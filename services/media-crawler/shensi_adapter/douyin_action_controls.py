"""Bounded, fail-closed locators for one approved Douyin browser action."""

from __future__ import annotations

import hashlib
import re
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
_FIXTURE_RECEIPT = '[data-e2e-receipt-id]'
_PLATFORM_ID = re.compile(r"[A-Za-z0-9_-]{1,200}")
_FIXTURE_ID = re.compile(r"[A-Za-z0-9:_-]{1,255}")
_MAX_MATCHES = 100


class ActionControls(NamedTuple):
    composer: object
    submit: object


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
        matches = _visible_matches(locator, "douyin_action_control_ambiguous")
        if not matches:
            continue
        if not _is_usable(matches[0], editable=editable):
            raise ActionControlsFailure("douyin_action_control_missing")
        if exact_text is not None:
            try:
                if matches[0].text_content(timeout=250) != exact_text:  # type: ignore[attr-defined]
                    raise ActionControlsFailure("douyin_action_control_missing")
            except ActionControlsFailure:
                raise
            except Exception as error:
                raise ActionControlsFailure("douyin_action_control_missing") from error
        return matches[0]
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


def _safe_comment_reference(item: object, request: ActionRequest) -> str:
    for attribute in ("data-comment-id", "data-cid"):
        try:
            value = item.get_attribute(attribute, timeout=250)  # type: ignore[attr-defined]
        except Exception:
            value = None
        if isinstance(value, str) and _PLATFORM_ID.fullmatch(value):
            return f"douyin-comment:{value}"
    material = "\0".join((
        request.action_id,
        str(request.target_public_url),
        request.content,
    )).encode("utf-8")
    return f"douyin-visible-comment:{hashlib.sha256(material).hexdigest()}"


def find_visible_receipt(page: object, request: ActionRequest) -> str | None:
    if request.kind == "comment":
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
        exact: list[object] = []
        for item in candidates:
            try:
                if item.get_attribute("contenteditable", timeout=250) == "true":  # type: ignore[attr-defined]
                    continue
                if item.locator('[contenteditable="true"]').count():  # type: ignore[attr-defined]
                    continue
                text_matches = _visible_matches(
                    item.get_by_text(request.content, exact=True),  # type: ignore[attr-defined]
                    "douyin_action_receipt_ambiguous",
                    require_unique=False,
                )
            except Exception as error:
                raise ActionControlsFailure("douyin_action_receipt_ambiguous") from error
            if text_matches:
                exact.append(item)
            if len(exact) > 1:
                raise ActionControlsFailure("douyin_action_receipt_ambiguous")
        if exact:
            return _safe_comment_reference(exact[0], request)

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
