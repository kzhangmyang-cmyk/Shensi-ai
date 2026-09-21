from __future__ import annotations

import asyncio
import logging
import os
import subprocess
import stat
import sys
import threading
import time
from collections.abc import Callable
from pathlib import Path

import pytest

from shensi_adapter.profile_lease import (
    ProfileLeaseBusy,
    acquire_profile_lease,
)


def _manager_type():
    # Keep the import local so the first RED run enumerates the missing
    # contract across tests instead of failing once during collection.
    from shensi_adapter.local_browser_session_manager import (
        LocalBrowserSessionManager,
    )

    return LocalBrowserSessionManager


class FakeLocalBrowserWorker:
    def __init__(
        self,
        *,
        block_open: bool = False,
        open_error: BaseException | None = None,
        poll_result: dict[str, object] | None = None,
        poll_error: Exception | None = None,
    ) -> None:
        self.open_started = threading.Event()
        self.release_open = threading.Event()
        if not block_open:
            self.release_open.set()
        self.open_error = open_error
        self.poll_result = poll_result or {"active": False}
        self.poll_error = poll_error
        self.open_paths: list[Path] = []
        self.open_handles: list[dict[str, object]] = []
        self.poll_calls = 0
        self.prepare_calls = 0
        self.remote_display_calls = 0
        self.live_session_calls = 0
        self.close_calls: list[object] = []
        self.abort_calls = 0
        self.close_browser_calls = 0

    def open_douyin_login(self, profile_path: Path) -> dict[str, object]:
        self.open_paths.append(Path(profile_path))
        self.open_started.set()
        if not self.release_open.wait(timeout=3):
            raise TimeoutError("fixture open gate timed out")
        if self.open_error is not None:
            raise self.open_error
        handle = {
            "handle": f"handle-{id(self)}",
            "login_page": None,
            "qr_status": "opening",
            "qr_image_data_url": None,
        }
        self.open_handles.append(handle)
        return handle

    def prepare_douyin_login(self, _context: object) -> dict[str, object]:
        self.prepare_calls += 1
        raise RuntimeError("douyin_qr_dom_not_found")

    def start_live_display(self) -> None:
        self.remote_display_calls += 1
        raise AssertionError("desktop login must not start VNC/noVNC")

    def create_live_session(self) -> None:
        self.live_session_calls += 1
        raise AssertionError("desktop login must not create /live-sessions")

    def poll_douyin_login(self, _context: object) -> dict[str, object]:
        self.poll_calls += 1
        if self.poll_error is not None:
            raise self.poll_error
        return dict(self.poll_result)

    def close(self, context: object) -> None:
        self.close_calls.append(context)

    def abort_browser(self) -> None:
        self.abort_calls += 1
        # A real session-scoped abort terminates the child browser process and
        # therefore unblocks an in-flight open command. Mirror that ownership
        # boundary so the replacement session cannot overlap the stale worker.
        self.release_open.set()

    def close_browser(self) -> None:
        self.close_browser_calls += 1


class BrowserWorkerFactory:
    def __init__(self, workers: list[FakeLocalBrowserWorker]) -> None:
        self._workers = list(workers)
        self.created: list[FakeLocalBrowserWorker] = []
        self._lock = threading.Lock()

    def __call__(self) -> FakeLocalBrowserWorker:
        with self._lock:
            if not self._workers:
                raise AssertionError("unexpected extra browser worker")
            worker = self._workers.pop(0)
            self.created.append(worker)
            return worker


class SerializedPollWorker(FakeLocalBrowserWorker):
    """Model BrowserState's single command lock around poll and close."""

    def __init__(self) -> None:
        super().__init__()
        self.command_lock = threading.Lock()
        self.poll_started = threading.Event()
        self.release_poll = threading.Event()
        self.lifecycle_calls: list[str] = []

    def poll_douyin_login(self, _context: object) -> dict[str, object]:
        with self.command_lock:
            self.poll_started.set()
            if not self.release_poll.wait(timeout=2):
                raise TimeoutError("fixture poll gate timed out")
            return {"active": False}

    def close(self, context: object) -> None:
        with self.command_lock:
            self.lifecycle_calls.append("close")
            super().close(context)

    def abort_browser(self) -> None:
        self.lifecycle_calls.append("abort")
        self.release_poll.set()
        super().abort_browser()


