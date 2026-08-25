"""Deterministic process fixture over the real private MediaCrawler adapter.

This module never contacts Douyin.  It injects deterministic browser/crawler
drivers into the production FastAPI contract so browser E2E can exercise real
HTTP, authentication, persistence and worker boundaries without route stubs.
"""

from __future__ import annotations

import hashlib
import os
from datetime import UTC, datetime
from pathlib import Path

from .accounts import AccountManager
from .action_jobs import ActionJobManager
from .app import create_app, deployment_service_secret
from .crawl_jobs import CrawlJobManager


class DeterministicBrowser:
    def open_douyin_login(self, profile: Path):
        return {
            "profile": profile,
            "qr_image_data_url": (
                "data:image/svg+xml;base64,"
                "PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxIiBoZWlnaHQ9IjEiLz4="
            ),
        }

    def poll_douyin_login(self, _context):
        return {"active": True, "display_name": "Task 10 Deterministic Account"}

    def close(self, _context):
        return None

    def close_browser(self):
        return None

    def execute_douyin_action(self, _profile: Path, request):
        digest = hashlib.sha256(request.action_id.encode("utf-8")).hexdigest()[:24]
        return {
            "action_id": request.action_id,
            "state": "succeeded",
            "platform_receipt_reference": f"fixture:{digest}",
            "occurred_at": datetime.now(UTC),
            "failure_code": None,
        }


def deterministic_records(*_arguments):
    return [
        ("video", {
            "aweme_id": "73001",
            "aweme_url": "https://www.douyin.com/video/73001",
            "nickname": "泵阀制造商",
            "title": "Industrial pump replacement seal",
            "source_keyword": "industrial pump",
            "create_time": 1_724_550_400,
            "cookie": "discarded-by-normalizer",
        }),
        ("creator", {
            "sec_user_id": "MS4wLjABTask10Creator",
            "nickname": "泵阀制造商",
            "signature": "工业泵制造商公开账号",
            "source_keyword": "industrial pump",
        }),
        ("comment", {
            "comment_id": "task10-comment-1",
            "aweme_id": "73001",
            "nickname": "公开采购需求",
            "sec_uid": "MS4wLjABTask10Buyer",
            "content": "Need 200 replacement seals by Friday",
            "source_keyword": "industrial pump",
            "create_time": 1_724_550_500,
            "cookies": ["discarded-by-normalizer"],
        }),
    ]


def create_deterministic_fixture_app(service_secret: str, root: Path):
    browser = DeterministicBrowser()
    account_manager = AccountManager(root, browser)
    crawl_manager = CrawlJobManager(
        root,
        account_resolver=account_manager.resolve_crawl_profile,
        runner=deterministic_records,
    )
    action_manager = ActionJobManager(
        root,
        account_resolver=account_manager.resolve_action_profile,
        executor=account_manager.execute_action,
    )
    return create_app(
        service_secret,
        account_manager=account_manager,
        crawl_job_manager=crawl_manager,
        action_job_manager=action_manager,
    )


def create_app_from_environment():
    root = os.environ.get("MEDIACRAWLER_ENCRYPTED_VOLUME", "").strip()
    if not root:
        raise RuntimeError("MEDIACRAWLER_ENCRYPTED_VOLUME is required")
    return create_deterministic_fixture_app(deployment_service_secret(), Path(root))
