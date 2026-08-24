import json
import threading
import time
from datetime import UTC, datetime, timedelta

import pytest

from shensi_adapter.crawl_jobs import (
    CrawlJobManager, CursorConflict, _browser_profile_template, _read_output_rows,
)
from shensi_adapter.douyin_normalizer import normalize_douyin_records
from shensi_adapter.schemas import CrawlJobRequest


NOW = datetime(2026, 8, 24, 1, 2, 3, tzinfo=UTC)


def request(job_id="job-1", account_handle="account-private-1"):
    return CrawlJobRequest(
        job_id=job_id,
        account_handle=account_handle,
        login_state_version=4,
        keywords=["industrial pump", "replacement seal"],
        max_videos=2,
        max_comments_per_video=2,
        max_pages_per_video=1,
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

    assert _read_output_rows(tmp_path) == [("video", {"aweme_id": "73001"})]


def test_pinned_runner_preserves_the_exact_private_browser_profile_path(tmp_path):
    profile = tmp_path / "account%private" / "profile"

    assert _browser_profile_template(profile) % "dy" == str(profile)


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
    assert all(record.content_hash.startswith("sha256:") and len(record.content_hash) == 71 for record in records)
    encoded = json.dumps([record.model_dump(mode="json") for record in records])
    assert "cookie" not in encoded.lower()
    assert "raw_response" not in encoded.lower()
    assert normalize_douyin_records(fixtures(), observed_at=NOW)[0].content_hash == records[0].content_hash


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


def test_manager_cancel_is_safe_and_acknowledged_pages_survive_restart_for_24_hours(tmp_path):
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
    assert expired.sweep_retained() == 1
    with pytest.raises(KeyError):
        expired.get("job-1")
    expired.close()
