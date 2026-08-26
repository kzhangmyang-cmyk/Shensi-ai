"""Bounded, fail-closed locators for one approved Douyin browser action."""

from __future__ import annotations

import hashlib
import re
from datetime import UTC, datetime
from dataclasses import dataclass
from typing import NamedTuple

from .schemas import ActionReconciliationRequest, ActionRequest


COMMENT_COMPOSERS = (
    '[contenteditable="true"][aria-label*="评论"]',
    '[contenteditable="true"][data-placeholder*="评论"]',
    'textarea[placeholder*="评论"]',
)
COMMENT_SUBMITS = (
    'button:has-text("发送")',
    '[role="button"]:has-text("发送")',
)
DIRECT_MESSAGE_ENTRIES = (
    ('button:has-text("发私信")', "发私信"),
    ('[role="button"]:has-text("发私信")', "发私信"),
    ('span:has-text("发私信")', "发私信"),
    ('button:has-text("私信")', "私信"),
    ('[role="button"]:has-text("私信")', "私信"),
    ('span:has-text("私信")', "私信"),
)
DIRECT_MESSAGE_COMPOSERS = (
    '.DraftEditor-editor [contenteditable="true"]',
    '.DraftEditor-root [contenteditable="true"]',
    '[data-contents="true"] [contenteditable="true"]',
    '[class*="chat-input-"] [contenteditable="true"]',
    '[contenteditable="true"][data-placeholder*="发消息"]',
)
DIRECT_MESSAGE_SUBMITS = (
    ".e2e-send-msg-btn",
    '[class*="chat-btn"]',
)

_FIXTURE_CONTROLS = {
    "comment": ('[data-e2e="comment-input"]', '[data-e2e="comment-submit"]'),
    "direct_message": ('[data-e2e="message-input"]', '[data-e2e="message-submit"]'),
}
_FIXTURE_MESSAGE_ENTRY = '[data-e2e="message-entry"]'
_PAGE_FAILURES = (
    ("#captcha-verify-image", "douyin_verification_required"),
    ("#captcha_container", "douyin_verification_required"),
    ('text="操作频繁，请稍后再试"', "douyin_rate_limited"),
    ('text="请稍后再试"', "douyin_rate_limited"),
    ('text="当前操作存在风险"', "douyin_account_warning"),
    ('iframe[src^="https://passport.douyin.com/login"]', "douyin_login_expired"),
    ('form[action^="https://passport.douyin.com/login"]', "douyin_login_expired"),
    ('[data-e2e="verification"]', "douyin_verification_required"),
    ('[data-e2e="rate-limit"]', "douyin_rate_limited"),
    ('[data-e2e="account-warning"]', "douyin_account_warning"),
    ('[data-e2e="login-required"]', "douyin_login_expired"),
)
_COMMENT_ITEMS = '.comment-item, [data-comment-id], [data-cid]'
_MESSAGE_ITEMS = (
    '[data-direction="outgoing"][data-message-id], '
    '[data-direction="outgoing"][data-msg-id], '
    '[data-message-direction="outgoing"][data-message-id], '
    '[data-message-direction="outgoing"][data-msg-id], '
    '[data-owner="self"][data-message-id], '
    '[data-owner="self"][data-msg-id], '
    '[aria-label="我发送的消息"][data-message-id], '
    '[aria-label="我发送的消息"][data-msg-id]'
)
_EDITOR_DESCENDANTS = '[contenteditable], textarea, input, [role="textbox"]'
_FIXTURE_RECEIPT = '[data-e2e-receipt-id]'
_PLATFORM_ID = re.compile(r"[A-Za-z0-9_-]{1,200}")
_FIXTURE_ID = re.compile(r"[A-Za-z0-9:_-]{1,255}")
_MAX_MATCHES = 100


class ActionControls(NamedTuple):
    composer: object
    submit: object


@dataclass(frozen=True)
class ReceiptBaseline:
    """Bounded pre-submit identities; never includes comment text or page data."""

    platform_ids: frozenset[str] = frozenset()
    exact_match_count: int = 0
    has_unidentified_match: bool = False


class _CommentMatch(NamedTuple):
    item: object
    platform_id: str | None


