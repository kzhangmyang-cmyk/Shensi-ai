import base64
import json
import logging
import multiprocessing
import os
import secrets
import signal
import stat
import subprocess
import sys
import threading
import time
from datetime import UTC, datetime, timedelta
from io import BytesIO
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient
from PIL import Image, ImageDraw

import shensi_adapter.accounts as accounts_module
import shensi_adapter.browser_state as browser_state_module
from shensi_adapter.accounts import AccountManager
from shensi_adapter.browser_state import (
    DOUYIN_VERIFICATION_SELECTORS,
    LOGIN_QR_CAPTURE_TIMEOUT_MS,
    LOGIN_QR_WAIT_MS,
    MediaCrawlerDouyinBrowserState,
    _open_context,
)
from shensi_adapter.app import (
    create_app,
    create_deployment_account_manager,
    deployment_browser_display,
    deployment_service_secret,
    validate_encrypted_profile_root,
)
from shensi_adapter.crawl_jobs import CrawlJobManager
from shensi_adapter.douyin_account_identity import (
    account_handle_for_fingerprint,
    identity_fingerprint_for_raw_sec_uid,
)
from shensi_adapter.schemas import CrawlJobRequest


ACCOUNT_FINGERPRINT = identity_fingerprint_for_raw_sec_uid(
    "MS4wLjABFixtureAccount"
)
LOGIN_PAGE_FRAME = {
    "image_data_url": "data:image/jpeg;base64,bG9naW4tanBlZw==",
    "width": 1280,
    "height": 800,
}


def _png(draw):
    image = Image.new("RGB", (180, 180), "white")
    draw(ImageDraw.Draw(image))
    output = BytesIO()
    image.save(output, format="PNG")
    return output.getvalue()


