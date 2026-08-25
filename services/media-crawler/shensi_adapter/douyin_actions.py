"""Closed Douyin browser action adapter.

The adapter deliberately knows only allowlisted public URLs, native controls,
and closed page states.  It never reads or logs page text, cookies, storage, or
the approved content after submission.
"""

from __future__ import annotations

from datetime import UTC, datetime
from types import MappingProxyType
from typing import Callable
from urllib.parse import urlsplit
import re

from .schemas import ActionReceipt, ActionRequest


DOUYIN_ACTION_SELECTORS = MappingProxyType({
    "verification": '[data-e2e="verification"]',
    "rate_limit": '[data-e2e="rate-limit"]',
    "account_warning": '[data-e2e="account-warning"]',
    "login_required": '[data-e2e="login-required"]',
    "comment_composer": '[data-e2e="comment-input"]',
    "comment_submit": '[data-e2e="comment-submit"]',
    "message_composer": '[data-e2e="message-input"]',
    "message_submit": '[data-e2e="message-submit"]',
    "receipt": '[data-e2e-receipt-id]',
})

PAGE_FAILURES = (
    ("verification", "douyin_verification_required"),
    ("rate_limit", "douyin_rate_limited"),
    ("account_warning", "douyin_account_warning"),
    ("login_required", "douyin_login_expired"),
)


class DouyinActionFailure(RuntimeError):
    """A closed failure code safe to cross the private service boundary."""

    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


def _visible(page: object, selector: str) -> bool:
    try:
        locator = page.locator(selector)
        return bool(locator.count()) and bool(locator.is_visible(timeout=250))
    except Exception:
        return False


def _receipt(page: object) -> str | None:
    selector = DOUYIN_ACTION_SELECTORS["receipt"]
    if not _visible(page, selector):
        return None
    try:
        value = page.locator(selector).get_attribute(
            "data-e2e-receipt-id", timeout=250
        )
    except Exception:
        return None
    if not isinstance(value, str) or not value or len(value) > 255:
        return None
    return value


class DouyinActionExecutor:
    """Submit one frozen action through a caller-owned authenticated page."""

    def __init__(self, *, now: Callable[[], datetime] | None = None,
                 receipt_attempts: int = 30, receipt_poll_ms: int = 250) -> None:
        if receipt_attempts < 1 or receipt_poll_ms < 0:
            raise ValueError("invalid_action_receipt_wait")
        self._now = now or (lambda: datetime.now(UTC))
        self._receipt_attempts = receipt_attempts
        self._receipt_poll_ms = receipt_poll_ms

    def execute(self, page: object, request: ActionRequest) -> ActionReceipt:
        target = urlsplit(str(request.target_public_url))
        expected = (r"/video/[A-Za-z0-9_-]{1,300}" if request.kind == "comment"
                    else r"/user/[A-Za-z0-9_-]{1,300}")
        if (target.scheme != "https" or target.hostname != "www.douyin.com"
                or target.port is not None or target.query or target.fragment
                or re.fullmatch(expected, target.path) is None):
            raise DouyinActionFailure("action_rejected")
        if self._now() >= request.deadline_at:
            raise DouyinActionFailure("deadline_exceeded")
        page.goto(str(request.target_public_url), wait_until="domcontentloaded")
        for name, code in PAGE_FAILURES:
            if _visible(page, DOUYIN_ACTION_SELECTORS[name]):
                raise DouyinActionFailure(code)

        prefix = "comment" if request.kind == "comment" else "message"
        composer = DOUYIN_ACTION_SELECTORS[f"{prefix}_composer"]
        submit = DOUYIN_ACTION_SELECTORS[f"{prefix}_submit"]
        if not _visible(page, composer) or not _visible(page, submit):
            raise DouyinActionFailure("douyin_action_control_missing")

        page.locator(composer).fill(request.content, timeout=5_000)
        page.locator(submit).click(timeout=5_000)
        for attempt in range(self._receipt_attempts):
            reference = _receipt(page)
            if reference is not None:
                return ActionReceipt(
                    action_id=request.action_id,
                    state="succeeded",
                    platform_receipt_reference=reference,
                    occurred_at=self._now(),
                    failure_code=None,
                )
            if attempt + 1 < self._receipt_attempts:
                page.wait_for_timeout(self._receipt_poll_ms)
        # The final read above is the only late-success recovery path.  We
        # never submit again after an ambiguous timeout.
        raise DouyinActionFailure("douyin_action_timeout")
