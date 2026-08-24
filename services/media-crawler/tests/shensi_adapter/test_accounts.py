from datetime import UTC, datetime, timedelta

import pytest

from shensi_adapter.accounts import AccountManager
from shensi_adapter.browser_state import MediaCrawlerDouyinBrowserState


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

    restarted = AccountManager(tmp_path, FakeBrowser(), now=lambda: now, session_ttl=timedelta(minutes=1))
    reloaded = restarted.get_login_session(session.session_id)

    assert active.account_handle is not None
    assert reloaded.state == "active"
    assert reloaded.account_handle == active.account_handle
    assert reloaded.account_display_name == "Douyin"
    assert restarted.sweep_expired(now + timedelta(minutes=2)) == 1
    assert not profile_dirs[0].exists()


def test_browser_startup_error_is_returned_without_leaking_worker_thread():
    before = {thread.ident for thread in __import__("threading").enumerate()}

    with pytest.raises(RuntimeError, match="playwright unavailable"):
        MediaCrawlerDouyinBrowserState(playwright_factory=lambda: (_ for _ in ()).throw(RuntimeError("playwright unavailable")), startup_timeout=0.1)

    after = {thread.ident for thread in __import__("threading").enumerate()}
    assert after == before
