"""Closed Douyin browser action adapter.

The adapter knows only allowlisted public URLs, bounded native controls, and
closed page states.  It compares only bounded comment-item text for a receipt
and never logs page text, cookies, storage, or approved content.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
import math
from typing import Callable
from urllib.parse import urlsplit
import re

from .douyin_action_controls import (
    ActionControlsFailure,
    capture_receipt_baseline,
    detect_page_failure,
    find_visible_receipt,
    locate_action_controls,
    read_composer_content,
)
from .schemas import ActionReceipt, ActionRequest


class DouyinActionFailure(RuntimeError):
    """A closed failure code safe to cross the private service boundary."""

    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


class DouyinActionExecutor:
    """Submit one frozen action through a caller-owned authenticated page."""

    def __init__(self, *, now: Callable[[], datetime] | None = None,
                 receipt_attempts: int = 30, receipt_poll_ms: int = 250,
                 verification_poll_ms: int = 250,
                 manual_verification_seconds: int = 120,
                 headless: bool = False) -> None:
        if (receipt_attempts < 1 or receipt_poll_ms < 0
                or verification_poll_ms < 1
                or type(manual_verification_seconds) is not int
                or not 30 <= manual_verification_seconds <= 300):
            raise ValueError("invalid_action_receipt_wait")
        self._now = now or (lambda: datetime.now(UTC))
        self._receipt_attempts = receipt_attempts
        self._receipt_poll_ms = receipt_poll_ms
        self._verification_poll_ms = verification_poll_ms
        self._manual_verification_seconds = manual_verification_seconds
        self._headless = headless

    @staticmethod
    def _require_exact_target(page: object, target_url: str) -> None:
        try:
            final_url = page.url  # type: ignore[attr-defined]
        except Exception:
            raise DouyinActionFailure("action_rejected") from None
        if not isinstance(final_url, str) or final_url != target_url:
            raise DouyinActionFailure("action_rejected")

    def _wait_for_manual_verification(
        self, page: object, request: ActionRequest, target_url: str,
    ) -> None:
        if self._headless:
            raise DouyinActionFailure("douyin_verification_required")
        try:
            page.bring_to_front()  # type: ignore[attr-defined]
        except Exception:
            raise DouyinActionFailure("douyin_verification_required") from None
        verification_deadline = min(
            request.deadline_at,
            self._now() + timedelta(seconds=self._manual_verification_seconds),
        )
        while True:
            remaining_ms = math.ceil(
                (verification_deadline - self._now()).total_seconds() * 1_000
            )
            if remaining_ms <= 0:
                raise DouyinActionFailure("douyin_verification_required")
            try:
                page.wait_for_timeout(  # type: ignore[attr-defined]
                    min(self._verification_poll_ms, remaining_ms)
                )
            except Exception:
                raise DouyinActionFailure(
                    "douyin_verification_required"
                ) from None
            self._require_exact_target(page, target_url)
            failure = detect_page_failure(page)
            if failure is None:
                if self._now() >= request.deadline_at:
                    raise DouyinActionFailure("deadline_exceeded")
                return
            if failure != "douyin_verification_required":
                raise DouyinActionFailure(failure)

    def execute(self, page: object, request: ActionRequest) -> ActionReceipt:
        target_url = str(request.target_public_url)
        expected = (
            r"https://www\.douyin\.com/video/[A-Za-z0-9_-]{1,300}"
            if request.kind == "comment"
            else r"https://www\.douyin\.com/user/[A-Za-z0-9_-]{1,300}"
        )
        target = urlsplit(target_url)
        if (re.fullmatch(expected, target_url) is None
                or target.username is not None or target.password is not None):
            raise DouyinActionFailure("action_rejected")
        if self._now() >= request.deadline_at:
            raise DouyinActionFailure("deadline_exceeded")
        page.goto(target_url, wait_until="domcontentloaded")
        self._require_exact_target(page, target_url)
        failure = detect_page_failure(page)
        if failure == "douyin_verification_required":
            self._wait_for_manual_verification(page, request, target_url)
            self._require_exact_target(page, target_url)
            failure = detect_page_failure(page)
        if failure is not None:
            raise DouyinActionFailure(failure)
        if self._now() >= request.deadline_at:
            raise DouyinActionFailure("deadline_exceeded")
        try:
            controls = locate_action_controls(page, request.kind)
        except ActionControlsFailure as error:
            raise DouyinActionFailure(error.code) from None
        try:
            controls.composer.fill(request.content, timeout=5_000)  # type: ignore[attr-defined]
        except Exception:
            raise DouyinActionFailure("douyin_action_control_missing") from None
        if read_composer_content(controls.composer) != request.content:
            raise DouyinActionFailure("douyin_action_content_mismatch")
        try:
            baseline = capture_receipt_baseline(page, request)
        except ActionControlsFailure as error:
            raise DouyinActionFailure(error.code) from None
        try:
            controls.submit.click(timeout=5_000)  # type: ignore[attr-defined]
        except Exception:
            raise DouyinActionFailure("douyin_action_control_missing") from None
        for attempt in range(self._receipt_attempts):
            try:
                reference = find_visible_receipt(page, request, baseline)
            except ActionControlsFailure as error:
                raise DouyinActionFailure(error.code) from None
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
