import copy
import json
import threading
import time
from datetime import UTC, datetime, timedelta
from pathlib import Path
from types import SimpleNamespace

import pytest

from shensi_adapter import crawl_jobs
from shensi_adapter.crawl_jobs import (
    CrawlJobManager, CursorConflict, MediaCrawlerRunner, _browser_profile_template,
    _execute_upstream, _public_comment_capture, _public_creator_capture,
    _read_output_rows,
)
from shensi_adapter.douyin_normalizer import normalize_douyin_records
from shensi_adapter.schemas import CrawlActivity, CrawlJobRequest


NOW = datetime(2026, 8, 24, 1, 2, 3, tzinfo=UTC)


def request(job_id="job-1", account_handle="account-private-1", *,
            collect_creators=True, collect_demand_comments=True):
    return CrawlJobRequest(
        job_id=job_id,
        account_handle=account_handle,
        login_state_version=4,
        keywords=["industrial pump", "replacement seal"],
        max_videos=2,
        max_comments_per_video=2,
        max_pages_per_video=1,
        collect_creators=collect_creators,
        collect_demand_comments=collect_demand_comments,
        deadline_at=NOW + timedelta(minutes=5),
    )


def fixtures():
    return [
        ("video", {
            "aweme_id": "73001", "aweme_url": "https://www.douyin.com/video/73001",
            "nickname": "Pump Maker", "title": "Industrial pump and seal " + "x" * 800,
            "source_keyword": "industrial pump", "create_time": 1_724_550_400,
            "cookie": "must-not-leak", "raw_response": {"secret": True},
        }),
        ("creator", {
            "sec_user_id": "MS4wLjABAAAA", "nickname": "Pump Maker",
            "signature": "Factory account", "source_keyword": "industrial pump",
        }),
        ("comment", {
            "comment_id": "c-1", "aweme_id": "73001", "nickname": "Buyer",
            "sec_uid": "MS4wLjABCommenter",
            "content": "Need 200 replacement seals by Friday", "source_keyword": "replacement seal",
            "create_time": 1_724_550_500, "cookies": ["must-not-leak"],
        }),
    ]


def test_pinned_runner_reads_the_actual_douyin_jsonl_output_directory(tmp_path):
    directory = tmp_path / "douyin" / "jsonl"
    directory.mkdir(parents=True)
    (directory / "search_contents_2026-08-24.jsonl").write_text(
        json.dumps({"aweme_id": "73001"}) + "\n", encoding="utf-8"
    )
    public_comment = {
        "comment_id": "c-1", "aweme_id": "73001",
        "sec_uid": "MS4wLjABCommenter", "content": "Need seals",
    }
    (directory / "000-shensi-comments.jsonl").write_text(
        json.dumps(public_comment) + "\n", encoding="utf-8"
    )
    (directory / "search_comments_2026-08-24.jsonl").write_text(
        json.dumps({"comment_id": "c-1", "creator_hash": "not-public"}) + "\n",
        encoding="utf-8",
    )

    assert _read_output_rows(tmp_path) == [
        ("video", {"aweme_id": "73001"}), ("comment", public_comment),
    ]


def test_pinned_runner_treats_only_physical_lf_as_a_jsonl_record_boundary(tmp_path):
    directory = tmp_path / "douyin" / "jsonl"
    directory.mkdir(parents=True)
    comment = {
        "comment_id": "c-u2028", "aweme_id": "73001",
        "sec_uid": "MS4wLjABCommenter",
        "content": "first line\u2028second line",
    }
    (directory / "000-shensi-comments.jsonl").write_text(
        json.dumps(comment, ensure_ascii=False) + "\n", encoding="utf-8",
    )

    assert _read_output_rows(tmp_path) == [("comment", comment)]


def test_pinned_runner_preserves_the_exact_private_browser_profile_path(tmp_path):
    profile = tmp_path / "account%private" / "profile"

    assert _browser_profile_template(profile) % "dy" == str(profile)


