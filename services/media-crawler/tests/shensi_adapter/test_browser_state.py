from __future__ import annotations

from datetime import UTC, datetime, timedelta
import hashlib
import json
import os
from pathlib import Path
import threading
from types import SimpleNamespace

import pytest

import shensi_adapter.app as deployment_app
import shensi_adapter.browser_state as browser_state_module
from shensi_adapter.browser_state import (
    MediaCrawlerDouyinBrowserState,
    _browser_worker,
    _execute_action,
    _require_bound_action_identity,
    _require_bound_action_identity_in_place,
    _reconcile_action,
)
from shensi_adapter.douyin_account_identity import (
    account_handle_for_raw_sec_uid,
)
from shensi_adapter.douyin_actions import DouyinActionFailure
from shensi_adapter.schemas import ActionReceipt, ActionRequest


NOW = datetime(2026, 8, 27, tzinfo=UTC)


def action_request(*, deadline_at: datetime | None = None,
                   account_handle: str = "private-handle",
                   kind: str = "comment") -> ActionRequest:
    content = "bounded browser action"
    return ActionRequest(
        action_id="action-browser-timeout",
        account_handle=account_handle,
        login_state_version=3,
        kind=kind,
        target_public_url=(
            "https://www.douyin.com/video/123"
            if kind == "comment"
            else "https://www.douyin.com/user/MS4wLjABDirectMessageTarget"
        ),
        content=content,
        deadline_at=deadline_at or NOW + timedelta(minutes=1),
        approved_content_hash="sha256:" + hashlib.sha256(json.dumps(
            {"content": content}, ensure_ascii=False, sort_keys=True,
            separators=(",", ":"),
        ).encode()).hexdigest(),
    )


class RecordingConnection:
    def __init__(self):
        self.command = None
        self.poll_timeouts: list[float] = []

    def send(self, command):
        self.command = command

    def poll(self, timeout):
        self.poll_timeouts.append(timeout)
        return True

    def recv(self):
        assert self.command is not None
        value = (
            {"handle": "login-handle", "qr_image_data_url": "data:image/png;base64,cXI="}
            if self.command["operation"] == "open"
            else {
                "action_id": "action-browser-timeout",
                "state": "failed",
                "platform_receipt_reference": None,
                "occurred_at": NOW.isoformat(),
                "failure_code": "douyin_verification_required",
            }
        )
        return {"id": self.command["id"], "kind": "ok", "value": value}


class AuthorityChallengeConnection:
    def __init__(self):
        self.sent = []
        self.responses = iter([
            {"id": 1, "kind": "authority_check", "check_id": 1},
            {
                "id": 1,
                "kind": "ok",
                "value": {"state": "succeeded"},
            },
        ])

    def send(self, value):
        self.sent.append(value)

    def poll(self, _timeout):
        return True

    def recv(self):
        return next(self.responses)


class LoginOpenErrorConnection:
    def __init__(self):
        self.command = None

    def send(self, command):
        self.command = command

    def poll(self, _timeout):
        return True

    def recv(self):
        assert self.command is not None
        return {
            "id": self.command["id"],
            "kind": "login_open_error",
            "stage": "live_display_start",
            "error_code": "douyin_live_display_unavailable",
        }


def test_login_open_failure_closes_unknown_stage_and_code():
    sensitive_stage = "secret_stage_/private/profile"
    sensitive_code = "cookie=session-must-not-leak"

    failure = browser_state_module.DouyinLoginOpenFailure(
        sensitive_stage,
        sensitive_code,
    )

    assert failure.stage == "browser_context_open"
    assert failure.error_code == "douyin_login_open_failed"
    assert str(failure) == "douyin_login_open_failed"
    assert sensitive_stage not in str(failure)
    assert sensitive_code not in str(failure)


def test_open_ipc_preserves_only_closed_login_diagnostic_fields():
    browser = object.__new__(MediaCrawlerDouyinBrowserState)
    browser._connection = LoginOpenErrorConnection()
    browser._timeout = 5
    browser._lock = threading.Lock()
    browser._closed = False
    browser._next_command_id = 1
    browser._hard_stop = lambda: None

    with pytest.raises(RuntimeError) as failure:
        browser.open_douyin_login(Path("/fixture/profile"))

    assert str(failure.value) == "douyin_live_display_unavailable"
    assert failure.value.stage == "live_display_start"
    assert failure.value.error_code == "douyin_live_display_unavailable"