class _MessageMatch(NamedTuple):
    item: object
    platform_id: str | None


class ActionControlsFailure(RuntimeError):
    """A closed failure code without page or approved-content text."""

    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


def _visible_matches(locator: object, ambiguous_code: str, *,
                     require_unique: bool = True) -> list[object]:
    try:
        count = locator.count()  # type: ignore[attr-defined]
    except Exception as error:
        raise ActionControlsFailure("douyin_action_control_missing") from error
    if not isinstance(count, int) or count < 0:
        raise ActionControlsFailure("douyin_action_control_missing")
    if count > _MAX_MATCHES:
        raise ActionControlsFailure(ambiguous_code)

    matches: list[object] = []
    for index in range(count):
        try:
            candidate = locator if count == 1 else locator.nth(index)  # type: ignore[attr-defined]
            if candidate.is_visible(timeout=250):  # type: ignore[attr-defined]
                matches.append(candidate)
        except Exception as error:
            raise ActionControlsFailure("douyin_action_control_missing") from error
        if require_unique and len(matches) > 1:
            raise ActionControlsFailure(ambiguous_code)
    return matches


def _is_usable(locator: object, *, editable: bool) -> bool:
    try:
        if not locator.is_enabled(timeout=250):  # type: ignore[attr-defined]
            return False
        return not editable or bool(locator.is_editable(timeout=250))  # type: ignore[attr-defined]
    except Exception:
        return False


def _first_unique(page: object, candidates: tuple[str, ...], *, editable: bool,
                  exact_send_role: bool = False,
                  exact_text: str | None = None) -> object | None:
    try:
        locator = page.locator(", ".join(candidates))  # type: ignore[attr-defined]
        if exact_send_role:
            locator = locator.and_(  # type: ignore[attr-defined]
                page.get_by_role("button", name="发送", exact=True),  # type: ignore[attr-defined]
            )
    except Exception as error:
        raise ActionControlsFailure("douyin_action_control_missing") from error
    try:
        count = locator.count()  # type: ignore[attr-defined]
    except Exception as error:
        raise ActionControlsFailure("douyin_action_control_missing") from error
    if not isinstance(count, int) or count < 0:
        raise ActionControlsFailure("douyin_action_control_missing")
    if count > 1:
        raise ActionControlsFailure("douyin_action_control_ambiguous")
    if count == 0:
        return None
    try:
        visible = locator.is_visible(timeout=250)  # type: ignore[attr-defined]
    except Exception as error:
        raise ActionControlsFailure("douyin_action_control_missing") from error
    if not visible or not _is_usable(locator, editable=editable):
        raise ActionControlsFailure("douyin_action_control_missing")
    if exact_text is not None:
        try:
            if locator.text_content(timeout=250) != exact_text:  # type: ignore[attr-defined]
                raise ActionControlsFailure("douyin_action_control_missing")
        except ActionControlsFailure:
            raise
        except Exception as error:
            raise ActionControlsFailure("douyin_action_control_missing") from error
    return locator


def detect_page_failure(page: object) -> str | None:
    try:
        current_url = page.url  # type: ignore[attr-defined]
    except Exception:
        current_url = None
    if isinstance(current_url, str) and re.fullmatch(
        r"https://passport\.douyin\.com/(?:login|sso/login)(?:[/?#].*)?",
        current_url,
    ):
        return "douyin_login_expired"
    try:
        title = page.title()  # type: ignore[attr-defined]
    except Exception:
        title = None
    if isinstance(title, str) and "验证码中间页" in title:
        return "douyin_verification_required"
    for selector, code in _PAGE_FAILURES:
        try:
            matches = _visible_matches(
                page.locator(selector),  # type: ignore[attr-defined]
                "douyin_action_control_ambiguous",
            )
        except ActionControlsFailure:
            return "douyin_action_control_missing"
        if matches:
            return code
    return None


