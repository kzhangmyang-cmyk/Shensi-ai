"""Lifecycle owner for user-operated local Douyin browser sessions."""

from __future__ import annotations

import asyncio
import hashlib
import logging
import os
import secrets
import threading
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Callable, Literal, Protocol, TypeVar

from .profile_lease import ProfileLease, ProfileLeaseBusy, acquire_profile_lease


LOGGER = logging.getLogger(__name__)
_T = TypeVar("_T")


class LocalBrowserWorker(Protocol):
    def open_douyin_login(self, profile_path: Path) -> dict[str, object]: ...

    def poll_douyin_login(self, context: object) -> dict[str, object]: ...

    def close(self, context: object) -> None: ...

    def abort_browser(self) -> None: ...

    def close_browser(self) -> None: ...


@dataclass(frozen=True, slots=True)
class LocalBrowserDiagnostic:
    code: str
    message: str
    recoverable: bool
    occurred_at: datetime


@dataclass(frozen=True, slots=True)
class LocalBrowserSessionStatus:
    session_id: str
    generation: int
    profile_path: Path
    runtime_state: Literal["stopped", "starting", "running", "crashed"]
    auth_state: Literal[
        "unknown",
        "logged_out",
        "waiting_for_user",
        "verification_required",
        "authenticated",
        "expired",
    ]
    task_state: Literal[
        "idle",
        "preparing",
        "running",
        "cancelling",
        "completed",
        "failed",
    ]
    diagnostic: LocalBrowserDiagnostic | None
    screenshot_available: bool = False
    qr_available: bool = False


@dataclass(slots=True)
class _Session:
    session_id: str
    account_digest: str
    start_generation: int
    generation: int
    profile_path: Path
    runtime_state: str = "starting"
    auth_state: str = "unknown"
    task_state: str = "preparing"
    diagnostic: LocalBrowserDiagnostic | None = None
    worker: LocalBrowserWorker | None = None
    context: object | None = None
    task: asyncio.Task[None] | None = None
    abort_called: bool = False
    worker_closed: bool = False
    context_closed: bool = False
    profile_lease: ProfileLease | None = None
    profile_lease_released: bool = False
    open_in_flight: bool = False
    command_lock: threading.Lock = field(default_factory=threading.Lock)
    cleanup_lock: threading.Lock = field(default_factory=threading.Lock)


def _account_digest(account_key: str) -> str:
    if not isinstance(account_key, str) or not account_key:
        raise ValueError("account_key is required")
    return hashlib.sha256(
        b"shensi-douyin-profile\0" + account_key.encode("utf-8")
    ).hexdigest()