class BlockingFirstFactory:
    """Block worker construction without touching the account profile."""

    def __init__(
        self,
        first: FakeLocalBrowserWorker,
        second: FakeLocalBrowserWorker | None = None,
    ) -> None:
        self.first = first
        self.second = second
        self.first_started = threading.Event()
        self.release_first = threading.Event()
        self.second_started = threading.Event()
        self._calls = 0
        self._lock = threading.Lock()

    def __call__(self) -> FakeLocalBrowserWorker:
        with self._lock:
            self._calls += 1
            call = self._calls
        if call == 1:
            self.first_started.set()
            if not self.release_first.wait(timeout=3):
                raise TimeoutError("fixture browser factory gate timed out")
            return self.first
        if call == 2 and self.second is not None:
            self.second_started.set()
            return self.second
        raise AssertionError("unexpected extra browser worker")


def _wait_for_status(
    manager,
    session_id: str,
    predicate: Callable[[object], bool],
    *,
    timeout: float = 2,
):
    deadline = time.monotonic() + timeout
    latest = manager.get_status(session_id)
    while time.monotonic() < deadline:
        latest = manager.get_status(session_id)
        if predicate(latest):
            return latest
        time.sleep(0.01)
    pytest.fail(f"session did not reach expected status: {latest!r}")


def _wait_for_worker(factory: BrowserWorkerFactory, count: int, timeout=1):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if len(factory.created) >= count:
            return factory.created[count - 1]
        time.sleep(0.005)
    pytest.fail(f"browser factory did not create worker {count}")


def _new_manager(tmp_path, *workers: FakeLocalBrowserWorker):
    manager_type = _manager_type()
    factory = BrowserWorkerFactory(list(workers))
    manager = manager_type(tmp_path / "profiles", browser_factory=factory)
    return manager, factory


def _profile_lease_child_exit_code(profile: Path, lease_root: Path) -> int:
    program = """
import sys
from pathlib import Path
from shensi_adapter.profile_lease import ProfileLeaseBusy, acquire_profile_lease

try:
    lease = acquire_profile_lease(Path(sys.argv[1]), Path(sys.argv[2]))
except ProfileLeaseBusy:
    raise SystemExit(23)
else:
    lease.release()
"""
    package_root = Path(__file__).resolve().parents[2]
    python_path = os.pathsep.join(filter(None, (
        str(package_root),
        os.environ.get("PYTHONPATH", ""),
    )))
    completed = subprocess.run(
        [sys.executable, "-c", program, str(profile), str(lease_root)],
        check=False,
        capture_output=True,
        text=True,
        env={**os.environ, "PYTHONPATH": python_path},
    )
    return completed.returncode


def test_start_login_registers_an_operable_context_without_qr_or_screenshot(
    tmp_path,
):
    worker = FakeLocalBrowserWorker()
    manager, factory = _new_manager(tmp_path, worker)
    try:
        started = manager.start_login("workspace-account-a")
        waiting = _wait_for_status(
            manager,
            started.session_id,
            lambda value: value.runtime_state == "running",
        )

        assert factory.created == [worker]
        assert waiting.auth_state == "waiting_for_user"
        assert waiting.task_state == "idle"
        assert waiting.screenshot_available is False
        assert waiting.qr_available is False
        assert worker.open_paths
        assert worker.prepare_calls == 0
        assert worker.remote_display_calls == 0
        assert worker.live_session_calls == 0
        assert worker.close_calls == []
    finally:
        manager.shutdown()


@pytest.mark.parametrize("session_id", [
    "_6NYK8JUrP5FTmGHATnkQsFI8oBhjR6V",
    "-6NYK8JUrP5FTmGHATnkQsFI8oBhjR6V",
])
def test_generated_urlsafe_session_id_round_trips_for_status_and_cancel(
    tmp_path, monkeypatch, session_id,
):
    from shensi_adapter import local_browser_session_manager as module

    monkeypatch.setattr(module.secrets, "token_urlsafe", lambda size: session_id)
    manager, _factory = _new_manager(tmp_path, FakeLocalBrowserWorker())
    try:
        started = manager.start_login("workspace-account-a")
        assert started.session_id == session_id
        assert manager.get_status(session_id).session_id == session_id
        assert manager.cancel_login(session_id).session_id == session_id
    finally:
        manager.shutdown()


