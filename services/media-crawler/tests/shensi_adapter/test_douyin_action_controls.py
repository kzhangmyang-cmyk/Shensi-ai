from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
import hashlib
import json
from urllib.parse import urlencode

import pytest

from shensi_adapter.douyin_action_controls import (
    ActionControlsFailure,
    ReceiptBaseline,
    find_existing_outgoing_receipt,
    find_visible_receipt,
    pin_action_control,
    prepare_guarded_action_submit,
    require_direct_message_recipient_binding,
)
from shensi_adapter.douyin_actions import (
    DouyinActionExecutor,
    DouyinActionFailure,
    DouyinActionReconciler,
)
from shensi_adapter.douyin_account_identity import (
    account_handle_for_raw_sec_uid,
)
from shensi_adapter.schemas import ActionReconciliationRequest, ActionRequest


NOW = datetime(2026, 8, 25, tzinfo=UTC)
COMMENT_COMPOSER = '[contenteditable="true"][aria-label*="评论"]'
COMMENT_SUBMIT = 'button:has-text("发送")'
INDEPENDENT_VIDEO_COMPOSER = ".public-DraftEditor-content"
INDEPENDENT_VIDEO_SUBMIT = 'div[data-e2e="comment-post"]'


@dataclass
class FakeElement:
    name: str
    selectors: set[str] = field(default_factory=set)
    role: str | None = None
    accessible_name: str | None = None
    text: str = ""
    exact_texts: set[str] = field(default_factory=set)
    attributes: dict[str, str] = field(default_factory=dict)
    visible: bool = True
    enabled: bool = True
    editable: bool = False
    input_value_supported: bool = False
    readback: str | None = None
    visible_after_submit: bool = False
    comment_item: bool = False
    contains_editor: bool = False
    descendant_texts: list[str] = field(default_factory=list)
    descendant_editors: set[str] = field(default_factory=set)
    tag_name: str = "div"
    attribute_errors: set[str] = field(default_factory=set)
    visibility_error_after: int | None = None
    visibility_reads: int = 0
    action: str | None = None
    click_error_after_dispatch: bool = False
    message_item: bool = False
    visible_in_message_panel: bool = False
    navigate_to: str | None = None
    tooltip_id: str | None = None
    conversation_recipient_markers: list[dict[str, str | None]] | None = None
    conversation_recipient_marker_sequence: list[
        list[dict[str, str | None]] | None
    ] = field(default_factory=list)


class FakeLocator:
    def __init__(self, page: "FakePage", elements: list[FakeElement]):
        self.page = page
        self.elements = elements

    def count(self):
        return len(self.elements)

    def nth(self, index: int):
        return FakeLocator(self.page, [self.elements[index]])

    def and_(self, other: "FakeLocator"):
        return FakeLocator(self.page, [
            item for item in self.elements if item in other.elements
        ])

    def _one(self):
        if len(self.elements) != 1:
            raise RuntimeError("fake_locator_not_unique")
        return self.elements[0]

    def is_visible(self, **_kwargs):
        element = self._one()
        element.visibility_reads += 1
        if (element.visibility_error_after is not None
                and element.visibility_reads > element.visibility_error_after):
            raise RuntimeError("fake_locator_detached")
        return element.visible and (
            not element.visible_after_submit or self.page.after_submit
        ) and (
            not element.visible_in_message_panel or self.page.message_panel_open
        )

    def is_enabled(self, **_kwargs):
        return self._one().enabled

    def is_editable(self, **_kwargs):
        return self._one().editable

    def fill(self, value: str, **_kwargs):
        element = self._one()
        self.page.fills.append((element.name, value))
        element.text = value

    def press(self, key: str, **_kwargs):
        element = self._one()
        self.page.native_keys.append((element.name, key))
        if key == "Backspace":
            element.text = ""

    def press_sequentially(self, value: str, **_kwargs):
        element = self._one()
        self.page.native_types.append((element.name, value))
        self.page.native_type_options.append(dict(_kwargs))
        element.text += value

    def input_value(self, **_kwargs):
        element = self._one()
        if not element.input_value_supported:
            raise RuntimeError("fake_input_value_unsupported")
        return element.readback if element.readback is not None else element.text

    def text_content(self, **_kwargs):
        element = self._one()
        return element.readback if element.readback is not None else element.text

    def click(self, **_kwargs):
        element = self._one()
        self.page.clicks.append(element.name)
        if element.editable:
            self.page.focused = element
        if element.action == "open_message":
            self.page.message_panel_open = True
            if element.navigate_to is not None:
                self.page.url = element.navigate_to
        elif element.action == "submit":
            self.page.after_submit = True
            if element.click_error_after_dispatch:
                raise RuntimeError("fake_submit_navigation_detached")

    def get_attribute(self, name: str, **_kwargs):
        element = self._one()
        if name in element.attribute_errors:
            raise RuntimeError("fake_attribute_read_failed")
        return element.attributes.get(name)

    def get_by_text(self, text: str, *, exact: bool):
        if exact:
            normalized = " ".join(text.split())
            matches = []
            for item in self.elements:
                if " ".join(item.text.split()) == normalized:
                    matches.append(item)
                for index, descendant in enumerate([
                    *sorted(item.exact_texts), *item.descendant_texts,
                ]):
                    if " ".join(descendant.split()) == normalized:
                        matches.append(FakeElement(
                            name=f"{item.name}-text-{index}", text=descendant,
                        ))
        else:
            matches = [item for item in self.elements if text in item.text]
        return FakeLocator(self.page, matches)

    def get_by_role(self, role: str):
        if role != "textbox":
            return FakeLocator(self.page, [])
        return FakeLocator(self.page, [
            item for item in self.elements
            if item.tag_name in {"input", "textarea"}
            or item.attributes.get("role") == "textbox"
        ])

    def locator(self, selector: str):
        if selector == '[id^="tooltip_"]':
            return FakeLocator(self.page, [
                FakeElement(
                    name=f"{item.name}-tooltip",
                    attributes={"id": item.tooltip_id},
                )
                for item in self.elements
                if item.tooltip_id is not None
            ])
        if selector == '[contenteditable="true"]':
            return FakeLocator(self.page, [
                item for item in self.elements
                if item.contains_editor or item.attributes.get("contenteditable") == "true"
            ])
        if selector == '[contenteditable], textarea, input, [role="textbox"]':
            descendants = []
            for item in self.elements:
                for index, editor_kind in enumerate(sorted(item.descendant_editors)):
                    descendants.append(FakeElement(
                        name=f"{item.name}-editor-{index}", tag_name=editor_kind,
                    ))
                if item.contains_editor:
                    descendants.append(FakeElement(name=f"{item.name}-editor"))
            return FakeLocator(self.page, descendants)
        return FakeLocator(self.page, [])

    def evaluate(self, _expression: str, arg=None, **_kwargs):
        if "__shensiDirectMessageRecipientBinding" in _expression:
            element = self._one()
            markers = (
                element.conversation_recipient_marker_sequence.pop(0)
                if element.conversation_recipient_marker_sequence
                else element.conversation_recipient_markers
            )
            return {
                "panelFound": markers is not None,
                "markers": [] if markers is None else markers,
            }
        if "__shensiDirectMessageReceiptSnapshot" in _expression:
            element = self._one()
            if not self.is_visible():
                return {"state": "not_match"}
            if (element.editable or element.contains_editor
                    or element.descendant_editors
                    or element.attributes.get("role") == "textbox"
                    or "contenteditable" in element.attributes
                    or element.tag_name in {"textarea", "input"}):
                return {"state": "not_match"}
            directions = {
                element.attributes.get("data-direction"),
                element.attributes.get("data-message-direction"),
                element.attributes.get("data-owner"),
                element.attributes.get("aria-label"),
            }
            directions.discard(None)
            normalized = {value.strip().lower() for value in directions}
            outgoing = {"outgoing", "sent", "self", "我发送的消息"}
            incoming = {"incoming", "received", "other", "对方发送的消息"}
            if normalized & outgoing and normalized & incoming:
                return {"state": "ambiguous"}
            if not normalized & outgoing:
                return (
                    {"state": "not_match"}
                    if normalized & incoming else {"state": "ambiguous"}
                )
            content = arg["content"]
            if content not in {
                element.text,
                *element.exact_texts,
                *element.descendant_texts,
            }:
                return {"state": "not_match"}
            markers = (
                element.conversation_recipient_marker_sequence.pop(0)
                if element.conversation_recipient_marker_sequence
                else element.conversation_recipient_markers
            )
            if markers is None or len(markers) != 1:
                return {"state": "ambiguous"}
            marker = markers[0]
            identities = []
            href = marker.get("href")
            if href is not None:
                prefix = "https://www.douyin.com/user/"
                if href.startswith(prefix):
                    identities.append(href.removeprefix(prefix))
                elif href.startswith("/user/"):
                    identities.append(href.removeprefix("/user/"))
                else:
                    return {"state": "ambiguous"}
            sec_uid = marker.get("secUid")
            if sec_uid is not None:
                identities.append(sec_uid)
            if (not identities or len(set(identities)) != 1
                    or identities[0] != arg["recipientReference"]):
                return {"state": "ambiguous"}
            raw_ids = [value for value in (
                element.attributes.get("data-message-id"),
                element.attributes.get("data-msg-id"),
            ) if value is not None]
            if len(set(raw_ids)) > 1:
                return {"state": "ambiguous"}
            times = [value for value in (
                element.attributes.get("data-created-at"),
                element.attributes.get("data-create-time"),
                element.attributes.get("datetime"),
            ) if value is not None]
            return {
                "state": "match",
                "platformId": raw_ids[0] if raw_ids else None,
                "receiptTimes": times,
            }
        return self._one().tag_name.lower()


class FakeKeyboard:
    def __init__(self, page: "FakePage"):
        self.page = page

    def press(self, key: str, *, delay: int | None = None):
        self.page.browser_keys.append(key)
        if key == "Backspace" and self.page.focused is not None:
            self.page.focused.text = ""


class FakePage:
    def __init__(self, elements: list[FakeElement], *, redirect_url: str | None = None,
                 page_title: str = "抖音", clock=None, after_wait=None):
        self.elements = elements
        self.after_submit = False
        self.url = "about:blank"
        self.redirect_url = redirect_url
        self.urls: list[str] = []
        self.fills: list[tuple[str, str]] = []
        self.clicks: list[str] = []
        self.locator_queries: list[str] = []
        self.role_queries: list[tuple[str, str, bool]] = []
        self.native_keys: list[tuple[str, str]] = []
        self.native_types: list[tuple[str, str]] = []
        self.native_type_options: list[dict[str, object]] = []
        self.browser_keys: list[str] = []
        self.focused: FakeElement | None = None
        self.message_panel_open = False
        self.page_title = page_title
        self.clock = clock
        self.after_wait = after_wait
        self.waits: list[int] = []
        self.keyboard = FakeKeyboard(self)

    def goto(self, url: str, **_kwargs):
        self.urls.append(url)
        self.url = self.redirect_url or url

    def locator(self, selector: str):
        self.locator_queries.append(selector)
        if "comment-item" in selector or "data-comment-id" in selector or "data-cid" in selector:
            return FakeLocator(self, [item for item in self.elements if item.comment_item])
        if ("data-message-id" in selector or "data-msg-id" in selector
                or "message-item" in selector or "message-bubble" in selector):
            return FakeLocator(self, [item for item in self.elements if item.message_item])
        selectors = {candidate.strip() for candidate in selector.split(", ")}
        return FakeLocator(self, [
            item for item in self.elements if selectors.intersection(item.selectors)
        ])

    def get_by_role(self, role: str, *, name: str, exact: bool):
        self.role_queries.append((role, name, exact))
        matches = [
            item for item in self.elements
            if item.role == role and item.accessible_name == name
        ] if exact else [
            item for item in self.elements
            if item.role == role and name in (item.accessible_name or "")
        ]
        return FakeLocator(self, matches)

    def wait_for_timeout(self, milliseconds: int):
        self.waits.append(milliseconds)
        if self.clock is not None:
            self.clock.advance(milliseconds)
        if self.after_wait is not None:
            self.after_wait(self)

    def title(self):
        return self.page_title