def test_action_ipc_answers_each_login_version_authority_checkpoint():
    browser = object.__new__(MediaCrawlerDouyinBrowserState)
    browser._headless = False
    browser._connection = AuthorityChallengeConnection()
    browser._timeout = 5
    browser._action_timeout = 80
    browser._lock = threading.Lock()
    browser._closed = False
    browser._next_command_id = 1
    calls = []

    result = browser.execute_douyin_action(
        Path("/fixture/profile"),
        action_request(),
        authority_validator=lambda: calls.append("checked"),
    )

    assert result == {"state": "succeeded"}
    assert calls == ["checked"]
    assert browser._connection.sent == [
        {
            "id": 1,
            "operation": "action",
            "profile_path": "/fixture/profile",
            "request": action_request().model_dump(mode="json"),
        },
        {"id": 1, "kind": "authority_ok", "check_id": 1},
    ]


def test_action_ipc_uses_its_own_manual_window_budget():
    browser = object.__new__(MediaCrawlerDouyinBrowserState)
    browser._headless = False
    browser._connection = RecordingConnection()
    browser._timeout = 5
    browser._action_timeout = 80
    browser._lock = threading.Lock()
    browser._closed = False
    browser._next_command_id = 1

    browser.open_douyin_login(Path("/fixture/profile"))
    browser.execute_douyin_action(Path("/fixture/profile"), action_request())

    assert browser._connection.poll_timeouts == pytest.approx([5, 80])


class VerificationLocator:
    def count(self):
        return 1

    def is_visible(self, **_kwargs):
        return True


class HeadlessVerificationPage:
    def __init__(self):
        self.raw_sec_uid = "MS4wLjABHeadlessVerification"
        self.url = "about:blank"
        self.brought_to_front = 0
        self.waits = 0
        self.bypass_calls: list[str] = []

    def goto(self, url, **_kwargs):
        self.url = url

    def locator(self, selector):
        if selector == (
            'header a[href], nav a[href], [role="navigation"] a[href], '
            '[data-e2e="douyin-header"] a[href], #douyin-header a[href]'
        ):
            return IdentityLocator([{
                "href": f"/user/{self.raw_sec_uid}",
                "title": "无头验证账号",
                "text": "无头验证账号",
            }])
        if selector == '[data-e2e="verification"]':
            return VerificationLocator()
        return EmptyLocator()

    def bring_to_front(self):
        self.brought_to_front += 1

    def wait_for_timeout(self, _milliseconds):
        self.waits += 1

    def screenshot(self, **_kwargs):
        self.bypass_calls.append("screenshot")

    def evaluate(self, *_args, **_kwargs):
        self.bypass_calls.append("evaluate")

    def drag_and_drop(self, *_args, **_kwargs):
        self.bypass_calls.append("drag_and_drop")


class EmptyLocator:
    def count(self):
        return 0


class HeadlessVerificationContext:
    def __init__(self):
        self.pages = [HeadlessVerificationPage()]

    def close(self):
        return None


class HeadlessVerificationChromium:
    def __init__(self):
        self.context = HeadlessVerificationContext()

    def launch_persistent_context(self, _profile_path, **_kwargs):
        return self.context


class HeadlessVerificationPlaywright:
    def __init__(self):
        self.chromium = HeadlessVerificationChromium()

    def stop(self):
        return None


def headless_verification_playwright_factory():
    return HeadlessVerificationPlaywright()


def test_browser_worker_headless_action_is_rejected_before_browser_launch():
    playwright = HeadlessVerificationPlaywright()

    with pytest.raises(DouyinActionFailure, match="^action_unavailable$"):
        _execute_action(
            playwright,
            "/fixture/profile",
            action_request(
                deadline_at=datetime.now(UTC) + timedelta(minutes=1),
                account_handle=account_handle_for_raw_sec_uid(
                    playwright.chromium.context.pages[0].raw_sec_uid
                ),
            ).model_dump(
                mode="json"
            ),
            headless=True,
            browser_channel=None,
            manual_verification_seconds=30,
        )

    page = playwright.chromium.context.pages[0]
    assert page.brought_to_front == 0
    assert page.waits == 0
    assert page.bypass_calls == []


def test_browser_worker_headless_reconciliation_is_rejected_before_browser_launch():
    class BrowserMustNotLaunch:
        class Chromium:
            def launch_persistent_context(self, *_args, **_kwargs):
                raise AssertionError("headless_reconciliation_launched_browser")

        chromium = Chromium()

    raw_request = action_request().model_dump(mode="json")
    raw_request["not_before"] = NOW.isoformat()

    with pytest.raises(DouyinActionFailure, match="^action_unavailable$"):
        _reconcile_action(
            BrowserMustNotLaunch(),
            "/fixture/profile",
            raw_request,
            headless=True,
            browser_channel=None,
        )