def test_each_account_gets_an_independent_private_stable_profile(tmp_path):
    first_worker = FakeLocalBrowserWorker()
    second_worker = FakeLocalBrowserWorker()
    manager, _factory = _new_manager(tmp_path, first_worker, second_worker)
    try:
        first = manager.start_login("customer-phone-13800000000")
        second = manager.start_login("different-account")
        _wait_for_status(
            manager, first.session_id,
            lambda value: value.runtime_state == "running",
        )
        _wait_for_status(
            manager, second.session_id,
            lambda value: value.runtime_state == "running",
        )

        first_path = first_worker.open_paths[0]
        second_path = second_worker.open_paths[0]
        assert first_path != second_path
        assert first_path.parent == tmp_path / "profiles"
        assert second_path.parent == tmp_path / "profiles"
        assert "13800000000" not in first_path.name
        assert stat.S_IMODE(first_path.stat().st_mode) == 0o700
        assert stat.S_IMODE(second_path.stat().st_mode) == 0o700
    finally:
        manager.shutdown()


def test_explicit_profile_path_is_supported_but_not_required(tmp_path):
    worker = FakeLocalBrowserWorker()
    manager, _factory = _new_manager(tmp_path, worker)
    explicit = tmp_path / "electron-app-data" / "profiles" / "douyin" / "safe"
    try:
        started = manager.start_login(
            "workspace-account",
            profile_path=explicit,
        )
        _wait_for_status(
            manager, started.session_id,
            lambda value: value.runtime_state == "running",
        )

        assert worker.open_paths == [explicit]
        assert stat.S_IMODE(explicit.stat().st_mode) == 0o700
    finally:
        manager.shutdown()


def test_repeated_start_for_same_account_is_idempotent(tmp_path):
    worker = FakeLocalBrowserWorker(block_open=True)
    manager, factory = _new_manager(tmp_path, worker)
    try:
        first = manager.start_login("same-account")
        assert worker.open_started.wait(1)
        duplicate = manager.start_login("same-account")

        assert duplicate.session_id == first.session_id
        assert duplicate.generation == first.generation
        assert factory.created == [worker]
    finally:
        worker.release_open.set()
        manager.shutdown()


def test_different_accounts_start_in_parallel_without_a_global_browser_lock(
    tmp_path,
):
    first_worker = FakeLocalBrowserWorker(block_open=True)
    second_worker = FakeLocalBrowserWorker(block_open=True)
    manager, factory = _new_manager(tmp_path, first_worker, second_worker)
    try:
        manager.start_login("account-one")
        assert first_worker.open_started.wait(1)
        manager.start_login("account-two")

        assert second_worker.open_started.wait(1)
        assert factory.created == [first_worker, second_worker]
    finally:
        first_worker.release_open.set()
        second_worker.release_open.set()
        manager.shutdown()


def test_confirm_login_selector_failure_is_recoverable_and_keeps_context(
    tmp_path,
):
    worker = FakeLocalBrowserWorker(
        poll_error=RuntimeError("douyin_qr_dom_not_found"),
    )
    manager, _factory = _new_manager(tmp_path, worker)
    try:
        started = manager.start_login("selector-change-account")
        _wait_for_status(
            manager, started.session_id,
            lambda value: value.runtime_state == "running",
        )

        checked = manager.confirm_login(started.session_id)

        assert checked.runtime_state == "running"
        assert checked.auth_state == "waiting_for_user"
        assert checked.diagnostic.recoverable is True
        assert worker.close_calls == []
        assert worker.close_browser_calls == 0
    finally:
        manager.shutdown()


