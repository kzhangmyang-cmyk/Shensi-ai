import multiprocessing
import json
import os
import signal
import stat
import subprocess
import sys
import threading
import time
from datetime import UTC, datetime, timedelta
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

import shensi_adapter.accounts as accounts_module
from shensi_adapter.accounts import AccountManager
from shensi_adapter.browser_state import MediaCrawlerDouyinBrowserState, _open_context
from shensi_adapter.app import (
    create_app,
    create_deployment_account_manager,
    deployment_service_secret,
    validate_encrypted_profile_root,
)
from shensi_adapter.crawl_jobs import CrawlJobManager
from shensi_adapter.douyin_account_identity import (
    account_handle_for_fingerprint,
    identity_fingerprint_for_raw_sec_uid,
)
from shensi_adapter.schemas import CrawlJobRequest


ACCOUNT_FINGERPRINT = identity_fingerprint_for_raw_sec_uid(
    "MS4wLjABFixtureAccount"
)


class FakeBrowser:
    def __init__(self):
        self.closed = 0

    def open_douyin_login(self, profile_path):
        assert profile_path.exists()
        return {"qr_image_data_url": "data:image/png;base64,cXI="}

    def close(self, _context):
        self.closed += 1

    def poll_douyin_login(self, _context):
        return {
            "active": True,
            "display_name": "Douyin",
            "identity_fingerprint": ACCOUNT_FINGERPRINT,
        }

    def close_browser(self):
        return None


def _allocate_login_version_in_process(root, start, result_queue):
    manager = AccountManager(Path(root), FakeBrowser())
    try:
        if not start.wait(timeout=5):
            raise RuntimeError("allocation_start_timeout")
        result_queue.put(("ok", manager._next_login_state_version()))
    except BaseException as error:
        result_queue.put(("error", type(error).__name__))
        raise
    finally:
        manager.close()


class FailingCloseBrowser(FakeBrowser):
    def __init__(self, *, fail_shutdown=False):
        super().__init__()
        self.close_browser_calls = 0
        self.fail_shutdown = fail_shutdown

    def close(self, _context):
        self.closed += 1
        raise RuntimeError("context close failed")

    def close_browser(self):
        self.close_browser_calls += 1
        if self.fail_shutdown:
            raise RuntimeError("browser shutdown failed")


class _TimeoutConnection:
    def __init__(self):
        self.closed = False

    def send(self, _command):
        return None

    def poll(self, _timeout):
        return False

    def close(self):
        self.closed = True


class _ShutdownErrorConnection(_TimeoutConnection):
    def __init__(self):
        super().__init__()
        self.sent = []

    def send(self, command):
        self.sent.append(command)

    def poll(self, _timeout):
        return True

    def recv(self):
        return {"kind": "shutdown_error"}


class _SlowExitProcess:
    pid = None

    def __init__(self):
        self.alive = True
        self.kill_calls = 0
        self.close_calls = 0

    def is_alive(self):
        return self.alive

    def kill(self):
        self.kill_calls += 1
        if self.kill_calls >= 2:
            self.alive = False

    def join(self, timeout=None):
        assert timeout is not None

    def close(self):
        assert not self.alive, "Process.close called while the worker was alive"
        self.close_calls += 1


class _DeadWorkerWithLiveDescendantProcess:
    pid = 41001

    def __init__(self):
        self.close_calls = 0

    def is_alive(self):
        return False

    def kill(self):
        raise AssertionError("dead worker must not be used as the group authority")

    def join(self, timeout=None):
        assert timeout is not None

    def close(self):
        self.close_calls += 1


class _AliveCheckFailureProcess:
    pid = 41002

    def __init__(self):
        self.alive_checks = 0
        self.explicit_death_observed = False
        self.close_calls = 0

    def is_alive(self):
        self.alive_checks += 1
        if self.alive_checks == 1:
            raise OSError("worker status unavailable")
        self.explicit_death_observed = True
        return False

    def kill(self):
        return None

    def join(self, timeout=None):
        assert timeout is not None

    def close(self):
        assert self.explicit_death_observed, (
            "Process.close called before worker death was explicitly observed"
        )
        self.close_calls += 1


class _FakeImage:
    def click(self, **_kwargs):
        return None

    def wait_for(self, **_kwargs):
        return None

    def get_attribute(self, _name):
        return "data:image/png;base64,cXI="


class _FakeIdentityAnchor:
    def count(self):
        return 1

    def nth(self, _index):
        return self

    def is_visible(self, **_kwargs):
        return True

    def get_attribute(self, name):
        return {
            "href": "/user/MS4wLjABFixtureAccount",
            "title": "Douyin",
        }.get(name)

    def inner_text(self, **_kwargs):
        return "Douyin"

    def locator(self, _selector):
        return _FakeEmptyLocator()


class _FakeEmptyLocator:
    def count(self):
        return 0