@pytest.mark.parametrize(
    "operation",
    ["execute_douyin_action", "reconcile_douyin_action"],
)
def test_headless_browser_state_rejects_real_action_entrypoints_before_ipc(
    operation,
):
    browser = object.__new__(MediaCrawlerDouyinBrowserState)
    browser._headless = True
    ipc_calls = []
    browser._call = lambda *args, **kwargs: ipc_calls.append((args, kwargs))

    with pytest.raises(DouyinActionFailure, match="^action_unavailable$"):
        getattr(browser, operation)(
            Path("/fixture/profile"),
            action_request(),
            authority_validator=lambda: None,
        )

    assert ipc_calls == []


class IdentityElement:
    def __init__(self, value):
        self.value = value

    def is_visible(self, **_kwargs):
        return True

    def get_attribute(self, name):
        return self.value.get(name)

    def inner_text(self, **_kwargs):
        return self.value.get("text", "")

    def locator(self, _selector):
        return IdentityLocator([])


class IdentityLocator:
    def __init__(self, values):
        self.values = values

    def count(self):
        return len(self.values)

    def nth(self, index):
        return IdentityElement(self.values[index])


class IdentityPage:
    def __init__(self, raw_sec_uid, events=None):
        self.raw_sec_uid = raw_sec_uid
        self.url = "about:blank"
        self.visited = []
        self.events = events if events is not None else []

    def goto(self, url, **_kwargs):
        self.url = url
        self.visited.append(url)

    def locator(self, selector):
        if selector == (
            'header a[href], nav a[href], [role="navigation"] a[href], '
            '[data-e2e="douyin-header"] a[href], #douyin-header a[href]'
        ):
            return IdentityLocator([{
                "href": f"/user/{self.raw_sec_uid}",
                "title": "当前登录账号",
                "text": "当前登录账号",
            }])
        raise AssertionError(selector)

    def bring_to_front(self):
        self.events.append("bring_to_front")

    def wait_for_timeout(self, milliseconds):
        self.events.append(("wait_for_timeout", milliseconds))


class DelayedIdentityPage(IdentityPage):
    def __init__(self, raw_sec_uid, *, missing_reads):
        super().__init__(raw_sec_uid)
        self.missing_reads = missing_reads
        self.identity_reads = 0
        self.waits = []

    def locator(self, selector):
        if selector == (
            'header a[href], nav a[href], [role="navigation"] a[href], '
            '[data-e2e="douyin-header"] a[href], #douyin-header a[href]'
        ):
            self.identity_reads += 1
            if self.identity_reads <= self.missing_reads:
                return IdentityLocator([])
        return super().locator(selector)

    def wait_for_timeout(self, milliseconds):
        self.waits.append(milliseconds)


class IdentityContext:
    def __init__(self, raw_sec_uid):
        self.events = []
        self.pages = [IdentityPage(raw_sec_uid, self.events)]
        self.closed = False

    def close(self):
        self.events.append("context_close")
        self.closed = True


class IdentityChromium:
    def __init__(self, raw_sec_uid):
        self.context = IdentityContext(raw_sec_uid)

    def launch_persistent_context(self, _profile_path, **_kwargs):
        return self.context


class IdentityPlaywright:
    def __init__(self, raw_sec_uid):
        self.chromium = IdentityChromium(raw_sec_uid)


def test_browser_action_rejects_changed_account_before_executor_write(
    monkeypatch,
):
    calls = []

    class MustNotExecute:
        def __init__(self, **_kwargs):
            pass

        def execute(self, *_args):
            calls.append("execute")
            raise AssertionError("external write must not be reached")

    monkeypatch.setattr(
        browser_state_module,
        "DouyinActionExecutor",
        MustNotExecute,
    )
    playwright = IdentityPlaywright("MS4wLjABActuallyLoggedIn")

    with pytest.raises(
        DouyinActionFailure,
        match="douyin_account_identity_changed",
    ):
        _execute_action(
            playwright,
            "/fixture/profile",
            action_request(account_handle=account_handle_for_raw_sec_uid(
                "MS4wLjABFrozenApprovalAccount"
            )).model_dump(mode="json"),
            headless=False,
            browser_channel=None,
            manual_verification_seconds=30,
        )

    assert calls == []
    assert playwright.chromium.context.pages[0].visited == [
        "https://www.douyin.com/"
    ]
    assert playwright.chromium.context.closed is True