def open_direct_message_panel(page: object) -> None:
    actionable_selectors = tuple(
        selector for selector, _ in DIRECT_MESSAGE_ENTRIES
        if not selector.startswith("span")
    )
    fallback_selectors = tuple(
        selector for selector, _ in DIRECT_MESSAGE_ENTRIES
        if selector.startswith("span")
    )
    entry = _first_unique(page, actionable_selectors, editable=False)
    if entry is None:
        entry = _first_unique(page, fallback_selectors, editable=False)
    if entry is not None:
        try:
            if entry.text_content(timeout=250) not in {  # type: ignore[attr-defined]
                "发私信", "私信",
            }:
                raise ActionControlsFailure("douyin_direct_message_unavailable")
            entry.click(timeout=5_000)  # type: ignore[attr-defined]
        except ActionControlsFailure:
            raise
        except Exception as error:
            raise ActionControlsFailure(
                "douyin_direct_message_unavailable"
            ) from error
        return
    fixture_entry = _first_unique(
        page,
        (_FIXTURE_MESSAGE_ENTRY,),
        editable=False,
    )
    if fixture_entry is not None:
        try:
            fixture_entry.click(timeout=5_000)  # type: ignore[attr-defined]
        except Exception as error:
            raise ActionControlsFailure(
                "douyin_direct_message_unavailable"
            ) from error
        return
    raise ActionControlsFailure("douyin_direct_message_unavailable")


def locate_action_controls(page: object, kind: str) -> ActionControls:
    if kind == "comment":
        composer = _first_unique(page, COMMENT_COMPOSERS, editable=True)
        submit = _first_unique(
            page, COMMENT_SUBMITS, editable=False, exact_send_role=True,
            exact_text="发送",
        )
    elif kind == "direct_message":
        composer = _first_unique(
            page,
            DIRECT_MESSAGE_COMPOSERS,
            editable=True,
        )
        submit = _first_unique(
            page,
            DIRECT_MESSAGE_SUBMITS,
            editable=False,
            exact_text="发送",
        )
    else:
        raise ActionControlsFailure("douyin_action_control_missing")

    fixture_composer, fixture_submit = _FIXTURE_CONTROLS[kind]
    if composer is None:
        composer = _first_unique(page, (fixture_composer,), editable=True)
    if submit is None:
        submit = _first_unique(page, (fixture_submit,), editable=False)
    if composer is None or submit is None:
        raise ActionControlsFailure("douyin_action_control_missing")
    return ActionControls(composer=composer, submit=submit)


def read_composer_content(composer: object) -> str | None:
    try:
        value = composer.input_value(timeout=250)  # type: ignore[attr-defined]
    except Exception:
        try:
            value = composer.text_content(timeout=250)  # type: ignore[attr-defined]
        except Exception:
            return None
    return value if isinstance(value, str) else None


def _receipt_attribute(item: object, name: str) -> str | None:
    try:
        value = item.get_attribute(name, timeout=250)  # type: ignore[attr-defined]
    except Exception as error:
        raise ActionControlsFailure("douyin_action_receipt_ambiguous") from error
    if value is not None and not isinstance(value, str):
        raise ActionControlsFailure("douyin_action_receipt_ambiguous")
    return value


def _platform_id(item: object, attributes: tuple[str, ...]) -> str | None:
    values: list[str] = []
    for attribute in attributes:
        value = _receipt_attribute(item, attribute)
        if value is None:
            continue
        if _PLATFORM_ID.fullmatch(value) is None:
            raise ActionControlsFailure("douyin_action_receipt_ambiguous")
        values.append(value)
    if len(set(values)) > 1:
        raise ActionControlsFailure("douyin_action_receipt_ambiguous")
    return values[0] if values else None


def _synthetic_comment_reference(request: ActionRequest) -> str:
    material = "\0".join((
        request.action_id,
        str(request.target_public_url),
        request.content,
    )).encode("utf-8")
    return f"douyin-visible-comment:{hashlib.sha256(material).hexdigest()}"