class _FakePage:
    url = "https://www.douyin.com/"

    def goto(self, *_args, **_kwargs):
        return None

    def locator(self, selector):
        if selector == (
            'header a[href], nav a[href], [role="navigation"] a[href], '
            '[data-e2e="douyin-header"] a[href], #douyin-header a[href]'
        ):
            return _FakeIdentityAnchor()
        return _FakeImage()

    def wait_for_timeout(self, _milliseconds):
        return None

    def evaluate(self, expression, *_args):
        if "HasUserLogin" in expression:
            return "1"
        raise AssertionError(expression)


class _FakeContext:
    def __init__(self):
        self.pages = [_FakePage()]

    def close(self):
        return None


class _FakeChromium:
    def launch_persistent_context(self, _profile_path, **_kwargs):
        return _FakeContext()


class _InteractiveChromeOnlyChromium:
    def launch_persistent_context(self, _profile_path, **kwargs):
        assert kwargs == {"headless": False, "channel": "chrome"}
        return _FakeContext()


class _ColdStartQrImage(_FakeImage):
    def wait_for(self, **kwargs):
        assert kwargs["timeout"] >= 25_000


class _ColdStartQrPage(_FakePage):
    def locator(self, selector):
        if selector == "#animate_qrcode_container img":
            return _ColdStartQrImage()
        return _FakeImage()


class _ColdStartQrContext(_FakeContext):
    def __init__(self):
        self.pages = [_ColdStartQrPage()]


class _ColdStartQrChromium:
    def launch_persistent_context(self, _profile_path, **_kwargs):
        return _ColdStartQrContext()


class _ColdStartQrPlaywright:
    chromium = _ColdStartQrChromium()


class _BlockingChromium:
    def launch_persistent_context(self, _profile_path, **_kwargs):
        threading.Event().wait()


class _BlockingChildChromium:
    def launch_persistent_context(self, profile_path, **_kwargs):
        child = subprocess.Popen(
            [sys.executable, "-c", "import time; time.sleep(60)"],
            start_new_session=False,
        )
        (Path(profile_path) / "browser-child.pid").write_text(
            str(child.pid), encoding="utf-8"
        )
        threading.Event().wait()


class _FakePlaywright:
    chromium = _FakeChromium()

    def stop(self):
        return None


class _InteractiveChromeOnlyPlaywright:
    chromium = _InteractiveChromeOnlyChromium()

    def stop(self):
        return None


class _BlockingPlaywright:
    chromium = _BlockingChromium()

    def stop(self):
        return None


class _BlockingChildPlaywright:
    chromium = _BlockingChildChromium()

    def stop(self):
        return None


class _ShutdownFailurePlaywright(_FakePlaywright):
    def stop(self):
        raise RuntimeError("playwright stop failed")


def _working_playwright_factory():
    return _FakePlaywright()


def _interactive_chrome_only_playwright_factory():
    return _InteractiveChromeOnlyPlaywright()


def _blocking_playwright_factory():
    return _BlockingPlaywright()


def _blocking_child_playwright_factory():
    return _BlockingChildPlaywright()


def _shutdown_failure_playwright_factory():
    return _ShutdownFailurePlaywright()


def _startup_failure_factory():
    raise RuntimeError("playwright unavailable")


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


def test_account_manager_reloads_durable_active_metadata_and_retains_it_after_qr_expiry(tmp_path):
    now = datetime(2026, 8, 24, tzinfo=UTC)
    browser = FakeBrowser()
    manager = AccountManager(tmp_path, browser, now=lambda: now, session_ttl=timedelta(minutes=1))

    session = manager.create_login_session()
    active = manager.get_login_session(session.session_id)
    profile_dirs = list((tmp_path / "profiles").iterdir())
    account_metadata = profile_dirs[0] / ".shensi-connected-account.json"
    assert account_metadata.is_file()
    assert "expires_at" not in json.loads(account_metadata.read_text(encoding="utf-8"))
    manager.close()

    metadata = profile_dirs[0] / ".shensi-login-session.json"
    os.chmod(profile_dirs[0], 0o777)
    os.chmod(metadata, 0o666)

    restarted = AccountManager(tmp_path, FakeBrowser(), now=lambda: now, session_ttl=timedelta(minutes=1))
    reloaded = restarted.get_login_session(session.session_id)

    assert active.account_handle is not None
    assert reloaded.state == "active"
    assert reloaded.account_handle == active.account_handle
    assert reloaded.account_display_name == "Douyin"
    assert profile_dirs[0].is_dir()
    assert oct(profile_dirs[0].stat().st_mode & 0o777) == "0o700"
    assert oct(metadata.stat().st_mode & 0o777) == "0o600"
    assert restarted.sweep_expired(now + timedelta(minutes=2)) == 1
    assert profile_dirs[0].exists()
    assert restarted.resolve_crawl_profile(active.account_handle, 1) == profile_dirs[0]
    restarted.close()