class FakeVisualLocator:
    def __init__(self, controls: dict[str, FakeElement] | None = None,
                 *, after_locate=None):
        self.controls = controls or {}
        self.after_locate = after_locate
        self.calls: list[str] = []

    def locate_control(self, page, *, purpose, deadline_at):
        assert deadline_at == NOW + timedelta(minutes=1)
        self.calls.append(purpose)
        element = self.controls.get(purpose)
        if element is None:
            raise AssertionError(f"unexpected visual lookup: {purpose}")
        if self.after_locate is not None:
            self.after_locate(page)
        return FakeLocator(page, [element])


@dataclass(frozen=True)
class FakeRequest:
    method: str
    post_data: str | None


class FakeResponse:
    def __init__(self, *, payload: object, url: str, method: str = "POST",
                 post_data: str | None, status: int = 200):
        self._payload = payload
        self.url = url
        self.status = status
        self.request = FakeRequest(method=method, post_data=post_data)

    def json(self):
        return self._payload


@dataclass(frozen=True)
class FakeResponseInfo:
    value: FakeResponse


class FakeExpectedResponse:
    def __init__(self, predicate, response: FakeResponse):
        self._predicate = predicate
        self._response = response

    def __enter__(self):
        return FakeResponseInfo(self._response)

    def __exit__(self, error_type, _error, _traceback):
        if error_type is None and not self._predicate(self._response):
            raise TimeoutError("fake_expected_response_timeout")


class ResponseCapturingPage(FakePage):
    def __init__(self, elements: list[FakeElement], *, response: FakeResponse):
        super().__init__(elements)
        self.response = response
        self.response_wait_timeouts: list[int] = []

    def expect_response(self, predicate, *, timeout: int):
        self.response_wait_timeouts.append(timeout)
        return FakeExpectedResponse(predicate, self.response)


def action_request(content: str = "冻结的批准文本",
                   kind: str = "comment") -> ActionRequest:
    return ActionRequest(
        action_id=f"action-{kind}",
        account_handle=account_handle_for_raw_sec_uid(
            "MS4wLjABCurrentAccount"
        ),
        login_state_version=3,
        kind=kind,
        target_public_url=(
            "https://www.douyin.com/video/7350000000000000001"
            if kind == "comment"
            else "https://www.douyin.com/user/MS4wLjABCreator"
        ),
        content=content,
        deadline_at=NOW + timedelta(minutes=1),
        approved_content_hash="sha256:" + hashlib.sha256(json.dumps(
            {"content": content}, ensure_ascii=False, sort_keys=True,
            separators=(",", ":"),
        ).encode()).hexdigest(),
    )


class FakeClock:
    def __init__(self):
        self.current = NOW

    def now(self) -> datetime:
        return self.current

    def advance(self, milliseconds: int) -> None:
        self.current += timedelta(milliseconds=milliseconds)


def reconciliation_request(
    content: str = "冻结的批准文本",
    kind: str = "comment",
    *,
    not_before: datetime = NOW - timedelta(seconds=1),
) -> ActionReconciliationRequest:
    return ActionReconciliationRequest(
        **action_request(content, kind).model_dump(),
        not_before=not_before,
    )


def dm_entry(name: str = "dm-entry", **changes: object) -> FakeElement:
    values: dict[str, object] = {
        "name": name,
        "selectors": {'button:has-text("发私信")'},
        "role": "button",
        "accessible_name": "发私信",
        "text": "发私信",
        "action": "open_message",
    }
    values.update(changes)
    return FakeElement(**values)


def dm_composer(**changes: object) -> FakeElement:
    values: dict[str, object] = {
        "name": "dm-composer",
        "selectors": {'.DraftEditor-editor [contenteditable="true"]'},
        "editable": True,
        "attributes": {"contenteditable": "true"},
        "visible_in_message_panel": True,
        "conversation_recipient_markers": [{
            "href": "/user/MS4wLjABCreator",
            "secUid": None,
        }],
    }
    values.update(changes)
    return FakeElement(**values)


def dm_submit(**changes: object) -> FakeElement:
    values: dict[str, object] = {
        "name": "dm-submit",
        "selectors": {".e2e-send-msg-btn"},
        "role": "button",
        "accessible_name": "发送",
        "text": "发送",
        "visible_in_message_panel": True,
        "action": "submit",
        "conversation_recipient_markers": [{
            "href": "/user/MS4wLjABCreator",
            "secUid": None,
        }],
    }
    values.update(changes)
    return FakeElement(**values)


def message_item(**changes: object) -> FakeElement:
    values: dict[str, object] = {
        "name": "message-new",
        "text": "冻结的批准文本",
        "attributes": {
            "data-message-id": "message-123",
            "data-direction": "outgoing",
        },
        "visible_after_submit": True,
        "visible_in_message_panel": True,
        "message_item": True,
        "conversation_recipient_markers": [{
            "href": "/user/MS4wLjABCreator",
            "secUid": None,
        }],
    }
    values.update(changes)
    return FakeElement(**values)


def test_real_direct_message_opens_unique_panel_types_natively_once_and_binds_new_receipt():
    page = FakePage([dm_entry(), dm_composer(), dm_submit(), message_item()])

    receipt = DouyinActionExecutor(now=lambda: NOW).execute(
        page,
        action_request(kind="direct_message"),
    )

    assert page.urls == ["https://www.douyin.com/user/MS4wLjABCreator"]
    assert page.clicks == ["dm-entry", "dm-composer", "dm-submit"]
    assert page.fills == []
    assert page.native_types == [("dm-composer", "冻结的批准文本")]
    assert page.native_keys == [
        ("dm-composer", "ControlOrMeta+A"),
        ("dm-composer", "Backspace"),
    ]
    assert receipt.platform_receipt_reference == "douyin-message:message-123"
    assert '[data-e2e="message-input"]' not in page.locator_queries
    assert '[data-e2e="message-submit"]' not in page.locator_queries
    assert '[data-e2e-receipt-id]' not in page.locator_queries


def test_direct_message_same_profile_url_rejects_a_wrong_recipient_panel_before_typing():
    wrong_recipient = [{
        "href": "/user/MS4wLjABDifferentRecipient",
        "secUid": None,
    }]
    page = FakePage([
        dm_entry(),
        dm_composer(conversation_recipient_markers=wrong_recipient),
        dm_submit(conversation_recipient_markers=wrong_recipient),
        message_item(conversation_recipient_markers=wrong_recipient),
    ])

    with pytest.raises(
        DouyinActionFailure,
        match="^douyin_direct_message_unavailable$",
    ):
        DouyinActionExecutor(now=lambda: NOW).execute(
            page,
            action_request(kind="direct_message"),
        )

    assert page.url == "https://www.douyin.com/user/MS4wLjABCreator"
    assert page.clicks == ["dm-entry"]
    assert page.native_types == []


def test_direct_message_rechecks_recipient_on_submit_and_never_clicks_a_switched_panel():
    page = FakePage([
        dm_entry(),
        dm_composer(),
        dm_submit(conversation_recipient_markers=[{
            "href": "/user/MS4wLjABDifferentRecipient",
            "secUid": None,
        }]),
        message_item(),
    ])

    with pytest.raises(
        DouyinActionFailure,
        match="^douyin_direct_message_unavailable$",
    ):
        DouyinActionExecutor(now=lambda: NOW).execute(
            page,
            action_request(kind="direct_message"),
        )

    assert page.clicks == ["dm-entry", "dm-composer"]
    assert page.native_types == [("dm-composer", "冻结的批准文本")]
    assert "dm-submit" not in page.clicks


def test_direct_message_rechecks_submit_binding_immediately_before_click():
    correct = [{"href": "/user/MS4wLjABCreator", "secUid": None}]
    wrong = [{
        "href": "/user/MS4wLjABDifferentRecipient",
        "secUid": None,
    }]
    page = FakePage([
        dm_entry(),
        dm_composer(),
        dm_submit(conversation_recipient_marker_sequence=[correct, wrong]),
        message_item(),
    ])

    with pytest.raises(
        DouyinActionFailure,
        match="^douyin_direct_message_unavailable$",
    ):
        DouyinActionExecutor(now=lambda: NOW).execute(
            page,
            action_request(kind="direct_message"),
        )

    assert page.clicks == ["dm-entry", "dm-composer"]
    assert "dm-submit" not in page.clicks


def test_real_playwright_guarded_submit_cannot_rebind_to_a_switched_panel():
    from playwright.sync_api import Error, sync_playwright

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        try:
            page = browser.new_page()
            target = "https://www.douyin.com/user/MS4wLjABCreator"
            html = """
              <header><a href="/user/MS4wLjABCurrentAccount">账号</a></header>
              <section data-e2e="message-panel">
                <a data-e2e="message-recipient"
                   href="/user/MS4wLjABCreator">Creator</a>
                <div id="composer" contenteditable="true">冻结的批准文本</div>
                <button class="e2e-send-msg-btn"
                        onclick="window.clicked = 'Creator'">发送</button>
              </section>
            """
            page.route(target, lambda route: route.fulfill(
                status=200,
                content_type="text/html; charset=utf-8",
                body=html,
            ))
            page.goto(target)
            live_submit = page.locator(".e2e-send-msg-btn")
            concrete_submit = pin_action_control(live_submit)
            require_direct_message_recipient_binding(
                concrete_submit,
                target,
            )
            guarded_submit = prepare_guarded_action_submit(
                page,
                concrete_submit,
                concrete_composer=pin_action_control(
                    page.locator("#composer")
                ),
                approved_content="冻结的批准文本",
                kind="direct_message",
                target_public_url=target,
                sender_reference="MS4wLjABCurrentAccount",
            )
            page.locator('[data-e2e="message-panel"]').evaluate("""
              panel => { panel.outerHTML = `
                <section data-e2e="message-panel">
                  <a data-e2e="message-recipient"
                     href="/user/MS4wLjABDifferentRecipient">Different</a>
                  <button class="e2e-send-msg-btn"
                          onclick="window.clicked = 'Different'">发送</button>
                </section>`; }
            """)

            with pytest.raises(Error):
                guarded_submit.click(timeout=100)

            assert page.evaluate("() => window.clicked || null") is None
        finally:
            browser.close()


