"""Service-owned, private persistence for Douyin QR browser sessions."""

from __future__ import annotations

import json
import os
import secrets
import shutil
import threading
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

from .browser_state import BrowserState
from .douyin_actions import DouyinActionFailure
from .schemas import LoginSessionView


class AccountManager:
    """Owns private profile state and its bounded lifecycle."""

    def __init__(self, root: Path, browser: BrowserState, now=lambda: datetime.now(UTC),
                 session_ttl: timedelta = timedelta(minutes=5),
                 sweep_interval: timedelta = timedelta(seconds=30)) -> None:
        volume = os.environ.get("MEDIACRAWLER_ENCRYPTED_VOLUME")
        if volume and not root.resolve().is_relative_to(Path(volume).resolve()):
            raise ValueError("profile root must be inside MEDIACRAWLER_ENCRYPTED_VOLUME")
        self._root = root.resolve()
        self._root.mkdir(mode=0o700, parents=True, exist_ok=True)
        os.chmod(self._root, 0o700)
        self._profiles = self._root / "profiles"
        self._profiles.mkdir(mode=0o700, parents=True, exist_ok=True)
        os.chmod(self._profiles, 0o700)
        self._browser, self._now, self._ttl = browser, now, session_ttl
        self._sessions: dict[str, dict[str, Any]] = {}
        self._accounts: dict[str, dict[str, Any]] = {}
        self._lock = threading.RLock()
        self._closed = threading.Event()
        self._reload_metadata()
        self._sweeper = threading.Thread(target=self._sweep_loop,
            args=(max(sweep_interval.total_seconds(), 0.01),), name="douyin-account-sweeper", daemon=True)
        self._sweeper.start()

    @staticmethod
    def _as_datetime(value: str) -> datetime:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))

    @staticmethod
    def _metadata_path(profile: Path) -> Path:
        return profile / ".shensi-login-session.json"

    @staticmethod
    def _account_metadata_path(profile: Path) -> Path:
        return profile / ".shensi-connected-account.json"

    @staticmethod
    def _write_metadata(target: Path, value: dict[str, Any]) -> None:
        temporary = target.with_suffix(".tmp")
        temporary.write_text(json.dumps(value, separators=(",", ":")), encoding="utf-8")
        os.chmod(temporary, 0o600)
        os.replace(temporary, target)
        os.chmod(target, 0o600)

    def _persist(self, session: dict[str, Any]) -> None:
        profile = session["profile"]
        value = {"session_id": session["id"], "expires_at": session["expires_at"].isoformat(),
                 "account_handle": session["account_handle"], "account_display_name": session["account_display_name"],
                 "login_state_version": session["login_state_version"], "closed": bool(session["closed"]),
                 "qr_expired": bool(session["qr_expired"])}
        target = self._metadata_path(profile)
        self._write_metadata(target, value)

    def _persist_account(self, session: dict[str, Any]) -> None:
        if not session["account_handle"]:
            return
        self._write_metadata(self._account_metadata_path(session["profile"]), {
            "session_id": session["id"],
            "account_handle": session["account_handle"],
            "account_display_name": session["account_display_name"],
            "login_state_version": session["login_state_version"],
        })
        self._accounts[session["account_handle"]] = session

    def _reload_metadata(self) -> None:
        for profile in self._profiles.iterdir():
            if not profile.is_dir() or profile.is_symlink():
                continue
            try:
                os.chmod(profile, 0o700)
                metadata = self._metadata_path(profile)
                account_metadata = self._account_metadata_path(profile)
                account: dict[str, Any] | None = None
                if account_metadata.exists():
                    if account_metadata.is_symlink() or not account_metadata.is_file():
                        raise ValueError("invalid account metadata")
                    os.chmod(account_metadata, 0o600)
                    account = json.loads(account_metadata.read_text(encoding="utf-8"))
                    if (not isinstance(account.get("session_id"), str)
                            or not isinstance(account.get("account_handle"), str)
                            or not account["account_handle"]
                            or not isinstance(account.get("login_state_version"), int)):
                        raise ValueError("invalid account metadata")

                value: dict[str, Any] = {}
                if metadata.exists():
                    try:
                        if metadata.is_symlink() or not metadata.is_file():
                            raise ValueError("invalid metadata")
                        os.chmod(metadata, 0o600)
                        loaded = json.loads(metadata.read_text(encoding="utf-8"))
                        if not isinstance(loaded, dict):
                            raise ValueError("invalid metadata")
                        value = loaded
                    except (OSError, ValueError, TypeError, json.JSONDecodeError):
                        if account is None:
                            raise
                elif account is None:
                    raise ValueError("missing metadata")

                if account is not None:
                    session_id = account["session_id"]
                    expires_at = self._now()
                    try:
                        if value.get("session_id") == session_id:
                            expires_at = self._as_datetime(value["expires_at"])
                    except (TypeError, KeyError, ValueError):
                        pass
                    account_handle = account["account_handle"]
                    account_display_name = account.get("account_display_name")
                    login_state_version = account["login_state_version"]
                else:
                    session_id = value["session_id"]
                    expires_at = self._as_datetime(value["expires_at"])
                    account_handle = value.get("account_handle")
                    account_display_name = value.get("account_display_name")
                    login_state_version = value.get("login_state_version")
                if not isinstance(session_id, str) or not session_id:
                    raise ValueError("invalid session")
                self._sessions[session_id] = {"id": session_id, "context": None, "expires_at": expires_at,
                    "closed": True, "account_handle": account_handle,
                    "account_display_name": account_display_name, "login_state_version": login_state_version,
                    "qr_expired": bool(value.get("qr_expired", False)) if value else account is not None,
                    "profile": profile}
                session = self._sessions[session_id]
                if session["account_handle"]:
                    if account is None:
                        self._persist_account(session)
                    self._accounts[session["account_handle"]] = session
            except (OSError, ValueError, TypeError, KeyError, json.JSONDecodeError):
                self._delete_profile(profile)

    @staticmethod
    def _delete_profile(profile: Path) -> None:
        if profile.is_symlink() or not profile.is_dir():
            try:
                profile.unlink(missing_ok=True)
            except OSError:
                pass
            return
        shutil.rmtree(profile, ignore_errors=True)

    def _close_session(self, session: dict[str, Any]) -> None:
        if not session["closed"] and session["context"] is not None:
            self._browser.close(session["context"])
        session["context"] = None
        session["closed"] = True

    def _remove_session(self, session_id: str, session: dict[str, Any]) -> None:
        try:
            self._close_session(session)
        finally:
            if session.get("account_handle"):
                self._accounts.pop(session["account_handle"], None)
            self._delete_profile(session["profile"])
            self._sessions.pop(session_id, None)

    def _persist_or_remove(
        self, session_id: str, session: dict[str, Any]
    ) -> None:
        try:
            self._persist_account(session)
            self._persist(session)
        except BaseException as persistence_error:
            try:
                self._remove_session(session_id, session)
            except BaseException as cleanup_error:
                raise BaseExceptionGroup(
                    "douyin_session_persistence_cleanup_failed",
                    [persistence_error, cleanup_error],
                )
            raise

    def _sweep_loop(self, interval: float) -> None:
        while not self._closed.wait(interval):
            try:
                self.sweep_expired()
            except Exception:
                continue

    def sweep_expired(self, now: datetime | None = None) -> int:
        current = now or self._now()
        with self._lock:
            expired = [session_id for session_id, session in self._sessions.items()
                       if current >= session["expires_at"] and not session["qr_expired"]]
            for session_id in expired:
                try:
                    session = self._sessions[session_id]
                    if session["account_handle"]:
                        self._close_session(session)
                        session["qr_expired"] = True
                        self._persist_or_remove(session_id, session)
                    else:
                        self._remove_session(session_id, session)
                except Exception:
                    continue
            return len(expired)

    def create_login_session(self) -> LoginSessionView:
        with self._lock:
            self.sweep_expired()
            session_id = secrets.token_urlsafe(24)
            profile = self._profiles / secrets.token_urlsafe(24)
            profile.mkdir(mode=0o700)
            os.chmod(profile, 0o700)
            try:
                context = self._browser.open_douyin_login(profile)
            except Exception:
                shutil.rmtree(profile, ignore_errors=True)
                raise
            now = self._now()
            session: dict[str, Any] = {"id": session_id, "context": context, "expires_at": now + self._ttl,
                "closed": False, "account_handle": None, "account_display_name": None,
                "login_state_version": None, "qr_expired": False, "profile": profile}
            self._sessions[session_id] = session
            self._persist_or_remove(session_id, session)
            return LoginSessionView(session_id=session_id, state="awaiting_scan", qr_image_data_url=context.get("qr_image_data_url"),
                expires_at=session["expires_at"], account_handle=None, account_display_name=None, login_state_version=None)

    def get_login_session(self, session_id: str, now: datetime | None = None) -> LoginSessionView:
        with self._lock:
            session = self._sessions.get(session_id)
            if session is None:
                raise KeyError(session_id)
            current = now or self._now()
            if current >= session["expires_at"]:
                if session["account_handle"]:
                    if not session["qr_expired"]:
                        self._close_session(session)
                        session["qr_expired"] = True
                        self._persist_or_remove(session_id, session)
                    return LoginSessionView(
                        session_id=session_id, state="active", qr_image_data_url=None,
                        expires_at=session["expires_at"], account_handle=session["account_handle"],
                        account_display_name=session["account_display_name"],
                        login_state_version=session["login_state_version"],
                    )
                self._remove_session(session_id, session)
                return LoginSessionView(session_id=session_id, state="expired", qr_image_data_url=None, expires_at=session["expires_at"],
                    account_handle=None, account_display_name=None, login_state_version=None)
            if session["context"] is not None and not session["closed"]:
                try:
                    result = self._browser.poll_douyin_login(session["context"])
                except Exception:
                    self._remove_session(session_id, session)
                    raise
                if result.get("active") is True:
                    session["account_handle"] = session["account_handle"] or secrets.token_urlsafe(24)
                    session["account_display_name"] = result.get("display_name")
                    session["login_state_version"] = 1
                    self._persist_or_remove(session_id, session)
            return LoginSessionView(session_id=session_id, state="active" if session["account_handle"] else "awaiting_scan",
                qr_image_data_url=None if session["account_handle"] else session["context"].get("qr_image_data_url") if session["context"] else None,
                expires_at=session["expires_at"], account_handle=session["account_handle"],
                account_display_name=session["account_display_name"], login_state_version=session["login_state_version"])

    def disconnect(self, session_id: str) -> None:
        with self._lock:
            session = self._sessions.get(session_id)
            if session is None:
                raise KeyError(session_id)
            self._remove_session(session_id, session)

    def resolve_crawl_profile(self, account_handle: str, login_state_version: int) -> Path:
        """Resolve private crawl authority without exposing it through HTTP."""
        with self._lock:
            self.sweep_expired()
            session = self._accounts.get(account_handle)
            if (session is None or session["login_state_version"] != login_state_version
                    or not account_handle):
                raise KeyError("active_account_not_found")
            self._close_session(session)
            self._persist_or_remove(session["id"], session)
            return session["profile"]

    def resolve_action_profile(self, account_handle: str,
                               login_state_version: int) -> Path:
        """Resolve the same durable authenticated profile for one action."""
        return self.resolve_crawl_profile(account_handle, login_state_version)

    def execute_action(self, profile: Path, request: object) -> object:
        execute = getattr(self._browser, "execute_douyin_action", None)
        if execute is None:
            raise DouyinActionFailure("action_unavailable")
        return execute(profile, request)

    def reconcile_action(self, profile: Path, request: object) -> object:
        reconcile = getattr(self._browser, "reconcile_douyin_action", None)
        if reconcile is None:
            raise DouyinActionFailure("action_unavailable")
        return reconcile(profile, request)

    def close(self) -> None:
        if self._closed.is_set():
            return
        self._closed.set()
        failures: list[BaseException] = []
        try:
            self._sweeper.join(timeout=2)
        except BaseException as error:
            failures.append(error)
        try:
            if self._sweeper.is_alive():
                failures.append(RuntimeError("account_sweeper_shutdown_timeout"))
        except BaseException as error:
            failures.append(error)

        acquired = False
        try:
            acquired = self._lock.acquire(timeout=2)
            if not acquired:
                failures.append(RuntimeError("account_manager_shutdown_lock_timeout"))
            else:
                try:
                    self.sweep_expired()
                except BaseException as error:
                    failures.append(error)
                for session in list(self._sessions.values()):
                    try:
                        self._close_session(session)
                    except BaseException as error:
                        failures.append(error)
                        session["context"] = None
                        session["closed"] = True
                    try:
                        self._persist_account(session)
                        self._persist(session)
                    except BaseException as error:
                        failures.append(error)
        except BaseException as error:
            failures.append(error)
        finally:
            if acquired:
                self._lock.release()

        close_browser = getattr(self._browser, "close_browser", None)
        if close_browser is not None:
            try:
                close_browser()
            except BaseException as error:
                failures.append(error)
        if len(failures) == 1:
            raise failures[0]
        if failures:
            raise BaseExceptionGroup("douyin_account_manager_shutdown_failed", failures)
