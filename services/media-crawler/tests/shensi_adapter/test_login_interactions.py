from __future__ import annotations

import base64
import logging
import time
from datetime import UTC, datetime, timedelta
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient
from pydantic import TypeAdapter, ValidationError

import shensi_adapter.browser_state as browser_state_module
import shensi_adapter.schemas as schemas_module
from shensi_adapter.accounts import AccountManager
from shensi_adapter.app import create_app
from shensi_adapter.browser_state import (
    DouyinLoginOpenFailure,
    _browser_worker,
    _open_context,
)
from shensi_adapter.douyin_account_identity import (
    identity_fingerprint_for_raw_sec_uid,
)


SERVICE_SECRET = "mediacrawler-test-secret-that-is-at-least-32-bytes"
NOW = datetime(2026, 8, 31, tzinfo=UTC)
FRAME_ONE = {
    "image_data_url": "data:image/jpeg;base64,Zmlyc3Q=",
    "width": 1280,
    "height": 800,
}
FRAME_TWO = {
    "image_data_url": "data:image/jpeg;base64,c2Vjb25k",
    "width": 1280,
    "height": 800,
}
FRAME_THREE = {
    "image_data_url": "data:image/jpeg;base64,dGhpcmQ=",
    "width": 1280,
    "height": 800,
}


class _EmptyLocator:
    def count(self):
        return 0


class _VisiblePanel:
    def wait_for(self, **_kwargs):
        return None


class _VisibleQr:
    def count(self):
        return 1

    def nth(self, _index):
        return self

    def is_visible(self, **_kwargs):
        return True

    def get_attribute(self, name, **_kwargs):
        assert name == "src"
        return "data:image/png;base64,cXI="


class _RecordingMouse:
    def __init__(self):
        self.clicks = []
        self.wheels = []

    def click(self, x, y):
        self.clicks.append((x, y))

    def wheel(self, x, y):
        self.wheels.append((x, y))


class _RecordingKeyboard:
    def __init__(self):
        self.text = []
        self.keys = []

    def insert_text(self, value):
        self.text.append(value)

    def press(self, value):
        self.keys.append(value)


class _LoginPage:
    def __init__(self, url="https://www.douyin.com/"):
        self.url = url
        self.goto_calls = []
        self.screenshot_calls = []
        self.screenshot_bytes = b"first-jpeg"
        self.mouse = _RecordingMouse()
        self.keyboard = _RecordingKeyboard()

    def goto(self, url, **kwargs):
        self.url = url
        self.goto_calls.append((url, kwargs))

    def title(self):
        return "抖音-记录美好生活"

    def locator(self, selector):
        if selector == "#login-panel-new":
            return _VisiblePanel()
        if selector == "#login-panel-new svg image":
            return _VisibleQr()
        return _EmptyLocator()

    def screenshot(self, **kwargs):
        self.screenshot_calls.append(kwargs)
        return self.screenshot_bytes

    def evaluate(self, expression, *_args):
        if "HasUserLogin" in expression:
            return "0"
        raise AssertionError(expression)

    def wait_for_timeout(self, _milliseconds):
        return None


class _LoginContext:
    def __init__(self, page):
        self.pages = [page]
        self.closed = False
        self.cdp_calls = []

    def new_cdp_session(self, page):
        context = self

        class Session:
            def send(self, method, payload):
                context.cdp_calls.append((method, payload))
                return {
                    "data": base64.b64encode(
                        page.screenshot_bytes
                    ).decode("ascii")
                }

            def detach(self):
                return None

        return Session()

    def close(self):
        self.closed = True


class _LoginChromium:
    def __init__(self, page):
        self.page = page
        self.launch_options = None
        self.context = None

    def launch_persistent_context(self, _profile_path, **kwargs):
        self.launch_options = kwargs
        self.context = _LoginContext(self.page)
        return self.context


def test_open_redacts_browser_launch_failure_at_its_exact_stage(tmp_path):
    sensitive_detail = (
        "api_key=sk-launch-must-not-leak "
        "url=https://www.douyin.com/login/?ticket=must-not-leak "
        f"profile={tmp_path.resolve()}"
    )

    class FailingChromium:
        def launch_persistent_context(self, _profile_path, **_kwargs):
            raise OSError(sensitive_detail)

    with pytest.raises(DouyinLoginOpenFailure) as failure:
        _open_context(
            SimpleNamespace(chromium=FailingChromium()),
            str(tmp_path),
            headless=False,
            browser_channel="chrome",
        )

    assert failure.value.stage == "browser_launch"
    assert failure.value.error_code == "douyin_login_open_failed"
    assert str(failure.value) == "douyin_login_open_failed"
    assert sensitive_detail not in str(failure.value)


def test_open_redacts_initial_page_failure_at_its_exact_stage(tmp_path):
    sensitive_detail = "cookie=session-must-not-leak profile=/private/profile"

    class FailingContext:
        closed = False

        @property
        def pages(self):
            raise RuntimeError(sensitive_detail)

        def close(self):
            self.closed = True

    context = FailingContext()

    class Chromium:
        def launch_persistent_context(self, _profile_path, **_kwargs):
            return context

    with pytest.raises(DouyinLoginOpenFailure) as failure:
        _open_context(
            SimpleNamespace(chromium=Chromium()),
            str(tmp_path),
            headless=False,
            browser_channel="chrome",
        )

    assert failure.value.stage == "browser_page_open"
    assert failure.value.error_code == "douyin_login_open_failed"
    assert str(failure.value) == "douyin_login_open_failed"
    assert sensitive_detail not in str(failure.value)
    assert context.closed is True


def test_open_cleanup_failure_does_not_replace_the_primary_safe_stage(tmp_path):
    primary_detail = "cookie=primary-must-not-leak"
    cleanup_detail = "profile=/private/cleanup-must-not-leak"

    class FailingContext:
        @property
        def pages(self):
            raise RuntimeError(primary_detail)

        def close(self):
            raise OSError(cleanup_detail)

    class Chromium:
        def launch_persistent_context(self, _profile_path, **_kwargs):
            return FailingContext()

    with pytest.raises(DouyinLoginOpenFailure) as failure:
        _open_context(
            SimpleNamespace(chromium=Chromium()),
            str(tmp_path),
            headless=False,
            browser_channel="chrome",
        )

    assert failure.value.stage == "browser_page_open"
    assert failure.value.error_code == "douyin_login_open_failed"
    assert str(failure.value) == "douyin_login_open_failed"
    assert primary_detail not in str(failure.value)
    assert cleanup_detail not in str(failure.value)


def test_open_exposes_ready_only_after_activating_and_capturing_qr(
    tmp_path,
    monkeypatch,
):
    page = _LoginPage()
    chromium = _LoginChromium(page)
    events = []
    monkeypatch.setattr(
        browser_state_module,
        "_wait_for_login_panel",
        lambda received_page: events.append(("panel", received_page)) or True,
    )
    monkeypatch.setattr(
        browser_state_module,
        "_activate_qr_login",
        lambda received_page: events.append(("activate", received_page)),
    )
    monkeypatch.setattr(
        browser_state_module,
        "_wait_for_qr_image",
        lambda received_page: (
            events.append(("qr", received_page))
            or "data:image/png;base64,cXI="
        ),
    )
    monkeypatch.setattr(
        browser_state_module,
        "_click_login_button",
        lambda _page: (_ for _ in ()).throw(
            AssertionError("an already-visible panel must not be reopened")
        ),
    )

    context, opened = _open_context(
        SimpleNamespace(chromium=chromium),
        str(tmp_path),
        headless=False,
        browser_channel="chrome",
    )

    try:
        assert opened == {
            "login_page": {
                "image_data_url": (
                    "data:image/jpeg;base64,"
                    + base64.b64encode(b"first-jpeg").decode("ascii")
                ),
                "width": 1280,
                "height": 800,
            },
            "qr_status": "ready",
            "qr_image_data_url": "data:image/png;base64,cXI=",
        }
        assert events == [
            ("panel", page),
            ("activate", page),
            ("qr", page),
        ]
        assert chromium.launch_options == {
            "headless": False,
            "channel": "chrome",
            "ignore_default_args": ["--disable-dev-shm-usage"],
            "args": ["--no-proxy-server"],
            "viewport": {"width": 1280, "height": 800},
        }
        assert page.screenshot_calls == [{
            "type": "jpeg",
            "quality": 80,
            "full_page": False,
            "timeout": 5_000,
        }]
        assert chromium.context.cdp_calls == []
    finally:
        context.close()


def test_deferred_open_publishes_interactive_context_before_auxiliary_work(
    tmp_path,
    monkeypatch,
):
    page = _LoginPage()
    chromium = _LoginChromium(page)
    auxiliary_calls = []
    monkeypatch.setattr(
        browser_state_module,
        "_wait_for_login_panel",
        lambda _page: auxiliary_calls.append("panel") or True,
    )
    monkeypatch.setattr(
        browser_state_module,
        "_capture_login_page_best_effort",
        lambda _context: auxiliary_calls.append("capture") or FRAME_ONE,
    )

    context, opened = _open_context(
        SimpleNamespace(chromium=chromium),
        str(tmp_path),
        headless=False,
        browser_channel="chrome",
        defer_auxiliary=True,
    )

    try:
        assert opened == {
            "login_page": None,
            "qr_status": "opening",
            "qr_image_data_url": None,
        }
        assert auxiliary_calls == []
        assert context.closed is False
    finally:
        context.close()


def test_open_keeps_the_official_login_context_when_qr_is_unavailable(
    tmp_path,
    monkeypatch,
):
    page = _LoginPage()
    chromium = _LoginChromium(page)
    monkeypatch.setattr(
        browser_state_module,
        "_wait_for_login_panel",
        lambda _page: True,
    )
    monkeypatch.setattr(
        browser_state_module,
        "_activate_qr_login",
        lambda _page: None,
    )
    monkeypatch.setattr(
        browser_state_module,
        "_wait_for_qr_image",
        lambda _page: (_ for _ in ()).throw(
            RuntimeError("douyin_qr_image_unavailable")
        ),
    )

    context, opened = _open_context(
        SimpleNamespace(chromium=chromium),
        str(tmp_path),
        headless=False,
        browser_channel="chrome",
    )

    try:
        assert context.closed is False
        assert opened["qr_status"] == "opening"
        assert opened["qr_image_data_url"] is None
        assert opened["login_page"]["width"] == 1280
    finally:
        context.close()