def test_real_playwright_guard_blocks_hidden_old_marker_with_same_submit_node():
    from playwright.sync_api import Error, sync_playwright

    target = "https://www.douyin.com/user/MS4wLjABCreator"
    html = """
      <header><a href="/user/MS4wLjABCurrentAccount">账号</a></header>
      <section data-e2e="message-panel">
        <a data-e2e="message-recipient"
           href="/user/MS4wLjABCreator">Creator</a>
        <div id="composer" contenteditable="true">冻结的批准文本</div>
        <button class="e2e-send-msg-btn"
                onclick="window.clicked = document.querySelector(
                  '[data-e2e=message-recipient]:not([style*=none])'
                )?.getAttribute('href')">发送</button>
      </section>
    """
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        try:
            page = browser.new_page()
            page.route(target, lambda route: route.fulfill(
                status=200,
                content_type="text/html; charset=utf-8",
                body=html,
            ))
            page.goto(target)
            submit_handle = pin_action_control(
                page.locator(".e2e-send-msg-btn")
            )
            guarded_submit = prepare_guarded_action_submit(
                page,
                submit_handle,
                concrete_composer=pin_action_control(
                    page.locator("#composer")
                ),
                approved_content="冻结的批准文本",
                kind="direct_message",
                target_public_url=target,
                sender_reference="MS4wLjABCurrentAccount",
            )
            page.locator('[data-e2e="message-panel"]').evaluate("""
              panel => {
                panel.querySelector('[data-e2e="message-recipient"]')
                  .style.display = 'none';
                const wrong = document.createElement('a');
                wrong.dataset.e2e = 'message-recipient';
                wrong.href = '/user/MS4wLjABDifferentRecipient';
                wrong.textContent = 'Different';
                panel.prepend(wrong);
              }
            """)

            with pytest.raises((Error, ActionControlsFailure)):
                guarded_submit.click(timeout=100)

            assert page.evaluate("() => window.clicked || null") is None
        finally:
            browser.close()


def test_real_playwright_guard_blocks_a_visible_sender_switch():
    from playwright.sync_api import Error, sync_playwright

    target = "https://www.douyin.com/video/7350000000000000001"
    html = """
      <header><a href="/user/MS4wLjABCurrentAccount">账号</a></header>
      <div id="composer" contenteditable="true">冻结的批准文本</div>
      <button id="send" onclick="window.clicked = true">发送</button>
    """
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        try:
            page = browser.new_page()
            page.route(target, lambda route: route.fulfill(
                status=200,
                content_type="text/html; charset=utf-8",
                body=html,
            ))
            page.goto(target)
            guarded_submit = prepare_guarded_action_submit(
                page,
                pin_action_control(page.locator("#send")),
                concrete_composer=pin_action_control(
                    page.locator("#composer")
                ),
                approved_content="冻结的批准文本",
                kind="comment",
                target_public_url=target,
                sender_reference="MS4wLjABCurrentAccount",
            )
            page.locator("header").evaluate("""
              header => {
                header.querySelector('a').style.display = 'none';
                const wrong = document.createElement('a');
                wrong.href = '/user/MS4wLjABDifferentAccount';
                wrong.textContent = 'Different';
                header.appendChild(wrong);
              }
            """)

            with pytest.raises((Error, ActionControlsFailure)):
                guarded_submit.click(timeout=100)

            assert page.evaluate("() => window.clicked || false") is False
        finally:
            browser.close()


def test_real_playwright_comment_guard_rechecks_content_at_click_dispatch():
    from playwright.sync_api import sync_playwright

    target = "https://www.douyin.com/video/7350000000000000001"
    html = """
      <header><a href="/user/MS4wLjABCurrentAccount">账号</a></header>
      <div id="composer" contenteditable="true">冻结的批准文本</div>
      <button id="send"
              onmousedown="composer.textContent = '未审批的更改'"
              onclick="window.platformClicks = (window.platformClicks || 0) + 1">
        发送
      </button>
    """
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        try:
            page = browser.new_page()
            page.route(target, lambda route: route.fulfill(
                status=200,
                content_type="text/html; charset=utf-8",
                body=html,
            ))
            page.goto(target)
            guarded_submit = prepare_guarded_action_submit(
                page,
                pin_action_control(page.locator("#send")),
                concrete_composer=pin_action_control(
                    page.locator("#composer")
                ),
                approved_content="冻结的批准文本",
                kind="comment",
                target_public_url=target,
                sender_reference="MS4wLjABCurrentAccount",
            )

            with pytest.raises(
                ActionControlsFailure,
                match="^douyin_action_content_mismatch$",
            ):
                guarded_submit.click(timeout=100)

            assert page.evaluate("() => window.platformClicks || 0") == 0
        finally:
            browser.close()


def test_real_playwright_dm_guard_keeps_submit_and_composer_in_same_panel():
    from playwright.sync_api import sync_playwright

    target = "https://www.douyin.com/user/MS4wLjABCreator"
    html = """
      <header><a href="/user/MS4wLjABCurrentAccount">账号</a></header>
      <section data-e2e="message-panel" id="approved-panel">
        <a data-e2e="message-recipient"
           href="/user/MS4wLjABCreator">Creator</a>
        <div id="composer-panel">
          <div id="composer" contenteditable="true">冻结的批准文本</div>
        </div>
        <button id="send" class="e2e-send-msg-btn"
                onmousedown="document.querySelector('#composer-panel')
                  .dataset.e2e = 'message-panel'"
                onclick="window.platformClicks = (window.platformClicks || 0) + 1">
          发送
        </button>
      </section>
    """
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        try:
            page = browser.new_page()
            page.route(target, lambda route: route.fulfill(
                status=200,
                content_type="text/html; charset=utf-8",
                body=html,
            ))
            page.goto(target)
            guarded_submit = prepare_guarded_action_submit(
                page,
                pin_action_control(page.locator("#send")),
                concrete_composer=pin_action_control(
                    page.locator("#composer")
                ),
                approved_content="冻结的批准文本",
                kind="direct_message",
                target_public_url=target,
                sender_reference="MS4wLjABCurrentAccount",
            )

            with pytest.raises(
                ActionControlsFailure,
                match="^douyin_direct_message_unavailable$",
            ):
                guarded_submit.click(timeout=100)

            assert page.evaluate("() => window.platformClicks || 0") == 0
        finally:
            browser.close()


def test_real_playwright_guard_reports_url_switch_before_dispatch():
    from playwright.sync_api import sync_playwright

    target = "https://www.douyin.com/video/7350000000000000001"
    html = """
      <header><a href="/user/MS4wLjABCurrentAccount">账号</a></header>
      <div id="composer" contenteditable="true">冻结的批准文本</div>
      <button id="send"
              onmousedown="history.replaceState({}, '',
                '/video/7350000000000000002')"
              onclick="window.platformClicks = (window.platformClicks || 0) + 1">
        发送
      </button>
    """
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        try:
            page = browser.new_page()
            page.route(target, lambda route: route.fulfill(
                status=200,
                content_type="text/html; charset=utf-8",
                body=html,
            ))
            page.goto(target)
            guarded_submit = prepare_guarded_action_submit(
                page,
                pin_action_control(page.locator("#send")),
                concrete_composer=pin_action_control(
                    page.locator("#composer")
                ),
                approved_content="冻结的批准文本",
                kind="comment",
                target_public_url=target,
                sender_reference="MS4wLjABCurrentAccount",
            )

            with pytest.raises(
                ActionControlsFailure,
                match="^douyin_action_control_missing$",
            ):
                guarded_submit.click(timeout=100)

            assert page.evaluate("() => window.platformClicks || 0") == 0
        finally:
            browser.close()


def test_real_playwright_executor_uses_pinned_controls_and_guarded_dm_submit():
    from playwright.sync_api import sync_playwright

    target = "https://www.douyin.com/user/MS4wLjABCreator"
    html = """
      <!doctype html><html><head><meta charset="utf-8"></head><body>
        <header><a href="/user/MS4wLjABCurrentAccount">账号</a></header>
        <button id="entry" onclick="document.querySelector('section').hidden=false">
          发私信
        </button>
        <section data-e2e="message-panel" hidden>
          <a data-e2e="message-recipient"
             href="/user/MS4wLjABCreator">Creator</a>
          <div class="DraftEditor-editor">
            <div id="composer" contenteditable="true"></div>
          </div>
          <button class="e2e-send-msg-btn" onclick="sendMessage()">发送</button>
        </section>
        <script>
          function sendMessage() {
            const item = document.createElement('article');
            item.dataset.direction = 'outgoing';
            item.dataset.messageId = 'message-executor-atomic';
            const text = document.createElement('span');
            text.textContent = document.querySelector('#composer').textContent;
            item.appendChild(text);
            document.querySelector('section').appendChild(item);
          }
        </script>
      </body></html>
    """
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        try:
            page = browser.new_page()
            page.route(target, lambda route: route.fulfill(
                status=200,
                content_type="text/html; charset=utf-8",
                body=html,
            ))

            receipt = DouyinActionExecutor(
                now=lambda: NOW,
                account_identity_revalidator=(
                    lambda: "MS4wLjABCurrentAccount"
                ),
                require_account_identity_binding=True,
            ).execute(page, action_request(kind="direct_message"))

            assert receipt.platform_receipt_reference == (
                "douyin-message:message-executor-atomic"
            )
        finally:
            browser.close()


def test_real_playwright_executor_activates_lazy_comment_composer_before_typing():
    from playwright.sync_api import sync_playwright

    target = "https://www.douyin.com/video/7350000000000000001"
    publish = "https://www.douyin.com/aweme/v1/web/comment/publish/"
    html = """
      <!doctype html><html><head><meta charset="utf-8"></head><body>
        <header><a href="/user/MS4wLjABCurrentAccount">账号</a></header>
        <div class="comment-input-inner-container">
          <button id="activate" type="button">留下你的精彩评论吧</button>
          <div id="editor-host"></div>
        </div>
        <section data-e2e="comment-list"></section>
        <script>
          window.activationClicks = 0;
          window.platformClicks = 0;
          document.querySelector('#activate').addEventListener('click', () => {
            window.activationClicks += 1;
            document.querySelector('#activate').remove();
            document.querySelector('#editor-host').innerHTML = `
              <div id="composer" class="public-DraftEditor-content"
                   role="combobox" contenteditable="true"></div>
            `;
            const composer = document.querySelector('#composer');
            composer.addEventListener('input', () => {
              if (!composer.textContent || document.querySelector('#send')) return;
              const send = document.createElement('div');
              send.id = 'send';
              send.dataset.e2e = 'comment-post';
              send.textContent = '发布';
              send.addEventListener('click', () => {
                window.platformClicks += 1;
                const body = new URLSearchParams({
                  text: composer.textContent,
                  aweme_id: '7350000000000000001',
                  is_self_see: '0',
                });
                fetch('/aweme/v1/web/comment/publish/', {
                  method: 'POST',
                  headers: {'Content-Type': 'application/x-www-form-urlencoded'},
                  body,
                });
              });
              document.querySelector('#editor-host').appendChild(send);
            });
          });
        </script>
      </body></html>
    """
    response_body = json.dumps({
        "status_code": 0,
        "comment": {
            "cid": "comment-activation-1",
            "text": "冻结的批准文本",
            "aweme_id": "7350000000000000001",
            "user": {"sec_uid": "MS4wLjABCurrentAccount"},
        },
    }, ensure_ascii=False)

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        try:
            page = browser.new_page()
            page.route(target, lambda route: route.fulfill(
                status=200,
                content_type="text/html; charset=utf-8",
                body=html,
            ))
            page.route(publish, lambda route: route.fulfill(
                status=200,
                content_type="application/json; charset=utf-8",
                body=response_body,
            ))

            receipt = DouyinActionExecutor(
                now=lambda: NOW,
                receipt_attempts=1,
                receipt_poll_ms=0,
                control_wait_ms=10,
                control_poll_ms=1,
                account_identity_revalidator=(
                    lambda: "MS4wLjABCurrentAccount"
                ),
                require_account_identity_binding=True,
            ).execute(page, action_request())

            assert receipt.platform_receipt_reference == (
                "douyin-comment:comment-activation-1"
            )
            assert page.evaluate("() => window.activationClicks") == 1
            assert page.evaluate("() => window.platformClicks") == 1
        finally:
            browser.close()