def test_account_manager_uses_stable_hashed_handle_and_monotonic_login_version(
    tmp_path,
):
    now = datetime(2026, 8, 24, tzinfo=UTC)
    first_manager = AccountManager(
        tmp_path,
        FakeBrowser(),
        now=lambda: now,
        session_ttl=timedelta(minutes=1),
    )
    first_session = first_manager.create_login_session()
    first = first_manager.get_login_session(first_session.session_id)
    repeated = first_manager.get_login_session(first_session.session_id)

    expected_handle = account_handle_for_fingerprint(ACCOUNT_FINGERPRINT)
    assert first.account_handle == expected_handle
    assert repeated.account_handle == expected_handle
    assert first.login_state_version == 1
    assert repeated.login_state_version == 1
    first_manager.disconnect(first_session.session_id)
    first_manager.close()

    restarted = AccountManager(
        tmp_path,
        FakeBrowser(),
        now=lambda: now,
        session_ttl=timedelta(minutes=1),
    )
    second_session = restarted.create_login_session()
    second = restarted.get_login_session(second_session.session_id)

    assert second.account_handle == expected_handle
    assert second.login_state_version == 2
    ledger = tmp_path / ".shensi-account-identity-ledger.json"
    persisted = json.loads(ledger.read_text(encoding="utf-8"))
    assert persisted == {
        "version": 1,
        "last_login_state_version": 2,
    }
    assert "MS4wLjABFixtureAccount" not in ledger.read_text(encoding="utf-8")
    assert oct(ledger.stat().st_mode & 0o777) == "0o600"
    restarted.close()


def test_login_state_version_ledger_is_atomic_across_processes(tmp_path):
    context = multiprocessing.get_context("spawn")
    start = context.Event()
    results = context.Queue()
    processes = [
        context.Process(
            target=_allocate_login_version_in_process,
            args=(str(tmp_path), start, results),
        )
        for _index in range(2)
    ]
    for process in processes:
        process.start()
    start.set()
    observed = [results.get(timeout=10) for _index in processes]
    for process in processes:
        process.join(timeout=10)
        assert process.exitcode == 0

    assert sorted(observed) == [("ok", 1), ("ok", 2)]
    ledger = json.loads((
        tmp_path / ".shensi-account-identity-ledger.json"
    ).read_text(encoding="utf-8"))
    assert ledger["last_login_state_version"] == 2
    assert oct((
        tmp_path / ".shensi-account-identity-ledger.lock"
    ).stat().st_mode & 0o777) == "0o600"
    results.close()
    results.join_thread()


def test_account_activation_syncs_identity_files_before_returning_active(
    tmp_path,
    monkeypatch,
):
    manager = AccountManager(tmp_path, FakeBrowser())
    created = manager.create_login_session()
    events = []
    real_fsync = os.fsync
    real_replace = os.replace

    def recording_fsync(descriptor):
        kind = (
            "directory_fsync"
            if stat.S_ISDIR(os.fstat(descriptor).st_mode)
            else "file_fsync"
        )
        events.append(kind)
        real_fsync(descriptor)

    def recording_replace(source, destination):
        events.append(f"replace:{Path(destination).name}")
        real_replace(source, destination)

    monkeypatch.setattr(accounts_module.os, "fsync", recording_fsync)
    monkeypatch.setattr(accounts_module.os, "replace", recording_replace)
    try:
        active = manager.get_login_session(created.session_id)
        observed = list(events)
    finally:
        manager.close()

    assert active.state == "active"
    assert observed == [
        "file_fsync",
        "replace:.shensi-account-identity-ledger.json",
        "directory_fsync",
        "file_fsync",
        "replace:.shensi-connected-account.json",
        "directory_fsync",
        "file_fsync",
        "replace:.shensi-login-session.json",
        "directory_fsync",
    ]


@pytest.mark.parametrize(
    ("failure_stage", "failure_kind", "failure_occurrence"),
    [
        ("ledger", "file", 1),
        ("ledger", "directory", 1),
        ("binding", "file", 2),
        ("binding", "directory", 2),
    ],
)
def test_account_activation_fails_closed_when_identity_sync_fails(
    tmp_path,
    monkeypatch,
    failure_stage,
    failure_kind,
    failure_occurrence,
):
    manager = AccountManager(tmp_path, FakeBrowser())
    created = manager.create_login_session()
    profile = manager._sessions[created.session_id]["profile"]
    sync_counts = {"file": 0, "directory": 0}
    real_fsync = os.fsync

    def failing_fsync(descriptor):
        kind = (
            "directory"
            if stat.S_ISDIR(os.fstat(descriptor).st_mode)
            else "file"
        )
        sync_counts[kind] += 1
        if kind == failure_kind and sync_counts[kind] == failure_occurrence:
            raise OSError(f"simulated_{failure_stage}_{kind}_fsync_failure")
        real_fsync(descriptor)

    monkeypatch.setattr(accounts_module.os, "fsync", failing_fsync)
    try:
        with pytest.raises(
            OSError,
            match=f"simulated_{failure_stage}_{failure_kind}_fsync_failure",
        ):
            manager.get_login_session(created.session_id)

        assert manager._accounts == {}
        if failure_stage == "ledger":
            assert created.session_id in manager._sessions
            assert manager._sessions[created.session_id]["account_handle"] is None
            assert not (
                profile / ".shensi-connected-account.json"
            ).exists()
        else:
            assert created.session_id not in manager._sessions
            assert not profile.exists()
    finally:
        manager.close()