def test_execute_upstream_disables_cdp_and_applies_configured_visible_mode(tmp_path):
    spec = tmp_path / "request.json"
    spec.write_text(json.dumps({
        "profile": str(tmp_path / "profile"),
        "output": str(tmp_path / "output"),
        "keywords": ["袜子"],
        "max_videos": 2,
        "max_comments_per_video": 2,
        "max_pages_per_video": 1,
        "collect_creators": False,
        "collect_demand_comments": True,
        "headless": False,
    }), encoding="utf-8")
    fake_config = SimpleNamespace()
    primary_calls = []
    observation_calls = []

    class FakePage:
        def __init__(self, calls):
            self.calls = calls

        async def goto(self, url):
            self.calls.append(url)

    class FakeBrowserContext:
        def __init__(self):
            self.new_page_calls = 0

        async def new_page(self):
            self.new_page_calls += 1
            return observation_page

    class FakeClient:
        async def search_info_by_keyword(self, *, keyword):
            return f"search-{keyword}"

    class FakeCrawler:
        def __init__(self):
            self.context_page = FakePage(primary_calls)
            self.browser_context = FakeBrowserContext()
            self.dy_client = FakeClient()

        async def search(self):
            return await self.dy_client.search_info_by_keyword(keyword="袜子")

        async def get_comments(self, aweme_id, _semaphore):
            return f"comments-{aweme_id}"

        async def start(self):
            self.search_result = await self.search()
            self.comments_result = await self.get_comments("73001", None)

    observation_page = FakePage(observation_calls)
    crawler = FakeCrawler()

    _execute_upstream(
        spec,
        config_module=fake_config,
        crawler_factory=lambda: crawler,
        capture_installer=lambda *_: None,
    )

    assert fake_config.ENABLE_CDP_MODE is False
    assert fake_config.CDP_CONNECT_EXISTING is False
    assert fake_config.HEADLESS is False
    assert fake_config.CDP_HEADLESS is False
    assert crawler.search_result == "search-袜子"
    assert crawler.comments_result == "comments-73001"
    assert primary_calls == []
    assert observation_calls == [
        "https://www.douyin.com/search/%E8%A2%9C%E5%AD%90?type=general",
        "https://www.douyin.com/video/73001",
    ]
    assert crawler.browser_context.new_page_calls == 1


def test_execute_upstream_losslessly_transports_comma_keyword(tmp_path):
    spec = tmp_path / "request.json"
    spec.write_text(json.dumps({
        "profile": str(tmp_path / "profile"),
        "output": str(tmp_path / "output"),
        "keywords": ["seal, gasket"],
        "max_videos": 2,
        "max_comments_per_video": 2,
        "max_pages_per_video": 1,
        "collect_creators": False,
        "collect_demand_comments": False,
        "headless": False,
    }), encoding="utf-8")
    fake_config = SimpleNamespace()
    primary_calls = []
    observation_calls = []

    class FakePage:
        def __init__(self, calls):
            self.calls = calls

        async def goto(self, url):
            self.calls.append(url)

    class FakeBrowserContext:
        async def new_page(self):
            return observation_page

    class FakeClient:
        async def search_info_by_keyword(self, *, keyword):
            from var import source_keyword_var
            self.source_keyword = source_keyword_var.get()
            return keyword

    class FakeCrawler:
        def __init__(self):
            self.context_page = FakePage(primary_calls)
            self.browser_context = FakeBrowserContext()
            self.dy_client = FakeClient()

        async def search(self):
            return await self.dy_client.search_info_by_keyword(
                keyword=fake_config.KEYWORDS,
            )

        async def get_comments(self, *_args):
            return None

        async def start(self):
            self.search_result = await self.search()

    observation_page = FakePage(observation_calls)
    crawler = FakeCrawler()
    _execute_upstream(
        spec,
        config_module=fake_config,
        crawler_factory=lambda: crawler,
        capture_installer=lambda *_: None,
    )

    assert fake_config.KEYWORDS == "seal%2C%20gasket"
    assert crawler.search_result == "seal, gasket"
    assert primary_calls == []
    assert observation_calls == [
        "https://www.douyin.com/search/seal%2C%20gasket?type=general",
    ]
    assert crawler.dy_client.source_keyword == "seal, gasket"


