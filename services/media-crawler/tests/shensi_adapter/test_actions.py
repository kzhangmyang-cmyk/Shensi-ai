from __future__ import annotations

from datetime import UTC, datetime, timedelta
import hashlib
import json
import os
import stat
import threading

import pytest

import shensi_adapter.action_jobs as action_jobs_module
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
        if (self.selector.endswith('-submit"]')
                and self.page.after_control_lookup is not None):
            callback, self.page.after_control_lookup = (
                self.page.after_control_lookup, None
            )
            callback(self.page)
        if (self.selector == '[data-e2e="comment-submit"]'
                and self.page.comment_submit_requires_content):
            return bool(self.page.values.get('[data-e2e="comment-input"]'))
        return True

    def is_editable(self, **_kwargs):
        return self.selector.endswith('-input"]')

    def fill(self, value: str, **_kwargs):
        self.page.fills.append((self.selector, value))
        self.page.values[self.selector] = value

    def press(self, key: str, **_kwargs):
        self.page.native_keys.append((self.selector, key))
        if key == "Backspace":
            self.page.values[self.selector] = ""

    def press_sequentially(self, value: str, **_kwargs):
        self.page.native_types.append((self.selector, value))
        self.page.values[self.selector] = (
            self.page.values.get(self.selector, "") + value
        )

    def input_value(self, **_kwargs):
        if self.page.after_readback is not None:
            callback, self.page.after_readback = self.page.after_readback, None
            callback(self.page)
        return self.page.values.get(self.selector, "")

    def text_content(self, **_kwargs):
        return self.page.values.get(self.selector, "")

    def click(self, **_kwargs):
        self.page.clicks.append(self.selector)
        if self.selector.endswith('-input"]'):
            self.page.focused_selector = self.selector
        if self.selector.endswith('-submit"]'):
            self.page.after_submit = True
            if self.page.on_submit is not None:
                self.page.on_submit(self.page)

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


class FakeKeyboard:
    def __init__(self, page: "FakePage"):
        self.page = page

    def press(self, key: str, *, delay: int | None = None):
        self.page.browser_keys.append(key)
        if key == "Backspace" and self.page.focused_selector is not None:
            self.page.values[self.page.focused_selector] = ""


class FakePage:
    def __init__(self, *, visible=(), receipt=False, late_receipt=False,
                 clock=None, after_wait=None, after_control_lookup=None,
                 after_readback=None, after_baseline=None,
                 comment_submit_requires_content=False, on_submit=None):
        self.visible = set(visible)
        self.receipt = receipt
        self.late_receipt = late_receipt
        self.clock = clock
        self.after_wait = after_wait
        self.after_control_lookup = after_control_lookup
        self.after_readback = after_readback
        self.after_baseline = after_baseline
        self.comment_submit_requires_content = comment_submit_requires_content
        self.after_submit = False
        self.on_submit = on_submit
        self.url = "about:blank"
        self.urls: list[str] = []
        self.fills: list[tuple[str, str]] = []
        self.values: dict[str, str] = {}
        self.clicks: list[str] = []
        self.native_keys: list[tuple[str, str]] = []
        self.native_types: list[tuple[str, str]] = []
        self.browser_keys: list[str] = []
        self.focused_selector: str | None = None
        self.waits = 0
        self.brought_to_front = 0
        self.verification_bypass_calls: list[str] = []
        self.mouse = FakeMouse(self.verification_bypass_calls)
        self.keyboard = FakeKeyboard(self)

    @property
    def receipt_visible(self):
        if self.receipt and self.after_submit:
            return True
        return self.late_receipt and self.after_submit and self.waits >= 1

    def goto(self, url: str, **_kwargs):
        self.urls.append(url)
        self.url = url

    def locator(self, selector: str):
        if ("comment-item" in selector
                and self.after_baseline is not None and self.native_types):
            callback, self.after_baseline = self.after_baseline, None
            callback(self)
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


