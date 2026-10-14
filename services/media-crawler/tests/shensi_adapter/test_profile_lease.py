from __future__ import annotations

import hashlib
import json
import threading
import time
from datetime import UTC, datetime, timedelta

import pytest

import shensi_adapter.crawl_jobs as crawl_jobs_module
from shensi_adapter.action_jobs import ActionJobManager
from shensi_adapter.crawl_jobs import CrawlJobManager
from shensi_adapter.local_browser_session_manager import (
    LocalBrowserSessionManager,
)
from shensi_adapter.schemas import ActionRequest, CrawlJobRequest


NOW = datetime(2026, 8, 27, tzinfo=UTC)


def _crawl_request() -> CrawlJobRequest:
    return CrawlJobRequest(
        job_id="profile-lease-crawl",
        account_handle="private-account-handle",
        login_state_version=7,
        keywords=["袜子"],
        max_videos=1,
        max_comments_per_video=1,
        max_pages_per_video=1,
        collect_creators=True,
        collect_demand_comments=True,
        deadline_at=NOW + timedelta(minutes=5),
    )


def _comment_request() -> ActionRequest:
    content = "用户已精确审批的评论"
    approved_hash = hashlib.sha256(json.dumps(
        {"content": content}, ensure_ascii=False, sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")).hexdigest()
    return ActionRequest(
        action_id="profile-lease-comment",
        account_handle="private-account-handle",
        login_state_version=7,
        kind="comment",
        target_public_url="https://www.douyin.com/video/73001",
        content=content,
        deadline_at=NOW + timedelta(minutes=1),
        approved_content_hash=f"sha256:{approved_hash}",
    )


class _OpenLoginWorker:
    def __init__(self) -> None:
        self.opened = threading.Event()
        self.closed = 0

    def open_douyin_login(self, profile):
        self.opened.set()
        return {"handle": "lease-login-context"}

    def poll_douyin_login(self, _context):
        return {"active": False}

    def close(self, _context):
        self.closed += 1

    def abort_browser(self):
        return None

    def close_browser(self):
        return None


def _wait_for_running_login(manager, session_id: str):
    deadline = time.monotonic() + 1
    while time.monotonic() < deadline:
        status = manager.get_status(session_id)
        if status.runtime_state == "running":
            return status
        time.sleep(0.01)
    pytest.fail("login did not reach running state")


def test_running_crawl_blocks_comment_before_a_second_persistent_context_starts(
    tmp_path,
):
    """Removing the shared profile lease would start both browser contexts."""
    profile = tmp_path / "profiles" / "account-profile"
    profile.mkdir(parents=True)
    crawl_browser_started = threading.Event()
    release_crawl = threading.Event()
    browser_starts: list[str] = []

    def crawl_runner(_request, _profile, _cancelled):
        browser_starts.append("crawl")
        crawl_browser_started.set()
        release_crawl.wait(2)
        return []

    def comment_executor(_profile, action):
        browser_starts.append("comment")
        return {
            "action_id": action.action_id,
            "state": "succeeded",
            "platform_receipt_reference": "must-not-be-created-while-busy",
            "occurred_at": NOW,
            "failure_code": None,
        }

    crawl = CrawlJobManager(
        tmp_path,
        account_resolver=lambda *_: profile,
        runner=crawl_runner,
        now=lambda: NOW,
    )
    actions = ActionJobManager(
        tmp_path,
        account_resolver=lambda *_: profile,
        executor=comment_executor,
        now=lambda: NOW,
    )
    try:
        crawl.start(_crawl_request())
        assert crawl_browser_started.wait(1)

        busy = actions.execute(_comment_request())

        assert busy.state == "failed"
        assert busy.failure_code == "douyin_profile_busy"
        assert browser_starts == ["crawl"]
        assert not list((tmp_path / "action-receipts").glob("*.json"))

        release_crawl.set()
        deadline = time.monotonic() + 1
        while crawl.get("profile-lease-crawl").state not in {
            "succeeded", "failed", "partial",
        }:
            assert time.monotonic() < deadline
            time.sleep(0.01)

        completed = actions.execute(_comment_request())
        assert completed.state == "succeeded"
        assert browser_starts == ["crawl", "comment"]
    finally:
        release_crawl.set()
        crawl.close()


def test_open_login_context_blocks_crawl_and_action_for_the_same_profile(
    tmp_path,
):
    worker = _OpenLoginWorker()
    login = LocalBrowserSessionManager(
        tmp_path / "profiles",
        lease_root=tmp_path,
        browser_factory=lambda: worker,
    )
    launched: list[str] = []
    started = login.start_login("shared-account")
    running = _wait_for_running_login(login, started.session_id)
    crawl = CrawlJobManager(
        tmp_path,
        account_resolver=lambda *_: running.profile_path,
        runner=lambda *_: launched.append("crawl") or [],
        now=lambda: NOW,
    )
    actions = ActionJobManager(
        tmp_path,
        account_resolver=lambda *_: running.profile_path,
        executor=lambda _profile, request: {
            "action_id": request.action_id,
            "state": launched.append("action") or "succeeded",
            "platform_receipt_reference": "must-not-run-while-login-open",
            "occurred_at": NOW,
            "failure_code": None,
        },
        now=lambda: NOW,
    )
    try:
        with pytest.raises(ValueError, match="^douyin_profile_busy$"):
            crawl.start(_crawl_request())
        busy_action = actions.execute(_comment_request())

        assert busy_action.state == "failed"
        assert busy_action.failure_code == "douyin_profile_busy"
        assert launched == []

        login.cancel_login(started.session_id)
        crawl.start(_crawl_request())
        deadline = time.monotonic() + 1
        while crawl.get("profile-lease-crawl").state not in {
            "succeeded", "failed", "partial",
        }:
            assert time.monotonic() < deadline
            time.sleep(0.01)
        completed_action = actions.execute(_comment_request())

        assert completed_action.state == "succeeded"
        assert launched == ["crawl", "action"]
    finally:
        login.shutdown()
        crawl.close()


def test_crawl_thread_start_failure_releases_profile_lease(tmp_path, monkeypatch):
    profile = tmp_path / "profiles" / "account-profile"
    profile.mkdir(parents=True)
    browser_starts: list[str] = []

    class FailingThread:
        def __init__(self, **_kwargs):
            pass

        def start(self):
            raise RuntimeError("thread_start_failed")

        def join(self, **_kwargs):
            pass

    crawl = CrawlJobManager(
        tmp_path,
        account_resolver=lambda *_: profile,
        runner=lambda *_: [],
        now=lambda: NOW,
    )
    monkeypatch.setattr(crawl_jobs_module.threading, "Thread", FailingThread)

    try:
        with pytest.raises(RuntimeError, match="^thread_start_failed$"):
            crawl.start(_crawl_request())
        assert crawl.get("profile-lease-crawl").state == "failed"

        actions = ActionJobManager(
            tmp_path,
            account_resolver=lambda *_: profile,
            executor=lambda _profile, request: {
                "action_id": request.action_id,
                "state": "succeeded",
                "platform_receipt_reference": "released-after-start-failure",
                "occurred_at": NOW,
                "failure_code": None,
            },
            now=lambda: NOW,
        )
        browser_starts.append(actions.execute(_comment_request()).state)

        assert browser_starts == ["succeeded"]
    finally:
        crawl.close()
