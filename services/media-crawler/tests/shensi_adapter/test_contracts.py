from datetime import datetime, timezone

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from shensi_adapter.app import create_app
from shensi_adapter.schemas import (
    ActionReceipt,
    ActionRequest,
    CrawlJobRequest,
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
            deadline_at=NOW,
        ),
        NormalizedDouyinRecord(
            record_id="record_1",
            kind="video",
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