def test_open_recovers_an_initial_expired_qr_with_the_semantic_refresh(
    tmp_path,
    monkeypatch,
    caplog,
):
    page = _LoginPage()
    chromium = _LoginChromium(page)
    events = []
    monkeypatch.setattr(
        browser_state_module,
        "_non_ready_qr_status",
        lambda received_page: events.append(("status", received_page))
        or "expired",
    )
    monkeypatch.setattr(
        browser_state_module,
        "_click_expired_qr_refresh",
        lambda received_page: events.append(("click_refresh", received_page))
        or True,
    )
    monkeypatch.setattr(
        browser_state_module,
        "_wait_for_refreshed_qr",
        lambda received_page: (
            events.append(("wait_new_qr", received_page))
            or ("ready", "data:image/png;base64,bmV3LXFy")
        ),
    )

    package_logger = logging.getLogger("shensi_adapter")
    package_logger.addHandler(caplog.handler)
    try:
        with caplog.at_level(
            logging.INFO,
            logger="shensi_adapter.browser_state",
        ):
            context, opened = _open_context(
                SimpleNamespace(chromium=chromium),
                str(tmp_path),
                headless=False,
                browser_channel="chrome",
            )
    finally:
        package_logger.removeHandler(caplog.handler)

    try:
        assert events == [
            ("status", page),
            ("click_refresh", page),
            ("wait_new_qr", page),
        ]
        assert opened["qr_status"] == "ready"
        assert opened["qr_image_data_url"] == (
            "data:image/png;base64,bmV3LXFy"
        )
        assert [
            message
            for message in caplog.messages
            if message.startswith("douyin_login_qr_refresh ")
        ] == [
            "douyin_login_qr_refresh entry=open outcome=clicked"
        ]
    finally:
        context.close()


def test_open_refreshes_when_qr_expires_during_the_initial_wait(
    tmp_path,
    monkeypatch,
    caplog,
):
    page = _LoginPage()
    chromium = _LoginChromium(page)
    events = []
    statuses = iter((None, "expired"))
    monkeypatch.setattr(
        browser_state_module,
        "_non_ready_qr_status",
        lambda received_page: (
            events.append(("status", received_page)) or next(statuses)
        ),
    )
    monkeypatch.setattr(
        browser_state_module,
        "_wait_for_login_panel",
        lambda received_page: events.append(("panel", received_page)) or True,
    )
    monkeypatch.setattr(
        browser_state_module,
        "_activate_qr_login",
        lambda received_page: events.append(("activate", received_page)),
    )
    monkeypatch.setattr(
        browser_state_module,
        "_wait_for_qr_image",
        lambda received_page: (
            events.append(("wait_initial_qr", received_page))
            or (_ for _ in ()).throw(
                RuntimeError("douyin_qr_image_unavailable")
            )
        ),
    )
    monkeypatch.setattr(
        browser_state_module,
        "_click_expired_qr_refresh",
        lambda received_page: (
            events.append(("click_refresh", received_page)) or True
        ),
    )
    monkeypatch.setattr(
        browser_state_module,
        "_wait_for_refreshed_qr",
        lambda received_page: (
            events.append(("wait_refreshed_qr", received_page))
            or ("ready", "data:image/png;base64,bmV3LXFy")
        ),
    )

    package_logger = logging.getLogger("shensi_adapter")
    package_logger.addHandler(caplog.handler)
    try:
        with caplog.at_level(
            logging.INFO,
            logger="shensi_adapter.browser_state",
        ):
            context, opened = _open_context(
                SimpleNamespace(chromium=chromium),
                str(tmp_path),
                headless=False,
                browser_channel="chrome",
            )
    finally:
        package_logger.removeHandler(caplog.handler)

    try:
        assert events == [
            ("status", page),
            ("panel", page),
            ("activate", page),
            ("wait_initial_qr", page),
            ("status", page),
            ("click_refresh", page),
            ("wait_refreshed_qr", page),
        ]
        assert opened["qr_status"] == "ready"
        assert opened["qr_image_data_url"] == (
            "data:image/png;base64,bmV3LXFy"
        )
        assert [
            message
            for message in caplog.messages
            if message.startswith("douyin_login_qr_refresh ")
        ] == [
            "douyin_login_qr_refresh entry=open outcome=clicked"
        ]
    finally:
        context.close()


def test_open_keeps_official_page_context_when_login_ui_is_unrecognized(
    tmp_path,
):
    class OfficialPageWithoutLoginPanel(_LoginPage):
        def locator(self, _selector):
            return _EmptyLocator()

        def get_by_text(self, *_args, **_kwargs):
            raise RuntimeError("login control absent")

    page = OfficialPageWithoutLoginPanel()
    chromium = _LoginChromium(page)

    opened_context, opened = _open_context(
        SimpleNamespace(chromium=chromium),
        str(tmp_path),
        headless=False,
        browser_channel="chrome",
    )

    assert opened_context is chromium.context
    assert opened["qr_status"] == "opening"
    assert opened["qr_image_data_url"] is None
    assert opened["login_page"] == {
        "image_data_url": "data:image/jpeg;base64,Zmlyc3QtanBlZw==",
        "width": 1280,
        "height": 800,
    }
    assert chromium.context.closed is False
    opened_context.close()


def test_open_captures_a_bounded_playwright_viewport_jpeg(
    tmp_path,
):
    events = []

    class BoundedCapturePage(_LoginPage):
        def screenshot(self, **kwargs):
            events.append(("capture", kwargs))
            return b"rendered-jpeg"

        def wait_for_timeout(self, milliseconds):
            events.append(("settle", milliseconds))

    page = BoundedCapturePage()
    context = _LoginContext(page)

    class Chromium:
        def launch_persistent_context(self, _profile_path, **_kwargs):
            return context

    opened_context, opened = _open_context(
        SimpleNamespace(chromium=Chromium()),
        str(tmp_path),
        headless=False,
        browser_channel="chrome",
    )

    try:
        assert opened["login_page"]["image_data_url"] == (
            "data:image/jpeg;base64,cmVuZGVyZWQtanBlZw=="
        )
        assert events == [
            ("settle", 1_000),
            (
                "capture",
                {
                    "type": "jpeg",
                    "quality": 80,
                    "full_page": False,
                    "timeout": 5_000,
                },
            ),
        ]
        assert context.cdp_calls == []
    finally:
        opened_context.close()


def test_open_keeps_context_when_initial_login_page_screenshot_times_out(
    tmp_path,
):
    sensitive_detail = "cookie=capture-must-not-leak path=/private/profile"

    class FailingCapturePage(_LoginPage):
        def screenshot(self, **kwargs):
            assert kwargs["timeout"] == 5_000
            raise TimeoutError(sensitive_detail)

    context = _LoginContext(FailingCapturePage())

    class Chromium:
        def launch_persistent_context(self, _profile_path, **_kwargs):
            return context

    opened_context, opened = _open_context(
        SimpleNamespace(chromium=Chromium()),
        str(tmp_path),
        headless=False,
        browser_channel="chrome",
    )

    assert opened_context is context
    assert opened == {
        "login_page": None,
        "qr_status": "ready",
        "qr_image_data_url": "data:image/png;base64,cXI=",
    }
    assert sensitive_detail not in str(opened)
    assert context.closed is False
    opened_context.close()


def test_poll_preserves_qr_state_when_login_page_screenshot_times_out():
    class SlowScreenshotPage(_LoginPage):
        def screenshot(self, **kwargs):
            assert kwargs == {
                "type": "jpeg",
                "quality": 80,
                "full_page": False,
                "timeout": 5_000,
            }
            raise TimeoutError("bounded screenshot timeout")

    context = _LoginContext(SlowScreenshotPage())

    result = browser_state_module._poll_login_context(context)

    assert result == {
        "active": False,
        "qr_status": "ready",
        "qr_image_data_url": "data:image/png;base64,cXI=",
        "login_page": None,
    }
    assert context.closed is False


def test_refresh_preserves_qr_state_when_login_page_screenshot_times_out(
    monkeypatch,
):
    class SlowRefreshScreenshotPage(_LoginPage):
        def reload(self, **_kwargs):
            return None

        def screenshot(self, **kwargs):
            assert kwargs == {
                "type": "jpeg",
                "quality": 80,
                "full_page": False,
                "timeout": 5_000,
            }
            raise TimeoutError("bounded screenshot timeout")

    page = SlowRefreshScreenshotPage()
    context = _LoginContext(page)
    monkeypatch.setattr(
        browser_state_module,
        "_wait_for_login_panel",
        lambda _page: True,
    )
    monkeypatch.setattr(
        browser_state_module,
        "_activate_qr_login",
        lambda _page: None,
    )
    monkeypatch.setattr(
        browser_state_module,
        "_wait_for_qr_image",
        lambda _page: "data:image/png;base64,bmV3LXFy",
    )

    result = browser_state_module._interact_login_context(
        context,
        {"type": "refresh_qr"},
    )

    assert result == {
        "active": False,
        "qr_status": "ready",
        "qr_image_data_url": "data:image/png;base64,bmV3LXFy",
        "login_page": None,
    }
    assert context.closed is False


def test_login_page_capture_rechecks_allowed_page_after_screenshot():
    class NavigatingScreenshotPage(_LoginPage):
        def screenshot(self, **kwargs):
            assert kwargs["timeout"] == 5_000
            self.url = "https://evil.example/after-capture"
            return b"captured-before-navigation"

    with pytest.raises(
        RuntimeError,
        match="^douyin_login_page_not_allowed$",
    ):
        browser_state_module._capture_login_page(
            _LoginContext(NavigatingScreenshotPage())
        )


def test_best_effort_login_page_capture_only_swallows_exact_unavailable(
    monkeypatch,
):
    monkeypatch.setattr(
        browser_state_module,
        "_capture_login_page",
        lambda _context: (_ for _ in ()).throw(
            RuntimeError("douyin_login_page_not_allowed")
        ),
    )

    with pytest.raises(
        RuntimeError,
        match="^douyin_login_page_not_allowed$",
    ):
        browser_state_module._capture_login_page_best_effort(object())


def test_open_passes_the_configured_outbound_proxy_to_chromium(tmp_path):
    page = _LoginPage()
    chromium = _LoginChromium(page)

    context, _opened = _open_context(
        SimpleNamespace(chromium=chromium),
        str(tmp_path),
        headless=False,
        browser_channel=None,
        browser_proxy="http://192.168.5.2:7897",
    )

    try:
        assert chromium.launch_options["proxy"] == {
            "server": "http://192.168.5.2:7897",
        }
    finally:
        context.close()


