from datetime import UTC, datetime, timedelta

import pytest

from shensi_adapter.accounts import AccountManager


class FakeBrowser:
    def __init__(self):
        self.closed = 0

    def open_douyin_login(self, profile_path):
        assert profile_path.exists()
        return {"qr_image_data_url": "data:image/png;base64,cXI="}

    def close(self, _context):
        self.closed += 1


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