def test_real_playwright_executor_clicks_unmounted_comment_entry_only_once():
    from playwright.sync_api import sync_playwright

    target = "https://www.douyin.com/video/7350000000000000001"
    html = """
      <!doctype html><html><head><meta charset="utf-8"></head><body>
        <div class="comment-input-inner-container">
          <button id="activate" type="button"
                  onclick="window.activationClicks += 1">
            留下你的精彩评论吧
          </button>
        </div>
        <section data-e2e="comment-list"></section>
        <script>window.activationClicks = 0;</script>
      </body></html>
    """

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        try:
            page = browser.new_page()
            page.route(target, lambda route: route.fulfill(
                status=200,
                content_type="text/html; charset=utf-8",
                body=html,
            ))

            with pytest.raises(
                DouyinActionFailure,
                match="^douyin_action_control_missing$",
            ):
                DouyinActionExecutor(
                    now=lambda: NOW,
                    control_wait_ms=3,
                    control_poll_ms=1,
                ).execute(page, action_request())

            assert page.evaluate("() => window.activationClicks") == 1
        finally:
            browser.close()


def test_real_playwright_executor_does_not_activate_matching_text_outside_comments():
    from playwright.sync_api import sync_playwright

    target = "https://www.douyin.com/video/7350000000000000001"
    html = """
      <!doctype html><html><head><meta charset="utf-8"></head><body>
        <button id="outside" type="button"
                onclick="window.outsideClicks += 1">
          留下你的精彩评论吧
        </button>
        <div class="comment-input-inner-container"></div>
        <section data-e2e="comment-list"></section>
        <script>window.outsideClicks = 0;</script>
      </body></html>
    """

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        try:
            page = browser.new_page()
            page.route(target, lambda route: route.fulfill(
                status=200,
                content_type="text/html; charset=utf-8",
                body=html,
            ))

            with pytest.raises(
                DouyinActionFailure,
                match="^douyin_action_control_missing$",
            ):
                DouyinActionExecutor(
                    now=lambda: NOW,
                    control_wait_ms=0,
                ).execute(page, action_request())

            assert page.evaluate("() => window.outsideClicks") == 0
        finally:
            browser.close()


def test_real_playwright_executor_rejects_ambiguous_comment_activation_entries():
    from playwright.sync_api import sync_playwright

    target = "https://www.douyin.com/video/7350000000000000001"
    html = """
      <!doctype html><html><head><meta charset="utf-8"></head><body>
        <div class="comment-input-inner-container">
          <button type="button" onclick="window.activationClicks += 1">
            留下你的精彩评论吧
          </button>
          <button type="button" onclick="window.activationClicks += 1">
            留下你的精彩评论吧
          </button>
        </div>
        <section data-e2e="comment-list"></section>
        <script>window.activationClicks = 0;</script>
      </body></html>
    """

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        try:
            page = browser.new_page()
            page.route(target, lambda route: route.fulfill(
                status=200,
                content_type="text/html; charset=utf-8",
                body=html,
            ))

            with pytest.raises(
                DouyinActionFailure,
                match="^douyin_action_control_ambiguous$",
            ):
                DouyinActionExecutor(
                    now=lambda: NOW,
                    control_wait_ms=0,
                ).execute(page, action_request())

            assert page.evaluate("() => window.activationClicks") == 0
        finally:
            browser.close()


def test_real_playwright_comment_guard_blocks_content_changed_after_readback():
    from playwright.sync_api import sync_playwright

    target = "https://www.douyin.com/video/7350000000000000001"
    html = """
      <!doctype html><html><head><meta charset="utf-8"></head><body>
        <header><a href="/user/MS4wLjABCurrentAccount">账号</a></header>
        <div id="composer" class="public-DraftEditor-content"
             contenteditable="true"></div>
        <div data-e2e="comment-post"
             onclick="window.platformClicks = (window.platformClicks || 0) + 1">
          发送
        </div>
      </body></html>
    """
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        try:
            page = browser.new_page()
            page.route(target, lambda route: route.fulfill(
                status=200,
                content_type="text/html; charset=utf-8",
                body=html,
            ))
            identity_checks = 0

            def mutate_after_readback():
                nonlocal identity_checks
                identity_checks += 1
                if identity_checks == 4:
                    page.locator("#composer").evaluate(
                        "element => { element.textContent = '未审批的更改'; }"
                    )
                return "MS4wLjABCurrentAccount"

            with pytest.raises(
                DouyinActionFailure,
                match="^douyin_action_content_mismatch$",
            ):
                DouyinActionExecutor(
                    now=lambda: NOW,
                    receipt_attempts=1,
                    account_identity_revalidator=mutate_after_readback,
                    require_account_identity_binding=True,
                ).execute(page, action_request())

            assert page.evaluate("() => window.platformClicks || 0") == 0
        finally:
            browser.close()


def test_real_playwright_dm_guard_blocks_replaced_composer_after_readback():
    from playwright.sync_api import sync_playwright

    target = "https://www.douyin.com/user/MS4wLjABCreator"
    html = """
      <!doctype html><html><head><meta charset="utf-8"></head><body>
        <header><a href="/user/MS4wLjABCurrentAccount">账号</a></header>
        <button id="entry" onclick="document.querySelector('section').hidden=false">
          发私信
        </button>
        <section data-e2e="message-panel" hidden>
          <a data-e2e="message-recipient"
             href="/user/MS4wLjABCreator">Creator</a>
          <div class="DraftEditor-editor">
            <div id="composer" contenteditable="true"></div>
          </div>
          <button class="e2e-send-msg-btn"
                  onclick="window.platformClicks = (window.platformClicks || 0) + 1">发送</button>
        </section>
      </body></html>
    """
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        try:
            page = browser.new_page()
            page.route(target, lambda route: route.fulfill(
                status=200,
                content_type="text/html; charset=utf-8",
                body=html,
            ))
            identity_checks = 0

            def mutate_after_readback():
                nonlocal identity_checks
                identity_checks += 1
                if identity_checks == 5:
                    page.locator("#composer").evaluate(
                        """element => {
                          const replacement = element.cloneNode(false);
                          replacement.textContent = '冻结的批准文本';
                          element.replaceWith(replacement);
                        }"""
                    )
                return "MS4wLjABCurrentAccount"

            with pytest.raises(
                DouyinActionFailure,
                match="^douyin_action_content_mismatch$",
            ):
                DouyinActionExecutor(
                    now=lambda: NOW,
                    receipt_attempts=1,
                    account_identity_revalidator=mutate_after_readback,
                    require_account_identity_binding=True,
                ).execute(page, action_request(kind="direct_message"))

            assert page.evaluate("() => window.platformClicks || 0") == 0
        finally:
            browser.close()


def test_real_playwright_executor_reports_content_change_at_dispatch():
    from playwright.sync_api import sync_playwright

    target = "https://www.douyin.com/video/7350000000000000001"
    html = """
      <!doctype html><html><head><meta charset="utf-8"></head><body>
        <header><a href="/user/MS4wLjABCurrentAccount">账号</a></header>
        <div id="composer" class="public-DraftEditor-content"
             contenteditable="true"></div>
        <div data-e2e="comment-post"
             onmousedown="document.querySelector('#composer').textContent =
               '未审批的更改'"
             onclick="window.platformClicks = (window.platformClicks || 0) + 1">
          发送
        </div>
      </body></html>
    """
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        try:
            page = browser.new_page()
            page.route(target, lambda route: route.fulfill(
                status=200,
                content_type="text/html; charset=utf-8",
                body=html,
            ))

            with pytest.raises(
                DouyinActionFailure,
                match="^douyin_action_content_mismatch$",
            ):
                DouyinActionExecutor(
                    now=lambda: NOW,
                    receipt_attempts=1,
                    account_identity_revalidator=(
                        lambda: "MS4wLjABCurrentAccount"
                    ),
                    require_account_identity_binding=True,
                ).execute(page, action_request())

            assert page.evaluate("() => window.platformClicks || 0") == 0
        finally:
            browser.close()


def test_real_playwright_executor_reports_sender_switch_before_dispatch():
    from playwright.sync_api import sync_playwright

    target = "https://www.douyin.com/video/7350000000000000001"
    html = """
      <!doctype html><html><head><meta charset="utf-8"></head><body>
        <header><a href="/user/MS4wLjABCurrentAccount">账号</a></header>
        <div id="composer" class="public-DraftEditor-content"
             contenteditable="true"></div>
        <div data-e2e="comment-post"
             onmousedown="document.querySelector('header a').href =
               '/user/MS4wLjABDifferentAccount'"
             onclick="window.platformClicks = (window.platformClicks || 0) + 1">
          发送
        </div>
      </body></html>
    """
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        try:
            page = browser.new_page()
            page.route(target, lambda route: route.fulfill(
                status=200,
                content_type="text/html; charset=utf-8",
                body=html,
            ))

            with pytest.raises(
                DouyinActionFailure,
                match="^douyin_account_identity_changed$",
            ):
                DouyinActionExecutor(
                    now=lambda: NOW,
                    receipt_attempts=1,
                    account_identity_revalidator=(
                        lambda: "MS4wLjABCurrentAccount"
                    ),
                    require_account_identity_binding=True,
                ).execute(page, action_request())

            assert page.evaluate("() => window.platformClicks || 0") == 0
        finally:
            browser.close()