def test_account_metadata_writer_refuses_a_symlink_temporary_file(tmp_path):
    target = tmp_path / ".shensi-connected-account.json"
    temporary = target.with_suffix(".tmp")
    victim = tmp_path / "victim.json"
    victim.write_text("do-not-overwrite", encoding="utf-8")
    temporary.symlink_to(victim)

    with pytest.raises((OSError, ValueError)):
        AccountManager._write_metadata(target, {"version": 1})

    assert victim.read_text(encoding="utf-8") == "do-not-overwrite"
    assert not target.exists()


def test_account_manager_fails_closed_when_login_identity_or_name_is_missing(
    tmp_path,
):
    class UnboundBrowser(FakeBrowser):
        def poll_douyin_login(self, _context):
            return {
                "active": False,
                "identity_error": "douyin_account_identity_missing",
            }

    manager = AccountManager(tmp_path, UnboundBrowser())
    created = manager.create_login_session()

    failed = manager.get_login_session(created.session_id)

    assert failed.state == "failed"
    assert failed.account_handle is None
    assert failed.account_display_name is None
    assert failed.login_state_version is None
    assert manager._accounts == {}
    manager.close()


def test_account_manager_refuses_corrupt_monotonic_identity_ledger(tmp_path):
    ledger = tmp_path / ".shensi-account-identity-ledger.json"
    ledger.write_text('{"version":1,"last_login_state_version":-1}',
                      encoding="utf-8")

    with pytest.raises(ValueError, match="invalid identity ledger"):
        AccountManager(tmp_path, FakeBrowser())


def test_old_same_identity_session_cannot_remove_newer_account_authority(
    tmp_path,
):
    clock = [datetime(2026, 8, 24, tzinfo=UTC)]
    manager = AccountManager(
        tmp_path,
        FakeBrowser(),
        now=lambda: clock[0],
        session_ttl=timedelta(minutes=1),
    )
    old_session = manager.create_login_session()
    old_account = manager.get_login_session(old_session.session_id)
    new_session = manager.create_login_session()
    new_account = manager.get_login_session(new_session.session_id)

    assert old_account.account_handle == new_account.account_handle
    assert old_account.login_state_version == 1
    assert new_account.login_state_version == 2
    new_profile = manager._sessions[new_session.session_id]["profile"]

    clock[0] += timedelta(minutes=2)
    manager.get_login_session(old_session.session_id, clock[0])
    assert manager.resolve_action_profile(
        new_account.account_handle,
        new_account.login_state_version,
    ) == new_profile

    manager.disconnect(old_session.session_id)
    assert manager.resolve_action_profile(
        new_account.account_handle,
        new_account.login_state_version,
    ) == new_profile
    manager.close()


def test_action_checkpoint_rejects_same_account_login_version_supersession(
    tmp_path,
):
    class VersionSwitchingActionBrowser(FakeBrowser):
        manager = None

        def execute_douyin_action(
            self, _profile, _request, *, authority_validator,
        ):
            authority_validator()
            newer_session = self.manager.create_login_session()
            newer = self.manager.get_login_session(
                newer_session.session_id
            )
            assert newer.login_state_version == 2
            authority_validator()
            raise AssertionError("superseded action must stop")

    browser = VersionSwitchingActionBrowser()
    manager = AccountManager(tmp_path, browser)
    browser.manager = manager
    first_session = manager.create_login_session()
    first = manager.get_login_session(first_session.session_id)
    profile = manager.resolve_action_profile(
        first.account_handle,
        first.login_state_version,
    )

    with pytest.raises(
        Exception,
        match="douyin_account_identity_changed",
    ):
        manager.execute_action(profile, SimpleNamespace(
            account_handle=first.account_handle,
            login_state_version=first.login_state_version,
        ))

    manager.close()


def test_action_authority_lease_blocks_reconnect_without_lock_inversion(
    tmp_path,
):
    class BlockingActionBrowser(FakeBrowser):
        def __init__(self):
            super().__init__()
            self.action_started = threading.Event()
            self.release_action = threading.Event()

        def execute_douyin_action(
            self, _profile, _request, *, authority_validator,
        ):
            authority_validator()
            self.action_started.set()
            assert self.release_action.wait(timeout=2)
            authority_validator()
            return {"state": "succeeded"}

    browser = BlockingActionBrowser()
    manager = AccountManager(tmp_path, browser)
    first_session = manager.create_login_session()
    first = manager.get_login_session(first_session.session_id)
    profile = manager.resolve_action_profile(
        first.account_handle,
        first.login_state_version,
    )
    action_errors = []
    reconnect_results = []

    def run_action():
        try:
            manager.execute_action(profile, SimpleNamespace(
                account_handle=first.account_handle,
                login_state_version=first.login_state_version,
            ))
        except BaseException as error:
            action_errors.append(error)

    def reconnect():
        created = manager.create_login_session()
        reconnect_results.append(
            manager.get_login_session(created.session_id)
        )

    action_thread = threading.Thread(target=run_action)
    action_thread.start()
    assert browser.action_started.wait(timeout=1)
    reconnect_thread = threading.Thread(target=reconnect)
    reconnect_thread.start()
    time.sleep(0.05)
    assert reconnect_thread.is_alive()
    assert reconnect_results == []

    browser.release_action.set()
    action_thread.join(timeout=2)
    reconnect_thread.join(timeout=2)

    assert not action_thread.is_alive()
    assert not reconnect_thread.is_alive()
    assert action_errors == []
    assert reconnect_results[0].login_state_version == 2
    manager.close()