def test_browser_reconciliation_rejects_changed_account_before_read(
    monkeypatch,
):
    calls = []

    class MustNotReconcile:
        def reconcile(self, *_args):
            calls.append("reconcile")
            raise AssertionError("receipt read must not be reached")

    monkeypatch.setattr(
        browser_state_module,
        "DouyinActionReconciler",
        MustNotReconcile,
    )
    playwright = IdentityPlaywright("MS4wLjABActuallyLoggedIn")

    raw = action_request(account_handle=account_handle_for_raw_sec_uid(
        "MS4wLjABFrozenApprovalAccount"
    )).model_dump(mode="json")
    raw["not_before"] = NOW.isoformat()
    with pytest.raises(
        DouyinActionFailure,
        match="douyin_account_identity_changed",
    ):
        _reconcile_action(
            playwright,
            "/fixture/profile",
            raw,
            headless=False,
            browser_channel=None,
        )

    assert calls == []
    assert playwright.chromium.context.pages[0].visited == [
        "https://www.douyin.com/"
    ]
    assert playwright.chromium.context.closed is True


def test_browser_action_passes_verified_bound_identity_to_executor(
    monkeypatch,
):
    calls = []
    executor_options = []
    raw_sec_uid = "MS4wLjABExpectedAccount"
    account_handle = account_handle_for_raw_sec_uid(raw_sec_uid)
    visual_locator = object()

    class RecordingExecutor:
        def __init__(self, **kwargs):
            executor_options.append(kwargs)

        def execute(self, _page, request):
            calls.append(request.account_handle)
            return ActionReceipt(
                action_id=request.action_id,
                state="succeeded",
                platform_receipt_reference="douyin-comment:receipt",
                occurred_at=NOW,
                failure_code=None,
            )

    class MustNotUsePrivateMessageExecutor:
        def __init__(self, **_kwargs):
            raise AssertionError("comment must keep the browser executor")

    monkeypatch.setattr(
        browser_state_module,
        "DouyinActionExecutor",
        RecordingExecutor,
    )
    monkeypatch.setattr(
        browser_state_module,
        "DouyinSpiderPrivateMessageExecutor",
        MustNotUsePrivateMessageExecutor,
        raising=False,
    )
    playwright = IdentityPlaywright(raw_sec_uid)

    receipt = _execute_action(
        playwright,
        "/fixture/profile",
        action_request(account_handle=account_handle).model_dump(mode="json"),
        headless=False,
        browser_channel=None,
        manual_verification_seconds=30,
        visual_locator=visual_locator,
    )

    assert receipt["state"] == "succeeded"
    assert calls == [account_handle]
    assert executor_options[0]["visual_locator"] is visual_locator
    revalidate = executor_options[0]["account_identity_revalidator"]
    assert callable(revalidate)
    revalidate()
    page = playwright.chromium.context.pages[0]
    assert page.visited == ["https://www.douyin.com/"]
    assert playwright.chromium.context.events == [
        "bring_to_front",
        ("wait_for_timeout", 10_000),
        "context_close",
    ]


def test_browser_direct_message_uses_spider_without_browser_controls_and_revalidates(
    monkeypatch,
):
    raw_sec_uid = "MS4wLjABExpectedAccount"
    account_handle = account_handle_for_raw_sec_uid(raw_sec_uid)
    authority_checks = []
    observed = []

    class MustNotUseBrowserMessageControls:
        def __init__(self, **_kwargs):
            raise AssertionError(
                "direct message must not instantiate browser action controls"
            )

    class RecordingPrivateMessageExecutor:
        def execute(
            self,
            context,
            page,
            request,
            *,
            account_authority_revalidator,
        ):
            observed.append((context, page, request.kind))
            account_authority_revalidator()
            return ActionReceipt(
                action_id=request.action_id,
                state="succeeded",
                platform_receipt_reference="douyin-im:sanitized-receipt",
                occurred_at=NOW,
                failure_code=None,
            )

    monkeypatch.setattr(
        browser_state_module,
        "DouyinActionExecutor",
        MustNotUseBrowserMessageControls,
    )
    monkeypatch.setattr(
        browser_state_module,
        "DouyinSpiderPrivateMessageExecutor",
        RecordingPrivateMessageExecutor,
        raising=False,
    )
    playwright = IdentityPlaywright(raw_sec_uid)

    receipt = _execute_action(
        playwright,
        "/fixture/profile",
        action_request(
            account_handle=account_handle,
            kind="direct_message",
        ).model_dump(mode="json"),
        headless=False,
        browser_channel=None,
        manual_verification_seconds=30,
        account_authority_revalidator=lambda: authority_checks.append(
            "checked"
        ),
    )

    context = playwright.chromium.context
    assert receipt["platform_receipt_reference"] == (
        "douyin-im:sanitized-receipt"
    )
    assert observed == [(context, context.pages[0], "direct_message")]
    assert authority_checks == ["checked"]
    assert context.events == ["context_close"]


