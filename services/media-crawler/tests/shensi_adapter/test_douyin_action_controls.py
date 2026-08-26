from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
import hashlib
import json

import pytest

from shensi_adapter.douyin_action_controls import (
    ActionControlsFailure,
    ReceiptBaseline,
    find_existing_outgoing_receipt,
    find_visible_receipt,
)
from shensi_adapter.douyin_actions import (
    DouyinActionExecutor,
    DouyinActionFailure,
    DouyinActionReconciler,
)
from shensi_adapter.schemas import ActionReconciliationRequest, ActionRequest


NOW = datetime(2026, 8, 25, tzinfo=UTC)
COMMENT_COMPOSER = '[contenteditable="true"][aria-label*="评论"]'
COMMENT_SUBMIT = 'button:has-text("发送")'


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
    message_item: bool = False
    visible_in_message_panel: bool = False
    navigate_to: str | None = None


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
        if element.action == "open_message":
            self.page.message_panel_open = True
            if element.navigate_to is not None:
                self.page.url = element.navigate_to
        elif element.action == "submit":
            self.page.after_submit = True

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

    def evaluate(self, _expression: str, **_kwargs):
        return self._one().tag_name.lower()


class FakePage:
    def __init__(self, elements: list[FakeElement], *, redirect_url: str | None = None,
                 page_title: str = "抖音"):
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
        self.message_panel_open = False
        self.page_title = page_title

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

    def wait_for_timeout(self, _milliseconds: int):
        return None

    def title(self):
        return self.page_title


def action_request(content: str = "冻结的批准文本",
                   kind: str = "comment") -> ActionRequest:
    return ActionRequest(
        action_id=f"action-{kind}",
        account_handle="private-handle",
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
        "attributes": {"data-comment-id": "comment-123"},
        "visible_after_submit": True,
        "comment_item": True,
    }
    values.update(changes)
    return FakeElement(**values)


def test_real_comment_structure_submits_exact_text_once_and_returns_bound_receipt():
    page = FakePage([composer(), submit(), comment_item()])

    receipt = DouyinActionExecutor(now=lambda: NOW).execute(page, action_request())

    assert page.urls == ["https://www.douyin.com/video/7350000000000000001"]
    assert page.fills == [("composer-1", "冻结的批准文本")]
    assert page.clicks == ["submit-1"]
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
        comment_item(visible_after_submit=False),
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

    assert page.clicks == []


@pytest.mark.parametrize(("elements", "code"), [
    ([composer(), composer(name="composer-2"), submit()], "douyin_action_control_ambiguous"),
    ([composer(), submit(), submit("submit-2")], "douyin_action_control_ambiguous"),
    ([composer(visible=False), submit()], "douyin_action_control_missing"),
    ([composer(), submit(visible=False)], "douyin_action_control_missing"),
    ([composer(editable=False), submit()], "douyin_action_control_missing"),
    ([composer(), submit(enabled=False)], "douyin_action_control_missing"),
    ([composer(), submit(accessible_name="发送评论", text="发送评论",
                         selectors={'[role="button"]:has-text("发送")'})],
     "douyin_action_control_missing"),
])
def test_non_unique_hidden_or_unusable_controls_fail_before_click(elements, code):
    page = FakePage(elements)

    with pytest.raises(DouyinActionFailure, match=f"^{code}$"):
        DouyinActionExecutor(now=lambda: NOW).execute(page, action_request())

    assert page.clicks == []


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
    assert page.clicks == []


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
                     attributes={"data-cid": "comment-456"}),
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


def test_unique_exact_receipt_without_platform_id_uses_stable_safe_reference():
    page = FakePage([comment_item(visible_after_submit=False, attributes={})])

    assert find_visible_receipt(page, action_request(), ReceiptBaseline()) == (
        "douyin-visible-comment:"
        "871c223a57c19b0f73e0c90e6ed03ec882b9271ea987292fb6f29a71b3fd8857"
    )
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

    assert page.clicks == ["submit-1"]


def test_new_unidentified_comment_uses_synthetic_receipt_only_after_baseline_absence():
    page = FakePage([
        composer(), submit(), comment_item(attributes={}),
    ])

    receipt = DouyinActionExecutor(now=lambda: NOW).execute(page, action_request())

    assert receipt.platform_receipt_reference.startswith("douyin-visible-comment:")
    assert page.clicks == ["submit-1"]


def test_new_platform_id_is_bound_when_an_identical_old_comment_preexists():
    page = FakePage([
        composer(), submit(),
        comment_item(visible_after_submit=False),
        comment_item(
            name="comment-new",
            attributes={"data-comment-id": "comment-456"},
        ),
    ])

    receipt = DouyinActionExecutor(now=lambda: NOW).execute(page, action_request())

    assert receipt.platform_receipt_reference == "douyin-comment:comment-456"
    assert page.clicks == ["submit-1"]


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

    assert page.clicks == ["submit-1"]


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