def test_confirm_closed_context_retires_session_and_reopens_same_profile(tmp_path):
    closed_worker = FakeLocalBrowserWorker(
        poll_error=RuntimeError("douyin_browser_context_closed"),
    )
    replacement_worker = FakeLocalBrowserWorker()
    manager, factory = _new_manager(tmp_path, closed_worker, replacement_worker)
    try:
        first = manager.start_login("closed-context-account")
        _wait_for_status(
            manager, first.session_id,
            lambda value: value.runtime_state == "running",
        )

        checked = manager.confirm_login(first.session_id)

        assert checked.runtime_state == "crashed"
        assert checked.task_state == "failed"
        assert checked.auth_state != "authenticated"
        assert closed_worker.close_browser_calls == 1
        replacement = manager.start_login("closed-context-account")
        running = _wait_for_status(
            manager, replacement.session_id,
            lambda value: value.runtime_state == "running",
        )
        assert replacement.session_id != first.session_id
        assert running.profile_path == first.profile_path
        assert factory.created == [closed_worker, replacement_worker]
        assert replacement_worker.open_paths == closed_worker.open_paths
    finally:
        manager.shutdown()


def test_cancel_aborts_only_the_target_worker_and_invalidates_its_generation(
    tmp_path,
):
    first_worker = FakeLocalBrowserWorker(block_open=True)
    second_worker = FakeLocalBrowserWorker(block_open=True)
    manager, _factory = _new_manager(tmp_path, first_worker, second_worker)
    try:
        first = manager.start_login("cancel-me")
        second = manager.start_login("keep-running")
        assert first_worker.open_started.wait(1)
        assert second_worker.open_started.wait(1)

        cancelled = manager.cancel_login(first.session_id)

        assert cancelled.generation > first.generation
        assert cancelled.runtime_state == "stopped"
        assert cancelled.task_state == "completed"
        assert first_worker.abort_calls == 1
        assert second_worker.abort_calls == 0
    finally:
        first_worker.release_open.set()
        second_worker.release_open.set()
        manager.shutdown()


def test_login_holds_cross_process_profile_lease_until_cancel(tmp_path):
    worker = FakeLocalBrowserWorker()
    lease_root = tmp_path / "state"
    manager = _manager_type()(
        tmp_path / "profiles",
        lease_root=lease_root,
        browser_factory=BrowserWorkerFactory([worker]),
    )
    try:
        started = manager.start_login("leased-login-account")
        running = _wait_for_status(
            manager,
            started.session_id,
            lambda value: value.runtime_state == "running",
        )

        assert _profile_lease_child_exit_code(
            running.profile_path,
            lease_root,
        ) == 23

        manager.cancel_login(started.session_id)

        assert _profile_lease_child_exit_code(
            running.profile_path,
            lease_root,
        ) == 0
    finally:
        manager.shutdown()


def test_cancel_releases_profile_lease_only_after_context_and_worker_close(
    tmp_path,
):
    lease_root = tmp_path / "state"
    observations: list[tuple[str, bool]] = []

    class LeaseOrderingWorker(FakeLocalBrowserWorker):
        def _observe_lease(self, stage: str) -> None:
            try:
                lease = acquire_profile_lease(self.open_paths[0], lease_root)
            except ProfileLeaseBusy:
                observations.append((stage, True))
            else:
                observations.append((stage, False))
                lease.release()

        def abort_browser(self) -> None:
            self._observe_lease("abort")
            super().abort_browser()

        def close_browser(self) -> None:
            self._observe_lease("worker_close")
            super().close_browser()

        def close(self, context: object) -> None:
            self._observe_lease("context_close")
            super().close(context)

    worker = LeaseOrderingWorker()
    manager = _manager_type()(
        tmp_path / "profiles",
        lease_root=lease_root,
        browser_factory=BrowserWorkerFactory([worker]),
    )
    try:
        started = manager.start_login("lease-close-order")
        running = _wait_for_status(
            manager,
            started.session_id,
            lambda value: value.runtime_state == "running",
        )

        manager.cancel_login(started.session_id)

        assert observations == [
            ("abort", True),
            ("worker_close", True),
            ("context_close", True),
        ]
        lease = acquire_profile_lease(running.profile_path, lease_root)
        lease.release()
    finally:
        manager.shutdown()