def test_comment_fixture_executes_exact_text_once_and_returns_sanitized_receipt():
    kind = "comment"
    composer = '[data-e2e="comment-input"]'
    submit = '[data-e2e="comment-submit"]'
    visible = {composer, submit, '[data-e2e-receipt-id]'}
    page = FakePage(visible=visible, receipt=True)

    receipt = DouyinActionExecutor(now=lambda: NOW).execute(page, request(kind))

    assert page.urls == [str(request(kind).target_public_url)]
    assert page.fills == []
    assert page.browser_keys == ["ControlOrMeta+A", "Backspace"]
    assert page.native_types == [(composer, "冻结的批准文本")]
    assert page.clicks == [composer, submit]
    assert receipt.platform_receipt_reference == "safe-receipt-123"
    assert receipt.failure_code is None
    assert "冻结的批准文本" not in receipt.model_dump_json()
    assert "private-handle" not in receipt.model_dump_json()


def test_comment_types_before_requiring_a_submit_that_starts_disabled():
    composer = '[data-e2e="comment-input"]'
    submit = '[data-e2e="comment-submit"]'
    page = FakePage(
        visible={composer, submit, '[data-e2e-receipt-id]'},
        receipt=True,
        comment_submit_requires_content=True,
    )

    receipt = DouyinActionExecutor(
        now=lambda: NOW,
        control_wait_ms=0,
    ).execute(page, request())

    assert page.native_types == [(composer, "冻结的批准文本")]
    assert page.clicks == [composer, submit]
    assert receipt.state == "succeeded"


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
    assert page.fills == []
    assert page.native_types == [
        ('[data-e2e="comment-input"]', "冻结的批准文本"),
    ]
    assert page.clicks == [
        '[data-e2e="comment-input"]',
        '[data-e2e="comment-submit"]',
    ]
    assert receipt.action_id == "action-comment"
    assert receipt.state == "succeeded"


@pytest.mark.parametrize("verification", [
    '[data-e2e="verification"]', 'text="接收短信验证码"',
])
@pytest.mark.parametrize("delayed", [False, True])
def test_post_submit_verification_waits_for_human_then_only_reads_receipt(
    verification, delayed,
):
    clock = FakeClock()

    def human_finishes(value):
        if delayed and value.waits == 1:
            value.visible.add(verification)
        if clock.now() >= NOW + timedelta(seconds=15):
            value.visible.discard(verification)
            value.receipt = True

    page = FakePage(
        visible={'[data-e2e="comment-input"]', '[data-e2e="comment-submit"]',
                 '[data-e2e-receipt-id]'},
        clock=clock,
        on_submit=None if delayed else lambda value: value.visible.add(verification),
        after_wait=human_finishes,
    )

    receipt = DouyinActionExecutor(
        now=clock.now, receipt_attempts=3, receipt_poll_ms=250,
    ).execute(page, request())

    assert clock.now() >= NOW + timedelta(seconds=15)
    assert page.brought_to_front == 1
    assert page.verification_bypass_calls == []
    assert page.clicks == ['[data-e2e="comment-input"]', '[data-e2e="comment-submit"]']
    assert page.native_types == [('[data-e2e="comment-input"]', "冻结的批准文本")]
    assert receipt.state == "succeeded"
    assert receipt.platform_receipt_reference == "safe-receipt-123"


@pytest.mark.parametrize(("deadline_seconds", "wait_seconds"), [(5, 5), (60, 30)])
def test_post_submit_verification_timeout_is_uncertain_and_never_resubmitted(
    deadline_seconds, wait_seconds,
):
    clock = FakeClock()
    page = FakePage(
        visible={'[data-e2e="comment-input"]', '[data-e2e="comment-submit"]'},
        clock=clock,
        on_submit=lambda value: value.visible.add('text="接收短信验证码"'),
    )

    with pytest.raises(DouyinActionFailure, match="^douyin_action_receipt_ambiguous$"):
        DouyinActionExecutor(
            now=clock.now, manual_verification_seconds=30,
        ).execute(page, request(deadline_at=NOW + timedelta(seconds=deadline_seconds)))

    assert clock.now() == NOW + timedelta(seconds=wait_seconds)
    assert page.brought_to_front == 1
    assert page.verification_bypass_calls == []
    assert page.clicks == ['[data-e2e="comment-input"]', '[data-e2e="comment-submit"]']