def test_browser_action_keeps_ambiguous_comment_visible_for_manual_review(
    monkeypatch,
):
    raw_sec_uid = "MS4wLjABExpectedAccount"
    account_handle = account_handle_for_raw_sec_uid(raw_sec_uid)

    class AmbiguousExecutor:
        def __init__(self, **_kwargs):
            pass

        def execute(self, _page, _request):
            raise DouyinActionFailure("douyin_action_receipt_ambiguous")

    monkeypatch.setattr(
        browser_state_module,
        "DouyinActionExecutor",
        AmbiguousExecutor,
    )
    playwright = IdentityPlaywright(raw_sec_uid)

    with pytest.raises(
        DouyinActionFailure,
        match="douyin_action_receipt_ambiguous",
    ):
        _execute_action(
            playwright,
            "/fixture/profile",
            action_request(account_handle=account_handle).model_dump(
                mode="json"
            ),
            headless=False,
            browser_channel=None,
            manual_verification_seconds=30,
        )

    assert playwright.chromium.context.events == [
        "bring_to_front",
        ("wait_for_timeout", 10_000),
        "context_close",
    ]


def test_browser_action_result_review_is_best_effort_after_confirmed_success(
    monkeypatch,
):
    raw_sec_uid = "MS4wLjABExpectedAccount"
    account_handle = account_handle_for_raw_sec_uid(raw_sec_uid)

    class SuccessfulExecutor:
        def __init__(self, **_kwargs):
            pass

        def execute(self, _page, request):
            return ActionReceipt(
                action_id=request.action_id,
                state="succeeded",
                platform_receipt_reference="douyin-comment:receipt",
                occurred_at=NOW,
                failure_code=None,
            )

    monkeypatch.setattr(
        browser_state_module,
        "DouyinActionExecutor",
        SuccessfulExecutor,
    )
    playwright = IdentityPlaywright(raw_sec_uid)
    page = playwright.chromium.context.pages[0]

    def preview_unavailable(*_args, **_kwargs):
        raise RuntimeError("preview_unavailable")

    page.bring_to_front = preview_unavailable
    page.wait_for_timeout = preview_unavailable

    receipt = _execute_action(
        playwright,
        "/fixture/profile",
        action_request(account_handle=account_handle).model_dump(mode="json"),
        headless=False,
        browser_channel=None,
        manual_verification_seconds=30,
    )

    assert receipt["state"] == "succeeded"
    assert playwright.chromium.context.closed is True
    assert playwright.chromium.context.events == ["context_close"]


@pytest.mark.parametrize(
    ("kind", "failure_code"),
    [
        ("comment", "douyin_action_control_missing"),
    ],
)
def test_browser_action_does_not_delay_non_reviewable_outcomes(
    monkeypatch,
    kind,
    failure_code,
):
    raw_sec_uid = "MS4wLjABExpectedAccount"
    account_handle = account_handle_for_raw_sec_uid(raw_sec_uid)

    class OutcomeExecutor:
        def __init__(self, **_kwargs):
            pass

        def execute(self, _page, request):
            if failure_code is not None:
                raise DouyinActionFailure(failure_code)
            return ActionReceipt(
                action_id=request.action_id,
                state="succeeded",
                platform_receipt_reference="douyin-message:receipt",
                occurred_at=NOW,
                failure_code=None,
            )

    monkeypatch.setattr(
        browser_state_module,
        "DouyinActionExecutor",
        OutcomeExecutor,
    )
    playwright = IdentityPlaywright(raw_sec_uid)

    if failure_code is not None:
        with pytest.raises(DouyinActionFailure, match=failure_code):
            _execute_action(
                playwright,
                "/fixture/profile",
                action_request(
                    account_handle=account_handle,
                    kind=kind,
                ).model_dump(mode="json"),
                headless=False,
                browser_channel=None,
                manual_verification_seconds=30,
            )
    else:
        receipt = _execute_action(
            playwright,
            "/fixture/profile",
            action_request(
                account_handle=account_handle,
                kind=kind,
            ).model_dump(mode="json"),
            headless=False,
            browser_channel=None,
            manual_verification_seconds=30,
        )
        assert receipt["state"] == "succeeded"

    assert playwright.chromium.context.events == ["context_close"]