def test_real_playwright_executor_reports_recipient_switch_before_dispatch():
    from playwright.sync_api import sync_playwright

    target = "https://www.douyin.com/user/MS4wLjABCreator"
    html = """
      <!doctype html><html><head><meta charset="utf-8"></head><body>
        <header><a href="/user/MS4wLjABCurrentAccount">账号</a></header>
        <button id="entry" onclick="document.querySelector('section').hidden=false">
          发私信
        </button>
        <section data-e2e="message-panel" hidden>
          <a data-e2e="message-recipient"
             href="/user/MS4wLjABCreator">Creator</a>
          <div class="DraftEditor-editor">
            <div id="composer" contenteditable="true"></div>
          </div>
          <button class="e2e-send-msg-btn" onmousedown="switchRecipient()"
                  onclick="window.platformClicks = (window.platformClicks || 0) + 1">发送</button>
        </section>
        <script>
          function switchRecipient() {
            document.querySelector('[data-e2e=message-recipient]').href =
              '/user/MS4wLjABDifferentRecipient';
          }
        </script>
      </body></html>
    """
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        try:
            page = browser.new_page()
            page.route(target, lambda route: route.fulfill(
                status=200,
                content_type="text/html; charset=utf-8",
                body=html,
            ))

            with pytest.raises(
                DouyinActionFailure,
                match="^douyin_direct_message_unavailable$",
            ):
                DouyinActionExecutor(
                    now=lambda: NOW,
                    receipt_attempts=1,
                    account_identity_revalidator=(
                        lambda: "MS4wLjABCurrentAccount"
                    ),
                    require_account_identity_binding=True,
                ).execute(page, action_request(kind="direct_message"))

            assert page.evaluate("() => window.platformClicks || 0") == 0
        finally:
            browser.close()


def test_real_playwright_direct_message_receipt_snapshot_binds_all_proof_once():
    from playwright.sync_api import sync_playwright

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        try:
            page = browser.new_page()
            page.set_content(f"""
              <header><a href="/user/MS4wLjABCurrentAccount">账号</a></header>
              <section data-e2e="message-panel">
                <a data-e2e="message-recipient"
                   href="/user/MS4wLjABCreator">Creator</a>
                <article data-direction="outgoing"
                         data-message-id="message-atomic"
                         data-created-at="{NOW.isoformat()}">
                  <span>冻结的批准文本</span>
                </article>
              </section>
            """)

            reference = find_existing_outgoing_receipt(
                page,
                reconciliation_request(kind="direct_message"),
                sender_reference="MS4wLjABCurrentAccount",
            )

            assert reference == "douyin-message:message-atomic"
        finally:
            browser.close()


def test_direct_message_receipt_revalidation_rejects_a_panel_switch():
    correct = [{"href": "/user/MS4wLjABCreator", "secUid": None}]
    wrong = [{
        "href": "/user/MS4wLjABDifferentRecipient",
        "secUid": None,
    }]
    page = FakePage([message_item(
        visible_after_submit=False,
        conversation_recipient_marker_sequence=[correct, wrong],
    )])
    page.message_panel_open = True

    with pytest.raises(
        ActionControlsFailure,
        match="^douyin_action_receipt_ambiguous$",
    ):
        find_visible_receipt(
            page,
            action_request(kind="direct_message"),
            ReceiptBaseline(),
        )


@pytest.mark.parametrize("marker", [
    {"href": "/user/MS4wLjABCreator", "secUid": None},
    {
        "href": "https://www.douyin.com/user/MS4wLjABCreator",
        "secUid": "MS4wLjABCreator",
    },
])
def test_recipient_binding_accepts_only_exact_relative_or_canonical_markers(marker):
    control = FakeLocator(FakePage([]), [FakeElement(
        name="bound-control",
        conversation_recipient_markers=[marker],
    )])

    require_direct_message_recipient_binding(
        control,
        "https://www.douyin.com/user/MS4wLjABCreator",
    )


@pytest.mark.parametrize("marker_href", [
    "/user/MS4wLjABCreator/",
    "/user/MS4wLjABCreator?from=chat",
    "/user/MS4wLjABCreator#profile",
    "https://evil.example/user/MS4wLjABCreator",
])
def test_recipient_binding_rejects_noncanonical_marker_variants(marker_href):
    control = FakeLocator(FakePage([]), [FakeElement(
        name="unbound-control",
        conversation_recipient_markers=[{
            "href": marker_href,
            "secUid": None,
        }],
    )])

    with pytest.raises(
        ActionControlsFailure,
        match="^douyin_direct_message_unavailable$",
    ):
        require_direct_message_recipient_binding(
            control,
            "https://www.douyin.com/user/MS4wLjABCreator",
        )


@pytest.mark.parametrize("markers", [
    None,
    [],
    [
        {"href": "/user/MS4wLjABCreator", "secUid": None},
        {"href": "/user/MS4wLjABDifferentRecipient", "secUid": None},
    ],
])
def test_direct_message_requires_one_exact_recipient_marker_before_typing(markers):
    page = FakePage([
        dm_entry(),
        dm_composer(conversation_recipient_markers=markers),
    ])

    with pytest.raises(DouyinActionFailure):
        DouyinActionExecutor(
            now=lambda: NOW,
            control_wait_ms=0,
        ).execute(page, action_request(kind="direct_message"))

    assert page.clicks == ["dm-entry"]
    assert page.native_types == []


def test_direct_message_uses_visual_locator_only_for_missing_entry_and_submit():
    visual_entry = dm_entry(selectors=set())
    visual_submit = dm_submit(selectors=set())
    visual = FakeVisualLocator({
        "direct_message_entry": visual_entry,
        "direct_message_submit": visual_submit,
    })
    page = FakePage([
        visual_entry,
        dm_composer(),
        visual_submit,
        message_item(),
    ])

    receipt = DouyinActionExecutor(
        now=lambda: NOW,
        control_wait_ms=0,
        visual_locator=visual,
    ).execute(page, action_request(kind="direct_message"))

    assert receipt.platform_receipt_reference == "douyin-message:message-123"
    assert visual.calls == ["direct_message_entry", "direct_message_submit"]
    assert page.clicks == ["dm-entry", "dm-composer", "dm-submit"]


def test_visual_entry_rebind_crossing_deadline_fails_before_click():
    clock = FakeClock()
    visual_entry = dm_entry(selectors=set())
    visual = FakeVisualLocator(
        {"direct_message_entry": visual_entry},
        after_locate=lambda _page: clock.advance(60_000),
    )
    page = FakePage([visual_entry], clock=clock)

    with pytest.raises(DouyinActionFailure, match="^deadline_exceeded$"):
        DouyinActionExecutor(
            now=clock.now,
            control_wait_ms=0,
            visual_locator=visual,
        ).execute(page, action_request(kind="direct_message"))

    assert visual.calls == ["direct_message_entry"]
    assert page.clicks == []


def test_visual_entry_rebind_navigation_fails_before_click():
    visual_entry = dm_entry(selectors=set())
    visual = FakeVisualLocator(
        {"direct_message_entry": visual_entry},
        after_locate=lambda page: setattr(
            page,
            "url",
            "https://www.douyin.com/user/different-actor",
        ),
    )
    page = FakePage([visual_entry])

    with pytest.raises(DouyinActionFailure, match="^action_rejected$"):
        DouyinActionExecutor(
            now=lambda: NOW,
            control_wait_ms=0,
            visual_locator=visual,
        ).execute(page, action_request(kind="direct_message"))

    assert visual.calls == ["direct_message_entry"]
    assert page.clicks == []


def test_visual_entry_rebind_risk_transition_fails_before_click():
    visual_entry = dm_entry(selectors=set())
    risk = FakeElement(
        name="risk",
        selectors={'text="当前操作存在风险"'},
        visible=False,
    )
    visual = FakeVisualLocator(
        {"direct_message_entry": visual_entry},
        after_locate=lambda _page: setattr(risk, "visible", True),
    )
    page = FakePage([visual_entry, risk])

    with pytest.raises(DouyinActionFailure, match="^douyin_account_warning$"):
        DouyinActionExecutor(
            now=lambda: NOW,
            control_wait_ms=0,
            visual_locator=visual,
        ).execute(page, action_request(kind="direct_message"))

    assert visual.calls == ["direct_message_entry"]
    assert page.clicks == []


def test_direct_message_keeps_dom_primary_when_controls_exist():
    visual = FakeVisualLocator()
    page = FakePage([dm_entry(), dm_composer(), dm_submit(), message_item()])

    receipt = DouyinActionExecutor(
        now=lambda: NOW,
        visual_locator=visual,
    ).execute(page, action_request(kind="direct_message"))

    assert receipt.platform_receipt_reference == "douyin-message:message-123"
    assert visual.calls == []


def test_direct_message_content_mismatch_never_uses_visual_submit():
    visual_submit = dm_submit(selectors=set())
    visual = FakeVisualLocator({"direct_message_submit": visual_submit})
    page = FakePage([
        dm_entry(),
        dm_composer(readback="非批准内容"),
        visual_submit,
    ])

    with pytest.raises(
        DouyinActionFailure,
        match="^douyin_action_content_mismatch$",
    ):
        DouyinActionExecutor(
            now=lambda: NOW,
            control_wait_ms=0,
            visual_locator=visual,
        ).execute(page, action_request(kind="direct_message"))

    assert visual.calls == []
    assert page.clicks == ["dm-entry", "dm-composer"]


def test_direct_message_entry_ambiguity_never_uses_visual_locator():
    visual = FakeVisualLocator()
    page = FakePage([
        dm_entry("dm-entry-1"),
        dm_entry("dm-entry-2"),
        dm_composer(),
        dm_submit(),
    ])

    with pytest.raises(
        DouyinActionFailure,
        match="^douyin_action_control_ambiguous$",
    ):
        DouyinActionExecutor(
            now=lambda: NOW,
            visual_locator=visual,
        ).execute(page, action_request(kind="direct_message"))

    assert visual.calls == []


def test_direct_message_risk_failure_never_uses_visual_locator():
    visual = FakeVisualLocator()
    page = FakePage([
        FakeElement(
            name="risk",
            selectors={'text="当前操作存在风险"'},
        ),
    ])

    with pytest.raises(
        DouyinActionFailure,
        match="^douyin_account_warning$",
    ):
        DouyinActionExecutor(
            now=lambda: NOW,
            visual_locator=visual,
        ).execute(page, action_request(kind="direct_message"))

    assert visual.calls == []


def test_direct_message_missing_composer_never_uses_visual_locator():
    visual = FakeVisualLocator()
    page = FakePage([dm_entry()])

    with pytest.raises(
        DouyinActionFailure,
        match="^douyin_action_control_missing$",
    ):
        DouyinActionExecutor(
            now=lambda: NOW,
            control_wait_ms=0,
            visual_locator=visual,
        ).execute(page, action_request(kind="direct_message"))

    assert visual.calls == []


def test_read_only_reconciliation_accepts_only_unique_outgoing_dm_receipt_without_submit():
    page = FakePage([
        dm_entry(),
        message_item(visible_after_submit=False, attributes={
            "data-message-id": "message-123",
            "data-direction": "outgoing",
            "data-created-at": NOW.isoformat(),
        }),
    ])

    receipt = DouyinActionReconciler(now=lambda: NOW).reconcile(
        page,
        reconciliation_request(kind="direct_message"),
    )

    assert receipt.platform_receipt_reference == "douyin-message:message-123"
    assert page.clicks == ["dm-entry"]
    assert page.fills == []
    assert page.native_types == []
    assert ".e2e-send-msg-btn" not in page.locator_queries


