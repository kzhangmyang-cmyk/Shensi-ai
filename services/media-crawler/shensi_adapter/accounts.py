"""Service-owned, private persistence for Douyin QR browser sessions."""

from __future__ import annotations

import os
import secrets
import shutil
import threading
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
        volume = os.environ.get("MEDIACRAWLER_ENCRYPTED_VOLUME")
        if volume and not root.resolve().is_relative_to(Path(volume).resolve()):
            raise ValueError("profile root must be inside MEDIACRAWLER_ENCRYPTED_VOLUME")
        self._root = root
        self._root.mkdir(mode=0o700, parents=True, exist_ok=True)
        os.chmod(self._root, 0o700)
        self._profiles = root / "profiles"
        self._profiles.mkdir(mode=0o700, parents=True, exist_ok=True)
        os.chmod(self._profiles, 0o700)
        self._browser = browser
        self._now = now
        self._ttl = session_ttl
        self._sessions: dict[str, dict[str, object]] = {}
        self._lock = threading.RLock()

    def sweep_expired(self, now: datetime | None = None) -> int:
        current = now or self._now()
        removed = 0
        with self._lock:
            for session_id in list(self._sessions):
                session = self._sessions[session_id]
                if current >= session["expires_at"]:
                    if not session["closed"]:
                        self._browser.close(session["context"])
                    shutil.rmtree(session["profile"], ignore_errors=True)
                    del self._sessions[session_id]
                    removed += 1
        return removed

    def create_login_session(self) -> LoginSessionView:
        self.sweep_expired()
        session_id = secrets.token_urlsafe(24)
        profile = self._profiles / secrets.token_urlsafe(24)
        profile.mkdir(mode=0o700)
        os.chmod(profile, 0o700)
        context = self._browser.open_douyin_login(profile)
        now = self._now()
        with self._lock:
            self._sessions[session_id] = {
            "context": context,
            "expires_at": now + self._ttl,
            "closed": False,
            "account_handle": None,
            "account_display_name": None,
            "login_state_version": None,
            "profile": profile,
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
        with self._lock:
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

    def disconnect(self, session_id: str) -> None:
        with self._lock:
            session = self._sessions.pop(session_id, None)
            if session is None:
                raise KeyError(session_id)
            if not session["closed"]:
                self._browser.close(session["context"])
            shutil.rmtree(session["profile"], ignore_errors=True)