def test_in_place_bound_identity_check_rejects_a_switched_sender_without_navigation():
    frozen_raw_sec_uid = "MS4wLjABFrozenSender"
    page = IdentityPage("MS4wLjABSwitchedSender")
    page.url = "https://www.douyin.com/video/123"

    with pytest.raises(
        DouyinActionFailure,
        match="douyin_account_identity_changed",
    ):
        _require_bound_action_identity_in_place(
            page,
            action_request(account_handle=account_handle_for_raw_sec_uid(
                frozen_raw_sec_uid
            )),
        )

    assert page.url == "https://www.douyin.com/video/123"
    assert page.visited == []


class WorkerConnection:
    def __init__(self, commands):
        self.commands = iter(commands)
        self.sent = []
        self.closed = False

    def recv(self):
        return next(self.commands)

    def send(self, value):
        self.sent.append(value)

    def close(self):
        self.closed = True


def test_browser_worker_constructs_visual_locator_inside_worker_before_action(
    monkeypatch,
):
    visual_locator = object()
    constructions = []
    action_locators = []
    connection = WorkerConnection([
        {
            "id": 1,
            "operation": "action",
            "profile_path": "/fixture/profile",
            "request": action_request().model_dump(mode="json"),
        },
        {"id": 2, "operation": "shutdown"},
    ])
    playwright = SimpleNamespace(stop=lambda: None)
    monkeypatch.setattr(browser_state_module, "os", SimpleNamespace(name="nt"))
    monkeypatch.setattr(
        browser_state_module,
        "create_visual_locator",
        lambda mode: constructions.append(mode) or visual_locator,
    )
    monkeypatch.setattr(
        browser_state_module,
        "_start_playwright",
        lambda _factory: playwright,
    )
    monkeypatch.setattr(
        browser_state_module,
        "_execute_action",
        lambda received_playwright, _profile, _request, **kwargs: (
            action_locators.append((
                received_playwright,
                kwargs.get("visual_locator"),
                callable(kwargs.get("account_authority_revalidator")),
            ))
            or {"state": "succeeded"}
        ),
    )

    _browser_worker(
        connection,
        None,
        True,
        None,
        30,
        "rapidocr",
    )

    assert constructions == ["rapidocr"]
    assert action_locators == [(playwright, visual_locator, True)]
    assert connection.sent[0] == {"kind": "ready"}
    assert connection.sent[1] == {
        "id": 1,
        "kind": "ok",
        "value": {"state": "succeeded"},
    }
    assert connection.sent[2] == {"kind": "shutdown_ok"}
    assert connection.closed is True


def test_browser_worker_fails_closed_before_playwright_when_ocr_is_unavailable(
    monkeypatch,
):
    starts = []
    connection = WorkerConnection([])
    monkeypatch.setattr(browser_state_module, "os", SimpleNamespace(name="nt"))
    monkeypatch.setattr(
        browser_state_module,
        "create_visual_locator",
        lambda _mode: (_ for _ in ()).throw(
            RuntimeError("douyin_visual_locator_unavailable")
        ),
    )
    monkeypatch.setattr(
        browser_state_module,
        "_start_playwright",
        lambda _factory: starts.append("playwright"),
    )

    _browser_worker(connection, None, True, None, 30, "rapidocr")

    assert starts == []
    assert connection.sent == [{
        "kind": "startup_error",
        "message": "douyin_visual_locator_unavailable",
    }]
    assert connection.closed is True


