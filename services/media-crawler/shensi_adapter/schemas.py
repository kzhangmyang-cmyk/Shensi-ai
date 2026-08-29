from datetime import datetime
from typing import Literal

from pydantic import AnyHttpUrl, BaseModel, ConfigDict


class HealthView(BaseModel):
    model_config = ConfigDict(extra="forbid")

    ok: Literal[True]
    service: Literal["shensi-mediacrawler"]
    upstream_commit: Literal["d6f7c5bb906b6dac40ddf343ef9e26438a3de092"]


class LoginSessionView(BaseModel):
    model_config = ConfigDict(extra="forbid")

    session_id: str
    state: Literal["awaiting_scan", "active", "expired", "failed"]
    qr_image_data_url: str | None
    expires_at: datetime
    account_handle: str | None
    account_display_name: str | None
    login_state_version: int | None


class CrawlJobRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    job_id: str
    account_handle: str
    login_state_version: int
    keywords: list[str]
    max_videos: int
    max_comments_per_video: int
    max_pages_per_video: int
    collect_creators: bool
    collect_demand_comments: bool
    deadline_at: datetime


class CrawlActivity(BaseModel):
    """Sanitized, operator-safe snapshot of the private crawl's progress."""

    model_config = ConfigDict(extra="forbid")

    phase: Literal[
        "queued", "starting_browser", "opening_douyin", "searching",
        "collecting_comments", "finalizing", "completed",
    ]
    current_keyword: str | None
    browser_mode: Literal["visible", "headless"]
    sequence: int


class CrawlJobView(BaseModel):
    model_config = ConfigDict(extra="forbid")

    job_id: str
    state: Literal["queued", "running", "succeeded", "partial", "paused", "cancelled", "failed"]
    created_at: datetime
    updated_at: datetime
    completed_at: datetime | None
    acknowledged_at: datetime | None
    record_count: int
    page_count: int
    failure_code: str | None
    activity: CrawlActivity


class CrawlJobAcknowledgement(BaseModel):
    model_config = ConfigDict(extra="forbid")

    job_id: str
    acknowledged_at: datetime


class NormalizedDouyinRecord(BaseModel):
    model_config = ConfigDict(extra="forbid")

    record_id: str
    kind: Literal["video", "creator", "comment"]
    actor_kind: Literal["creator", "commenter"] | None
    canonical_url: AnyHttpUrl
    public_display_name: str
    public_profile_url: AnyHttpUrl | None
    text_excerpt: str
    source_keyword: str
    observed_at: datetime
    content_hash: str


class CrawlJobPage(BaseModel):
    model_config = ConfigDict(extra="forbid")

    job_id: str
    cursor: str | None
    next_cursor: str | None
    done: bool
    records: list[NormalizedDouyinRecord]


class ActionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    action_id: str
    account_handle: str
    login_state_version: int
    kind: Literal["comment", "direct_message"]
    target_public_url: AnyHttpUrl
    content: str
    deadline_at: datetime
    approved_content_hash: str


class ActionReconciliationRequest(ActionRequest):
    model_config = ConfigDict(extra="forbid")

    not_before: datetime


class ActionReceipt(BaseModel):
    model_config = ConfigDict(extra="forbid")

    action_id: str
    state: Literal["accepted", "succeeded", "failed"]
    platform_receipt_reference: str | None
    occurred_at: datetime
    failure_code: Literal[
        "action_unavailable", "action_rejected", "deadline_exceeded",
        "douyin_verification_required", "douyin_rate_limited",
        "douyin_account_warning", "douyin_account_identity_changed",
        "douyin_login_expired",
        "douyin_direct_message_unavailable",
        "douyin_action_control_missing", "douyin_action_control_ambiguous",
        "douyin_action_content_mismatch", "douyin_action_receipt_ambiguous",
        "douyin_action_timeout", "douyin_profile_busy",
    ] | None