def test_read_only_reconciliation_may_visually_open_panel_but_never_locates_submit():
    visual_entry = dm_entry(selectors=set())
    visual = FakeVisualLocator({"direct_message_entry": visual_entry})
    page = FakePage([
        visual_entry,
        message_item(visible_after_submit=False, attributes={
            "data-message-id": "message-visual-reconcile",
            "data-direction": "outgoing",
            "data-created-at": NOW.isoformat(),
        }),
    ])

    receipt = DouyinActionReconciler(
        now=lambda: NOW,
        visual_locator=visual,
    ).reconcile(page, reconciliation_request(kind="direct_message"))

    assert receipt.platform_receipt_reference == (
        "douyin-message:message-visual-reconcile"
    )
    assert visual.calls == ["direct_message_entry"]
    assert page.clicks == ["dm-entry"]
    assert page.native_types == []
    assert ".e2e-send-msg-btn" not in page.locator_queries


def test_read_only_reconciliation_rejects_inbound_same_text_without_submit():
    page = FakePage([
        dm_entry(),
        message_item(
            visible_after_submit=False,
            attributes={
                "data-message-id": "message-inbound",
                "data-direction": "incoming",
                "data-created-at": NOW.isoformat(),
            },
        ),
    ])

    with pytest.raises(
        DouyinActionFailure,
        match="^douyin_action_receipt_ambiguous$",
    ):
        DouyinActionReconciler(now=lambda: NOW).reconcile(
            page,
            reconciliation_request(kind="direct_message"),
        )

    assert page.clicks == ["dm-entry"]
    assert page.native_types == []


def test_read_only_reconciliation_rejects_same_text_from_wrong_recipient():
    page = FakePage([
        dm_entry(),
        message_item(
            visible_after_submit=False,
            conversation_recipient_markers=[{
                "href": "/user/MS4wLjABDifferentRecipient",
                "secUid": None,
            }],
            attributes={
                "data-message-id": "message-wrong-recipient",
                "data-direction": "outgoing",
                "data-created-at": NOW.isoformat(),
            },
        ),
    ])

    with pytest.raises(
        DouyinActionFailure,
        match="^douyin_action_receipt_ambiguous$",
    ):
        DouyinActionReconciler(now=lambda: NOW).reconcile(
            page,
            reconciliation_request(kind="direct_message"),
        )

    assert page.clicks == ["dm-entry"]
    assert page.native_types == []


def test_direct_message_rejects_a_receipt_from_the_wrong_recipient():
    page = FakePage([
        dm_entry(),
        dm_composer(),
        dm_submit(),
        message_item(conversation_recipient_markers=[{
            "href": "/user/MS4wLjABDifferentRecipient",
            "secUid": None,
        }]),
    ])

    with pytest.raises(
        DouyinActionFailure,
        match="^douyin_action_receipt_ambiguous$",
    ):
        DouyinActionExecutor(
            now=lambda: NOW,
            receipt_attempts=1,
        ).execute(page, action_request(kind="direct_message"))

    assert page.clicks == ["dm-entry", "dm-composer", "dm-submit"]


def test_real_direct_message_never_accepts_same_text_inbound_as_a_send_receipt():
    page = FakePage([
        dm_entry(),
        dm_composer(),
        dm_submit(),
        message_item(attributes={
            "data-message-id": "message-inbound",
            "data-direction": "incoming",
        }),
    ])

    with pytest.raises(DouyinActionFailure, match="^douyin_action_timeout$"):
        DouyinActionExecutor(
            now=lambda: NOW,
            receipt_attempts=1,
        ).execute(page, action_request(kind="direct_message"))


def test_real_direct_message_requires_a_stable_outgoing_platform_message_id():
    page = FakePage([
        dm_entry(), dm_composer(), dm_submit(),
        message_item(attributes={"data-direction": "outgoing"}),
    ])

    with pytest.raises(
        DouyinActionFailure,
        match="^douyin_action_receipt_ambiguous$",
    ):
        DouyinActionExecutor(now=lambda: NOW).execute(
            page,
            action_request(kind="direct_message"),
        )


def test_direct_message_never_accepts_fixture_receipt_without_outgoing_message():
    fixture_receipt = FakeElement(
        name="fixture-receipt",
        selectors={'[data-e2e-receipt-id]'},
        attributes={"data-e2e-receipt-id": "safe-receipt-123"},
        visible_after_submit=True,
    )
    page = FakePage([
        dm_entry(), dm_composer(), dm_submit(), fixture_receipt,
    ])

    with pytest.raises(DouyinActionFailure, match="^douyin_action_timeout$"):
        DouyinActionExecutor(
            now=lambda: NOW,
            receipt_attempts=1,
        ).execute(page, action_request(kind="direct_message"))

    assert page.clicks == ["dm-entry", "dm-composer", "dm-submit"]


def test_direct_message_route_transition_without_frozen_actor_binding_fails_closed():
    page = FakePage([
        dm_entry(navigate_to="https://www.douyin.com/messages"),
        dm_composer(), dm_submit(), message_item(),
    ])

    with pytest.raises(DouyinActionFailure, match="^action_rejected$"):
        DouyinActionExecutor(now=lambda: NOW).execute(
            page,
            action_request(kind="direct_message"),
        )

    assert page.clicks == ["dm-entry"]
    assert page.native_types == []


@pytest.mark.parametrize("redirect_url", [
    "https://passport.douyin.com/not-a-login",
    "http://passport.douyin.com/login",
])
def test_non_allowlisted_passport_like_redirect_is_not_classified_as_login(
    redirect_url,
):
    page = FakePage([], redirect_url=redirect_url)

    with pytest.raises(DouyinActionFailure, match="^action_rejected$"):
        DouyinActionExecutor(now=lambda: NOW, headless=True).execute(
            page,
            action_request(),
        )


def test_real_direct_message_fails_closed_when_profile_entry_is_ambiguous():
    page = FakePage([
        dm_entry("dm-entry-1"),
        dm_entry("dm-entry-2"),
        dm_composer(),
        dm_submit(),
    ])

    with pytest.raises(
        DouyinActionFailure,
        match="^douyin_action_control_ambiguous$",
    ):
        DouyinActionExecutor(now=lambda: NOW).execute(
            page,
            action_request(kind="direct_message"),
        )

    assert page.clicks == []
    assert page.native_types == []


def test_real_direct_message_fails_closed_when_distinct_entry_selectors_both_match():
    page = FakePage([
        dm_entry("dm-entry-long"),
        dm_entry(
            "dm-entry-short",
            selectors={'button:has-text("\u79c1\u4fe1")'},
            accessible_name="\u79c1\u4fe1",
            text="\u79c1\u4fe1",
        ),
        dm_composer(),
        dm_submit(),
        message_item(),
    ])

    with pytest.raises(
        DouyinActionFailure,
        match="^douyin_action_control_ambiguous$",
    ):
        DouyinActionExecutor(now=lambda: NOW).execute(
            page,
            action_request(kind="direct_message"),
        )

    assert page.clicks == []
    assert page.native_types == []


@pytest.mark.parametrize(("elements", "page_title", "redirect_url", "code"), [
    ([FakeElement(name="captcha-image", selectors={"#captcha-verify-image"})],
     "抖音", None, "douyin_verification_required"),
    ([FakeElement(name="captcha-container", selectors={"#captcha_container"})],
     "抖音", None, "douyin_verification_required"),
    ([], "验证码中间页 - 抖音", None, "douyin_verification_required"),
    ([], "抖音", "https://passport.douyin.com/login/", "douyin_login_expired"),
    ([FakeElement(name="rate-limit", selectors={'text="操作频繁，请稍后再试"'})],
     "抖音", None, "douyin_rate_limited"),
])
def test_real_page_failures_are_classified_before_any_editor_or_submit(
    elements,
    page_title,
    redirect_url,
    code,
):
    page = FakePage(
        [*elements, composer(), submit()],
        page_title=page_title,
        redirect_url=redirect_url,
    )

    with pytest.raises(DouyinActionFailure, match=f"^{code}$"):
        DouyinActionExecutor(now=lambda: NOW, headless=True).execute(
            page,
            action_request(),
        )

    assert page.fills == []
    assert page.native_types == []
    assert page.clicks == []


def composer(**changes: object) -> FakeElement:
    values: dict[str, object] = {
        "name": "composer-1",
        "selectors": {COMMENT_COMPOSER},
        "editable": True,
        "attributes": {"contenteditable": "true", "aria-label": "留下你的评论"},
    }
    values.update(changes)
    return FakeElement(**values)


def submit(name: str = "submit-1", **changes: object) -> FakeElement:
    values: dict[str, object] = {
        "name": name,
        "selectors": {COMMENT_SUBMIT},
        "role": "button",
        "accessible_name": "发送",
        "text": "发送",
        "action": "submit",
    }
    values.update(changes)
    return FakeElement(**values)


def comment_item(text: str = "冻结的批准文本", **changes: object) -> FakeElement:
    values: dict[str, object] = {
        "name": "comment-1",
        "text": text,
        "attributes": {
            "data-comment-id": "comment-123",
            "data-owner": "self",
        },
        "visible_after_submit": True,
        "comment_item": True,
    }
    values.update(changes)
    return FakeElement(**values)


def independent_video_composer(**changes: object) -> FakeElement:
    values: dict[str, object] = {
        "name": "independent-video-composer",
        "selectors": {INDEPENDENT_VIDEO_COMPOSER},
        "editable": True,
        "attributes": {"contenteditable": "true"},
    }
    values.update(changes)
    return FakeElement(**values)


def independent_video_submit(**changes: object) -> FakeElement:
    values: dict[str, object] = {
        "name": "independent-video-submit",
        "selectors": {INDEPENDENT_VIDEO_SUBMIT},
        "text": "发布",
        "action": "submit",
    }
    values.update(changes)
    return FakeElement(**values)


def independent_video_comment(**changes: object) -> FakeElement:
    values: dict[str, object] = {
        "name": "independent-video-comment",
        "selectors": {'[data-e2e="comment-item"]'},
        "text": "冻结的批准文本",
        "attributes": {"data-owner": "self"},
        "tooltip_id": "tooltip_comment-789",
        "visible_after_submit": True,
        "comment_item": True,
    }
    values.update(changes)
    return FakeElement(**values)


def official_comment_response(
    *,
    request_text: str = "冻结的批准文本",
    response_text: str = "冻结的批准文本",
    request_aweme_id: str = "7350000000000000001",
    response_aweme_id: str = "7350000000000000001",
    cid: str = "official-comment-789",
    user: object = None,
) -> FakeResponse:
    return FakeResponse(
        url="https://www.douyin.com/aweme/v1/web/comment/publish/",
        post_data=urlencode({
            "text": request_text,
            "aweme_id": request_aweme_id,
            "is_self_see": "0",
        }),
        payload={
            "status_code": 0,
            "comment": {
                "cid": cid,
                "text": response_text,
                "aweme_id": response_aweme_id,
                "user": {"sec_uid": "MS4wLjABCurrentAccount"}
                if user is None else user,
            },
        },
    )