def test_concurrent_cancel_cleanup_cannot_release_lease_before_abort_finishes(
    tmp_path,
):
    lease_root = tmp_path / "state"

    class BlockingAbortWorker(FakeLocalBrowserWorker):
        def __init__(self) -> None:
            super().__init__(block_open=True)
            self.abort_started = threading.Event()
            self.release_abort = threading.Event()

        def abort_browser(self) -> None:
            self.abort_started.set()
            self.release_open.set()
            assert self.release_abort.wait(timeout=2)
            super().abort_browser()

    worker = BlockingAbortWorker()
    manager = _manager_type()(
        tmp_path / "profiles",
        lease_root=lease_root,
        browser_factory=BrowserWorkerFactory([worker]),
    )
    started = manager.start_login("concurrent-cancel-cleanup")
    assert worker.open_started.wait(timeout=1)
    cancel_errors: list[BaseException] = []

    def cancel():
        try:
            manager.cancel_login(started.session_id)
        except BaseException as error:
            cancel_errors.append(error)

    canceller = threading.Thread(target=cancel)
    canceller.start()
    assert worker.abort_started.wait(timeout=1)
    try:
        with pytest.raises(ProfileLeaseBusy, match="^douyin_profile_busy$"):
            acquire_profile_lease(started.profile_path, lease_root)
    finally:
        worker.release_abort.set()
        canceller.join(timeout=1)
        manager.shutdown()

    assert not canceller.is_alive()
    assert cancel_errors == []
    lease = acquire_profile_lease(started.profile_path, lease_root)
    lease.release()


def test_cancel_keeps_profile_lease_until_in_flight_open_returns(tmp_path):
    lease_root = tmp_path / "state"

    class NonCooperativeOpenWorker(FakeLocalBrowserWorker):
        def __init__(self) -> None:
            super().__init__(block_open=True)

        def abort_browser(self) -> None:
            self.abort_calls += 1

    worker = NonCooperativeOpenWorker()
    manager = _manager_type()(
        tmp_path / "profiles",
        lease_root=lease_root,
        browser_factory=BrowserWorkerFactory([worker]),
    )
    started = manager.start_login("in-flight-open-lease")
    assert worker.open_started.wait(timeout=1)

    cancel_started = time.monotonic()
    manager.cancel_login(started.session_id)
    assert time.monotonic() - cancel_started < 0.3

    try:
        with pytest.raises(ProfileLeaseBusy, match="^douyin_profile_busy$"):
            acquire_profile_lease(started.profile_path, lease_root)

        worker.release_open.set()
        deadline = time.monotonic() + 1
        while not worker.close_calls and time.monotonic() < deadline:
            time.sleep(0.01)
        assert worker.close_calls == worker.open_handles

        lease = acquire_profile_lease(started.profile_path, lease_root)
        lease.release()
    finally:
        worker.release_open.set()
        manager.shutdown()


def test_login_profile_lease_blocks_collection_until_context_closes(tmp_path):
    worker = FakeLocalBrowserWorker()
    lease_root = tmp_path / "state"
    manager = _manager_type()(
        tmp_path / "profiles",
        lease_root=lease_root,
        browser_factory=BrowserWorkerFactory([worker]),
    )
    collected: list[Path] = []
    try:
        started = manager.start_login("login-before-collection")
        _wait_for_status(
            manager,
            started.session_id,
            lambda value: value.runtime_state == "running",
        )

        with pytest.raises(ProfileLeaseBusy, match="^douyin_profile_busy$"):
            manager.start_collection(
                "login-before-collection",
                lambda profile: collected.append(profile),
            )
        assert collected == []

        manager.cancel_login(started.session_id)
        manager.start_collection(
            "login-before-collection",
            lambda profile: collected.append(profile),
        )

        assert collected == [started.profile_path]
    finally:
        manager.shutdown()


def test_profile_lease_conflict_is_reported_as_recoverable(tmp_path):
    worker = FakeLocalBrowserWorker()
    lease_root = tmp_path / "state"
    explicit_profile = tmp_path / "profiles" / "leased-elsewhere"
    explicit_profile.mkdir(parents=True)
    external_lease = acquire_profile_lease(explicit_profile, lease_root)
    manager = _manager_type()(
        tmp_path / "profiles",
        lease_root=lease_root,
        browser_factory=BrowserWorkerFactory([worker]),
    )
    try:
        started = manager.start_login(
            "profile-busy-account",
            profile_path=explicit_profile,
        )
        failed = _wait_for_status(
            manager,
            started.session_id,
            lambda value: value.task_state == "failed",
        )

        assert failed.runtime_state == "crashed"
        assert failed.diagnostic is not None
        assert failed.diagnostic.code == "douyin_profile_busy"
        assert failed.diagnostic.recoverable is True
        assert worker.open_started.is_set() is False
    finally:
        manager.shutdown()
        external_lease.release()