def test_browser_worker_redacts_live_display_open_failure_diagnostics(
    monkeypatch,
):
    api_key = "sk-worker-diagnostic-must-not-leak"
    private_url = (
        "https://www.douyin.com/login/?ticket=must-not-leak"
    )
    profile_path = "/private/profiles/must-not-leak"
    connection = WorkerConnection([
        {
            "id": 1,
            "operation": "open",
            "profile_path": profile_path,
        },
        {"id": 2, "operation": "shutdown"},
    ])
    playwright = SimpleNamespace(stop=lambda: None)
    monkeypatch.setattr(browser_state_module, "os", SimpleNamespace(name="nt"))
    monkeypatch.setattr(
        browser_state_module,
        "_start_playwright",
        lambda _factory: playwright,
    )

    def fail_live_display():
        raise RuntimeError(
            f"api_key={api_key} url={private_url} profile={profile_path}"
        )

    _browser_worker(
        connection,
        None,
        False,
        None,
        30,
        live_display_factory=fail_live_display,
    )

    assert connection.sent[0] == {"kind": "ready"}
    assert connection.sent[1] == {
        "id": 1,
        "kind": "login_open_error",
        "stage": "live_display_start",
        "error_code": "douyin_live_display_unavailable",
    }
    serialized = json.dumps(connection.sent, ensure_ascii=False)
    assert api_key not in serialized
    assert private_url not in serialized
    assert profile_path not in serialized
    assert connection.sent[2] == {"kind": "shutdown_ok"}
    assert connection.closed is True


def test_browser_worker_preserves_closed_open_substage_without_raw_detail(
    monkeypatch,
):
    api_key = "sk-worker-open-substage-must-not-leak"
    private_url = "https://www.douyin.com/login/?ticket=must-not-leak"
    profile_path = "/private/profiles/open-substage-must-not-leak"
    connection = WorkerConnection([
        {
            "id": 1,
            "operation": "open",
            "profile_path": profile_path,
        },
        {"id": 2, "operation": "shutdown"},
    ])
    playwright = SimpleNamespace(stop=lambda: None)
    monkeypatch.setattr(browser_state_module, "os", SimpleNamespace(name="nt"))
    monkeypatch.setattr(
        browser_state_module,
        "_start_playwright",
        lambda _factory: playwright,
    )

    def fail_open_context(*_args, **_kwargs):
        failure = browser_state_module.DouyinLoginOpenFailure(
            "browser_launch",
            "douyin_login_open_failed",
        )
        failure.raw_detail = (
            f"api_key={api_key} url={private_url} profile={profile_path}"
        )
        raise failure

    monkeypatch.setattr(
        browser_state_module,
        "_open_context",
        fail_open_context,
    )

    _browser_worker(connection, None, False, None, 30)

    assert connection.sent[0] == {"kind": "ready"}
    assert connection.sent[1] == {
        "id": 1,
        "kind": "login_open_error",
        "stage": "browser_launch",
        "error_code": "douyin_login_open_failed",
    }
    serialized = json.dumps(connection.sent, ensure_ascii=False)
    assert api_key not in serialized
    assert private_url not in serialized
    assert profile_path not in serialized
    assert connection.sent[2] == {"kind": "shutdown_ok"}
    assert connection.closed is True


def test_bound_identity_waits_for_delayed_logged_in_header_dom():
    raw_sec_uid = "MS4wLjABDelayedHeader"
    page = DelayedIdentityPage(raw_sec_uid, missing_reads=2)

    _require_bound_action_identity(
        page,
        action_request(account_handle=account_handle_for_raw_sec_uid(
            raw_sec_uid
        )),
    )

    assert page.identity_reads == 3
    assert page.waits == [250, 250]
    assert page.visited == ["https://www.douyin.com/"]


def test_bound_identity_retry_does_not_reload_and_reset_delayed_dom():
    raw_sec_uid = "MS4wLjABDelayedAcrossNavigation"

    class NavigationResetPage(DelayedIdentityPage):
        def goto(self, url, **kwargs):
            super().goto(url, **kwargs)
            self.identity_reads = 0

    page = NavigationResetPage(raw_sec_uid, missing_reads=2)

    _require_bound_action_identity(
        page,
        action_request(account_handle=account_handle_for_raw_sec_uid(
            raw_sec_uid
        )),
    )

    assert page.identity_reads == 3
    assert page.waits == [250, 250]
    assert page.visited == ["https://www.douyin.com/"]