def test_login_state_version_is_global_across_different_real_accounts(
    tmp_path,
):
    fingerprints = iter([
        identity_fingerprint_for_raw_sec_uid("MS4wLjABAccountA"),
        identity_fingerprint_for_raw_sec_uid("MS4wLjABAccountB"),
    ])

    class SwitchingBrowser(FakeBrowser):
        def poll_douyin_login(self, _context):
            return {
                "active": True,
                "display_name": "账号 A" if not hasattr(
                    self, "_returned_once"
                ) else "账号 B",
                "identity_fingerprint": next(fingerprints),
            }

    browser = SwitchingBrowser()
    manager = AccountManager(tmp_path, browser)
    first_session = manager.create_login_session()
    first = manager.get_login_session(first_session.session_id)
    browser._returned_once = True
    second_session = manager.create_login_session()
    second = manager.get_login_session(second_session.session_id)

    assert first.account_handle != second.account_handle
    assert first.login_state_version == 1
    assert second.login_state_version == 2
    with pytest.raises(KeyError, match="active_account_not_found"):
        manager.resolve_action_profile(
            second.account_handle,
            first.login_state_version,
        )
    manager.close()


@pytest.mark.parametrize("ephemeral", ["missing", "malformed"])
def test_durable_active_account_can_crawl_after_qr_ttl_and_fresh_manager_restart(
    tmp_path, ephemeral
):
    clock = [datetime(2026, 8, 24, tzinfo=UTC)]
    manager = AccountManager(
        tmp_path, FakeBrowser(), now=lambda: clock[0],
        session_ttl=timedelta(minutes=1),
    )
    session = manager.create_login_session()
    active = manager.get_login_session(session.session_id)
    assert active.account_handle is not None
    manager.close()

    clock[0] += timedelta(minutes=2)
    ephemeral_metadata = next((tmp_path / "profiles").iterdir()).joinpath(
        ".shensi-login-session.json"
    )
    if ephemeral == "missing":
        ephemeral_metadata.unlink()
    else:
        ephemeral_metadata.write_text("not-json", encoding="utf-8")
    restarted = AccountManager(
        tmp_path, FakeBrowser(), now=lambda: clock[0],
        session_ttl=timedelta(minutes=1),
    )
    crawl = CrawlJobManager(
        tmp_path,
        account_resolver=restarted.resolve_crawl_profile,
        runner=lambda *_: [],
        now=lambda: clock[0],
    )
    crawl.start(CrawlJobRequest(
        job_id="post-ttl-job", account_handle=active.account_handle,
        login_state_version=1, keywords=["pump"], max_videos=1,
        max_comments_per_video=1, max_pages_per_video=1,
        collect_creators=True, collect_demand_comments=True,
        deadline_at=clock[0] + timedelta(minutes=1),
    ))

    deadline = time.monotonic() + 1
    while crawl.get("post-ttl-job").state not in {"succeeded", "failed"}:
        assert time.monotonic() < deadline
        time.sleep(0.01)
    assert crawl.get("post-ttl-job").state == "succeeded"
    crawl.close()
    restarted.disconnect(session.session_id)
    assert not any((tmp_path / "profiles").iterdir())
    restarted.close()


def test_expiry_evicts_session_and_profile_even_when_context_close_fails(tmp_path):
    now = datetime(2026, 8, 24, tzinfo=UTC)
    manager = AccountManager(
        tmp_path,
        FailingCloseBrowser(),
        now=lambda: now,
        session_ttl=timedelta(minutes=1),
    )
    session = manager.create_login_session()
    profile = next((tmp_path / "profiles").iterdir())

    with pytest.raises(RuntimeError, match="context close failed"):
        manager.get_login_session(session.session_id, now + timedelta(minutes=2))

    assert not profile.exists()
    with pytest.raises(KeyError):
        manager.get_login_session(session.session_id)
    manager.close()


def test_disconnect_evicts_session_and_profile_even_when_context_close_fails(tmp_path):
    manager = AccountManager(tmp_path, FailingCloseBrowser())
    session = manager.create_login_session()
    profile = next((tmp_path / "profiles").iterdir())

    with pytest.raises(RuntimeError, match="context close failed"):
        manager.disconnect(session.session_id)

    assert not profile.exists()
    with pytest.raises(KeyError):
        manager.disconnect(session.session_id)
    manager.close()