def test_cancel_aborts_before_graceful_close_when_poll_holds_command_lock(
    tmp_path,
):
    worker = SerializedPollWorker()
    manager, _factory = _new_manager(tmp_path, worker)
    poll_errors: list[BaseException] = []
    watchdog = threading.Timer(1, worker.release_poll.set)
    try:
        started = manager.start_login("cancel-blocked-poll")
        _wait_for_status(
            manager,
            started.session_id,
            lambda value: value.runtime_state == "running",
        )

        def poll() -> None:
            try:
                manager.confirm_login(started.session_id)
            except BaseException as error:
                poll_errors.append(error)

        poller = threading.Thread(target=poll)
        poller.start()
        assert worker.poll_started.wait(timeout=1)
        watchdog.start()

        cancel_started = time.monotonic()
        cancelled = manager.cancel_login(started.session_id)
        cancel_elapsed = time.monotonic() - cancel_started
        poller.join(timeout=1)

        assert cancel_elapsed < 0.3
        assert cancelled.runtime_state == "stopped"
        assert cancelled.task_state == "completed"
        assert worker.lifecycle_calls[0] == "abort"
        assert worker.abort_calls == 1
        assert worker.close_calls == worker.open_handles
        assert not poller.is_alive()
        assert len(poll_errors) == 1
        assert isinstance(poll_errors[0], KeyError)
    finally:
        watchdog.cancel()
        worker.release_poll.set()
        manager.shutdown()


def test_close_session_is_bounded_when_poll_holds_command_lock(tmp_path):
    worker = SerializedPollWorker()
    manager, _factory = _new_manager(tmp_path, worker)
    watchdog = threading.Timer(1, worker.release_poll.set)
    poll_errors: list[BaseException] = []
    poller = None
    try:
        started = manager.start_login("close-blocked-poll")
        _wait_for_status(
            manager,
            started.session_id,
            lambda value: value.runtime_state == "running",
        )

        def poll() -> None:
            try:
                manager.confirm_login(started.session_id)
            except BaseException as error:
                poll_errors.append(error)

        poller = threading.Thread(target=poll)
        poller.start()
        assert worker.poll_started.wait(timeout=1)
        watchdog.start()

        close_started = time.monotonic()
        closed = manager.close_session(started.session_id)
        close_elapsed = time.monotonic() - close_started
        poller.join(timeout=1)

        assert close_elapsed < 0.3
        assert closed.runtime_state == "stopped"
        assert worker.lifecycle_calls[0] == "abort"
        assert not poller.is_alive()
        assert len(poll_errors) == 1
        assert isinstance(poll_errors[0], KeyError)
    finally:
        watchdog.cancel()
        worker.release_poll.set()
        if poller is not None:
            poller.join(timeout=1)
        manager.shutdown()


def test_cancel_during_blocked_factory_does_not_hold_the_account_profile_lock(
    tmp_path,
):
    stale_worker = FakeLocalBrowserWorker()
    replacement_worker = FakeLocalBrowserWorker()
    factory = BlockingFirstFactory(stale_worker, replacement_worker)
    manager = _manager_type()(
        tmp_path / "profiles",
        browser_factory=factory,
    )
    try:
        stale = manager.start_login("factory-blocked-account")
        assert factory.first_started.wait(timeout=1)

        cancel_started = time.monotonic()
        manager.cancel_login(stale.session_id)
        assert time.monotonic() - cancel_started < 0.3

        replacement = manager.start_login("factory-blocked-account")
        assert factory.second_started.wait(timeout=0.3)
        current = _wait_for_status(
            manager,
            replacement.session_id,
            lambda value: value.runtime_state == "running",
        )

        assert current.session_id == replacement.session_id
        assert replacement_worker.open_started.is_set()
        assert stale_worker.open_started.is_set() is False

        factory.release_first.set()
        deadline = time.monotonic() + 1
        while stale_worker.abort_calls == 0 and time.monotonic() < deadline:
            time.sleep(0.01)
        assert stale_worker.abort_calls == 1
        assert stale_worker.close_browser_calls == 1
        assert replacement_worker.abort_calls == 0
    finally:
        factory.release_first.set()
        manager.shutdown()