def _is_editor(item: object) -> bool:
    contenteditable = _receipt_attribute(item, "contenteditable")
    if (contenteditable is not None
            and contenteditable.strip().lower() != "false"):
        return True
    role = _receipt_attribute(item, "role")
    if isinstance(role, str) and role.strip().lower() == "textbox":
        return True
    try:
        descendants = item.locator(_EDITOR_DESCENDANTS)  # type: ignore[attr-defined]
        descendant_count = descendants.count()  # type: ignore[attr-defined]
        editable = item.is_editable(timeout=250)  # type: ignore[attr-defined]
        textboxes = item.get_by_role("textbox")  # type: ignore[attr-defined]
        textbox_count = textboxes.count()  # type: ignore[attr-defined]
    except Exception as error:
        raise ActionControlsFailure("douyin_action_receipt_ambiguous") from error
    if not isinstance(descendant_count, int) or descendant_count < 0:
        raise ActionControlsFailure("douyin_action_receipt_ambiguous")
    if (not isinstance(textbox_count, int) or textbox_count < 0
            or descendant_count > _MAX_MATCHES
            or textbox_count > _MAX_MATCHES):
        raise ActionControlsFailure("douyin_action_receipt_ambiguous")
    return descendant_count > 0 or textbox_count > 0 or bool(editable)


def _match_comment_item(item: object, request: ActionRequest) -> _CommentMatch | None:
    try:
        if not item.is_visible(timeout=250):  # type: ignore[attr-defined]
            return None
    except Exception as error:
        raise ActionControlsFailure("douyin_action_receipt_ambiguous") from error
    if _is_editor(item):
        return None
    try:
        text_locator = item.get_by_text(  # type: ignore[attr-defined]
            request.content, exact=True,
        )
        text_matches = _visible_matches(
            text_locator,
            "douyin_action_receipt_ambiguous",
            require_unique=False,
        )
    except ActionControlsFailure:
        raise
    except Exception as error:
        raise ActionControlsFailure("douyin_action_receipt_ambiguous") from error
    exact = False
    for text_match in text_matches:
        try:
            if text_match.text_content(timeout=250) == request.content:  # type: ignore[attr-defined]
                exact = True
        except Exception as error:
            raise ActionControlsFailure("douyin_action_receipt_ambiguous") from error
    if not exact:
        return None
    return _CommentMatch(
        item=item,
        platform_id=_platform_id(item, ("data-comment-id", "data-cid")),
    )


def _match_message_item(
    item: object,
    request: ActionRequest,
) -> _MessageMatch | None:
    try:
        if not item.is_visible(timeout=250):  # type: ignore[attr-defined]
            return None
    except Exception as error:
        raise ActionControlsFailure("douyin_action_receipt_ambiguous") from error
    if _is_editor(item):
        return None
    direction_markers = {
        _receipt_attribute(item, "data-direction"),
        _receipt_attribute(item, "data-message-direction"),
        _receipt_attribute(item, "data-owner"),
        _receipt_attribute(item, "aria-label"),
    }
    direction_markers.discard(None)
    normalized_markers = {
        marker.strip().lower()
        for marker in direction_markers
        if isinstance(marker, str)
    }
    outgoing_markers = {"outgoing", "sent", "self", "我发送的消息"}
    incoming_markers = {"incoming", "received", "other", "对方发送的消息"}
    if normalized_markers & outgoing_markers:
        if normalized_markers & incoming_markers:
            raise ActionControlsFailure("douyin_action_receipt_ambiguous")
    elif normalized_markers & incoming_markers:
        return None
    else:
        raise ActionControlsFailure("douyin_action_receipt_ambiguous")
    try:
        text_matches = _visible_matches(
            item.get_by_text(request.content, exact=True),  # type: ignore[attr-defined]
            "douyin_action_receipt_ambiguous",
            require_unique=False,
        )
    except ActionControlsFailure:
        raise
    except Exception as error:
        raise ActionControlsFailure("douyin_action_receipt_ambiguous") from error
    exact = False
    for text_match in text_matches:
        try:
            if text_match.text_content(timeout=250) == request.content:  # type: ignore[attr-defined]
                exact = True
        except Exception as error:
            raise ActionControlsFailure(
                "douyin_action_receipt_ambiguous"
            ) from error
    if not exact:
        return None
    return _MessageMatch(
        item=item,
        platform_id=_platform_id(item, ("data-message-id", "data-msg-id")),
    )


