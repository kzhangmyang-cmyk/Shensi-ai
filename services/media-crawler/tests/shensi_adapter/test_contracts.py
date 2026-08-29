import hashlib
import json
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

import shensi_adapter.app as deployment_app
from shensi_adapter.app import create_app
from shensi_adapter.action_jobs import ActionJobManager
from shensi_adapter.browser_state import MediaCrawlerDouyinBrowserState
from shensi_adapter.douyin_account_identity import (
    account_handle_for_raw_sec_uid,
)
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


class _IpcActionElement:
    def __init__(self, page, kind):
        self.page = page
        self.kind = kind


class _IpcActionLocator:
    def __init__(self, page, elements=()):
        self.page = page
        self.elements = list(elements)

    def _one(self):
        if len(self.elements) != 1:
            raise RuntimeError("fixture_locator_not_unique")
        return self.elements[0]

    def count(self):
        return len(self.elements)

    def nth(self, index):
        return _IpcActionLocator(self.page, [self.elements[index]])

    def and_(self, other):
        return _IpcActionLocator(self.page, [
            item for item in self.elements if item in other.elements
        ])

    def is_visible(self, **_kwargs):
        element = self._one()
        return element.kind != "receipt" or self.page.after_submit

    def is_enabled(self, **_kwargs):
        return True

    def is_editable(self, **_kwargs):
        return self._one().kind == "composer"

    def fill(self, value, **_kwargs):
        self.page.value = value

    def press_sequentially(self, value, **_kwargs):
        self.page.value += value

    def input_value(self, **_kwargs):
        if self._one().kind != "composer":
            raise RuntimeError("fixture_input_value_unsupported")
        if self.page.failure_code == "douyin_action_content_mismatch":
            return "fixture-mismatch"
        return self.page.value

    def text_content(self, **_kwargs):
        kind = self._one().kind
        if kind == "submit":
            return "发送"
        if kind == "receipt":
            return self.page.approved_content
        return self.page.value

    def inner_text(self, **_kwargs):
        if self._one().kind == "identity":
            return "IPC 真实账号"
        return self.text_content(**_kwargs)

    def click(self, **_kwargs):
        if self._one().kind == "composer":
            self.page.focused = self._one()
        else:
            self.page.after_submit = True

    def get_attribute(self, name, **_kwargs):
        if self._one().kind == "identity" and name == "href":
            return f"/user/{self.page.raw_sec_uid}"
        if self._one().kind == "identity" and name in {"title", "aria-label"}:
            return "IPC 真实账号"
        if (self._one().kind == "receipt" and name == "data-comment-id"
                and self.page.failure_code == "douyin_action_receipt_ambiguous"):
            raise RuntimeError("fixture_attribute_failure_must_not_cross_ipc")
        if self._one().kind == "receipt" and name == "data-comment-id":
            return "ipc-comment-1"
        if self._one().kind == "receipt" and name == "data-owner":
            return "self"
        return None

    def get_by_text(self, text, *, exact):
        assert exact is True
        element = self._one()
        return _IpcActionLocator(
            self.page,
            [element] if element.kind == "receipt" and text == self.page.approved_content else [],
        )

    def locator(self, _selector):
        return _IpcActionLocator(self.page)

    def evaluate(self, expression, arg=None, **_kwargs):
        if "__shensiTagBoundActionComposer" in expression:
            element = self._one()
            if (element.kind != "composer" or not isinstance(arg, dict)
                    or arg.get("content") != self.page.value):
                return False
            self.page.bound_composer_nonce = arg.get("nonce")
            return isinstance(self.page.bound_composer_nonce, str)
        if "__shensiTagBoundActionControl" in expression:
            element = self._one()
            if element.kind != "submit" or not isinstance(arg, dict):
                return False
            self.page.bound_action_nonce = arg.get("nonce")
            return isinstance(self.page.bound_action_nonce, str)
        return "div"


class _IpcActionPage:
    raw_sec_uid = "MS4wLjABIpcBoundAccount"

    def __init__(self, failure_code):
        self.failure_code = failure_code
        self.url = "about:blank"
        self.after_submit = False
        self.bound_action_nonce = None
        self.bound_composer_nonce = None
        self.value = ""
        self.focused = None
        self.keyboard = _IpcActionKeyboard(self)
        self.approved_content = "ipc frozen approved content"
        self.composers = [_IpcActionElement(self, "composer")]
        if failure_code == "douyin_action_control_ambiguous":
            self.composers.append(_IpcActionElement(self, "composer"))
        self.submit = _IpcActionElement(self, "submit")
        self.receipt = _IpcActionElement(self, "receipt")
        self.identity = _IpcActionElement(self, "identity")

    def goto(self, url, **_kwargs):
        self.url = url

    def locator(self, selector):
        if selector == (
            'header a[href], nav a[href], [role="navigation"] a[href], '
            '[data-e2e="douyin-header"] a[href], #douyin-header a[href]'
        ):
            return _IpcActionLocator(self, [self.identity])
        if '[contenteditable="true"][aria-label*="评论"]' in selector:
            return _IpcActionLocator(self, self.composers)
        if 'button:has-text("发送")' in selector:
            return _IpcActionLocator(self, [self.submit])
        if ('data-shensi-bound-action=' in selector
                and self.bound_action_nonce in selector):
            return _IpcActionLocator(self, [self.submit])
        if "comment-item" in selector:
            return _IpcActionLocator(self, [self.receipt])
        return _IpcActionLocator(self)

    def get_by_role(self, role, *, name, exact):
        assert (role, name, exact) == ("button", "发送", True)
        return _IpcActionLocator(self, [self.submit])

    def wait_for_timeout(self, _milliseconds):
        return None


