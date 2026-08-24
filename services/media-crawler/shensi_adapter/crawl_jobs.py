"""Restart-safe private MediaCrawler job manager with append-only result pages."""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import secrets
import signal
import subprocess
import sys
import threading
import time
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Callable, Iterable, Mapping

from .douyin_normalizer import normalize_douyin_records
from .schemas import (
    CrawlJobPage, CrawlJobRequest, CrawlJobView, NormalizedDouyinRecord,
)


class CursorConflict(ValueError):
    pass


Runner = Callable[
    [CrawlJobRequest, Path, threading.Event],
    Iterable[tuple[str, Mapping[str, object]]] | Iterable[NormalizedDouyinRecord],
]


def _atomic_json(path: Path, value: object) -> None:
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    os.chmod(temporary, 0o600)
    os.replace(temporary, path)
    os.chmod(path, 0o600)


def _instant(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def _read_output_rows(output: Path) -> list[tuple[str, Mapping[str, object]]]:
    rows: list[tuple[str, Mapping[str, object]]] = []
    for kind, pattern in (("video", "*contents*.jsonl"),
                          ("creator", "*creators*.jsonl"),
                          ("comment", "*comments*.jsonl")):
        for path in sorted(output.glob(f"douyin/jsonl/{pattern}")):
            for line in path.read_text(encoding="utf-8").splitlines():
                value = json.loads(line)
                if isinstance(value, dict):
                    rows.append((kind, value))
    return rows


def _browser_profile_template(profile: Path) -> str:
    # MediaCrawler interpolates PLATFORM into USER_DATA_DIR unconditionally.
    # A zero-width conversion preserves the exact account-owned absolute path.
    return str(profile).replace("%", "%%") + "%.0s"


class MediaCrawlerRunner:
    """Runs the pinned in-tree API in an isolated process; no user shell text."""

    def __init__(self, service_root: Path | None = None) -> None:
        self._service_root = service_root or Path(__file__).resolve().parents[1]

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
        })
        command = [sys.executable, "-m", "shensi_adapter.crawl_jobs", "--execute", str(spec)]
        process = subprocess.Popen(command, cwd=self._service_root, start_new_session=True,
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        deadline = request.deadline_at.timestamp()
        while process.poll() is None:
            if cancelled.is_set() or time.time() >= deadline:
                os.killpg(process.pid, signal.SIGTERM)
                try:
                    process.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    os.killpg(process.pid, signal.SIGKILL)
                    process.wait(timeout=3)
                if cancelled.is_set():
                    return []
                raise TimeoutError("crawl_deadline_exceeded")
            time.sleep(0.05)
        if process.returncode != 0:
            raise RuntimeError("mediacrawler_job_failed")
        return _read_output_rows(output)


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
                            failure_code=job.get("failure_code"))

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
                               "record_count": 0, "pages": []}
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

    def _execute(self, request: CrawlJobRequest, profile: Path, cancelled: threading.Event) -> None:
        try:
            with self._lock:
                job = self._jobs[request.job_id]
                job["state"], job["updated_at"] = "running", self._now().isoformat()
                self._persist(job)
            values = list(self._runner(request, profile, cancelled))
            records = values if all(isinstance(value, NormalizedDouyinRecord) for value in values) else normalize_douyin_records(values, observed_at=self._now())
            records = [record for record in records if (
                record.kind == "video"
                or (record.kind == "creator" and request.collect_creators)
                or (record.kind == "comment" and request.collect_demand_comments)
            )]
            with self._lock:
                job = self._jobs[request.job_id]
                if cancelled.is_set():
                    self._finish(job, "cancelled")
                    return
                pages = []
                for offset in range(0, max(len(records), 1), self._page_size):
                    chunk = records[offset:offset + self._page_size]
                    index = len(pages)
                    cursor = None if index == 0 else pages[index - 1]["next_cursor"]
                    done = offset + self._page_size >= len(records)
                    next_cursor = None if done else secrets.token_urlsafe(32)
                    page = CrawlJobPage(job_id=request.job_id, cursor=cursor,
                                        next_cursor=next_cursor, done=done, records=chunk)
                    page_name = f"page-{index:08d}.json"
                    _atomic_json(self._directory(request.job_id) / page_name, page.model_dump(mode="json"))
                    pages.append({"cursor": cursor, "next_cursor": next_cursor, "file": page_name})
                job["pages"], job["record_count"] = pages, len(records)
                self._finish(job, "succeeded")
        except Exception:
            with self._lock:
                job = self._jobs.get(request.job_id)
                if job:
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
            job["acknowledged_at"] = instant.isoformat()
            job["updated_at"] = instant.isoformat()
            self._persist(job)
            return instant

    def sweep_retained(self) -> int:
        import shutil
        with self._lock:
            expired = [job_id for job_id, job in self._jobs.items()
                       if (job.get("acknowledged_at")
                           and self._now() >= _instant(job["acknowledged_at"]) + self._retention)
                       or (not job.get("pages") and job.get("completed_at")
                           and self._now() >= _instant(job["completed_at"]) + self._retention)]
            for job_id in expired:
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


def _execute_upstream(spec_path: Path) -> None:
    value = json.loads(spec_path.read_text(encoding="utf-8"))
    import config
    from media_platform.douyin import DouYinCrawler
    config.PLATFORM = "dy"
    config.LOGIN_TYPE = "qrcode"
    config.CRAWLER_TYPE = "search"
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
    asyncio.run(DouYinCrawler().start())


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--execute", type=Path, required=True)
    _execute_upstream(parser.parse_args().execute)