def test_shutdown_is_bounded_while_browser_factory_is_blocked(tmp_path):
    late_worker = FakeLocalBrowserWorker()
    factory = BlockingFirstFactory(late_worker)
    manager = _manager_type()(
        tmp_path / "profiles",
        browser_factory=factory,
    )
    manager.start_login("shutdown-blocked-factory")
    assert factory.first_started.wait(timeout=1)

    shutdown_started = time.monotonic()
    manager.shutdown()
    shutdown_elapsed = time.monotonic() - shutdown_started

    assert shutdown_elapsed < 0.3
    factory.release_first.set()
    deadline = time.monotonic() + 1
    while late_worker.abort_calls == 0 and time.monotonic() < deadline:
        time.sleep(0.01)
    assert late_worker.abort_calls == 1
    assert late_worker.close_browser_calls == 1
    assert late_worker.open_started.is_set() is False


def test_late_open_cannot_overwrite_replacement_session_or_close_new_context(
    tmp_path,
):
    stale_worker = FakeLocalBrowserWorker(block_open=True)
    current_worker = FakeLocalBrowserWorker()
    manager, _factory = _new_manager(tmp_path, stale_worker, current_worker)
    try:
        stale = manager.start_login("replace-account")
        assert stale_worker.open_started.wait(1)
        manager.cancel_login(stale.session_id)

        replacement = manager.start_login("replace-account")
        current = _wait_for_status(
            manager,
            replacement.session_id,
            lambda value: value.runtime_state == "running",
        )
        stale_worker.release_open.set()
        deadline = time.monotonic() + 1
        while not stale_worker.close_calls and time.monotonic() < deadline:
            time.sleep(0.01)

        observed = manager.get_status(replacement.session_id)
        assert observed.session_id == current.session_id
        assert observed.generation == current.generation
        assert observed.runtime_state == "running"
        assert stale_worker.close_calls == stale_worker.open_handles
        assert current_worker.close_calls == []
        assert current_worker.abort_calls == 0
    finally:
        stale_worker.release_open.set()
        manager.shutdown()


def test_close_session_is_idempotent(tmp_path):
    worker = FakeLocalBrowserWorker()
    manager, _factory = _new_manager(tmp_path, worker)
    try:
        started = manager.start_login("close-once")
        _wait_for_status(
            manager, started.session_id,
            lambda value: value.runtime_state == "running",
        )

        manager.close_session(started.session_id)
        manager.close_session(started.session_id)

        assert worker.close_calls == worker.open_handles
        assert worker.close_browser_calls == 1
    finally:
        manager.shutdown()


def test_fatal_post_context_startup_error_cleans_worker_resources(tmp_path):
    worker = FakeLocalBrowserWorker(
        open_error=RuntimeError("context_created_then_navigation_failed"),
    )
    manager, _factory = _new_manager(tmp_path, worker)
    try:
        started = manager.start_login("fatal-startup")
        failed = _wait_for_status(
            manager,
            started.session_id,
            lambda value: value.task_state == "failed",
        )

        assert failed.runtime_state == "crashed"
        assert failed.diagnostic.recoverable is False
        assert worker.abort_calls == 1
        assert worker.close_browser_calls == 1
    finally:
        manager.shutdown()


def test_asyncio_cancelled_error_is_not_converted_to_a_failure(tmp_path):
    worker = FakeLocalBrowserWorker(open_error=asyncio.CancelledError())
    manager, _factory = _new_manager(tmp_path, worker)
    try:
        started = manager.start_login("cancelled-error")
        cancelled = _wait_for_status(
            manager,
            started.session_id,
            lambda value: value.runtime_state == "stopped",
        )

        assert cancelled.task_state == "completed"
        assert cancelled.diagnostic is None
        assert worker.abort_calls == 1
        assert worker.close_browser_calls == 1
    finally:
        manager.shutdown()