def test_post_submit_verification_clear_without_receipt_is_not_success():
    clock = FakeClock()
    page = FakePage(
        visible={'[data-e2e="comment-input"]', '[data-e2e="comment-submit"]'},
        clock=clock,
        on_submit=lambda value: value.visible.add('text="接收短信验证码"'),
        after_wait=lambda value: value.visible.discard('text="接收短信验证码"'),
    )

    with pytest.raises(DouyinActionFailure, match="^douyin_action_timeout$"):
        DouyinActionExecutor(now=clock.now, receipt_attempts=2).execute(page, request())

    assert page.brought_to_front == 1
    assert page.clicks == ['[data-e2e="comment-input"]', '[data-e2e="comment-submit"]']


def test_post_submit_verification_revalidates_account_before_accepting_receipt():
    clock = FakeClock()
    page = FakePage(
        visible={'[data-e2e="comment-input"]', '[data-e2e="comment-submit"]',
                 '[data-e2e-receipt-id]'},
        receipt=True, clock=clock,
        on_submit=lambda value: value.visible.add('text="接收短信验证码"'),
        after_wait=lambda value: value.visible.discard('text="接收短信验证码"'),
    )

    def revalidate():
        if page.waits:
            raise DouyinActionFailure("douyin_account_identity_changed")

    with pytest.raises(DouyinActionFailure, match="^douyin_action_receipt_ambiguous$"):
        DouyinActionExecutor(
            now=clock.now, account_identity_revalidator=revalidate,
        ).execute(page, request())

    assert page.brought_to_front == 1
    assert page.clicks == ['[data-e2e="comment-input"]', '[data-e2e="comment-submit"]']


def test_manual_verification_revalidates_sender_before_any_input():
    clock = FakeClock()
    sender_is_bound = True

    def clear_verification_and_switch_sender(value):
        nonlocal sender_is_bound
        value.visible.discard('[data-e2e="verification"]')
        value.visible.update({
            '[data-e2e="comment-input"]',
            '[data-e2e="comment-submit"]',
        })
        sender_is_bound = False

    def require_bound_sender():
        if not sender_is_bound:
            raise DouyinActionFailure("douyin_account_identity_changed")

    page = FakePage(
        visible={'[data-e2e="verification"]'},
        clock=clock,
        after_wait=clear_verification_and_switch_sender,
    )

    with pytest.raises(
        DouyinActionFailure,
        match="douyin_account_identity_changed",
    ):
        DouyinActionExecutor(
            now=clock.now,
            verification_poll_ms=1,
            account_identity_revalidator=require_bound_sender,
        ).execute(
            page,
            request(deadline_at=clock.now() + timedelta(seconds=5)),
        )

    assert page.native_types == []
    assert page.clicks == []


def test_sender_switch_after_readback_is_rejected_before_submit():
    sender_is_bound = True

    def switch_sender(_page):
        nonlocal sender_is_bound
        sender_is_bound = False

    def require_bound_sender():
        if not sender_is_bound:
            raise DouyinActionFailure("douyin_account_identity_changed")

    page = FakePage(
        visible={
            '[data-e2e="comment-input"]',
            '[data-e2e="comment-submit"]',
            '[data-e2e-receipt-id]',
        },
        receipt=True,
        after_readback=switch_sender,
    )

    with pytest.raises(
        DouyinActionFailure,
        match="douyin_account_identity_changed",
    ):
        DouyinActionExecutor(
            now=lambda: NOW,
            account_identity_revalidator=require_bound_sender,
        ).execute(page, request())

    assert page.native_types == [
        ('[data-e2e="comment-input"]', "冻结的批准文本")
    ]
    assert page.clicks == ['[data-e2e="comment-input"]']


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


def test_submit_lookup_reintroducing_verification_is_rechecked_before_submit():
    page = FakePage(
        visible={
            '[data-e2e="comment-input"]',
            '[data-e2e="comment-submit"]',
            '[data-e2e-receipt-id]',
        },
        receipt=True,
        after_control_lookup=lambda value: value.visible.add(
            '[data-e2e="verification"]'
        ),
    )

    with pytest.raises(DouyinActionFailure, match="douyin_verification_required"):
        DouyinActionExecutor(now=lambda: NOW, headless=True).execute(
            page, request()
        )

    assert page.fills == []
    assert page.native_types == [
        ('[data-e2e="comment-input"]', "冻结的批准文本"),
    ]
    assert page.clicks == ['[data-e2e="comment-input"]']
    assert page.verification_bypass_calls == []


