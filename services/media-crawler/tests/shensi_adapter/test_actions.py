from __future__ import annotations

from datetime import UTC, datetime, timedelta
import hashlib
import json

import pytest

from shensi_adapter.douyin_actions import DouyinActionExecutor, DouyinActionFailure
from shensi_adapter.action_jobs import ActionJobManager, ActionReplayConflict
from shensi_adapter.schemas import ActionRequest


NOW = datetime(2026, 8, 25, tzinfo=UTC)


class FakeLocator:
    def __init__(self, page: "FakePage", selector: str):
        self.page, self.selector = page, selector

    def count(self):
        return int(self.selector in self.page.visible)

    def is_visible(self, **_kwargs):
        return self.selector in self.page.visible

    def fill(self, value: str, **_kwargs):
        self.page.fills.append((self.selector, value))

    def click(self, **_kwargs):
        self.page.clicks.append(self.selector)
        self.page.after_submit = True

    def get_attribute(self, name: str, **_kwargs):
        if name == "data-e2e-receipt-id" and self.page.receipt_visible:
            return "safe-receipt-123"
        return None


class FakePage:
    def __init__(self, *, visible=(), receipt=False, late_receipt=False):
        self.visible = set(visible)
        self.receipt = receipt
        self.late_receipt = late_receipt
        self.after_submit = False
        self.urls: list[str] = []
        self.fills: list[tuple[str, str]] = []
        self.clicks: list[str] = []
        self.waits = 0

    @property
    def receipt_visible(self):
        if self.receipt and self.after_submit:
            return True
        return self.late_receipt and self.after_submit and self.waits >= 1

    def goto(self, url: str, **_kwargs):
        self.urls.append(url)

    def locator(self, selector: str):
        return FakeLocator(self, selector)

    def wait_for_timeout(self, _milliseconds: int):
        self.waits += 1


def request(kind="comment", *, content="冻结的批准文本"):
    target = ("https://www.douyin.com/video/123" if kind == "comment"
              else "https://www.douyin.com/user/public_actor")
    return ActionRequest(action_id=f"action-{kind}", account_handle="private-handle",
                         login_state_version=3, kind=kind,
                         target_public_url=target, content=content,
                         deadline_at=NOW + timedelta(minutes=1),
                         approved_content_hash="sha256:" + hashlib.sha256(
                             json.dumps({"content": content}, ensure_ascii=False,
                                        sort_keys=True, separators=(",", ":")).encode()
                         ).hexdigest())


@pytest.mark.parametrize(("kind", "composer", "submit"), [
    ("comment", '[data-e2e="comment-input"]', '[data-e2e="comment-submit"]'),
    ("direct_message", '[data-e2e="message-input"]', '[data-e2e="message-submit"]'),
])
def test_executes_exact_frozen_text_once_and_returns_sanitized_receipt(kind, composer, submit):
    page = FakePage(visible={composer, submit, '[data-e2e-receipt-id]'}, receipt=True)

    receipt = DouyinActionExecutor(now=lambda: NOW).execute(page, request(kind))

    assert page.urls == [str(request(kind).target_public_url)]
    assert page.fills == [(composer, "冻结的批准文本")]
    assert page.clicks == [submit]
    assert receipt.platform_receipt_reference == "safe-receipt-123"
    assert receipt.failure_code is None
    assert "冻结的批准文本" not in receipt.model_dump_json()
    assert "private-handle" not in receipt.model_dump_json()


@pytest.mark.parametrize(("visible", "code"), [
    ({'[data-e2e="verification"]'}, "douyin_verification_required"),
    ({'[data-e2e="rate-limit"]'}, "douyin_rate_limited"),
    ({'[data-e2e="account-warning"]'}, "douyin_account_warning"),
    ({'[data-e2e="login-required"]'}, "douyin_login_expired"),
])
def test_closed_page_states_never_try_an_alternate_control(visible, code):
    page = FakePage(visible=visible)
    with pytest.raises(DouyinActionFailure, match=code):
        DouyinActionExecutor(now=lambda: NOW).execute(page, request())
    assert page.fills == []
    assert page.clicks == []


def test_missing_native_control_fails_closed_without_submit():
    page = FakePage()
    with pytest.raises(DouyinActionFailure, match="douyin_action_control_missing"):
        DouyinActionExecutor(now=lambda: NOW).execute(page, request())
    assert page.clicks == []


def test_non_public_or_wrong_kind_target_is_rejected_before_navigation():
    value = request().model_copy(update={"target_public_url": "https://example.com/video/1"})
    page = FakePage()
    with pytest.raises(DouyinActionFailure, match="action_rejected"):
        DouyinActionExecutor(now=lambda: NOW).execute(page, value)
    assert page.urls == []


def test_timeout_checks_once_for_late_success_and_never_clicks_twice():
    page = FakePage(visible={'[data-e2e="comment-input"]', '[data-e2e="comment-submit"]',
                             '[data-e2e-receipt-id]'}, late_receipt=True)
    receipt = DouyinActionExecutor(now=lambda: NOW, receipt_attempts=2,
                                   receipt_poll_ms=1).execute(page, request())
    assert receipt.state == "succeeded"
    assert page.clicks == ['[data-e2e="comment-submit"]']

    timed_out = FakePage(visible={'[data-e2e="comment-input"]', '[data-e2e="comment-submit"]'})
    with pytest.raises(DouyinActionFailure, match="douyin_action_timeout"):
        DouyinActionExecutor(now=lambda: NOW, receipt_attempts=1).execute(timed_out, request())
    assert timed_out.clicks == ['[data-e2e="comment-submit"]']


def test_action_job_exact_replay_is_durable_and_never_persists_raw_content(tmp_path):
    calls = []
    executor = lambda _profile, value: calls.append(value.action_id) or {
        "action_id": value.action_id, "state": "succeeded",
        "platform_receipt_reference": "safe-receipt-123",
        "occurred_at": NOW.isoformat(), "failure_code": None,
    }
    manager = ActionJobManager(tmp_path, account_resolver=lambda _handle, _version: tmp_path,
                               executor=executor, now=lambda: NOW)
    value = request(content="不得落盘的冻结文本")

    first = manager.execute(value)
    second = ActionJobManager(tmp_path,
        account_resolver=lambda _handle, _version: tmp_path,
        executor=executor, now=lambda: NOW).execute(value)

    assert first == second
    assert calls == [value.action_id]
    persisted = "".join(path.read_text(encoding="utf-8") for path in tmp_path.rglob("*.json"))
    assert value.content not in persisted
    assert value.account_handle not in persisted

    changed = value.model_copy(update={"content": "changed"})
    with pytest.raises(ActionReplayConflict):
        manager.execute(changed)