def test_observer_failures_do_not_interrupt_search_or_comment_collection(tmp_path):
    spec = tmp_path / "request.json"
    spec.write_text(json.dumps({
        "profile": str(tmp_path / "profile"),
        "output": str(tmp_path / "output"),
        "keywords": ["袜子"],
        "max_videos": 2,
        "max_comments_per_video": 2,
        "max_pages_per_video": 1,
        "collect_creators": False,
        "collect_demand_comments": True,
        "headless": False,
    }), encoding="utf-8")

    class FailingPage:
        def __init__(self):
            self.calls = []

        async def goto(self, url):
            self.calls.append(url)
            raise RuntimeError("observation_navigation_failed")

    class FakeBrowserContext:
        def __init__(self):
            self.new_page_calls = 0

        async def new_page(self):
            self.new_page_calls += 1
            return observation_page

    class FakeClient:
        async def search_info_by_keyword(self, *, keyword):
            return f"search-{keyword}"

    class FakeCrawler:
        def __init__(self):
            self.context_page = primary_page
            self.browser_context = FakeBrowserContext()
            self.dy_client = FakeClient()

        async def search(self):
            return await self.dy_client.search_info_by_keyword(keyword="袜子")

        async def get_comments(self, aweme_id, _semaphore):
            return f"comments-{aweme_id}"

        async def start(self):
            self.search_result = await self.search()
            self.comments_result = await self.get_comments("73001", None)

    primary_page = FailingPage()
    observation_page = FailingPage()
    crawler = FakeCrawler()

    _execute_upstream(
        spec,
        config_module=SimpleNamespace(),
        crawler_factory=lambda: crawler,
        capture_installer=lambda *_: None,
    )

    assert crawler.search_result == "search-袜子"
    assert crawler.comments_result == "comments-73001"
    assert primary_page.calls == []
    assert observation_page.calls == [
        "https://www.douyin.com/search/%E8%A2%9C%E5%AD%90?type=general",
        "https://www.douyin.com/video/73001",
    ]
    assert crawler.browser_context.new_page_calls == 1


def test_observer_page_creation_failure_does_not_interrupt_collection(tmp_path):
    spec = tmp_path / "request.json"
    spec.write_text(json.dumps({
        "profile": str(tmp_path / "profile"),
        "output": str(tmp_path / "output"),
        "keywords": ["袜子"],
        "max_videos": 2,
        "max_comments_per_video": 2,
        "max_pages_per_video": 1,
        "collect_creators": False,
        "collect_demand_comments": True,
        "headless": False,
    }), encoding="utf-8")

    class PrimaryPage:
        async def goto(self, _url):
            raise AssertionError("collector page must not be used for observation")

    class FailingBrowserContext:
        def __init__(self):
            self.new_page_calls = 0

        async def new_page(self):
            self.new_page_calls += 1
            raise RuntimeError("observation_page_creation_failed")

    class FakeClient:
        async def search_info_by_keyword(self, *, keyword):
            return f"search-{keyword}"

    class FakeCrawler:
        def __init__(self):
            self.context_page = PrimaryPage()
            self.browser_context = FailingBrowserContext()
            self.dy_client = FakeClient()

        async def search(self):
            return await self.dy_client.search_info_by_keyword(keyword="袜子")

        async def get_comments(self, aweme_id, _semaphore):
            return f"comments-{aweme_id}"

        async def start(self):
            self.search_result = await self.search()
            self.comments_result = await self.get_comments("73001", None)

    crawler = FakeCrawler()
    _execute_upstream(
        spec,
        config_module=SimpleNamespace(),
        crawler_factory=lambda: crawler,
        capture_installer=lambda *_: None,
    )

    assert crawler.search_result == "search-袜子"
    assert crawler.comments_result == "comments-73001"
    assert crawler.browser_context.new_page_calls == 2


def test_execute_upstream_publishes_opening_only_after_standard_browser_launch(
    tmp_path, monkeypatch,
):
    spec = tmp_path / "request.json"
    spec.write_text(json.dumps({
        "profile": str(tmp_path / "profile"),
        "output": str(tmp_path / "output"),
        "keywords": ["袜子"],
        "max_videos": 2,
        "max_comments_per_video": 2,
        "max_pages_per_video": 1,
        "collect_creators": False,
        "collect_demand_comments": False,
        "headless": False,
    }), encoding="utf-8")
    events = []
    original_writer = crawl_jobs._write_activity_snapshot

    def writer(path, *, phase, current_keyword, browser_mode):
        events.append(f"activity:{phase}")
        original_writer(
            path,
            phase=phase,
            current_keyword=current_keyword,
            browser_mode=browser_mode,
        )

    class FakeCrawler:
        async def launch_browser(self, *_args, **_kwargs):
            events.append("launch_returned")
            return object()

        async def search(self):
            return None

        async def get_comments(self, *_args):
            return None

        async def start(self):
            self.browser_context = await self.launch_browser(None, None, None)

    monkeypatch.setattr(crawl_jobs, "_write_activity_snapshot", writer)
    _execute_upstream(
        spec,
        config_module=SimpleNamespace(),
        crawler_factory=FakeCrawler,
        capture_installer=lambda *_: None,
    )

    assert events == [
        "launch_returned",
        "activity:opening_douyin",
        "activity:finalizing",
    ]