def test_readback_redirect_is_rechecked_before_submit_without_retry():
    page = FakePage(
        visible={
            '[data-e2e="comment-input"]',
            '[data-e2e="comment-submit"]',
            '[data-e2e-receipt-id]',
        },
        receipt=True,
        after_readback=lambda value: setattr(
            value, "url", "https://www.douyin.com/video/different"
        ),
    )

    with pytest.raises(DouyinActionFailure, match="action_rejected"):
        DouyinActionExecutor(now=lambda: NOW).execute(page, request())

    assert page.native_types == [
        ('[data-e2e="comment-input"]', "冻结的批准文本")
    ]
    assert page.clicks == ['[data-e2e="comment-input"]']


def test_baseline_reintroducing_verification_is_rechecked_before_submit():
    page = FakePage(
        visible={
            '[data-e2e="comment-input"]',
            '[data-e2e="comment-submit"]',
            '[data-e2e-receipt-id]',
        },
        receipt=True,
        after_baseline=lambda value: value.visible.add(
            '[data-e2e="verification"]'
        ),
    )

    with pytest.raises(DouyinActionFailure, match="douyin_verification_required"):
        DouyinActionExecutor(now=lambda: NOW, headless=True).execute(
            page, request()
        )

    assert len(page.native_types) == 1
    assert page.clicks == ['[data-e2e="comment-input"]']
    assert page.verification_bypass_calls == []


def test_baseline_crossing_deadline_is_rechecked_before_submit():
    clock = FakeClock()
    page = FakePage(
        visible={
            '[data-e2e="comment-input"]',
            '[data-e2e="comment-submit"]',
            '[data-e2e-receipt-id]',
        },
        receipt=True,
        clock=clock,
        after_baseline=lambda _value: clock.advance(5_000),
    )

    with pytest.raises(DouyinActionFailure, match="deadline_exceeded"):
        DouyinActionExecutor(now=clock.now).execute(
            page,
            request(deadline_at=clock.now() + timedelta(seconds=5)),
        )

    assert len(page.native_types) == 1
    assert page.clicks == ['[data-e2e="comment-input"]']


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
    assert page.clicks == [
        '[data-e2e="comment-input"]',
        '[data-e2e="comment-submit"]',
    ]

    timed_out = FakePage(visible={'[data-e2e="comment-input"]', '[data-e2e="comment-submit"]'})
    with pytest.raises(DouyinActionFailure, match="douyin_action_timeout"):
        DouyinActionExecutor(now=lambda: NOW, receipt_attempts=1).execute(timed_out, request())
    assert timed_out.clicks == [
        '[data-e2e="comment-input"]',
        '[data-e2e="comment-submit"]',
    ]