def _matching_comment_items(page: object, request: ActionRequest) -> list[_CommentMatch]:
    try:
        candidates = _visible_matches(
            page.locator(_COMMENT_ITEMS),  # type: ignore[attr-defined]
            "douyin_action_receipt_ambiguous",
            require_unique=False,
        )
    except ActionControlsFailure as error:
        if error.code == "douyin_action_control_missing":
            raise ActionControlsFailure("douyin_action_receipt_ambiguous") from error
        raise
    matches = []
    for item in candidates:
        match = _match_comment_item(item, request)
        if match is not None:
            matches.append(match)
    return matches


def _matching_message_items(page: object, request: ActionRequest) -> list[_MessageMatch]:
    try:
        candidates = _visible_matches(
            page.locator(_MESSAGE_ITEMS),  # type: ignore[attr-defined]
            "douyin_action_receipt_ambiguous",
            require_unique=False,
        )
    except ActionControlsFailure as error:
        if error.code == "douyin_action_control_missing":
            raise ActionControlsFailure(
                "douyin_action_receipt_ambiguous"
            ) from error
        raise
    matches = []
    for item in candidates:
        match = _match_message_item(item, request)
        if match is not None:
            matches.append(match)
    return matches


def capture_receipt_baseline(page: object, request: ActionRequest) -> ReceiptBaseline:
    if request.kind == "comment":
        matches = _matching_comment_items(page, request)
    elif request.kind == "direct_message":
        matches = _matching_message_items(page, request)
    else:
        return ReceiptBaseline()
    platform_ids = [match.platform_id for match in matches
                    if match.platform_id is not None]
    if len(platform_ids) != len(set(platform_ids)):
        raise ActionControlsFailure("douyin_action_receipt_ambiguous")
    return ReceiptBaseline(
        platform_ids=frozenset(platform_ids),
        exact_match_count=len(matches),
        has_unidentified_match=any(
            match.platform_id is None for match in matches
        ),
    )


def find_visible_receipt(
    page: object,
    request: ActionRequest,
    baseline: ReceiptBaseline,
) -> str | None:
    if request.kind == "comment":
        matches = _matching_comment_items(page, request)
        if baseline.has_unidentified_match:
            new_platform_ids = [
                match for match in matches
                if (match.platform_id is not None
                    and match.platform_id not in baseline.platform_ids)
            ]
            if new_platform_ids:
                raise ActionControlsFailure("douyin_action_receipt_ambiguous")
        eligible = [
            match for match in matches
            if (
                match.platform_id is not None
                and match.platform_id not in baseline.platform_ids
            ) or (
                match.platform_id is None
                and baseline.exact_match_count == 0
            )
        ]
        if len(eligible) > 1:
            raise ActionControlsFailure("douyin_action_receipt_ambiguous")
        if eligible:
            match = eligible[0]
            revalidated = _match_comment_item(match.item, request)
            if revalidated is None or revalidated.platform_id != match.platform_id:
                raise ActionControlsFailure("douyin_action_receipt_ambiguous")
            if revalidated.platform_id is not None:
                return f"douyin-comment:{revalidated.platform_id}"
            return _synthetic_comment_reference(request)
    elif request.kind == "direct_message":
        matches = _matching_message_items(page, request)
        if baseline.has_unidentified_match:
            new_platform_ids = [
                match for match in matches
                if (match.platform_id is not None
                    and match.platform_id not in baseline.platform_ids)
            ]
            if new_platform_ids:
                raise ActionControlsFailure(
                    "douyin_action_receipt_ambiguous"
                )
        eligible = [
            match for match in matches
            if (
                match.platform_id is not None
                and match.platform_id not in baseline.platform_ids
            ) or (
                match.platform_id is None
                and baseline.exact_match_count == 0
            )
        ]
        if len(eligible) > 1:
            raise ActionControlsFailure("douyin_action_receipt_ambiguous")
        if eligible:
            match = eligible[0]
            revalidated = _match_message_item(match.item, request)
            if (revalidated is None
                    or revalidated.platform_id != match.platform_id):
                raise ActionControlsFailure(
                    "douyin_action_receipt_ambiguous"
                )
            if revalidated.platform_id is not None:
                return f"douyin-message:{revalidated.platform_id}"
            raise ActionControlsFailure("douyin_action_receipt_ambiguous")

    try:
        fixture = _visible_matches(
            page.locator(_FIXTURE_RECEIPT),  # type: ignore[attr-defined]
            "douyin_action_receipt_ambiguous",
        )
    except ActionControlsFailure as error:
        if error.code == "douyin_action_control_missing":
            raise ActionControlsFailure("douyin_action_receipt_ambiguous") from error
        raise
    if not fixture:
        return None
    try:
        value = fixture[0].get_attribute("data-e2e-receipt-id", timeout=250)  # type: ignore[attr-defined]
    except Exception as error:
        raise ActionControlsFailure("douyin_action_receipt_ambiguous") from error
    return value if isinstance(value, str) and _FIXTURE_ID.fullmatch(value) else None


