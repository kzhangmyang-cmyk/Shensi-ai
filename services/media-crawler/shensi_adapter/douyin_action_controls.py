"""Bounded, fail-closed locators for one approved Douyin browser action."""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass
from typing import NamedTuple

from .schemas import ActionRequest


COMMENT_COMPOSERS = (
    '[contenteditable="true"][aria-label*="评论"]',
    '[contenteditable="true"][data-placeholder*="评论"]',
    'textarea[placeholder*="评论"]',
)
COMMENT_SUBMITS = (
    'button:has-text("发送")',
    '[role="button"]:has-text("发送")',
)

_FIXTURE_CONTROLS = {
    "comment": ('[data-e2e="comment-input"]', '[data-e2e="comment-submit"]'),
    "direct_message": ('[data-e2e="message-input"]', '[data-e2e="message-submit"]'),
}
_PAGE_FAILURES = (
    ('[data-e2e="verification"]', "douyin_verification_required"),
    ('[data-e2e="rate-limit"]', "douyin_rate_limited"),
    ('[data-e2e="account-warning"]', "douyin_account_warning"),
    ('[data-e2e="login-required"]', "douyin_login_expired"),
)
_COMMENT_ITEMS = '.comment-item, [data-comment-id], [data-cid]'
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
    for index, selector in enumerate(candidates):
        try:
            locator = page.locator(selector)  # type: ignore[attr-defined]
            if exact_send_role:
                locator = locator.and_(  # type: ignore[attr-defined]
                    page.get_by_role("button", name="发送", exact=True),  # type: ignore[attr-defined]
                )
        except Exception:
            raise ActionControlsFailure("douyin_action_control_missing")
        try:
            count = locator.count()  # type: ignore[attr-defined]
        except Exception as error:
            raise ActionControlsFailure("douyin_action_control_missing") from error
        if not isinstance(count, int) or count < 0:
            raise ActionControlsFailure("douyin_action_control_missing")
        if count > 1:
            raise ActionControlsFailure("douyin_action_control_ambiguous")
        if count == 0:
            continue
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
    return None


def detect_page_failure(page: object) -> str | None:
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


def locate_action_controls(page: object, kind: str) -> ActionControls:
    if kind == "comment":
        composer = _first_unique(page, COMMENT_COMPOSERS, editable=True)
        submit = _first_unique(
            page, COMMENT_SUBMITS, editable=False, exact_send_role=True,
            exact_text="发送",
        )
    elif kind == "direct_message":
        composer = submit = None
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


def _platform_id(item: object) -> str | None:
    values: list[str] = []
    for attribute in ("data-comment-id", "data-cid"):
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


def _is_comment_editor(item: object) -> bool:
    contenteditable = _receipt_attribute(item, "contenteditable")
    if (contenteditable is not None
            and contenteditable.strip().lower() != "false"):
        return True
    role = _receipt_attribute(item, "role")
    if isinstance(role, str) and role.strip().lower() == "textbox":
        return True
    try:
        tag_name = item.evaluate(  # type: ignore[attr-defined]
            "(element) => element.tagName.toLowerCase()", timeout=250,
        )
        descendants = item.locator(_EDITOR_DESCENDANTS)  # type: ignore[attr-defined]
        descendant_count = descendants.count()  # type: ignore[attr-defined]
        editable = item.is_editable(timeout=250)  # type: ignore[attr-defined]
    except Exception as error:
        raise ActionControlsFailure("douyin_action_receipt_ambiguous") from error
    if not isinstance(tag_name, str) or tag_name not in {
        "article", "div", "li", "p", "section", "span", "input", "textarea",
    }:
        raise ActionControlsFailure("douyin_action_receipt_ambiguous")
    if not isinstance(descendant_count, int) or descendant_count < 0:
        raise ActionControlsFailure("douyin_action_receipt_ambiguous")
    if descendant_count > _MAX_MATCHES:
        raise ActionControlsFailure("douyin_action_receipt_ambiguous")
    return tag_name in {"input", "textarea"} or descendant_count > 0 or bool(editable)


def _match_comment_item(item: object, request: ActionRequest) -> _CommentMatch | None:
    try:
        if not item.is_visible(timeout=250):  # type: ignore[attr-defined]
            return None
    except Exception as error:
        raise ActionControlsFailure("douyin_action_receipt_ambiguous") from error
    if _is_comment_editor(item):
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
    return _CommentMatch(item=item, platform_id=_platform_id(item))


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


def capture_receipt_baseline(page: object, request: ActionRequest) -> ReceiptBaseline:
    if request.kind != "comment":
        return ReceiptBaseline()
    matches = _matching_comment_items(page, request)
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
