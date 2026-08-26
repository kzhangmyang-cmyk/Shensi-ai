from __future__ import annotations

from datetime import UTC, datetime, timedelta
import hashlib
import json

import pytest

from shensi_adapter.douyin_actions import DouyinActionExecutor, DouyinActionFailure
from shensi_adapter.action_jobs import ActionJobManager, ActionReplayConflict
from shensi_adapter.schemas import ActionReceipt, ActionRequest


NOW = datetime(2026, 8, 25, tzinfo=UTC)


class FakeLocator:
    def __init__(self, page: "FakePage", selector: str):
        self.page, self.selector = page, selector

    def count(self):
        return int(self.selector in self.page.visible)

    def and_(self, other: "FakeLocator"):
        return other

    def is_visible(self, **_kwargs):
        return self.selector in self.page.visible

    def is_enabled(self, **_kwargs):
        return True

    def is_editable(self, **_kwargs):
        return self.selector.endswith('-input"]')

    def fill(self, value: str, **_kwargs):
        self.page.fills.append((self.selector, value))
        self.page.values[self.selector] = value

    def input_value(self, **_kwargs):
        return self.page.values.get(self.selector, "")

    def text_content(self, **_kwargs):
        return self.page.values.get(self.selector, "")

    def click(self, **_kwargs):
        self.page.clicks.append(self.selector)
        self.page.after_submit = True

    def get_attribute(self, name: str, **_kwargs):
        if name == "data-e2e-receipt-id" and self.page.receipt_visible:
            return "safe-receipt-123"
        return None


class FakeMouse:
    def __init__(self, calls: list[str]):
        self.calls = calls

    def move(self, *_args, **_kwargs):
        self.calls.append("mouse.move")

    def down(self, *_args, **_kwargs):
        self.calls.append("mouse.down")

    def up(self, *_args, **_kwargs):
        self.calls.append("mouse.up")

    def click(self, *_args, **_kwargs):
        self.calls.append("mouse.click")


class FakePage:
    def __init__(self, *, visible=(), receipt=False, late_receipt=False,
                 clock=None, after_wait=None):
        self.visible = set(visible)
        self.receipt = receipt
        self.late_receipt = late_receipt
        self.clock = clock
        self.after_wait = after_wait
        self.after_submit = False
        self.url = "about:blank"
        self.urls: list[str] = []
        self.fills: list[tuple[str, str]] = []
        self.values: dict[str, str] = {}
        self.clicks: list[str] = []
        self.waits = 0
        self.brought_to_front = 0
        self.verification_bypass_calls: list[str] = []
        self.mouse = FakeMouse(self.verification_bypass_calls)

    @property
    def receipt_visible(self):
        if self.receipt and self.after_submit:
            return True
        return self.late_receipt and self.after_submit and self.waits >= 1

    def goto(self, url: str, **_kwargs):
        self.urls.append(url)
        self.url = url

    def locator(self, selector: str):
        return FakeLocator(self, selector)

    def get_by_role(self, _role: str, *, name: str, exact: bool):
        assert name == "发送" and exact is True
        return FakeLocator(self, "[fake-missing-exact-send-role]")

    def bring_to_front(self):
        self.brought_to_front += 1

    def wait_for_timeout(self, milliseconds: int):
        self.waits += 1
        if self.clock is not None:
            self.clock.advance(milliseconds)
        if self.after_wait is not None:
            self.after_wait(self)

    def screenshot(self, **_kwargs):
        self.verification_bypass_calls.append("screenshot")

    def evaluate(self, *_args, **_kwargs):
        self.verification_bypass_calls.append("evaluate")

    def drag_and_drop(self, *_args, **_kwargs):
        self.verification_bypass_calls.append("drag_and_drop")


class FakeClock:
    def __init__(self):
        self.current = NOW

    def now(self):
        return self.current

    def advance(self, milliseconds: int):
        self.current += timedelta(milliseconds=milliseconds)


