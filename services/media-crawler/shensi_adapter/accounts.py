"""Service-owned, private persistence for Douyin QR browser sessions."""

from __future__ import annotations

import json
import os
import re
import secrets
import shutil
import threading
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import fcntl

from .browser_state import BrowserState
from .douyin_account_identity import (
    account_handle_for_fingerprint,
    is_bound_account_handle,
)
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
        self._identity_ledger = (
            self._root / ".shensi-account-identity-ledger.json"
        )
        self._identity_ledger_lock = (
            self._root / ".shensi-account-identity-ledger.lock"
        )
        self._last_login_state_version = self._load_identity_ledger()
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

    @contextmanager
    def _locked_identity_ledger(self):
        """Serialize ledger read-modify-write across service processes."""
        if (self._identity_ledger_lock.exists()
                and (self._identity_ledger_lock.is_symlink()
                     or not self._identity_ledger_lock.is_file())):
            raise ValueError("invalid identity ledger lock")
        flags = os.O_RDWR | os.O_CREAT
        if hasattr(os, "O_NOFOLLOW"):
            flags |= os.O_NOFOLLOW
        try:
            descriptor = os.open(
                self._identity_ledger_lock,
                flags,
                0o600,
            )
            os.fchmod(descriptor, 0o600)
            fcntl.flock(descriptor, fcntl.LOCK_EX)
        except OSError as error:
            try:
                os.close(descriptor)
            except (OSError, UnboundLocalError):
                pass
            raise ValueError("invalid identity ledger lock") from error
        try:
            yield
        finally:
            try:
                fcntl.flock(descriptor, fcntl.LOCK_UN)
            finally:
                os.close(descriptor)

    def _read_identity_ledger_unlocked(self) -> int:
        if not self._identity_ledger.exists():
            return 0
        if (self._identity_ledger.is_symlink()
                or not self._identity_ledger.is_file()):
            raise ValueError("invalid identity ledger")
        try:
            os.chmod(self._identity_ledger, 0o600)
            value = json.loads(
                self._identity_ledger.read_text(encoding="utf-8")
            )
            last_version = value.get("last_login_state_version")
            if (set(value) != {"version", "last_login_state_version"}
                    or value.get("version") != 1
                    or type(last_version) is not int
                    or last_version < 0):
                raise ValueError("invalid identity ledger")
            return last_version
        except (OSError, TypeError, json.JSONDecodeError) as error:
            raise ValueError("invalid identity ledger") from error

    def _load_identity_ledger(self) -> int:
        with self._locked_identity_ledger():
            return self._read_identity_ledger_unlocked()

    def _persist_identity_ledger(self) -> None:
        with self._locked_identity_ledger():
            last_version = max(
                self._last_login_state_version,
                self._read_identity_ledger_unlocked(),
            )
            self._write_metadata(self._identity_ledger, {
                "version": 1,
                "last_login_state_version": last_version,
            })
            self._last_login_state_version = last_version

    def _next_login_state_version(self) -> int:
        with self._locked_identity_ledger():
            disk_version = self._read_identity_ledger_unlocked()
            version = max(
                self._last_login_state_version,
                disk_version,
            ) + 1
            self._write_metadata(self._identity_ledger, {
                "version": 1,
                "last_login_state_version": version,
            })
            self._last_login_state_version = version
            return version

    @staticmethod
    def _write_metadata(target: Path, value: dict[str, Any]) -> None:
        temporary = target.with_suffix(".tmp")
        if temporary.is_symlink():
            raise ValueError("invalid metadata temporary")
        if target.is_symlink() or (target.exists() and not target.is_file()):
            raise ValueError("invalid metadata target")
        encoded = json.dumps(value, separators=(",", ":")).encode("utf-8")
        file_flags = os.O_CREAT | os.O_TRUNC | os.O_WRONLY
        if hasattr(os, "O_CLOEXEC"):
            file_flags |= os.O_CLOEXEC
        if hasattr(os, "O_NOFOLLOW"):
            file_flags |= os.O_NOFOLLOW
        descriptor = os.open(temporary, file_flags, 0o600)
        try:
            os.fchmod(descriptor, 0o600)
            with os.fdopen(descriptor, "wb", closefd=False) as stream:
                stream.write(encoded)
                stream.flush()
                os.fsync(descriptor)
        finally:
            os.close(descriptor)
        os.replace(temporary, target)
        directory_flags = os.O_RDONLY
        if hasattr(os, "O_CLOEXEC"):
            directory_flags |= os.O_CLOEXEC
        if hasattr(os, "O_DIRECTORY"):
            directory_flags |= os.O_DIRECTORY
        if hasattr(os, "O_NOFOLLOW"):
            directory_flags |= os.O_NOFOLLOW
        parent_descriptor = os.open(target.parent, directory_flags)
        try:
            os.fsync(parent_descriptor)
        finally:
            os.close(parent_descriptor)

    def _persist(self, session: dict[str, Any]) -> None:
        profile = session["profile"]
        value = {"session_id": session["id"], "expires_at": session["expires_at"].isoformat(),
                 "account_handle": session["account_handle"], "account_display_name": session["account_display_name"],
                 "login_state_version": session["login_state_version"], "closed": bool(session["closed"]),
                 "qr_expired": bool(session["qr_expired"]),
                 "identity_failed": bool(session["identity_failed"])}
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
        self._index_account_session(session)

    def _index_account_session(self, session: dict[str, Any]) -> None:
        account_handle = session.get("account_handle")
        if not account_handle:
            return
        current = self._accounts.get(account_handle)
        if (current is None
                or session["login_state_version"]
                > current["login_state_version"]):
            self._accounts[account_handle] = session

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
                            or not is_bound_account_handle(
                                account["account_handle"]
                            )
                            or not isinstance(
                                account.get("account_display_name"), str
                            )
                            or not account["account_display_name"].strip()
                            or type(account.get("login_state_version")) is not int
                            or account["login_state_version"] < 1):
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
                    "identity_failed": bool(value.get("identity_failed", False)),
                    "profile": profile}
                session = self._sessions[session_id]
                if session["account_handle"]:
                    self._last_login_state_version = max(
                        self._last_login_state_version,
                        session["login_state_version"],
                    )
                    if account is None:
                        self._persist_account(session)
                    self._index_account_session(session)
            except (OSError, ValueError, TypeError, KeyError, json.JSONDecodeError):
                self._delete_profile(profile)
        if self._last_login_state_version:
            self._persist_identity_ledger()

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
            if (session.get("account_handle")
                    and self._accounts.get(session["account_handle"])
                    is session):
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
                "login_state_version": None, "qr_expired": False,
                "identity_failed": False, "profile": profile}
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
            if session["identity_failed"]:
                return LoginSessionView(
                    session_id=session_id, state="failed",
                    qr_image_data_url=None,
                    expires_at=session["expires_at"],
                    account_handle=None, account_display_name=None,
                    login_state_version=None,
                )
            if session["context"] is not None and not session["closed"]:
                try:
                    result = self._browser.poll_douyin_login(session["context"])
                except Exception:
                    self._remove_session(session_id, session)
                    raise
                if result.get("identity_error"):
                    self._close_session(session)
                    session["identity_failed"] = True
                    self._persist_or_remove(session_id, session)
                elif result.get("active") is True:
                    fingerprint = result.get("identity_fingerprint")
                    display_name = result.get("display_name")
                    if (not isinstance(fingerprint, str)
                            or re.fullmatch(r"[0-9a-f]{64}", fingerprint)
                            is None
                            or not isinstance(display_name, str)
                            or not display_name.strip()
                            or len(display_name.strip()) > 100):
                        self._close_session(session)
                        session["identity_failed"] = True
                    else:
                        account_handle = account_handle_for_fingerprint(
                            fingerprint
                        )
                        login_state_version = (
                            self._next_login_state_version()
                        )
                        session["account_handle"] = account_handle
                        session["account_display_name"] = (
                            display_name.strip()
                        )
                        session["login_state_version"] = login_state_version
                        self._close_session(session)
                    self._persist_or_remove(session_id, session)
            state = ("active" if session["account_handle"]
                     else "failed" if session["identity_failed"]
                     else "awaiting_scan")
            return LoginSessionView(session_id=session_id, state=state,
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

    def _require_current_action_authority(
        self,
        profile: Path,
        account_handle: str,
        login_state_version: int,
    ) -> None:
        """Re-read active account and login-version authority without I/O."""
        with self._lock:
            session = self._accounts.get(account_handle)
            if (session is None
                    or session.get("login_state_version")
                    != login_state_version
                    or session.get("profile") != profile):
                raise DouyinActionFailure(
                    "douyin_account_identity_changed"
                )

    def execute_action(self, profile: Path, request: object) -> object:
        # All AccountManager→BrowserState calls use this lock order. Keeping
        # the authority lease across the irreversible browser action also
        # prevents disconnect/reconnect from superseding the final checkpoint.
        with self._lock:
            self._require_current_action_authority(
                profile,
                request.account_handle,
                request.login_state_version,
            )
            execute = getattr(self._browser, "execute_douyin_action", None)
            if execute is None:
                raise DouyinActionFailure("action_unavailable")
            return execute(
                profile,
                request,
                authority_validator=lambda: (
                    self._require_current_action_authority(
                        profile,
                        request.account_handle,
                        request.login_state_version,
                    )
                ),
            )

    def reconcile_action(self, profile: Path, request: object) -> object:
        with self._lock:
            self._require_current_action_authority(
                profile,
                request.account_handle,
                request.login_state_version,
            )
            reconcile = getattr(self._browser, "reconcile_douyin_action", None)
            if reconcile is None:
                raise DouyinActionFailure("action_unavailable")
            return reconcile(
                profile,
                request,
                authority_validator=lambda: (
                    self._require_current_action_authority(
                        profile,
                        request.account_handle,
                        request.login_state_version,
                    )
                ),
            )

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
