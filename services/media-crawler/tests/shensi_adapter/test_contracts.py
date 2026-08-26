import os
from datetime import datetime, timezone

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

import shensi_adapter.app as deployment_app
from shensi_adapter.app import create_app
from shensi_adapter.schemas import (
    ActionReceipt,
    ActionRequest,
    CrawlActivity,
    CrawlJobRequest,
    CrawlJobView,
    HealthView,
    LoginSessionView,
    NormalizedDouyinRecord,
)


SERVICE_SECRET = "mediacrawler-test-secret-that-is-at-least-32-bytes"
NOW = datetime(2026, 8, 24, tzinfo=timezone.utc)


def test_service_schemas_are_closed():
    models = [
        HealthView(
            ok=True,
            service="shensi-mediacrawler",
            upstream_commit="d6f7c5bb906b6dac40ddf343ef9e26438a3de092",
        ),
        LoginSessionView(
            session_id="session_1",
            state="active",
            qr_image_data_url=None,
            expires_at=NOW,
            account_handle="handle",
            account_display_name="Display",
            login_state_version=1,
        ),
        CrawlJobRequest(
            job_id="job_1",
            account_handle="handle",
            login_state_version=1,
            keywords=["keyword"],
            max_videos=1,
            max_comments_per_video=1,
            max_pages_per_video=1,
            collect_creators=True,
            collect_demand_comments=True,
            deadline_at=NOW,
        ),
        CrawlJobView(
            job_id="job_1",
            state="queued",
            created_at=NOW,
            updated_at=NOW,
            completed_at=None,
            acknowledged_at=None,
            record_count=0,
            page_count=0,
            failure_code=None,
            activity=CrawlActivity(
                phase="queued",
                current_keyword=None,
                browser_mode="visible",
                sequence=0,
            ),
        ),
        NormalizedDouyinRecord(
            record_id="record_1",
            kind="video",
            actor_kind=None,
            canonical_url="https://www.douyin.com/video/1",
            public_display_name="Display",
            public_profile_url=None,
            text_excerpt="excerpt",
            source_keyword="keyword",
            observed_at=NOW,
            content_hash="sha256:record",
        ),
        ActionRequest(
            action_id="action_1",
            account_handle="handle",
            login_state_version=1,
            kind="comment",
            target_public_url="https://www.douyin.com/video/1",
            content="approved content",
            deadline_at=NOW,
            approved_content_hash="sha256:content",
        ),
        ActionReceipt(
            action_id="action_1",
            state="succeeded",
            platform_receipt_reference="receipt_1",
            occurred_at=NOW,
            failure_code=None,
        ),
    ]

    for model in models:
        with pytest.raises(ValidationError):
            type(model).model_validate({**model.model_dump(mode="json"), "unexpected": True})


def test_health_requires_valid_bearer_authentication_without_echoing_header():
    client = TestClient(create_app(SERVICE_SECRET))

    missing = client.get("/internal/v1/health")
    invalid = client.get("/internal/v1/health", headers={"Authorization": "Bearer wrong"})
    authorized = client.get(
        "/internal/v1/health", headers={"Authorization": f"Bearer {SERVICE_SECRET}"}
    )

    assert missing.status_code == 401
    assert invalid.status_code == 401
    assert missing.json() == {"detail": "unauthorized"}
    assert invalid.json() == {"detail": "unauthorized"}
    assert SERVICE_SECRET not in invalid.text
    assert authorized.status_code == 200
    assert authorized.json() == {
        "ok": True,
        "service": "shensi-mediacrawler",
        "upstream_commit": "d6f7c5bb906b6dac40ddf343ef9e26438a3de092",
    }


def test_service_secret_requires_32_non_whitespace_bytes():
    with pytest.raises(ValueError, match="32 non-whitespace bytes"):
        create_app(" " * 32)

    with pytest.raises(ValueError, match="32 non-whitespace bytes"):
        create_app("a" + (" " * 64) + "b")


