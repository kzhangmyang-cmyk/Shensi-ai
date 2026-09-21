"""Service-owned, private persistence for Douyin QR browser sessions."""

from __future__ import annotations

import json
import hashlib
import logging
import os
import re
import secrets
import shutil
import threading
import time
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
from .schemas import (
    LiveLoginSessionView,
    LoginInteractionRequest,
    LoginPageView,
    LoginSessionView,
)


LOGGER = logging.getLogger(__name__)
_LOGIN_BOOTSTRAP_FAILURE_CODES = frozenset({
    "douyin_login_ui_unsupported",
    "douyin_verification_required",
    "douyin_login_page_unavailable",
    "douyin_login_page_not_allowed",
    "douyin_browser_unavailable",
    "douyin_browser_command_timeout",
})
_LOGIN_BOOTSTRAP_LOG_STAGES = frozenset({
    "open_failed",
    "live_display_start",
    "browser_context_open",
    "browser_launch",
    "browser_page_open",
    "douyin_navigation",
    "login_page_capture",
    "open_result_invalid",
})
_LOGIN_BOOTSTRAP_ERROR_CODES = _LOGIN_BOOTSTRAP_FAILURE_CODES | frozenset({
    "douyin_live_display_unavailable",
    "douyin_live_vnc_unavailable",
    "douyin_login_open_failed",
})