def test_sweeper_survives_per_session_close_failures(tmp_path):
    clock = [datetime(2026, 8, 24, tzinfo=UTC)]
    manager = AccountManager(
        tmp_path,
        FailingCloseBrowser(),
        now=lambda: clock[0],
        session_ttl=timedelta(milliseconds=20),
        sweep_interval=timedelta(milliseconds=10),
    )

    manager.create_login_session()
    clock[0] += timedelta(seconds=1)
    deadline = time.monotonic() + 1
    while any((tmp_path / "profiles").iterdir()) and time.monotonic() < deadline:
        time.sleep(0.01)
    assert not any((tmp_path / "profiles").iterdir())

    manager.create_login_session()
    clock[0] += timedelta(seconds=1)
    deadline = time.monotonic() + 1
    while any((tmp_path / "profiles").iterdir()) and time.monotonic() < deadline:
        time.sleep(0.01)
    assert not any((tmp_path / "profiles").iterdir())
    manager.close()


def test_persistence_failure_after_browser_creation_removes_all_owned_state(
    tmp_path, monkeypatch
):
    browser = FakeBrowser()
    manager = AccountManager(tmp_path, browser)
    monkeypatch.setattr(
        manager,
        "_persist",
        lambda _session: (_ for _ in ()).throw(RuntimeError("metadata write failed")),
    )

    with pytest.raises(RuntimeError, match="metadata write failed"):
        manager.create_login_session()

    assert browser.closed == 1
    assert not any((tmp_path / "profiles").iterdir())
    assert manager._sessions == {}
    manager.close()


def test_browser_startup_error_is_returned_without_leaking_worker_thread():
    before = {thread.ident for thread in __import__("threading").enumerate()}

    with pytest.raises(RuntimeError, match="playwright unavailable"):
        MediaCrawlerDouyinBrowserState(
            playwright_factory=_startup_failure_factory, startup_timeout=2
        )

    after = {thread.ident for thread in __import__("threading").enumerate()}
    assert after == before


def test_browser_process_routes_create_poll_disconnect_without_exposing_context(tmp_path):
    browser = MediaCrawlerDouyinBrowserState(
        playwright_factory=_working_playwright_factory,
        startup_timeout=2,
        command_timeout=2,
    )
    try:
        if os.name == "posix":
            assert browser._owned_pgid == browser._process.pid
        opened = browser.open_douyin_login(tmp_path)
        assert opened["qr_image_data_url"] == "data:image/png;base64,cXI="
        assert set(opened) == {"handle", "qr_image_data_url"}
        polled = browser.poll_douyin_login(opened)
        assert polled == {
            "active": True,
            "identity_fingerprint": ACCOUNT_FINGERPRINT,
            "display_name": "Douyin",
        }
        assert "MS4wLjABFixtureAccount" not in json.dumps(polled)
        browser.close(opened)
    finally:
        browser.close_browser()


def test_browser_process_propagates_interactive_chrome_login_configuration(tmp_path):
    browser = MediaCrawlerDouyinBrowserState(
        playwright_factory=_interactive_chrome_only_playwright_factory,
        startup_timeout=2,
        command_timeout=2,
        headless=False,
        browser_channel="chrome",
    )
    try:
        opened = browser.open_douyin_login(tmp_path)
        assert opened["qr_image_data_url"] == "data:image/png;base64,cXI="
    finally:
        browser.close_browser()


def test_interactive_login_allows_a_cold_start_before_requiring_the_qr(tmp_path):
    context, qr = _open_context(
        _ColdStartQrPlaywright(),
        str(tmp_path),
        headless=False,
        browser_channel="chrome",
    )
    try:
        assert qr == "data:image/png;base64,cXI="
    finally:
        context.close()


def test_deployment_account_manager_uses_explicit_interactive_browser_settings(
    tmp_path, monkeypatch
):
    volume = tmp_path / "volume"
    profiles = volume / "profiles"
    profiles.mkdir(parents=True, mode=0o700)
    os.chmod(volume, 0o700)
    os.chmod(profiles, 0o700)
    monkeypatch.setenv("MEDIACRAWLER_ENCRYPTED_VOLUME", str(volume))
    monkeypatch.setenv("MEDIACRAWLER_PROFILE_ROOT", str(profiles))
    monkeypatch.setenv("MEDIACRAWLER_BROWSER_HEADLESS", "false")
    monkeypatch.setenv("MEDIACRAWLER_BROWSER_CHANNEL", "chrome")
    created_with = []

    def browser_factory(**kwargs):
        created_with.append(kwargs)
        return FakeBrowser()

    monkeypatch.setattr(
        "shensi_adapter.app.MediaCrawlerDouyinBrowserState", browser_factory
    )
    manager = create_deployment_account_manager()
    try:
        assert created_with == [
            {"headless": False, "browser_channel": "chrome"}
        ]
    finally:
        manager.close()


def test_deployment_rejects_headless_browser_when_real_outreach_is_enabled(
    tmp_path, monkeypatch,
):
    volume = tmp_path / "volume"
    profiles = volume / "profiles"
    profiles.mkdir(parents=True, mode=0o700)
    os.chmod(volume, 0o700)
    os.chmod(profiles, 0o700)
    monkeypatch.setenv("MEDIACRAWLER_ENCRYPTED_VOLUME", str(volume))
    monkeypatch.setenv("MEDIACRAWLER_PROFILE_ROOT", str(profiles))
    monkeypatch.setenv("DOUYIN_OUTREACH_ACTIONS_ENABLED", "true")
    monkeypatch.setenv("MEDIACRAWLER_BROWSER_HEADLESS", "true")
    browser_starts = 0

    def browser_factory(**_kwargs):
        nonlocal browser_starts
        browser_starts += 1
        return FakeBrowser()

    monkeypatch.setattr(
        "shensi_adapter.app.MediaCrawlerDouyinBrowserState", browser_factory
    )

    with pytest.raises(
        RuntimeError,
        match=(
            "DOUYIN_OUTREACH_ACTIONS_ENABLED=true requires "
            "MEDIACRAWLER_BROWSER_HEADLESS=false"
        ),
    ):
        create_deployment_account_manager()

    assert browser_starts == 0