def test_deployment_crawl_output_root_is_a_distinct_owner_only_directory(
    tmp_path, monkeypatch,
):
    volume = tmp_path / "encrypted"
    volume.mkdir(mode=0o700)
    output_root = volume / "crawl-output"
    output_root.mkdir(mode=0o700)
    monkeypatch.setenv("MEDIACRAWLER_ENCRYPTED_VOLUME", str(volume))
    monkeypatch.setenv("MEDIACRAWLER_CRAWL_OUTPUT_ROOT", str(output_root))

    assert deployment_app.deployment_crawl_output_root() == output_root.resolve()

    monkeypatch.setenv("MEDIACRAWLER_CRAWL_OUTPUT_ROOT", str(volume))
    with pytest.raises(RuntimeError, match="strictly inside"):
        deployment_app.deployment_crawl_output_root()

    outside = tmp_path / "outside"
    outside.mkdir(mode=0o700)
    monkeypatch.setenv("MEDIACRAWLER_CRAWL_OUTPUT_ROOT", str(outside))
    with pytest.raises(RuntimeError, match="strictly inside"):
        deployment_app.deployment_crawl_output_root()

    linked = volume / "linked-output"
    linked.symlink_to(output_root, target_is_directory=True)
    monkeypatch.setenv("MEDIACRAWLER_CRAWL_OUTPUT_ROOT", str(linked))
    with pytest.raises(RuntimeError, match="non-symlinked"):
        deployment_app.deployment_crawl_output_root()

    os.chmod(output_root, 0o755)
    monkeypatch.setenv("MEDIACRAWLER_CRAWL_OUTPUT_ROOT", str(output_root))
    with pytest.raises(RuntimeError, match="0700"):
        deployment_app.deployment_crawl_output_root()


def test_deployment_rejects_missing_crawl_output_before_browser_start(
    tmp_path, monkeypatch,
):
    volume = tmp_path / "encrypted"
    volume.mkdir(mode=0o700)
    monkeypatch.setenv("MEDIACRAWLER_ENCRYPTED_VOLUME", str(volume))
    monkeypatch.setenv("MEDIACRAWLER_PROFILE_ROOT", str(volume / "profiles"))
    monkeypatch.delenv("MEDIACRAWLER_CRAWL_OUTPUT_ROOT", raising=False)
    secret_file = tmp_path / "service-secret"
    secret_file.write_text(SERVICE_SECRET, encoding="utf-8")
    os.chmod(secret_file, 0o600)
    monkeypatch.setenv("MEDIACRAWLER_SERVICE_SECRET_FILE", str(secret_file))
    browser_starts = 0

    class BrowserMustNotStart:
        def __init__(self, **_kwargs):
            nonlocal browser_starts
            browser_starts += 1
            raise AssertionError("browser_started_before_output_validation")

    monkeypatch.setattr(
        deployment_app, "MediaCrawlerDouyinBrowserState", BrowserMustNotStart,
    )

    with pytest.raises(RuntimeError, match="MEDIACRAWLER_CRAWL_OUTPUT_ROOT"):
        with TestClient(deployment_app.create_deployment_app()):
            pass
    assert browser_starts == 0


def test_deployment_outreach_actions_require_literal_true(monkeypatch):
    monkeypatch.delenv("DOUYIN_OUTREACH_ACTIONS_ENABLED", raising=False)
    assert deployment_app.deployment_outreach_actions_enabled() is False
    for value in ["", "false", "1", "yes", " true ", "true-ish"]:
        monkeypatch.setenv("DOUYIN_OUTREACH_ACTIONS_ENABLED", value)
        assert deployment_app.deployment_outreach_actions_enabled() is False
    for value in ["true", "TRUE", "TrUe"]:
        monkeypatch.setenv("DOUYIN_OUTREACH_ACTIONS_ENABLED", value)
        assert deployment_app.deployment_outreach_actions_enabled() is True


def test_deployment_app_rejects_actions_when_default_disabled(tmp_path, monkeypatch):
    secret_file = tmp_path / "service-secret"
    secret_file.write_text(SERVICE_SECRET, encoding="utf-8")
    os.chmod(secret_file, 0o600)
    monkeypatch.setenv("MEDIACRAWLER_SERVICE_SECRET_FILE", str(secret_file))
    monkeypatch.delenv("DOUYIN_OUTREACH_ACTIONS_ENABLED", raising=False)

    client = TestClient(deployment_app.create_deployment_app())
    response = client.post(
        "/internal/v1/douyin/actions/action-disabled",
        headers={"Authorization": f"Bearer {SERVICE_SECRET}"},
        json={
            "action_id": "action-disabled",
            "account_handle": "private-handle",
            "login_state_version": 1,
            "kind": "comment",
            "target_public_url": "https://www.douyin.com/video/1",
            "content": "frozen approved content",
            "deadline_at": NOW.isoformat(),
            "approved_content_hash": f"sha256:{'a' * 64}",
        },
    )

    assert response.status_code == 503
    assert response.json() == {"detail": "outreach_actions_disabled"}