def test_real_page_binds_comment_to_exact_official_publish_response():
    page = ResponseCapturingPage(
        [independent_video_composer(), independent_video_submit()],
        response=official_comment_response(),
    )

    receipt = DouyinActionExecutor(now=lambda: NOW).execute(
        page,
        action_request(),
    )

    assert receipt.platform_receipt_reference == (
        "douyin-comment:official-comment-789"
    )
    assert page.clicks == [
        "independent-video-composer",
        "independent-video-submit",
    ]
    assert page.response_wait_timeouts == [5_000]


def test_missing_publish_response_after_completed_click_uses_dom_receipt_proof():
    unrelated_response = FakeResponse(
        url="https://www.douyin.com/aweme/v1/web/other",
        post_data=None,
        payload={"status_code": 0},
    )
    page = ResponseCapturingPage(
        [
            independent_video_composer(),
            independent_video_submit(),
            independent_video_comment(),
        ],
        response=unrelated_response,
    )

    receipt = DouyinActionExecutor(now=lambda: NOW).execute(
        page,
        action_request(),
    )

    assert receipt.platform_receipt_reference == (
        "douyin-comment:comment-789"
    )
    assert page.clicks == [
        "independent-video-composer",
        "independent-video-submit",
    ]
    assert page.response_wait_timeouts == [5_000]


@pytest.mark.parametrize("response", [
    official_comment_response(request_text="非批准文本"),
    official_comment_response(response_text="非批准文本"),
    official_comment_response(request_aweme_id="7350000000000000002"),
    official_comment_response(response_aweme_id="7350000000000000002"),
    official_comment_response(cid="bad id with spaces"),
    official_comment_response(user={}),
    official_comment_response(user={"uid": "123456789"}),
    official_comment_response(user={
        "sec_uid": "MS4wLjABDifferentAccount",
    }),
])
def test_official_publish_response_must_bind_exact_content_video_id_and_author(
    response,
):
    page = ResponseCapturingPage(
        [independent_video_composer(), independent_video_submit()],
        response=response,
    )

    with pytest.raises(
        DouyinActionFailure,
        match="^douyin_action_receipt_ambiguous$",
    ):
        DouyinActionExecutor(now=lambda: NOW).execute(
            page,
            action_request(),
        )

    assert page.clicks == [
        "independent-video-composer",
        "independent-video-submit",
    ]


def test_independent_video_dom_types_draftjs_content_natively_and_binds_owned_comment():
    page = FakePage([
        independent_video_composer(),
        independent_video_submit(),
        independent_video_comment(),
    ])

    receipt = DouyinActionExecutor(now=lambda: NOW).execute(
        page,
        action_request(),
    )

    assert page.fills == []
    assert page.clicks == [
        "independent-video-composer",
        "independent-video-submit",
    ]
    assert page.browser_keys == ["ControlOrMeta+A", "Backspace"]
    assert page.native_types == [
        ("independent-video-composer", "冻结的批准文本"),
    ]
    assert any('[data-e2e="comment-item"]' in query
               for query in page.locator_queries)
    assert receipt.platform_receipt_reference == "douyin-comment:comment-789"


def test_max_length_comment_uses_a_length_aware_timeout_within_the_deadline():
    content = "评" * 300
    page = FakePage([
        independent_video_composer(),
        independent_video_submit(),
        independent_video_comment(text=content),
    ])

    receipt = DouyinActionExecutor(now=lambda: NOW).execute(
        page,
        action_request(content),
    )

    assert receipt.platform_receipt_reference == "douyin-comment:comment-789"
    assert page.native_type_options == [{"delay": 10, "timeout": 4_000}]


def test_delayed_independent_video_controls_mount_before_the_bounded_deadline():
    clock = FakeClock()
    editor = independent_video_composer(visible=False)
    post = independent_video_submit(visible=False)
    page = FakePage(
        [editor, post, independent_video_comment()],
        clock=clock,
        after_wait=lambda _page: (
            setattr(editor, "visible", True),
            setattr(post, "visible", True),
        ),
    )

    receipt = DouyinActionExecutor(
        now=clock.now,
        control_wait_ms=10,
        control_poll_ms=1,
    ).execute(page, action_request())

    assert page.waits == [1]
    assert receipt.platform_receipt_reference == "douyin-comment:comment-789"
    assert page.clicks == [
        "independent-video-composer",
        "independent-video-submit",
    ]


def test_delayed_control_wait_rechecks_page_risk_before_typing():
    editor = independent_video_composer(visible=False)
    post = independent_video_submit(visible=False)
    verification = FakeElement(
        name="verification",
        selectors={'[data-e2e="verification"]'},
        visible=False,
    )
    page = FakePage(
        [editor, post, verification],
        after_wait=lambda _page: (
            setattr(editor, "visible", True),
            setattr(post, "visible", True),
            setattr(verification, "visible", True),
        ),
    )

    with pytest.raises(
        DouyinActionFailure,
        match="^douyin_verification_required$",
    ):
        DouyinActionExecutor(
            now=lambda: NOW,
            headless=True,
            control_wait_ms=10,
            control_poll_ms=1,
        ).execute(page, action_request())

    assert page.native_types == []
    assert page.clicks == []


def test_delayed_control_wait_rechecks_exact_url_before_typing():
    editor = independent_video_composer(visible=False)
    post = independent_video_submit(visible=False)
    page = FakePage(
        [editor, post],
        after_wait=lambda value: (
            setattr(editor, "visible", True),
            setattr(post, "visible", True),
            setattr(
                value,
                "url",
                "https://www.douyin.com/video/7350000000000000002",
            ),
        ),
    )

    with pytest.raises(DouyinActionFailure, match="^action_rejected$"):
        DouyinActionExecutor(
            now=lambda: NOW,
            control_wait_ms=10,
            control_poll_ms=1,
        ).execute(page, action_request())

    assert page.native_types == []
    assert page.clicks == []


def test_delayed_control_wait_stops_at_action_deadline_before_typing():
    clock = FakeClock()
    page = FakePage([], clock=clock)

    with pytest.raises(DouyinActionFailure, match="^deadline_exceeded$"):
        DouyinActionExecutor(
            now=clock.now,
            control_wait_ms=10,
            control_poll_ms=1,
        ).execute(page, action_request().model_copy(update={
            "deadline_at": clock.now() + timedelta(milliseconds=1),
        }))

    assert page.waits == [1]
    assert page.native_types == []
    assert page.clicks == []


def test_real_comment_structure_submits_exact_text_once_and_returns_bound_receipt():
    page = FakePage([composer(), submit(), comment_item()])

    receipt = DouyinActionExecutor(now=lambda: NOW).execute(page, action_request())

    assert page.urls == ["https://www.douyin.com/video/7350000000000000001"]
    assert page.fills == []
    assert page.clicks == ["composer-1", "submit-1"]
    assert page.browser_keys == ["ControlOrMeta+A", "Backspace"]
    assert page.native_types == [("composer-1", "冻结的批准文本")]
    assert page.role_queries == [("button", "发送", True)]
    assert '[data-e2e="comment-input"]' not in page.locator_queries
    assert '[data-e2e="comment-submit"]' not in page.locator_queries
    assert '[data-e2e-receipt-id]' not in page.locator_queries
    assert receipt.platform_receipt_reference == "douyin-comment:comment-123"


def test_real_comment_fails_closed_when_distinct_composer_selectors_both_match():
    page = FakePage([
        composer(),
        composer(
            name="composer-2",
            selectors={'[contenteditable="true"][data-placeholder*="\u8bc4\u8bba"]'},
            attributes={"contenteditable": "true", "data-placeholder": "\u5199\u4e0b\u8bc4\u8bba"},
        ),
        submit(),
        comment_item(),
    ])

    with pytest.raises(
        DouyinActionFailure,
        match="^douyin_action_control_ambiguous$",
    ):
        DouyinActionExecutor(now=lambda: NOW).execute(page, action_request())

    assert page.fills == []
    assert page.clicks == []


def test_read_only_reconciliation_requires_unique_self_owned_comment_platform_id():
    owned = comment_item(
        visible_after_submit=False,
        attributes={
            "data-comment-id": "comment-123",
            "data-owner": "self",
            "data-created-at": NOW.isoformat(),
        },
    )
    page = FakePage([owned])

    assert find_existing_outgoing_receipt(
        page,
        reconciliation_request(),
    ) == "douyin-comment:comment-123"
    receipt = DouyinActionReconciler(now=lambda: NOW).reconcile(
        page,
        reconciliation_request(),
    )

    assert receipt.platform_receipt_reference == "douyin-comment:comment-123"
    assert page.clicks == []
    assert page.fills == []


def test_read_only_reconciliation_rejects_unowned_or_unidentified_comment():
    page = FakePage([
        comment_item(
            visible_after_submit=False,
            attributes={"data-comment-id": "comment-123"},
        ),
    ])

    with pytest.raises(
        DouyinActionFailure,
        match="^douyin_action_receipt_ambiguous$",
    ):
        DouyinActionReconciler(now=lambda: NOW).reconcile(
            page,
            reconciliation_request(),
        )

    assert page.clicks == []


def test_read_only_reconciliation_rejects_self_owned_same_text_from_before_attempt():
    page = FakePage([comment_item(
        visible_after_submit=False,
        attributes={
            "data-comment-id": "comment-old",
            "data-owner": "self",
            "data-created-at": (NOW - timedelta(minutes=5)).isoformat(),
        },
    )])

    with pytest.raises(
        DouyinActionFailure,
        match="^douyin_action_receipt_ambiguous$",
    ):
        DouyinActionReconciler(now=lambda: NOW).reconcile(
            page,
            reconciliation_request(not_before=NOW),
        )

    assert page.clicks == []


def test_distinct_native_and_role_send_buttons_fail_closed_as_ambiguous():
    role_submit = submit(
        "submit-role",
        selectors={'[role="button"]:has-text("发送")'},
    )
    page = FakePage([composer(), submit(), role_submit, comment_item()])

    with pytest.raises(
        DouyinActionFailure,
        match="^douyin_action_control_ambiguous$",
    ):
        DouyinActionExecutor(now=lambda: NOW).execute(page, action_request())

    assert page.clicks == ["composer-1"]


@pytest.mark.parametrize(("elements", "code", "expected_clicks"), [
    ([composer(), composer(name="composer-2"), submit()],
     "douyin_action_control_ambiguous", []),
    ([composer(), submit(), submit("submit-2")],
     "douyin_action_control_ambiguous", ["composer-1"]),
    ([composer(visible=False), submit()], "douyin_action_control_missing", []),
    ([composer(), submit(visible=False)],
     "douyin_action_control_missing", ["composer-1"]),
    ([composer(editable=False), submit()], "douyin_action_control_missing", []),
    ([composer(), submit(enabled=False)],
     "douyin_action_control_missing", ["composer-1"]),
    ([composer(), submit(accessible_name="发送评论", text="发送评论",
                             selectors={'[role="button"]:has-text("发送")'})],
     "douyin_action_control_missing", ["composer-1"]),
])
def test_non_unique_hidden_or_unusable_controls_never_click_submit(
    elements, code, expected_clicks,
):
    page = FakePage(elements)

    with pytest.raises(DouyinActionFailure, match=f"^{code}$"):
        DouyinActionExecutor(now=lambda: NOW).execute(page, action_request())

    assert page.clicks == expected_clicks
    assert not any(name.startswith("submit") for name in page.clicks)