def _comment_is_self_owned(item: object) -> bool:
    markers = {
        _receipt_attribute(item, "data-direction"),
        _receipt_attribute(item, "data-owner"),
        _receipt_attribute(item, "data-is-author"),
        _receipt_attribute(item, "aria-label"),
    }
    markers.discard(None)
    normalized = {
        marker.strip().lower()
        for marker in markers
        if isinstance(marker, str)
    }
    positive = {"outgoing", "self", "true", "我的评论"}
    negative = {"incoming", "other", "false", "他人的评论"}
    if normalized & positive:
        if normalized & negative:
            raise ActionControlsFailure("douyin_action_receipt_ambiguous")
        return True
    if normalized & negative:
        return False
    return False


def _receipt_time(item: object) -> datetime | None:
    raw_values = [
        _receipt_attribute(item, "data-created-at"),
        _receipt_attribute(item, "data-create-time"),
        _receipt_attribute(item, "datetime"),
    ]
    values = [value for value in raw_values if value is not None]
    if not values:
        return None
    parsed: list[datetime] = []
    for value in values:
        try:
            if re.fullmatch(r"[0-9]{10,13}", value):
                raw = int(value)
                seconds = raw / 1_000 if len(value) == 13 else raw
                timestamp = datetime.fromtimestamp(seconds, UTC)
            else:
                timestamp = datetime.fromisoformat(value.replace("Z", "+00:00"))
                if timestamp.tzinfo is None:
                    raise ValueError("naive timestamp")
                timestamp = timestamp.astimezone(UTC)
        except (OverflowError, ValueError):
            raise ActionControlsFailure(
                "douyin_action_receipt_ambiguous"
            ) from None
        parsed.append(timestamp)
    if len(set(parsed)) != 1:
        raise ActionControlsFailure("douyin_action_receipt_ambiguous")
    return parsed[0]


def find_existing_outgoing_receipt(
    page: object,
    request: ActionReconciliationRequest,
) -> str | None:
    """Find one already-present, stable, self-owned receipt without writing.

    This deliberately has no synthetic-reference or fixture fallback.  A
    post-timeout reconciliation is allowed to succeed only when the current
    account's outgoing item is uniquely identifiable by a platform DOM ID.
    """
    if request.kind == "comment":
        eligible = [
            match for match in _matching_comment_items(page, request)
            if _comment_is_self_owned(match.item)
        ]
        prefix = "douyin-comment:"
        rematch = _match_comment_item
    elif request.kind == "direct_message":
        eligible = _matching_message_items(page, request)
        prefix = "douyin-message:"
        rematch = _match_message_item
    else:
        raise ActionControlsFailure("douyin_action_receipt_ambiguous")
    if len(eligible) != 1 or eligible[0].platform_id is None:
        return None
    match = eligible[0]
    observed_at = _receipt_time(match.item)
    not_before = request.not_before.astimezone(UTC)
    if observed_at is None or observed_at < not_before:
        return None
    revalidated = rematch(match.item, request)
    if (revalidated is None
            or revalidated.platform_id != match.platform_id):
        raise ActionControlsFailure("douyin_action_receipt_ambiguous")
    if request.kind == "comment" and not _comment_is_self_owned(match.item):
        raise ActionControlsFailure("douyin_action_receipt_ambiguous")
    return f"{prefix}{match.platform_id}"