def test_unknown_poll_and_close_handles_return_stable_closed_errors(tmp_path):
    browser = MediaCrawlerDouyinBrowserState(
        playwright_factory=_working_playwright_factory,
        startup_timeout=2,
        command_timeout=2,
    )
    try:
        opened = browser.open_douyin_login(tmp_path)
        browser.close(opened)
        for operation in (browser.poll_douyin_login, browser.close):
            with pytest.raises(RuntimeError) as failure:
                operation(opened)
            assert str(failure.value) == "douyin_browser_context_closed"
            assert opened["handle"] not in str(failure.value)
    finally:
        browser.close_browser()


def test_hard_stop_retries_exit_before_closing_process_and_preserves_timeout_error():
    browser = object.__new__(MediaCrawlerDouyinBrowserState)
    browser._connection = _TimeoutConnection()
    browser._process = _SlowExitProcess()
    browser._timeout = 0.01
    browser._lock = threading.Lock()
    browser._closed = False
    browser._shutdown_failed = False
    browser._next_command_id = 1

    with pytest.raises(RuntimeError) as failure:
        browser._call("open", profile_path="unused")

    assert str(failure.value) == "douyin_browser_command_timeout"
    assert browser._process.alive is False
    assert browser._process.close_calls == 1


def test_shutdown_error_wins_when_worker_exit_is_delayed_after_response():
    browser = object.__new__(MediaCrawlerDouyinBrowserState)
    browser._connection = _ShutdownErrorConnection()
    browser._process = _SlowExitProcess()
    browser._owned_pgid = None
    browser._timeout = 0.01
    browser._lock = threading.Lock()
    browser._closed = False
    browser._shutdown_failed = False
    browser._next_command_id = 1

    with pytest.raises(
        RuntimeError,
        match="^douyin_browser_shutdown_failed$",
    ):
        browser.close_browser()

    assert browser._connection.sent == [{
        "id": 1,
        "operation": "shutdown",
    }]
    assert browser._process.alive is False
    assert browser._process.close_calls == 1
    assert browser._shutdown_failed is True


@pytest.mark.skipif(os.name != "posix", reason="POSIX process-group boundary")
def test_hard_stop_signals_verified_process_group_after_worker_already_died(monkeypatch):
    browser = object.__new__(MediaCrawlerDouyinBrowserState)
    browser._connection = _TimeoutConnection()
    browser._process = _DeadWorkerWithLiveDescendantProcess()
    browser._owned_pgid = browser._process.pid
    browser._timeout = 0.01
    browser._closed = False

    signalled = []
    monkeypatch.setattr(os, "killpg", lambda pgid, sig: signalled.append((pgid, sig)))

    browser._hard_stop()

    assert signalled == [(browser._process.pid, signal.SIGKILL)]
    assert browser._process.close_calls == 1


@pytest.mark.skipif(os.name != "posix", reason="POSIX process-group boundary")
def test_hard_stop_treats_is_alive_failure_as_unknown_before_closing(monkeypatch):
    browser = object.__new__(MediaCrawlerDouyinBrowserState)
    browser._connection = _TimeoutConnection()
    browser._process = _AliveCheckFailureProcess()
    browser._owned_pgid = browser._process.pid
    browser._timeout = 0.01
    browser._closed = False

    signalled = []
    monkeypatch.setattr(os, "killpg", lambda pgid, sig: signalled.append((pgid, sig)))

    browser._hard_stop()

    assert signalled == [(browser._process.pid, signal.SIGKILL)]
    assert browser._process.alive_checks >= 2
    assert browser._process.close_calls == 1


def test_timed_out_browser_command_hard_stops_owned_process(tmp_path):
    before = {child.pid for child in multiprocessing.active_children()}
    browser = MediaCrawlerDouyinBrowserState(
        playwright_factory=_blocking_playwright_factory,
        startup_timeout=2,
        command_timeout=0.05,
    )

    started = time.monotonic()
    with pytest.raises(RuntimeError, match="douyin_browser_command_timeout"):
        browser.open_douyin_login(tmp_path)

    assert time.monotonic() - started < 1
    assert {child.pid for child in multiprocessing.active_children()} == before
    browser.close_browser()


