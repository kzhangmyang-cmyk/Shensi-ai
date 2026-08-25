import hashlib
import json
import time
from datetime import UTC, datetime, timedelta

from fastapi.testclient import TestClient

from shensi_adapter.e2e_fixture import create_deterministic_fixture_app


def test_deterministic_fixture_uses_the_actual_private_service_contract(tmp_path):
    secret = "fixture-sidecar-secret-that-is-at-least-32-bytes"
    with TestClient(create_deterministic_fixture_app(secret, tmp_path)) as client:
        headers = {"Authorization": f"Bearer {secret}"}
        assert client.get("/internal/v1/health", headers=headers).status_code == 200

        login = client.post("/internal/v1/douyin/login-sessions", headers=headers).json()
        assert login["state"] == "awaiting_scan"
        active = client.get(
            f"/internal/v1/douyin/login-sessions/{login['session_id']}", headers=headers
        ).json()
        assert active["state"] == "active"
        assert active["account_display_name"] == "Task 10 Deterministic Account"

        job = {
            "job_id": "fixture-job-1",
            "account_handle": active["account_handle"],
            "login_state_version": active["login_state_version"],
            "keywords": ["industrial pump"],
            "max_videos": 2,
            "max_comments_per_video": 2,
            "max_pages_per_video": 1,
            "collect_creators": True,
            "collect_demand_comments": True,
            "deadline_at": (datetime.now(UTC) + timedelta(minutes=2)).isoformat(),
        }
        assert client.post("/internal/v1/douyin/crawl-jobs", headers=headers, json=job).status_code == 200
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline:
            status = client.get("/internal/v1/douyin/crawl-jobs/fixture-job-1", headers=headers).json()
            if status["state"] == "succeeded":
                break
            time.sleep(0.01)
        assert status["state"] == "succeeded"
        records = client.get("/internal/v1/douyin/crawl-jobs/fixture-job-1/results", headers=headers).json()["records"]
        assert [record["kind"] for record in records] == ["video", "creator", "comment"]
        assert all("cookie" not in json.dumps(record).lower() for record in records)

        content = "公开测试留言"
        approved = "sha256:" + hashlib.sha256(
            json.dumps({"content": content}, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()
        ).hexdigest()
        action = client.post("/internal/v1/douyin/actions/fixture-action-1", headers=headers, json={
            "action_id": "fixture-action-1",
            "account_handle": active["account_handle"],
            "login_state_version": active["login_state_version"],
            "kind": "comment",
            "target_public_url": "https://www.douyin.com/video/73001",
            "content": content,
            "deadline_at": (datetime.now(UTC) + timedelta(minutes=2)).isoformat(),
            "approved_content_hash": approved,
        }).json()
        assert action["state"] == "succeeded"
        assert action["platform_receipt_reference"].startswith("fixture:")