def test_authenticated_profile_is_retained_and_reused_for_collection(tmp_path):
    worker = FakeLocalBrowserWorker(poll_result={"active": True})
    manager, _factory = _new_manager(tmp_path, worker)
    captured_profiles: list[Path] = []
    try:
        started = manager.start_login("collection-account")
        _wait_for_status(
            manager, started.session_id,
            lambda value: value.runtime_state == "running",
        )
        authenticated = manager.confirm_login(started.session_id)
        result = manager.start_collection(
            "collection-account",
            lambda profile: captured_profiles.append(profile) or "collected",
        )

        assert authenticated.auth_state == "authenticated"
        assert worker.close_calls == worker.open_handles
        assert result == "collected"
        assert captured_profiles == worker.open_paths
        assert captured_profiles[0].is_dir()
    finally:
        manager.shutdown()


def test_same_account_reuses_profile_after_manager_restart(tmp_path):
    root = tmp_path / "profiles"
    first_worker = FakeLocalBrowserWorker(poll_result={"active": True})
    first_factory = BrowserWorkerFactory([first_worker])
    manager_type = _manager_type()
    first_manager = manager_type(root, browser_factory=first_factory)
    first = first_manager.start_login("stable-workspace-account")
    _wait_for_status(
        first_manager, first.session_id,
        lambda value: value.runtime_state == "running",
    )
    first_manager.confirm_login(first.session_id)
    first_manager.shutdown()

    second_worker = FakeLocalBrowserWorker()
    second_factory = BrowserWorkerFactory([second_worker])
    second_manager = manager_type(root, browser_factory=second_factory)
    try:
        second = second_manager.start_login("stable-workspace-account")
        _wait_for_status(
            second_manager, second.session_id,
            lambda value: value.runtime_state == "running",
        )

        assert second_worker.open_paths == first_worker.open_paths
    finally:
        second_manager.shutdown()


def test_shutdown_closes_every_owned_context_and_worker(tmp_path):
    first_worker = FakeLocalBrowserWorker()
    second_worker = FakeLocalBrowserWorker()
    manager, _factory = _new_manager(tmp_path, first_worker, second_worker)
    first = manager.start_login("shutdown-one")
    second = manager.start_login("shutdown-two")
    _wait_for_status(
        manager, first.session_id,
        lambda value: value.runtime_state == "running",
    )
    _wait_for_status(
        manager, second.session_id,
        lambda value: value.runtime_state == "running",
    )

    manager.shutdown()
    manager.shutdown()

    assert first_worker.close_calls == first_worker.open_handles
    assert second_worker.close_calls == second_worker.open_handles
    assert first_worker.close_browser_calls == 1
    assert second_worker.close_browser_calls == 1


def test_logs_and_diagnostics_never_expose_credentials_qr_cookies_or_profile(
    tmp_path,
    caplog,
):
    sensitive_account_key = "phone=13800000000 password=top-secret"
    sensitive_failure = (
        "cookie=session-secret "
        "qr=data:image/png;base64,c2VjcmV0 "
        "Authorization=Bearer private-token"
    )
    worker = FakeLocalBrowserWorker(
        open_error=RuntimeError(sensitive_failure),
    )
    manager, _factory = _new_manager(tmp_path, worker)
    package_logger = logging.getLogger("shensi_adapter")
    package_logger.addHandler(caplog.handler)
    try:
        with caplog.at_level(
            logging.INFO,
            logger="shensi_adapter.local_browser_session_manager",
        ):
            started = manager.start_login(sensitive_account_key)
            failed = _wait_for_status(
                manager,
                started.session_id,
                lambda value: value.task_state == "failed",
            )
    finally:
        manager.shutdown()
        package_logger.removeHandler(caplog.handler)

    diagnostic_text = (
        "" if failed.diagnostic is None else failed.diagnostic.message
    )
    observed = caplog.text + diagnostic_text
    assert sensitive_account_key not in observed
    assert "13800000000" not in observed
    assert "top-secret" not in observed
    assert "session-secret" not in observed
    assert "data:image" not in observed
    assert "private-token" not in observed
    assert str(tmp_path.resolve()) not in observed
    assert "RuntimeError" in caplog.text
