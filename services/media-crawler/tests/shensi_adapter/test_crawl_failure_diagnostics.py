import json
import logging
import os
import re
import signal
import sys
import threading
import time
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

from shensi_adapter import crawl_jobs, process_group
from shensi_adapter.crawl_jobs import CrawlJobManager, MediaCrawlerRunner
from shensi_adapter.profile_lease import acquire_profile_lease
from shensi_adapter.schemas import CrawlActivity, CrawlJobRequest


SECRET_MARKER = "private-cookie-must-not-appear"
RAW_MARKER = "raw-comment-must-not-appear"
PATH_MARKER = "/private/test-only-profile-must-not-appear"


def _request(job_id):
    return CrawlJobRequest(
        job_id=job_id, account_handle="diagnostic-test-account", login_state_version=1,
        keywords=["pump"], max_videos=2, max_comments_per_video=2,
        max_pages_per_video=1, collect_creators=True, collect_demand_comments=True,
        deadline_at=datetime.now(UTC) + timedelta(minutes=1),
    )


def _video():
    return "video", {
        "aweme_id": "73001", "nickname": "Fixture", "title": "Pump",
        "source_keyword": "pump",
    }


def _invalid_comment():
    return "comment", {
        "comment_id": "comment-without-actor", "aweme_id": "73001",
        "content": RAW_MARKER, "cookie": SECRET_MARKER, "profile": PATH_MARKER,
    }


class _Records(logging.Handler):
    def __init__(self):
        super().__init__()
        self.records = []

    def emit(self, record):
        self.records.append(record)


@pytest.fixture
def diagnostic_records():
    logger = logging.getLogger("shensi_adapter.crawl_jobs")
    handler = _Records()
    logger.addHandler(handler)
    try:
        yield handler.records
    finally:
        logger.removeHandler(handler)


def _has_field(record, field, value):
    if getattr(record, field, None) == value:
        return True
    return re.search(
        rf'["\']?{re.escape(field)}["\']?\s*[:=]\s*["\']?{re.escape(value)}(?:["\']|\s|,|}}|$)',
        record.getMessage(),
    ) is not None


def _wait_terminal(manager, job_id):
    deadline = time.monotonic() + 4
    while time.monotonic() < deadline:
        view = manager.get(job_id)
        if view.state in {"succeeded", "partial", "failed", "cancelled"}:
            return view
        time.sleep(0.01)
    pytest.fail("the fixture job did not terminate within four seconds")


@pytest.mark.parametrize(("failure", "stage", "code"), [
    ("normalize", "normalize", "invalid_douyin_actor"),
    ("activity", "activity", "invalid_crawl_activity_keyword"),
    ("deadline", "runner", "crawl_deadline_exceeded"),
    ("upstream", "runner", "mediacrawler_job_failed"),
    ("unknown", "runner", "crawl_processing_failed"),
])
def test_partial_failure_has_safe_stage_without_exposing_source_data(
    tmp_path, diagnostic_records, failure, stage, code,
):
    def runner(*_args):
        yield _video()
        if failure == "normalize":
            yield _invalid_comment()
        elif failure == "activity":
            yield CrawlActivity(
                phase="searching", current_keyword="not-an-authorized-keyword",
                browser_mode="visible", sequence=1,
            )
        elif failure == "deadline":
            raise TimeoutError("crawl_deadline_exceeded")
        elif failure == "upstream":
            raise RuntimeError("mediacrawler_job_failed")
        else:
            raise RuntimeError(f"Cookie: {SECRET_MARKER} {PATH_MARKER} {RAW_MARKER}")

    manager = CrawlJobManager(
        tmp_path, account_resolver=lambda *_: tmp_path / "profile",
        runner=runner, page_size=1,
    )
    try:
        manager.start(_request(f"diagnostic-{failure}"))
        terminal = _wait_terminal(manager, f"diagnostic-{failure}")
        assert terminal.state == "partial"
        assert terminal.record_count == 1
        assert terminal.failure_code == "crawl_interrupted_after_partial_results"
        assert any(_has_field(record, "stage", stage) and _has_field(record, "code", code)
                   for record in diagnostic_records), (
            f"partial {failure} must retain its safe diagnostic stage and code"
        )
        rendered = "\n".join(record.getMessage() for record in diagnostic_records)
        for marker in (SECRET_MARKER, RAW_MARKER, PATH_MARKER, "Cookie:"):
            assert marker not in rendered
        assert all(record.exc_info is None for record in diagnostic_records), (
            "raw exception tracebacks must not cross the diagnostic boundary"
        )
    finally:
        manager.close()


def _child_running(pid):
    try:
        waited, _status = os.waitpid(pid, os.WNOHANG)
        if waited == pid:
            return False
    except ChildProcessError:
        pass
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False