def test_bound_identity_profile_name_retry_does_not_reload_profile_dom():
    raw_sec_uid = "MS4wLjABDelayedProfileName"
    profile_url = f"https://www.douyin.com/user/{raw_sec_uid}"

    class DelayedProfileNamePage(IdentityPage):
        def __init__(self):
            super().__init__(raw_sec_uid)
            self.waits = []

        def locator(self, selector):
            if selector == (
                'header a[href], nav a[href], [role="navigation"] a[href], '
                '[data-e2e="douyin-header"] a[href], #douyin-header a[href]'
            ):
                return IdentityLocator([{
                    "href": f"/user/{raw_sec_uid}",
                    "title": "个人主页",
                    "text": "个人主页",
                }])
            if selector in {
                '[data-e2e="user-info"] [data-e2e="user-name"]',
                '[data-e2e="user-info"] h1',
                '[data-e2e="user-detail"] h1',
                'main [data-e2e="user-name"]',
                'main h1',
            }:
                if self.url == profile_url and len(self.waits) >= 2:
                    return IdentityLocator([{
                        "text": "延迟挂载账号名",
                    }])
                return IdentityLocator([])
            raise AssertionError(selector)

        def wait_for_timeout(self, milliseconds):
            self.waits.append(milliseconds)

    page = DelayedProfileNamePage()

    _require_bound_action_identity(
        page,
        action_request(account_handle=account_handle_for_raw_sec_uid(
            raw_sec_uid
        )),
    )

    assert page.waits == [250, 250]
    assert page.visited == ["https://www.douyin.com/", profile_url]


def test_bound_identity_ambiguity_does_not_retry():
    class AmbiguousIdentityPage(DelayedIdentityPage):
        def locator(self, selector):
            if selector == (
                'header a[href], nav a[href], [role="navigation"] a[href], '
                '[data-e2e="douyin-header"] a[href], #douyin-header a[href]'
            ):
                return IdentityLocator([
                    {"href": "/user/MS4wLjABFirst", "title": "账号一"},
                    {"href": "/user/MS4wLjABSecond", "title": "账号二"},
                ])
            return super().locator(selector)

    page = AmbiguousIdentityPage("unused", missing_reads=0)

    with pytest.raises(
        DouyinActionFailure,
        match="douyin_account_identity_changed",
    ):
        _require_bound_action_identity(
            page,
            action_request(account_handle=account_handle_for_raw_sec_uid(
                "MS4wLjABFirst"
            )),
        )

    assert page.waits == []


def test_browser_action_ipc_timeout_is_manual_window_plus_fifty_seconds(
    monkeypatch,
):
    monkeypatch.setenv("DOUYIN_ACTION_MANUAL_VERIFICATION_SECONDS", "30")
    browser = MediaCrawlerDouyinBrowserState(
        playwright_factory=headless_verification_playwright_factory,
        startup_timeout=2,
        command_timeout=5,
    )
    try:
        assert browser._timeout == 5
        assert browser._action_timeout == 80
    finally:
        browser.close_browser()


def test_deployment_manual_verification_window_defaults_and_validates_range(
    monkeypatch,
):
    parser = getattr(
        deployment_app,
        "deployment_action_manual_verification_seconds",
        None,
    )
    assert parser is not None

    monkeypatch.delenv("DOUYIN_ACTION_MANUAL_VERIFICATION_SECONDS", raising=False)
    assert parser() == 120
    for raw, expected in [("30", 30), ("120", 120), ("300", 300)]:
        monkeypatch.setenv("DOUYIN_ACTION_MANUAL_VERIFICATION_SECONDS", raw)
        assert parser() == expected
    for invalid in ["29", "301", "30.5", "", " 120 "]:
        monkeypatch.setenv("DOUYIN_ACTION_MANUAL_VERIFICATION_SECONDS", invalid)
        with pytest.raises(
            RuntimeError,
            match="DOUYIN_ACTION_MANUAL_VERIFICATION_SECONDS",
        ):
            parser()


def test_invalid_deployment_window_is_rejected_before_browser_start(
    tmp_path, monkeypatch,
):
    volume = tmp_path / "encrypted"
    profiles = volume / "profiles"
    profiles.mkdir(parents=True, mode=0o700)
    os.chmod(volume, 0o700)
    os.chmod(profiles, 0o700)
    monkeypatch.setenv("MEDIACRAWLER_ENCRYPTED_VOLUME", str(volume))
    monkeypatch.setenv("MEDIACRAWLER_PROFILE_ROOT", str(profiles))
    monkeypatch.setenv("DOUYIN_ACTION_MANUAL_VERIFICATION_SECONDS", "301")
    browser_starts = 0

    class BrowserMustNotStart:
        def __init__(self, **_kwargs):
            nonlocal browser_starts
            browser_starts += 1

    monkeypatch.setattr(
        deployment_app,
        "MediaCrawlerDouyinBrowserState",
        BrowserMustNotStart,
    )

    with pytest.raises(
        RuntimeError,
        match="DOUYIN_ACTION_MANUAL_VERIFICATION_SECONDS",
    ):
        deployment_app.create_deployment_account_manager()
    assert browser_starts == 0