def request(kind="comment", *, content="冻结的批准文本", deadline_at=None):
    target = ("https://www.douyin.com/video/123" if kind == "comment"
              else "https://www.douyin.com/user/public_actor")
    return ActionRequest(action_id=f"action-{kind}", account_handle="private-handle",
                         login_state_version=3, kind=kind,
                         target_public_url=target, content=content,
                         deadline_at=deadline_at or NOW + timedelta(minutes=1),
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
        DouyinActionExecutor(now=lambda: NOW, headless=True).execute(page, request())
    assert page.fills == []
    assert page.clicks == []


def test_visible_verification_handoff_rechecks_and_completes_the_same_action_once():
    clock = FakeClock()
    page = FakePage(
        visible={'[data-e2e="verification"]'},
        receipt=True,
        clock=clock,
        after_wait=lambda value: value.visible.update({
            '[data-e2e="comment-input"]',
            '[data-e2e="comment-submit"]',
            '[data-e2e-receipt-id]',
        }) or value.visible.discard('[data-e2e="verification"]'),
    )

    receipt = DouyinActionExecutor(
        now=clock.now, verification_poll_ms=1,
    ).execute(page, request(deadline_at=clock.now() + timedelta(seconds=5)))

    assert page.brought_to_front == 1
    assert page.verification_bypass_calls == []
    assert page.fills == [('[data-e2e="comment-input"]', "冻结的批准文本")]
    assert page.clicks == ['[data-e2e="comment-submit"]']
    assert receipt.action_id == "action-comment"
    assert receipt.state == "succeeded"


def test_visible_verification_at_deadline_fails_without_fill_click_or_bypass():
    clock = FakeClock()
    page = FakePage(
        visible={'[data-e2e="verification"]'},
        clock=clock,
    )

    with pytest.raises(DouyinActionFailure, match="douyin_verification_required"):
        DouyinActionExecutor(
            now=clock.now, verification_poll_ms=1,
        ).execute(page, request(
            deadline_at=clock.now() + timedelta(milliseconds=3),
        ))

    assert page.brought_to_front == 1
    assert page.waits == 3
    assert page.verification_bypass_calls == []
    assert page.fills == []
    assert page.clicks == []


def test_visible_verification_clear_then_redirect_rejects_before_fill_or_click():
    clock = FakeClock()

    def redirect_after_wait(page):
        page.visible.discard('[data-e2e="verification"]')
        page.visible.update({
            '[data-e2e="comment-input"]',
            '[data-e2e="comment-submit"]',
        })
        page.url = "https://www.douyin.com/video/different"

    page = FakePage(
        visible={'[data-e2e="verification"]'},
        clock=clock,
        after_wait=redirect_after_wait,
    )

    with pytest.raises(DouyinActionFailure, match="action_rejected"):
        DouyinActionExecutor(
            now=clock.now, verification_poll_ms=1,
        ).execute(page, request(deadline_at=clock.now() + timedelta(seconds=5)))

    assert page.brought_to_front == 1
    assert page.verification_bypass_calls == []
    assert page.fills == []
    assert page.clicks == []


def test_headless_verification_fails_immediately_without_handoff_or_bypass():
    clock = FakeClock()
    page = FakePage(
        visible={'[data-e2e="verification"]'},
        clock=clock,
    )

    with pytest.raises(DouyinActionFailure, match="douyin_verification_required"):
        DouyinActionExecutor(
            now=clock.now, verification_poll_ms=1, headless=True,
        ).execute(page, request(deadline_at=clock.now() + timedelta(seconds=5)))

    assert page.brought_to_front == 0
    assert page.waits == 0
    assert page.verification_bypass_calls == []
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


@pytest.mark.parametrize("failure_code", [
    "douyin_action_control_ambiguous",
    "douyin_action_content_mismatch",
    "douyin_action_receipt_ambiguous",
])
def test_action_receipt_accepts_each_closed_control_failure_code(failure_code):
    receipt = ActionReceipt(
        action_id="action-comment",
        state="failed",
        platform_receipt_reference=None,
        occurred_at=NOW,
        failure_code=failure_code,
    )

    assert receipt.failure_code == failure_code


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