def test_runner_reads_each_activity_snapshot_once_when_replaced_during_a_poll(
    tmp_path, monkeypatch,
):
    service_root = tmp_path / "service"
    runner = MediaCrawlerRunner(headless=False, service_root=service_root)
    request_value = request("activity-race").model_copy(update={
        "deadline_at": datetime.now(UTC) + timedelta(minutes=5),
    })
    activity_path = (
        service_root / ".shensi-crawl-output" / "activity-race" / "activity.json"
    )
    starting = json.dumps({
        "phase": "starting_browser", "current_keyword": None,
        "browser_mode": "visible",
    }, separators=(",", ":"))
    opening = json.dumps({
        "phase": "opening_douyin", "current_keyword": None,
        "browser_mode": "visible",
    }, separators=(",", ":"))

    class FakeProcess:
        returncode = None

        def __init__(self):
            self.polls = 0

        def poll(self):
            self.polls += 1
            if self.polls == 1:
                return None
            self.returncode = 0
            return 0

    process = FakeProcess()

    def popen(*_args, **_kwargs):
        activity_path.parent.mkdir(parents=True, exist_ok=True)
        activity_path.write_text(opening, encoding="utf-8")
        return process

    original_read_text = Path.read_text
    reads = iter([starting, opening, opening, opening])

    def read_text(path, *args, **kwargs):
        if path == activity_path:
            return next(reads)
        return original_read_text(path, *args, **kwargs)

    monkeypatch.setattr("shensi_adapter.crawl_jobs.subprocess.Popen", popen)
    monkeypatch.setattr(Path, "read_text", read_text)

    activities = [
        value for value in runner(request_value, tmp_path / "profile", threading.Event())
        if isinstance(value, CrawlActivity)
    ]

    assert activities == [
        CrawlActivity(
            phase="starting_browser", current_keyword=None,
            browser_mode="visible", sequence=0,
        ),
        CrawlActivity(
            phase="opening_douyin", current_keyword=None,
            browser_mode="visible", sequence=0,
        ),
    ]


def test_manager_persists_only_authorized_activity_keywords_with_monotonic_sequence(tmp_path):
    entered = threading.Event()
    release = threading.Event()

    def runner(_request, _profile, _cancelled):
        yield CrawlActivity(
            phase="searching", current_keyword="industrial pump",
            browser_mode="visible", sequence=999,
        )
        entered.set()
        release.wait(1)

    manager = CrawlJobManager(
        tmp_path,
        account_resolver=lambda *_: tmp_path / "profile",
        runner=runner,
        now=lambda: NOW,
    )
    manager.start(request("activity-job"))
    assert entered.wait(1)

    assert manager.get("activity-job").activity == CrawlActivity(
        phase="searching", current_keyword="industrial pump",
        browser_mode="visible", sequence=2,
    )
    release.set()
    terminal = wait_terminal(manager, "activity-job")
    assert terminal.activity == CrawlActivity(
        phase="completed", current_keyword=None,
        browser_mode="visible", sequence=3,
    )
    manager.close()


def test_manager_rejects_an_activity_keyword_outside_the_frozen_request(tmp_path):
    def runner(_request, _profile, _cancelled):
        yield CrawlActivity(
            phase="searching", current_keyword="unapproved keyword",
            browser_mode="visible", sequence=1,
        )

    manager = CrawlJobManager(
        tmp_path,
        account_resolver=lambda *_: tmp_path / "profile",
        runner=runner,
        now=lambda: NOW,
    )
    manager.start(request("invalid-activity-job"))

    terminal = wait_terminal(manager, "invalid-activity-job")

    assert terminal.state == "failed"
    assert terminal.failure_code == "crawl_failed"
    assert terminal.activity.current_keyword is None
    manager.close()


def test_manager_publishes_starting_browser_before_invoking_the_runner(tmp_path):
    observed = []

    def runner(current_request, _profile, _cancelled):
        observed.append(manager.get(current_request.job_id).activity)
        return []

    manager = CrawlJobManager(
        tmp_path,
        account_resolver=lambda *_: tmp_path / "profile",
        runner=runner,
        now=lambda: NOW,
    )
    manager.start(request("synchronous-starting"))

    assert wait_terminal(manager, "synchronous-starting").state == "succeeded"
    assert observed == [CrawlActivity(
        phase="starting_browser", current_keyword=None,
        browser_mode="headless", sequence=1,
    )]
    manager.close()