def test_launch_options_force_direct_chromium_without_explicit_proxy():
    options = browser_state_module._launch_options(
        headless=False,
        browser_channel=None,
        browser_proxy=None,
    )

    assert options["args"] == ["--no-proxy-server"]
    assert options["ignore_default_args"] == ["--disable-dev-shm-usage"]
    assert "proxy" not in options


def test_macos_external_login_enables_the_chromium_sandbox(
    tmp_path,
    monkeypatch,
):
    monkeypatch.setattr(browser_state_module.sys, "platform", "darwin")
    chromium = _LoginChromium(_LoginPage())

    context, _opened = _open_context(
        SimpleNamespace(chromium=chromium),
        str(tmp_path),
        headless=False,
        browser_channel="chrome",
        interaction_surface="external_window",
        defer_auxiliary=True,
    )

    try:
        assert chromium.launch_options["chromium_sandbox"] is True
        assert chromium.launch_options["ignore_default_args"] == [
            "--disable-dev-shm-usage",
        ]
    finally:
        context.close()


@pytest.mark.parametrize(
    ("platform", "interaction_surface"),
    [
        ("darwin", "remote_canvas"),
        ("linux", "external_window"),
    ],
)
def test_web_or_non_macos_launch_keeps_playwright_sandbox_default(
    monkeypatch,
    platform,
    interaction_surface,
):
    monkeypatch.setattr(browser_state_module.sys, "platform", platform)

    options = browser_state_module._launch_options(
        headless=False,
        browser_channel="chrome",
        browser_proxy=None,
        interaction_surface=interaction_surface,
    )

    assert options["ignore_default_args"] == ["--disable-dev-shm-usage"]
    assert "chromium_sandbox" not in options


def test_launch_options_use_only_explicit_playwright_proxy():
    options = browser_state_module._launch_options(
        headless=False,
        browser_channel=None,
        browser_proxy="http://192.168.5.2:7897",
    )

    assert options["proxy"] == {"server": "http://192.168.5.2:7897"}
    assert options["ignore_default_args"] == ["--disable-dev-shm-usage"]
    assert "args" not in options


def test_open_rejects_a_redirect_before_touching_the_foreign_page(tmp_path):
    class RedirectedPage(_LoginPage):
        def __init__(self):
            super().__init__()
            self.locator_calls = []

        def goto(self, url, **kwargs):
            self.goto_calls.append((url, kwargs))
            self.url = "https://evil.example/fake-login"

        def locator(self, selector):
            self.locator_calls.append(selector)
            return _EmptyLocator()

    page = RedirectedPage()
    chromium = _LoginChromium(page)

    with pytest.raises(
        RuntimeError,
        match="^douyin_login_page_not_allowed$",
    ):
        _open_context(
            SimpleNamespace(chromium=chromium),
            str(tmp_path),
            headless=False,
            browser_channel="chrome",
        )

    assert page.locator_calls == []


def test_open_reports_navigation_timeout_as_login_page_unavailable(tmp_path):
    sensitive_detail = "ticket=navigation-must-not-leak profile=/private/profile"

    class TimedOutPage(_LoginPage):
        def __init__(self):
            super().__init__(url="about:blank")
            self.closed = False

        def goto(self, url, **kwargs):
            self.goto_calls.append((url, kwargs))
            raise TimeoutError(sensitive_detail)

        def close(self):
            self.closed = True

    pages = [TimedOutPage(), TimedOutPage(), TimedOutPage()]

    class TimedOutContext(_LoginContext):
        def __init__(self):
            super().__init__(pages[0])
            self.new_page_calls = 0

        def new_page(self):
            self.new_page_calls += 1
            page = pages[self.new_page_calls]
            self.pages.append(page)
            return page

    context = TimedOutContext()

    class TimedOutChromium:
        def launch_persistent_context(self, _profile_path, **_kwargs):
            return context

    with pytest.raises(
        DouyinLoginOpenFailure,
        match="^douyin_login_page_unavailable$",
    ) as failure:
        _open_context(
            SimpleNamespace(chromium=TimedOutChromium()),
            str(tmp_path),
            headless=False,
            browser_channel="chrome",
        )

    assert [len(page.goto_calls) for page in pages] == [1, 1, 1]
    assert [page.closed for page in pages] == [True, True, False]
    assert failure.value.stage == "douyin_navigation"
    assert failure.value.error_code == "douyin_login_page_unavailable"
    assert str(failure.value) == "douyin_login_page_unavailable"
    assert sensitive_detail not in str(failure.value)
    assert context.closed is True


def test_open_recovers_when_the_third_fresh_page_can_navigate(tmp_path):
    class TimedOutPage(_LoginPage):
        def __init__(self):
            super().__init__(url="about:blank")
            self.closed = False

        def goto(self, url, **kwargs):
            self.goto_calls.append((url, kwargs))
            raise TimeoutError("navigation failed before commit")

        def close(self):
            self.closed = True

        def is_closed(self):
            return self.closed

    failed_pages = [TimedOutPage(), TimedOutPage()]
    recovered_page = _LoginPage()
    pages = [*failed_pages, recovered_page]

    class RetryingContext(_LoginContext):
        def __init__(self):
            super().__init__(pages[0])
            self.new_page_calls = 0
            self.captured_pages = []

        def new_page(self):
            self.new_page_calls += 1
            page = pages[self.new_page_calls]
            self.pages.append(page)
            return page

        def new_cdp_session(self, page):
            self.captured_pages.append(page)
            return super().new_cdp_session(page)

    context = RetryingContext()

    class RetryingChromium:
        def launch_persistent_context(self, _profile_path, **_kwargs):
            return context

    opened_context, opened = _open_context(
        SimpleNamespace(chromium=RetryingChromium()),
        str(tmp_path),
        headless=False,
        browser_channel="chrome",
    )

    try:
        assert opened["login_page"]["width"] == 1280
        assert opened["login_page"]["height"] == 800
        assert [page.closed for page in failed_pages] == [True, True]
        assert context.new_page_calls == 2
        assert [len(page.goto_calls) for page in pages] == [1, 1, 1]
        assert [page.screenshot_calls for page in failed_pages] == [[], []]
        assert recovered_page.screenshot_calls == [{
            "type": "jpeg",
            "quality": 80,
            "full_page": False,
            "timeout": 5_000,
        }]
        assert context.captured_pages == []
    finally:
        opened_context.close()


def test_open_retries_navigation_in_a_fresh_page(tmp_path):
    class TimedOutPage(_LoginPage):
        def __init__(self):
            super().__init__(url="about:blank")
            self.closed = False

        def goto(self, url, **kwargs):
            self.goto_calls.append((url, kwargs))
            raise TimeoutError("navigation failed before commit")

        def close(self):
            self.closed = True

        def is_closed(self):
            return self.closed

    failed_page = TimedOutPage()
    recovered_page = _LoginPage()

    class RetryingContext(_LoginContext):
        def __init__(self):
            super().__init__(failed_page)
            self.new_page_calls = 0

        def new_page(self):
            self.new_page_calls += 1
            self.pages.append(recovered_page)
            return recovered_page

    context = RetryingContext()

    class RetryingChromium:
        def launch_persistent_context(self, _profile_path, **_kwargs):
            return context

    opened_context, opened = _open_context(
        SimpleNamespace(chromium=RetryingChromium()),
        str(tmp_path),
        headless=False,
        browser_channel="chrome",
    )

    try:
        assert opened["login_page"]["width"] == 1280
        assert failed_page.closed is True
        assert context.new_page_calls == 1
        assert len(recovered_page.goto_calls) == 1
    finally:
        opened_context.close()


def test_login_interactions_use_normalized_viewport_and_return_fresh_frame():
    page = _LoginPage()
    context = _LoginContext(page)
    interact = getattr(browser_state_module, "_interact_login_context")

    page.screenshot_bytes = b"click"
    clicked = interact(context, {
        "type": "click",
        "normalized_x": 0.5,
        "normalized_y": 0.25,
    })
    page.screenshot_bytes = b"text"
    typed = interact(context, {"type": "text", "text": "13800138000"})
    page.screenshot_bytes = b"key"
    keyed = interact(context, {"type": "key", "key": "Enter"})
    page.screenshot_bytes = b"scroll"
    scrolled = interact(context, {
        "type": "scroll",
        "delta_x": -0.5,
        "delta_y": 1,
    })

    assert page.mouse.clicks == [(640, 200)]
    assert page.keyboard.text == ["13800138000"]
    assert page.keyboard.keys == ["Enter"]
    assert page.mouse.wheels == [(-640, 800)]
    for result, encoded in (
        (clicked, "Y2xpY2s="),
        (typed, "dGV4dA=="),
        (keyed, "a2V5"),
        (scrolled, "c2Nyb2xs"),
    ):
        assert result == {
            "active": False,
            "login_page": {
                "image_data_url": f"data:image/jpeg;base64,{encoded}",
                "width": 1280,
                "height": 800,
            },
            "qr_status": "ready",
            "qr_image_data_url": "data:image/png;base64,cXI=",
        }


def test_refresh_qr_is_a_single_semantic_reload_and_qr_probe(monkeypatch):
    events = []

    class RefreshPage(_LoginPage):
        def reload(self, **kwargs):
            events.append(("reload", kwargs))

    page = RefreshPage()
    context = _LoginContext(page)
    monkeypatch.setattr(
        browser_state_module,
        "_wait_for_login_panel",
        lambda received_page: events.append(("panel", received_page)) or True,
    )
    monkeypatch.setattr(
        browser_state_module,
        "_activate_qr_login",
        lambda received_page: events.append(("activate", received_page)),
    )
    monkeypatch.setattr(
        browser_state_module,
        "_wait_for_qr_image",
        lambda received_page: (
            events.append(("qr", received_page))
            or "data:image/png;base64,bmV3LXFy"
        ),
    )

    result = browser_state_module._interact_login_context(
        context,
        {"type": "refresh_qr"},
    )

    assert events == [
        ("reload", {"wait_until": "domcontentloaded", "timeout": 10_000}),
        ("panel", page),
        ("activate", page),
        ("qr", page),
    ]
    assert result["active"] is False
    assert result["qr_status"] == "ready"
    assert result["qr_image_data_url"] == "data:image/png;base64,bmV3LXFy"


