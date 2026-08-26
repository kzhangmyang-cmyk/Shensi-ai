from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
import hashlib
import json

import pytest

from shensi_adapter.douyin_action_controls import (
    ActionControlsFailure,
    find_visible_receipt,
)
from shensi_adapter.douyin_actions import DouyinActionExecutor, DouyinActionFailure
from shensi_adapter.schemas import ActionRequest


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
        return element.visible and (
            not element.visible_after_submit or self.page.after_submit
        )

    def is_enabled(self, **_kwargs):
        return self._one().enabled

    def is_editable(self, **_kwargs):
        return self._one().editable

    def fill(self, value: str, **_kwargs):
        element = self._one()
        self.page.fills.append((element.name, value))
        element.text = value

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
        self.page.after_submit = True

    def get_attribute(self, name: str, **_kwargs):
        return self._one().attributes.get(name)

    def get_by_text(self, text: str, *, exact: bool):
        if exact:
            matches = [
                item for item in self.elements
                if item.text == text or text in item.exact_texts
            ]
        else:
            matches = [item for item in self.elements if text in item.text]
        return FakeLocator(self.page, matches)

    def locator(self, selector: str):
        if selector == '[contenteditable="true"]':
            return FakeLocator(self.page, [
                item for item in self.elements
                if item.contains_editor or item.attributes.get("contenteditable") == "true"
            ])
        return FakeLocator(self.page, [])


class FakePage:
    def __init__(self, elements: list[FakeElement]):
        self.elements = elements
        self.after_submit = False
        self.urls: list[str] = []
        self.fills: list[tuple[str, str]] = []
        self.clicks: list[str] = []
        self.locator_queries: list[str] = []
        self.role_queries: list[tuple[str, str, bool]] = []

    def goto(self, url: str, **_kwargs):
        self.urls.append(url)

    def locator(self, selector: str):
        self.locator_queries.append(selector)
        if "comment-item" in selector or "data-comment-id" in selector or "data-cid" in selector:
            return FakeLocator(self, [item for item in self.elements if item.comment_item])
        return FakeLocator(self, [item for item in self.elements if selector in item.selectors])

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


def action_request(content: str = "冻结的批准文本") -> ActionRequest:
    return ActionRequest(
        action_id="action-comment",
        account_handle="private-handle",
        login_state_version=3,
        kind="comment",
        target_public_url="https://www.douyin.com/video/7350000000000000001",
        content=content,
        deadline_at=NOW + timedelta(minutes=1),
        approved_content_hash="sha256:" + hashlib.sha256(json.dumps(
            {"content": content}, ensure_ascii=False, sort_keys=True,
            separators=(",", ":"),
        ).encode()).hexdigest(),
    )


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


def test_native_send_button_keeps_priority_over_exact_role_button_fallback():
    role_submit = submit(
        "submit-role",
        selectors={'[role="button"]:has-text("发送")'},
    )
    page = FakePage([composer(), submit(), role_submit, comment_item()])

    receipt = DouyinActionExecutor(now=lambda: NOW).execute(page, action_request())

    assert receipt.platform_receipt_reference == "douyin-comment:comment-123"
    assert page.clicks == ["submit-1"]


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


def test_composer_readback_mismatch_fails_before_click_without_leaking_text():
    page = FakePage([composer(readback="不是批准文本"), submit()])

    with pytest.raises(DouyinActionFailure) as caught:
        DouyinActionExecutor(now=lambda: NOW).execute(page, action_request())

    assert str(caught.value) == "douyin_action_content_mismatch"
    assert "冻结的批准文本" not in str(caught.value)
    assert page.clicks == []


def test_non_exact_receipt_text_is_not_accepted_and_does_not_click():
    page = FakePage([comment_item(text="前缀冻结的批准文本后缀", visible_after_submit=False)])

    assert find_visible_receipt(page, action_request()) is None
    assert page.clicks == []


def test_multiple_exact_receipts_fail_ambiguous_without_click():
    page = FakePage([
        comment_item(visible_after_submit=False),
        comment_item(visible_after_submit=False, name="comment-2",
                     attributes={"data-comment-id": "comment-456"}),
    ])

    with pytest.raises(ActionControlsFailure, match="^douyin_action_receipt_ambiguous$"):
        find_visible_receipt(page, action_request())

    assert page.clicks == []


def test_unique_exact_receipt_is_accepted_among_unrelated_comment_items():
    page = FakePage([
        comment_item(text="其他评论", visible_after_submit=False),
        comment_item(visible_after_submit=False, name="comment-2",
                     attributes={"data-cid": "comment-456"}),
    ])

    assert find_visible_receipt(page, action_request()) == "douyin-comment:comment-456"
    assert page.clicks == []


def test_exact_text_descendant_is_accepted_inside_a_comment_item_with_metadata():
    page = FakePage([comment_item(
        text="Buyer冻结的批准文本1分钟前",
        exact_texts={"冻结的批准文本"},
        visible_after_submit=False,
    )])

    assert find_visible_receipt(page, action_request()) == "douyin-comment:comment-123"
    assert page.clicks == []


def test_editor_with_exact_text_is_not_accepted_as_a_receipt():
    page = FakePage([comment_item(
        visible_after_submit=False,
        attributes={"contenteditable": "true", "data-comment-id": "editor-1"},
    )])

    assert find_visible_receipt(page, action_request()) is None
    assert page.clicks == []


def test_comment_item_containing_an_editor_is_not_accepted_as_a_receipt():
    page = FakePage([comment_item(
        exact_texts={"冻结的批准文本"},
        visible_after_submit=False,
        contains_editor=True,
    )])

    assert find_visible_receipt(page, action_request()) is None
    assert page.clicks == []


def test_unique_exact_receipt_without_platform_id_uses_stable_safe_reference():
    page = FakePage([comment_item(visible_after_submit=False, attributes={})])

    assert find_visible_receipt(page, action_request()) == (
        "douyin-visible-comment:"
        "871c223a57c19b0f73e0c90e6ed03ec882b9271ea987292fb6f29a71b3fd8857"
    )
    assert page.clicks == []