def test_manager_ignores_an_identical_activity_without_advancing_metadata(tmp_path):
    entered = threading.Event()
    release = threading.Event()
    clock = [NOW]

    def runner(_request, _profile, _cancelled):
        entered.set()
        release.wait(1)
        return []

    manager = CrawlJobManager(
        tmp_path,
        account_resolver=lambda *_: tmp_path / "profile",
        runner=runner,
        now=lambda: clock[0],
    )
    manager.start(request("identical-activity"))
    assert entered.wait(1)
    before = manager.get("identical-activity")
    clock[0] += timedelta(seconds=1)

    with manager._lock:
        manager._publish_activity(
            manager._jobs["identical-activity"],
            request("identical-activity"),
            before.activity,
        )

    after = manager.get("identical-activity")
    assert after.activity == before.activity
    assert after.updated_at == before.updated_at
    release.set()
    wait_terminal(manager, "identical-activity")
    manager.close()


@pytest.mark.parametrize(("job_id", "partial"), [
    ("terminal-succeeded", False),
    ("terminal-partial", True),
])
def test_manager_persists_final_page_and_terminal_activity_together(
    tmp_path, job_id, partial,
):
    record = normalize_douyin_records(fixtures(), observed_at=NOW)[0]

    def runner(_request, _profile, _cancelled):
        yield record
        if partial:
            raise RuntimeError("upstream_browser_closed")

    manager = CrawlJobManager(
        tmp_path,
        account_resolver=lambda *_: tmp_path / "profile",
        runner=runner,
        now=lambda: NOW,
    )
    writes = []
    persist = manager._persist

    def capture_persist(job):
        writes.append(copy.deepcopy(job))
        persist(job)

    manager._persist = capture_persist
    manager.start(request(job_id))
    terminal = wait_terminal(manager, job_id)

    expected_state = "partial" if partial else "succeeded"
    assert terminal.state == expected_state
    assert terminal.activity == CrawlActivity(
        phase="completed", current_keyword=None,
        browser_mode="headless", sequence=2,
    )
    terminal_writes = [
        saved for saved in writes
        if saved["pages"] and saved["pages"][-1]["next_cursor"] is None
    ]
    assert len(terminal_writes) == 1
    assert terminal_writes[0]["state"] == expected_state
    assert terminal_writes[0]["activity"] == terminal.activity.model_dump(mode="json")
    assert not any(
        saved["state"] == "running"
        and saved["pages"]
        and saved["pages"][-1]["next_cursor"] is None
        for saved in writes
    )
    persisted = json.loads(
        (tmp_path / "crawl-jobs" / job_id / "job.json").read_text(encoding="utf-8")
    )
    assert persisted["state"] == expected_state
    assert persisted["activity"] == terminal.activity.model_dump(mode="json")
    manager.close()


def wait_terminal(manager, job_id):
    deadline = time.monotonic() + 2
    while time.monotonic() < deadline:
        status = manager.get(job_id)
        if status.state in {"succeeded", "partial", "cancelled", "failed"}:
            return status
        time.sleep(0.01)
    raise AssertionError("crawl did not terminate")


def test_normalizer_emits_closed_bounded_records_with_stable_hashes():
    records = normalize_douyin_records(fixtures(), observed_at=NOW)

    assert [record.kind for record in records] == ["video", "creator", "comment"]
    assert str(records[0].canonical_url) == "https://www.douyin.com/video/73001"
    assert len(records[0].text_excerpt) == 500
    assert str(records[1].canonical_url) == "https://www.douyin.com/user/MS4wLjABAAAA"
    assert str(records[2].canonical_url) == "https://www.douyin.com/video/73001"
    assert records[1].actor_kind == "creator"
    assert records[2].actor_kind == "commenter"
    assert str(records[2].public_profile_url) == "https://www.douyin.com/user/MS4wLjABCommenter"
    assert all(record.content_hash.startswith("sha256:") and len(record.content_hash) == 71 for record in records)
    encoded = json.dumps([record.model_dump(mode="json") for record in records])
    assert "cookie" not in encoded.lower()
    assert "raw_response" not in encoded.lower()
    assert normalize_douyin_records(fixtures(), observed_at=NOW)[0].content_hash == records[0].content_hash


def test_capture_derives_bounded_sidecar_rows_from_real_mediacrawler_authors():
    comment = _public_comment_capture("73001", {
        "aweme_id": "73001", "cid": "c-1", "text": "Need seals",
        "create_time": 1_724_550_500,
        "user": {
            "sec_uid": "MS4wLjABCommenter", "uid": "commenter-uid",
            "nickname": "Buyer", "avatar_medium": {"url_list": ["secret"]},
        },
    }, "replacement seal")
    assert comment == {
        "comment_id": "c-1", "aweme_id": "73001",
        "sec_uid": "MS4wLjABCommenter", "nickname": "Buyer",
        "content": "Need seals", "source_keyword": "replacement seal",
        "create_time": 1_724_550_500,
    }
    creator = _public_creator_capture({
        "aweme_id": "73001", "desc": "industrial pump",
        "author": {"sec_uid": "MS4wLjABCreator", "nickname": "Maker"},
    }, "industrial pump")
    assert creator == {
        "sec_uid": "MS4wLjABCreator", "nickname": "Maker",
        "desc": "industrial pump", "source_keyword": "industrial pump",
    }