def test_refresh_qr_keeps_session_when_official_login_ui_does_not_recover(
    monkeypatch,
):
    class RefreshPage(_LoginPage):
        def reload(self, **_kwargs):
            return None

    page = RefreshPage()
    monkeypatch.setattr(
        browser_state_module,
        "_wait_for_login_panel",
        lambda _page: False,
    )
    monkeypatch.setattr(
        browser_state_module,
        "_click_login_button",
        lambda _page: (_ for _ in ()).throw(
            RuntimeError("douyin_login_ui_unsupported")
        ),
    )

    result = browser_state_module._interact_login_context(
        _LoginContext(page),
        {"type": "refresh_qr"},
    )

    assert result["active"] is False
    assert result["qr_status"] == "opening"
    assert result["qr_image_data_url"] is None
    assert result["login_page"] is not None


def test_refresh_qr_clicks_visible_expired_control_and_waits_for_new_qr():
    events = []

    class RefreshControl:
        def __init__(self, page):
            self.page = page

        def count(self):
            return 1

        def nth(self, _index):
            return self

        def is_visible(self):
            return True

        def click(self, **kwargs):
            events.append(("click_refresh", kwargs))
            self.page.expired = False

    class Body:
        def __init__(self, page):
            self.page = page

        def inner_text(self, **_kwargs):
            return "二维码失效\n点击刷新" if self.page.expired else ""

    class ExpiredRefreshPage(_LoginPage):
        def __init__(self):
            super().__init__()
            self.expired = True
            self.refresh_ticks = 0

        def reload(self, **kwargs):
            events.append(("reload", kwargs))

        def get_by_text(self, text, *, exact):
            events.append(("find_refresh", text, exact))
            assert text == "点击刷新"
            assert exact is True
            return RefreshControl(self)

        def locator(self, selector):
            if selector == "body":
                return Body(self)
            if (selector == "#login-panel-new svg image"
                    and (self.expired or self.refresh_ticks < 2)):
                return _EmptyLocator()
            return super().locator(selector)

        def wait_for_timeout(self, milliseconds):
            events.append(("wait", milliseconds))
            self.refresh_ticks += 1

    page = ExpiredRefreshPage()
    result = browser_state_module._interact_login_context(
        _LoginContext(page),
        {"type": "refresh_qr"},
    )

    assert events[:2] == [
        ("find_refresh", "点击刷新", True),
        ("click_refresh", {"timeout": 5_000}),
    ]
    assert [event for event in events if event[0] == "reload"] == []
    assert [event for event in events if event[0] == "click_refresh"] == [
        ("click_refresh", {"timeout": 5_000})
    ]
    assert result["active"] is False
    assert result["qr_status"] == "ready"
    assert result["qr_image_data_url"] == "data:image/png;base64,cXI="


def test_expired_qr_refresh_does_not_click_after_a_locator_error():
    clicks = []

    class Body:
        def __init__(self, page):
            self.page = page

        def inner_text(self, **_kwargs):
            return "二维码失效\n点击刷新" if self.page.expired else ""

    class RefreshControl:
        def __init__(self, page):
            self.page = page

        def is_visible(self):
            return True

        def click(self, **_kwargs):
            clicks.append(True)
            self.page.expired = False

    class PartiallyBrokenRefreshControls:
        def __init__(self, page):
            self.control = RefreshControl(page)

        def count(self):
            return 2

        def nth(self, index):
            if index == 1:
                raise RuntimeError("locator detached")
            return self.control

    class PartiallyBrokenRefreshPage(_LoginPage):
        def __init__(self):
            super().__init__()
            self.expired = True

        def reload(self, **_kwargs):
            return None

        def get_by_text(self, text, *, exact):
            assert (text, exact) == ("点击刷新", True)
            return PartiallyBrokenRefreshControls(self)

        def locator(self, selector):
            if selector == "body":
                return Body(self)
            if selector == "#login-panel-new svg image" and self.expired:
                return _EmptyLocator()
            return super().locator(selector)

    result = browser_state_module._interact_login_context(
        _LoginContext(PartiallyBrokenRefreshPage()),
        {"type": "refresh_qr"},
    )

    assert result["qr_status"] == "expired"
    assert result["qr_image_data_url"] is None
    assert clicks == []


def test_expired_qr_refresh_logs_click_failure_without_details(caplog):
    sensitive_error = (
        "click failed url=https://www.douyin.com/?session=must-not-leak "
        "cookie=must-not-leak"
    )

    class Body:
        def inner_text(self, **_kwargs):
            return f"二维码失效\n点击刷新\n{sensitive_error}"

    class FailingRefreshControl:
        def count(self):
            return 1

        def nth(self, _index):
            return self

        def is_visible(self):
            return True

        def click(self, **_kwargs):
            raise RuntimeError(sensitive_error)

    class FailingRefreshPage(_LoginPage):
        def reload(self, **_kwargs):
            return None

        def get_by_text(self, *_args, **_kwargs):
            return FailingRefreshControl()

        def locator(self, selector):
            if selector == "body":
                return Body()
            return super().locator(selector)

    package_logger = logging.getLogger("shensi_adapter")
    package_logger.addHandler(caplog.handler)
    try:
        with caplog.at_level(
            logging.INFO,
            logger="shensi_adapter.browser_state",
        ), pytest.raises(RuntimeError, match="click failed"):
            browser_state_module._interact_login_context(
                _LoginContext(FailingRefreshPage()),
                {"type": "refresh_qr"},
            )
    finally:
        package_logger.removeHandler(caplog.handler)

    assert [
        message
        for message in caplog.messages
        if message.startswith("douyin_login_qr_refresh ")
    ] == [
        "douyin_login_qr_refresh entry=interaction outcome=click_failed"
    ]
    assert sensitive_error not in caplog.text
    assert "cookie" not in caplog.text.lower()
    assert "session=" not in caplog.text.lower()


def test_refresh_qr_capture_respects_one_hard_wait_budget(monkeypatch):
    class Clock:
        value = 0.0

        def monotonic(self):
            return self.value

        def advance_ms(self, milliseconds):
            self.value += milliseconds / 1_000

    clock = Clock()
    capture_timeouts = []

    class SlowQr:
        def count(self):
            return 1

        def nth(self, _index):
            return self

        def is_visible(self, **_kwargs):
            return True

        def get_attribute(self, name, **_kwargs):
            assert name == "src"
            return ""

        def evaluate(self, _expression, **_kwargs):
            return None

        def screenshot(self, *, timeout):
            capture_timeouts.append(timeout)
            clock.advance_ms(timeout)
            raise RuntimeError("capture timed out")

    class Body:
        def __init__(self, page):
            self.page = page

        def inner_text(self, **_kwargs):
            return "二维码失效\n点击刷新" if self.page.expired else ""

    class RefreshControl:
        def __init__(self, page):
            self.page = page

        def count(self):
            return 1

        def nth(self, _index):
            return self

        def is_visible(self):
            return True

        def click(self, **_kwargs):
            self.page.expired = False

    class SlowRefreshPage(_LoginPage):
        def __init__(self):
            super().__init__()
            self.expired = True

        def reload(self, **_kwargs):
            return None

        def get_by_text(self, text, *, exact):
            assert (text, exact) == ("点击刷新", True)
            return RefreshControl(self)

        def locator(self, selector):
            if selector == "body":
                return Body(self)
            if selector == "#login-panel-new svg image":
                return _EmptyLocator() if self.expired else SlowQr()
            return super().locator(selector)

        def wait_for_timeout(self, milliseconds):
            clock.advance_ms(milliseconds)

    monkeypatch.setattr(
        browser_state_module,
        "time",
        SimpleNamespace(monotonic=clock.monotonic),
    )

    result = browser_state_module._interact_login_context(
        _LoginContext(SlowRefreshPage()),
        {"type": "refresh_qr"},
    )

    assert result["qr_status"] == "opening"
    assert capture_timeouts
    assert capture_timeouts[-1] < 5_000
    assert clock.value <= 25.0


def test_refreshed_qr_does_not_reuse_css_budget_for_generic_probe(
    monkeypatch,
):
    class Clock:
        value = 0.0

        def monotonic(self):
            return self.value

        def advance_ms(self, milliseconds):
            self.value += milliseconds / 1_000

    clock = Clock()
    capture_calls = []

    class Body:
        advanced = False

        def inner_text(self, **_kwargs):
            if not self.advanced:
                self.advanced = True
                clock.advance_ms(20_500)
            return ""

    class SlowCssQr:
        def count(self):
            return 1

        def nth(self, _index):
            return self

        def is_visible(self, **_kwargs):
            return True

        def screenshot(self, *, timeout):
            capture_calls.append(("css", timeout))
            clock.advance_ms(timeout)
            raise RuntimeError("css capture timed out")

    class GenericQr:
        def is_visible(self, **_kwargs):
            return True

        def evaluate(self, expression, **_kwargs):
            if "getBoundingClientRect" in expression:
                return {
                    "tag": "IMG",
                    "source": "",
                    "width": 160,
                    "height": 160,
                    "hinted": True,
                }
            return None

        def get_attribute(self, name, **_kwargs):
            assert name == "src"
            return ""

        def screenshot(self, *, timeout):
            capture_calls.append(("generic", timeout))
            clock.advance_ms(timeout)
            raise RuntimeError("generic capture timed out")

    class GenericSet:
        qr = GenericQr()

        def count(self):
            return 1

        def nth(self, _index):
            return self.qr

    class SlowFallbackPage:
        def title(self):
            return "抖音-记录美好生活"

        def locator(self, selector):
            if selector == "body":
                return Body()
            if selector == browser_state_module.DOUYIN_LOGIN_QR_CONTAINER_SELECTOR:
                return SlowCssQr()
            if selector == "img, canvas, svg":
                return GenericSet()
            return _EmptyLocator()

        def wait_for_timeout(self, milliseconds):
            clock.advance_ms(milliseconds)

    monkeypatch.setattr(
        browser_state_module,
        "time",
        SimpleNamespace(monotonic=clock.monotonic),
    )

    status, image = browser_state_module._wait_for_refreshed_qr(
        SlowFallbackPage()
    )

    assert (status, image) == ("opening", None)
    assert capture_calls
    assert {kind for kind, _timeout in capture_calls} == {"css"}
    assert clock.value <= 25.0