class LocalBrowserSessionManager:
    """Own every local login worker and the Context hidden inside that worker.

    Callers receive only an opaque session handle.  A dedicated browser worker
    is created for every login session, so browser I/O for unrelated accounts
    never shares a global command lock.
    """

    interaction_surface = "external_window"

    def __init__(
        self,
        profile_root: Path,
        *,
        lease_root: Path | None = None,
        browser_factory: Callable[[], LocalBrowserWorker],
        now: Callable[[], datetime] = lambda: datetime.now(UTC),
    ) -> None:
        self._profile_root = profile_root.resolve()
        self._profile_root.mkdir(mode=0o700, parents=True, exist_ok=True)
        os.chmod(self._profile_root, 0o700)
        self._lease_root = (
            lease_root.resolve()
            if lease_root is not None
            else self._profile_root.parent
        )
        self._browser_factory = browser_factory
        self._now = now
        self._lock = threading.RLock()
        self._sessions: dict[str, _Session] = {}
        self._current_by_account: dict[str, str] = {}
        self._profile_by_account: dict[str, Path] = {}
        self._account_generations: dict[str, int] = {}
        self._account_locks: dict[str, threading.Lock] = {}
        self._closed = False
        self._loop = asyncio.new_event_loop()
        self._loop_ready = threading.Event()
        self._loop_thread = threading.Thread(
            target=self._run_event_loop,
            name="douyin-local-session-loop",
            daemon=True,
        )
        self._loop_thread.start()
        if not self._loop_ready.wait(timeout=2):
            raise RuntimeError("douyin_local_session_loop_start_failed")

    def _run_event_loop(self) -> None:
        asyncio.set_event_loop(self._loop)
        self._loop_ready.set()
        self._loop.run_forever()
        pending = asyncio.all_tasks(self._loop)
        for task in pending:
            task.cancel()
        if pending:
            self._loop.run_until_complete(
                asyncio.gather(*pending, return_exceptions=True)
            )
        self._loop.run_until_complete(self._loop.shutdown_asyncgens())
        self._loop.close()

    def _is_current_locked(self, session: _Session) -> bool:
        return (
            not self._closed
            and self._sessions.get(session.session_id) is session
            and self._current_by_account.get(session.account_digest)
            == session.session_id
            and self._account_generations.get(session.account_digest)
            == session.start_generation
            and session.task_state not in {"cancelling", "completed", "failed"}
        )

    def _snapshot_locked(self, session: _Session) -> LocalBrowserSessionStatus:
        return LocalBrowserSessionStatus(
            session_id=session.session_id,
            generation=session.generation,
            profile_path=session.profile_path,
            runtime_state=session.runtime_state,  # type: ignore[arg-type]
            auth_state=session.auth_state,  # type: ignore[arg-type]
            task_state=session.task_state,  # type: ignore[arg-type]
            diagnostic=session.diagnostic,
            screenshot_available=False,
            qr_available=False,
        )

    def _profile_path(
        self,
        account_digest: str,
        explicit: Path | None,
    ) -> Path:
        profile = (
            Path(explicit).expanduser().resolve()
            if explicit is not None
            else self._profile_root / account_digest
        )
        profile.mkdir(mode=0o700, parents=True, exist_ok=True)
        os.chmod(profile, 0o700)
        return profile

    def _schedule_start(self, session: _Session) -> None:
        scheduled = threading.Event()

        def create_task() -> None:
            task = self._loop.create_task(self._start_task(session))
            with self._lock:
                session.task = task
            scheduled.set()

        self._loop.call_soon_threadsafe(create_task)
        if not scheduled.wait(timeout=2):
            raise RuntimeError("douyin_local_login_schedule_failed")

    def start_login(
        self,
        account_key: str,
        *,
        profile_path: Path | None = None,
    ) -> LocalBrowserSessionStatus:
        digest = _account_digest(account_key)
        with self._lock:
            if self._closed:
                raise RuntimeError("local_browser_session_manager_closed")
            current_id = self._current_by_account.get(digest)
            if current_id is not None:
                current = self._sessions.get(current_id)
                if (
                    current is not None
                    and current.runtime_state in {"starting", "running"}
                    and current.task_state in {"preparing", "idle", "running"}
                ):
                    return self._snapshot_locked(current)

            generation = self._account_generations.get(digest, 0) + 1
            self._account_generations[digest] = generation
            profile = self._profile_path(digest, profile_path)
            session = _Session(
                session_id=secrets.token_urlsafe(24),
                account_digest=digest,
                start_generation=generation,
                generation=generation,
                profile_path=profile,
            )
            self._sessions[session.session_id] = session
            self._current_by_account[digest] = session.session_id
            self._profile_by_account[digest] = profile
            self._account_locks.setdefault(digest, threading.Lock())

        try:
            self._schedule_start(session)
        except BaseException:
            with self._lock:
                self._sessions.pop(session.session_id, None)
                if self._current_by_account.get(digest) == session.session_id:
                    self._current_by_account.pop(digest, None)
            raise
        LOGGER.info(
            "local_douyin_login scheduled session_id=%s generation=%d",
            session.session_id,
            generation,
        )
        with self._lock:
            return self._snapshot_locked(session)

    async def _start_task(self, session: _Session) -> None:
        try:
            await asyncio.to_thread(self._open_session, session)
        except asyncio.CancelledError:
            self._mark_cancelled(session)
            self._close_resources(session, abort=True)
            raise
        except BaseException as error:
            if isinstance(error, asyncio.CancelledError):
                self._mark_cancelled(session)
                self._close_resources(session, abort=True)
                raise
            self._mark_failed(session, error)

    def _open_session(self, session: _Session) -> None:
        account_lock = self._account_locks[session.account_digest]
        worker: LocalBrowserWorker | None = None
        context: object | None = None
        try:
            with self._lock:
                if not self._is_current_locked(session):
                    return
            # Worker construction may synchronously wait for its child process
            # to start, but it does not touch the account Profile.  Keep it
            # outside the per-account Profile lock so a cancelled construction
            # cannot prevent the replacement generation from starting.
            worker = self._browser_factory()
            with self._lock:
                session.worker = worker
                stale = not self._is_current_locked(session)
            if stale:
                self._close_resources(session, abort=True)
                return

            with account_lock:
                with self._lock:
                    stale = not self._is_current_locked(session)
                    if not stale:
                        session.profile_lease = acquire_profile_lease(
                            session.profile_path,
                            self._lease_root,
                        )
                        session.open_in_flight = True
                if stale:
                    self._close_resources(session, abort=True)
                    return

                try:
                    context = worker.open_douyin_login(session.profile_path)
                except BaseException:
                    with session.cleanup_lock:
                        with self._lock:
                            session.open_in_flight = False
                    self._close_resources(session, abort=True)
                    raise
                with session.cleanup_lock:
                    with self._lock:
                        session.open_in_flight = False
                        if not self._is_current_locked(session):
                            stale = True
                        else:
                            session.context = context
                            session.runtime_state = "running"
                            session.auth_state = "waiting_for_user"
                            session.task_state = "idle"
                            session.diagnostic = None
                            stale = False
                    if stale:
                        self._dispose_late_context_locked(
                            session,
                            worker,
                            context,
                        )
                        return
            LOGGER.info(
                "local_douyin_login waiting_for_user session_id=%s "
                "generation=%d",
                session.session_id,
                session.start_generation,
            )
        except asyncio.CancelledError:
            self._mark_cancelled(session)
            self._close_resources(session, abort=True)
            raise
        except BaseException:
            if context is not None and worker is not None:
                self._dispose_late_context(session, worker, context)
            raise

    def _dispose_late_context(
        self,
        session: _Session,
        worker: LocalBrowserWorker,
        context: object,
    ) -> None:
        with session.cleanup_lock:
            self._dispose_late_context_locked(session, worker, context)

    def _dispose_late_context_locked(
        self,
        session: _Session,
        worker: LocalBrowserWorker,
        context: object,
    ) -> None:
        should_close = False
        with self._lock:
            if not session.context_closed:
                session.context_closed = True
                should_close = True
        if should_close:
            try:
                worker.close(context)
            except BaseException:
                pass
        try:
            self._close_worker_once(session, worker, abort=True)
        finally:
            self._release_profile_lease_once(session)
        LOGGER.info(
            "local_douyin_login stale_task_exit session_id=%s generation=%d",
            session.session_id,
            session.start_generation,
        )

    def _mark_cancelled(self, session: _Session) -> None:
        with self._lock:
            session.runtime_state = "stopped"
            session.task_state = "completed"
            if session.auth_state != "authenticated":
                session.auth_state = "unknown"
            session.diagnostic = None

    def _mark_failed(self, session: _Session, error: BaseException) -> None:
        with self._lock:
            if not self._is_current_locked(session):
                self._mark_cancelled(session)
                stale = True
            else:
                session.runtime_state = "crashed"
                session.auth_state = "unknown"
                session.task_state = "failed"
                if isinstance(error, ProfileLeaseBusy):
                    session.diagnostic = LocalBrowserDiagnostic(
                        code="douyin_profile_busy",
                        message="This Douyin profile is already in use.",
                        recoverable=True,
                        occurred_at=self._now(),
                    )
                else:
                    session.diagnostic = LocalBrowserDiagnostic(
                        code="douyin_login_open_failed",
                        message="The external browser could not be started.",
                        recoverable=False,
                        occurred_at=self._now(),
                    )
                if (
                    self._current_by_account.get(session.account_digest)
                    == session.session_id
                ):
                    self._current_by_account.pop(session.account_digest, None)
                stale = False
        self._close_resources(session, abort=True)
        LOGGER.warning(
            "local_douyin_login start_failed session_id=%s generation=%d "
            "error_type=%s stale=%s",
            session.session_id,
            session.start_generation,
            type(error).__name__,
            str(stale).lower(),
        )

    def _close_worker_once(
        self,
        session: _Session,
        worker: LocalBrowserWorker,
        *,
        abort: bool,
    ) -> None:
        call_abort = False
        call_close = False
        with self._lock:
            if abort and not session.abort_called:
                session.abort_called = True
                call_abort = True
            if not session.worker_closed:
                session.worker_closed = True
                call_close = True
        if call_abort:
            try:
                worker.abort_browser()
            except BaseException:
                pass
        if call_close:
            try:
                worker.close_browser()
            except BaseException:
                pass

    def _close_resources(self, session: _Session, *, abort: bool) -> None:
        with session.cleanup_lock:
            self._close_resources_locked(session, abort=abort)

    def _close_resources_locked(
        self,
        session: _Session,
        *,
        abort: bool,
    ) -> None:
        with self._lock:
            worker = session.worker
            context = session.context
            session.context = None
            close_context = context is not None and not session.context_closed
            if close_context:
                session.context_closed = True
            release_profile_lease = not session.open_in_flight
        try:
            if worker is None:
                return
            if abort:
                # A dedicated worker may currently hold its own command lock in a
                # blocking poll/open call.  Terminate it before asking for graceful
                # Context cleanup; otherwise close() waits behind that same lock and
                # the explicit cancellation cannot reach abort_browser().
                self._close_worker_once(session, worker, abort=True)
                if close_context:
                    try:
                        worker.close(context)
                    except BaseException:
                        pass
                return
            if close_context:
                try:
                    worker.close(context)
                except BaseException:
                    abort = True
            self._close_worker_once(session, worker, abort=abort)
        finally:
            if release_profile_lease:
                self._release_profile_lease_once(session)

    def _release_profile_lease_once(self, session: _Session) -> None:
        lease: ProfileLease | None = None
        with self._lock:
            if not session.profile_lease_released:
                session.profile_lease_released = True
                lease = session.profile_lease
                session.profile_lease = None
        if lease is not None:
            lease.release()

    def get_status(self, session_id: str) -> LocalBrowserSessionStatus:
        with self._lock:
            session = self._sessions.get(session_id)
            if session is None:
                raise KeyError(session_id)
            return self._snapshot_locked(session)

    def _poll_result(self, session_id: str) -> dict[str, object]:
        with self._lock:
            session = self._sessions.get(session_id)
            if session is None:
                raise KeyError(session_id)
            if session.runtime_state != "running" or session.context is None:
                return {
                    "active": False,
                    "qr_status": "opening",
                    "login_page": None,
                    "qr_image_data_url": None,
                }
            worker = session.worker
            context = session.context
            start_generation = session.start_generation
        if worker is None:
            return {"active": False, "qr_status": "opening"}

        with session.command_lock:
            with self._lock:
                if (
                    self._sessions.get(session_id) is not session
                    or self._account_generations.get(session.account_digest)
                    != start_generation
                    or session.context is not context
                ):
                    raise KeyError(session_id)
            try:
                result = worker.poll_douyin_login(context)
            except asyncio.CancelledError:
                self.cancel_login(session_id)
                raise
            except Exception as error:
                # This exact worker error means the handle no longer owns a
                # Context. Retrying detection cannot make that session usable.
                if (isinstance(error, RuntimeError)
                        and str(error) == "douyin_browser_context_closed"):
                    self._mark_failed(session, error)
                    return {"active": False, "qr_status": "opening"}
                with self._lock:
                    if (
                        self._sessions.get(session_id) is session
                        and self._account_generations.get(
                            session.account_digest
                        )
                        == start_generation
                        and session.context is context
                    ):
                        session.diagnostic = LocalBrowserDiagnostic(
                            code="douyin_login_detection_unavailable",
                            message=(
                                "Login detection is temporarily unavailable; "
                                "the external browser remains open."
                            ),
                            recoverable=True,
                            occurred_at=self._now(),
                        )
                LOGGER.info(
                    "local_douyin_login auth_check_recoverable "
                    "session_id=%s generation=%d error_type=%s",
                    session.session_id,
                    start_generation,
                    type(error).__name__,
                )
                return {
                    "active": False,
                    "qr_status": "opening",
                    "login_page": None,
                    "qr_image_data_url": None,
                }

            with self._lock:
                if (
                    self._sessions.get(session_id) is not session
                    or self._account_generations.get(session.account_digest)
                    != start_generation
                    or session.context is not context
                ):
                    raise KeyError(session_id)
                session.diagnostic = None
                if result.get("active") is True:
                    session.auth_state = "authenticated"
                    session.task_state = "completed"
                elif result.get("qr_status") == "verification_required":
                    session.auth_state = "verification_required"
                else:
                    session.auth_state = "waiting_for_user"

            if result.get("active") is True:
                self._close_resources(session, abort=False)
                with self._lock:
                    session.runtime_state = "stopped"
                    if (
                        self._current_by_account.get(session.account_digest)
                        == session.session_id
                    ):
                        self._current_by_account.pop(session.account_digest, None)
                LOGGER.info(
                    "local_douyin_login authenticated session_id=%s "
                    "generation=%d",
                    session.session_id,
                    start_generation,
                )
            return dict(result)

    def confirm_login(self, session_id: str) -> LocalBrowserSessionStatus:
        self._poll_result(session_id)
        return self.get_status(session_id)

    def cancel_login(self, session_id: str) -> LocalBrowserSessionStatus:
        with self._lock:
            session = self._sessions.get(session_id)
            if session is None:
                raise KeyError(session_id)
            if session.task_state == "completed" and session.runtime_state == "stopped":
                return self._snapshot_locked(session)
            next_generation = max(
                self._account_generations.get(session.account_digest, 0),
                session.generation,
            ) + 1
            self._account_generations[session.account_digest] = next_generation
            session.generation = next_generation
            session.task_state = "cancelling"
            task = session.task
            if (
                self._current_by_account.get(session.account_digest)
                == session.session_id
            ):
                self._current_by_account.pop(session.account_digest, None)
        if task is not None:
            self._loop.call_soon_threadsafe(task.cancel)
        self._close_resources(session, abort=True)
        self._mark_cancelled(session)
        LOGGER.info(
            "local_douyin_login cancel_requested session_id=%s generation=%d",
            session.session_id,
            next_generation,
        )
        with self._lock:
            return self._snapshot_locked(session)

    def close_session(self, session_id: str) -> LocalBrowserSessionStatus:
        with self._lock:
            session = self._sessions.get(session_id)
            if session is None:
                raise KeyError(session_id)
            already_stopped = (
                session.runtime_state == "stopped" and session.worker_closed
            )
            task = session.task
        if not already_stopped and task is not None and not task.done():
            self._loop.call_soon_threadsafe(task.cancel)
        self._close_resources(session, abort=not already_stopped)
        with self._lock:
            session.runtime_state = "stopped"
            session.task_state = "completed"
            if session.auth_state not in {"authenticated", "expired"}:
                session.auth_state = "unknown"
            if (
                self._current_by_account.get(session.account_digest)
                == session.session_id
            ):
                self._current_by_account.pop(session.account_digest, None)
            status = self._snapshot_locked(session)
        if not already_stopped:
            LOGGER.info(
                "local_douyin_login context_closed session_id=%s generation=%d",
                session.session_id,
                session.generation,
            )
        return status

    def start_collection(
        self,
        account_key: str,
        task: Callable[[Path], _T],
    ) -> _T:
        digest = _account_digest(account_key)
        with self._lock:
            if self._closed:
                raise RuntimeError("local_browser_session_manager_closed")
            profile = self._profile_by_account.get(
                digest,
                self._profile_root / digest,
            )
            account_lock = self._account_locks.setdefault(
                digest,
                threading.Lock(),
            )
        if not profile.is_dir():
            raise KeyError("local_browser_profile_not_found")
        with account_lock:
            with acquire_profile_lease(profile, self._lease_root):
                return task(profile)

    @staticmethod
    def _handle(context: object) -> str:
        if not isinstance(context, dict):
            raise RuntimeError("douyin_browser_context_invalid")
        handle = context.get("handle")
        if not isinstance(handle, str) or not handle:
            raise RuntimeError("douyin_browser_context_invalid")
        return handle

    # BrowserState-compatible facade used by AccountManager.  The opaque
    # handle is the only object allowed to cross this ownership boundary.
    def open_douyin_login(self, profile_path: Path) -> dict[str, object]:
        status = self.start_login(
            Path(profile_path).name,
            profile_path=Path(profile_path),
        )
        return {
            "handle": status.session_id,
            "login_page": None,
            "qr_status": "opening",
            "qr_image_data_url": None,
        }

    def poll_douyin_login(self, context: object) -> dict[str, object]:
        return self._poll_result(self._handle(context))

    def close(self, context: object) -> None:
        # AccountManager uses ``close`` for an explicit login cancellation.
        # Route that boundary through task.cancel() + session-scoped abort so
        # an in-flight Playwright launch cannot keep the account profile busy.
        self.cancel_login(self._handle(context))

    def abort_douyin_login(self, context: object) -> None:
        """Preempt one owned login without waiting for an outer I/O lease."""
        try:
            self.cancel_login(self._handle(context))
        except KeyError:
            # Cancellation is idempotent across the outer AccountManager and
            # its detached cleanup thread.
            return

    def abort_douyin_profile(self, profile_path: Path) -> None:
        """Preempt the current login generation that owns ``profile_path``."""
        canonical = Path(profile_path).expanduser().resolve()
        with self._lock:
            session_id = next(
                (
                    current_id
                    for current_id in self._current_by_account.values()
                    if (session := self._sessions.get(current_id)) is not None
                    and session.profile_path == canonical
                ),
                None,
            )
        if session_id is None:
            return
        try:
            self.cancel_login(session_id)
        except KeyError:
            return

    def execute_douyin_action(
        self,
        profile_path: Path,
        request: Any,
        *,
        authority_validator: Callable[[], None],
    ) -> dict[str, object]:
        worker = self._browser_factory()
        try:
            execute = getattr(worker, "execute_douyin_action")
            return execute(
                profile_path,
                request,
                authority_validator=authority_validator,
            )
        finally:
            worker.close_browser()

    def reconcile_douyin_action(
        self,
        profile_path: Path,
        request: Any,
        *,
        authority_validator: Callable[[], None],
    ) -> dict[str, object]:
        worker = self._browser_factory()
        try:
            reconcile = getattr(worker, "reconcile_douyin_action")
            return reconcile(
                profile_path,
                request,
                authority_validator=authority_validator,
            )
        finally:
            worker.close_browser()

    def close_browser(self) -> None:
        self.shutdown()

    def shutdown(self) -> None:
        with self._lock:
            if self._closed:
                return
            self._closed = True
            sessions = list(self._sessions.values())
            tasks = [session.task for session in sessions if session.task]
            for session in sessions:
                session.task_state = "cancelling"
                self._account_generations[session.account_digest] = max(
                    self._account_generations.get(session.account_digest, 0),
                    session.generation,
                ) + 1
                session.generation = self._account_generations[
                    session.account_digest
                ]
            self._current_by_account.clear()
        for task in tasks:
            self._loop.call_soon_threadsafe(task.cancel)
        for session in sessions:
            self._close_resources(session, abort=True)
            self._mark_cancelled(session)
        self._loop.call_soon_threadsafe(self._loop.stop)
        self._loop_thread.join(timeout=3)
        if self._loop_thread.is_alive():
            raise RuntimeError("local_browser_session_manager_shutdown_timeout")