class AccountManager:
    """Owns private profile state and its bounded lifecycle."""

    def __init__(self, root: Path, browser: BrowserState, now=lambda: datetime.now(UTC),
                 session_ttl: timedelta = timedelta(minutes=5),
                 live_session_ttl: timedelta = timedelta(minutes=2),
                 sweep_interval: timedelta = timedelta(seconds=30),
                 profiles_root: Path | None = None,
                 interaction_surface: str | None = None) -> None:
        resolved_surface = interaction_surface or getattr(
            browser,
            "interaction_surface",
            "remote_canvas",
        )
        if resolved_surface not in {"external_window", "remote_canvas"}:
            raise ValueError("invalid browser interaction surface")
        volume = os.environ.get("MEDIACRAWLER_ENCRYPTED_VOLUME")
        if (volume and resolved_surface == "remote_canvas"
                and not root.resolve().is_relative_to(Path(volume).resolve())):
            raise ValueError("profile root must be inside MEDIACRAWLER_ENCRYPTED_VOLUME")
        self._root = root.resolve()
        self._root.mkdir(mode=0o700, parents=True, exist_ok=True)
        os.chmod(self._root, 0o700)
        self._profiles = (
            profiles_root.resolve()
            if profiles_root is not None
            else self._root / "profiles"
        )
        if (volume and resolved_surface == "remote_canvas"
                and not self._profiles.is_relative_to(Path(volume).resolve())):
            raise ValueError(
                "profile root must be inside MEDIACRAWLER_ENCRYPTED_VOLUME"
            )
        self._profiles.mkdir(mode=0o700, parents=True, exist_ok=True)
        os.chmod(self._profiles, 0o700)
        if live_session_ttl <= timedelta(0):
            raise ValueError("live session ttl must be positive")
        self._browser, self._now, self._ttl = browser, now, session_ttl
        self._interaction_surface = resolved_surface
        self._live_session_ttl = live_session_ttl
        self._sessions: dict[str, dict[str, Any]] = {}
        self._live_tokens: dict[str, dict[str, Any]] = {}
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
        self._login_bootstraps: dict[str, threading.Thread] = {}
        self._login_bootstrap_profiles: dict[str, str | None] = {}
        self._detached_cleanup_threads: set[threading.Thread] = set()
        self._detached_cleanup_failures: list[BaseException] = []
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
        if session.get("profile_removed"):
            return
        profile = session["profile"]
        value = {"session_id": session["id"], "expires_at": session["expires_at"].isoformat(),
                 "account_handle": session["account_handle"], "account_display_name": session["account_display_name"],
                 "login_state_version": session["login_state_version"], "closed": bool(session["closed"]),
                 "qr_expired": bool(session["qr_expired"]),
                 "identity_failed": bool(session["identity_failed"])}
        target = self._metadata_path(profile)
        self._write_metadata(target, value)

    def _persist_account(self, session: dict[str, Any]) -> None:
        if not session["account_handle"] or session.get("profile_removed"):
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
                if (self._interaction_surface == "external_window"
                        and not account_metadata.exists()):
                    raise ValueError("missing account metadata")
                if account_metadata.exists():
                    if account_metadata.is_symlink() or not account_metadata.is_file():
                        raise ValueError("invalid account metadata")
                    os.chmod(account_metadata, 0o600)
                    account = json.loads(account_metadata.read_text(encoding="utf-8"))
                    if (not isinstance(account, dict)
                            or not isinstance(account.get("session_id"), str)
                            or not isinstance(account.get("account_handle"), str)
                            or not is_bound_account_handle(
                                account["account_handle"]
                            )
                            or not isinstance(
                                account.get("account_display_name"), str
                            )
                            or not account["account_display_name"].strip()
                            or type(account.get("login_state_version")) is not int
                            or not 1 <= account["login_state_version"] <= 9007199254740991):
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
                if not account_handle:
                    self._delete_profile(profile)
                    continue
                self._sessions[session_id] = {"id": session_id, "context": None, "login_page": None, "qr_status": None, "qr_image_data_url": None, "expires_at": expires_at,
                    "closed": True, "account_handle": account_handle,
                    "account_display_name": account_display_name, "login_state_version": login_state_version,
                    "qr_expired": bool(value.get("qr_expired", False)) if value else account is not None,
                    "identity_failed": bool(value.get("identity_failed", False)),
                    "failure_code": None,
                    "profile": profile, "profile_removed": False,
                    "profile_key": profile.name,
                    "diagnostic": None,
                    "bootstrap_pending": False,
                    "bootstrap_cleanup_pending": False,
                    "io_lock": threading.Lock(),
                    "context_generation": 0,
                    "context_closed": True, "closing": False}
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

    def _delete_profile(self, profile: Path) -> None:
        # Desktop profiles are durable application data.  Cancelling or
        # expiring one login session must never remove the same stable profile
        # that a newer session or a collection task can already be using.
        # Remote-canvas sessions retain their existing ephemeral cleanup.
        if self._interaction_surface == "external_window":
            return
        if profile.is_symlink() or not profile.is_dir():
            try:
                profile.unlink(missing_ok=True)
            except OSError:
                pass
            return
        shutil.rmtree(profile, ignore_errors=True)

    def _invalidate_live_tokens_locked(self, session_id: str) -> None:
        for token in [
            token
            for token, live in self._live_tokens.items()
            if live["session_id"] == session_id
        ]:
            self._live_tokens.pop(token, None)

    def _purge_live_tokens_locked(self, now: datetime) -> None:
        for token in [
            token
            for token, live in self._live_tokens.items()
            if now >= live["expires_at"]
        ]:
            self._live_tokens.pop(token, None)

    def _take_context_locked(self, session: dict[str, Any]) -> object | None:
        self._invalidate_live_tokens_locked(session["id"])
        context = None
        if (not session["context_closed"]
                and session["context"] is not None):
            context = session["context"]
        session["context"] = None
        session["login_page"] = None
        session["qr_status"] = None
        session["qr_image_data_url"] = None
        session["closed"] = True
        session["context_closed"] = True
        session["context_generation"] += 1
        return context

    def _detach_session_locked(
        self,
        session_id: str,
        session: dict[str, Any],
    ) -> bool:
        if self._sessions.get(session_id) is not session:
            return False
        self._invalidate_live_tokens_locked(session_id)
        session["closing"] = True
        session["bootstrap_pending"] = False
        session["context_generation"] += 1
        if (session.get("account_handle")
                and self._accounts.get(session["account_handle"]) is session):
            self._accounts.pop(session["account_handle"], None)
        self._sessions.pop(session_id, None)
        return True

    def _cleanup_detached_session(
        self,
        session: dict[str, Any],
        *,
        delete_profile: bool,
    ) -> None:
        context = None
        with session["io_lock"]:
            with self._lock:
                context = self._take_context_locked(session)
            try:
                if context is not None:
                    self._browser.close(context)
            finally:
                if delete_profile:
                    self._delete_profile(session["profile"])
                    session["profile_removed"] = True

    def _record_detached_cleanup_failure(
        self,
        error: BaseException,
    ) -> None:
        try:
            error_code = str(error)
        except BaseException:
            error_code = None
        if self._closed.is_set() and error_code == "douyin_browser_closed":
            LOGGER.info(
                "douyin_detached_session_cleanup_closed_by_shutdown"
            )
            return
        with self._lock:
            self._detached_cleanup_failures.append(error)
        LOGGER.warning(
            "douyin_detached_session_cleanup_failed error_type=%s",
            self._safe_bootstrap_error_type(error),
        )

    def _start_detached_cleanup_locked(
        self,
        session: dict[str, Any],
    ) -> None:
        cleanup_thread: threading.Thread

        def cleanup() -> None:
            try:
                self._cleanup_detached_session(
                    session,
                    delete_profile=True,
                )
            except BaseException as error:
                self._record_detached_cleanup_failure(error)
            finally:
                with self._lock:
                    self._detached_cleanup_threads.discard(cleanup_thread)

        cleanup_thread = threading.Thread(
            target=cleanup,
            name="douyin-session-cleanup",
            daemon=True,
        )
        self._detached_cleanup_threads.add(cleanup_thread)
        try:
            cleanup_thread.start()
        except BaseException:
            self._detached_cleanup_threads.discard(cleanup_thread)
            raise

    def _persist_or_remove(
        self, session_id: str, session: dict[str, Any]
    ) -> None:
        try:
            self._persist_account(session)
            self._persist(session)
        except BaseException as persistence_error:
            try:
                self._detach_session_locked(session_id, session)
                context = self._take_context_locked(session)
                if context is not None:
                    raise RuntimeError(
                        "persistence_cleanup_requires_session_io_lease"
                    )
                self._delete_profile(session["profile"])
                session["profile_removed"] = True
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

    def _reap_finished_bootstraps_locked(self) -> None:
        current = threading.current_thread()
        finished = [
            session_id
            for session_id, bootstrap in self._login_bootstraps.items()
            if bootstrap is not current and not bootstrap.is_alive()
        ]
        for session_id in finished:
            self._login_bootstraps.pop(session_id, None)
            self._login_bootstrap_profiles.pop(session_id, None)

    def sweep_expired(self, now: datetime | None = None) -> int:
        current = now or self._now()
        with self._lock:
            self._purge_live_tokens_locked(current)
            self._reap_finished_bootstraps_locked()
            expired = [session_id for session_id, session in self._sessions.items()
                       if current >= session["expires_at"] and not session["qr_expired"]]
        for session_id in expired:
            try:
                self.get_login_session(session_id, current)
            except Exception:
                continue
        return len(expired)

    @staticmethod
    def _bootstrap_duration_ms(started: float) -> int:
        return max(0, round((time.monotonic() - started) * 1_000))

    @staticmethod
    def _safe_bootstrap_error_type(error: BaseException) -> str:
        allowed = {
            "AssertionError",
            "DouyinLoginOpenFailure",
            "KeyError",
            "OSError",
            "RuntimeError",
            "TimeoutError",
            "TypeError",
            "ValidationError",
            "ValueError",
        }
        error_type = type(error).__name__
        return error_type if error_type in allowed else "UnexpectedError"

    @staticmethod
    def _safe_bootstrap_stage(
        error: BaseException,
        fallback: str,
    ) -> str:
        try:
            stage = getattr(error, "stage", None)
        except BaseException:
            return fallback
        if type(stage) is str and stage in _LOGIN_BOOTSTRAP_LOG_STAGES:
            return stage
        return fallback

    @staticmethod
    def _safe_bootstrap_error_code(error: BaseException) -> str:
        try:
            error_code = getattr(error, "error_code", None)
        except BaseException:
            error_code = None
        if (type(error_code) is str
                and error_code in _LOGIN_BOOTSTRAP_ERROR_CODES):
            return error_code
        try:
            message_code = str(error)
        except BaseException:
            return "douyin_login_open_failed"
        if message_code in _LOGIN_BOOTSTRAP_ERROR_CODES:
            return message_code
        return "douyin_login_open_failed"

    @staticmethod
    def _safe_bootstrap_failure_code(error: BaseException) -> str:
        try:
            code = str(error)
        except BaseException:
            return "douyin_login_open_failed"
        if code in _LOGIN_BOOTSTRAP_FAILURE_CODES:
            return code
        return "douyin_login_open_failed"

    def _fail_login_bootstrap(
        self,
        session_id: str,
        session: dict[str, Any],
        generation: int,
        *,
        stage: str,
        error_type: str,
        error_code: str,
        failure_code: str,
        started: float,
        context: object | None = None,
    ) -> None:
        cleanup_failed = False
        if context is not None:
            try:
                self._browser.close(context)
            except BaseException:
                cleanup_failed = True
        with self._lock:
            current = self._sessions.get(session_id)
            if (current is session
                    and session["context_generation"] == generation):
                session["bootstrap_pending"] = False
                session["identity_failed"] = True
                session["failure_code"] = failure_code
                session["closed"] = True
                session["context_closed"] = True
                session["context_generation"] += 1
                session["context"] = None
                session["login_page"] = None
                session["qr_status"] = None
                session["qr_image_data_url"] = None
            self._delete_profile(session["profile"])
            session["profile_removed"] = True
        LOGGER.warning(
            "douyin_login_bootstrap stage=%s error_type=%s duration_ms=%d "
            "error_code=%s cleanup_failed=%s failure_code=%s",
            stage,
            error_type,
            self._bootstrap_duration_ms(started),
            error_code,
            str(cleanup_failed).lower(),
            failure_code,
        )

    def _abort_login_bootstrap_for_base_exception(
        self,
        session_id: str,
        session: dict[str, Any],
        generation: int,
        *,
        context: object | None = None,
    ) -> None:
        owns_cleanup = False
        try:
            with self._lock:
                if (self._sessions.get(session_id) is session
                        and not session["closing"]
                        and session["context_generation"] == generation
                        and (context is None
                             or session["context"] is context)):
                    owns_cleanup = self._detach_session_locked(
                        session_id,
                        session,
                    )
        except BaseException:
            return
        if not owns_cleanup:
            return
        try:
            self._cleanup_detached_session(
                session,
                delete_profile=True,
            )
        except BaseException:
            return

    def _bootstrap_login_session(
        self,
        session_id: str,
        session: dict[str, Any],
        generation: int,
        predecessors: tuple[threading.Thread, ...],
    ) -> None:
        started = time.monotonic()
        try:
            for predecessor in predecessors:
                while predecessor.is_alive():
                    predecessor.join(timeout=0.05)
                    with self._lock:
                        if (self._sessions.get(session_id) is not session
                                or session["closing"]
                                or session["context_generation"] != generation
                                or self._closed.is_set()):
                            return
            try:
                with self._lock:
                    if (self._sessions.get(session_id) is not session
                            or session["closing"]
                            or session["context_generation"] != generation
                            or self._closed.is_set()):
                        return
                context = self._browser.open_douyin_login(session["profile"])
            except Exception as error:
                self._fail_login_bootstrap(
                    session_id,
                    session,
                    generation,
                    stage=self._safe_bootstrap_stage(error, "open_failed"),
                    error_type=self._safe_bootstrap_error_type(error),
                    error_code=self._safe_bootstrap_error_code(error),
                    failure_code=self._safe_bootstrap_failure_code(error),
                    started=started,
                )
                return
            except BaseException:
                self._abort_login_bootstrap_for_base_exception(
                    session_id,
                    session,
                    generation,
                )
                raise

            try:
                if not isinstance(context, dict):
                    raise ValueError("invalid login context")
                raw_login_page = context.get("login_page")
                login_page = (
                    None
                    if raw_login_page is None
                    else LoginPageView.model_validate(
                        raw_login_page
                    ).model_dump(mode="json")
                )
            except Exception as error:
                self._fail_login_bootstrap(
                    session_id,
                    session,
                    generation,
                    stage=self._safe_bootstrap_stage(
                        error,
                        "open_result_invalid",
                    ),
                    error_type=self._safe_bootstrap_error_type(error),
                    error_code=self._safe_bootstrap_error_code(error),
                    failure_code=self._safe_bootstrap_failure_code(error),
                    started=started,
                    context=context,
                )
                return
            except BaseException:
                try:
                    self._browser.close(context)
                except BaseException:
                    pass
                self._abort_login_bootstrap_for_base_exception(
                    session_id,
                    session,
                    generation,
                )
                raise

            prepare_login = getattr(
                self._browser,
                "prepare_douyin_login",
                None,
            )
            discard_stage: str | None = None
            registered_generation: int | None = None
            with self._lock:
                current = self._sessions.get(session_id)
                if (current is not session
                        or session["context_generation"] != generation):
                    discard_stage = "cancelled"
                elif self._closed.is_set():
                    self._detach_session_locked(session_id, session)
                    self._delete_profile(session["profile"])
                    session["profile_removed"] = True
                    discard_stage = "shutdown"
                elif self._now() >= session["expires_at"]:
                    self._detach_session_locked(session_id, session)
                    self._delete_profile(session["profile"])
                    session["profile_removed"] = True
                    discard_stage = "expired"
                else:
                    session["context"] = context
                    session["login_page"] = login_page
                    session["qr_status"] = context.get(
                        "qr_status",
                        "opening",
                    )
                    session["qr_image_data_url"] = context.get(
                        "qr_image_data_url"
                    )
                    session["context_closed"] = False
                    session["context_generation"] += 1
                    registered_generation = session["context_generation"]
                    session["bootstrap_pending"] = callable(prepare_login)

            if discard_stage is not None:
                try:
                    self._browser.close(context)
                except Exception:
                    LOGGER.warning(
                        "douyin_login_bootstrap stage=discard_cleanup_failed "
                        "duration_ms=%d",
                        self._bootstrap_duration_ms(started),
                    )
                else:
                    LOGGER.info(
                        "douyin_login_bootstrap stage=discarded_%s "
                        "duration_ms=%d",
                        discard_stage,
                        self._bootstrap_duration_ms(started),
                    )
                finally:
                    self._delete_profile(session["profile"])
                    session["profile_removed"] = True
                return

            LOGGER.info(
                "douyin_login_bootstrap stage=interactive_ready "
                "duration_ms=%d",
                self._bootstrap_duration_ms(started),
            )
            if not callable(prepare_login):
                return

            with self._lock:
                if (self._sessions.get(session_id) is not session
                        or session["closing"]
                        or session["context"] is not context
                        or session["context_generation"]
                        != registered_generation):
                    return

            try:
                prepared = prepare_login(context)
                if not isinstance(prepared, dict):
                    raise ValueError("invalid login preparation result")
                raw_prepared_login_page = prepared.get("login_page")
                prepared_login_page = (
                    None
                    if raw_prepared_login_page is None
                    else LoginPageView.model_validate(
                        raw_prepared_login_page
                    ).model_dump(mode="json")
                )
            except Exception as error:
                context_to_close = None
                owns_cleanup = False
                with self._lock:
                    if (self._sessions.get(session_id) is session
                            and not session["closing"]
                            and session["context"] is context
                            and session["context_generation"]
                            == registered_generation):
                        self._detach_session_locked(session_id, session)
                        context_to_close = self._take_context_locked(session)
                        owns_cleanup = True
                cleanup_failed = False
                if owns_cleanup:
                    try:
                        if context_to_close is not None:
                            self._browser.close(context_to_close)
                    except Exception:
                        cleanup_failed = True
                    finally:
                        self._delete_profile(session["profile"])
                        session["profile_removed"] = True
                LOGGER.warning(
                    "douyin_login_bootstrap "
                    "stage=login_prepare_failed "
                    "error_type=%s duration_ms=%d cleanup_failed=%s",
                    self._safe_bootstrap_error_type(error),
                    self._bootstrap_duration_ms(started),
                    str(cleanup_failed).lower(),
                )
                return
            except BaseException:
                self._abort_login_bootstrap_for_base_exception(
                    session_id,
                    session,
                    registered_generation,
                    context=context,
                )
                raise

            with self._lock:
                if (self._sessions.get(session_id) is not session
                        or session["closing"]
                        or session["context"] is not context
                        or session["context_generation"]
                        != registered_generation):
                    LOGGER.info(
                        "douyin_login_bootstrap stage=prepare_stale_exit "
                        "duration_ms=%d",
                        self._bootstrap_duration_ms(started),
                    )
                    return
                session["login_page"] = prepared_login_page
                session["qr_status"] = prepared.get(
                    "qr_status",
                    session["qr_status"],
                )
                session["qr_image_data_url"] = prepared.get(
                    "qr_image_data_url",
                    session["qr_image_data_url"],
                )
                session["bootstrap_pending"] = False

            LOGGER.info(
                "douyin_login_bootstrap stage=login_page_ready duration_ms=%d",
                self._bootstrap_duration_ms(started),
            )
        finally:
            cleanup_detached = False
            with self._lock:
                current = self._sessions.get(session_id)
                if current is session:
                    session["bootstrap_pending"] = False
                if session.get("bootstrap_cleanup_pending"):
                    session["bootstrap_cleanup_pending"] = False
                    cleanup_detached = not session.get("profile_removed", False)
                    if (
                        not cleanup_detached
                        and self._login_bootstraps.get(session_id)
                        is threading.current_thread()
                    ):
                        self._login_bootstraps.pop(session_id, None)
                        self._login_bootstrap_profiles.pop(session_id, None)
                elif (
                    self._login_bootstraps.get(session_id)
                    is threading.current_thread()
                ):
                    self._login_bootstraps.pop(session_id, None)
                    self._login_bootstrap_profiles.pop(session_id, None)

            if cleanup_detached:
                try:
                    self._cleanup_detached_session(
                        session,
                        delete_profile=True,
                    )
                except BaseException as error:
                    self._record_detached_cleanup_failure(error)

                with self._lock:
                    bootstrap = self._login_bootstraps.get(session_id)
                    if bootstrap is threading.current_thread():
                        self._login_bootstraps.pop(session_id, None)
                        self._login_bootstrap_profiles.pop(session_id, None)

    def create_login_session(
        self,
        account_key: str | None = None,
    ) -> LoginSessionView:
        if self._closed.is_set():
            raise RuntimeError("account_manager_closed")
        profile_key: str | None = None
        if self._interaction_surface == "external_window":
            if (not isinstance(account_key, str)
                    or re.fullmatch(r"[0-9a-f]{64}", account_key) is None):
                raise ValueError("douyin_account_key_required")
            profile_key = hashlib.sha256(
                b"shensi-douyin-profile\0" + account_key.encode("ascii")
            ).hexdigest()

            # The local browser manager returns an opaque handle before its
            # worker finishes launching.  Retire that outer handle once the
            # inner owner reports a terminal failure so a retry can create a
            # fresh generation; starting/running sessions remain idempotent.
            while True:
                with self._lock:
                    self._reap_finished_bootstraps_locked()
                    failed_session_id = next((
                        current["id"]
                        for current in self._sessions.values()
                        if current.get("profile_key") == profile_key
                        and not current["closing"]
                        and (
                            (owned := self._local_browser_status(current))
                            is not None
                        )
                        and (
                            getattr(owned, "runtime_state", None) == "crashed"
                            or getattr(owned, "task_state", None) == "failed"
                        )
                    ), None)
                if failed_session_id is None:
                    break
                try:
                    self.disconnect(failed_session_id)
                except KeyError:
                    continue

        with self._lock:
            if self._closed.is_set():
                raise RuntimeError("account_manager_closed")
            self._reap_finished_bootstraps_locked()
            now = self._now()
            if self._interaction_surface == "external_window":
                for current in self._sessions.values():
                    if (current.get("profile_key") == profile_key
                            and not current["closing"]
                            and now < current["expires_at"]
                            and (current["bootstrap_pending"]
                                 or current["context"] is not None
                                 or current["account_handle"])):
                        return self._login_session_view(current)
                predecessors = tuple(
                    bootstrap
                    for bootstrap_id, bootstrap in self._login_bootstraps.items()
                    if self._login_bootstrap_profiles.get(bootstrap_id)
                    == profile_key
                    and bootstrap.is_alive()
                )
            else:
                predecessors = tuple(
                    bootstrap
                    for bootstrap in self._login_bootstraps.values()
                    if bootstrap.is_alive()
                )
            session_id = secrets.token_urlsafe(24)
            profile = self._profiles / (
                profile_key or secrets.token_urlsafe(24)
            )
            profile.mkdir(mode=0o700, exist_ok=True)
            os.chmod(profile, 0o700)
            session: dict[str, Any] = {"id": session_id, "context": None,
                "login_page": None, "qr_status": "opening",
                "qr_image_data_url": None, "expires_at": now + self._ttl,
                "closed": False, "account_handle": None, "account_display_name": None,
                "login_state_version": None, "qr_expired": False,
                "identity_failed": False, "profile": profile,
                "failure_code": None,
                "profile_key": profile_key,
                "diagnostic": None,
                "profile_removed": False, "bootstrap_pending": True,
                "bootstrap_cleanup_pending": False,
                "io_lock": threading.Lock(),
                "context_generation": 0,
                "context_closed": True, "closing": False}
            self._sessions[session_id] = session
            self._persist_or_remove(session_id, session)
            bootstrap = threading.Thread(
                target=self._bootstrap_login_session,
                args=(
                    session_id,
                    session,
                    session["context_generation"],
                    predecessors,
                ),
                name="douyin-login-bootstrap",
                daemon=True,
            )
            self._login_bootstraps[session_id] = bootstrap
            self._login_bootstrap_profiles[session_id] = profile_key
            try:
                bootstrap.start()
            except BaseException:
                self._login_bootstraps.pop(session_id, None)
                self._login_bootstrap_profiles.pop(session_id, None)
                self._detach_session_locked(session_id, session)
                self._delete_profile(profile)
                session["profile_removed"] = True
                raise
            return self._login_session_view(session)

    def create_live_login_session(
        self,
        session_id: str,
    ) -> LiveLoginSessionView:
        if self._interaction_surface == "external_window":
            raise ValueError("douyin_live_login_unavailable")
        now = self._now()
        with self._lock:
            self._purge_live_tokens_locked(now)
            session = self._sessions.get(session_id)
            if session is None or now >= session["expires_at"]:
                raise KeyError(session_id)
            if (session["closed"] or session["context"] is None
                    or session["account_handle"]
                    or session["identity_failed"] or session["closing"]):
                raise ValueError("douyin_login_session_not_interactive")
            live_vnc_port = getattr(self._browser, "live_vnc_port", None)
            if live_vnc_port is None:
                raise ValueError("douyin_live_login_unavailable")
            try:
                port = live_vnc_port(session["context"])
            except Exception:
                raise ValueError("douyin_live_login_unavailable") from None
            if type(port) is not int or not 1 <= port <= 65_535:
                raise ValueError("douyin_live_login_unavailable")
            token = secrets.token_urlsafe(32)
            expires_at = min(
                session["expires_at"],
                now + self._live_session_ttl,
            )
            self._invalidate_live_tokens_locked(session_id)
            self._live_tokens[token] = {
                "session_id": session_id,
                "context_generation": session["context_generation"],
                "vnc_port": port,
                "expires_at": expires_at,
            }
            return LiveLoginSessionView(
                token=token,
                expires_at=expires_at,
            )

    def claim_live_login_session(self, token: str) -> int:
        """Consume one opaque token and return its session-bound VNC port."""
        now = self._now()
        with self._lock:
            self._purge_live_tokens_locked(now)
            live = self._live_tokens.pop(token, None)
            if live is None:
                raise KeyError(token)
            session = self._sessions.get(live["session_id"])
            if (session is None or session["closing"] or session["closed"]
                    or session["context"] is None or session["account_handle"]
                    or session["identity_failed"]
                    or session["context_generation"]
                    != live["context_generation"]):
                raise KeyError(token)
            return live["vnc_port"]

    def _apply_login_result(
        self,
        session_id: str,
        session: dict[str, Any],
        result: dict[str, object],
    ) -> None:
        identity_error = bool(result.get("identity_error"))
        if not identity_error and result.get("active") is not True:
            session["login_page"] = result.get("login_page")
            observed_status = result.get("qr_status", session["qr_status"])
            if not (
                observed_status == "opening"
                and session["qr_status"] in {
                    "network_error",
                    "expired",
                    "verification_required",
                }
            ):
                session["qr_status"] = observed_status
            if session["qr_status"] == "ready":
                session["qr_image_data_url"] = result.get(
                    "qr_image_data_url", session["qr_image_data_url"]
                )
            else:
                session["qr_image_data_url"] = None
            return

        try:
            if identity_error:
                session["identity_failed"] = True
                session["failure_code"] = "douyin_login_open_failed"
            else:
                fingerprint = result.get("identity_fingerprint")
                display_name = result.get("display_name")
                if (not isinstance(fingerprint, str)
                        or re.fullmatch(
                            r"[0-9a-f]{64}", fingerprint
                        ) is None
                        or not isinstance(display_name, str)
                        or not display_name.strip()
                        or len(display_name.strip()) > 100):
                    session["identity_failed"] = True
                    session["failure_code"] = "douyin_login_open_failed"
                else:
                    account_handle = account_handle_for_fingerprint(
                        fingerprint
                    )
                    login_state_version = self._next_login_state_version()
                    session["account_handle"] = account_handle
                    session["account_display_name"] = display_name.strip()
                    session["login_state_version"] = login_state_version
                    session["failure_code"] = None
            self._persist_or_remove(session_id, session)
        except BaseException:
            self._detach_session_locked(session_id, session)
            self._take_context_locked(session)
            self._delete_profile(session["profile"])
            session["profile_removed"] = True
            raise

    def _finish_login_result(
        self,
        session_id: str,
        session: dict[str, Any],
        context: object,
        generation: int,
        result: dict[str, object],
    ) -> LoginSessionView:
        terminal = (
            bool(result.get("identity_error"))
            or result.get("active") is True
        )
        if not terminal:
            with self._lock:
                if (self._sessions.get(session_id) is not session
                        or session["closing"]
                        or session["context"] is not context
                        or session["context_generation"] != generation):
                    raise KeyError(session_id)
                self._apply_login_result(session_id, session, result)
                return self._login_session_view(session)

        with self._lock:
            if (self._sessions.get(session_id) is not session
                    or session["closing"]
                    or session["context"] is not context
                    or session["context_generation"] != generation):
                raise KeyError(session_id)
            context_to_close = self._take_context_locked(session)
            closed_generation = session["context_generation"]

        try:
            if context_to_close is not None:
                self._browser.close(context_to_close)
        except BaseException:
            owns_cleanup = False
            with self._lock:
                if (self._sessions.get(session_id) is session
                        and not session["closing"]
                        and session["context_generation"]
                        == closed_generation):
                    self._detach_session_locked(session_id, session)
                    owns_cleanup = True
            if owns_cleanup:
                self._delete_profile(session["profile"])
                session["profile_removed"] = True
            raise

        with self._lock:
            if (self._sessions.get(session_id) is not session
                    or session["closing"]
                    or session["context_generation"] != closed_generation):
                raise KeyError(session_id)
            self._apply_login_result(session_id, session, result)
            return self._login_session_view(session)

    def _local_browser_status(
        self,
        session: dict[str, Any],
    ) -> object | None:
        if self._interaction_surface != "external_window":
            return None
        context = session.get("context")
        if not isinstance(context, dict):
            return None
        handle = context.get("handle")
        status_reader = getattr(self._browser, "get_status", None)
        if not isinstance(handle, str) or not callable(status_reader):
            return None
        try:
            return status_reader(handle)
        except (KeyError, RuntimeError):
            return None

    def _login_session_view(self, session: dict[str, Any]) -> LoginSessionView:
        owned_status = self._local_browser_status(session)
        owned_runtime = getattr(owned_status, "runtime_state", None)
        owned_auth = getattr(owned_status, "auth_state", None)
        owned_task = getattr(owned_status, "task_state", None)
        state = ("active" if session["account_handle"]
                 else "failed" if (session["identity_failed"]
                                   or owned_runtime == "crashed")
                 else "awaiting_scan")
        if state == "active":
            runtime_state = "stopped"
            auth_state = "authenticated"
            task_state = "completed"
        elif state == "failed":
            runtime_state = "crashed"
            auth_state = "unknown"
            task_state = "failed"
        else:
            runtime_state = (
                owned_runtime
                if owned_runtime in {"stopped", "starting", "running", "crashed"}
                else "starting" if session["bootstrap_pending"]
                else "running"
            )
            auth_state = (
                owned_auth
                if owned_auth in {
                    "unknown", "logged_out", "waiting_for_user",
                    "verification_required", "authenticated", "expired",
                }
                else "waiting_for_user"
                if self._interaction_surface == "external_window"
                else "verification_required"
                if session["qr_status"] == "verification_required"
                else "logged_out"
            )
            task_state = (
                owned_task
                if owned_task in {
                    "idle", "preparing", "running", "cancelling",
                    "completed", "failed",
                }
                else "preparing" if session["bootstrap_pending"] else "idle"
            )
        diagnostic = session.get("diagnostic")
        owned_diagnostic = getattr(owned_status, "diagnostic", None)
        if owned_diagnostic is not None:
            diagnostic = {
                "code": owned_diagnostic.code,
                "message": owned_diagnostic.message,
                "recoverable": owned_diagnostic.recoverable,
                "occurred_at": owned_diagnostic.occurred_at,
            }
        login_page = (
            session["login_page"] if state == "awaiting_scan"
            and not session["closed"]
            and self._interaction_surface == "remote_canvas"
            else None
        )
        qr_image = (
            session["qr_image_data_url"]
            if state == "awaiting_scan"
            and self._interaction_surface == "remote_canvas"
            else None
        )
        return LoginSessionView(
            session_id=session["id"],
            state=state,
            qr_status=(session["qr_status"] if state == "awaiting_scan"
                       and self._interaction_surface == "remote_canvas"
                       else None),
            qr_image_data_url=qr_image,
            login_page=login_page,
            expires_at=session["expires_at"],
            account_handle=session["account_handle"],
            account_display_name=session["account_display_name"],
            login_state_version=session["login_state_version"],
            failure_code=(session["failure_code"] if state == "failed"
                          else "douyin_login_open_failed"
                          if owned_runtime == "crashed" else None),
            interaction_surface=self._interaction_surface,
            runtime_state=runtime_state,
            auth_state=auth_state,
            task_state=task_state,
            diagnostic=diagnostic,
            screenshot_available=login_page is not None,
            qr_available=qr_image is not None,
        )

    def _expired_login_session_view(
        self,
        session_id: str,
        expires_at: datetime,
    ) -> LoginSessionView:
        return LoginSessionView(
            session_id=session_id,
            state="expired",
            qr_status=None,
            qr_image_data_url=None,
            login_page=None,
            expires_at=expires_at,
            account_handle=None,
            account_display_name=None,
            login_state_version=None,
            interaction_surface=self._interaction_surface,
            runtime_state="stopped",
            auth_state="expired",
            task_state="completed",
            screenshot_available=False,
            qr_available=False,
        )

    def get_login_session(self, session_id: str, now: datetime | None = None) -> LoginSessionView:
        current_time = now or self._now()
        expired_session: dict[str, Any] | None = None
        active_expiry: dict[str, Any] | None = None
        with self._lock:
            self._reap_finished_bootstraps_locked()
            session = self._sessions.get(session_id)
            if session is None:
                raise KeyError(session_id)
            if current_time >= session["expires_at"]:
                if session["account_handle"]:
                    if session["qr_expired"]:
                        return self._login_session_view(session)
                    active_expiry = session
                else:
                    self._detach_session_locked(session_id, session)
                    expired_session = session
            if (session["identity_failed"] and expired_session is None
                    and active_expiry is None):
                return self._login_session_view(session)
            if expired_session is None and active_expiry is None:
                if (session["context"] is None or session["closed"]
                        or session["closing"]):
                    return self._login_session_view(session)
                io_lock = session["io_lock"]

        if expired_session is not None:
            expires_at = expired_session["expires_at"]
            self._cleanup_detached_session(
                expired_session,
                delete_profile=True,
            )
            return self._expired_login_session_view(session_id, expires_at)

        if active_expiry is not None:
            context_to_close = None
            with active_expiry["io_lock"]:
                with self._lock:
                    if self._sessions.get(session_id) is not active_expiry:
                        raise KeyError(session_id)
                    if not active_expiry["qr_expired"]:
                        context_to_close = self._take_context_locked(
                            active_expiry
                        )
                        active_expiry["qr_expired"] = True
                        self._persist_or_remove(session_id, active_expiry)
                    view = self._login_session_view(active_expiry)
                if context_to_close is not None:
                    self._browser.close(context_to_close)
                return view

        with io_lock:
            with self._lock:
                if (self._sessions.get(session_id) is not session
                        or session["closing"]):
                    raise KeyError(session_id)
                if current_time >= session["expires_at"]:
                    self._detach_session_locked(session_id, session)
                    context_to_close = self._take_context_locked(session)
                    expires_at = session["expires_at"]
                    expired_while_waiting = True
                elif session["context"] is None or session["closed"]:
                    return self._login_session_view(session)
                else:
                    context = session["context"]
                    generation = session["context_generation"]
                    expired_while_waiting = False

            if expired_while_waiting:
                try:
                    if context_to_close is not None:
                        self._browser.close(context_to_close)
                finally:
                    self._delete_profile(session["profile"])
                    session["profile_removed"] = True
                return self._expired_login_session_view(
                    session_id,
                    expires_at,
                )

            try:
                result = self._browser.poll_douyin_login(context)
            except Exception:
                context_to_close = None
                owns_cleanup = False
                with self._lock:
                    if (self._sessions.get(session_id) is session
                            and session["context"] is context
                            and session["context_generation"] == generation):
                        self._detach_session_locked(session_id, session)
                        context_to_close = self._take_context_locked(session)
                        owns_cleanup = True
                if owns_cleanup:
                    try:
                        if context_to_close is not None:
                            self._browser.close(context_to_close)
                    finally:
                        self._delete_profile(session["profile"])
                        session["profile_removed"] = True
                raise

            return self._finish_login_result(
                session_id,
                session,
                context,
                generation,
                result,
            )

    def interact_login_session(
        self,
        session_id: str,
        request: LoginInteractionRequest,
    ) -> LoginSessionView:
        if self._interaction_surface == "external_window":
            raise ValueError("douyin_login_interaction_unavailable")
        expired_session: dict[str, Any] | None = None
        with self._lock:
            session = self._sessions.get(session_id)
            if session is None:
                raise KeyError(session_id)
            if self._now() >= session["expires_at"]:
                if session["account_handle"]:
                    raise ValueError("douyin_login_session_not_interactive")
                self._detach_session_locked(session_id, session)
                expired_session = session
            if (session["closed"] or session["context"] is None
                    or session["account_handle"]
                    or session["identity_failed"] or session["closing"]):
                if expired_session is not None:
                    pass
                else:
                    raise ValueError("douyin_login_session_not_interactive")
            io_lock = session["io_lock"]

        if expired_session is not None:
            self._cleanup_detached_session(
                expired_session,
                delete_profile=True,
            )
            raise KeyError(session_id)

        with io_lock:
            with self._lock:
                if (self._sessions.get(session_id) is not session
                        or session["closing"]):
                    raise KeyError(session_id)
                if self._now() >= session["expires_at"]:
                    self._detach_session_locked(session_id, session)
                    context_to_close = self._take_context_locked(session)
                    expired_while_waiting = True
                elif (session["closed"] or session["context"] is None
                        or session["account_handle"]
                        or session["identity_failed"]):
                    raise ValueError(
                        "douyin_login_session_not_interactive"
                    )
                else:
                    context = session["context"]
                    generation = session["context_generation"]
                    expired_while_waiting = False

            if expired_while_waiting:
                try:
                    if context_to_close is not None:
                        self._browser.close(context_to_close)
                finally:
                    self._delete_profile(session["profile"])
                    session["profile_removed"] = True
                raise KeyError(session_id)

            try:
                result = self._browser.interact_douyin_login(
                    context,
                    request,
                )
            except Exception as error:
                context_to_close = None
                owns_cleanup = False
                with self._lock:
                    if (self._sessions.get(session_id) is session
                            and session["context"] is context
                            and session["context_generation"] == generation):
                        self._detach_session_locked(session_id, session)
                        context_to_close = self._take_context_locked(session)
                        owns_cleanup = True
                cleanup_error_code = None
                if owns_cleanup:
                    try:
                        if context_to_close is not None:
                            self._browser.close(context_to_close)
                    except BaseException as cleanup_error:
                        cleanup_error_code = self._safe_bootstrap_failure_code(
                            cleanup_error
                        )
                    finally:
                        self._delete_profile(session["profile"])
                        session["profile_removed"] = True
                if cleanup_error_code is not None:
                    LOGGER.warning(
                        "douyin_login_interaction stage=cleanup_failed "
                        "primary_error_code=%s cleanup_error_code=%s",
                        self._safe_bootstrap_failure_code(error),
                        cleanup_error_code,
                    )
                raise

            return self._finish_login_result(
                session_id,
                session,
                context,
                generation,
                result,
            )

    def disconnect(self, session_id: str) -> None:
        bootstrap_owns_cleanup = False
        cleanup_start_error: BaseException | None = None
        preempt_error: BaseException | None = None
        with self._lock:
            session = self._sessions.get(session_id)
            if session is None:
                raise KeyError(session_id)
            bootstrap = self._login_bootstraps.get(session_id)
            bootstrap_owns_cleanup = bool(
                bootstrap is not None and bootstrap.is_alive()
            )
            session["bootstrap_cleanup_pending"] = bootstrap_owns_cleanup
            self._detach_session_locked(session_id, session)
            if self._interaction_surface == "external_window":
                context = session.get("context")
                preempt_profile = getattr(
                    self._browser,
                    "abort_douyin_profile",
                    None,
                )
                preempt_context = getattr(
                    self._browser,
                    "abort_douyin_login",
                    None,
                )
                if callable(preempt_profile):
                    try:
                        preempt_profile(session["profile"])
                    except BaseException as error:
                        preempt_error = error
                elif callable(preempt_context) and context is not None:
                    try:
                        preempt_context(context)
                    except BaseException as error:
                        preempt_error = error
            if not bootstrap_owns_cleanup:
                try:
                    self._start_detached_cleanup_locked(session)
                except BaseException as error:
                    cleanup_start_error = error
        if cleanup_start_error is not None:
            try:
                self._cleanup_detached_session(session, delete_profile=True)
            except BaseException as cleanup_error:
                raise BaseExceptionGroup(
                    "douyin_detached_session_cleanup_start_failed",
                    [cleanup_start_error, cleanup_error],
                )
            if not isinstance(cleanup_start_error, Exception):
                raise cleanup_start_error
            LOGGER.warning(
                "douyin_detached_session_cleanup_used_sync_fallback "
                "error_type=%s",
                self._safe_bootstrap_error_type(cleanup_start_error),
            )
        if preempt_error is not None:
            raise preempt_error

    def resolve_crawl_profile(self, account_handle: str, login_state_version: int) -> Path:
        """Resolve private crawl authority without exposing it through HTTP."""
        self.sweep_expired()
        with self._lock:
            session = self._accounts.get(account_handle)
            if (session is None or session["login_state_version"] != login_state_version
                    or not account_handle):
                raise KeyError("active_account_not_found")
            io_lock = session["io_lock"]
        with io_lock:
            failures: list[BaseException] = []
            with self._lock:
                if (self._accounts.get(account_handle) is not session
                        or session["login_state_version"] != login_state_version
                        or session["closing"]):
                    raise KeyError("active_account_not_found")
                context = self._take_context_locked(session)
                try:
                    self._persist_or_remove(session["id"], session)
                except BaseException as error:
                    failures.append(error)
                profile = session["profile"]
            if context is not None:
                try:
                    self._browser.close(context)
                except BaseException as error:
                    failures.append(error)
            if len(failures) == 1:
                raise failures[0]
            if failures:
                raise BaseExceptionGroup(
                    "douyin_profile_resolution_failed",
                    failures,
                )
            return profile

    def resolve_action_profile(self, account_handle: str,
                               login_state_version: int) -> Path:
        """Resolve the same durable authenticated profile for one action."""
        return self.resolve_crawl_profile(account_handle, login_state_version)

    def resolve_account_identity(self, account_key: str):
        """Resolve only the exact stable desktop profile, never disclose paths."""
        from .schemas import DesktopAccountIdentity

        if (self._interaction_surface != "external_window"
                or not isinstance(account_key, str)
                or re.fullmatch(r"[0-9a-f]{64}", account_key) is None):
            raise KeyError("active_account_not_found")
        profile_key = hashlib.sha256(
            b"shensi-douyin-profile\0" + account_key.encode("ascii")
        ).hexdigest()
        profile = self._profiles / profile_key
        metadata = self._account_metadata_path(profile)
        with self._lock:
            try:
                if (profile.is_symlink() or not profile.is_dir()
                        or metadata.is_symlink() or not metadata.is_file()):
                    raise ValueError("invalid account metadata")
                value = json.loads(metadata.read_text(encoding="utf-8"))
                if (not isinstance(value, dict)
                        or not is_bound_account_handle(value.get("account_handle"))
                        or not isinstance(value.get("account_display_name"), str)
                        or not value["account_display_name"].strip()
                        or type(value.get("login_state_version")) is not int
                        or not 1 <= value["login_state_version"] <= 9007199254740991):
                    raise ValueError("invalid account metadata")
                session = self._accounts.get(value["account_handle"])
                if (session is None or session["profile"] != profile
                        or session["id"] != value.get("session_id")
                        or session["login_state_version"] != value["login_state_version"]
                        or session["account_display_name"] != value["account_display_name"]):
                    raise ValueError("stale account metadata")
                return DesktopAccountIdentity(
                    account_key=account_key, account_handle=value["account_handle"],
                    account_display_name=value["account_display_name"],
                    login_state_version=value["login_state_version"],
                )
            except (OSError, ValueError, TypeError, KeyError) as error:
                raise KeyError("active_account_not_found") from error

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
        if self._interaction_surface == "external_window":
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

        # Keep the legacy remote-canvas authority lease unchanged.  Desktop
        # workers use per-profile leases and must not serialize other accounts.
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
        if self._interaction_surface == "external_window":
            self._require_current_action_authority(
                profile,
                request.account_handle,
                request.login_state_version,
            )
            reconcile = getattr(
                self._browser,
                "reconcile_douyin_action",
                None,
            )
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
        bootstrap_threads: list[threading.Thread] = []
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
        sessions: list[dict[str, Any]] = []
        try:
            acquired = self._lock.acquire(timeout=2)
            if not acquired:
                failures.append(RuntimeError("account_manager_shutdown_lock_timeout"))
            else:
                bootstrap_threads = list(self._login_bootstraps.values())
                sessions = list(self._sessions.values())
                for session in sessions:
                    session["closing"] = True
                    session["context_generation"] += 1
        except BaseException as error:
            failures.append(error)
        finally:
            if acquired:
                self._lock.release()

        if self._interaction_surface == "external_window":
            for session in sessions:
                context = session.get("context")
                preempt_profile = getattr(
                    self._browser,
                    "abort_douyin_profile",
                    None,
                )
                preempt_context = getattr(
                    self._browser,
                    "abort_douyin_login",
                    None,
                )
                try:
                    if callable(preempt_profile):
                        preempt_profile(session["profile"])
                    elif callable(preempt_context) and context is not None:
                        preempt_context(context)
                except BaseException as error:
                    failures.append(error)

        session_close_deadline = time.monotonic() + 2
        for session in sessions:
            io_lock_acquired = False
            try:
                io_lock_acquired = session["io_lock"].acquire(
                    timeout=max(
                        0,
                        session_close_deadline - time.monotonic(),
                    )
                )
                if not io_lock_acquired:
                    failures.append(RuntimeError(
                        "douyin_session_shutdown_io_timeout"
                    ))
                    continue
                with self._lock:
                    if self._sessions.get(session["id"]) is not session:
                        continue
                    context = self._take_context_locked(session)
                if context is not None:
                    try:
                        self._browser.close(context)
                    except BaseException as error:
                        failures.append(error)
                with self._lock:
                    if self._sessions.get(session["id"]) is not session:
                        continue
                    try:
                        self._persist_account(session)
                        self._persist(session)
                    except BaseException as error:
                        failures.append(error)
            finally:
                if io_lock_acquired:
                    session["io_lock"].release()

        close_browser = getattr(self._browser, "close_browser", None)
        if close_browser is not None:
            try:
                close_browser()
            except BaseException as error:
                failures.append(error)
        bootstrap_deadline = time.monotonic() + 2
        for bootstrap in bootstrap_threads:
            try:
                bootstrap.join(
                    timeout=max(0, bootstrap_deadline - time.monotonic())
                )
                if bootstrap.is_alive():
                    failures.append(RuntimeError(
                        "douyin_login_bootstrap_shutdown_timeout"
                    ))
            except BaseException as error:
                failures.append(error)
        with self._lock:
            self._reap_finished_bootstraps_locked()
        cleanup_deadline = time.monotonic() + 2
        while True:
            with self._lock:
                cleanup_threads = list(self._detached_cleanup_threads)
            if not cleanup_threads:
                break
            for cleanup_thread in cleanup_threads:
                try:
                    cleanup_thread.join(
                        timeout=max(
                            0,
                            cleanup_deadline - time.monotonic(),
                        )
                    )
                except BaseException as error:
                    failures.append(error)
            with self._lock:
                cleanup_alive = any(
                    cleanup.is_alive()
                    for cleanup in self._detached_cleanup_threads
                )
            if not cleanup_alive:
                break
            if time.monotonic() >= cleanup_deadline:
                failures.append(RuntimeError(
                    "douyin_session_cleanup_shutdown_timeout"
                ))
                break
        with self._lock:
            failures.extend(self._detached_cleanup_failures)
            self._detached_cleanup_failures.clear()
        if len(failures) == 1:
            raise failures[0]
        if failures:
            raise BaseExceptionGroup("douyin_account_manager_shutdown_failed", failures)
