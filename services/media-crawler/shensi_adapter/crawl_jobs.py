"""Restart-safe private MediaCrawler job manager with append-only result pages."""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import secrets
import shutil
import signal
import subprocess
import sys
import threading
import time
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Callable, Iterable, Mapping
from urllib.parse import quote

from .douyin_normalizer import normalize_douyin_records
from .schemas import (
    CrawlActivity, CrawlJobPage, CrawlJobRequest, CrawlJobView,
    NormalizedDouyinRecord,
)


class CursorConflict(ValueError):
    pass


Runner = Callable[
    [CrawlJobRequest, Path, threading.Event],
    Iterable[
        tuple[str, Mapping[str, object]] | NormalizedDouyinRecord | CrawlActivity,
    ],
]


def _atomic_json(path: Path, value: object) -> None:
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    os.chmod(temporary, 0o600)
    os.replace(temporary, path)
    os.chmod(path, 0o600)


def _instant(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def _output_row_identity(kind: str, value: Mapping[str, object]) -> str:
    return str(
        value.get("aweme_id") if kind == "video"
        else value.get("sec_uid") or value.get("sec_user_id")
        or value.get("user_id") or value.get("uid")
        if kind == "creator"
        else value.get("comment_id") or value.get("cid")
        or ""
    )


def _read_output_rows(
    output: Path, *, ignore_incomplete_tail: bool = False,
) -> list[tuple[str, Mapping[str, object]]]:
    rows: list[tuple[str, Mapping[str, object]]] = []
    seen: set[tuple[str, str]] = set()
    for kind, pattern in (("video", "*contents*.jsonl"),
                          ("creator", "*creators*.jsonl"),
                          ("comment", "*comments*.jsonl")):
        for path in sorted(output.glob(f"douyin/jsonl/{pattern}")):
            payload = path.read_bytes()
            if ignore_incomplete_tail and not payload.endswith(b"\n"):
                boundary = payload.rfind(b"\n")
                if boundary < 0:
                    continue
                payload = payload[:boundary + 1]
            for line in payload.decode("utf-8").split("\n"):
                if not line.strip():
                    continue
                value = json.loads(line)
                if isinstance(value, dict):
                    identity = _output_row_identity(kind, value)
                    key = (kind, identity)
                    if identity and key in seen:
                        continue
                    if identity:
                        seen.add(key)
                    rows.append((kind, value))
    return rows


def _capture_text(value: object, maximum: int) -> str:
    return "" if value is None else "".join(list(str(value).strip())[:maximum])


def _capture_actor(value: Mapping[str, object]) -> str:
    actor = _capture_text(
        value.get("sec_uid") or value.get("sec_user_id")
        or value.get("user_id") or value.get("uid"),
        300,
    )
    return actor if re.fullmatch(r"[A-Za-z0-9_-]{1,300}", actor) else ""


def _public_comment_capture(aweme_id: str, raw: Mapping[str, object],
                            source_keyword: str) -> dict[str, object] | None:
    user = raw.get("user") if isinstance(raw.get("user"), Mapping) else {}
    actor = _capture_actor(user)
    comment_id = _capture_text(raw.get("cid") or raw.get("comment_id"), 160)
    video_id = _capture_text(raw.get("aweme_id") or aweme_id, 160)
    if not actor or not comment_id or not video_id:
        return None
    return {
        "comment_id": comment_id,
        "aweme_id": video_id,
        "sec_uid": actor,
        "nickname": _capture_text(user.get("nickname"), 200),
        "content": _capture_text(raw.get("text") or raw.get("content"), 500),
        "source_keyword": _capture_text(source_keyword, 100),
        "create_time": raw.get("create_time"),
    }


def _public_creator_capture(raw: Mapping[str, object],
                            source_keyword: str) -> dict[str, object] | None:
    author = raw.get("author") if isinstance(raw.get("author"), Mapping) else {}
    actor = _capture_actor(author)
    if not actor:
        return None
    return {
        "sec_uid": actor,
        "nickname": _capture_text(author.get("nickname"), 200),
        "desc": _capture_text(raw.get("desc"), 500),
        "source_keyword": _capture_text(source_keyword, 100),
    }


def _append_public_capture(path: Path, value: Mapping[str, object]) -> None:
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(path.parent, 0o700)
    with path.open("a", encoding="utf-8") as stream:
        stream.write(json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n")
    os.chmod(path, 0o600)


def _install_public_actor_capture(output: Path, collect_creators: bool) -> None:
    from store import douyin as douyin_store

    original_comment = douyin_store.update_dy_aweme_comment
    original_aweme = douyin_store.update_douyin_aweme
    capture_root = output / "douyin" / "jsonl"

    async def capture_comment(aweme_id: str, comment_item: Mapping[str, object]):
        row = _public_comment_capture(
            aweme_id, comment_item, douyin_store.source_keyword_var.get(),
        )
        if row:
            _append_public_capture(capture_root / "000-shensi-comments.jsonl", row)
        await original_comment(aweme_id, comment_item)

    async def capture_aweme(aweme_item: Mapping[str, object]):
        if collect_creators:
            row = _public_creator_capture(
                aweme_item, douyin_store.source_keyword_var.get(),
            )
            if row:
                _append_public_capture(capture_root / "000-shensi-creators.jsonl", row)
        await original_aweme(aweme_item)

    douyin_store.update_dy_aweme_comment = capture_comment
    douyin_store.update_douyin_aweme = capture_aweme


def _browser_profile_template(profile: Path) -> str:
    # MediaCrawler interpolates PLATFORM into USER_DATA_DIR unconditionally.
    # A zero-width conversion preserves the exact account-owned absolute path.
    return str(profile).replace("%", "%%") + "%.0s"


def _write_activity_snapshot(path: Path, *, phase: str, current_keyword: str | None,
                             browser_mode: str) -> None:
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(path.parent, 0o700)
    _atomic_json(path, {
        "phase": phase,
        "current_keyword": current_keyword,
        "browser_mode": browser_mode,
    })


def _read_activity_snapshot(path: Path) -> CrawlActivity | None:
    if not path.is_file():
        return None
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError("invalid_crawl_activity")
    return CrawlActivity.model_validate({**value, "sequence": 0})


class _VisibleDouyinObserver:
    """Adds operator-visible, allowlisted navigation around upstream reads."""

    def __init__(self, *, browser_mode: str, activity_path: Path) -> None:
        self._browser_mode = browser_mode
        self._activity_path = activity_path
        self._current_keyword: str | None = None

    def _publish(self, phase: str, current_keyword: str | None = None) -> None:
        _write_activity_snapshot(
            self._activity_path,
            phase=phase,
            current_keyword=current_keyword,
            browser_mode=self._browser_mode,
        )

    async def _open_search(self, page: object, keyword: object) -> None:
        normalized_keyword = str(keyword)
        self._current_keyword = normalized_keyword
        self._publish("searching", normalized_keyword)
        await page.goto(  # type: ignore[attr-defined]
            f"https://www.douyin.com/search/{quote(normalized_keyword, safe='')}?type=general"
        )

    async def _open_video(self, page: object, aweme_id: object) -> None:
        normalized_aweme_id = str(aweme_id)
        self._publish("collecting_comments", self._current_keyword)
        if re.fullmatch(r"[0-9]{1,32}", normalized_aweme_id):
            await page.goto(  # type: ignore[attr-defined]
                f"https://www.douyin.com/video/{normalized_aweme_id}"
            )

    def install(self, crawler: object) -> None:
        original_search = crawler.search  # type: ignore[attr-defined]
        original_get_comments = crawler.get_comments  # type: ignore[attr-defined]

        async def observed_search():
            client = crawler.dy_client  # type: ignore[attr-defined]
            original_search_info = client.search_info_by_keyword

            async def observed_search_info(*args, **kwargs):
                keyword = kwargs.get("keyword", args[0] if args else "")
                await self._open_search(crawler.context_page, keyword)  # type: ignore[attr-defined]
                return await original_search_info(*args, **kwargs)

            client.search_info_by_keyword = observed_search_info
            return await original_search()

        async def observed_get_comments(aweme_id, *args, **kwargs):
            await self._open_video(crawler.context_page, aweme_id)  # type: ignore[attr-defined]
            return await original_get_comments(aweme_id, *args, **kwargs)

        crawler.search = observed_search  # type: ignore[attr-defined]
        crawler.get_comments = observed_get_comments  # type: ignore[attr-defined]


class MediaCrawlerRunner:
    """Runs the pinned in-tree API in an isolated process; no user shell text."""

    def __init__(self, headless: bool | Path = True,
                 service_root: Path | None = None) -> None:
        # Keep the earlier positional service-root seam compatible with focused
        # tests while making browser mode explicit for all new callers.
        if isinstance(headless, Path):
            service_root, headless = headless, True
        self._headless = bool(headless)
        self._service_root = service_root or Path(__file__).resolve().parents[1]

    @property
    def browser_mode(self) -> str:
        return "headless" if self._headless else "visible"

    def __call__(self, request: CrawlJobRequest, profile: Path,
                 cancelled: threading.Event):
        output = self._service_root / ".shensi-crawl-output" / request.job_id
        output.mkdir(mode=0o700, parents=True, exist_ok=True)
        spec = output / "request.json"
        _atomic_json(spec, {
            "profile": str(profile), "output": str(output),
            "keywords": request.keywords, "max_videos": request.max_videos,
            "max_comments_per_video": request.max_comments_per_video,
            "max_pages_per_video": request.max_pages_per_video,
            "collect_creators": request.collect_creators,
            "collect_demand_comments": request.collect_demand_comments,
            "headless": self._headless,
        })
        command = [sys.executable, "-m", "shensi_adapter.crawl_jobs", "--execute", str(spec)]
        process = subprocess.Popen(command, cwd=self._service_root, start_new_session=True,
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        deadline = request.deadline_at.timestamp()
        seen: set[tuple[str, str]] = set()
        activity_path = output / "activity.json"
        previous_activity: str | None = None

        def newly_completed_rows(*, live: bool):
            for kind, value in _read_output_rows(
                output, ignore_incomplete_tail=live,
            ):
                identity = _output_row_identity(kind, value)
                key = (kind, identity or json.dumps(
                    value, ensure_ascii=False, sort_keys=True, separators=(",", ":"),
                ))
                if key in seen:
                    continue
                seen.add(key)
                yield kind, value

        def newly_published_activity():
            nonlocal previous_activity
            if not activity_path.is_file():
                return
            encoded = activity_path.read_text(encoding="utf-8")
            if encoded == previous_activity:
                return
            previous_activity = encoded
            activity = _read_activity_snapshot(activity_path)
            if activity is not None:
                yield activity

        termination_error: Exception | None = None
        while process.poll() is None:
            if cancelled.is_set() or time.time() >= deadline:
                os.killpg(process.pid, signal.SIGTERM)
                try:
                    process.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    os.killpg(process.pid, signal.SIGKILL)
                    process.wait(timeout=3)
                if cancelled.is_set():
                    break
                termination_error = TimeoutError("crawl_deadline_exceeded")
                break
            yield from newly_published_activity()
            yield from newly_completed_rows(live=True)
            time.sleep(0.05)
        yield from newly_published_activity()
        yield from newly_completed_rows(live=False)
        if cancelled.is_set():
            return
        if termination_error:
            raise termination_error
        if process.returncode != 0:
            raise RuntimeError("mediacrawler_job_failed")

    def cleanup(self, job_id: str) -> None:
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,254}", job_id):
            raise ValueError("invalid_crawl_job_id")
        shutil.rmtree(self._service_root / ".shensi-crawl-output" / job_id,
                      ignore_errors=True)


class CrawlJobManager:
    def __init__(self, root: Path, *, account_resolver: Callable[[str, int], Path],
                 runner: Runner | None = None, now: Callable[[], datetime] | None = None,
                 page_size: int = 25, retention: timedelta = timedelta(hours=24),
                 sweep_interval: timedelta = timedelta(minutes=5),
                 shutdown_timeout: float = 3.0) -> None:
        if page_size < 1 or page_size > 200:
            raise ValueError("invalid_crawl_page_size")
        if sweep_interval.total_seconds() <= 0 or shutdown_timeout <= 0:
            raise ValueError("invalid_crawl_lifecycle_bounds")
        self._root = root.resolve() / "crawl-jobs"
        self._root.mkdir(mode=0o700, parents=True, exist_ok=True)
        os.chmod(self._root, 0o700)
        self._resolve = account_resolver
        self._runner = runner or MediaCrawlerRunner()
        self._now = now or (lambda: datetime.now(UTC))
        self._page_size, self._retention = page_size, retention
        self._sweep_interval = sweep_interval.total_seconds()
        self._shutdown_timeout = shutdown_timeout
        self._lock = threading.RLock()
        self._jobs: dict[str, dict] = {}
        self._cancel: dict[str, threading.Event] = {}
        self._threads: dict[str, threading.Thread] = {}
        self._closed = threading.Event()
        self._load()
        self.sweep_retained()
        self._sweeper = threading.Thread(
            target=self._sweep_loop, name="douyin-crawl-retention-sweeper",
            daemon=True,
        )
        self._sweeper.start()

    def _sweep_loop(self) -> None:
        while not self._closed.wait(self._sweep_interval):
            try:
                self.sweep_retained()
            except Exception:
                continue

    def _directory(self, job_id: str) -> Path:
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,254}", job_id):
            raise ValueError("invalid_crawl_job_id")
        return self._root / job_id

    def _persist(self, job: dict) -> None:
        _atomic_json(self._directory(job["request"]["job_id"]) / "job.json", job)

    def _load(self) -> None:
        for directory in self._root.iterdir():
            metadata = directory / "job.json"
            if directory.is_symlink() or not directory.is_dir() or metadata.is_symlink() or not metadata.is_file():
                continue
            try:
                job = json.loads(metadata.read_text(encoding="utf-8"))
                job_id = CrawlJobRequest.model_validate(job["request"]).job_id
                if job["state"] in {"queued", "running"}:
                    job["state"] = "paused"
                    job["updated_at"] = self._now().isoformat()
                    self._persist(job)
                self._jobs[job_id] = job
            except (OSError, ValueError, KeyError, json.JSONDecodeError):
                continue

    @staticmethod
    def _view(job: dict) -> CrawlJobView:
        return CrawlJobView(job_id=job["request"]["job_id"], state=job["state"],
                            created_at=job["created_at"], updated_at=job["updated_at"],
                            completed_at=job.get("completed_at"),
                            acknowledged_at=job.get("acknowledged_at"),
                            record_count=job["record_count"],
                            page_count=len(job["pages"]),
                            failure_code=job.get("failure_code"),
                            activity=CrawlActivity.model_validate(
                                job.get("activity", {
                                    "phase": "queued", "current_keyword": None,
                                    "browser_mode": "headless", "sequence": 0,
                                })
                            ))

    def _initial_activity(self) -> dict[str, object]:
        browser_mode = getattr(self._runner, "browser_mode", "headless")
        return CrawlActivity(
            phase="queued", current_keyword=None,
            browser_mode=browser_mode, sequence=0,
        ).model_dump(mode="json")

    def _publish_activity(self, job: dict, request: CrawlJobRequest,
                          activity: CrawlActivity) -> None:
        if (activity.current_keyword is not None
                and activity.current_keyword not in request.keywords):
            raise ValueError("invalid_crawl_activity_keyword")
        previous = CrawlActivity.model_validate(job["activity"])
        job["activity"] = activity.model_copy(
            update={"sequence": previous.sequence + 1},
        ).model_dump(mode="json")
        job["updated_at"] = self._now().isoformat()
        self._persist(job)

    def start(self, request: CrawlJobRequest) -> CrawlJobView:
        with self._lock:
            if self._closed.is_set():
                raise RuntimeError("crawl_job_manager_closed")
            existing = self._jobs.get(request.job_id)
            if existing and existing["request"] != request.model_dump(mode="json"):
                raise ValueError("crawl_job_binding_conflict")
            if existing and existing["state"] not in {"paused", "failed"}:
                return self._view(existing)
            for job in self._jobs.values():
                if job["request"]["account_handle"] == request.account_handle and job["state"] in {"queued", "running"}:
                    raise ValueError("account_crawl_active")
            profile = self._resolve(request.account_handle, request.login_state_version).resolve()
            directory = self._directory(request.job_id)
            directory.mkdir(mode=0o700, exist_ok=True)
            os.chmod(directory, 0o700)
            instant = self._now().isoformat()
            job = existing or {"request": request.model_dump(mode="json"), "created_at": instant,
                               "record_count": 0, "pages": [],
                               "activity": self._initial_activity()}
            job.setdefault("activity", self._initial_activity())
            job.update({"state": "queued", "updated_at": instant, "completed_at": None,
                        "acknowledged_at": None,
                        "failure_code": None})
            self._jobs[request.job_id] = job
            self._persist(job)
            cancelled = threading.Event()
            self._cancel[request.job_id] = cancelled
            thread = threading.Thread(target=self._execute, args=(request, profile, cancelled),
                                      name=f"douyin-crawl-{request.job_id}", daemon=True)
            self._threads[request.job_id] = thread
            thread.start()
            return self._view(job)

    @staticmethod
    def _record_enabled(record: NormalizedDouyinRecord,
                        request: CrawlJobRequest) -> bool:
        return (
            record.kind == "video"
            or (record.kind == "creator" and request.collect_creators)
            or (record.kind == "comment" and request.collect_demand_comments)
        )

    def _append_page(self, job: dict, records: list[NormalizedDouyinRecord],
                     *, done: bool) -> None:
        index = len(job["pages"])
        cursor = None if index == 0 else job["pages"][-1]["next_cursor"]
        if index > 0 and cursor is None:
            raise RuntimeError("crawl_page_already_terminal")
        next_cursor = None if done else secrets.token_urlsafe(32)
        page = CrawlJobPage(
            job_id=job["request"]["job_id"], cursor=cursor,
            next_cursor=next_cursor, done=done, records=records,
        )
        page_name = f"page-{index:08d}.json"
        _atomic_json(
            self._directory(job["request"]["job_id"]) / page_name,
            page.model_dump(mode="json"),
        )
        job["pages"].append({
            "cursor": cursor, "next_cursor": next_cursor, "file": page_name,
        })
        job["record_count"] += len(records)
        job["updated_at"] = self._now().isoformat()
        self._persist(job)

    def _execute(self, request: CrawlJobRequest, profile: Path, cancelled: threading.Event) -> None:
        pending: list[NormalizedDouyinRecord] = []
        seen: set[str] = set()
        try:
            with self._lock:
                job = self._jobs[request.job_id]
                job["state"], job["updated_at"] = "running", self._now().isoformat()
                self._persist(job)
            for value in self._runner(request, profile, cancelled):
                if cancelled.is_set():
                    break
                if isinstance(value, CrawlActivity):
                    with self._lock:
                        self._publish_activity(
                            self._jobs[request.job_id], request, value,
                        )
                    continue
                normalized = (
                    [value] if isinstance(value, NormalizedDouyinRecord)
                    else normalize_douyin_records([value], observed_at=self._now())
                )
                for record in normalized:
                    if record.record_id in seen or not self._record_enabled(record, request):
                        continue
                    seen.add(record.record_id)
                    pending.append(record)
                    if len(pending) == self._page_size:
                        with self._lock:
                            self._append_page(self._jobs[request.job_id], pending, done=False)
                        pending = []
            with self._lock:
                job = self._jobs[request.job_id]
                if cancelled.is_set():
                    self._finish(job, "cancelled")
                    return
                self._append_page(job, pending, done=True)
                self._finish(job, "succeeded")
        except Exception:
            with self._lock:
                job = self._jobs.get(request.job_id)
                if job:
                    if cancelled.is_set():
                        self._finish(job, "cancelled")
                    elif job["record_count"] > 0 or pending:
                        if pending or not job["pages"] or job["pages"][-1]["next_cursor"] is not None:
                            self._append_page(job, pending, done=True)
                        job["failure_code"] = "crawl_interrupted_after_partial_results"
                        self._finish(job, "partial")
                    else:
                        job["failure_code"] = "crawl_failed"
                        self._finish(job, "failed")
        finally:
            with self._lock:
                if self._threads.get(request.job_id) is threading.current_thread():
                    self._threads.pop(request.job_id, None)
                    self._cancel.pop(request.job_id, None)

    def _finish(self, job: dict, state: str) -> None:
        instant = self._now().isoformat()
        job.update({"state": state, "updated_at": instant, "completed_at": instant})
        self._persist(job)

    def get(self, job_id: str) -> CrawlJobView:
        with self._lock:
            job = self._jobs.get(job_id)
            if not job:
                raise KeyError(job_id)
            return self._view(job)

    def page(self, job_id: str, cursor: str | None) -> CrawlJobPage:
        with self._lock:
            job = self._jobs.get(job_id)
            if not job:
                raise KeyError(job_id)
            descriptor = next((page for page in job["pages"] if page["cursor"] == cursor), None)
            if not descriptor:
                raise CursorConflict("crawl_cursor_conflict")
            return CrawlJobPage.model_validate_json(
                (self._directory(job_id) / descriptor["file"]).read_text(encoding="utf-8")
            )

    def cancel(self, job_id: str) -> None:
        with self._lock:
            job = self._jobs.get(job_id)
            if not job:
                raise KeyError(job_id)
            event = self._cancel.get(job_id)
            if event:
                event.set()
            if job["state"] in {"queued", "paused"}:
                self._finish(job, "cancelled")

    def acknowledge(self, job_id: str) -> datetime:
        """Durably starts the 24-hour cleanup clock after backend ingestion."""
        with self._lock:
            job = self._jobs.get(job_id)
            if not job:
                raise KeyError(job_id)
            if job["state"] not in {"succeeded", "partial"}:
                raise ValueError("crawl_job_not_acknowledgeable")
            existing = job.get("acknowledged_at")
            if existing:
                return _instant(existing)
            instant = self._now()
            persisted = dict(job)
            persisted["acknowledged_at"] = instant.isoformat()
            persisted["updated_at"] = instant.isoformat()
            self._persist(persisted)
            self._jobs[job_id] = persisted
            return instant

    def sweep_retained(self) -> int:
        with self._lock:
            expired = [job_id for job_id, job in self._jobs.items()
                       if (job.get("acknowledged_at")
                           and self._now() >= _instant(job["acknowledged_at"]) + self._retention)
                       or (not job.get("pages") and job.get("completed_at")
                           and self._now() >= _instant(job["completed_at"]) + self._retention)]
            for job_id in expired:
                cleanup = getattr(self._runner, "cleanup", None)
                if callable(cleanup):
                    cleanup(job_id)
                shutil.rmtree(self._directory(job_id))
                self._jobs.pop(job_id, None)
                self._cancel.pop(job_id, None)
                self._threads.pop(job_id, None)
            return len(expired)

    def close(self) -> None:
        with self._lock:
            if self._closed.is_set():
                return
            self._closed.set()
            for event in self._cancel.values():
                event.set()
            threads = list(self._threads.values())
        deadline = time.monotonic() + self._shutdown_timeout
        for thread in [self._sweeper, *threads]:
            thread.join(timeout=max(0.0, deadline - time.monotonic()))
        if self._sweeper.is_alive() or any(thread.is_alive() for thread in threads):
            raise RuntimeError("crawl_job_shutdown_timeout")


def _execute_upstream(
    spec_path: Path,
    *,
    config_module: object | None = None,
    crawler_factory: Callable[[], object] | None = None,
    capture_installer: Callable[[Path, bool], None] | None = None,
) -> None:
    value = json.loads(spec_path.read_text(encoding="utf-8"))
    if config_module is None:
        import config
    else:
        config = config_module
    if crawler_factory is None:
        from media_platform.douyin import DouYinCrawler
        crawler_factory = DouYinCrawler
    if capture_installer is None:
        capture_installer = _install_public_actor_capture
    headless = bool(value.get("headless", True))
    output = Path(value["output"])
    activity_path = output / "activity.json"
    browser_mode = "headless" if headless else "visible"
    _write_activity_snapshot(
        activity_path, phase="starting_browser", current_keyword=None,
        browser_mode=browser_mode,
    )
    config.PLATFORM = "dy"
    config.LOGIN_TYPE = "qrcode"
    config.CRAWLER_TYPE = "search"
    config.ENABLE_CDP_MODE = False
    config.CDP_CONNECT_EXISTING = False
    config.HEADLESS = headless
    config.CDP_HEADLESS = headless
    config.KEYWORDS = ",".join(value["keywords"])
    config.ENABLE_GET_COMMENTS = bool(value["collect_demand_comments"])
    config.ENABLE_GET_SUB_COMMENTS = False
    config.SAVE_DATA_OPTION = "jsonl"
    config.SAVE_DATA_PATH = value["output"]
    config.SAVE_LOGIN_STATE = True
    config.USER_DATA_DIR = _browser_profile_template(Path(value["profile"]))
    config.CRAWLER_MAX_NOTES_COUNT = int(value["max_videos"])
    config.CRAWLER_MAX_COMMENTS_COUNT_SINGLENOTES = min(
        int(value["max_comments_per_video"]),
        int(value["max_pages_per_video"]) * 20,
    )
    config.MAX_CONCURRENCY_NUM = 1
    config.ENABLE_GET_WORDCLOUD = False
    capture_installer(
        output, bool(value["collect_creators"]),
    )
    crawler = crawler_factory()
    _VisibleDouyinObserver(
        browser_mode=browser_mode, activity_path=activity_path,
    ).install(crawler)
    _write_activity_snapshot(
        activity_path, phase="opening_douyin", current_keyword=None,
        browser_mode=browser_mode,
    )
    try:
        asyncio.run(crawler.start())  # type: ignore[attr-defined]
    finally:
        _write_activity_snapshot(
            activity_path, phase="finalizing", current_keyword=None,
            browser_mode=browser_mode,
        )
    _write_activity_snapshot(
        activity_path, phase="completed", current_keyword=None,
        browser_mode=browser_mode,
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--execute", type=Path, required=True)
    _execute_upstream(parser.parse_args().execute)