def test_normalizer_rejects_commenters_without_a_non_root_public_identity():
    missing_actor = fixtures()
    missing_actor[-1][1].pop("sec_uid")
    with pytest.raises(ValueError, match="invalid_douyin_actor"):
        normalize_douyin_records(missing_actor, observed_at=NOW)

    root_actor = fixtures()
    root_actor[-1][1]["sec_uid"] = "/"
    with pytest.raises(ValueError, match="invalid_douyin_actor"):
        normalize_douyin_records(root_actor, observed_at=NOW)


@pytest.mark.parametrize(("creators", "comments", "expected"), [
    (True, False, ["video", "creator"]),
    (False, True, ["video", "comment"]),
])
def test_manager_filters_disabled_frozen_record_kinds(tmp_path, creators, comments, expected):
    manager = CrawlJobManager(
        tmp_path, account_resolver=lambda *_: tmp_path / "profile",
        runner=lambda *_: fixtures(), now=lambda: NOW,
    )
    manager.start(request(
        f"flags-{int(creators)}-{int(comments)}",
        collect_creators=creators,
        collect_demand_comments=comments,
    ))
    job_id = f"flags-{int(creators)}-{int(comments)}"
    assert wait_terminal(manager, job_id).state == "succeeded"
    assert [record.kind for record in manager.page(job_id, None).records] == expected
    manager.close()


def test_manager_enforces_one_active_job_per_account_and_replays_opaque_cursor(tmp_path):
    gate = threading.Event()

    def runner(_request, _profile, cancelled):
        gate.wait(1)
        if cancelled.is_set():
            return []
        return fixtures()

    manager = CrawlJobManager(
        tmp_path,
        account_resolver=lambda handle, version: tmp_path / f"{handle}-{version}",
        runner=runner,
        now=lambda: NOW,
        page_size=2,
    )
    first = manager.start(request())
    assert first.state in {"queued", "running"}
    with pytest.raises(ValueError, match="account_crawl_active"):
        manager.start(request("job-2"))
    gate.set()
    assert wait_terminal(manager, "job-1").state == "succeeded"

    first_page = manager.page("job-1", None)
    replay = manager.page("job-1", None)
    assert first_page == replay
    assert first_page.cursor is None
    assert first_page.next_cursor is not None
    assert len(first_page.records) == 2
    second_page = manager.page("job-1", first_page.next_cursor)
    assert second_page.done is True
    assert len(second_page.records) == 1
    assert first_page.next_cursor != "1"
    with pytest.raises(CursorConflict):
        manager.page("job-1", "reordered-cursor")
    manager.close()


def test_manager_publishes_full_pages_while_the_runner_is_still_running(tmp_path):
    runner_waiting = threading.Event()
    release = threading.Event()
    records = normalize_douyin_records(fixtures(), observed_at=NOW)

    def streaming_runner(_request, _profile, _cancelled):
        yield records[0]
        yield records[1]
        runner_waiting.set()
        release.wait(1)
        yield records[2]

    manager = CrawlJobManager(
        tmp_path,
        account_resolver=lambda *_: tmp_path / "profile",
        runner=streaming_runner,
        now=lambda: NOW,
        page_size=2,
    )
    manager.start(request("streaming-job"))
    assert runner_waiting.wait(1)

    deadline = time.monotonic() + 1
    while True:
        running = manager.get("streaming-job")
        if running.record_count == 2:
            break
        assert time.monotonic() < deadline
        time.sleep(0.01)
    assert running.state == "running"
    assert running.page_count == 1
    first_page = manager.page("streaming-job", None)
    assert first_page.done is False
    assert len(first_page.records) == 2

    release.set()
    terminal = wait_terminal(manager, "streaming-job")
    assert terminal.state == "succeeded"
    assert terminal.record_count == 3
    assert terminal.page_count == 2
    final_page = manager.page("streaming-job", first_page.next_cursor)
    assert final_page.done is True
    assert len(final_page.records) == 1
    manager.close()