def test_hidden_and_visible_same_priority_controls_are_ambiguous_before_click():
    page = FakePage([
        composer(name="hidden-composer", visible=False),
        composer(name="visible-composer"),
        submit(),
        comment_item(),
    ])

    with pytest.raises(DouyinActionFailure, match="^douyin_action_control_ambiguous$"):
        DouyinActionExecutor(now=lambda: NOW).execute(page, action_request())

    assert page.clicks == []


def test_hidden_real_control_does_not_fall_through_to_fixture_control():
    page = FakePage([
        composer(visible=False),
        FakeElement(
            name="fixture-composer",
            selectors={'[data-e2e="comment-input"]'},
            editable=True,
        ),
        submit(),
        comment_item(),
    ])

    with pytest.raises(DouyinActionFailure, match="^douyin_action_control_missing$"):
        DouyinActionExecutor(now=lambda: NOW).execute(page, action_request())

    assert page.clicks == []


def test_composer_readback_mismatch_fails_before_click_without_leaking_text():
    page = FakePage([composer(readback="不是批准文本"), submit()])

    with pytest.raises(DouyinActionFailure) as caught:
        DouyinActionExecutor(now=lambda: NOW).execute(page, action_request())

    assert str(caught.value) == "douyin_action_content_mismatch"
    assert "冻结的批准文本" not in str(caught.value)
    assert page.clicks == ["composer-1"]


def test_non_exact_receipt_text_is_not_accepted_and_does_not_click():
    page = FakePage([comment_item(text="前缀冻结的批准文本后缀", visible_after_submit=False)])

    assert find_visible_receipt(page, action_request(), ReceiptBaseline()) is None
    assert page.clicks == []


def test_playwright_normalized_whitespace_match_is_not_a_byte_exact_receipt():
    content = "冻结 的批准文本"
    page = FakePage([comment_item(
        text="冻结\n的批准文本",
        visible_after_submit=False,
    )])

    assert find_visible_receipt(
        page, action_request(content), ReceiptBaseline(),
    ) is None
    assert page.clicks == []


def test_multiple_exact_receipts_fail_ambiguous_without_click():
    page = FakePage([
        comment_item(visible_after_submit=False),
        comment_item(visible_after_submit=False, name="comment-2",
                     attributes={"data-comment-id": "comment-456"}),
    ])

    with pytest.raises(ActionControlsFailure, match="^douyin_action_receipt_ambiguous$"):
        find_visible_receipt(page, action_request(), ReceiptBaseline())

    assert page.clicks == []


def test_unique_exact_receipt_is_accepted_among_unrelated_comment_items():
    page = FakePage([
        comment_item(text="其他评论", visible_after_submit=False),
        comment_item(visible_after_submit=False, name="comment-2",
                     attributes={"data-cid": "comment-456",
                                 "data-owner": "self"}),
    ])

    assert find_visible_receipt(
        page, action_request(), ReceiptBaseline(),
    ) == "douyin-comment:comment-456"
    assert page.clicks == []


def test_exact_text_descendant_is_accepted_inside_a_comment_item_with_metadata():
    page = FakePage([comment_item(
        text="Buyer冻结的批准文本1分钟前",
        exact_texts={"冻结的批准文本"},
        visible_after_submit=False,
    )])

    assert find_visible_receipt(
        page, action_request(), ReceiptBaseline(),
    ) == "douyin-comment:comment-123"
    assert page.clicks == []


def test_editor_with_exact_text_is_not_accepted_as_a_receipt():
    page = FakePage([comment_item(
        visible_after_submit=False,
        attributes={"contenteditable": "true", "data-comment-id": "editor-1"},
    )])

    assert find_visible_receipt(page, action_request(), ReceiptBaseline()) is None
    assert page.clicks == []


def test_comment_item_containing_an_editor_is_not_accepted_as_a_receipt():
    page = FakePage([comment_item(
        exact_texts={"冻结的批准文本"},
        visible_after_submit=False,
        contains_editor=True,
    )])

    assert find_visible_receipt(page, action_request(), ReceiptBaseline()) is None
    assert page.clicks == []


@pytest.mark.parametrize("changes", [
    {"attributes": {"contenteditable": "", "data-comment-id": "editor-empty"}},
    {"attributes": {"contenteditable": "plaintext-only",
                    "data-comment-id": "editor-plaintext"}},
    {"attributes": {"role": "textbox", "data-comment-id": "editor-role"}},
    {"tag_name": "textarea"},
    {"tag_name": "input"},
    {"editable": True},
    {"descendant_editors": {"textarea"}, "exact_texts": {"冻结的批准文本"}},
    {"descendant_editors": {"input"}, "exact_texts": {"冻结的批准文本"}},
    {"descendant_editors": {"contenteditable-empty"},
     "exact_texts": {"冻结的批准文本"}},
    {"descendant_editors": {"textbox"}, "exact_texts": {"冻结的批准文本"}},
])
def test_all_editor_variants_are_excluded_from_receipts(changes):
    page = FakePage([comment_item(visible_after_submit=False, **changes)])

    assert find_visible_receipt(page, action_request(), ReceiptBaseline()) is None
    assert page.clicks == []


def test_receipt_attribute_read_error_fails_ambiguous_without_click():
    page = FakePage([comment_item(
        visible_after_submit=False,
        attribute_errors={"data-comment-id"},
    )])

    with pytest.raises(ActionControlsFailure,
                       match="^douyin_action_receipt_ambiguous$"):
        find_visible_receipt(page, action_request(), ReceiptBaseline())

    assert page.clicks == []


def test_detached_receipt_during_reference_revalidation_fails_without_click():
    page = FakePage([comment_item(
        text="作者冻结的批准文本刚刚",
        exact_texts={"冻结的批准文本"},
        visible_after_submit=False,
        visibility_error_after=1,
    )])

    with pytest.raises(ActionControlsFailure,
                       match="^douyin_action_receipt_ambiguous$"):
        find_visible_receipt(page, action_request(), ReceiptBaseline())

    assert page.clicks == []


def test_unique_exact_receipt_without_platform_id_is_not_success_proof():
    page = FakePage([comment_item(visible_after_submit=False, attributes={})])

    assert find_visible_receipt(
        page, action_request(), ReceiptBaseline(),
    ) is None
    assert page.clicks == []


@pytest.mark.parametrize("attributes", [
    {"data-comment-id": "comment-123"},
    {},
])
def test_preexisting_identical_comment_cannot_prove_submission_success_or_reclick(
    attributes,
):
    page = FakePage([
        composer(), submit(),
        comment_item(visible_after_submit=False, attributes=attributes),
    ])

    with pytest.raises(DouyinActionFailure, match="^douyin_action_timeout$"):
        DouyinActionExecutor(
            now=lambda: NOW, receipt_attempts=2, receipt_poll_ms=1,
        ).execute(page, action_request())

    assert page.clicks == ["composer-1", "submit-1"]


def test_new_unidentified_comment_never_unlocks_the_successor():
    page = FakePage([
        composer(), submit(), comment_item(attributes={}),
    ])

    with pytest.raises(DouyinActionFailure, match="^douyin_action_timeout$"):
        DouyinActionExecutor(
            now=lambda: NOW,
            receipt_attempts=1,
        ).execute(page, action_request())

    assert page.clicks == ["composer-1", "submit-1"]


@pytest.mark.parametrize("ownership", [{}, {"data-owner": "other"}])
def test_new_same_text_comment_without_self_ownership_never_proves_our_write(
    ownership,
):
    page = FakePage([
        composer(),
        submit(),
        comment_item(attributes={
            "data-comment-id": "racing-comment-456",
            **ownership,
        }),
    ])

    with pytest.raises(DouyinActionFailure, match="^douyin_action_timeout$"):
        DouyinActionExecutor(
            now=lambda: NOW,
            receipt_attempts=1,
        ).execute(page, action_request())

    assert page.clicks == ["composer-1", "submit-1"]


def test_video_author_marker_does_not_prove_the_comment_is_ours():
    page = FakePage([comment_item(
        visible_after_submit=False,
        attributes={
            "data-comment-id": "video-author-comment",
            "data-is-author": "true",
        },
    )])

    assert find_visible_receipt(
        page, action_request(), ReceiptBaseline(),
    ) is None


def test_new_platform_id_is_bound_when_an_identical_old_comment_preexists():
    page = FakePage([
        composer(), submit(),
        comment_item(visible_after_submit=False),
        comment_item(
            name="comment-new",
            attributes={
                "data-comment-id": "comment-456",
                "data-owner": "self",
            },
        ),
    ])

    receipt = DouyinActionExecutor(now=lambda: NOW).execute(page, action_request())

    assert receipt.platform_receipt_reference == "douyin-comment:comment-456"
    assert page.clicks == ["composer-1", "submit-1"]


@pytest.mark.parametrize("changes", [
    {"attribute_errors": {"data-comment-id"}},
    {"text": "作者冻结的批准文本刚刚",
     "exact_texts": {"冻结的批准文本"}, "visibility_error_after": 2},
])
def test_post_submit_receipt_error_never_retries_the_submit_click(changes):
    page = FakePage([
        composer(), submit(), comment_item(**changes),
    ])

    with pytest.raises(DouyinActionFailure,
                       match="^douyin_action_receipt_ambiguous$"):
        DouyinActionExecutor(now=lambda: NOW).execute(page, action_request())

    assert page.clicks == ["composer-1", "submit-1"]


def test_submit_click_exception_after_possible_dispatch_is_ambiguous_and_never_retried():
    page = FakePage([
        composer(), submit(click_error_after_dispatch=True), comment_item(),
    ])

    with pytest.raises(DouyinActionFailure,
                       match="^douyin_action_receipt_ambiguous$"):
        DouyinActionExecutor(now=lambda: NOW).execute(page, action_request())

    assert page.clicks == ["composer-1", "submit-1"]


def test_redirected_wrong_video_id_is_rejected_before_fill_or_click():
    page = FakePage(
        [composer(), submit(), comment_item()],
        redirect_url="https://www.douyin.com/video/7350000000000000002",
    )

    with pytest.raises(DouyinActionFailure, match="^action_rejected$"):
        DouyinActionExecutor(now=lambda: NOW).execute(page, action_request())

    assert page.fills == []
    assert page.clicks == []


def test_userinfo_target_is_rejected_before_navigation_or_click():
    value = action_request().model_copy(update={
        "target_public_url": (
            "https://user@www.douyin.com/video/7350000000000000001"
        ),
    })
    page = FakePage([composer(), submit(), comment_item()])

    with pytest.raises(DouyinActionFailure, match="^action_rejected$"):
        DouyinActionExecutor(now=lambda: NOW).execute(page, value)

    assert page.urls == []
    assert page.clicks == []