def _qr_like_png():
    def draw_modules(draw):
        for y in range(12, 168, 12):
            for x in range(12, 168, 12):
                if (x // 12 + y // 12) % 3 != 0:
                    draw.rectangle((x, y, x + 7, y + 7), fill="black")

    return _png(draw_modules)


class FakeBrowser:
    def __init__(self):
        self.closed = 0

    def open_douyin_login(self, profile_path):
        assert profile_path.exists()
        return {
            "login_page": {
                "image_data_url": "data:image/jpeg;base64,bG9naW4tanBlZw==",
                "width": 1280,
                "height": 800,
            }
        }

    def close(self, _context):
        self.closed += 1

    def poll_douyin_login(self, _context):
        return {
            "active": True,
            "display_name": "Douyin",
            "identity_fingerprint": ACCOUNT_FINGERPRINT,
        }

    def close_browser(self):
        return None


def _wait_for_login_state(manager, session_id, expected_state, timeout=1):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        current = manager.get_login_session(session_id)
        if current.state == expected_state:
            return current
        time.sleep(0.01)
    pytest.fail(f"login session did not reach {expected_state}")


def _wait_for_login_bootstrap(manager, session_id, timeout=1):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        with manager._lock:
            bootstrap = manager._login_bootstraps.get(session_id)
            if bootstrap is None or not bootstrap.is_alive():
                return
        time.sleep(0.01)
    pytest.fail("login bootstrap did not finish")


def _run_login_bootstrap_in_calling_thread(manager, session_id):
    with manager._lock:
        session = manager._sessions[session_id]
        generation = session["context_generation"]
        manager._login_bootstraps[session_id] = threading.current_thread()
    manager._bootstrap_login_session(
        session_id,
        session,
        generation,
        (),
    )


def _allocate_login_version_in_process(root, start, result_queue):
    manager = AccountManager(Path(root), FakeBrowser())
    try:
        if not start.wait(timeout=5):
            raise RuntimeError("allocation_start_timeout")
        result_queue.put(("ok", manager._next_login_state_version()))
    except BaseException as error:
        result_queue.put(("error", type(error).__name__))
        raise
    finally:
        manager.close()


class FailingCloseBrowser(FakeBrowser):
    def __init__(self, *, fail_shutdown=False):
        super().__init__()
        self.close_browser_calls = 0
        self.fail_shutdown = fail_shutdown

    def close(self, _context):
        self.closed += 1
        raise RuntimeError("context close failed")

    def close_browser(self):
        self.close_browser_calls += 1
        if self.fail_shutdown:
            raise RuntimeError("browser shutdown failed")


class _TimeoutConnection:
    def __init__(self):
        self.closed = False
        self.sent = []

    def send(self, command):
        self.sent.append(command)

    def poll(self, _timeout):
        return False

    def close(self):
        self.closed = True


class _ShutdownErrorConnection(_TimeoutConnection):
    def __init__(self):
        super().__init__()
        self.sent = []

    def send(self, command):
        self.sent.append(command)

    def poll(self, _timeout):
        return True

    def recv(self):
        return {"kind": "shutdown_error"}


class _SlowExitProcess:
    pid = None

    def __init__(self):
        self.alive = True
        self.kill_calls = 0
        self.close_calls = 0

    def is_alive(self):
        return self.alive

    def kill(self):
        self.kill_calls += 1
        if self.kill_calls >= 2:
            self.alive = False

    def join(self, timeout=None):
        assert timeout is not None

    def close(self):
        assert not self.alive, "Process.close called while the worker was alive"
        self.close_calls += 1


class _DeadWorkerWithLiveDescendantProcess:
    pid = 41001

    def __init__(self):
        self.close_calls = 0

    def is_alive(self):
        return False

    def kill(self):
        raise AssertionError("dead worker must not be used as the group authority")

    def join(self, timeout=None):
        assert timeout is not None

    def close(self):
        self.close_calls += 1


class _AliveCheckFailureProcess:
    pid = 41002

    def __init__(self):
        self.alive_checks = 0
        self.explicit_death_observed = False
        self.close_calls = 0

    def is_alive(self):
        self.alive_checks += 1
        if self.alive_checks == 1:
            raise OSError("worker status unavailable")
        self.explicit_death_observed = True
        return False

    def kill(self):
        return None

    def join(self, timeout=None):
        assert timeout is not None

    def close(self):
        assert self.explicit_death_observed, (
            "Process.close called before worker death was explicitly observed"
        )
        self.close_calls += 1


class _FakeImage:
    def count(self):
        return 1

    def nth(self, _index):
        return self

    def is_visible(self, **_kwargs):
        return True

    def click(self, **_kwargs):
        return None

    def wait_for(self, **_kwargs):
        return None

    def get_attribute(self, _name):
        return "data:image/png;base64,cXI="


class _FakeIdentityAnchor:
    def count(self):
        return 1

    def nth(self, _index):
        return self

    def is_visible(self, **_kwargs):
        return True

    def get_attribute(self, name):
        return {
            "href": "/user/MS4wLjABFixtureAccount",
            "title": "Douyin",
        }.get(name)

    def inner_text(self, **_kwargs):
        return "Douyin"

    def locator(self, _selector):
        return _FakeEmptyLocator()


class _FakeEmptyLocator:
    def count(self):
        return 0


class _FakePage:
    url = "https://www.douyin.com/"

    def goto(self, *_args, **_kwargs):
        return None

    def locator(self, selector):
        if selector == (
            '[class~="tab-user_self"] a[href], '
            'a[class~="tab-user_self"][href]'
        ):
            return _FakeEmptyLocator()
        if selector == (
            'header a[href], nav a[href], [role="navigation"] a[href], '
            '[data-e2e="douyin-header"] a[href], #douyin-header a[href]'
        ):
            return _FakeIdentityAnchor()
        if selector in DOUYIN_VERIFICATION_SELECTORS:
            return _FakeEmptyLocator()
        return _FakeImage()

    def wait_for_timeout(self, _milliseconds):
        return None

    def screenshot(self, **_kwargs):
        return b"login-jpeg"

    def evaluate(self, expression, *_args):
        if "HasUserLogin" in expression:
            return "1"
        raise AssertionError(expression)


class _FakeContext:
    def __init__(self):
        self.pages = [_FakePage()]

    def new_cdp_session(self, page):
        class Session:
            def send(self, method, payload):
                assert method == "Page.captureScreenshot"
                assert payload == {
                    "format": "jpeg",
                    "quality": 80,
                    "fromSurface": True,
                    "captureBeyondViewport": False,
                }
                return {
                    "data": base64.b64encode(
                        page.screenshot()
                    ).decode("ascii")
                }

            def detach(self):
                return None

        return Session()

    def close(self):
        return None


class _FakeChromium:
    def launch_persistent_context(self, _profile_path, **_kwargs):
        return _FakeContext()


class _InteractiveChromeOnlyChromium:
    def launch_persistent_context(self, _profile_path, **kwargs):
        assert kwargs == {
            "headless": False,
            "channel": "chrome",
            "ignore_default_args": ["--disable-dev-shm-usage"],
            "args": ["--no-proxy-server"],
            "viewport": {"width": 1280, "height": 800},
        }
        return _FakeContext()


class _ColdStartQrImage(_FakeImage):
    def wait_for(self, **kwargs):
        assert kwargs["timeout"] >= 25_000


class _ColdStartQrPage(_FakePage):
    def __init__(self):
        self.goto_calls = []

    def goto(self, url, **kwargs):
        self.goto_calls.append((url, kwargs))

    def locator(self, selector):
        if selector == "#animate_qrcode_container img":
            return _ColdStartQrImage()
        if selector in DOUYIN_VERIFICATION_SELECTORS:
            return _FakeEmptyLocator()
        return _FakeImage()


class _ColdStartQrContext(_FakeContext):
    def __init__(self):
        self.pages = [_ColdStartQrPage()]


class _ColdStartQrChromium:
    def launch_persistent_context(self, _profile_path, **_kwargs):
        return _ColdStartQrContext()


class _ColdStartQrPlaywright:
    chromium = _ColdStartQrChromium()


class _StrictLoginLocator:
    def __init__(self, page, selector, *, visible=False, source=None,
                 screenshot=None, clickable=False, qr_metadata=None,
                 qr_data_url=None):
        self.page = page
        self.selector = selector
        self.visible = visible
        self.source = source
        self.screenshot_bytes = screenshot
        self.clickable = clickable
        self.qr_metadata = qr_metadata
        self.qr_data_url = qr_data_url

    def count(self):
        return 1 if self.visible else 0

    def nth(self, index):
        if not self.visible or index != 0:
            raise IndexError(index)
        return self

    def is_visible(self, **_kwargs):
        return self.visible

    def wait_for(self, **_kwargs):
        if not self.visible:
            raise TimeoutError(self.selector)

    def click(self, **_kwargs):
        if not self.visible or not self.clickable:
            raise TimeoutError(self.selector)
        if self.page.panel_appears_during_click:
            self.page.auto_panel = True
            raise TimeoutError("login panel intercepted the stale button")
        self.page.login_clicked = True

    def get_attribute(self, name):
        if name == "src":
            return self.source
        return None

    def screenshot(self, **_kwargs):
        if self.screenshot_bytes is None:
            raise AssertionError(f"unexpected screenshot: {self.selector}")
        return self.screenshot_bytes

    def evaluate(self, expression):
        if self.qr_data_url is not None and (
            "toDataURL" in expression or "XMLSerializer" in expression
        ):
            return self.qr_data_url
        if self.qr_metadata is None:
            raise AssertionError(f"unexpected evaluate: {self.selector}")
        return self.qr_metadata


class _StrictLoginPage:
    url = "https://www.douyin.com/"

    def __init__(self, *, qr_selector=None, qr_source=None,
                 qr_screenshot=None, auto_panel=True,
                 title="抖音-记录美好生活", qr_metadata=None,
                 qr_data_url=None,
                 panel_selector="#login-panel-new",
                 panel_appears_during_click=False):
        self.qr_selector = qr_selector
        self.qr_source = qr_source
        self.qr_screenshot = qr_screenshot
        self.auto_panel = auto_panel
        self.page_title = title
        self.qr_metadata = qr_metadata
        self.qr_data_url = qr_data_url
        self.panel_selector = panel_selector
        self.panel_appears_during_click = panel_appears_during_click
        self.login_clicked = False
        self.goto_calls = []

    def goto(self, url, **kwargs):
        self.goto_calls.append((url, kwargs))

    def title(self):
        return self.page_title

    def locator(self, selector):
        if selector in {
            "#login-panel-new",
            "#login-pannel",
            '[id^="login-full-panel-"]',
        }:
            return _StrictLoginLocator(
                self, selector,
                visible=(selector == self.panel_selector
                         and (self.auto_panel or self.login_clicked)),
            )
        if selector == 'button:has-text("登录")':
            return _StrictLoginLocator(
                self, selector, visible=not self.auto_panel, clickable=True,
            )
        if selector == self.qr_selector:
            return _StrictLoginLocator(
                self, selector,
                visible=self.auto_panel or self.login_clicked,
                source=self.qr_source,
                screenshot=self.qr_screenshot,
                qr_metadata=self.qr_metadata,
                qr_data_url=self.qr_data_url,
            )
        return _StrictLoginLocator(self, selector)

    def wait_for_timeout(self, _milliseconds):
        return None

    def screenshot(self, **_kwargs):
        return b"login-jpeg"

    def evaluate(self, expression, *_args):
        raise AssertionError(expression)


class _StrictLoginContext:
    def __init__(self, page):
        self.pages = [page]
        self.closed = False

    def new_cdp_session(self, page):
        class Session:
            def send(self, _method, _payload):
                return {
                    "data": base64.b64encode(
                        page.screenshot()
                    ).decode("ascii")
                }

            def detach(self):
                return None

        return Session()

    def close(self):
        self.closed = True


class _StrictLoginChromium:
    def __init__(self, page):
        self.page = page
        self.context = None

    def launch_persistent_context(self, _profile_path, **_kwargs):
        self.context = _StrictLoginContext(self.page)
        return self.context


def _strict_login_playwright(page):
    return SimpleNamespace(chromium=_StrictLoginChromium(page))


class _BlockingChromium:
    def launch_persistent_context(self, _profile_path, **_kwargs):
        threading.Event().wait()


class _BlockingChildChromium:
    def launch_persistent_context(self, profile_path, **_kwargs):
        child = subprocess.Popen(
            [sys.executable, "-c", "import time; time.sleep(60)"],
            start_new_session=False,
        )
        (Path(profile_path) / "browser-child.pid").write_text(
            str(child.pid), encoding="utf-8"
        )
        threading.Event().wait()


class _FakePlaywright:
    chromium = _FakeChromium()

    def stop(self):
        return None


class _InteractiveChromeOnlyPlaywright:
    chromium = _InteractiveChromeOnlyChromium()

    def stop(self):
        return None


class _BlockingPlaywright:
    chromium = _BlockingChromium()

    def stop(self):
        return None


class _BlockingChildPlaywright:
    chromium = _BlockingChildChromium()

    def stop(self):
        return None


class _TimeoutOnceChromium:
    def __init__(self, launch_count_path):
        self.launch_count_path = Path(launch_count_path)

    def launch_persistent_context(self, _profile_path, **_kwargs):
        count = (
            int(self.launch_count_path.read_text(encoding="utf-8"))
            if self.launch_count_path.exists()
            else 0
        ) + 1
        self.launch_count_path.write_text(str(count), encoding="utf-8")
        if count == 1:
            threading.Event().wait()
        return _FakeContext()


class _TimeoutOncePlaywright:
    def __init__(self, launch_count_path):
        self.chromium = _TimeoutOnceChromium(launch_count_path)

    def stop(self):
        return None


class _TimeoutOncePlaywrightFactory:
    def __init__(self, launch_count_path):
        self.launch_count_path = str(launch_count_path)

    def __call__(self):
        return _TimeoutOncePlaywright(self.launch_count_path)


class _ShutdownFailurePlaywright(_FakePlaywright):
    def stop(self):
        raise RuntimeError("playwright stop failed")


def _working_playwright_factory():
    return _FakePlaywright()


def _interactive_chrome_only_playwright_factory():
    return _InteractiveChromeOnlyPlaywright()


def _blocking_playwright_factory():
    return _BlockingPlaywright()


def _blocking_child_playwright_factory():
    return _BlockingChildPlaywright()


def _shutdown_failure_playwright_factory():
    return _ShutdownFailurePlaywright()


def _startup_failure_factory():
    raise RuntimeError("playwright unavailable")


def test_account_manager_emits_only_short_lived_safe_login_view_and_closes_expiry(tmp_path):
    now = datetime(2026, 8, 24, tzinfo=UTC)
    browser = FakeBrowser()
    manager = AccountManager(
        root=tmp_path,
        browser=browser,
        now=lambda: now,
        session_ttl=timedelta(minutes=1),
    )

    session = manager.create_login_session()

    assert session.state == "awaiting_scan"
    assert session.qr_status == "opening"
    assert session.qr_image_data_url is None
    assert session.login_page is None
    assert session.account_handle is None
    assert oct((tmp_path / "profiles").stat().st_mode & 0o777) == "0o700"
    assert "cookie" not in session.model_dump_json().lower()

    _wait_for_login_state(manager, session.session_id, "active")
    expired = manager.get_login_session(session.session_id, now + timedelta(minutes=2))

    assert expired.state == "active"
    assert expired.qr_image_data_url is None
    assert browser.closed == 1


def test_login_session_creation_returns_before_browser_open_and_keeps_manager_responsive(
    tmp_path,
):
    class BlockingLoginBrowser(FakeBrowser):
        def __init__(self):
            super().__init__()
            self.open_started = threading.Event()
            self.release_open = threading.Event()

        def open_douyin_login(self, profile_path):
            assert profile_path.exists()
            self.open_started.set()
            self.release_open.wait(timeout=1)
            return {"login_page": LOGIN_PAGE_FRAME}

        def poll_douyin_login(self, _context):
            return {"active": False, "login_page": LOGIN_PAGE_FRAME}

    browser = BlockingLoginBrowser()
    manager = AccountManager(tmp_path, browser)
    try:
        started = time.monotonic()
        created = manager.create_login_session()

        assert time.monotonic() - started < 0.5
        assert created.state == "awaiting_scan"
        assert created.login_page is None
        assert browser.open_started.wait(timeout=1)

        observed = []
        read_finished = threading.Event()

        def read_session():
            observed.append(manager.get_login_session(created.session_id))
            read_finished.set()

        reader = threading.Thread(target=read_session)
        reader.start()
        assert read_finished.wait(timeout=0.5)
        assert observed[0].state == "awaiting_scan"
        assert observed[0].login_page is None

        browser.release_open.set()
        deadline = time.monotonic() + 1
        while time.monotonic() < deadline:
            current = manager.get_login_session(created.session_id)
            if current.login_page is not None:
                break
            time.sleep(0.01)
        else:
            pytest.fail("background login page did not become available")
        assert current.login_page.model_dump() == {
            "image_data_url": LOGIN_PAGE_FRAME["image_data_url"],
            "width": LOGIN_PAGE_FRAME["width"],
            "height": LOGIN_PAGE_FRAME["height"],
        }
    finally:
        browser.release_open.set()
        manager.close()


def test_parallel_sidecar_login_creations_remain_isolated_without_a_tenant_slot(
    tmp_path,
):
    class BlockingLoginBrowser(FakeBrowser):
        def __init__(self):
            super().__init__()
            self.first_open_started = threading.Event()
            self.release_open = threading.Event()
            self.open_calls = 0

        def open_douyin_login(self, profile_path):
            assert profile_path.exists()
            self.open_calls += 1
            if self.open_calls == 1:
                self.first_open_started.set()
            assert self.release_open.wait(timeout=2)
            return {
                "handle": f"isolated-context-{self.open_calls}",
                "login_page": None,
                "qr_status": "opening",
                "qr_image_data_url": None,
            }

    browser = BlockingLoginBrowser()
    manager = AccountManager(tmp_path, browser)
    try:
        first = manager.create_login_session()
        assert browser.first_open_started.wait(timeout=1)

        second = manager.create_login_session()

        assert second.session_id != first.session_id
        assert len(manager._sessions) == 2
        assert len(list((tmp_path / "profiles").iterdir())) == 2
    finally:
        browser.release_open.set()
        manager.close()


def test_registered_login_context_is_live_before_optional_prepare_finishes(
    tmp_path,
):
    class BlockingPrepareBrowser(FakeBrowser):
        def __init__(self):
            super().__init__()
            self.prepare_started = threading.Event()
            self.release_prepare = threading.Event()
            self.open_calls = 0

        def open_douyin_login(self, profile_path):
            assert profile_path.exists()
            self.open_calls += 1
            return {
                "handle": "interactive-before-prepare",
                "vnc_port": 59_102,
                "login_page": None,
                "qr_status": "opening",
                "qr_image_data_url": None,
            }

        def live_vnc_port(self, context):
            return context["vnc_port"]

        def poll_douyin_login(self, _context):
            return {
                "active": False,
                "login_page": None,
                "qr_status": "opening",
                "qr_image_data_url": None,
            }

        def prepare_douyin_login(self, context):
            assert context["handle"] == "interactive-before-prepare"
            self.prepare_started.set()
            assert self.release_prepare.wait(timeout=2)
            return {
                "login_page": LOGIN_PAGE_FRAME,
                "qr_status": "ready",
                "qr_image_data_url": "data:image/png;base64,cXI=",
            }

    browser = BlockingPrepareBrowser()
    manager = AccountManager(tmp_path, browser)
    try:
        created = manager.create_login_session()
        assert browser.prepare_started.wait(timeout=1)

        live = manager.create_live_login_session(created.session_id)
        observed = manager.get_login_session(created.session_id)

        assert browser.open_calls == 1
        assert len(live.token) >= 40
        assert observed.state == "awaiting_scan"
        assert observed.login_page is None
        assert browser.closed == 0
    finally:
        browser.release_prepare.set()
        manager.close()


def test_disconnected_prepare_result_is_stale_and_closes_its_context_once(
    tmp_path,
):
    class StalePrepareBrowser(FakeBrowser):
        def __init__(self):
            super().__init__()
            self._open_lock = threading.Lock()
            self.open_calls = 0
            self.second_open_started = threading.Event()
            self.first_prepare_started = threading.Event()
            self.release_first_prepare = threading.Event()
            self.closed_contexts = []

        def open_douyin_login(self, profile_path):
            assert profile_path.exists()
            with self._open_lock:
                self.open_calls += 1
                handle = f"login-context-{self.open_calls}"
                if self.open_calls == 2:
                    self.second_open_started.set()
            return {
                "handle": handle,
                "vnc_port": 59_100 + self.open_calls,
                "login_page": None,
                "qr_status": "opening",
                "qr_image_data_url": None,
            }

        def prepare_douyin_login(self, context):
            if context["handle"] == "login-context-1":
                self.first_prepare_started.set()
                assert self.release_first_prepare.wait(timeout=2)
            return {
                "login_page": LOGIN_PAGE_FRAME,
                "qr_status": "ready",
                "qr_image_data_url": "data:image/png;base64,cXI=",
            }

        def close(self, context):
            self.closed_contexts.append(context["handle"])

    browser = StalePrepareBrowser()
    manager = AccountManager(tmp_path, browser)
    try:
        old = manager.create_login_session()
        assert browser.first_prepare_started.wait(timeout=1)

        manager.disconnect(old.session_id)
        new = manager.create_login_session()
        assert not browser.second_open_started.wait(timeout=0.2)
        assert browser.open_calls == 1
        with manager._lock:
            assert manager._login_bootstraps[new.session_id].is_alive()

        browser.release_first_prepare.set()
        _wait_for_login_bootstrap(manager, old.session_id)
        assert browser.second_open_started.wait(timeout=1)
        _wait_for_login_bootstrap(manager, new.session_id)
        new_context = manager._sessions[new.session_id]["context"]

        assert manager._sessions[new.session_id]["context"] is new_context
        assert manager._sessions[new.session_id]["qr_status"] == "ready"
        assert browser.closed_contexts.count("login-context-1") == 1
        assert "login-context-2" not in browser.closed_contexts
        with pytest.raises(KeyError):
            manager.get_login_session(old.session_id)
    finally:
        browser.release_first_prepare.set()
        manager.close()


def test_disconnect_does_not_wait_for_serialized_login_preparation_cleanup(
    tmp_path,
    monkeypatch,
):
    class SerializedPrepareBrowser(FakeBrowser):
        def __init__(self):
            super().__init__()
            self.command_lock = threading.Lock()
            self.prepare_started = threading.Event()
            self.release_prepare = threading.Event()
            self.closed_contexts = []

        def open_douyin_login(self, profile_path):
            assert profile_path.exists()
            return {
                "handle": "serialized-login-context",
                "vnc_port": 59_107,
                "login_page": None,
                "qr_status": "opening",
                "qr_image_data_url": None,
            }

        def prepare_douyin_login(self, context):
            with self.command_lock:
                assert context["handle"] == "serialized-login-context"
                self.prepare_started.set()
                assert self.release_prepare.wait(timeout=2)
                return {
                    "login_page": LOGIN_PAGE_FRAME,
                    "qr_status": "ready",
                    "qr_image_data_url": "data:image/png;base64,cXI=",
                }

        def close(self, context):
            with self.command_lock:
                self.closed_contexts.append(context["handle"])

    browser = SerializedPrepareBrowser()
    manager = AccountManager(tmp_path, browser)
    disconnect_done = threading.Event()
    disconnect_errors = []
    disconnector = None
    try:
        created = manager.create_login_session()
        assert browser.prepare_started.wait(timeout=1)
        profile = manager._sessions[created.session_id]["profile"]
        deleted_profiles = []
        original_delete_profile = manager._delete_profile

        def record_delete_profile(candidate):
            deleted_profiles.append(candidate)
            original_delete_profile(candidate)

        monkeypatch.setattr(manager, "_delete_profile", record_delete_profile)

        def disconnect():
            try:
                manager.disconnect(created.session_id)
            except BaseException as error:
                disconnect_errors.append(error)
            finally:
                disconnect_done.set()

        disconnector = threading.Thread(target=disconnect)
        disconnector.start()

        assert disconnect_done.wait(timeout=0.2)
        assert disconnect_errors == []
        with pytest.raises(KeyError):
            manager.disconnect(created.session_id)
        assert profile.exists()
        assert browser.closed_contexts == []

        browser.release_prepare.set()
        disconnector.join(timeout=2)
        _wait_for_login_bootstrap(manager, created.session_id)
        deadline = time.monotonic() + 1
        while profile.exists() and time.monotonic() < deadline:
            time.sleep(0.01)

        assert not profile.exists()
        assert browser.closed_contexts == ["serialized-login-context"]
        assert deleted_profiles == [profile]
    finally:
        browser.release_prepare.set()
        if disconnector is not None:
            disconnector.join(timeout=2)
        manager.close()


def test_disconnect_after_bootstrap_cleanup_check_still_has_one_cleanup_owner(
    tmp_path,
):
    class PreparedBrowser(FakeBrowser):
        def __init__(self):
            super().__init__()
            self.prepare_returned = threading.Event()
            self.closed_contexts = []

        def open_douyin_login(self, profile_path):
            assert profile_path.exists()
            return {
                "handle": "cleanup-handoff-context",
                "vnc_port": 59_111,
                "login_page": None,
                "qr_status": "opening",
                "qr_image_data_url": None,
            }

        def prepare_douyin_login(self, _context):
            self.prepare_returned.set()
            return {
                "login_page": LOGIN_PAGE_FRAME,
                "qr_status": "ready",
                "qr_image_data_url": "data:image/png;base64,cXI=",
            }

        def close(self, context):
            self.closed_contexts.append(context["handle"])

    class PauseAfterSecondBootstrapRelease:
        def __init__(self, wrapped, prepare_returned):
            self._wrapped = wrapped
            self._prepare_returned = prepare_returned
            self._count_lock = threading.Lock()
            self._bootstrap_releases = 0
            self.cleanup_check_released = threading.Event()
            self.allow_bootstrap_finish = threading.Event()

        def acquire(self, *args, **kwargs):
            return self._wrapped.acquire(*args, **kwargs)

        def release(self):
            return self._wrapped.release()

        def __enter__(self):
            self._wrapped.acquire()
            return self

        def __exit__(self, exc_type, exc, traceback):
            self._wrapped.release()
            should_pause = False
            if (
                threading.current_thread().name == "douyin-login-bootstrap"
                and self._prepare_returned.is_set()
            ):
                with self._count_lock:
                    self._bootstrap_releases += 1
                    should_pause = self._bootstrap_releases == 2
            if should_pause:
                self.cleanup_check_released.set()
                assert self.allow_bootstrap_finish.wait(timeout=2)
            return False

    browser = PreparedBrowser()
    manager = AccountManager(tmp_path, browser)
    observed_lock = PauseAfterSecondBootstrapRelease(
        manager._lock,
        browser.prepare_returned,
    )
    manager._lock = observed_lock
    try:
        created = manager.create_login_session()
        assert observed_lock.cleanup_check_released.wait(timeout=1)
        profile = manager._sessions[created.session_id]["profile"]

        manager.disconnect(created.session_id)
        observed_lock.allow_bootstrap_finish.set()
        _wait_for_login_bootstrap(manager, created.session_id)
        deadline = time.monotonic() + 1
        while profile.exists() and time.monotonic() < deadline:
            time.sleep(0.01)

        assert not profile.exists()
        assert browser.closed_contexts == ["cleanup-handoff-context"]
        with pytest.raises(KeyError):
            manager.disconnect(created.session_id)
    finally:
        observed_lock.allow_bootstrap_finish.set()
        manager.close()


def test_discarded_bootstrap_with_removed_profile_releases_registry_ownership(
    tmp_path,
):
    class BlockingOpenBrowser(FakeBrowser):
        def __init__(self):
            super().__init__()
            self.open_started = threading.Event()
            self.release_open = threading.Event()
            self.closed_contexts = []

        def open_douyin_login(self, profile_path):
            assert profile_path.exists()
            self.open_started.set()
            assert self.release_open.wait(timeout=2)
            return {
                "handle": "discarded-before-registration",
                "login_page": LOGIN_PAGE_FRAME,
            }

        def close(self, context):
            self.closed_contexts.append(context["handle"])

    browser = BlockingOpenBrowser()
    manager = AccountManager(tmp_path, browser)
    try:
        created = manager.create_login_session()
        assert browser.open_started.wait(timeout=1)
        profile = manager._sessions[created.session_id]["profile"]
        with manager._lock:
            bootstrap = manager._login_bootstraps[created.session_id]

        manager.disconnect(created.session_id)
        browser.release_open.set()
        bootstrap.join(timeout=2)

        assert not bootstrap.is_alive()
        assert not profile.exists()
        assert browser.closed_contexts == ["discarded-before-registration"]
        with manager._lock:
            assert created.session_id not in manager._login_bootstraps
    finally:
        browser.release_open.set()
        manager.close()


def test_cleanup_thread_start_failure_uses_successful_synchronous_fallback(
    tmp_path,
    monkeypatch,
):
    browser = FakeBrowser()
    manager = AccountManager(tmp_path, browser)
    created = manager.create_login_session()
    _wait_for_login_bootstrap(manager, created.session_id)
    profile = manager._sessions[created.session_id]["profile"]
    original_start = accounts_module.threading.Thread.start

    def fail_cleanup_start(thread):
        if thread.name == "douyin-session-cleanup":
            raise RuntimeError("cleanup thread start failed")
        return original_start(thread)

    monkeypatch.setattr(
        accounts_module.threading.Thread,
        "start",
        fail_cleanup_start,
    )

    manager.disconnect(created.session_id)

    assert browser.closed == 1
    assert not profile.exists()
    with pytest.raises(KeyError):
        manager.disconnect(created.session_id)
    manager.close()


def test_detached_prepare_cleanup_failure_is_recorded_and_shutdown_observes_it(
    tmp_path,
):
    class FailingSerializedCloseBrowser(FakeBrowser):
        def __init__(self):
            super().__init__()
            self.command_lock = threading.Lock()
            self.prepare_started = threading.Event()
            self.release_prepare = threading.Event()

        def open_douyin_login(self, profile_path):
            assert profile_path.exists()
            return {
                "handle": "failing-serialized-context",
                "vnc_port": 59_108,
                "login_page": None,
                "qr_status": "opening",
                "qr_image_data_url": None,
            }

        def prepare_douyin_login(self, _context):
            with self.command_lock:
                self.prepare_started.set()
                assert self.release_prepare.wait(timeout=2)
                return {
                    "login_page": LOGIN_PAGE_FRAME,
                    "qr_status": "ready",
                    "qr_image_data_url": "data:image/png;base64,cXI=",
                }

        def close(self, _context):
            with self.command_lock:
                self.closed += 1
                raise RuntimeError("context close failed")

    browser = FailingSerializedCloseBrowser()
    manager = AccountManager(tmp_path, browser)
    try:
        created = manager.create_login_session()
        assert browser.prepare_started.wait(timeout=1)
        profile = manager._sessions[created.session_id]["profile"]

        manager.disconnect(created.session_id)
        browser.release_prepare.set()
        _wait_for_login_bootstrap(manager, created.session_id)

        assert browser.closed == 1
        assert not profile.exists()
        with pytest.raises(RuntimeError, match="context close failed"):
            manager.close()
    finally:
        browser.release_prepare.set()
        if not manager._closed.is_set():
            try:
                manager.close()
            except BaseException:
                pass


def test_shutdown_waits_for_detached_prepare_cleanup_without_leaking_resources(
    tmp_path,
):
    class BlockingSerializedCloseBrowser(FakeBrowser):
        def __init__(self):
            super().__init__()
            self.command_lock = threading.Lock()
            self.prepare_started = threading.Event()
            self.release_prepare = threading.Event()
            self.close_started = threading.Event()
            self.release_close = threading.Event()

        def open_douyin_login(self, profile_path):
            assert profile_path.exists()
            return {
                "handle": "shutdown-serialized-context",
                "vnc_port": 59_109,
                "login_page": None,
                "qr_status": "opening",
                "qr_image_data_url": None,
            }

        def prepare_douyin_login(self, _context):
            with self.command_lock:
                self.prepare_started.set()
                assert self.release_prepare.wait(timeout=2)
                return {
                    "login_page": LOGIN_PAGE_FRAME,
                    "qr_status": "ready",
                    "qr_image_data_url": "data:image/png;base64,cXI=",
                }

        def close(self, _context):
            with self.command_lock:
                self.close_started.set()
                assert self.release_close.wait(timeout=2)
                self.closed += 1

    browser = BlockingSerializedCloseBrowser()
    manager = AccountManager(tmp_path, browser)
    close_done = threading.Event()
    close_errors = []
    closer = None
    try:
        created = manager.create_login_session()
        assert browser.prepare_started.wait(timeout=1)
        profile = manager._sessions[created.session_id]["profile"]
        manager.disconnect(created.session_id)

        def close_manager():
            try:
                manager.close()
            except BaseException as error:
                close_errors.append(error)
            finally:
                close_done.set()

        closer = threading.Thread(target=close_manager)
        closer.start()
        assert not close_done.wait(timeout=0.2)

        browser.release_prepare.set()
        assert browser.close_started.wait(timeout=1)
        assert not close_done.wait(timeout=0.2)
        browser.release_close.set()
        closer.join(timeout=2)

        assert close_done.is_set()
        assert close_errors == []
        assert browser.closed == 1
        assert not profile.exists()
        assert all(
            thread.name != "douyin-login-bootstrap"
            for thread in threading.enumerate()
        )
    finally:
        browser.release_prepare.set()
        browser.release_close.set()
        if closer is not None:
            closer.join(timeout=2)
        if not manager._closed.is_set():
            manager.close()


def test_shutdown_browser_close_wins_detached_cleanup_without_false_failure(
    tmp_path,
):
    class ShutdownWinsBrowser(FakeBrowser):
        def __init__(self):
            super().__init__()
            self.prepare_started = threading.Event()
            self.release_prepare = threading.Event()
            self.browser_closed = False

        def open_douyin_login(self, profile_path):
            assert profile_path.exists()
            return {
                "handle": "shutdown-wins-context",
                "vnc_port": 59_110,
                "login_page": None,
                "qr_status": "opening",
                "qr_image_data_url": None,
            }

        def prepare_douyin_login(self, _context):
            self.prepare_started.set()
            assert self.release_prepare.wait(timeout=2)
            return {
                "login_page": LOGIN_PAGE_FRAME,
                "qr_status": "ready",
                "qr_image_data_url": "data:image/png;base64,cXI=",
            }

        def close(self, _context):
            assert self.browser_closed
            self.closed += 1
            raise RuntimeError("douyin_browser_closed")

        def close_browser(self):
            self.browser_closed = True
            self.release_prepare.set()

    browser = ShutdownWinsBrowser()
    manager = AccountManager(tmp_path, browser)
    created = manager.create_login_session()
    assert browser.prepare_started.wait(timeout=1)
    profile = manager._sessions[created.session_id]["profile"]

    manager.disconnect(created.session_id)
    manager.close()

    assert browser.closed == 1
    assert not profile.exists()
    assert manager._detached_cleanup_failures == []
    assert all(
        thread.name not in {
            "douyin-login-bootstrap",
            "douyin-session-cleanup",
        }
        for thread in threading.enumerate()
    )


def test_fatal_prepare_failure_removes_registered_context_instead_of_leaving_live(
    tmp_path,
):
    class FailedPrepareBrowser(FakeBrowser):
        def __init__(self):
            super().__init__()
            self.prepare_finished = threading.Event()
            self.closed_contexts = []

        def open_douyin_login(self, profile_path):
            assert profile_path.exists()
            return {
                "handle": "context-with-dead-browser-worker",
                "vnc_port": 59_104,
                "login_page": None,
                "qr_status": "opening",
                "qr_image_data_url": None,
            }

        def prepare_douyin_login(self, _context):
            try:
                raise RuntimeError("douyin_browser_unavailable")
            finally:
                self.prepare_finished.set()

        def live_vnc_port(self, context):
            return context["vnc_port"]

        def close(self, context):
            self.closed_contexts.append(context["handle"])

    browser = FailedPrepareBrowser()
    manager = AccountManager(tmp_path, browser)
    try:
        created = manager.create_login_session()
        assert browser.prepare_finished.wait(timeout=1)
        _wait_for_login_bootstrap(manager, created.session_id)

        with pytest.raises(KeyError):
            manager.get_login_session(created.session_id)
        assert browser.closed_contexts == [
            "context-with-dead-browser-worker"
        ]
        assert not any((tmp_path / "profiles").iterdir())
    finally:
        manager.close()


def test_open_base_exception_terminates_bootstrap_before_propagating(
    tmp_path,
    monkeypatch,
):
    class InterruptedOpenBrowser(FakeBrowser):
        def open_douyin_login(self, profile_path):
            assert profile_path.exists()
            raise SystemExit("operator interrupted browser open")

    browser = InterruptedOpenBrowser()
    manager = AccountManager(tmp_path, browser)
    monkeypatch.setattr(threading.Thread, "start", lambda _thread: None)
    try:
        created = manager.create_login_session()
        session = manager._sessions[created.session_id]
        profile = session["profile"]

        with pytest.raises(
            SystemExit,
            match="^operator interrupted browser open$",
        ):
            _run_login_bootstrap_in_calling_thread(
                manager,
                created.session_id,
            )

        assert created.session_id not in manager._sessions
        assert created.session_id not in manager._login_bootstraps
        assert session["closed"] is True
        assert session["context"] is None
        assert session["bootstrap_pending"] is False
        assert session["profile_removed"] is True
        assert not profile.exists()
        with pytest.raises(KeyError):
            manager.get_login_session(created.session_id)
    finally:
        manager.close()


def test_open_result_validation_base_exception_closes_unregistered_context(
    tmp_path,
    monkeypatch,
):
    class InterruptedLoginContext(dict):
        def get(self, key, default=None):
            if key == "login_page":
                raise SystemExit("operator interrupted open result validation")
            return super().get(key, default)

    class InterruptedValidationBrowser(FakeBrowser):
        def __init__(self):
            super().__init__()
            self.closed_contexts = []

        def open_douyin_login(self, profile_path):
            assert profile_path.exists()
            return InterruptedLoginContext({
                "handle": "unregistered-validation-context",
                "login_page": None,
                "qr_status": "opening",
                "qr_image_data_url": None,
            })

        def close(self, context):
            self.closed_contexts.append(context["handle"])

    browser = InterruptedValidationBrowser()
    manager = AccountManager(tmp_path, browser)
    monkeypatch.setattr(threading.Thread, "start", lambda _thread: None)
    try:
        created = manager.create_login_session()
        session = manager._sessions[created.session_id]
        profile = session["profile"]

        with pytest.raises(
            SystemExit,
            match="^operator interrupted open result validation$",
        ):
            _run_login_bootstrap_in_calling_thread(
                manager,
                created.session_id,
            )

        assert browser.closed_contexts == [
            "unregistered-validation-context"
        ]
        assert created.session_id not in manager._sessions
        assert created.session_id not in manager._login_bootstraps
        assert session["closed"] is True
        assert session["context"] is None
        assert session["bootstrap_pending"] is False
        assert session["profile_removed"] is True
        assert not profile.exists()
    finally:
        manager.close()


def test_prepare_base_exception_cleans_owned_context_once_without_masking_it(
    tmp_path,
    monkeypatch,
):
    class InterruptedPrepareBrowser(FakeBrowser):
        def __init__(self):
            super().__init__()
            self.closed_contexts = []

        def open_douyin_login(self, profile_path):
            assert profile_path.exists()
            return {
                "handle": "interrupted-prepare-context",
                "login_page": None,
                "qr_status": "opening",
                "qr_image_data_url": None,
            }

        def prepare_douyin_login(self, _context):
            raise KeyboardInterrupt("operator interrupted login prepare")

        def close(self, context):
            self.closed_contexts.append(context["handle"])
            raise RuntimeError("context cleanup failed")

    browser = InterruptedPrepareBrowser()
    manager = AccountManager(tmp_path, browser)
    monkeypatch.setattr(threading.Thread, "start", lambda _thread: None)
    try:
        created = manager.create_login_session()
        session = manager._sessions[created.session_id]
        profile = session["profile"]

        with pytest.raises(
            KeyboardInterrupt,
            match="^operator interrupted login prepare$",
        ):
            _run_login_bootstrap_in_calling_thread(
                manager,
                created.session_id,
            )

        assert created.session_id not in manager._sessions
        assert created.session_id not in manager._login_bootstraps
        assert session["closed"] is True
        assert session["context"] is None
        assert session["bootstrap_pending"] is False
        assert session["profile_removed"] is True
        assert browser.closed_contexts == ["interrupted-prepare-context"]
        assert not profile.exists()
    finally:
        manager.close()


def test_screenshotless_login_context_is_published_for_live_interaction(
    tmp_path,
):
    class ScreenshotlessInteractiveBrowser(FakeBrowser):
        def open_douyin_login(self, profile_path):
            assert profile_path.exists()
            return {
                "handle": "screenshotless-login-context",
                "login_page": None,
                "qr_status": "opening",
                "qr_image_data_url": None,
            }

        def poll_douyin_login(self, _context):
            return {
                "active": False,
                "login_page": None,
                "qr_status": "opening",
                "qr_image_data_url": None,
            }

        def live_vnc_port(self, context):
            assert context["handle"] == "screenshotless-login-context"
            return 59_101

    browser = ScreenshotlessInteractiveBrowser()
    manager = AccountManager(tmp_path, browser)
    try:
        created = manager.create_login_session()
        _wait_for_login_bootstrap(manager, created.session_id)

        observed = manager.get_login_session(created.session_id)
        live = manager.create_live_login_session(created.session_id)

        assert observed.state == "awaiting_scan"
        assert observed.qr_status == "opening"
        assert observed.login_page is None
        assert len(live.token) >= 40
        assert browser.closed == 0
    finally:
        manager.close()


@pytest.mark.parametrize(
    "observed_status",
    ["network_error", "expired", "verification_required"],
)
def test_empty_opening_poll_does_not_erase_observed_qr_failure_status(
    tmp_path,
    observed_status,
):
    class EmptyOpeningPollBrowser(FakeBrowser):
        def open_douyin_login(self, profile_path):
            assert profile_path.exists()
            return {
                "login_page": LOGIN_PAGE_FRAME,
                "qr_status": observed_status,
                "qr_image_data_url": "data:image/png;base64,c3RhbGU=",
            }

        def poll_douyin_login(self, _context):
            return {
                "active": False,
                "login_page": LOGIN_PAGE_FRAME,
                "qr_status": "opening",
                "qr_image_data_url": None,
            }

    manager = AccountManager(tmp_path, EmptyOpeningPollBrowser())
    try:
        created = manager.create_login_session()
        _wait_for_login_bootstrap(manager, created.session_id)

        observed = manager.get_login_session(created.session_id)

        assert observed.qr_status == observed_status
        assert observed.qr_image_data_url is None
    finally:
        manager.close()


@pytest.mark.parametrize(
    ("initial_status", "poll_status", "poll_qr", "expected_qr"),
    [
        (
            "network_error",
            "ready",
            "data:image/png;base64,bmV3",
            "data:image/png;base64,bmV3",
        ),
        ("ready", "expired", None, None),
        ("ready", "network_error", None, None),
        ("ready", "verification_required", None, None),
    ],
)
def test_explicit_qr_poll_status_advances_and_non_ready_clears_stale_qr(
    tmp_path,
    initial_status,
    poll_status,
    poll_qr,
    expected_qr,
):
    class ExplicitStatusPollBrowser(FakeBrowser):
        def open_douyin_login(self, profile_path):
            assert profile_path.exists()
            return {
                "login_page": LOGIN_PAGE_FRAME,
                "qr_status": initial_status,
                "qr_image_data_url": "data:image/png;base64,b2xk",
            }

        def poll_douyin_login(self, _context):
            return {
                "active": False,
                "login_page": LOGIN_PAGE_FRAME,
                "qr_status": poll_status,
                "qr_image_data_url": poll_qr,
            }

    manager = AccountManager(tmp_path, ExplicitStatusPollBrowser())
    try:
        created = manager.create_login_session()
        _wait_for_login_bootstrap(manager, created.session_id)

        observed = manager.get_login_session(created.session_id)

        assert observed.qr_status == poll_status
        assert observed.qr_image_data_url == expected_qr
    finally:
        manager.close()


def test_empty_opening_poll_can_initialize_an_unknown_qr_status(tmp_path):
    class UnknownStatusBrowser(FakeBrowser):
        def open_douyin_login(self, profile_path):
            assert profile_path.exists()
            return {
                "login_page": LOGIN_PAGE_FRAME,
                "qr_status": None,
                "qr_image_data_url": None,
            }

        def poll_douyin_login(self, _context):
            return {
                "active": False,
                "login_page": LOGIN_PAGE_FRAME,
                "qr_status": "opening",
                "qr_image_data_url": None,
            }

    manager = AccountManager(tmp_path, UnknownStatusBrowser())
    try:
        created = manager.create_login_session()
        _wait_for_login_bootstrap(manager, created.session_id)

        observed = manager.get_login_session(created.session_id)

        assert observed.qr_status == "opening"
        assert observed.qr_image_data_url is None
    finally:
        manager.close()


def test_empty_opening_poll_replaces_ready_status_when_qr_disappears(tmp_path):
    class MissingQrPollBrowser(FakeBrowser):
        def open_douyin_login(self, profile_path):
            assert profile_path.exists()
            return {
                "login_page": LOGIN_PAGE_FRAME,
                "qr_status": "ready",
                "qr_image_data_url": "data:image/png;base64,b2xk",
            }

        def poll_douyin_login(self, _context):
            return {
                "active": False,
                "login_page": LOGIN_PAGE_FRAME,
                "qr_status": "opening",
                "qr_image_data_url": None,
            }

    manager = AccountManager(tmp_path, MissingQrPollBrowser())
    try:
        created = manager.create_login_session()
        _wait_for_login_bootstrap(manager, created.session_id)

        observed = manager.get_login_session(created.session_id)

        assert observed.qr_status == "opening"
        assert observed.qr_image_data_url is None
    finally:
        manager.close()


def test_blocked_poll_does_not_block_concurrent_create_and_disconnect_closes_once(
    tmp_path,
):
    class BlockingPollBrowser(FakeBrowser):
        def __init__(self):
            super().__init__()
            self.poll_started = threading.Event()
            self.release_poll = threading.Event()
            self.closed_contexts = []

        def open_douyin_login(self, profile_path):
            assert profile_path.exists()
            return {
                "handle": secrets.token_urlsafe(8),
                "login_page": LOGIN_PAGE_FRAME,
            }

        def poll_douyin_login(self, _context):
            self.poll_started.set()
            assert self.release_poll.wait(timeout=2)
            return {"active": False, "login_page": LOGIN_PAGE_FRAME}

        def close(self, context):
            self.closed_contexts.append(context["handle"])

    browser = BlockingPollBrowser()
    manager = AccountManager(tmp_path, browser)
    first = manager.create_login_session()
    _wait_for_login_bootstrap(manager, first.session_id)
    first_handle = manager._sessions[first.session_id]["context"]["handle"]
    first_profile = manager._sessions[first.session_id]["profile"]
    get_errors = []
    disconnect_errors = []
    created = []
    create_done = threading.Event()

    def blocked_get():
        try:
            manager.get_login_session(first.session_id)
        except BaseException as error:
            get_errors.append(error)

    def disconnect_first():
        try:
            manager.disconnect(first.session_id)
        except BaseException as error:
            disconnect_errors.append(error)

    def create_second():
        try:
            created.append(manager.create_login_session())
        finally:
            create_done.set()

    getter = threading.Thread(target=blocked_get)
    disconnector = threading.Thread(target=disconnect_first)
    creator = threading.Thread(target=create_second)
    getter.start()
    assert browser.poll_started.wait(timeout=1)
    disconnector.start()
    creator.start()
    try:
        assert create_done.wait(timeout=0.5)
        assert len(created) == 1
        assert created[0].state == "awaiting_scan"
        disconnector.join(timeout=0.5)
        assert not disconnector.is_alive()
    finally:
        browser.release_poll.set()
        getter.join(timeout=2)
        disconnector.join(timeout=2)
        creator.join(timeout=2)

    deadline = time.monotonic() + 1
    while first_profile.exists() and time.monotonic() < deadline:
        time.sleep(0.01)

    assert not getter.is_alive()
    assert not disconnector.is_alive()
    assert not creator.is_alive()
    assert disconnect_errors == []
    assert len(get_errors) <= 1
    assert not first_profile.exists()
    assert browser.closed_contexts.count(first_handle) == 1
    with pytest.raises(KeyError):
        manager.get_login_session(first.session_id)
    manager.close()


def test_external_disconnect_preempts_blocked_poll_before_fast_reconnect(
    tmp_path,
):
    class DeduplicatingExternalBrowser(FakeBrowser):
        interaction_surface = "external_window"

        def __init__(self):
            super().__init__()
            self._state_lock = threading.Lock()
            self._current_context = None
            self.open_count = 0
            self.abort_calls = []
            self.poll_started = threading.Event()
            self.release_poll = threading.Event()

        def open_douyin_login(self, profile_path):
            assert profile_path.exists()
            with self._state_lock:
                if self._current_context is None:
                    self.open_count += 1
                    self._current_context = {
                        "handle": f"external-{self.open_count}",
                        "login_page": None,
                        "qr_status": "opening",
                        "qr_image_data_url": None,
                    }
                return dict(self._current_context)

        def poll_douyin_login(self, _context):
            self.poll_started.set()
            assert self.release_poll.wait(timeout=2)
            return {"active": False, "qr_status": "opening"}

        def abort_douyin_login(self, context):
            self.abort_calls.append(context["handle"])
            with self._state_lock:
                if self._current_context == context:
                    self._current_context = None
            self.release_poll.set()

        def close(self, context):
            super().close(context)
            with self._state_lock:
                if self._current_context == context:
                    self._current_context = None

    browser = DeduplicatingExternalBrowser()
    manager = AccountManager(
        tmp_path / "state",
        browser,
        profiles_root=tmp_path / "profiles",
        interaction_surface="external_window",
    )
    first = manager.create_login_session("a" * 64)
    _wait_for_login_bootstrap(manager, first.session_id)
    first_context = manager._sessions[first.session_id]["context"]
    poll_errors = []

    def poll_first():
        try:
            manager.get_login_session(first.session_id)
        except BaseException as error:
            poll_errors.append(error)

    poller = threading.Thread(target=poll_first)
    poller.start()
    assert browser.poll_started.wait(timeout=1)
    try:
        manager.disconnect(first.session_id)
        second = manager.create_login_session("a" * 64)
        _wait_for_login_bootstrap(manager, second.session_id)
        second_context = manager._sessions[second.session_id]["context"]

        assert browser.abort_calls == [first_context["handle"]]
        assert second_context["handle"] != first_context["handle"]
        assert browser.open_count == 2
    finally:
        browser.release_poll.set()
        poller.join(timeout=2)
        manager.close()

    assert not poller.is_alive()
    assert len(poll_errors) <= 1


def test_external_shutdown_preempts_blocked_poll_before_waiting_for_io_lock(
    tmp_path,
):
    class ShutdownPreemptBrowser(FakeBrowser):
        interaction_surface = "external_window"

        def __init__(self):
            super().__init__()
            self.poll_started = threading.Event()
            self.release_poll = threading.Event()
            self.lifecycle_calls: list[str] = []

        def open_douyin_login(self, profile_path):
            assert profile_path.exists()
            return {
                "handle": "shutdown-preempt-context",
                "login_page": None,
                "qr_status": "opening",
                "qr_image_data_url": None,
            }

        def poll_douyin_login(self, _context):
            self.poll_started.set()
            assert self.release_poll.wait(timeout=2)
            return {"active": False, "qr_status": "opening"}

        def abort_douyin_profile(self, _profile_path):
            self.lifecycle_calls.append("abort")
            self.release_poll.set()

        def close(self, context):
            self.lifecycle_calls.append("close")
            super().close(context)

    browser = ShutdownPreemptBrowser()
    manager = AccountManager(
        tmp_path / "state",
        browser,
        profiles_root=tmp_path / "profiles",
        interaction_surface="external_window",
    )
    created = manager.create_login_session("d" * 64)
    _wait_for_login_bootstrap(manager, created.session_id)
    poll_errors: list[BaseException] = []

    def poll_login():
        try:
            manager.get_login_session(created.session_id)
        except BaseException as error:
            poll_errors.append(error)

    poller = threading.Thread(target=poll_login)
    poller.start()
    assert browser.poll_started.wait(timeout=1)
    watchdog = threading.Timer(1, browser.release_poll.set)
    watchdog.start()
    try:
        started = time.monotonic()
        manager.close()
        elapsed = time.monotonic() - started
        poller.join(timeout=1)

        assert elapsed < 0.3
        assert browser.lifecycle_calls[0] == "abort"
        assert browser.lifecycle_calls.count("close") == 1
        assert not poller.is_alive()
        assert len(poll_errors) <= 1
    finally:
        watchdog.cancel()
        browser.release_poll.set()
        poller.join(timeout=1)
        manager.close()


def test_shutdown_persists_session_while_holding_its_io_lock(
    tmp_path,
    monkeypatch,
):
    browser = FakeBrowser()
    manager = AccountManager(tmp_path, browser)
    created = manager.create_login_session()
    _wait_for_login_bootstrap(manager, created.session_id)
    session = manager._sessions[created.session_id]
    persist_lock_states: list[bool] = []
    original_persist = manager._persist

    def record_persist(current):
        persist_lock_states.append(current["io_lock"].locked())
        original_persist(current)

    monkeypatch.setattr(manager, "_persist", record_persist)

    manager.close()

    assert persist_lock_states == [True]


def test_external_disconnect_fences_bootstrap_before_context_registration(
    tmp_path,
):
    class BlockingDeduplicatingExternalBrowser(FakeBrowser):
        interaction_surface = "external_window"

        def __init__(self):
            super().__init__()
            self._state_lock = threading.Lock()
            self._current_context = None
            self.first_open_started = threading.Event()
            self.release_first_open = threading.Event()
            self.open_count = 0
            self.aborted_profiles = []

        def open_douyin_login(self, profile_path):
            with self._state_lock:
                if self._current_context is None:
                    self.open_count += 1
                    self._current_context = {
                        "handle": f"external-{self.open_count}",
                        "login_page": None,
                        "qr_status": "opening",
                        "qr_image_data_url": None,
                    }
                context = dict(self._current_context)
                first = self.open_count == 1
            if first and not self.first_open_started.is_set():
                self.first_open_started.set()
                assert self.release_first_open.wait(timeout=2)
            return context

        def abort_douyin_profile(self, profile_path):
            self.aborted_profiles.append(Path(profile_path))
            with self._state_lock:
                self._current_context = None
            self.release_first_open.set()

        def poll_douyin_login(self, _context):
            return {"active": False, "qr_status": "opening"}

        def close(self, context):
            super().close(context)
            with self._state_lock:
                if self._current_context == context:
                    self._current_context = None

    browser = BlockingDeduplicatingExternalBrowser()
    manager = AccountManager(
        tmp_path / "state",
        browser,
        profiles_root=tmp_path / "profiles",
        interaction_surface="external_window",
    )
    first = manager.create_login_session("b" * 64)
    assert browser.first_open_started.wait(timeout=1)
    first_profile = manager._sessions[first.session_id]["profile"]
    try:
        manager.disconnect(first.session_id)
        second = manager.create_login_session("b" * 64)
        _wait_for_login_bootstrap(manager, second.session_id)
        second_context = manager._sessions[second.session_id]["context"]

        assert browser.aborted_profiles == [first_profile]
        assert second_context["handle"] == "external-2"
        assert browser.open_count == 2
    finally:
        browser.release_first_open.set()
        manager.close()


def test_cancelled_external_bootstrap_cannot_open_after_replacement(
    tmp_path,
    monkeypatch,
):
    class ProfileFencedExternalBrowser(FakeBrowser):
        interaction_surface = "external_window"

        def __init__(self):
            super().__init__()
            self._state_lock = threading.Lock()
            self._current_context = None
            self.open_count = 0
            self.closed_handles = []

        def open_douyin_login(self, profile_path):
            assert profile_path.exists()
            with self._state_lock:
                if self._current_context is None:
                    self.open_count += 1
                    self._current_context = {
                        "handle": f"external-{self.open_count}",
                        "login_page": None,
                        "qr_status": "opening",
                        "qr_image_data_url": None,
                    }
                return dict(self._current_context)

        def abort_douyin_profile(self, _profile_path):
            with self._state_lock:
                self._current_context = None

        def poll_douyin_login(self, _context):
            return {"active": False, "qr_status": "opening"}

        def close(self, context):
            self.closed_handles.append(context["handle"])
            with self._state_lock:
                if self._current_context == context:
                    self._current_context = None

    browser = ProfileFencedExternalBrowser()
    manager = AccountManager(
        tmp_path / "state",
        browser,
        profiles_root=tmp_path / "profiles",
        interaction_surface="external_window",
    )
    original_bootstrap = manager._bootstrap_login_session
    stale_ready = threading.Event()
    release_stale = threading.Event()
    stale_finished = threading.Event()
    call_count = 0
    call_lock = threading.Lock()

    def gated_bootstrap(*args):
        nonlocal call_count
        with call_lock:
            call_count += 1
            current_call = call_count
        if current_call == 1:
            stale_ready.set()
            assert release_stale.wait(timeout=2)
        try:
            original_bootstrap(*args)
        finally:
            if current_call == 1:
                stale_finished.set()

    monkeypatch.setattr(manager, "_bootstrap_login_session", gated_bootstrap)
    first = manager.create_login_session("c" * 64)
    assert stale_ready.wait(timeout=1)
    try:
        manager.disconnect(first.session_id)
        second = manager.create_login_session("c" * 64)
        release_stale.set()
        assert stale_finished.wait(timeout=1)
        _wait_for_login_bootstrap(manager, second.session_id)
        second_handle = manager._sessions[second.session_id]["context"]["handle"]

        assert second_handle not in browser.closed_handles
        assert browser.open_count == 1
    finally:
        release_stale.set()
        manager.close()


def test_background_login_open_failure_becomes_failed_and_cleans_private_resources(
    tmp_path,
    caplog,
):
    sensitive_detail = "cookie=must-not-appear-in-logs"

    class FailingLoginBrowser(FakeBrowser):
        def open_douyin_login(self, profile_path):
            assert profile_path.exists()
            raise RuntimeError(sensitive_detail)

    package_logger = logging.getLogger("shensi_adapter")
    package_logger.addHandler(caplog.handler)
    try:
        caplog.set_level("INFO", logger=accounts_module.__name__)
        manager = AccountManager(tmp_path, FailingLoginBrowser())
        try:
            created = manager.create_login_session()
            deadline = time.monotonic() + 1
            while time.monotonic() < deadline:
                failed = manager.get_login_session(created.session_id)
                if failed.state == "failed":
                    break
                time.sleep(0.01)
            else:
                pytest.fail("background login failure was not published")

            assert failed.login_page is None
            assert not any((tmp_path / "profiles").iterdir())
            assert all(
                thread.name != "douyin-login-bootstrap"
                for thread in threading.enumerate()
            )
            assert sensitive_detail not in caplog.text
            assert "error_type=RuntimeError" in caplog.text
            assert any(
                record.getMessage().startswith(
                    "douyin_login_bootstrap stage=open_failed "
                    "error_type=RuntimeError duration_ms="
                )
                for record in caplog.records
            )
        finally:
            manager.close()
    finally:
        package_logger.removeHandler(caplog.handler)


def test_background_login_open_failure_logs_only_safe_stage_and_error_code(
    tmp_path,
    caplog,
):
    api_key = "sk-login-diagnostic-must-not-leak"
    private_url = (
        "https://www.douyin.com/login/?ticket=must-not-leak"
    )

    class StagedOpenFailure(RuntimeError):
        stage = "browser_launch"
        error_code = "douyin_login_open_failed"

    class FailingLiveDisplayBrowser(FakeBrowser):
        def open_douyin_login(self, profile_path):
            raise StagedOpenFailure(
                f"api_key={api_key} url={private_url} "
                f"profile={profile_path.resolve()}"
            )

    package_logger = logging.getLogger("shensi_adapter")
    package_logger.addHandler(caplog.handler)
    try:
        caplog.set_level("INFO", logger=accounts_module.__name__)
        manager = AccountManager(tmp_path, FailingLiveDisplayBrowser())
        try:
            created = manager.create_login_session()
            failed = _wait_for_login_state(
                manager,
                created.session_id,
                "failed",
            )
            _wait_for_login_bootstrap(manager, created.session_id)

            assert failed.failure_code == "douyin_login_open_failed"
            diagnostic_messages = [
                record.getMessage()
                for record in caplog.records
                if record.getMessage().startswith(
                    "douyin_login_bootstrap stage=browser_launch "
                )
            ]
            assert len(diagnostic_messages) == 1
            assert (
                "error_code=douyin_login_open_failed"
                in diagnostic_messages[0]
            )
            assert api_key not in caplog.text
            assert private_url not in caplog.text
            assert str(tmp_path.resolve()) not in caplog.text
        finally:
            manager.close()
    finally:
        package_logger.removeHandler(caplog.handler)


def test_background_login_open_publishes_only_a_closed_safe_failure_code(
    tmp_path,
):
    class UnsupportedLoginBrowser(FakeBrowser):
        def open_douyin_login(self, profile_path):
            assert profile_path.exists()
            raise RuntimeError("douyin_login_ui_unsupported")

    manager = AccountManager(tmp_path, UnsupportedLoginBrowser())
    try:
        created = manager.create_login_session()
        failed = _wait_for_login_state(
            manager,
            created.session_id,
            "failed",
        )

        assert failed.failure_code == "douyin_login_ui_unsupported"
    finally:
        manager.close()


def test_unknown_background_login_error_is_replaced_by_a_generic_safe_code(
    tmp_path,
):
    class SensitiveFailureBrowser(FakeBrowser):
        def open_douyin_login(self, _profile_path):
            raise RuntimeError("cookie=must-not-cross-the-api-boundary")

    manager = AccountManager(tmp_path, SensitiveFailureBrowser())
    try:
        created = manager.create_login_session()
        failed = _wait_for_login_state(
            manager,
            created.session_id,
            "failed",
        )

        assert failed.failure_code == "douyin_login_open_failed"
    finally:
        manager.close()


def test_malformed_background_login_result_fails_closed_without_leaking_resources(
    tmp_path,
):
    class MalformedLoginBrowser(FakeBrowser):
        def open_douyin_login(self, profile_path):
            assert profile_path.exists()
            return object()

    manager = AccountManager(tmp_path, MalformedLoginBrowser())
    try:
        created = manager.create_login_session()
        failed = _wait_for_login_state(
            manager,
            created.session_id,
            "failed",
        )

        assert failed.login_page is None
        assert not any((tmp_path / "profiles").iterdir())
        assert all(
            thread.name != "douyin-login-bootstrap"
            for thread in threading.enumerate()
        )
    finally:
        manager.close()


@pytest.mark.parametrize("end_session", ["disconnect", "expire"])
def test_cancelled_or_expired_background_login_discards_late_browser_context(
    tmp_path,
    end_session,
):
    class BlockingLoginBrowser(FakeBrowser):
        def __init__(self):
            super().__init__()
            self.open_started = threading.Event()
            self.release_open = threading.Event()

        def open_douyin_login(self, profile_path):
            assert profile_path.exists()
            self.open_started.set()
            assert self.release_open.wait(timeout=2)
            profile_path.mkdir(mode=0o700, parents=True, exist_ok=True)
            (profile_path / "late-browser-state").write_text(
                "recreated after cancellation",
                encoding="utf-8",
            )
            return {"login_page": LOGIN_PAGE_FRAME}

    now = datetime(2026, 8, 24, tzinfo=UTC)
    browser = BlockingLoginBrowser()
    manager = AccountManager(
        tmp_path,
        browser,
        now=lambda: now,
        session_ttl=timedelta(minutes=1),
    )
    try:
        created = manager.create_login_session()
        assert browser.open_started.wait(timeout=1)

        if end_session == "disconnect":
            manager.disconnect(created.session_id)
            with pytest.raises(KeyError):
                manager.get_login_session(created.session_id)
        else:
            expired = manager.get_login_session(
                created.session_id,
                now + timedelta(minutes=2),
            )
            assert expired.state == "expired"
            assert not any((tmp_path / "profiles").iterdir())
        browser.release_open.set()
        deadline = time.monotonic() + 1
        while time.monotonic() < deadline:
            if browser.closed == 1 and all(
                thread.name != "douyin-login-bootstrap"
                for thread in threading.enumerate()
            ):
                break
            time.sleep(0.01)
        else:
            pytest.fail("late browser context or bootstrap thread leaked")
        assert not any((tmp_path / "profiles").iterdir())

        with pytest.raises(KeyError):
            manager.get_login_session(created.session_id)
    finally:
        browser.release_open.set()
        manager.close()


def test_account_manager_reloads_durable_active_metadata_and_retains_it_after_qr_expiry(tmp_path):
    now = datetime(2026, 8, 24, tzinfo=UTC)
    browser = FakeBrowser()
    manager = AccountManager(tmp_path, browser, now=lambda: now, session_ttl=timedelta(minutes=1))

    session = manager.create_login_session()
    active = _wait_for_login_state(manager, session.session_id, "active")
    profile_dirs = list((tmp_path / "profiles").iterdir())
    account_metadata = profile_dirs[0] / ".shensi-connected-account.json"
    assert account_metadata.is_file()
    assert "expires_at" not in json.loads(account_metadata.read_text(encoding="utf-8"))
    manager.close()

    metadata = profile_dirs[0] / ".shensi-login-session.json"
    os.chmod(profile_dirs[0], 0o777)
    os.chmod(metadata, 0o666)

    restarted = AccountManager(tmp_path, FakeBrowser(), now=lambda: now, session_ttl=timedelta(minutes=1))
    reloaded = restarted.get_login_session(session.session_id)

    assert active.account_handle is not None
    assert reloaded.state == "active"
    assert reloaded.account_handle == active.account_handle
    assert reloaded.account_display_name == "Douyin"
    assert profile_dirs[0].is_dir()
    assert oct(profile_dirs[0].stat().st_mode & 0o777) == "0o700"
    assert oct(metadata.stat().st_mode & 0o777) == "0o600"
    assert restarted.sweep_expired(now + timedelta(minutes=2)) == 1
    assert profile_dirs[0].exists()
    assert restarted.resolve_crawl_profile(active.account_handle, 1) == profile_dirs[0]
    restarted.close()


def test_restart_evicts_unrecoverable_unbound_login_placeholder(tmp_path):
    manager = AccountManager(tmp_path, FakeBrowser())
    created = manager.create_login_session()
    _wait_for_login_bootstrap(manager, created.session_id)
    manager.close()
    assert any((tmp_path / "profiles").iterdir())

    restarted = AccountManager(tmp_path, FakeBrowser())
    try:
        with pytest.raises(KeyError):
            restarted.get_login_session(created.session_id)
        assert not any((tmp_path / "profiles").iterdir())
    finally:
        restarted.close()


def test_account_manager_uses_stable_hashed_handle_and_monotonic_login_version(
    tmp_path,
):
    now = datetime(2026, 8, 24, tzinfo=UTC)
    first_manager = AccountManager(
        tmp_path,
        FakeBrowser(),
        now=lambda: now,
        session_ttl=timedelta(minutes=1),
    )
    first_session = first_manager.create_login_session()
    first = _wait_for_login_state(
        first_manager, first_session.session_id, "active"
    )
    repeated = first_manager.get_login_session(first_session.session_id)

    expected_handle = account_handle_for_fingerprint(ACCOUNT_FINGERPRINT)
    assert first.account_handle == expected_handle
    assert repeated.account_handle == expected_handle
    assert first.login_state_version == 1
    assert repeated.login_state_version == 1
    first_manager.disconnect(first_session.session_id)
    first_manager.close()

    restarted = AccountManager(
        tmp_path,
        FakeBrowser(),
        now=lambda: now,
        session_ttl=timedelta(minutes=1),
    )
    second_session = restarted.create_login_session()
    second = _wait_for_login_state(
        restarted, second_session.session_id, "active"
    )

    assert second.account_handle == expected_handle
    assert second.login_state_version == 2
    ledger = tmp_path / ".shensi-account-identity-ledger.json"
    persisted = json.loads(ledger.read_text(encoding="utf-8"))
    assert persisted == {
        "version": 1,
        "last_login_state_version": 2,
    }
    assert "MS4wLjABFixtureAccount" not in ledger.read_text(encoding="utf-8")
    assert oct(ledger.stat().st_mode & 0o777) == "0o600"
    restarted.close()


def test_login_state_version_ledger_is_atomic_across_processes(tmp_path):
    context = multiprocessing.get_context("spawn")
    start = context.Event()
    results = context.Queue()
    processes = [
        context.Process(
            target=_allocate_login_version_in_process,
            args=(str(tmp_path), start, results),
        )
        for _index in range(2)
    ]
    for process in processes:
        process.start()
    start.set()
    observed = [results.get(timeout=10) for _index in processes]
    for process in processes:
        process.join(timeout=10)
        assert process.exitcode == 0

    assert sorted(observed) == [("ok", 1), ("ok", 2)]
    ledger = json.loads((
        tmp_path / ".shensi-account-identity-ledger.json"
    ).read_text(encoding="utf-8"))
    assert ledger["last_login_state_version"] == 2
    assert oct((
        tmp_path / ".shensi-account-identity-ledger.lock"
    ).stat().st_mode & 0o777) == "0o600"
    results.close()
    results.join_thread()


def test_account_activation_syncs_identity_files_before_returning_active(
    tmp_path,
    monkeypatch,
):
    browser = FakeBrowser()
    manager = AccountManager(tmp_path, browser)
    created = manager.create_login_session()
    events = []
    real_fsync = os.fsync
    real_replace = os.replace

    def recording_fsync(descriptor):
        kind = (
            "directory_fsync"
            if stat.S_ISDIR(os.fstat(descriptor).st_mode)
            else "file_fsync"
        )
        events.append(kind)
        real_fsync(descriptor)

    def recording_replace(source, destination):
        events.append(f"replace:{Path(destination).name}")
        real_replace(source, destination)

    monkeypatch.setattr(accounts_module.os, "fsync", recording_fsync)
    monkeypatch.setattr(accounts_module.os, "replace", recording_replace)
    try:
        active = _wait_for_login_state(manager, created.session_id, "active")
        observed = list(events)
    finally:
        manager.close()

    assert active.state == "active"
    assert observed == [
        "file_fsync",
        "replace:.shensi-account-identity-ledger.json",
        "directory_fsync",
        "file_fsync",
        "replace:.shensi-connected-account.json",
        "directory_fsync",
        "file_fsync",
        "replace:.shensi-login-session.json",
        "directory_fsync",
    ]


@pytest.mark.parametrize(
    ("failure_stage", "failure_kind", "failure_occurrence"),
    [
        ("ledger", "file", 1),
        ("ledger", "directory", 1),
        ("binding", "file", 2),
        ("binding", "directory", 2),
    ],
)
def test_account_activation_fails_closed_when_identity_sync_fails(
    tmp_path,
    monkeypatch,
    failure_stage,
    failure_kind,
    failure_occurrence,
):
    browser = FakeBrowser()
    manager = AccountManager(tmp_path, browser)
    created = manager.create_login_session()
    profile = manager._sessions[created.session_id]["profile"]
    sync_counts = {"file": 0, "directory": 0}
    real_fsync = os.fsync

    def failing_fsync(descriptor):
        kind = (
            "directory"
            if stat.S_ISDIR(os.fstat(descriptor).st_mode)
            else "file"
        )
        sync_counts[kind] += 1
        if kind == failure_kind and sync_counts[kind] == failure_occurrence:
            raise OSError(f"simulated_{failure_stage}_{kind}_fsync_failure")
        real_fsync(descriptor)

    monkeypatch.setattr(accounts_module.os, "fsync", failing_fsync)
    try:
        with pytest.raises(
            OSError,
            match=f"simulated_{failure_stage}_{failure_kind}_fsync_failure",
        ):
            _wait_for_login_state(manager, created.session_id, "active")

        assert manager._accounts == {}
        assert created.session_id not in manager._sessions
        assert not profile.exists()
        assert browser.closed == 1
    finally:
        manager.close()


def test_account_metadata_writer_refuses_a_symlink_temporary_file(tmp_path):
    target = tmp_path / ".shensi-connected-account.json"
    temporary = target.with_suffix(".tmp")
    victim = tmp_path / "victim.json"
    victim.write_text("do-not-overwrite", encoding="utf-8")
    temporary.symlink_to(victim)

    with pytest.raises((OSError, ValueError)):
        AccountManager._write_metadata(target, {"version": 1})

    assert victim.read_text(encoding="utf-8") == "do-not-overwrite"
    assert not target.exists()


def test_account_manager_fails_closed_when_login_identity_or_name_is_missing(
    tmp_path,
):
    class UnboundBrowser(FakeBrowser):
        def poll_douyin_login(self, _context):
            return {
                "active": False,
                "identity_error": "douyin_account_identity_missing",
            }

    manager = AccountManager(tmp_path, UnboundBrowser())
    created = manager.create_login_session()

    failed = _wait_for_login_state(manager, created.session_id, "failed")

    assert failed.state == "failed"
    assert failed.account_handle is None
    assert failed.account_display_name is None
    assert failed.login_state_version is None
    assert manager._accounts == {}
    manager.close()


def test_account_manager_refuses_corrupt_monotonic_identity_ledger(tmp_path):
    ledger = tmp_path / ".shensi-account-identity-ledger.json"
    ledger.write_text('{"version":1,"last_login_state_version":-1}',
                      encoding="utf-8")

    with pytest.raises(ValueError, match="invalid identity ledger"):
        AccountManager(tmp_path, FakeBrowser())


def test_old_same_identity_session_cannot_remove_newer_account_authority(
    tmp_path,
):
    clock = [datetime(2026, 8, 24, tzinfo=UTC)]
    manager = AccountManager(
        tmp_path,
        FakeBrowser(),
        now=lambda: clock[0],
        session_ttl=timedelta(minutes=1),
    )
    old_session = manager.create_login_session()
    old_account = _wait_for_login_state(
        manager, old_session.session_id, "active"
    )
    new_session = manager.create_login_session()
    new_account = _wait_for_login_state(
        manager, new_session.session_id, "active"
    )

    assert old_account.account_handle == new_account.account_handle
    assert old_account.login_state_version == 1
    assert new_account.login_state_version == 2
    new_profile = manager._sessions[new_session.session_id]["profile"]

    clock[0] += timedelta(minutes=2)
    manager.get_login_session(old_session.session_id, clock[0])
    assert manager.resolve_action_profile(
        new_account.account_handle,
        new_account.login_state_version,
    ) == new_profile

    manager.disconnect(old_session.session_id)
    assert manager.resolve_action_profile(
        new_account.account_handle,
        new_account.login_state_version,
    ) == new_profile
    manager.close()


def test_action_checkpoint_rejects_same_account_login_version_supersession(
    tmp_path,
):
    browser = FakeBrowser()
    manager = AccountManager(tmp_path, browser)
    first_session = manager.create_login_session()
    first = _wait_for_login_state(manager, first_session.session_id, "active")
    profile = manager.resolve_action_profile(
        first.account_handle,
        first.login_state_version,
    )
    newer_session = manager.create_login_session()
    newer = _wait_for_login_state(
        manager, newer_session.session_id, "active"
    )
    assert newer.login_state_version == 2

    with pytest.raises(
        Exception,
        match="douyin_account_identity_changed",
    ):
        manager.execute_action(profile, SimpleNamespace(
            account_handle=first.account_handle,
            login_state_version=first.login_state_version,
        ))

    manager.close()


def test_action_authority_lease_blocks_reconnect_without_lock_inversion(
    tmp_path,
):
    class BlockingActionBrowser(FakeBrowser):
        def __init__(self):
            super().__init__()
            self.action_started = threading.Event()
            self.release_action = threading.Event()

        def execute_douyin_action(
            self, _profile, _request, *, authority_validator,
        ):
            authority_validator()
            self.action_started.set()
            assert self.release_action.wait(timeout=2)
            authority_validator()
            return {"state": "succeeded"}

    browser = BlockingActionBrowser()
    manager = AccountManager(tmp_path, browser)
    first_session = manager.create_login_session()
    first = _wait_for_login_state(manager, first_session.session_id, "active")
    profile = manager.resolve_action_profile(
        first.account_handle,
        first.login_state_version,
    )
    action_errors = []
    reconnect_results = []

    def run_action():
        try:
            manager.execute_action(profile, SimpleNamespace(
                account_handle=first.account_handle,
                login_state_version=first.login_state_version,
            ))
        except BaseException as error:
            action_errors.append(error)

    def reconnect():
        created = manager.create_login_session()
        reconnect_results.append(
            _wait_for_login_state(manager, created.session_id, "active")
        )

    action_thread = threading.Thread(target=run_action)
    action_thread.start()
    assert browser.action_started.wait(timeout=1)
    reconnect_thread = threading.Thread(target=reconnect)
    reconnect_thread.start()
    time.sleep(0.05)
    assert reconnect_thread.is_alive()
    assert reconnect_results == []

    browser.release_action.set()
    action_thread.join(timeout=2)
    reconnect_thread.join(timeout=2)

    assert not action_thread.is_alive()
    assert not reconnect_thread.is_alive()
    assert action_errors == []
    assert reconnect_results[0].login_state_version == 2
    manager.close()


def test_login_state_version_is_global_across_different_real_accounts(
    tmp_path,
):
    fingerprints = iter([
        identity_fingerprint_for_raw_sec_uid("MS4wLjABAccountA"),
        identity_fingerprint_for_raw_sec_uid("MS4wLjABAccountB"),
    ])

    class SwitchingBrowser(FakeBrowser):
        def poll_douyin_login(self, _context):
            return {
                "active": True,
                "display_name": "账号 A" if not hasattr(
                    self, "_returned_once"
                ) else "账号 B",
                "identity_fingerprint": next(fingerprints),
            }

    browser = SwitchingBrowser()
    manager = AccountManager(tmp_path, browser)
    first_session = manager.create_login_session()
    first = _wait_for_login_state(manager, first_session.session_id, "active")
    browser._returned_once = True
    second_session = manager.create_login_session()
    second = _wait_for_login_state(manager, second_session.session_id, "active")

    assert first.account_handle != second.account_handle
    assert first.login_state_version == 1
    assert second.login_state_version == 2
    with pytest.raises(KeyError, match="active_account_not_found"):
        manager.resolve_action_profile(
            second.account_handle,
            first.login_state_version,
        )
    manager.close()


@pytest.mark.parametrize("ephemeral", ["missing", "malformed"])
def test_durable_active_account_can_crawl_after_qr_ttl_and_fresh_manager_restart(
    tmp_path, ephemeral
):
    clock = [datetime(2026, 8, 24, tzinfo=UTC)]
    manager = AccountManager(
        tmp_path, FakeBrowser(), now=lambda: clock[0],
        session_ttl=timedelta(minutes=1),
    )
    session = manager.create_login_session()
    active = _wait_for_login_state(manager, session.session_id, "active")
    assert active.account_handle is not None
    manager.close()

    clock[0] += timedelta(minutes=2)
    ephemeral_metadata = next((tmp_path / "profiles").iterdir()).joinpath(
        ".shensi-login-session.json"
    )
    if ephemeral == "missing":
        ephemeral_metadata.unlink()
    else:
        ephemeral_metadata.write_text("not-json", encoding="utf-8")
    restarted = AccountManager(
        tmp_path, FakeBrowser(), now=lambda: clock[0],
        session_ttl=timedelta(minutes=1),
    )
    crawl = CrawlJobManager(
        tmp_path,
        account_resolver=restarted.resolve_crawl_profile,
        runner=lambda *_: [],
        now=lambda: clock[0],
    )
    crawl.start(CrawlJobRequest(
        job_id="post-ttl-job", account_handle=active.account_handle,
        login_state_version=1, keywords=["pump"], max_videos=1,
        max_comments_per_video=1, max_pages_per_video=1,
        collect_creators=True, collect_demand_comments=True,
        deadline_at=clock[0] + timedelta(minutes=1),
    ))

    deadline = time.monotonic() + 1
    while crawl.get("post-ttl-job").state not in {"succeeded", "failed"}:
        assert time.monotonic() < deadline
        time.sleep(0.01)
    assert crawl.get("post-ttl-job").state == "succeeded"
    crawl.close()
    restarted.disconnect(session.session_id)
    restarted.close()
    assert not any((tmp_path / "profiles").iterdir())


def test_expiry_evicts_session_and_profile_even_when_context_close_fails(tmp_path):
    now = datetime(2026, 8, 24, tzinfo=UTC)
    manager = AccountManager(
        tmp_path,
        FailingCloseBrowser(),
        now=lambda: now,
        session_ttl=timedelta(minutes=1),
    )
    session = manager.create_login_session()
    _wait_for_login_bootstrap(manager, session.session_id)
    profile = next((tmp_path / "profiles").iterdir())

    with pytest.raises(RuntimeError, match="context close failed"):
        manager.get_login_session(session.session_id, now + timedelta(minutes=2))

    assert not profile.exists()
    with pytest.raises(KeyError):
        manager.get_login_session(session.session_id)
    manager.close()


def test_disconnect_evicts_session_and_records_async_context_close_failure(tmp_path):
    browser = FailingCloseBrowser()
    manager = AccountManager(tmp_path, browser)
    session = manager.create_login_session()
    _wait_for_login_bootstrap(manager, session.session_id)
    profile = next((tmp_path / "profiles").iterdir())

    manager.disconnect(session.session_id)
    deadline = time.monotonic() + 1
    while profile.exists() and time.monotonic() < deadline:
        time.sleep(0.01)

    assert not profile.exists()
    assert browser.closed == 1
    with pytest.raises(KeyError):
        manager.disconnect(session.session_id)
    with pytest.raises(RuntimeError, match="context close failed"):
        manager.close()


def test_sweeper_survives_per_session_close_failures(tmp_path):
    clock = [datetime(2026, 8, 24, tzinfo=UTC)]
    manager = AccountManager(
        tmp_path,
        FailingCloseBrowser(),
        now=lambda: clock[0],
        session_ttl=timedelta(milliseconds=20),
        sweep_interval=timedelta(milliseconds=10),
    )

    manager.create_login_session()
    clock[0] += timedelta(seconds=1)
    deadline = time.monotonic() + 1
    while any((tmp_path / "profiles").iterdir()) and time.monotonic() < deadline:
        time.sleep(0.01)
    assert not any((tmp_path / "profiles").iterdir())

    manager.create_login_session()
    clock[0] += timedelta(seconds=1)
    deadline = time.monotonic() + 1
    while any((tmp_path / "profiles").iterdir()) and time.monotonic() < deadline:
        time.sleep(0.01)
    assert not any((tmp_path / "profiles").iterdir())
    manager.close()


def test_persistence_failure_after_browser_creation_removes_all_owned_state(
    tmp_path, monkeypatch
):
    browser = FakeBrowser()
    manager = AccountManager(tmp_path, browser)
    monkeypatch.setattr(
        manager,
        "_persist",
        lambda _session: (_ for _ in ()).throw(RuntimeError("metadata write failed")),
    )

    with pytest.raises(RuntimeError, match="metadata write failed"):
        manager.create_login_session()

    assert browser.closed == 0
    assert not any((tmp_path / "profiles").iterdir())
    assert manager._sessions == {}
    manager.close()


def test_active_login_persistence_failure_closes_context_once_and_rolls_back(
    tmp_path,
    monkeypatch,
):
    browser = FakeBrowser()
    manager = AccountManager(tmp_path, browser)
    created = manager.create_login_session()
    _wait_for_login_bootstrap(manager, created.session_id)
    profile = manager._sessions[created.session_id]["profile"]
    persistence_error = RuntimeError("account metadata write failed")
    monkeypatch.setattr(
        manager,
        "_persist_account",
        lambda _session: (_ for _ in ()).throw(persistence_error),
    )

    with pytest.raises(RuntimeError) as failure:
        manager.get_login_session(created.session_id)

    assert failure.value is persistence_error
    assert browser.closed == 1
    assert manager._sessions == {}
    assert manager._accounts == {}
    assert not profile.exists()
    manager.close()


def test_active_login_ledger_failure_closes_context_once_and_rolls_back(
    tmp_path,
    monkeypatch,
):
    browser = FakeBrowser()
    manager = AccountManager(tmp_path, browser)
    created = manager.create_login_session()
    _wait_for_login_bootstrap(manager, created.session_id)
    profile = manager._sessions[created.session_id]["profile"]
    ledger_error = RuntimeError("identity ledger write failed")
    monkeypatch.setattr(
        manager,
        "_next_login_state_version",
        lambda: (_ for _ in ()).throw(ledger_error),
    )

    with pytest.raises(RuntimeError) as failure:
        manager.get_login_session(created.session_id)

    assert failure.value is ledger_error
    assert browser.closed == 1
    assert manager._sessions == {}
    assert manager._accounts == {}
    assert not profile.exists()
    manager.close()


def test_identity_failure_persistence_error_closes_context_once_and_rolls_back(
    tmp_path,
    monkeypatch,
):
    class IdentityFailureBrowser(FakeBrowser):
        def poll_douyin_login(self, _context):
            return {
                "active": False,
                "identity_error": "douyin_account_identity_missing",
            }

    browser = IdentityFailureBrowser()
    manager = AccountManager(tmp_path, browser)
    created = manager.create_login_session()
    _wait_for_login_bootstrap(manager, created.session_id)
    profile = manager._sessions[created.session_id]["profile"]
    persistence_error = RuntimeError("session metadata write failed")
    monkeypatch.setattr(
        manager,
        "_persist",
        lambda _session: (_ for _ in ()).throw(persistence_error),
    )

    with pytest.raises(RuntimeError) as failure:
        manager.get_login_session(created.session_id)

    assert failure.value is persistence_error
    assert browser.closed == 1
    assert manager._sessions == {}
    assert manager._accounts == {}
    assert not profile.exists()
    manager.close()


def test_active_login_context_close_failure_rolls_back_without_authority(
    tmp_path,
):
    browser = FailingCloseBrowser()
    manager = AccountManager(tmp_path, browser)
    created = manager.create_login_session()
    _wait_for_login_bootstrap(manager, created.session_id)
    profile = manager._sessions[created.session_id]["profile"]

    with pytest.raises(RuntimeError, match="context close failed"):
        manager.get_login_session(created.session_id)

    assert browser.closed == 1
    assert manager._last_login_state_version == 0
    assert manager._sessions == {}
    assert manager._accounts == {}
    assert not profile.exists()
    manager.close()


def test_disconnect_during_active_login_close_never_commits_authority(tmp_path):
    class BlockingCloseBrowser(FakeBrowser):
        def __init__(self):
            super().__init__()
            self.close_started = threading.Event()
            self.release_close = threading.Event()

        def close(self, _context):
            self.close_started.set()
            assert self.release_close.wait(timeout=2)
            self.closed += 1

    browser = BlockingCloseBrowser()
    manager = AccountManager(tmp_path, browser)
    created = manager.create_login_session()
    _wait_for_login_bootstrap(manager, created.session_id)
    profile = manager._sessions[created.session_id]["profile"]
    get_errors = []
    disconnect_errors = []

    def activate():
        try:
            manager.get_login_session(created.session_id)
        except BaseException as error:
            get_errors.append(error)

    def disconnect():
        try:
            manager.disconnect(created.session_id)
        except BaseException as error:
            disconnect_errors.append(error)

    getter = threading.Thread(target=activate)
    disconnector = threading.Thread(target=disconnect)
    getter.start()
    assert browser.close_started.wait(timeout=1)
    disconnector.start()
    try:
        deadline = time.monotonic() + 1
        while created.session_id in manager._sessions:
            assert time.monotonic() < deadline
            time.sleep(0.01)
        disconnector.join(timeout=0.5)
        assert not disconnector.is_alive()
    finally:
        browser.release_close.set()
        getter.join(timeout=2)
        disconnector.join(timeout=2)

    deadline = time.monotonic() + 1
    while profile.exists() and time.monotonic() < deadline:
        time.sleep(0.01)

    assert not getter.is_alive()
    assert not disconnector.is_alive()
    assert len(get_errors) == 1
    assert isinstance(get_errors[0], KeyError)
    assert disconnect_errors == []
    assert browser.closed == 1
    assert manager._last_login_state_version == 0
    assert manager._sessions == {}
    assert manager._accounts == {}
    assert not profile.exists()
    manager.close()


def test_manager_close_does_not_reindex_session_detached_after_snapshot(
    tmp_path,
    monkeypatch,
):
    browser = FakeBrowser()
    manager = AccountManager(tmp_path, browser)
    created = manager.create_login_session()
    active = _wait_for_login_state(manager, created.session_id, "active")
    session = manager._sessions[created.session_id]
    cleanup_started = threading.Event()
    release_cleanup = threading.Event()
    original_cleanup = manager._cleanup_detached_session

    def delayed_cleanup(detached, *, delete_profile):
        cleanup_started.set()
        assert release_cleanup.wait(timeout=2)
        return original_cleanup(detached, delete_profile=delete_profile)

    monkeypatch.setattr(manager, "_cleanup_detached_session", delayed_cleanup)
    close_errors = []
    disconnect_errors = []
    session["io_lock"].acquire()

    def close_manager():
        try:
            manager.close()
        except BaseException as error:
            close_errors.append(error)

    def disconnect():
        try:
            manager.disconnect(created.session_id)
        except BaseException as error:
            disconnect_errors.append(error)

    closer = threading.Thread(target=close_manager)
    disconnector = threading.Thread(target=disconnect)
    closer.start()
    deadline = time.monotonic() + 1
    while not session["closing"]:
        assert time.monotonic() < deadline
        time.sleep(0.01)
    disconnector.start()
    assert cleanup_started.wait(timeout=1)
    assert created.session_id not in manager._sessions
    disconnector.join(timeout=1)
    assert not disconnector.is_alive()
    session["io_lock"].release()
    time.sleep(0.05)
    assert closer.is_alive()
    release_cleanup.set()
    closer.join(timeout=2)

    assert not closer.is_alive()
    assert not disconnector.is_alive()
    assert close_errors == []
    assert disconnect_errors == []
    assert active.account_handle not in manager._accounts
    assert manager._sessions == {}
    assert not session["profile"].exists()


def test_manager_close_does_not_run_expiry_sweep(tmp_path, monkeypatch):
    manager = AccountManager(tmp_path, FakeBrowser())
    sweep_calls = []
    monkeypatch.setattr(
        manager,
        "sweep_expired",
        lambda: sweep_calls.append("called"),
    )

    manager.close()

    assert sweep_calls == []


def test_login_bootstrap_thread_start_failure_rolls_back_session_and_profile(
    tmp_path,
    monkeypatch,
):
    browser = FakeBrowser()
    manager = AccountManager(tmp_path, browser)
    monkeypatch.setattr(
        accounts_module.threading.Thread,
        "start",
        lambda _thread: (_ for _ in ()).throw(
            RuntimeError("thread start failed")
        ),
    )

    with pytest.raises(RuntimeError, match="thread start failed"):
        manager.create_login_session()

    assert manager._sessions == {}
    assert manager._login_bootstraps == {}
    assert not any((tmp_path / "profiles").iterdir())
    assert browser.closed == 0
    manager.close()


def test_manager_close_waits_for_late_login_context_cleanup_without_thread_or_profile_leak(
    tmp_path,
):
    class ClosingLoginBrowser(FakeBrowser):
        def __init__(self):
            super().__init__()
            self.open_started = threading.Event()
            self.release_open = threading.Event()
            self.open_finished = threading.Event()

        def open_douyin_login(self, profile_path):
            assert profile_path.exists()
            self.open_started.set()
            assert self.release_open.wait(timeout=2)
            time.sleep(0.1)
            self.open_finished.set()
            return {"login_page": LOGIN_PAGE_FRAME}

        def close_browser(self):
            self.release_open.set()

    browser = ClosingLoginBrowser()
    manager = AccountManager(tmp_path, browser)
    manager.create_login_session()
    assert browser.open_started.wait(timeout=1)

    try:
        manager.close()

        assert browser.open_finished.is_set()
        assert browser.closed == 1
        assert not any((tmp_path / "profiles").iterdir())
        assert all(
            thread.name != "douyin-login-bootstrap"
            for thread in threading.enumerate()
        )
    finally:
        browser.release_open.set()
        deadline = time.monotonic() + 1
        while (
            any(
                thread.name == "douyin-login-bootstrap"
                for thread in threading.enumerate()
            )
            and time.monotonic() < deadline
        ):
            time.sleep(0.01)


def test_manager_close_snapshots_bootstrap_until_late_context_cleanup_finishes(
    tmp_path,
):
    class BlockingLateCloseBrowser(FakeBrowser):
        def __init__(self):
            super().__init__()
            self.open_started = threading.Event()
            self.release_open = threading.Event()
            self.close_started = threading.Event()
            self.release_close = threading.Event()

        def open_douyin_login(self, profile_path):
            assert profile_path.exists()
            self.open_started.set()
            assert self.release_open.wait(timeout=2)
            return {"login_page": LOGIN_PAGE_FRAME}

        def close(self, _context):
            self.close_started.set()
            assert self.release_close.wait(timeout=2)
            self.closed += 1

    browser = BlockingLateCloseBrowser()
    manager = AccountManager(tmp_path, browser)
    created = manager.create_login_session()
    assert browser.open_started.wait(timeout=1)
    manager.disconnect(created.session_id)
    browser.release_open.set()
    assert browser.close_started.wait(timeout=1)

    close_errors = []
    close_done = threading.Event()

    def close_manager():
        try:
            manager.close()
        except BaseException as error:
            close_errors.append(error)
        finally:
            close_done.set()

    closer = threading.Thread(target=close_manager)
    closer.start()
    try:
        assert not close_done.wait(timeout=0.3)
    finally:
        browser.release_close.set()
        closer.join(timeout=2)

    assert not closer.is_alive()
    assert close_errors == []
    assert browser.closed == 1
    assert all(
        thread.name != "douyin-login-bootstrap"
        for thread in threading.enumerate()
    )


def test_browser_startup_error_is_returned_without_leaking_worker_thread():
    before = {thread.ident for thread in __import__("threading").enumerate()}

    with pytest.raises(RuntimeError, match="playwright unavailable"):
        MediaCrawlerDouyinBrowserState(
            playwright_factory=_startup_failure_factory, startup_timeout=2
        )

    after = {thread.ident for thread in __import__("threading").enumerate()}
    assert after == before


def test_browser_process_routes_create_poll_disconnect_without_exposing_context(tmp_path):
    browser = MediaCrawlerDouyinBrowserState(
        playwright_factory=_working_playwright_factory,
        startup_timeout=2,
        command_timeout=2,
    )
    try:
        if os.name == "posix":
            assert browser._owned_pgid == browser._process.pid
        opened = browser.open_douyin_login(tmp_path)
        assert opened["login_page"] is None
        assert set(opened) == {
            "handle",
            "login_page",
            "qr_status",
            "qr_image_data_url",
        }
        assert opened["qr_status"] == "opening"
        assert opened["qr_image_data_url"] is None
        prepared = browser.prepare_douyin_login(opened)
        assert prepared["login_page"] == {
            "image_data_url": "data:image/jpeg;base64,bG9naW4tanBlZw==",
            "width": 1280,
            "height": 800,
        }
        assert prepared["qr_status"] == "ready"
        assert prepared["qr_image_data_url"] == (
            "data:image/png;base64,cXI="
        )
        polled = browser.poll_douyin_login(opened)
        assert polled == {
            "active": True,
            "identity_fingerprint": ACCOUNT_FINGERPRINT,
            "display_name": "Douyin",
        }
        assert "MS4wLjABFixtureAccount" not in json.dumps(polled)
        browser.close(opened)
    finally:
        browser.close_browser()


def test_browser_default_command_budget_covers_login_navigation_and_qr_wait():
    browser = MediaCrawlerDouyinBrowserState(
        playwright_factory=_working_playwright_factory,
        startup_timeout=2,
    )
    try:
        assert browser._timeout == 65
    finally:
        browser.close_browser()


def test_browser_process_propagates_interactive_chrome_login_configuration(tmp_path):
    browser = MediaCrawlerDouyinBrowserState(
        playwright_factory=_interactive_chrome_only_playwright_factory,
        startup_timeout=2,
        command_timeout=2,
        headless=False,
        browser_channel="chrome",
    )
    try:
        opened = browser.open_douyin_login(tmp_path)
        assert opened["login_page"] is None
        assert opened["qr_status"] == "opening"
        prepared = browser.prepare_douyin_login(opened)
        assert prepared["login_page"] == {
            "image_data_url": "data:image/jpeg;base64,bG9naW4tanBlZw==",
            "width": 1280,
            "height": 800,
        }
    finally:
        browser.close_browser()


def test_interactive_login_allows_a_cold_start_before_capturing_the_page(tmp_path):
    context, opened = _open_context(
        _ColdStartQrPlaywright(),
        str(tmp_path),
        headless=False,
        browser_channel="chrome",
    )
    try:
        assert opened["login_page"] == LOGIN_PAGE_FRAME
        assert opened["qr_status"] == "ready"
        assert context.pages[0].goto_calls == [(
            "https://www.douyin.com/",
            {"wait_until": "domcontentloaded", "timeout": 10_000},
        )]
    finally:
        context.close()


def test_interactive_login_accepts_current_aria_label_qr_image(tmp_path):
    page = _StrictLoginPage(
        qr_selector='img[aria-label="二维码"]',
        qr_source="data:image/png;base64,bmV3LXFy",
    )

    assert browser_state_module._wait_for_qr_image(page) == (
        "data:image/png;base64,bmV3LXFy"
    )
    assert page.login_clicked is False


def test_interactive_login_recognizes_current_dynamic_full_panel(tmp_path):
    page = _StrictLoginPage(
        panel_selector='[id^="login-full-panel-"]',
        qr_selector="#animate_qrcode_container img",
        qr_source="data:image/png;base64,cXI=",
    )

    context, opened = _open_context(
        _strict_login_playwright(page),
        str(tmp_path),
        headless=False,
        browser_channel="chrome",
    )

    try:
        assert opened["login_page"] == LOGIN_PAGE_FRAME
        assert opened["qr_status"] == "ready"
        assert page.login_clicked is False
    finally:
        context.close()


def test_interactive_login_converts_canvas_qr_to_png_data_url(tmp_path):
    page = _StrictLoginPage(
        qr_selector="#animate_qrcode_container canvas",
        qr_screenshot=b"qr-png",
    )

    assert browser_state_module._wait_for_qr_image(page) == (
        "data:image/png;base64,cXItcG5n"
    )


def test_interactive_login_serializes_svg_qr_without_screenshot(tmp_path):
    page = _StrictLoginPage(
        qr_selector='svg[aria-label="二维码"]',
        qr_data_url="data:image/svg+xml;base64,PHN2Zy8+",
    )

    assert browser_state_module._wait_for_qr_image(page) == (
        "data:image/svg+xml;base64,PHN2Zy8+"
    )


def test_interactive_login_captures_current_panel_svg_image_qr(tmp_path):
    page = _StrictLoginPage(
        qr_selector="#login-panel-new svg image",
        qr_screenshot=b"current-panel-qr-png",
    )

    assert browser_state_module._wait_for_qr_image(page) == (
        "data:image/png;base64,Y3VycmVudC1wYW5lbC1xci1wbmc="
    )
    assert page.login_clicked is False


def test_interactive_login_captures_current_css_qr_container(tmp_path):
    screenshot = _qr_like_png()
    page = _StrictLoginPage(
        qr_selector="#animate_qrcode_container",
        qr_screenshot=screenshot,
    )

    assert browser_state_module._wait_for_qr_image(page) == (
        "data:image/png;base64,"
        + base64.b64encode(screenshot).decode("ascii")
    )
    assert page.login_clicked is False


def test_css_qr_capture_rejects_center_logo_without_point_matrix():
    screenshot = _png(
        lambda draw: draw.rectangle((70, 70, 110, 110), fill="black")
    )

    assert browser_state_module._qr_screenshot_has_modules(screenshot) is False


def test_css_qr_capture_accepts_distributed_point_matrix():
    assert browser_state_module._qr_screenshot_has_modules(
        _qr_like_png()
    ) is True


def test_blank_css_qr_stops_at_absolute_deadline_before_parent_ipc_timeout(
    monkeypatch,
):
    clock = [0.0]
    capture_timeouts = []
    blank_qr = _png(
        lambda draw: draw.rectangle((70, 70, 110, 110), fill="black")
    )

    class DeadlineLocator(_StrictLoginLocator):
        def screenshot(self, *, timeout):
            capture_timeouts.append(timeout)
            clock[0] += timeout / 1_000
            return blank_qr

    class BlankQrPage(_StrictLoginPage):
        def __init__(self):
            super().__init__(qr_selector="#animate_qrcode_container")

        def locator(self, selector):
            if selector == self.qr_selector:
                return DeadlineLocator(self, selector, visible=True)
            return super().locator(selector)

        def wait_for_timeout(self, milliseconds):
            clock[0] += milliseconds / 1_000

    monkeypatch.setattr(
        browser_state_module.time,
        "monotonic",
        lambda: clock[0],
    )

    with pytest.raises(
        RuntimeError,
        match="^douyin_qr_image_unavailable$",
    ):
        browser_state_module._wait_for_qr_image(BlankQrPage())

    assert capture_timeouts
    assert max(capture_timeouts) <= LOGIN_QR_CAPTURE_TIMEOUT_MS
    assert clock[0] <= LOGIN_QR_WAIT_MS / 1_000
    assert clock[0] < 65


def test_interactive_login_activates_the_qr_tab_when_phone_login_is_default(tmp_path):
    class QrTab(_StrictLoginLocator):
        def click(self, **_kwargs):
            self.page.qr_tab_active = True

    class PhoneDefaultPage(_StrictLoginPage):
        def __init__(self):
            self.activated_screenshot = _qr_like_png()
            super().__init__(
                qr_selector="#animate_qrcode_container",
                qr_screenshot=self.activated_screenshot,
            )
            self.qr_tab_active = False

        def locator(self, selector):
            if selector == 'button:has-text("扫码登录")':
                return QrTab(self, selector, visible=True, clickable=True)
            if selector == self.qr_selector:
                return _StrictLoginLocator(
                    self,
                    selector,
                    visible=self.qr_tab_active,
                    screenshot=self.qr_screenshot,
                )
            return super().locator(selector)

    page = PhoneDefaultPage()
    context, opened = _open_context(
        _strict_login_playwright(page),
        str(tmp_path),
        headless=False,
        browser_channel="chrome",
    )

    try:
        assert opened["login_page"] == LOGIN_PAGE_FRAME
        assert opened["qr_status"] == "ready"
        assert page.qr_tab_active is True
    finally:
        context.close()


def test_interactive_login_accepts_unique_square_qr_candidate(tmp_path):
    page = _StrictLoginPage(
        qr_selector="img, canvas, svg",
        qr_source="data:image/png;base64,c3F1YXJlLXFy",
        qr_metadata={
            "tag": "IMG",
            "source": "data:image/png;base64,c3F1YXJlLXFy",
            "width": 192,
            "height": 192,
            "hinted": True,
        },
    )

    assert browser_state_module._wait_for_qr_image(page) == (
        "data:image/png;base64,c3F1YXJlLXFy"
    )


def test_interactive_login_reports_verification_page_before_qr(tmp_path):
    page = _StrictLoginPage(title="验证码中间页", auto_panel=False)
    playwright = _strict_login_playwright(page)

    context, opened = _open_context(
        playwright,
        str(tmp_path),
        headless=False,
        browser_channel="chrome",
    )

    try:
        assert opened["qr_status"] == "verification_required"
        assert opened["qr_image_data_url"] is None
        assert opened["login_page"] == LOGIN_PAGE_FRAME
    finally:
        context.close()


def test_deployment_account_manager_uses_explicit_interactive_browser_settings(
    tmp_path, monkeypatch
):
    volume = tmp_path / "volume"
    profiles = volume / "profiles"
    profiles.mkdir(parents=True, mode=0o700)
    os.chmod(volume, 0o700)
    os.chmod(profiles, 0o700)
    monkeypatch.setenv("MEDIACRAWLER_ENCRYPTED_VOLUME", str(volume))
    monkeypatch.setenv("MEDIACRAWLER_PROFILE_ROOT", str(profiles))
    monkeypatch.setenv("MEDIACRAWLER_BROWSER_HEADLESS", "false")
    monkeypatch.setenv("MEDIACRAWLER_BROWSER_CHANNEL", "chrome")
    monkeypatch.setenv("SHENSI_RUNTIME_MODE", "web")
    monkeypatch.setenv("MEDIACRAWLER_BROWSER_DISPLAY", "virtual")
    monkeypatch.setenv("DISPLAY", ":99")
    monkeypatch.setattr("shensi_adapter.app.sys.platform", "linux")
    created_with = []

    def browser_factory(**kwargs):
        created_with.append(kwargs)
        return FakeBrowser()

    monkeypatch.setattr(
        "shensi_adapter.app.MediaCrawlerDouyinBrowserState", browser_factory
    )
    manager = create_deployment_account_manager()
    try:
        assert created_with == [
            {"headless": False, "browser_channel": "chrome",
             "interaction_surface": "remote_canvas"}
        ]
    finally:
        manager.close()


def test_deployment_account_manager_does_not_repurpose_generic_https_proxy(
    tmp_path, monkeypatch,
):
    volume = tmp_path / "volume"
    profiles = volume / "profiles"
    profiles.mkdir(parents=True, mode=0o700)
    os.chmod(volume, 0o700)
    os.chmod(profiles, 0o700)
    monkeypatch.setenv("MEDIACRAWLER_ENCRYPTED_VOLUME", str(volume))
    monkeypatch.setenv("MEDIACRAWLER_PROFILE_ROOT", str(profiles))
    monkeypatch.setenv("MEDIACRAWLER_BROWSER_HEADLESS", "false")
    monkeypatch.setenv("MEDIACRAWLER_BROWSER_CHANNEL", "")
    monkeypatch.setenv("HTTPS_PROXY", "http://192.168.5.2:7897")
    monkeypatch.setenv("SHENSI_RUNTIME_MODE", "web")
    monkeypatch.setenv("MEDIACRAWLER_BROWSER_DISPLAY", "virtual")
    monkeypatch.setenv("DISPLAY", ":99")
    monkeypatch.setattr("shensi_adapter.app.sys.platform", "linux")
    created_with = []

    def browser_factory(**kwargs):
        created_with.append(kwargs)
        return FakeBrowser()

    monkeypatch.setattr(
        "shensi_adapter.app.MediaCrawlerDouyinBrowserState", browser_factory
    )
    manager = create_deployment_account_manager()
    try:
        assert created_with == [{
            "headless": False,
            "browser_channel": None,
            "interaction_surface": "remote_canvas",
        }]
    finally:
        manager.close()


def test_deployment_account_manager_uses_an_explicit_browser_proxy(
    tmp_path, monkeypatch,
):
    volume = tmp_path / "volume"
    profiles = volume / "profiles"
    profiles.mkdir(parents=True, mode=0o700)
    os.chmod(volume, 0o700)
    os.chmod(profiles, 0o700)
    monkeypatch.setenv("MEDIACRAWLER_ENCRYPTED_VOLUME", str(volume))
    monkeypatch.setenv("MEDIACRAWLER_PROFILE_ROOT", str(profiles))
    monkeypatch.setenv("MEDIACRAWLER_BROWSER_HEADLESS", "false")
    monkeypatch.setenv("MEDIACRAWLER_BROWSER_CHANNEL", "")
    monkeypatch.setenv(
        "MEDIACRAWLER_BROWSER_PROXY",
        "http://192.168.5.2:7897",
    )
    monkeypatch.setenv("SHENSI_RUNTIME_MODE", "web")
    monkeypatch.setenv("MEDIACRAWLER_BROWSER_DISPLAY", "virtual")
    monkeypatch.setenv("DISPLAY", ":99")
    monkeypatch.setattr("shensi_adapter.app.sys.platform", "linux")
    created_with = []

    def browser_factory(**kwargs):
        created_with.append(kwargs)
        return FakeBrowser()

    monkeypatch.setattr(
        "shensi_adapter.app.MediaCrawlerDouyinBrowserState", browser_factory
    )
    manager = create_deployment_account_manager()
    try:
        assert created_with == [{
            "headless": False,
            "browser_channel": None,
            "interaction_surface": "remote_canvas",
            "browser_proxy": "http://192.168.5.2:7897",
        }]
    finally:
        manager.close()


@pytest.mark.parametrize("proxy", [
    "file:///tmp/proxy",
    "http://proxy.example:7897/path",
    "http://user:secret@proxy.example:7897",
    "http://",
])
def test_deployment_rejects_an_unsafe_browser_proxy_before_browser_start(
    tmp_path, monkeypatch, proxy,
):
    volume = tmp_path / "volume"
    profiles = volume / "profiles"
    profiles.mkdir(parents=True, mode=0o700)
    os.chmod(volume, 0o700)
    os.chmod(profiles, 0o700)
    monkeypatch.setenv("MEDIACRAWLER_ENCRYPTED_VOLUME", str(volume))
    monkeypatch.setenv("MEDIACRAWLER_PROFILE_ROOT", str(profiles))
    monkeypatch.setenv("MEDIACRAWLER_BROWSER_PROXY", proxy)
    browser_starts = 0

    def browser_factory(**_kwargs):
        nonlocal browser_starts
        browser_starts += 1
        return FakeBrowser()

    monkeypatch.setattr(
        "shensi_adapter.app.MediaCrawlerDouyinBrowserState", browser_factory
    )

    with pytest.raises(RuntimeError, match="MEDIACRAWLER_BROWSER_PROXY"):
        create_deployment_account_manager()

    assert browser_starts == 0


def test_deployment_rejects_headless_browser_when_real_outreach_is_enabled(
    tmp_path, monkeypatch,
):
    volume = tmp_path / "volume"
    profiles = volume / "profiles"
    profiles.mkdir(parents=True, mode=0o700)
    os.chmod(volume, 0o700)
    os.chmod(profiles, 0o700)
    monkeypatch.setenv("MEDIACRAWLER_ENCRYPTED_VOLUME", str(volume))
    monkeypatch.setenv("MEDIACRAWLER_PROFILE_ROOT", str(profiles))
    monkeypatch.setenv("DOUYIN_OUTREACH_ACTIONS_ENABLED", "true")
    monkeypatch.setenv("MEDIACRAWLER_BROWSER_HEADLESS", "true")
    monkeypatch.setenv("SHENSI_RUNTIME_MODE", "web")
    monkeypatch.setenv("MEDIACRAWLER_BROWSER_DISPLAY", "virtual")
    browser_starts = 0

    def browser_factory(**_kwargs):
        nonlocal browser_starts
        browser_starts += 1
        return FakeBrowser()

    monkeypatch.setattr(
        "shensi_adapter.app.MediaCrawlerDouyinBrowserState", browser_factory
    )

    with pytest.raises(
        RuntimeError,
        match=(
            "DOUYIN_OUTREACH_ACTIONS_ENABLED=true requires "
            "MEDIACRAWLER_BROWSER_HEADLESS=false"
        ),
    ):
        create_deployment_account_manager()

    assert browser_starts == 0


def test_virtual_display_mode_fails_closed_on_the_macos_host(
    tmp_path, monkeypatch,
):
    volume = tmp_path / "volume"
    profiles = volume / "profiles"
    profiles.mkdir(parents=True, mode=0o700)
    os.chmod(volume, 0o700)
    os.chmod(profiles, 0o700)
    monkeypatch.setenv("MEDIACRAWLER_ENCRYPTED_VOLUME", str(volume))
    monkeypatch.setenv("MEDIACRAWLER_PROFILE_ROOT", str(profiles))
    monkeypatch.setenv("MEDIACRAWLER_BROWSER_HEADLESS", "false")
    monkeypatch.setenv("MEDIACRAWLER_BROWSER_DISPLAY", "virtual")
    monkeypatch.setattr("shensi_adapter.app.sys.platform", "darwin")
    browser_starts = 0

    def browser_factory(**_kwargs):
        nonlocal browser_starts
        browser_starts += 1
        return FakeBrowser()

    monkeypatch.setattr(
        "shensi_adapter.app.MediaCrawlerDouyinBrowserState", browser_factory
    )

    with pytest.raises(
        RuntimeError,
        match="MEDIACRAWLER_BROWSER_DISPLAY=virtual requires Linux DISPLAY",
    ):
        create_deployment_account_manager()

    assert browser_starts == 0


def test_virtual_display_mode_requires_an_x_display_on_linux(monkeypatch):
    monkeypatch.setenv("MEDIACRAWLER_BROWSER_DISPLAY", "virtual")
    monkeypatch.delenv("DISPLAY", raising=False)
    monkeypatch.setattr("shensi_adapter.app.sys.platform", "linux")

    with pytest.raises(
        RuntimeError,
        match="MEDIACRAWLER_BROWSER_DISPLAY=virtual requires Linux DISPLAY",
    ):
        deployment_browser_display()


def test_virtual_display_mode_accepts_only_a_linux_x_display(monkeypatch):
    monkeypatch.setenv("MEDIACRAWLER_BROWSER_DISPLAY", "virtual")
    monkeypatch.setenv("DISPLAY", ":99")
    monkeypatch.setattr("shensi_adapter.app.sys.platform", "linux")

    assert deployment_browser_display() == "virtual"


def test_browser_display_mode_rejects_unknown_values(monkeypatch):
    monkeypatch.setenv("MEDIACRAWLER_BROWSER_DISPLAY", "host-window")

    with pytest.raises(
        RuntimeError,
        match="MEDIACRAWLER_BROWSER_DISPLAY must be operator or virtual",
    ):
        deployment_browser_display()


def test_unknown_poll_and_close_handles_return_stable_closed_errors(tmp_path):
    browser = MediaCrawlerDouyinBrowserState(
        playwright_factory=_working_playwright_factory,
        startup_timeout=2,
        command_timeout=2,
    )
    try:
        opened = browser.open_douyin_login(tmp_path)
        browser.close(opened)
        for operation in (browser.poll_douyin_login, browser.close):
            with pytest.raises(RuntimeError) as failure:
                operation(opened)
            assert str(failure.value) == "douyin_browser_context_closed"
            assert opened["handle"] not in str(failure.value)
    finally:
        browser.close_browser()


def test_hard_stop_retries_exit_before_closing_process_and_preserves_timeout_error():
    browser = object.__new__(MediaCrawlerDouyinBrowserState)
    browser._connection = _TimeoutConnection()
    browser._process = _SlowExitProcess()
    browser._timeout = 0.01
    browser._lock = threading.Lock()
    browser._closed = False
    browser._shutdown_failed = False
    browser._next_command_id = 1

    with pytest.raises(RuntimeError) as failure:
        browser._call("open", profile_path="unused")

    assert str(failure.value) == "douyin_browser_command_timeout"
    assert browser._connection.sent == [{
        "id": 1,
        "operation": "open",
        "profile_path": "unused",
    }]
    assert browser._process.alive is False
    assert browser._process.close_calls == 1


def test_faulted_worker_restarts_before_next_fresh_open_without_replaying_timeout(
    tmp_path,
):
    launch_count = tmp_path / "launch-count"
    browser = MediaCrawlerDouyinBrowserState(
        playwright_factory=_TimeoutOncePlaywrightFactory(launch_count),
        startup_timeout=2,
        command_timeout=0.05,
    )
    try:
        with pytest.raises(
            RuntimeError,
            match="^douyin_browser_command_timeout$",
        ):
            browser.open_douyin_login(tmp_path)

        assert launch_count.read_text(encoding="utf-8") == "1"
        browser._timeout = 2
        opened = browser.open_douyin_login(tmp_path)

        assert opened["login_page"] is None
        assert opened["qr_status"] == "opening"
        prepared = browser.prepare_douyin_login(opened)
        assert prepared["login_page"] == {
            "image_data_url": "data:image/jpeg;base64,bG9naW4tanBlZw==",
            "width": 1280,
            "height": 800,
        }
        assert launch_count.read_text(encoding="utf-8") == "2"
    finally:
        browser.close_browser()


@pytest.mark.parametrize(
    "operation",
    ["poll", "interact", "close", "reconcile"],
)
def test_faulted_worker_never_restarts_for_stale_or_reconciliation_commands(
    operation,
):
    browser = object.__new__(MediaCrawlerDouyinBrowserState)
    browser._closed = True
    browser._faulted = True
    browser._terminally_closed = False
    starts = []
    browser._start_worker = lambda: starts.append(operation)

    with pytest.raises(RuntimeError, match="^douyin_browser_unavailable$"):
        browser._prepare_fresh_command(operation)

    assert starts == []


def test_explicit_browser_close_remains_terminal_for_future_open(tmp_path):
    browser = MediaCrawlerDouyinBrowserState(
        playwright_factory=_working_playwright_factory,
        startup_timeout=2,
        command_timeout=2,
    )
    browser.close_browser()

    with pytest.raises(RuntimeError, match="^douyin_browser_closed$"):
        browser.open_douyin_login(tmp_path)


def test_shutdown_error_wins_when_worker_exit_is_delayed_after_response():
    browser = object.__new__(MediaCrawlerDouyinBrowserState)
    browser._connection = _ShutdownErrorConnection()
    browser._process = _SlowExitProcess()
    browser._owned_pgid = None
    browser._timeout = 0.01
    browser._lock = threading.Lock()
    browser._closed = False
    browser._shutdown_failed = False
    browser._next_command_id = 1

    with pytest.raises(
        RuntimeError,
        match="^douyin_browser_shutdown_failed$",
    ):
        browser.close_browser()

    assert browser._connection.sent == [{
        "id": 1,
        "operation": "shutdown",
    }]
    assert browser._process.alive is False
    assert browser._process.close_calls == 1
    assert browser._shutdown_failed is True


@pytest.mark.skipif(os.name != "posix", reason="POSIX process-group boundary")
def test_hard_stop_signals_verified_process_group_after_worker_already_died(monkeypatch):
    browser = object.__new__(MediaCrawlerDouyinBrowserState)
    browser._connection = _TimeoutConnection()
    browser._process = _DeadWorkerWithLiveDescendantProcess()
    browser._owned_pgid = browser._process.pid
    browser._timeout = 0.01
    browser._closed = False

    signalled = []
    monkeypatch.setattr(os, "killpg", lambda pgid, sig: signalled.append((pgid, sig)))

    browser._hard_stop()

    assert signalled == [(browser._process.pid, signal.SIGKILL)]
    assert browser._process.close_calls == 1


@pytest.mark.skipif(os.name != "posix", reason="POSIX process-group boundary")
def test_hard_stop_treats_is_alive_failure_as_unknown_before_closing(monkeypatch):
    browser = object.__new__(MediaCrawlerDouyinBrowserState)
    browser._connection = _TimeoutConnection()
    browser._process = _AliveCheckFailureProcess()
    browser._owned_pgid = browser._process.pid
    browser._timeout = 0.01
    browser._closed = False

    signalled = []
    monkeypatch.setattr(os, "killpg", lambda pgid, sig: signalled.append((pgid, sig)))

    browser._hard_stop()

    assert signalled == [(browser._process.pid, signal.SIGKILL)]
    assert browser._process.alive_checks >= 2
    assert browser._process.close_calls == 1


def test_timed_out_browser_command_hard_stops_owned_process(tmp_path):
    before = {child.pid for child in multiprocessing.active_children()}
    browser = MediaCrawlerDouyinBrowserState(
        playwright_factory=_blocking_playwright_factory,
        startup_timeout=2,
        command_timeout=0.05,
    )

    started = time.monotonic()
    with pytest.raises(RuntimeError, match="douyin_browser_command_timeout"):
        browser.open_douyin_login(tmp_path)

    assert time.monotonic() - started < 1
    assert {child.pid for child in multiprocessing.active_children()} == before
    browser.close_browser()


@pytest.mark.skipif(os.name != "posix", reason="POSIX process-group boundary")
def test_timed_out_browser_command_kills_playwright_descendants(tmp_path):
    browser = MediaCrawlerDouyinBrowserState(
        playwright_factory=_blocking_child_playwright_factory,
        startup_timeout=2,
        command_timeout=0.5,
    )

    with pytest.raises(RuntimeError, match="douyin_browser_command_timeout"):
        browser.open_douyin_login(tmp_path)

    child_pid = int((tmp_path / "browser-child.pid").read_text(encoding="utf-8"))
    deadline = time.monotonic() + 2
    while time.monotonic() < deadline:
        try:
            os.kill(child_pid, 0)
        except ProcessLookupError:
            break
        time.sleep(0.02)
    else:
        pytest.fail("timed-out Playwright descendant remained alive")


def test_browser_shutdown_failure_is_bounded_and_leak_free():
    before = {child.pid for child in multiprocessing.active_children()}
    browser = MediaCrawlerDouyinBrowserState(
        playwright_factory=_shutdown_failure_playwright_factory,
        startup_timeout=2,
        command_timeout=0.2,
    )

    with pytest.raises(RuntimeError, match="douyin_browser_shutdown_failed"):
        browser.close_browser()

    assert {child.pid for child in multiprocessing.active_children()} == before


def test_graceful_close_aggregates_failures_and_always_attempts_browser_shutdown(
    tmp_path, monkeypatch
):
    browser = FailingCloseBrowser(fail_shutdown=True)
    manager = AccountManager(tmp_path, browser)
    created = manager.create_login_session()
    _wait_for_login_bootstrap(manager, created.session_id)

    class _StuckSweeper:
        def join(self, timeout=None):
            assert timeout == 2

        def is_alive(self):
            return True

    manager._sweeper = _StuckSweeper()
    monkeypatch.setattr(
        manager,
        "_persist",
        lambda _session: (_ for _ in ()).throw(RuntimeError("metadata write failed")),
    )

    with pytest.raises(ExceptionGroup) as failure:
        manager.close()

    messages = [str(error) for error in failure.value.exceptions]
    assert messages == [
        "account_sweeper_shutdown_timeout",
        "context close failed",
        "metadata write failed",
        "browser shutdown failed",
    ]
    assert browser.close_browser_calls == 1


def test_deployment_profile_root_requires_an_owner_only_existing_encrypted_directory(tmp_path):
    missing = tmp_path / "missing"
    with pytest.raises(RuntimeError, match="must exist"):
        validate_encrypted_profile_root(missing, missing / "profiles")

    volume_file = tmp_path / "volume-file"
    volume_file.write_text("not a directory", encoding="utf-8")
    with pytest.raises(RuntimeError, match="directory"):
        validate_encrypted_profile_root(volume_file, volume_file / "profiles")

    volume = tmp_path / "encrypted"
    volume.mkdir(mode=0o755)
    os.chmod(volume, 0o755)
    with pytest.raises(RuntimeError, match="0700"):
        validate_encrypted_profile_root(volume, volume / "profiles")

    os.chmod(volume, 0o700)
    assert validate_encrypted_profile_root(volume, volume / "profiles") == (
        volume / "profiles"
    ).resolve()
    with pytest.raises(RuntimeError, match="inside"):
        validate_encrypted_profile_root(volume, tmp_path / "outside")


def test_deployment_secret_requires_an_owner_only_regular_file(tmp_path, monkeypatch):
    secret_file = tmp_path / "service-secret"
    secret_file.write_text("s" * 48, encoding="utf-8")
    monkeypatch.setenv("MEDIACRAWLER_SERVICE_SECRET_FILE", str(secret_file))

    os.chmod(secret_file, 0o644)
    with pytest.raises(RuntimeError, match="owner-only"):
        deployment_service_secret()

    os.chmod(secret_file, 0o600)
    assert deployment_service_secret() == "s" * 48


def test_real_asgi_routes_delete_profiles_but_graceful_close_preserves_active_restart_state(tmp_path):
    now = datetime(2026, 8, 24, tzinfo=UTC)
    secret = "mediacrawler-test-secret-that-is-at-least-32-bytes"
    manager = AccountManager(tmp_path, FakeBrowser(), now=lambda: now)
    app = create_app(secret, manager)
    headers = {"Authorization": f"Bearer {secret}"}

    with TestClient(app) as client:
        created = client.post("/internal/v1/douyin/login-sessions", headers=headers)
        assert created.status_code == 200
        session_id = created.json()["session_id"]
        active = client.get(
            f"/internal/v1/douyin/login-sessions/{session_id}", headers=headers
        )
        assert active.status_code == 200
        assert active.json()["state"] == "active"

    profiles = list((tmp_path / "profiles").iterdir())
    assert len(profiles) == 1
    restarted = AccountManager(tmp_path, FakeBrowser(), now=lambda: now)
    assert restarted.get_login_session(session_id).state == "active"

    second_app = create_app(secret, restarted)
    with TestClient(second_app) as client:
        deleted = client.delete(
            f"/internal/v1/douyin/login-sessions/{session_id}", headers=headers
        )
        assert deleted.status_code == 204
        missing_response = client.get(
            f"/internal/v1/douyin/login-sessions/{session_id}", headers=headers
        )
        assert missing_response.status_code == 404
    assert not profiles[0].exists()
