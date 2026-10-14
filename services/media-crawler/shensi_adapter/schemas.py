from datetime import UTC, datetime
import re
from urllib.parse import unquote
from typing import Annotated, Literal

from pydantic import AnyHttpUrl, BaseModel, ConfigDict, Field, field_serializer, field_validator, model_validator


class HealthView(BaseModel):
    model_config = ConfigDict(extra="forbid")

    ok: Literal[True]
    service: Literal["shensi-mediacrawler"]
    upstream_commit: Literal["d6f7c5bb906b6dac40ddf343ef9e26438a3de092"]


class LoginPageView(BaseModel):
    model_config = ConfigDict(extra="forbid")

    image_data_url: Annotated[
        str,
        Field(pattern=r"^data:image/jpeg;base64,[A-Za-z0-9+/]+={0,2}$"),
    ]
    width: Annotated[int, Field(gt=0)]
    height: Annotated[int, Field(gt=0)]


class LoginClickInteraction(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: Literal["click"]
    normalized_x: Annotated[float, Field(ge=0, le=1)]
    normalized_y: Annotated[float, Field(ge=0, le=1)]


class LoginTextInteraction(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: Literal["text"]
    text: Annotated[str, Field(min_length=1, max_length=200)]


class LoginKeyInteraction(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: Literal["key"]
    key: Literal[
        "Enter",
        "Tab",
        "Backspace",
        "Escape",
        "ArrowUp",
        "ArrowDown",
        "ArrowLeft",
        "ArrowRight",
    ]


class LoginScrollInteraction(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: Literal["scroll"]
    delta_x: Annotated[float, Field(ge=-1, le=1)]
    delta_y: Annotated[float, Field(ge=-1, le=1)]


class LoginRefreshQrInteraction(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: Literal["refresh_qr"]


LoginInteractionRequest = Annotated[
    LoginClickInteraction
    | LoginTextInteraction
    | LoginKeyInteraction
    | LoginScrollInteraction
    | LoginRefreshQrInteraction,
    Field(discriminator="type"),
]


class LoginSessionCreateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    account_key: Annotated[
        str,
        Field(pattern=r"^[0-9a-f]{64}$"),
    ] | None = None


class LoginDiagnosticView(BaseModel):
    model_config = ConfigDict(extra="forbid")

    code: Annotated[str, Field(min_length=1, max_length=100)]
    message: Annotated[str, Field(min_length=1, max_length=500)]
    recoverable: bool
    occurred_at: datetime


class LoginSessionView(BaseModel):
    model_config = ConfigDict(extra="forbid")

    session_id: str
    state: Literal["awaiting_scan", "active", "expired", "failed"]
    qr_status: Literal[
        "opening",
        "ready",
        "expired",
        "network_error",
        "verification_required",
    ] | None
    qr_image_data_url: str | None
    login_page: LoginPageView | None
    expires_at: datetime
    account_handle: str | None
    account_display_name: str | None
    login_state_version: int | None
    interaction_surface: Literal[
        "external_window", "remote_canvas"
    ] = "remote_canvas"
    runtime_state: Literal[
        "stopped", "starting", "running", "crashed"
    ] = "running"
    auth_state: Literal[
        "unknown", "logged_out", "waiting_for_user",
        "verification_required", "authenticated", "expired",
    ] = "logged_out"
    task_state: Literal[
        "idle", "preparing", "running", "cancelling", "completed",
        "failed",
    ] = "idle"
    diagnostic: LoginDiagnosticView | None = None
    screenshot_available: bool = False
    qr_available: bool = False
    failure_code: Literal[
        "douyin_login_ui_unsupported",
        "douyin_verification_required",
        "douyin_login_page_unavailable",
        "douyin_login_page_not_allowed",
        "douyin_browser_unavailable",
        "douyin_browser_command_timeout",
        "douyin_login_open_failed",
    ] | None = None


class LiveLoginSessionView(BaseModel):
    model_config = ConfigDict(extra="forbid")

    token: Annotated[str, Field(min_length=40, max_length=200)]
    expires_at: datetime


class CrawlJobRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    job_id: str
    account_handle: str
    login_state_version: int
    keywords: list[str]
    max_videos: int
    max_comments_per_video: int
    max_comments: Annotated[int, Field(ge=1, le=10000)] | None = None
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
    comment_count: int | None = None
    comment_target: int | None = None
    control_state: Literal["running", "pausing", "paused", "stopping"] = "running"
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
    """Retained Web wire and internal browser IPC; desktop uses its own envelope."""
    model_config = ConfigDict(extra="forbid")

    action_id: str
    account_handle: str
    login_state_version: int
    kind: Literal["comment", "direct_message"]
    target_public_url: AnyHttpUrl
    content: str
    deadline_at: datetime
    approved_content_hash: str


Sha256Hex = Annotated[str, Field(strict=True, pattern=r"^[0-9a-f]{64}$")]


class DesktopAccountIdentityRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    account_key: Sha256Hex


class DesktopAccountIdentity(DesktopAccountIdentityRequest):
    account_handle: str
    account_display_name: str
    login_state_version: Annotated[int, Field(strict=True, gt=0, le=9007199254740991)]
    profile_available: Literal[True] = True


class DesktopActionRequest(BaseModel):
    """Validate central canonical bytes without running a URL canonicalizer."""
    model_config = ConfigDict(extra="forbid")
    action_id: Annotated[str, Field(strict=True, min_length=1, max_length=160)]
    account_handle: Annotated[str, Field(strict=True, pattern=r"^dyacct_[0-9a-f]{64}$")]
    login_state_version: Annotated[int, Field(strict=True, gt=0, le=9007199254740991)]
    kind: Literal["comment", "direct_message"]
    canonical_target_public_url: Annotated[str, Field(strict=True)]
    content: Annotated[str, Field(strict=True, min_length=1)]
    deadline_at: datetime
    approved_content_hash: Annotated[str, Field(strict=True, pattern=r"^sha256:[0-9a-f]{64}$")]
    request_hash: Sha256Hex

    @model_validator(mode="after")
    def validate_canonical_target(self):
        target = self.canonical_target_public_url
        path = "video" if self.kind == "comment" else "user"
        if (re.fullmatch(r"https://www\.douyin\.com/" + path + r"/[A-Za-z0-9_-]{1,300}(?:\?[\x21-\x7e]*)?", target) is None
                or re.search(r"[\\\"#<>'\x7f]", target)
                or re.search(r"%(?![0-9A-F]{2})", target)
                or re.search(r"%(?:0[0-9A-F]|1[0-9A-F]|2F|5C|7F)", target)
                or re.search(r"%[0-9A-Fa-f]{2}", unquote(target, errors="strict"))):
            raise ValueError("noncanonical_douyin_target")
        if self.deadline_at.utcoffset() is None:
            raise ValueError("action_deadline_timezone_required")
        return self

    def executor_request(self) -> ActionRequest:
        payload = self.model_dump(exclude={"request_hash", "canonical_target_public_url", "observation_login_state_version"})
        return ActionRequest(**payload, target_public_url=self.canonical_target_public_url)


class DesktopActionReconciliationRequest(DesktopActionRequest):
    observation_login_state_version: Annotated[int, Field(strict=True, gt=0, le=9007199254740991)] | None = None

    @model_validator(mode="after")
    def validate_observation_login(self):
        if (self.observation_login_state_version is not None
                and self.observation_login_state_version <= self.login_state_version):
            raise ValueError("observation_login_must_be_newer")
        return self


class ActionAcknowledgementRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    request_hash: Sha256Hex
    receipt_hash: Sha256Hex


class ActionAcknowledgement(BaseModel):
    model_config = ConfigDict(extra="forbid")
    action_id: str
    acknowledged_at: datetime


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


class DesktopActionReceipt(ActionReceipt):
    state: Literal["succeeded", "failed"]

    @field_validator("occurred_at", mode="before")
    @classmethod
    def canonical_timestamp(cls, value):
        if isinstance(value, str) and re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z", value) is None:
            raise ValueError("noncanonical_receipt_timestamp")
        if not isinstance(value, (str, datetime)):
            raise ValueError("invalid_receipt_timestamp")
        if isinstance(value, datetime):
            if value.utcoffset() is None:
                raise ValueError("receipt_timezone_required")
            value = value.astimezone(UTC)
            return value.replace(microsecond=value.microsecond // 1000 * 1000)
        return value

    @field_serializer("occurred_at")
    def serialize_occurred_at(self, value: datetime) -> str:
        return value.astimezone(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")