@pytest.mark.parametrize("failure_code", [
    "douyin_direct_message_unavailable",
    "douyin_action_control_ambiguous",
    "douyin_action_content_mismatch",
    "douyin_action_receipt_ambiguous",
    "douyin_account_identity_changed",
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


def test_action_job_does_not_block_another_accounts_browser_action(tmp_path):
    profiles = {
        "account-a": tmp_path / "profiles" / "account-a",
        "account-b": tmp_path / "profiles" / "account-b",
    }
    for profile in profiles.values():
        profile.mkdir(parents=True)

    first_started = threading.Event()
    release_first = threading.Event()
    second_completed = threading.Event()
    receipts: dict[str, ActionReceipt] = {}
    failures: list[BaseException] = []

    def execute(profile, action):
        assert profile == profiles[action.account_handle]
        if action.account_handle == "account-a":
            first_started.set()
            if not release_first.wait(5):
                raise RuntimeError("first_action_release_timed_out")
        return {
            "action_id": action.action_id,
            "state": "succeeded",
            "platform_receipt_reference": f"douyin-comment:{action.action_id}",
            "occurred_at": NOW.isoformat(),
            "failure_code": None,
        }

    manager = ActionJobManager(
        tmp_path,
        account_resolver=lambda handle, _version: profiles[handle],
        executor=execute,
        now=lambda: NOW,
    )
    first = request().model_copy(update={
        "action_id": "action-account-a",
        "account_handle": "account-a",
    })
    second = request().model_copy(update={
        "action_id": "action-account-b",
        "account_handle": "account-b",
    })

    def run(label, value, completed=None):
        try:
            receipts[label] = manager.execute(value)
        except BaseException as error:
            failures.append(error)
        finally:
            if completed is not None:
                completed.set()

    first_thread = threading.Thread(
        target=run,
        args=("first", first),
        daemon=True,
    )
    second_thread = threading.Thread(
        target=run,
        args=("second", second, second_completed),
        daemon=True,
    )
    first_thread.start()
    assert first_started.wait(1)
    second_thread.start()
    try:
        assert second_completed.wait(1), (
            "an unrelated account was blocked by the first browser action"
        )
        assert receipts["second"].state == "succeeded"
        assert first_thread.is_alive()
    finally:
        release_first.set()
        first_thread.join(2)
        second_thread.join(2)

    assert not first_thread.is_alive()
    assert not second_thread.is_alive()
    assert failures == []
    assert receipts["first"].state == "succeeded"


def test_action_job_serializes_the_same_action_id_across_accounts(tmp_path):
    profiles = {
        "account-a": tmp_path / "profiles" / "account-a",
        "account-b": tmp_path / "profiles" / "account-b",
    }
    for profile in profiles.values():
        profile.mkdir(parents=True)

    first_resolved = threading.Event()
    release_first = threading.Event()
    second_executor_started = threading.Event()
    receipts: dict[str, ActionReceipt] = {}
    failures: dict[str, BaseException] = {}
    executor_calls: list[str] = []

    def resolve(handle, _version):
        if handle == "account-a":
            first_resolved.set()
            if not release_first.wait(5):
                raise RuntimeError("first_resolution_release_timed_out")
        return profiles[handle]

    def execute(_profile, action):
        executor_calls.append(action.account_handle)
        if action.account_handle == "account-b":
            second_executor_started.set()
        return {
            "action_id": action.action_id,
            "state": "succeeded",
            "platform_receipt_reference": f"douyin-comment:{action.action_id}",
            "occurred_at": NOW.isoformat(),
            "failure_code": None,
        }

    manager = ActionJobManager(
        tmp_path,
        account_resolver=resolve,
        executor=execute,
        now=lambda: NOW,
    )
    first = request().model_copy(update={
        "action_id": "shared-action-id",
        "account_handle": "account-a",
    })
    conflicting = request().model_copy(update={
        "action_id": "shared-action-id",
        "account_handle": "account-b",
    })

    def run(label, value):
        try:
            receipts[label] = manager.execute(value)
        except BaseException as error:
            failures[label] = error

    first_thread = threading.Thread(
        target=run,
        args=("first", first),
        daemon=True,
    )
    conflicting_thread = threading.Thread(
        target=run,
        args=("conflicting", conflicting),
        daemon=True,
    )
    first_thread.start()
    assert first_resolved.wait(1)
    conflicting_thread.start()
    try:
        assert not second_executor_started.wait(1), (
            "the same action ID bypassed its journal serialization boundary"
        )
    finally:
        release_first.set()
        first_thread.join(2)
        conflicting_thread.join(2)

    assert not first_thread.is_alive()
    assert not conflicting_thread.is_alive()
    assert receipts["first"].state == "succeeded"
    assert isinstance(failures.get("conflicting"), ActionReplayConflict)
    assert executor_calls == ["account-a"]


def test_action_job_serializes_different_actions_for_the_same_account(tmp_path):
    profile = tmp_path / "profiles" / "account-a"
    profile.mkdir(parents=True)
    first_executor_started = threading.Event()
    release_first = threading.Event()
    second_call_started = threading.Event()
    second_completed = threading.Event()
    receipts: dict[str, ActionReceipt] = {}
    failures: list[BaseException] = []
    executor_calls: list[str] = []

    def execute(_profile, action):
        executor_calls.append(action.action_id)
        if action.action_id == "same-account-first":
            first_executor_started.set()
            if not release_first.wait(5):
                raise RuntimeError("first_action_release_timed_out")
        return {
            "action_id": action.action_id,
            "state": "succeeded",
            "platform_receipt_reference": f"douyin-comment:{action.action_id}",
            "occurred_at": NOW.isoformat(),
            "failure_code": None,
        }

    manager = ActionJobManager(
        tmp_path,
        account_resolver=lambda _handle, _version: profile,
        executor=execute,
        now=lambda: NOW,
    )
    first = request().model_copy(update={"action_id": "same-account-first"})
    second = request().model_copy(update={"action_id": "same-account-second"})

    def run(label, value, started=None, completed=None):
        if started is not None:
            started.set()
        try:
            receipts[label] = manager.execute(value)
        except BaseException as error:
            failures.append(error)
        finally:
            if completed is not None:
                completed.set()

    first_thread = threading.Thread(
        target=run,
        args=("first", first),
        daemon=True,
    )
    second_thread = threading.Thread(
        target=run,
        args=("second", second, second_call_started, second_completed),
        daemon=True,
    )
    first_thread.start()
    assert first_executor_started.wait(1)
    second_thread.start()
    assert second_call_started.wait(1)
    try:
        assert not second_completed.wait(1), (
            "two actions for one account must remain serialized"
        )
    finally:
        release_first.set()
        first_thread.join(2)
        second_thread.join(2)

    assert not first_thread.is_alive()
    assert not second_thread.is_alive()
    assert failures == []
    assert receipts["first"].state == "succeeded"
    assert receipts["second"].state == "succeeded"
    assert executor_calls == ["same-account-first", "same-account-second"]


def test_action_job_executes_direct_message_under_profile_lease_and_started_journal(
    tmp_path,
):
    profile_calls = []
    executor_calls = []
    value = request(kind="direct_message")

    def execute(profile, action):
        executor_calls.append((profile, action.action_id))
        journal = next((tmp_path / "action-receipts").glob("*.json"))
        persisted = json.loads(journal.read_text(encoding="utf-8"))
        assert persisted["state"] == "started"
        return {
            "action_id": action.action_id,
            "state": "succeeded",
            "platform_receipt_reference": "douyin-message:message-123",
            "occurred_at": NOW.isoformat(),
            "failure_code": None,
        }

    manager = ActionJobManager(
        tmp_path,
        account_resolver=lambda handle, version: profile_calls.append(
            (handle, version)
        ) or tmp_path,
        executor=execute,
        now=lambda: NOW,
    )

    first = manager.execute(value)
    second = manager.execute(value)

    assert first == second
    assert first.state == "succeeded"
    assert first.platform_receipt_reference == "douyin-message:message-123"
    assert profile_calls == [(value.account_handle, value.login_state_version)]
    assert executor_calls == [(tmp_path, value.action_id)]
    lease_files = list((tmp_path / "profile-leases").glob("*.lock"))
    assert len(lease_files) == 1
    persisted = journal = next((tmp_path / "action-receipts").glob("*.json"))
    assert value.content not in persisted.read_text(encoding="utf-8")
    assert value.account_handle not in persisted.read_text(encoding="utf-8")


def test_action_job_replays_a_completed_receipt_when_only_deadline_changes(tmp_path):
    calls = []

    def executor(_profile, value):
        calls.append(value.action_id)
        return {
            "action_id": value.action_id,
            "state": "succeeded",
            "platform_receipt_reference": "safe-receipt-deadline",
            "occurred_at": NOW.isoformat(),
            "failure_code": None,
        }

    manager = ActionJobManager(
        tmp_path,
        account_resolver=lambda _handle, _version: tmp_path,
        executor=executor,
        now=lambda: NOW,
    )
    value = request()

    first = manager.execute(value)
    second = manager.execute(value.model_copy(update={
        "deadline_at": value.deadline_at + timedelta(seconds=15),
    }))

    assert second == first
    assert calls == [value.action_id]


def test_action_job_persists_started_before_external_work_and_never_reexecutes_uncertain_job(
    tmp_path,
):
    calls = []

    def crashes_after_possible_click(_profile, value):
        calls.append(value.action_id)
        persisted = "".join(
            path.read_text(encoding="utf-8")
            for path in tmp_path.rglob("*.json")
        )
        assert '"state":"started"' in persisted
        raise RuntimeError("simulated_process_loss_after_click")

    value = request()
    manager = ActionJobManager(
        tmp_path,
        account_resolver=lambda _handle, _version: tmp_path,
        executor=crashes_after_possible_click,
        now=lambda: NOW,
    )
    with pytest.raises(RuntimeError, match="simulated_process_loss_after_click"):
        manager.execute(value)

    recovered = ActionJobManager(
        tmp_path,
        account_resolver=lambda _handle, _version: tmp_path,
        executor=crashes_after_possible_click,
        now=lambda: NOW + timedelta(seconds=5),
    ).execute(value.model_copy(update={
        "deadline_at": value.deadline_at + timedelta(seconds=10),
    }))

    assert calls == [value.action_id]
    assert recovered.state == "failed"
    assert recovered.failure_code == "douyin_action_receipt_ambiguous"


def test_action_job_fsyncs_started_file_and_parent_before_external_work(
    tmp_path,
    monkeypatch,
):
    events = []
    real_fsync = os.fsync
    real_replace = os.replace

    def recording_fsync(descriptor):
        kind = (
            "directory_fsync"
            if stat.S_ISDIR(os.fstat(descriptor).st_mode)
            else "file_fsync"
        )
        events.append(kind)
        real_fsync(descriptor)

    def recording_replace(source, destination):
        events.append("replace")
        real_replace(source, destination)

    monkeypatch.setattr(action_jobs_module.os, "fsync", recording_fsync)
    monkeypatch.setattr(action_jobs_module.os, "replace", recording_replace)
    value = request()
    manager = ActionJobManager(
        tmp_path,
        account_resolver=lambda _handle, _version: tmp_path,
        executor=lambda _profile, action: events.append("executor") or {
            "action_id": action.action_id,
            "state": "succeeded",
            "platform_receipt_reference": "douyin-comment:durable-order",
            "occurred_at": NOW.isoformat(),
            "failure_code": None,
        },
        now=lambda: NOW,
    )

    manager.execute(value)

    assert events[:4] == [
        "file_fsync",
        "replace",
        "directory_fsync",
        "executor",
    ]


@pytest.mark.parametrize("failure_kind", ["file", "directory"])
def test_action_job_does_not_execute_when_started_journal_sync_fails(
    tmp_path,
    monkeypatch,
    failure_kind,
):
    events = []
    executions = []
    real_fsync = os.fsync
    real_replace = os.replace

    def failing_fsync(descriptor):
        kind = (
            "directory"
            if stat.S_ISDIR(os.fstat(descriptor).st_mode)
            else "file"
        )
        events.append(f"{kind}_fsync")
        if kind == failure_kind:
            raise OSError(f"simulated_{kind}_fsync_failure")
        real_fsync(descriptor)

    def recording_replace(source, destination):
        events.append("replace")
        real_replace(source, destination)

    monkeypatch.setattr(action_jobs_module.os, "fsync", failing_fsync)
    monkeypatch.setattr(action_jobs_module.os, "replace", recording_replace)
    value = request()
    manager = ActionJobManager(
        tmp_path,
        account_resolver=lambda _handle, _version: tmp_path,
        executor=lambda _profile, action: executions.append(action.action_id),
        now=lambda: NOW,
    )

    with pytest.raises(OSError, match=f"simulated_{failure_kind}_fsync_failure"):
        manager.execute(value)

    assert executions == []
    if failure_kind == "file":
        assert events == ["file_fsync"]
        assert not list((tmp_path / "action-receipts").glob("*.json"))
    else:
        assert events == ["file_fsync", "replace", "directory_fsync"]
        journal = next((tmp_path / "action-receipts").glob("*.json"))
        assert json.loads(journal.read_text(encoding="utf-8"))["state"] == "started"


def test_uncertain_action_can_only_recover_through_read_only_reconciliation(
    tmp_path,
):
    executions = []
    reconciliations = []
    value = request()

    def crash_after_possible_click(_profile, action):
        executions.append(action.action_id)
        raise RuntimeError("simulated_process_loss_after_click")

    manager = ActionJobManager(
        tmp_path,
        account_resolver=lambda _handle, _version: tmp_path,
        executor=crash_after_possible_click,
        reconciler=lambda _profile, action: reconciliations.append(
            action.action_id
        ) or {
            "action_id": action.action_id,
            "state": "succeeded",
            "platform_receipt_reference": "douyin-comment:reconciled-123",
            "occurred_at": NOW.isoformat(),
            "failure_code": None,
        },
        now=lambda: NOW,
    )
    with pytest.raises(RuntimeError, match="simulated_process_loss_after_click"):
        manager.execute(value)

    receipt = manager.reconcile(value.model_copy(update={
        "deadline_at": value.deadline_at + timedelta(seconds=30),
    }))

    assert executions == [value.action_id]
    assert reconciliations == [value.action_id]
    assert receipt.state == "succeeded"
    assert receipt.platform_receipt_reference == "douyin-comment:reconciled-123"
    assert manager.execute(value).platform_receipt_reference == (
        "douyin-comment:reconciled-123"
    )
    assert executions == [value.action_id]


def test_completed_timeout_reconciliation_keeps_original_started_at(tmp_path):
    reconciliation_not_before = []
    value = request()
    manager = ActionJobManager(
        tmp_path,
        account_resolver=lambda _handle, _version: tmp_path,
        executor=lambda _profile, action: {
            "action_id": action.action_id,
            "state": "failed",
            "platform_receipt_reference": None,
            "occurred_at": (NOW + timedelta(seconds=9)).isoformat(),
            "failure_code": "douyin_action_timeout",
        },
        reconciler=lambda _profile, action: reconciliation_not_before.append(
            action.not_before
        ) or {
            "action_id": action.action_id,
            "state": "succeeded",
            "platform_receipt_reference": "douyin-comment:after-timeout",
            "occurred_at": (NOW + timedelta(seconds=12)).isoformat(),
            "failure_code": None,
        },
        now=lambda: NOW,
    )

    assert manager.execute(value).failure_code == "douyin_action_timeout"
    receipt = manager.reconcile(value.model_copy(update={
        "deadline_at": value.deadline_at + timedelta(seconds=30),
    }))

    assert receipt.state == "succeeded"
    assert reconciliation_not_before == [NOW]


def test_completed_uncertain_journal_without_started_at_fails_closed(tmp_path):
    value = request()
    manager = ActionJobManager(
        tmp_path,
        account_resolver=lambda _handle, _version: tmp_path,
        executor=lambda _profile, action: {
            "action_id": action.action_id,
            "state": "failed",
            "platform_receipt_reference": None,
            "occurred_at": NOW.isoformat(),
            "failure_code": "douyin_action_timeout",
        },
        reconciler=lambda _profile, _action: pytest.fail(
            "malformed journal must not reach the read-only adapter"
        ),
        now=lambda: NOW,
    )
    manager.execute(value)
    journal = next((tmp_path / "action-receipts").glob("*.json"))
    persisted = json.loads(journal.read_text(encoding="utf-8"))
    persisted.pop("started_at", None)
    journal.write_text(json.dumps(persisted), encoding="utf-8")

    receipt = manager.reconcile(value)

    assert receipt.state == "failed"
    assert receipt.failure_code == "action_unavailable"


@pytest.mark.parametrize("started_at", ["not-a-time", "2026-08-25T10:00:00"])
def test_completed_uncertain_journal_with_malformed_started_at_fails_closed(
    tmp_path,
    started_at,
):
    value = request()
    manager = ActionJobManager(
        tmp_path,
        account_resolver=lambda _handle, _version: tmp_path,
        executor=lambda _profile, action: {
            "action_id": action.action_id,
            "state": "failed",
            "platform_receipt_reference": None,
            "occurred_at": NOW.isoformat(),
            "failure_code": "douyin_action_timeout",
        },
        reconciler=lambda _profile, _action: pytest.fail(
            "malformed journal must not reach the read-only adapter"
        ),
        now=lambda: NOW,
    )
    manager.execute(value)
    journal = next((tmp_path / "action-receipts").glob("*.json"))
    persisted = json.loads(journal.read_text(encoding="utf-8"))
    persisted["started_at"] = started_at
    journal.write_text(json.dumps(persisted), encoding="utf-8")

    receipt = manager.reconcile(value)

    assert receipt.state == "failed"
    assert receipt.failure_code == "action_unavailable"
