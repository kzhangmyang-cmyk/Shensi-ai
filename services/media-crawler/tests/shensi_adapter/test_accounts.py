import multiprocessing
import os
import subprocess
import sys
import threading
import time
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from shensi_adapter.accounts import AccountManager
from shensi_adapter.browser_state import MediaCrawlerDouyinBrowserState
from shensi_adapter.app import create_app, validate_encrypted_profile_root


class FakeBrowser:
    def __init__(self):
        self.closed = 0

    def open_douyin_login(self, profile_path):
        assert profile_path.exists()
        return {"qr_image_data_url": "data:image/png;base64,cXI="}

    def close(self, _context):
        self.closed += 1

    def poll_douyin_login(self, _context):
        return {"active": True, "display_name": "Douyin"}


class _FakeImage:
    def click(self, **_kwargs):
        return None

    def wait_for(self, **_kwargs):
        return None

    def get_attribute(self, _name):
        return "data:image/png;base64,cXI="


class _FakePage:
    def goto(self, *_args, **_kwargs):
        return None

    def locator(self, _selector):
        return _FakeImage()

    def evaluate(self, expression, *_args):
        if "HasUserLogin" in expression:
            return "1"
        raise AssertionError(expression)


class _FakeContext:
    def __init__(self):
        self.pages = [_FakePage()]

    def close(self):
        return None


class _FakeChromium:
    def launch_persistent_context(self, _profile_path, **_kwargs):
        return _FakeContext()


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


class _BlockingPlaywright:
    chromium = _BlockingChromium()

    def stop(self):
        return None


class _BlockingChildPlaywright:
    chromium = _BlockingChildChromium()

    def stop(self):
        return None


class _ShutdownFailurePlaywright(_FakePlaywright):
    def stop(self):
        raise RuntimeError("playwright stop failed")


def _working_playwright_factory():
    return _FakePlaywright()


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
    assert session.qr_image_data_url == "data:image/png;base64,cXI="
    assert session.account_handle is None
    assert oct((tmp_path / "profiles").stat().st_mode & 0o777) == "0o700"
    assert "cookie" not in session.model_dump_json().lower()

    expired = manager.get_login_session(session.session_id, now + timedelta(minutes=2))

    assert expired.state == "expired"
    assert expired.qr_image_data_url is None
    assert browser.closed == 1


def test_account_manager_reloads_durable_active_metadata_and_removes_expired_profile(tmp_path):
    now = datetime(2026, 8, 24, tzinfo=UTC)
    browser = FakeBrowser()
    manager = AccountManager(tmp_path, browser, now=lambda: now, session_ttl=timedelta(minutes=1))

    session = manager.create_login_session()
    active = manager.get_login_session(session.session_id)
    profile_dirs = list((tmp_path / "profiles").iterdir())
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
    assert not profile_dirs[0].exists()
    restarted.close()


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
        opened = browser.open_douyin_login(tmp_path)
        assert opened["qr_image_data_url"] == "data:image/png;base64,cXI="
        assert set(opened) == {"handle", "qr_image_data_url"}
        assert browser.poll_douyin_login(opened) == {"active": True}
        browser.close(opened)
    finally:
        browser.close_browser()


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