class _IpcActionKeyboard:
    def __init__(self, page):
        self.page = page

    def press(self, key, *, delay=None):
        if key == "Backspace" and self.page.focused is not None:
            self.page.value = ""


class _IpcActionContext:
    def __init__(self, failure_code):
        self.pages = [_IpcActionPage(failure_code)]

    def close(self):
        return None


class _IpcActionChromium:
    def launch_persistent_context(self, profile_path, **_kwargs):
        return _IpcActionContext(Path(profile_path).name)


class _IpcActionPlaywright:
    chromium = _IpcActionChromium()

    def stop(self):
        return None


def _ipc_action_playwright_factory():
    return _IpcActionPlaywright()


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


@pytest.mark.parametrize("failure_code", [
    "douyin_action_control_ambiguous",
    "douyin_action_content_mismatch",
    "douyin_action_receipt_ambiguous",
])
def test_closed_action_failure_survives_browser_ipc_to_fastapi(
    tmp_path, failure_code,
):
    profile = tmp_path / failure_code
    profile.mkdir()
    browser = MediaCrawlerDouyinBrowserState(
        playwright_factory=_ipc_action_playwright_factory,
        headless=False,
        startup_timeout=2,
        command_timeout=2,
    )
    content = "ipc frozen approved content"
    content_hash = "sha256:" + hashlib.sha256(json.dumps(
        {"content": content}, ensure_ascii=False, sort_keys=True,
        separators=(",", ":"),
    ).encode()).hexdigest()
    manager = ActionJobManager(
        tmp_path / "jobs",
        account_resolver=lambda _handle, _version: profile,
        executor=lambda resolved_profile, request: (
            browser.execute_douyin_action(
                resolved_profile,
                request,
                authority_validator=lambda: None,
            )
        ),
    )
    body = {
        "action_id": f"ipc-{failure_code}",
        "account_handle": account_handle_for_raw_sec_uid(
            _IpcActionPage.raw_sec_uid
        ),
        "login_state_version": 1,
        "kind": "comment",
        "target_public_url": "https://www.douyin.com/video/7350000000000000001",
        "content": content,
        "deadline_at": (datetime.now(timezone.utc) + timedelta(minutes=1)).isoformat(),
        "approved_content_hash": content_hash,
    }
    try:
        with TestClient(
            create_app(SERVICE_SECRET, action_job_manager=manager),
            raise_server_exceptions=False,
        ) as client:
            response = client.post(
                f"/internal/v1/douyin/actions/{body['action_id']}",
                headers={"Authorization": f"Bearer {SERVICE_SECRET}"},
                json=body,
            )

        assert response.status_code == 200
        assert response.json() == {
            "action_id": body["action_id"],
            "state": "failed",
            "platform_receipt_reference": None,
            "occurred_at": response.json()["occurred_at"],
            "failure_code": failure_code,
        }
        assert content not in response.text
        assert "fixture_attribute_failure_must_not_cross_ipc" not in response.text
        assert "cookie" not in response.text.lower()
        assert "html" not in response.text.lower()
    finally:
        browser.close_browser()


def test_fastapi_reconciliation_is_read_only_and_requires_uncertain_journal(
    tmp_path,
):
    content = "reconciliation frozen content"
    content_hash = "sha256:" + hashlib.sha256(json.dumps(
        {"content": content}, ensure_ascii=False, sort_keys=True,
        separators=(",", ":"),
    ).encode()).hexdigest()
    body = {
        "action_id": "reconcile-action-1",
        "account_handle": "private-handle",
        "login_state_version": 1,
        "kind": "comment",
        "target_public_url": "https://www.douyin.com/video/7350000000000000001",
        "content": content,
        "deadline_at": (datetime.now(timezone.utc) + timedelta(minutes=1)).isoformat(),
        "approved_content_hash": content_hash,
    }
    sends = []
    reads = []
    manager = ActionJobManager(
        tmp_path / "jobs",
        account_resolver=lambda _handle, _version: tmp_path,
        executor=lambda _profile, request: sends.append(request.action_id)
        or (_ for _ in ()).throw(RuntimeError("crash_after_click")),
        reconciler=lambda _profile, request: reads.append(request.action_id) or {
            "action_id": request.action_id,
            "state": "succeeded",
            "platform_receipt_reference": "douyin-comment:reconciled-fastapi",
            "occurred_at": NOW.isoformat(),
            "failure_code": None,
        },
    )
    with pytest.raises(RuntimeError, match="crash_after_click"):
        manager.execute(ActionRequest.model_validate(body))

    with TestClient(
        create_app(SERVICE_SECRET, action_job_manager=manager),
        raise_server_exceptions=False,
    ) as client:
        response = client.post(
            "/internal/v1/douyin/actions/reconcile-action-1/reconcile",
            headers={"Authorization": f"Bearer {SERVICE_SECRET}"},
            json=body,
        )

    assert response.status_code == 200
    assert response.json()["platform_receipt_reference"] == (
        "douyin-comment:reconciled-fastapi"
    )
    assert sends == ["reconcile-action-1"]
    assert reads == ["reconcile-action-1"]
    assert content not in response.text


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
