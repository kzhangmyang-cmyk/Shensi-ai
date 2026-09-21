from __future__ import annotations

import threading
import time
from pathlib import Path
from types import SimpleNamespace

import pytest

import shensi_adapter.browser_state as browser_state_module
import shensi_adapter.app as app_module
from shensi_adapter.accounts import AccountManager
from shensi_adapter.browser_state import MediaCrawlerDouyinBrowserState
from shensi_adapter.douyin_account_identity import (
    DouyinAccountIdentityFailure,
    identity_fingerprint_for_raw_sec_uid,
)


class _ExternalPage:
    url = "https://www.douyin.com/"

    def is_closed(self):
        return False

    def evaluate(self, _script):
        return None

    def screenshot(self, **_options):
        raise AssertionError("desktop auth polling must not capture a screenshot")


class _ExternalContext:
    pages = [_ExternalPage()]


def test_external_browser_state_disables_live_display_by_configuration(
    monkeypatch,
):
    monkeypatch.setattr(
        MediaCrawlerDouyinBrowserState,
        "_start_worker",
        lambda self: None,
    )

    state = MediaCrawlerDouyinBrowserState(
        headless=False,
        interaction_surface="external_window",
    )

    assert state._headless is False
    assert state._live_display_factory is None
    assert state.interaction_surface == "external_window"


def test_external_login_poll_does_not_depend_on_qr_or_page_capture():
    result = browser_state_module._poll_external_login_context(
        _ExternalContext()
    )

    assert result == {
        "active": False,
        "qr_status": "opening",
        "qr_image_data_url": None,
        "login_page": None,
    }


def test_external_identity_selector_failure_is_recoverable(monkeypatch):
    context = _ExternalContext()
    context.pages[0].evaluate = lambda _script: "1"
    monkeypatch.setattr(
        browser_state_module,
        "_extract_bound_identity_with_retry",
        lambda _page: (_ for _ in ()).throw(
            DouyinAccountIdentityFailure(
                "douyin_account_identity_missing"
            )
        ),
    )

    with pytest.raises(
        RuntimeError,
        match="douyin_account_identity_detection_unavailable",
    ):
        browser_state_module._poll_external_login_context(context)


class _AccountBrowser:
    interaction_surface = "external_window"

    def __init__(self):
        self.opened: list[Path] = []

    def open_douyin_login(self, profile_path: Path):
        self.opened.append(profile_path)
        return {
            "handle": "local-session",
            "qr_status": "opening",
            "qr_image_data_url": None,
            "login_page": None,
        }

    def poll_douyin_login(self, _context):
        return {"active": False, "qr_status": "opening"}

    def close(self, _context):
        return None

    def close_browser(self):
        return None


def test_account_manager_exposes_external_surface_and_stable_profile(tmp_path):
    browser = _AccountBrowser()
    manager = AccountManager(
        tmp_path / "state",
        browser,
        profiles_root=tmp_path / "profiles" / "douyin",
        interaction_surface="external_window",
    )
    try:
        first = manager.create_login_session("a" * 64)
        second = manager.create_login_session("a" * 64)
        manager._login_bootstraps[first.session_id].join(timeout=1)
        observed = manager.get_login_session(first.session_id)

        assert second.session_id == first.session_id
        assert observed.interaction_surface == "external_window"
        assert observed.runtime_state == "running"
        assert observed.auth_state == "waiting_for_user"
        assert observed.task_state == "idle"
        assert observed.screenshot_available is False
        assert observed.qr_available is False
        assert browser.opened[0].parent == tmp_path / "profiles" / "douyin"
        with pytest.raises(
            ValueError,
            match="douyin_live_login_unavailable",
        ):
            manager.create_live_login_session(first.session_id)
    finally:
        manager.close()


def test_failed_external_login_can_be_retried_with_a_new_session(tmp_path):
    class _FailedSessionBrowser(_AccountBrowser):
        def get_status(self, _session_id):
            return SimpleNamespace(
                runtime_state="crashed",
                auth_state="unknown",
                task_state="failed",
                diagnostic=None,
            )

    browser = _FailedSessionBrowser()
    manager = AccountManager(
        tmp_path / "state",
        browser,
        profiles_root=tmp_path / "profiles" / "douyin",
        interaction_surface="external_window",
    )
    try:
        first = manager.create_login_session("f" * 64)
        manager._login_bootstraps[first.session_id].join(timeout=1)
        failed = manager.get_login_session(first.session_id)

        retried = manager.create_login_session("f" * 64)
        assert retried.session_id != first.session_id
        manager._login_bootstraps[retried.session_id].join(timeout=1)

        assert failed.runtime_state == "crashed"
        assert failed.task_state == "failed"
        assert len(browser.opened) == 2
    finally:
        manager.close()


def test_external_disconnect_cleanup_never_deletes_reused_stable_profile(
    tmp_path,
):
    class _BlockingCloseBrowser(_AccountBrowser):
        def __init__(self):
            super().__init__()
            self.close_started = threading.Event()
            self.release_close = threading.Event()

        def close(self, _context):
            self.close_started.set()
            assert self.release_close.wait(timeout=2)

    browser = _BlockingCloseBrowser()
    manager = AccountManager(
        tmp_path / "state",
        browser,
        profiles_root=tmp_path / "profiles" / "douyin",
        interaction_surface="external_window",
    )
    account_key = "b" * 64
    try:
        first = manager.create_login_session(account_key)
        manager._login_bootstraps[first.session_id].join(timeout=1)
        first_profile = manager._sessions[first.session_id]["profile"]

        manager.disconnect(first.session_id)
        assert browser.close_started.wait(timeout=1)
        second = manager.create_login_session(account_key)
        manager._login_bootstraps[second.session_id].join(timeout=1)
        second_profile = manager._sessions[second.session_id]["profile"]

        assert second.session_id != first.session_id
        assert second_profile == first_profile
        assert second_profile.is_dir()

        browser.release_close.set()
        deadline = time.monotonic() + 1
        while manager._detached_cleanup_threads and time.monotonic() < deadline:
            time.sleep(0.01)

        assert second.session_id in manager._sessions
        assert second_profile.is_dir()
    finally:
        browser.release_close.set()
        manager.close()