def test_media_crawler_runner_streams_completed_jsonl_rows_before_process_exit(
    tmp_path, monkeypatch,
):
    process_release = threading.Event()

    class FakeProcess:
        pid = 90001
        returncode = None

        def poll(self):
            if not process_release.is_set():
                return None
            self.returncode = 0
            return 0

    process = FakeProcess()
    service_root = tmp_path / "service"

    def popen(*_args, **_kwargs):
        output = service_root / ".shensi-crawl-output" / "runner-stream" / "douyin" / "jsonl"
        output.mkdir(parents=True)
        (output / "search_contents.jsonl").write_text(
            json.dumps(fixtures()[0][1]) + "\n", encoding="utf-8",
        )
        return process

    monkeypatch.setattr("shensi_adapter.crawl_jobs.subprocess.Popen", popen)
    manager = CrawlJobManager(
        tmp_path / "state",
        account_resolver=lambda *_: tmp_path / "profile",
        runner=MediaCrawlerRunner(service_root),
        now=lambda: NOW,
        page_size=1,
    )
    live_request = request("runner-stream").model_copy(update={
        "deadline_at": datetime.now(UTC) + timedelta(minutes=5),
    })
    try:
        manager.start(live_request)
        deadline = time.monotonic() + 1
        while manager.get("runner-stream").record_count == 0:
            assert time.monotonic() < deadline
            time.sleep(0.01)
        running = manager.get("runner-stream")
        assert running.state == "running"
        assert running.page_count == 1
    finally:
        process_release.set()
        manager.close()


def test_manager_keeps_streamed_records_when_the_runner_fails(tmp_path):
    records = normalize_douyin_records(fixtures(), observed_at=NOW)

    def interrupted_runner(_request, _profile, _cancelled):
        yield records[0]
        yield records[1]
        raise RuntimeError("upstream_browser_closed")

    manager = CrawlJobManager(
        tmp_path,
        account_resolver=lambda *_: tmp_path / "profile",
        runner=interrupted_runner,
        now=lambda: NOW,
        page_size=2,
    )
    manager.start(request("partial-job"))

    terminal = wait_terminal(manager, "partial-job")
    assert terminal.state == "partial"
    assert terminal.failure_code == "crawl_interrupted_after_partial_results"
    assert terminal.record_count == 2
    assert terminal.page_count == 2
    first_page = manager.page("partial-job", None)
    assert first_page.done is False
    final_page = manager.page("partial-job", first_page.next_cursor)
    assert final_page.done is True
    assert final_page.records == []
    manager.close()


def test_manager_cancel_is_safe_and_terminal_metadata_survives_restart_for_24_hours(tmp_path):
    entered = threading.Event()

    def runner(_request, _profile, cancelled):
        entered.set()
        cancelled.wait(1)
        return []

    manager = CrawlJobManager(
        tmp_path,
        account_resolver=lambda *_: tmp_path / "profile",
        runner=runner,
        now=lambda: NOW,
    )
    manager.start(request())
    assert entered.wait(1)
    manager.cancel("job-1")
    assert wait_terminal(manager, "job-1").state == "cancelled"
    manager.close()

    restarted = CrawlJobManager(
        tmp_path,
        account_resolver=lambda *_: tmp_path / "profile",
        runner=lambda *_: [],
        now=lambda: NOW + timedelta(hours=23, minutes=59),
    )
    assert restarted.get("job-1").state == "cancelled"
    assert restarted.sweep_retained() == 0
    restarted.close()

    expired = CrawlJobManager(
        tmp_path,
        account_resolver=lambda *_: tmp_path / "profile",
        runner=lambda *_: [],
        now=lambda: NOW + timedelta(hours=24, seconds=1),
    )
    assert expired.sweep_retained() == 0
    with pytest.raises(KeyError):
        expired.get("job-1")
    expired.close()


def test_unacknowledged_pages_survive_and_ack_timestamp_drives_restart_cleanup(tmp_path):
    clock = [NOW]
    manager = CrawlJobManager(
        tmp_path,
        account_resolver=lambda *_: tmp_path / "profile",
        runner=lambda *_: [normalize_douyin_records(fixtures(), observed_at=NOW)[0]],
        now=lambda: clock[0],
    )
    manager.start(request("ack-job"))
    assert wait_terminal(manager, "ack-job").state == "succeeded"
    clock[0] = NOW + timedelta(days=7)
    assert manager.sweep_retained() == 0
    acknowledged_at = manager.acknowledge("ack-job")
    assert acknowledged_at == clock[0]
    manager.close()

    clock[0] += timedelta(hours=23, minutes=59)
    restarted = CrawlJobManager(
        tmp_path,
        account_resolver=lambda *_: tmp_path / "profile",
        runner=lambda *_: [],
        now=lambda: clock[0],
    )
    assert restarted.get("ack-job").acknowledged_at == acknowledged_at
    assert restarted.sweep_retained() == 0
    restarted.close()

    clock[0] += timedelta(minutes=2)
    expired = CrawlJobManager(
        tmp_path,
        account_resolver=lambda *_: tmp_path / "profile",
        runner=lambda *_: [],
        now=lambda: clock[0],
    )
    with pytest.raises(KeyError):
        expired.get("ack-job")
    expired.close()


