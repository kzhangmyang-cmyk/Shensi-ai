"""Service-owned, private persistence for Douyin QR browser sessions."""

from __future__ import annotations

import os
import secrets
from datetime import UTC, datetime, timedelta
from pathlib import Path

from .browser_state import BrowserState
from .schemas import LoginSessionView


class AccountManager:
    def __init__(
        self,
        root: Path,
        browser: BrowserState,
        now=lambda: datetime.now(UTC),
        session_ttl: timedelta = timedelta(minutes=5),
    ) -> None:
        self._root = root
        self._profiles = root / "profiles"
        self._profiles.mkdir(mode=0o700, parents=True, exist_ok=True)
        os.chmod(self._profiles, 0o700)
        self._browser = browser
        self._now = now
        self._ttl = session_ttl
        self._sessions: dict[str, dict[str, object]] = {}

    def create_login_session(self) -> LoginSessionView:
        session_id = secrets.token_urlsafe(24)
        profile = self._profiles / secrets.token_urlsafe(24)
        profile.mkdir(mode=0o700)
        os.chmod(profile, 0o700)
        context = self._browser.open_douyin_login(profile)
        now = self._now()
        self._sessions[session_id] = {
            "context": context,
            "expires_at": now + self._ttl,
            "closed": False,
            "account_handle": None,
            "account_display_name": None,
            "login_state_version": None,
        }
        return LoginSessionView(
            session_id=session_id,
            state="awaiting_scan",
            qr_image_data_url=context.get("qr_image_data_url"),
            expires_at=now + self._ttl,
            account_handle=None,
            account_display_name=None,
            login_state_version=None,
        )

    def get_login_session(
        self, session_id: str, now: datetime | None = None
    ) -> LoginSessionView:
        session = self._sessions.get(session_id)
        if session is None:
            raise KeyError(session_id)
        current = now or self._now()
        expired = current >= session["expires_at"]
        if expired and not session["closed"]:
            self._browser.close(session["context"])
            session["closed"] = True
        if not expired and hasattr(self._browser, "poll_douyin_login"):
            result = self._browser.poll_douyin_login(session["context"])
            if result.get("active") is True:
                session["account_handle"] = session["account_handle"] or secrets.token_urlsafe(24)
                session["account_display_name"] = result.get("display_name")
                session["login_state_version"] = 1
        return LoginSessionView(
            session_id=session_id,
            state="expired" if expired else ("active" if session["account_handle"] else "awaiting_scan"),
            qr_image_data_url=None if expired or session["account_handle"] else session["context"].get("qr_image_data_url"),
            expires_at=session["expires_at"],
            account_handle=session["account_handle"],
            account_display_name=session["account_display_name"],
            login_state_version=session["login_state_version"],
        )