def test_refreshed_qr_status_probe_does_not_run_past_the_deadline(
    monkeypatch,
):
    class Clock:
        value = 0.0

        def monotonic(self):
            return self.value

        def advance_ms(self, milliseconds):
            self.value += milliseconds / 1_000

    clock = Clock()
    body_reads = []

    class SlowAbsentVerification:
        def count(self):
            return 1

        def nth(self, _index):
            return self

        def is_visible(self, **kwargs):
            clock.advance_ms(kwargs.get("timeout", 5_000))
            return False

    class Body:
        def inner_text(self, *, timeout):
            body_reads.append(timeout)
            clock.advance_ms(timeout)
            return ""

    class SlowStatusPage:
        def title(self):
            return "抖音-记录美好生活"

        def locator(self, selector):
            if selector in browser_state_module.DOUYIN_VERIFICATION_SELECTORS:
                return SlowAbsentVerification()
            if selector == "body":
                return Body()
            return _EmptyLocator()

        def wait_for_timeout(self, milliseconds):
            clock.advance_ms(milliseconds)

    monkeypatch.setattr(
        browser_state_module,
        "time",
        SimpleNamespace(monotonic=clock.monotonic),
    )

    status, image = browser_state_module._wait_for_refreshed_qr(
        SlowStatusPage()
    )

    assert (status, image) == ("opening", None)
    assert body_reads == []
    assert clock.value <= 25.0


@pytest.mark.parametrize(
    ("expected_status", "title", "body_text"),
    [
        ("network_error", "抖音-记录美好生活", "当前网络异常"),
        ("verification_required", "验证码中间页", ""),
    ],
)
def test_refresh_qr_preserves_network_and_verification_states(
    expected_status,
    title,
    body_text,
):
    class Body:
        def inner_text(self, **_kwargs):
            return body_text

    class BlockedRefreshPage(_LoginPage):
        def reload(self, **_kwargs):
            return None

        def title(self):
            return title

        def get_by_text(self, *_args, **_kwargs):
            raise AssertionError("blocked states must not click QR refresh")

        def locator(self, selector):
            if selector == "body":
                return Body()
            return super().locator(selector)

    result = browser_state_module._interact_login_context(
        _LoginContext(BlockedRefreshPage()),
        {"type": "refresh_qr"},
    )

    assert result["active"] is False
    assert result["qr_status"] == expected_status
    assert result["qr_image_data_url"] is None


def test_poll_reports_an_expired_qr_without_claiming_ready():
    class Body:
        def inner_text(self, **_kwargs):
            return "二维码失效\n点击刷新"

    class ExpiredQrPage(_LoginPage):
        def locator(self, selector):
            if selector == "body":
                return Body()
            return super().locator(selector)

    result = browser_state_module._poll_login_context(
        _LoginContext(ExpiredQrPage())
    )

    assert result["active"] is False
    assert result["qr_status"] == "expired"
    assert result["qr_image_data_url"] is None


def test_qr_wait_rejects_a_stale_image_when_the_page_marks_it_expired():
    class Body:
        def inner_text(self, **_kwargs):
            return "二维码失效\n点击刷新"

    class ExpiredQrPage(_LoginPage):
        def locator(self, selector):
            if selector == "body":
                return Body()
            return super().locator(selector)

    with pytest.raises(
        RuntimeError,
        match="^douyin_qr_image_unavailable$",
    ):
        browser_state_module._wait_for_qr_image(ExpiredQrPage())


def test_poll_reports_a_page_level_network_error_without_claiming_ready():
    class Body:
        def inner_text(self, **_kwargs):
            return "当前网络异常，请刷新"

    class NetworkErrorPage(_LoginPage):
        def locator(self, selector):
            if selector == "body":
                return Body()
            return super().locator(selector)

    result = browser_state_module._poll_login_context(
        _LoginContext(NetworkErrorPage())
    )

    assert result["active"] is False
    assert result["qr_status"] == "network_error"
    assert result["qr_image_data_url"] is None


def test_poll_reports_verification_required_without_claiming_ready():
    page = _LoginPage()
    page.title = lambda: "验证码中间页"

    result = browser_state_module._poll_login_context(_LoginContext(page))

    assert result["active"] is False
    assert result["qr_status"] == "verification_required"
    assert result["qr_image_data_url"] is None


def test_qr_diagnostics_log_only_closed_stage_status_and_counters(caplog):
    package_logger = logging.getLogger("shensi_adapter")
    package_logger.addHandler(caplog.handler)
    try:
        with caplog.at_level(
            logging.INFO,
            logger="shensi_adapter.browser_state",
        ):
            browser_state_module._log_login_qr_diagnostic(
                stage="refresh_result",
                status="ready",
                poll_count=3,
                refresh_count=1,
            )
    finally:
        package_logger.removeHandler(caplog.handler)

    assert caplog.messages == [
        "douyin_login_qr stage=refresh_result status=ready "
        "poll_count=3 refresh_count=1"
    ]
    assert "data:image" not in caplog.text
    assert "cookie" not in caplog.text.lower()


def test_expired_qr_refresh_logs_one_closed_unavailable_outcome(caplog):
    sensitive_error = (
        "https://www.douyin.com/?cookie=must-not-leak "
        "data:image/png;base64,bXVzdC1ub3QtbGVhaw=="
    )

    class Body:
        def inner_text(self, **_kwargs):
            return f"二维码失效\n点击刷新\n{sensitive_error}"

    class MissingRefreshPage(_LoginPage):
        def reload(self, **_kwargs):
            return None

        def get_by_text(self, *_args, **_kwargs):
            return _EmptyLocator()

        def locator(self, selector):
            if selector == "body":
                return Body()
            return super().locator(selector)

    package_logger = logging.getLogger("shensi_adapter")
    package_logger.addHandler(caplog.handler)
    try:
        with caplog.at_level(
            logging.INFO,
            logger="shensi_adapter.browser_state",
        ):
            result = browser_state_module._interact_login_context(
                _LoginContext(MissingRefreshPage()),
                {"type": "refresh_qr"},
            )
    finally:
        package_logger.removeHandler(caplog.handler)

    assert result["qr_status"] == "expired"
    assert [
        message
        for message in caplog.messages
        if message.startswith("douyin_login_qr_refresh ")
    ] == [
        "douyin_login_qr_refresh entry=interaction outcome=unavailable"
    ]
    assert sensitive_error not in caplog.text
    assert "cookie" not in caplog.text.lower()
    assert "data:image" not in caplog.text.lower()


def test_refresh_qr_network_diagnostic_logs_zero_and_removes_listeners(caplog):
    class Body:
        def inner_text(self, **_kwargs):
            return "二维码失效\n点击刷新"

    class ObservableRefreshPage(_LoginPage):
        def __init__(self):
            super().__init__()
            self.listeners = {}
            self.removed = []

        def on(self, event, callback):
            self.listeners[event] = callback

        def remove_listener(self, event, callback):
            assert self.listeners[event] is callback
            self.removed.append(event)
            self.listeners.pop(event)

        def get_by_text(self, *_args, **_kwargs):
            return _EmptyLocator()

        def locator(self, selector):
            if selector == "body":
                return Body()
            return super().locator(selector)

    page = ObservableRefreshPage()
    package_logger = logging.getLogger("shensi_adapter")
    package_logger.addHandler(caplog.handler)
    try:
        with caplog.at_level(
            logging.INFO,
            logger="shensi_adapter.browser_state",
        ):
            result = browser_state_module._interact_login_context(
                _LoginContext(page),
                {"type": "refresh_qr"},
            )
    finally:
        package_logger.removeHandler(caplog.handler)

    assert result["qr_status"] == "expired"
    assert page.listeners == {}
    assert page.removed == ["response", "requestfailed"]
    assert [
        message
        for message in caplog.messages
        if message.startswith("douyin_login_refresh_network ")
    ] == [
        "douyin_login_refresh_network phase=before hostname=none "
        "resource_type=other count=0",
        "douyin_login_refresh_network phase=after hostname=none "
        "resource_type=other count=0",
    ]


def test_refresh_qr_logs_closed_stage_order_and_remaining_budget_before_work(
    monkeypatch,
    caplog,
):
    class Clock:
        value = 100.0

        def monotonic(self):
            return self.value

        def advance(self, milliseconds):
            self.value += milliseconds / 1_000

    clock = Clock()

    class TimedRefreshPage(_LoginPage):
        def __init__(self):
            super().__init__(
                "https://www.douyin.com/?session=sensitive-session-marker"
            )

        def reload(self, **_kwargs):
            clock.advance(1_000)

    page = TimedRefreshPage()
    panel_calls = 0

    def wait_for_panel(_page):
        nonlocal panel_calls
        panel_calls += 1
        clock.advance(2_000)
        return panel_calls == 2

    def click_login(_page):
        clock.advance(3_000)

    def activate_qr(_page):
        clock.advance(4_000)

    def wait_for_qr(_page):
        clock.advance(5_000)
        return "data:image/png;base64,c2Vuc2l0aXZlLXFyLW1hcmtlcg=="

    monkeypatch.setattr(
        browser_state_module,
        "time",
        SimpleNamespace(monotonic=clock.monotonic),
    )
    monkeypatch.setattr(
        browser_state_module,
        "_non_ready_qr_status",
        lambda _page: None,
    )
    monkeypatch.setattr(
        browser_state_module,
        "_wait_for_login_panel",
        wait_for_panel,
    )
    monkeypatch.setattr(
        browser_state_module,
        "_click_login_button",
        click_login,
    )
    monkeypatch.setattr(
        browser_state_module,
        "_activate_qr_login",
        activate_qr,
    )
    monkeypatch.setattr(
        browser_state_module,
        "_wait_for_qr_image",
        wait_for_qr,
    )

    package_logger = logging.getLogger("shensi_adapter")
    package_logger.addHandler(caplog.handler)
    try:
        with caplog.at_level(
            logging.INFO,
            logger="shensi_adapter.browser_state",
        ):
            result = browser_state_module._interact_login_context(
                _LoginContext(page),
                {"type": "refresh_qr"},
                diagnostic_timeout_ms=65_000,
            )
    finally:
        package_logger.removeHandler(caplog.handler)

    assert result["qr_status"] == "ready"
    timing_messages = [
        message
        for message in caplog.messages
        if message.startswith("douyin_login_refresh_timing ")
    ]
    assert timing_messages == [
        "douyin_login_refresh_timing stage=start elapsed_ms=0 "
        "remaining_ms=65000",
        "douyin_login_refresh_timing stage=status_before elapsed_ms=0 "
        "remaining_ms=65000",
        "douyin_login_refresh_timing stage=reload elapsed_ms=0 "
        "remaining_ms=65000",
        "douyin_login_refresh_timing stage=status_after_reload "
        "elapsed_ms=1000 remaining_ms=64000",
        "douyin_login_refresh_timing stage=panel_probe elapsed_ms=1000 "
        "remaining_ms=64000",
        "douyin_login_refresh_timing stage=open_login elapsed_ms=3000 "
        "remaining_ms=62000",
        "douyin_login_refresh_timing stage=panel_reprobe elapsed_ms=6000 "
        "remaining_ms=59000",
        "douyin_login_refresh_timing stage=activate_qr elapsed_ms=8000 "
        "remaining_ms=57000",
        "douyin_login_refresh_timing stage=wait_qr elapsed_ms=12000 "
        "remaining_ms=53000",
        "douyin_login_refresh_timing stage=capture_page elapsed_ms=17000 "
        "remaining_ms=48000",
        "douyin_login_refresh_timing stage=finish elapsed_ms=17000 "
        "remaining_ms=48000",
    ]
    assert "sensitive-session-marker" not in caplog.text
    assert "sensitive-qr-marker" not in caplog.text
    assert "cookie" not in caplog.text.lower()
    assert "data:image" not in caplog.text.lower()