@pytest.mark.skipif(os.name != "posix", reason="POSIX process-group boundary")
def test_timed_out_browser_command_kills_playwright_descendants(tmp_path):
    browser = MediaCrawlerDouyinBrowserState(
        playwright_factory=_blocking_child_playwright_factory,
        startup_timeout=2,
        command_timeout=0.5,
    )

    with pytest.raises(RuntimeError, match="douyin_browser_command_timeout"):
        browser.open_douyin_login(tmp_path)

    child_pid = int((tmp_path / "browser-child.pid").read_text(encoding="utf-8"))
    deadline = time.monotonic() + 2
    while time.monotonic() < deadline:
        try:
            os.kill(child_pid, 0)
        except ProcessLookupError:
            break
        time.sleep(0.02)
    else:
        pytest.fail("timed-out Playwright descendant remained alive")


def test_browser_shutdown_failure_is_bounded_and_leak_free():
    before = {child.pid for child in multiprocessing.active_children()}
    browser = MediaCrawlerDouyinBrowserState(
        playwright_factory=_shutdown_failure_playwright_factory,
        startup_timeout=2,
        command_timeout=0.2,
    )

    with pytest.raises(RuntimeError, match="douyin_browser_shutdown_failed"):
        browser.close_browser()

    assert {child.pid for child in multiprocessing.active_children()} == before


def test_graceful_close_aggregates_failures_and_always_attempts_browser_shutdown(
    tmp_path, monkeypatch
):
    browser = FailingCloseBrowser(fail_shutdown=True)
    manager = AccountManager(tmp_path, browser)
    manager.create_login_session()

    class _StuckSweeper:
        def join(self, timeout=None):
            assert timeout == 2

        def is_alive(self):
            return True

    manager._sweeper = _StuckSweeper()
    monkeypatch.setattr(
        manager,
        "sweep_expired",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            RuntimeError("expiry sweep failed")
        ),
    )
    monkeypatch.setattr(
        manager,
        "_persist",
        lambda _session: (_ for _ in ()).throw(RuntimeError("metadata write failed")),
    )

    with pytest.raises(ExceptionGroup) as failure:
        manager.close()

    messages = [str(error) for error in failure.value.exceptions]
    assert messages == [
        "account_sweeper_shutdown_timeout",
        "expiry sweep failed",
        "context close failed",
        "metadata write failed",
        "browser shutdown failed",
    ]
    assert browser.close_browser_calls == 1


def test_deployment_profile_root_requires_an_owner_only_existing_encrypted_directory(tmp_path):
    missing = tmp_path / "missing"
    with pytest.raises(RuntimeError, match="must exist"):
        validate_encrypted_profile_root(missing, missing / "profiles")

    volume_file = tmp_path / "volume-file"
    volume_file.write_text("not a directory", encoding="utf-8")
    with pytest.raises(RuntimeError, match="directory"):
        validate_encrypted_profile_root(volume_file, volume_file / "profiles")

    volume = tmp_path / "encrypted"
    volume.mkdir(mode=0o755)
    os.chmod(volume, 0o755)
    with pytest.raises(RuntimeError, match="0700"):
        validate_encrypted_profile_root(volume, volume / "profiles")

    os.chmod(volume, 0o700)
    assert validate_encrypted_profile_root(volume, volume / "profiles") == (
        volume / "profiles"
    ).resolve()
    with pytest.raises(RuntimeError, match="inside"):
        validate_encrypted_profile_root(volume, tmp_path / "outside")


def test_deployment_secret_requires_an_owner_only_regular_file(tmp_path, monkeypatch):
    secret_file = tmp_path / "service-secret"
    secret_file.write_text("s" * 48, encoding="utf-8")
    monkeypatch.setenv("MEDIACRAWLER_SERVICE_SECRET_FILE", str(secret_file))

    os.chmod(secret_file, 0o644)
    with pytest.raises(RuntimeError, match="owner-only"):
        deployment_service_secret()

    os.chmod(secret_file, 0o600)
    assert deployment_service_secret() == "s" * 48


def test_real_asgi_routes_delete_profiles_but_graceful_close_preserves_active_restart_state(tmp_path):
    now = datetime(2026, 8, 24, tzinfo=UTC)
    secret = "mediacrawler-test-secret-that-is-at-least-32-bytes"
    manager = AccountManager(tmp_path, FakeBrowser(), now=lambda: now)
    app = create_app(secret, manager)
    headers = {"Authorization": f"Bearer {secret}"}

    with TestClient(app) as client:
        created = client.post("/internal/v1/douyin/login-sessions", headers=headers)
        assert created.status_code == 200
        session_id = created.json()["session_id"]
        active = client.get(
            f"/internal/v1/douyin/login-sessions/{session_id}", headers=headers
        )
        assert active.status_code == 200
        assert active.json()["state"] == "active"

    profiles = list((tmp_path / "profiles").iterdir())
    assert len(profiles) == 1
    restarted = AccountManager(tmp_path, FakeBrowser(), now=lambda: now)
    assert restarted.get_login_session(session_id).state == "active"

    second_app = create_app(secret, restarted)
    with TestClient(second_app) as client:
        deleted = client.delete(
            f"/internal/v1/douyin/login-sessions/{session_id}", headers=headers
        )
        assert deleted.status_code == 204
        missing_response = client.get(
            f"/internal/v1/douyin/login-sessions/{session_id}", headers=headers
        )
        assert missing_response.status_code == 404
    assert not profiles[0].exists()