@pytest.mark.parametrize("worker_wait_times_out", [False, True])
def test_runner_close_waits_for_group_disappearance_after_kill(
    tmp_path, monkeypatch, worker_wait_times_out,
):
    class ProcessWithLingeringGroup:
        pid = 900001
        returncode = None
        group_present = True
        killed = False
        post_kill_checks = 0

        def poll(self):
            return self.returncode

        def wait(self, timeout=None):
            if worker_wait_times_out:
                raise crawl_jobs.subprocess.TimeoutExpired("isolated-fixture", timeout)
            # Reaping the direct worker says nothing about its descendants.
            self.returncode = -signal.SIGTERM
            return self.returncode

    process = ProcessWithLingeringGroup()

    def popen(command, **kwargs):
        assert kwargs["start_new_session"] is True
        output = Path(json.loads(Path(command[-1]).read_text())["output"])
        data = output / "douyin" / "jsonl"
        data.mkdir(parents=True)
        (data / "search_contents.jsonl").write_text(json.dumps(_video()[1]) + "\n")
        return process

    def killpg(pid, requested_signal):
        assert pid == process.pid, "all process operations must stay inside the isolated fixture"
        if requested_signal == signal.SIGTERM:
            process.returncode = -signal.SIGTERM
            return
        if requested_signal == signal.SIGKILL:
            process.killed = True
            return
        assert requested_signal == 0
        if process.killed:
            process.post_kill_checks += 1
            if process.post_kill_checks >= 3:
                process.group_present = False
        if not process.group_present:
            raise ProcessLookupError

    monkeypatch.setattr(crawl_jobs.subprocess, "Popen", popen)
    monkeypatch.setattr(crawl_jobs.os, "killpg", killpg)
    # This fixture models killpg existence; Linux /proc parsing has its own
    # tests and must not inspect real processes for this synthetic PID.
    monkeypatch.setattr(process_group, "_IS_LINUX", False)
    runner = MediaCrawlerRunner(service_root=tmp_path)
    iterator = runner(_request("linger-after-kill"), tmp_path / "profile", threading.Event())
    try:
        assert next(iterator)[0] == "video"
        iterator.close()
        assert process.group_present is False, (
            "runner cleanup must not complete merely because the direct worker was reaped; "
            "the killed process group must actually disappear first"
        )
    finally:
        iterator.close()


@pytest.mark.parametrize("stubborn_descendant", [False, True])
def test_normalizer_failure_stops_owned_real_child_before_terminal_and_profile_release(
    tmp_path, monkeypatch, stubborn_descendant,
):
    attempts = []
    worker = """
import json, os, pathlib, subprocess, sys, time
spec = json.loads(pathlib.Path(sys.argv[1]).read_text())
output = pathlib.Path(spec["output"])
(output / "test-child.pid").write_text(str(os.getpid()))
if sys.argv[2] == "True":
    subprocess.Popen([sys.executable, "-c", '''
import os, pathlib, signal, sys, time
signal.signal(signal.SIGTERM, signal.SIG_IGN)
pathlib.Path(sys.argv[1]).write_text(str(os.getpid()))
while True:
    time.sleep(0.1)
''', str(output / "test-descendant.pid")])
    while not (output / "test-descendant.pid").exists():
        time.sleep(0.01)
data = output / "douyin" / "jsonl"
data.mkdir(parents=True)
(data / "search_contents.jsonl").write_text(json.dumps({
    "aweme_id": "73001", "title": "Pump", "source_keyword": "pump"
}) + "\\n")
(data / "search_comments.jsonl").write_text(json.dumps({
    "comment_id": "missing-actor", "aweme_id": "73001", "content": "fixture"
}) + "\\n")
while True:
    time.sleep(0.1)
"""

    def command(spec):
        attempts.append(Path(json.loads(spec.read_text(encoding="utf-8"))["output"]))
        return [sys.executable, "-c", worker, str(spec), str(stubborn_descendant)]

    monkeypatch.setattr(crawl_jobs, "_crawl_worker_command", command)
    profile = tmp_path / "owned-profile"
    service = tmp_path / "service"
    service.mkdir()
    manager = CrawlJobManager(
        tmp_path / "state", account_resolver=lambda *_: profile,
        runner=MediaCrawlerRunner(service_root=service), page_size=1,
    )
    pid = None
    descendant = None
    try:
        manager.start(_request("owned-child-normalizer-failure"))
        terminal = _wait_terminal(manager, "owned-child-normalizer-failure")
        assert terminal.state == "partial"
        assert terminal.record_count == 1
        assert terminal.failure_code == "crawl_interrupted_after_partial_results"
        assert len(attempts) == 1
        pid = int((attempts[0] / "test-child.pid").read_text(encoding="utf-8"))
        assert not _child_running(pid), (
            "partial must not become visible while the failed job still owns a live browser worker"
        )
        if stubborn_descendant:
            descendant = int((attempts[0] / "test-descendant.pid").read_text())
            assert not _child_running(descendant), "the worker exit must not leave its browser descendants alive"
        with acquire_profile_lease(profile, tmp_path / "state"):
            assert not _child_running(pid), (
                "a released profile must not still be used by the failed worker"
            )
    finally:
        try:
            manager.close()
        finally:
            if pid is None and attempts:
                marker = attempts[0] / "test-child.pid"
                if marker.is_file():
                    pid = int(marker.read_text(encoding="utf-8"))
            if descendant is None and attempts:
                marker = attempts[0] / "test-descendant.pid"
                if marker.is_file():
                    descendant = int(marker.read_text())
            live_pid = next((value for value in (pid, descendant) if value and _child_running(value)), None)
            if pid is not None and live_pid is not None:
                assert os.getpgid(live_pid) == pid, "only the fixture child process group may be cleaned up"
                os.killpg(pid, signal.SIGTERM)
                deadline = time.monotonic() + 1
                while _child_running(live_pid) and time.monotonic() < deadline:
                    time.sleep(0.01)
                if _child_running(live_pid):
                    os.killpg(pid, signal.SIGKILL)
                    try:
                        os.waitpid(pid, 0)
                    except ChildProcessError:
                        pass