def test_acknowledgement_persist_failure_does_not_mutate_live_or_restart_state(tmp_path):
    manager = CrawlJobManager(
        tmp_path,
        account_resolver=lambda *_: tmp_path / "profile",
        runner=lambda *_: [normalize_douyin_records(fixtures(), observed_at=NOW)[0]],
        now=lambda: NOW,
    )
    manager.start(request("ack-failure"))
    assert wait_terminal(manager, "ack-failure").state == "succeeded"
    persist = manager._persist

    def fail_persist(_job):
        raise OSError("disk-full")

    manager._persist = fail_persist
    with pytest.raises(OSError, match="disk-full"):
        manager.acknowledge("ack-failure")
    assert manager.get("ack-failure").acknowledged_at is None
    manager._persist = persist
    manager.close()

    restarted = CrawlJobManager(
        tmp_path,
        account_resolver=lambda *_: tmp_path / "profile",
        runner=lambda *_: [],
        now=lambda: NOW + timedelta(hours=25),
    )
    assert restarted.get("ack-failure").acknowledged_at is None
    restarted.close()


def test_retention_sweep_removes_the_private_upstream_capture(tmp_path):
    clock = [NOW]

    class Runner:
        def __init__(self):
            self.cleaned = []

        def __call__(self, *_args):
            return [normalize_douyin_records(fixtures(), observed_at=NOW)[0]]

        def cleanup(self, job_id):
            self.cleaned.append(job_id)

    runner = Runner()
    manager = CrawlJobManager(
        tmp_path, account_resolver=lambda *_: tmp_path / "profile",
        runner=runner, now=lambda: clock[0],
    )
    manager.start(request("capture-retention"))
    assert wait_terminal(manager, "capture-retention").state == "succeeded"
    manager.acknowledge("capture-retention")
    clock[0] += timedelta(hours=24, seconds=1)
    assert manager.sweep_retained() == 1
    assert runner.cleaned == ["capture-retention"]
    manager.close()


def test_manager_sweeps_retention_on_startup_and_periodically_and_cleans_maps(tmp_path):
    clock = [NOW]
    manager = CrawlJobManager(
        tmp_path, account_resolver=lambda *_: tmp_path / "profile",
        runner=lambda *_: [], now=lambda: clock[0],
        sweep_interval=timedelta(milliseconds=10),
    )
    manager.start(request("cleanup-job"))
    assert wait_terminal(manager, "cleanup-job").state == "succeeded"
    manager.acknowledge("cleanup-job")
    deadline = time.monotonic() + 1
    while ("cleanup-job" in manager._threads or "cleanup-job" in manager._cancel):
        assert time.monotonic() < deadline
        time.sleep(0.01)

    clock[0] += timedelta(hours=24, seconds=1)
    deadline = time.monotonic() + 1
    while (tmp_path / "crawl-jobs" / "cleanup-job").exists():
        assert time.monotonic() < deadline
        time.sleep(0.01)
    assert "cleanup-job" not in manager._jobs
    manager.close()

    restarted = CrawlJobManager(
        tmp_path, account_resolver=lambda *_: tmp_path / "profile",
        runner=lambda *_: [], now=lambda: clock[0],
        sweep_interval=timedelta(hours=1),
    )
    with pytest.raises(KeyError):
        restarted.get("cleanup-job")
    restarted.close()


def test_manager_close_uses_one_global_deadline_for_all_workers(tmp_path):
    release = threading.Event()
    entered = [threading.Event(), threading.Event()]

    def blocking_runner(job, _profile, _cancelled):
        entered[int(job.job_id[-1]) - 1].set()
        release.wait(2)
        return []

    manager = CrawlJobManager(
        tmp_path, account_resolver=lambda *_: tmp_path / "profile",
        runner=blocking_runner, now=lambda: NOW,
        shutdown_timeout=0.05,
    )
    manager.start(request("worker-1", "account-1"))
    manager.start(request("worker-2", "account-2"))
    assert all(event.wait(1) for event in entered)

    started = time.monotonic()
    with pytest.raises(RuntimeError, match="crawl_job_shutdown_timeout"):
        manager.close()
    assert time.monotonic() - started < 0.15
    release.set()