def test_external_expired_view_keeps_desktop_runtime_contract(tmp_path):
    browser = _AccountBrowser()
    manager = AccountManager(
        tmp_path / "state",
        browser,
        profiles_root=tmp_path / "profiles" / "douyin",
        interaction_surface="external_window",
    )
    try:
        created = manager.create_login_session("c" * 64)
        manager._login_bootstraps[created.session_id].join(timeout=1)
        session = manager._sessions[created.session_id]
        session["expires_at"] = manager._now()

        expired = manager.get_login_session(created.session_id)

        assert expired.state == "expired"
        assert expired.interaction_surface == "external_window"
        assert expired.runtime_state == "stopped"
        assert expired.auth_state == "expired"
        assert expired.task_state == "completed"
        assert expired.screenshot_available is False
        assert expired.qr_available is False
    finally:
        manager.close()


def test_external_action_for_one_account_does_not_block_another_login(
    tmp_path,
):
    class _IndependentAccountBrowser(_AccountBrowser):
        def __init__(self):
            super().__init__()
            self.action_started = threading.Event()
            self.release_action = threading.Event()

        def open_douyin_login(self, profile_path: Path):
            opened = super().open_douyin_login(profile_path)
            opened["profile_name"] = profile_path.name
            return opened

        def poll_douyin_login(self, context):
            return {
                "active": True,
                "display_name": context["profile_name"],
                "identity_fingerprint": identity_fingerprint_for_raw_sec_uid(
                    context["profile_name"]
                ),
            }

        def execute_douyin_action(
            self, _profile, _request, *, authority_validator,
        ):
            authority_validator()
            self.action_started.set()
            assert self.release_action.wait(timeout=2)
            authority_validator()
            return {"state": "succeeded"}

    browser = _IndependentAccountBrowser()
    manager = AccountManager(
        tmp_path / "state",
        browser,
        profiles_root=tmp_path / "profiles" / "douyin",
        interaction_surface="external_window",
    )
    action_errors: list[BaseException] = []
    second_result = []
    try:
        first_session = manager.create_login_session("d" * 64)
        deadline = time.monotonic() + 1
        while time.monotonic() < deadline:
            first = manager.get_login_session(first_session.session_id)
            if first.state == "active":
                break
            time.sleep(0.01)
        else:
            pytest.fail("first desktop account did not become active")
        profile = manager.resolve_action_profile(
            first.account_handle,
            first.login_state_version,
        )

        def run_action():
            try:
                manager.execute_action(
                    profile,
                    SimpleNamespace(
                        account_handle=first.account_handle,
                        login_state_version=first.login_state_version,
                    ),
                )
            except BaseException as error:
                action_errors.append(error)

        action_thread = threading.Thread(target=run_action)
        action_thread.start()
        assert browser.action_started.wait(timeout=1)

        def start_second_login():
            second_result.append(manager.create_login_session("e" * 64))

        second_thread = threading.Thread(target=start_second_login)
        second_thread.start()
        second_thread.join(timeout=0.3)

        assert not second_thread.is_alive()
        assert len(second_result) == 1
    finally:
        browser.release_action.set()
        if "action_thread" in locals():
            action_thread.join(timeout=2)
        if "second_thread" in locals():
            second_thread.join(timeout=2)
        manager.close()
    assert action_errors == []


def test_deployment_desktop_mode_wires_session_scoped_visible_workers(
    tmp_path,
    monkeypatch,
):
    app_data = tmp_path / "application-support" / "Shensi"
    monkeypatch.setenv("SHENSI_RUNTIME_MODE", "desktop")
    monkeypatch.setenv("MEDIACRAWLER_BROWSER_DISPLAY", "operator")
    monkeypatch.setenv("SHENSI_USER_DATA_DIR", str(app_data))
    monkeypatch.delenv("MEDIACRAWLER_ENCRYPTED_VOLUME", raising=False)
    monkeypatch.delenv("MEDIACRAWLER_PROFILE_ROOT", raising=False)
    browser_options: list[dict[str, object]] = []
    manager_options: dict[str, object] = {}

    class _Browser:
        interaction_surface = "external_window"

        def close_browser(self):
            return None

    class _LocalManager(_Browser):
        def __init__(self, profile_root, *, lease_root, browser_factory):
            manager_options["profile_root"] = profile_root
            manager_options["lease_root"] = lease_root
            manager_options["browser_factory"] = browser_factory

    def _browser_factory(**options):
        browser_options.append(options)
        return _Browser()

    monkeypatch.setattr(
        app_module,
        "LocalBrowserSessionManager",
        _LocalManager,
        raising=False,
    )
    monkeypatch.setattr(
        app_module,
        "MediaCrawlerDouyinBrowserState",
        _browser_factory,
    )

    manager = app_module.create_deployment_account_manager()
    try:
        assert manager._interaction_surface == "external_window"
        assert manager._profiles == app_data / "profiles" / "douyin"
        assert manager_options["profile_root"] == manager._profiles
        assert manager_options["lease_root"] == app_data / "state" / "douyin"
        worker = manager_options["browser_factory"]()
        assert isinstance(worker, _Browser)
        assert browser_options == [{
            "headless": False,
            "browser_channel": "chrome",
            "interaction_surface": "external_window",
        }]
    finally:
        manager.close()