def test_refresh_qr_logs_stage_before_a_blocking_operation(monkeypatch, caplog):
    class FailingReloadPage(_LoginPage):
        def reload(self, **_kwargs):
            timing_messages = [
                message
                for message in caplog.messages
                if message.startswith("douyin_login_refresh_timing ")
            ]
            assert timing_messages[-1].startswith(
                "douyin_login_refresh_timing stage=reload "
            )
            raise RuntimeError("reload blocked")

    monkeypatch.setattr(
        browser_state_module,
        "_non_ready_qr_status",
        lambda _page: None,
    )
    package_logger = logging.getLogger("shensi_adapter")
    package_logger.addHandler(caplog.handler)
    try:
        with caplog.at_level(
            logging.INFO,
            logger="shensi_adapter.browser_state",
        ), pytest.raises(RuntimeError, match="^reload blocked$"):
            browser_state_module._interact_login_context(
                _LoginContext(FailingReloadPage()),
                {"type": "refresh_qr"},
                diagnostic_timeout_ms=65_000,
            )
    finally:
        package_logger.removeHandler(caplog.handler)

    timing_messages = [
        message
        for message in caplog.messages
        if message.startswith("douyin_login_refresh_timing ")
    ]
    assert [message.split()[1] for message in timing_messages] == [
        "stage=start",
        "stage=status_before",
        "stage=reload",
        "stage=finish",
    ]


def test_refresh_qr_timing_stage_is_a_closed_redacted_value(caplog):
    sensitive_stage = (
        "cookie=must-not-leak "
        "https://www.douyin.com/login/?ticket=must-not-leak"
    )
    package_logger = logging.getLogger("shensi_adapter")
    package_logger.addHandler(caplog.handler)
    try:
        with caplog.at_level(
            logging.INFO,
            logger="shensi_adapter.browser_state",
        ):
            browser_state_module._log_refresh_timing(
                stage=sensitive_stage,
                started_at=10.0,
                diagnostic_timeout_ms=65_000,
                observed_at=10.5,
            )
    finally:
        package_logger.removeHandler(caplog.handler)

    assert caplog.messages[-1] == (
        "douyin_login_refresh_timing stage=finish elapsed_ms=500 "
        "remaining_ms=64500"
    )
    assert sensitive_stage not in caplog.text


def test_refresh_qr_passes_the_configured_command_budget_to_worker_evidence():
    browser = object.__new__(
        browser_state_module.MediaCrawlerDouyinBrowserState
    )
    browser._timeout = 12.5
    observed = []
    browser._call = lambda operation, **payload: (
        observed.append((operation, payload)) or {"active": False}
    )
    request = TypeAdapter(schemas_module.LoginInteractionRequest).validate_python(
        {"type": "refresh_qr"}
    )

    result = browser.interact_douyin_login(
        {"handle": "opaque-browser-handle"},
        request,
    )

    assert result == {"active": False}
    assert observed == [(
        "interact",
        {
            "handle": "opaque-browser-handle",
            "request": {"type": "refresh_qr"},
            "diagnostic_timeout_ms": 12_500,
        },
    )]


def test_refresh_qr_network_listener_failures_do_not_change_the_result():
    class Body:
        def inner_text(self, **_kwargs):
            return "二维码失效\n点击刷新"

    class UnreliableListenerPage(_LoginPage):
        def __init__(self):
            super().__init__()
            self.register_attempts = []
            self.remove_attempts = []

        def on(self, event, _callback):
            self.register_attempts.append(event)
            if event == "response":
                raise RuntimeError("listener unavailable")

        def remove_listener(self, event, _callback):
            self.remove_attempts.append(event)
            raise RuntimeError("listener removal unavailable")

        def get_by_text(self, *_args, **_kwargs):
            return _EmptyLocator()

        def locator(self, selector):
            if selector == "body":
                return Body()
            return super().locator(selector)

    page = UnreliableListenerPage()
    result = browser_state_module._interact_login_context(
        _LoginContext(page),
        {"type": "refresh_qr"},
    )

    assert result["qr_status"] == "expired"
    assert page.register_attempts == ["response", "requestfailed"]
    assert page.remove_attempts == ["requestfailed"]


def test_refresh_qr_network_diagnostic_aggregates_failed_requests_safely(
    caplog,
):
    class FailedRequest:
        def __init__(self, url, resource_type, failure):
            self.url = url
            self.resource_type = resource_type
            self.failure = failure

    class Body:
        def __init__(self, page):
            self.page = page

        def inner_text(self, **_kwargs):
            self.page.emit(
                "requestfailed",
                FailedRequest(
                    "https://www.douyin.com/private/path?cookie=must-not-leak",
                    "xhr",
                    "net::ERR_CONNECTION_RESET",
                ),
            )
            return "二维码失效\n点击刷新"

    class ObservableRefreshPage(_LoginPage):
        def __init__(self):
            super().__init__()
            self.listeners = {}

        def on(self, event, callback):
            self.listeners[event] = callback

        def remove_listener(self, event, callback):
            assert self.listeners[event] is callback
            self.listeners.pop(event)

        def emit(self, event, value):
            self.listeners[event](value)

        def get_by_text(self, *_args, **_kwargs):
            self.emit(
                "requestfailed",
                FailedRequest(
                    "https://api.douyin.com/qr?session=must-not-leak",
                    "fetch",
                    "net::ERR_FAILED",
                ),
            )
            self.emit(
                "requestfailed",
                FailedRequest(
                    "https://private-secret.evil.example/qr",
                    "xhr",
                    "net::ERR_ABORTED",
                ),
            )
            return _EmptyLocator()

        def locator(self, selector):
            if selector == "body":
                return Body(self)
            return super().locator(selector)

    package_logger = logging.getLogger("shensi_adapter")
    package_logger.addHandler(caplog.handler)
    try:
        with caplog.at_level(
            logging.INFO,
            logger="shensi_adapter.browser_state",
        ):
            result = browser_state_module._interact_login_context(
                _LoginContext(ObservableRefreshPage()),
                {"type": "refresh_qr"},
            )
    finally:
        package_logger.removeHandler(caplog.handler)

    assert result["qr_status"] == "expired"
    assert [
        message
        for message in caplog.messages
        if message.startswith("douyin_login_refresh_network ")
    ] == [
        "douyin_login_refresh_network phase=before hostname=www.douyin.com "
        "resource_type=xhr error=net::ERR_CONNECTION_RESET count=1",
        "douyin_login_refresh_network phase=after hostname=api.douyin.com "
        "resource_type=fetch error=net::ERR_FAILED count=1",
        "douyin_login_refresh_network phase=after hostname=other "
        "resource_type=xhr error=net::ERR_ABORTED count=1",
    ]
    assert "/private/path" not in caplog.text
    assert "/qr" not in caplog.text
    assert "cookie" not in caplog.text.lower()
    assert "session" not in caplog.text.lower()
    assert "private-secret" not in caplog.text.lower()


def test_refresh_qr_network_diagnostic_aggregates_http_statuses_safely(
    caplog,
):
    class Request:
        def __init__(self, resource_type):
            self.resource_type = resource_type

    class Response:
        def __init__(self, url, status, resource_type):
            self.url = url
            self.status = status
            self.request = Request(resource_type)

        @property
        def headers(self):
            raise AssertionError("diagnostic must not inspect headers")

        def body(self):
            raise AssertionError("diagnostic must not inspect bodies")

    class Body:
        def __init__(self, page):
            self.page = page

        def inner_text(self, **_kwargs):
            self.page.emit(
                "response",
                Response(
                    "https://www.douyin.com/private/qr?cookie=must-not-leak",
                    200,
                    "document",
                ),
            )
            return "二维码失效\n点击刷新"

    class ObservableRefreshPage(_LoginPage):
        def __init__(self):
            super().__init__()
            self.listeners = {}

        def on(self, event, callback):
            self.listeners[event] = callback

        def remove_listener(self, event, callback):
            assert self.listeners[event] is callback
            self.listeners.pop(event)

        def emit(self, event, value):
            self.listeners[event](value)

        def get_by_text(self, *_args, **_kwargs):
            response = Response(
                "https://api.douyin.com/internal/login?session=must-not-leak",
                503,
                "xhr",
            )
            self.emit("response", response)
            self.emit("response", response)
            return _EmptyLocator()

        def locator(self, selector):
            if selector == "body":
                return Body(self)
            return super().locator(selector)

    package_logger = logging.getLogger("shensi_adapter")
    package_logger.addHandler(caplog.handler)
    try:
        with caplog.at_level(
            logging.INFO,
            logger="shensi_adapter.browser_state",
        ):
            result = browser_state_module._interact_login_context(
                _LoginContext(ObservableRefreshPage()),
                {"type": "refresh_qr"},
            )
    finally:
        package_logger.removeHandler(caplog.handler)

    assert result["qr_status"] == "expired"
    assert [
        message
        for message in caplog.messages
        if message.startswith("douyin_login_refresh_network ")
    ] == [
        "douyin_login_refresh_network phase=before hostname=www.douyin.com "
        "resource_type=document status=200 count=1",
        "douyin_login_refresh_network phase=after hostname=api.douyin.com "
        "resource_type=xhr status=503 count=2",
    ]
    assert "/private/qr" not in caplog.text
    assert "/internal/login" not in caplog.text
    assert "cookie" not in caplog.text.lower()
    assert "session" not in caplog.text.lower()


def test_poll_reports_ready_only_with_a_visible_qr_image():
    class VisibleQr:
        def count(self):
            return 1

        def nth(self, _index):
            return self

        def is_visible(self):
            return True

        def get_attribute(self, name):
            assert name == "src"
            return "data:image/png;base64,cXI="

    class ReadyQrPage(_LoginPage):
        def locator(self, selector):
            if selector == "#login-panel-new svg image":
                return VisibleQr()
            return super().locator(selector)

    result = browser_state_module._poll_login_context(
        _LoginContext(ReadyQrPage())
    )

    assert result["active"] is False
    assert result["qr_status"] == "ready"
    assert result["qr_image_data_url"] == "data:image/png;base64,cXI="


@pytest.mark.parametrize(
    "url",
    [
        "https://evil.example/",
        "https://douyin.com.evil.example/",
        "http://www.douyin.com/",
        "https://www.douyin.com:8443/",
    ],
)
def test_login_context_rejects_disallowed_navigation(url):
    page = _LoginPage(url)
    context = _LoginContext(page)

    with pytest.raises(
        RuntimeError,
        match="^douyin_login_page_not_allowed$",
    ):
        getattr(browser_state_module, "_interact_login_context")(
            context,
            {"type": "key", "key": "Tab"},
        )

    assert page.keyboard.keys == []


class _WorkerConnection:
    def __init__(self, commands):
        self.commands = iter(commands)
        self.sent = []
        self.closed = False

    def recv(self):
        return next(self.commands)

    def send(self, value):
        self.sent.append(value)

    def close(self):
        self.closed = True


def test_worker_interaction_reuses_the_open_login_context(monkeypatch):
    context = _LoginContext(_LoginPage())
    observed_contexts = []
    open_options = []
    request = {"type": "key", "key": "Tab"}
    connection = _WorkerConnection([
        {"id": 1, "operation": "open", "profile_path": "/profile"},
        {
            "id": 2,
            "operation": "interact",
            "handle": "fixed-handle",
            "request": request,
        },
        {"id": 3, "operation": "shutdown"},
    ])
    monkeypatch.setattr(browser_state_module, "os", SimpleNamespace(name="nt"))
    monkeypatch.setattr(
        browser_state_module,
        "create_visual_locator",
        lambda _mode: None,
    )
    monkeypatch.setattr(
        browser_state_module,
        "_start_playwright",
        lambda _factory: SimpleNamespace(stop=lambda: None),
    )
    monkeypatch.setattr(
        browser_state_module,
        "_open_context",
        lambda *_args, **kwargs: (
            open_options.append(kwargs)
            or (
                context,
                {
                    "login_page": FRAME_ONE,
                    "qr_status": "ready",
                    "qr_image_data_url": "data:image/png;base64,cXI=",
                },
            )
        ),
    )
    monkeypatch.setattr(
        browser_state_module,
        "_interact_login_context",
        lambda received, raw: (
            observed_contexts.append((received, raw))
            or {"active": False, "login_page": FRAME_TWO}
        ),
        raising=False,
    )
    monkeypatch.setattr(
        browser_state_module.secrets,
        "token_urlsafe",
        lambda _length: "fixed-handle",
    )

    _browser_worker(connection, None, False, "chrome", 30)

    assert open_options == [{
        "headless": False,
        "browser_channel": "chrome",
        "browser_proxy": None,
        "browser_environment": None,
        "defer_auxiliary": True,
        "interaction_surface": "remote_canvas",
    }]
    assert observed_contexts == [(context, request)]
    assert connection.sent == [
        {"kind": "ready"},
        {
                "id": 1,
                "kind": "ok",
                "value": {
                    "handle": "fixed-handle",
                    "login_page": FRAME_ONE,
                    "qr_status": "ready",
                    "qr_image_data_url": "data:image/png;base64,cXI=",
                },
        },
        {
            "id": 2,
            "kind": "ok",
            "value": {"active": False, "login_page": FRAME_TWO},
        },
        {"kind": "shutdown_ok"},
    ]
    assert context.closed is True


def test_worker_prepares_the_registered_login_context_after_open(monkeypatch):
    context = _LoginContext(_LoginPage())
    prepared_contexts = []
    connection = _WorkerConnection([
        {"id": 1, "operation": "open", "profile_path": "/profile"},
        {
            "id": 2,
            "operation": "prepare_login",
            "handle": "fixed-handle",
        },
        {"id": 3, "operation": "shutdown"},
    ])
    monkeypatch.setattr(browser_state_module, "os", SimpleNamespace(name="nt"))
    monkeypatch.setattr(
        browser_state_module,
        "create_visual_locator",
        lambda _mode: None,
    )
    monkeypatch.setattr(
        browser_state_module,
        "_start_playwright",
        lambda _factory: SimpleNamespace(stop=lambda: None),
    )
    monkeypatch.setattr(
        browser_state_module,
        "_open_context",
        lambda *_args, **_kwargs: (
            context,
            {
                "login_page": None,
                "qr_status": "opening",
                "qr_image_data_url": None,
            },
        ),
    )
    monkeypatch.setattr(
        browser_state_module,
        "_prepare_login_context",
        lambda received: (
            prepared_contexts.append(received)
            or {
                "login_page": FRAME_ONE,
                "qr_status": "ready",
                "qr_image_data_url": "data:image/png;base64,cXI=",
            }
        ),
        raising=False,
    )
    monkeypatch.setattr(
        browser_state_module.secrets,
        "token_urlsafe",
        lambda _length: "fixed-handle",
    )

    _browser_worker(connection, None, False, "chrome", 30)

    assert prepared_contexts == [context]
    assert connection.sent[2] == {
        "id": 2,
        "kind": "ok",
        "value": {
            "login_page": FRAME_ONE,
            "qr_status": "ready",
            "qr_image_data_url": "data:image/png;base64,cXI=",
        },
    }
    assert context.closed is True


class _InteractiveBrowser:
    def __init__(self):
        self.closed = 0
        self.interactions = []
        self.poll_result = {"active": False, "login_page": FRAME_TWO}

    def open_douyin_login(self, profile_path):
        assert Path(profile_path).exists()
        return {"handle": "opaque-login-handle", "login_page": FRAME_ONE}

    def poll_douyin_login(self, _context):
        return self.poll_result

    def interact_douyin_login(self, _context, request):
        self.interactions.append(request.model_dump(mode="json"))
        return {"active": False, "login_page": FRAME_THREE}

    def close(self, _context):
        self.closed += 1

    def close_browser(self):
        return None


def test_login_interaction_cleanup_does_not_replace_the_original_timeout(
    tmp_path,
    caplog,
):
    class TimeoutBrowser(_InteractiveBrowser):
        def __init__(self):
            super().__init__()
            self.profile_path = None

        def open_douyin_login(self, profile_path):
            self.profile_path = Path(profile_path)
            return super().open_douyin_login(profile_path)

        def interact_douyin_login(self, _context, _request):
            raise RuntimeError("douyin_browser_command_timeout")

        def close(self, _context):
            self.closed += 1
            raise RuntimeError("douyin_browser_unavailable")

    browser = TimeoutBrowser()
    manager = AccountManager(tmp_path, browser, now=lambda: NOW)
    created = manager.create_login_session()
    deadline = time.monotonic() + 1
    while time.monotonic() < deadline:
        session = manager.get_login_session(created.session_id)
        if session.login_page == schemas_module.LoginPageView.model_validate(
            FRAME_TWO
        ):
            break
        time.sleep(0.01)
    else:
        pytest.fail("background login page did not become available")

    try:
        accounts_logger = logging.getLogger("shensi_adapter.accounts")
        accounts_logger.addHandler(caplog.handler)
        try:
            with caplog.at_level(
                logging.WARNING,
                logger="shensi_adapter.accounts",
            ):
                with pytest.raises(
                    RuntimeError,
                    match="^douyin_browser_command_timeout$",
                ):
                    manager.interact_login_session(
                        created.session_id,
                        TypeAdapter(
                            getattr(schemas_module, "LoginInteractionRequest")
                        ).validate_python({"type": "refresh_qr"}),
                    )
        finally:
            accounts_logger.removeHandler(caplog.handler)

        assert browser.closed == 1
        assert browser.profile_path is not None
        assert browser.profile_path.exists() is False
        with pytest.raises(KeyError):
            manager.get_login_session(created.session_id)
        assert [
            message
            for message in caplog.messages
            if message.startswith("douyin_login_interaction ")
        ] == [
            "douyin_login_interaction stage=cleanup_failed "
            "primary_error_code=douyin_browser_command_timeout "
            "cleanup_error_code=douyin_browser_unavailable"
        ]
    finally:
        manager.close()


@pytest.mark.parametrize("operation", ["poll", "refresh"])
@pytest.mark.parametrize("end_session", ["disconnect", "expire"])
def test_temporary_login_page_capture_failure_keeps_and_recovers_session(
    tmp_path,
    operation,
    end_session,
):
    qr_image = "data:image/png;base64,cXI="

    class TemporaryCaptureFailureBrowser(_InteractiveBrowser):
        def __init__(self):
            super().__init__()
            self.context = {
                "handle": "opaque-login-handle",
                "login_page": FRAME_ONE,
                "qr_status": "ready",
                "qr_image_data_url": qr_image,
            }
            self.profile_path = None
            self.poll_frame = FRAME_ONE
            self.interaction_frame = FRAME_ONE
            self.observed_contexts = []
            self.closed_contexts = []

        def open_douyin_login(self, profile_path):
            self.profile_path = Path(profile_path)
            assert self.profile_path.exists()
            return self.context

        @staticmethod
        def _result(login_page):
            return {
                "active": False,
                "login_page": login_page,
                "qr_status": "ready",
                "qr_image_data_url": qr_image,
            }

        def poll_douyin_login(self, context):
            self.observed_contexts.append(context)
            return self._result(self.poll_frame)

        def interact_douyin_login(self, context, request):
            self.observed_contexts.append(context)
            self.interactions.append(request.model_dump(mode="json"))
            return self._result(self.interaction_frame)

        def close(self, context):
            self.closed_contexts.append(context)

    browser = TemporaryCaptureFailureBrowser()
    manager = AccountManager(
        tmp_path,
        browser,
        now=lambda: NOW,
        session_ttl=timedelta(minutes=1),
    )
    created = manager.create_login_session()
    deadline = time.monotonic() + 1
    while time.monotonic() < deadline:
        ready = manager.get_login_session(created.session_id)
        if ready.login_page == schemas_module.LoginPageView.model_validate(
            FRAME_ONE
        ):
            break
        time.sleep(0.01)
    else:
        pytest.fail("background login page did not become available")

    try:
        if operation == "poll":
            browser.poll_frame = None
            unavailable = manager.get_login_session(created.session_id)
        else:
            browser.interaction_frame = None
            unavailable = manager.interact_login_session(
                created.session_id,
                TypeAdapter(
                    getattr(schemas_module, "LoginInteractionRequest")
                ).validate_python({"type": "refresh_qr"}),
            )

        assert unavailable.state == "awaiting_scan"
        assert unavailable.login_page is None
        assert unavailable.qr_status == "ready"
        assert unavailable.qr_image_data_url == qr_image
        assert unavailable.session_id == created.session_id
        assert browser.closed_contexts == []
        assert browser.profile_path is not None
        assert browser.profile_path.exists()
        assert browser.observed_contexts
        assert all(
            context is browser.context
            for context in browser.observed_contexts
        )

        browser.poll_frame = FRAME_TWO
        recovered = manager.get_login_session(created.session_id)

        assert recovered.state == "awaiting_scan"
        assert recovered.login_page == (
            schemas_module.LoginPageView.model_validate(FRAME_TWO)
        )
        assert recovered.qr_status == "ready"
        assert recovered.qr_image_data_url == qr_image
        assert browser.closed_contexts == []
        assert browser.profile_path.exists()

        if end_session == "disconnect":
            manager.disconnect(created.session_id)
            with pytest.raises(KeyError):
                manager.get_login_session(created.session_id)
            cleanup_deadline = time.monotonic() + 1
            while (
                browser.profile_path.exists()
                and time.monotonic() < cleanup_deadline
            ):
                time.sleep(0.01)
        else:
            expired = manager.get_login_session(
                created.session_id,
                NOW + timedelta(minutes=2),
            )
            assert expired.state == "expired"

        assert browser.closed_contexts == [browser.context]
        assert browser.profile_path.exists() is False
    finally:
        manager.close()


def test_login_page_refreshes_on_poll_and_interaction_endpoint(tmp_path):
    browser = _InteractiveBrowser()
    manager = AccountManager(tmp_path, browser, now=lambda: NOW)
    app = create_app(SERVICE_SECRET, manager)
    headers = {"Authorization": f"Bearer {SERVICE_SECRET}"}

    with TestClient(app) as client:
        created = client.post(
            "/internal/v1/douyin/login-sessions",
            headers=headers,
        )
        assert created.status_code == 200
        created_body = created.json()
        assert created_body["qr_image_data_url"] is None
        assert created_body["login_page"] is None

        session_id = created_body["session_id"]
        deadline = time.monotonic() + 1
        while time.monotonic() < deadline:
            polled = client.get(
                f"/internal/v1/douyin/login-sessions/{session_id}",
                headers=headers,
            )
            if polled.json()["login_page"] == FRAME_TWO:
                break
            time.sleep(0.01)
        else:
            pytest.fail("background login page did not become available")
        assert polled.status_code == 200
        assert polled.json()["login_page"] == FRAME_TWO

        interacted = client.post(
            f"/internal/v1/douyin/login-sessions/{session_id}/interactions",
            headers=headers,
            json={
                "type": "click",
                "normalized_x": 0.25,
                "normalized_y": 0.75,
            },
        )
        assert interacted.status_code == 200
        assert interacted.json()["login_page"] == FRAME_THREE

        refreshed = client.post(
            f"/internal/v1/douyin/login-sessions/{session_id}/interactions",
            headers=headers,
            json={"type": "refresh_qr"},
        )
        assert refreshed.status_code == 200
        assert refreshed.json()["login_page"] == FRAME_THREE

    assert browser.interactions == [
        {
            "type": "click",
            "normalized_x": 0.25,
            "normalized_y": 0.75,
        },
        {"type": "refresh_qr"},
    ]


def test_ambiguous_expired_qr_refresh_keeps_the_api_session_alive(
    tmp_path,
    caplog,
):
    clicks = []

    class Body:
        def inner_text(self, **_kwargs):
            return "二维码失效\n点击刷新"

    class RefreshControl:
        def is_visible(self):
            return True

        def click(self, **_kwargs):
            clicks.append(True)

    class AmbiguousRefreshControls:
        controls = (RefreshControl(), RefreshControl())

        def count(self):
            return len(self.controls)

        def nth(self, index):
            return self.controls[index]

    class AmbiguousRefreshPage(_LoginPage):
        def reload(self, **_kwargs):
            return None

        def get_by_text(self, text, *, exact):
            assert (text, exact) == ("点击刷新", True)
            return AmbiguousRefreshControls()

        def locator(self, selector):
            if selector == "body":
                return Body()
            return super().locator(selector)

    live_context = _LoginContext(AmbiguousRefreshPage())

    class HelperBrowser:
        def open_douyin_login(self, profile_path):
            assert Path(profile_path).exists()
            return {
                "handle": "ambiguous-refresh-context",
                "login_page": FRAME_ONE,
                "qr_status": "expired",
                "qr_image_data_url": None,
                "live_context": live_context,
            }

        def poll_douyin_login(self, context):
            return browser_state_module._poll_login_context(
                context["live_context"]
            )

        def interact_douyin_login(self, context, request):
            return browser_state_module._interact_login_context(
                context["live_context"],
                request.model_dump(mode="json"),
            )

        def close(self, context):
            context["live_context"].close()

        def close_browser(self):
            return None

    manager = AccountManager(tmp_path, HelperBrowser(), now=lambda: NOW)
    app = create_app(SERVICE_SECRET, manager)
    headers = {"Authorization": f"Bearer {SERVICE_SECRET}"}

    with TestClient(app, raise_server_exceptions=False) as client:
        created = client.post(
            "/internal/v1/douyin/login-sessions",
            headers=headers,
        )
        session_id = created.json()["session_id"]
        deadline = time.monotonic() + 1
        while time.monotonic() < deadline:
            before = client.get(
                f"/internal/v1/douyin/login-sessions/{session_id}",
                headers=headers,
            )
            if before.status_code == 200 and before.json()["qr_status"] == "expired":
                break
            time.sleep(0.01)
        else:
            pytest.fail("expired login session did not become available")

        package_logger = logging.getLogger("shensi_adapter")
        package_logger.addHandler(caplog.handler)
        try:
            with caplog.at_level(
                logging.INFO,
                logger="shensi_adapter.browser_state",
            ):
                refreshed = client.post(
                    f"/internal/v1/douyin/login-sessions/{session_id}/interactions",
                    headers=headers,
                    json={"type": "refresh_qr"},
                )
        finally:
            package_logger.removeHandler(caplog.handler)
        after = client.get(
            f"/internal/v1/douyin/login-sessions/{session_id}",
            headers=headers,
        )

        assert refreshed.status_code == 200
        assert refreshed.json()["qr_status"] == "expired"
        assert after.status_code == 200
        assert after.json()["qr_status"] == "expired"
        assert clicks == []
        assert live_context.closed is False
        assert [
            message
            for message in caplog.messages
            if message.startswith("douyin_login_qr_refresh ")
        ] == [
            "douyin_login_qr_refresh entry=interaction outcome=unavailable"
        ]


@pytest.mark.parametrize(
    "payload",
    [
        {"type": "click", "normalized_x": -0.01, "normalized_y": 0.5},
        {"type": "click", "normalized_x": 0.5, "normalized_y": 1.01},
        {"type": "text", "text": ""},
        {"type": "text", "text": "x" * 201},
        {"type": "key", "key": "Meta+A"},
        {"type": "scroll", "delta_x": -1.01, "delta_y": 0},
        {"type": "scroll", "delta_x": 0, "delta_y": 1.01},
        {"type": "key", "key": "Enter", "cookie": "not-allowed"},
    ],
)
def test_login_interaction_contract_rejects_unbounded_or_extra_input(payload):
    interaction_type = getattr(schemas_module, "LoginInteractionRequest")

    with pytest.raises(ValidationError):
        TypeAdapter(interaction_type).validate_python(payload)


def test_login_interaction_rejects_expired_disconnected_and_active_sessions(
    tmp_path,
):
    clock = [NOW]
    browser = _InteractiveBrowser()
    manager = AccountManager(
        tmp_path,
        browser,
        now=lambda: clock[0],
        session_ttl=timedelta(minutes=1),
    )
    try:
        expired = manager.create_login_session()
        clock[0] += timedelta(minutes=2)
        with pytest.raises(KeyError):
            manager.interact_login_session(
                expired.session_id,
                TypeAdapter(
                    getattr(schemas_module, "LoginInteractionRequest")
                ).validate_python({"type": "key", "key": "Tab"}),
            )

        clock[0] = NOW
        disconnected = manager.create_login_session()
        manager.disconnect(disconnected.session_id)
        with pytest.raises(KeyError):
            manager.interact_login_session(
                disconnected.session_id,
                TypeAdapter(
                    getattr(schemas_module, "LoginInteractionRequest")
                ).validate_python({"type": "key", "key": "Tab"}),
            )

        active = manager.create_login_session()
        browser.poll_result = {
            "active": True,
            "display_name": "Douyin",
            "identity_fingerprint": identity_fingerprint_for_raw_sec_uid(
                "MS4wLjABInteractiveLogin"
            ),
        }
        deadline = time.monotonic() + 1
        while time.monotonic() < deadline:
            if manager.get_login_session(active.session_id).state == "active":
                break
            time.sleep(0.01)
        else:
            pytest.fail("background login session did not become active")
        with pytest.raises(
            ValueError,
            match="^douyin_login_session_not_interactive$",
        ):
            manager.interact_login_session(
                active.session_id,
                TypeAdapter(
                    getattr(schemas_module, "LoginInteractionRequest")
                ).validate_python({"type": "key", "key": "Tab"}),
            )
    finally:
        manager.close()
