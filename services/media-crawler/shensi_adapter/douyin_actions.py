"""Closed Douyin browser action adapter.

The adapter knows only allowlisted public URLs, bounded native controls, and
closed page states.  It compares only bounded comment-item text for a receipt
and never logs page text, cookies, storage, or approved content.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
import math
from typing import Callable, Mapping
from urllib.parse import parse_qs, urlsplit
import re

from .douyin_action_controls import (
    ActionControlsFailure,
    capture_receipt_baseline,
    detect_page_failure,
    find_existing_outgoing_receipt,
    find_visible_receipt,
    locate_action_composer,
    locate_action_submit,
    open_comment_composer,
    open_direct_message_panel,
    pin_action_control,
    prepare_guarded_action_submit,
    read_composer_content,
    require_direct_message_recipient_binding,
    type_action_content,
)
from .douyin_account_identity import account_handle_for_raw_sec_uid
from .schemas import ActionReceipt, ActionReconciliationRequest, ActionRequest
from .visual_locator import VisualLocator, VisualLocatorFailure


class DouyinActionFailure(RuntimeError):
    """A closed failure code safe to cross the private service boundary."""

    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


_COMMENT_PUBLISH_PATHS = {
    "/aweme/v1/web/comment/publish",
    "/aweme/v1/web/comment/publish/",
}
_PLATFORM_RECEIPT_ID = re.compile(r"[A-Za-z0-9_-]{1,200}")


def _is_comment_publish_response(response: object) -> bool:
    """Match only the first-party response emitted by the approved click."""
    try:
        target = urlsplit(response.url)  # type: ignore[attr-defined]
        method = response.request.method  # type: ignore[attr-defined]
    except Exception:
        return False
    try:
        port = target.port
    except ValueError:
        return False
    return (
        target.scheme == "https"
        and target.hostname == "www.douyin.com"
        and port in {None, 443}
        and target.username is None
        and target.password is None
        and target.path in _COMMENT_PUBLISH_PATHS
        and method == "POST"
    )


def _stable_response_id(value: object) -> str | None:
    if isinstance(value, bool):
        return None
    normalized = str(value) if isinstance(value, (str, int)) else None
    if normalized is None or _PLATFORM_RECEIPT_ID.fullmatch(normalized) is None:
        return None
    return normalized


def _official_comment_receipt(
    response: object,
    request: ActionRequest,
    target_video_id: str,
) -> str:
    """Bind one successful publish response to the frozen click and content."""
    try:
        status = response.status  # type: ignore[attr-defined]
        post_data = response.request.post_data  # type: ignore[attr-defined]
        payload = response.json()  # type: ignore[attr-defined]
    except Exception:
        raise DouyinActionFailure("douyin_action_receipt_ambiguous") from None
    if (type(status) is not int or not 200 <= status < 300
            or not isinstance(post_data, str)
            or not isinstance(payload, Mapping)):
        raise DouyinActionFailure("douyin_action_receipt_ambiguous")
    try:
        form = parse_qs(post_data, keep_blank_values=True)
    except ValueError:
        raise DouyinActionFailure("douyin_action_receipt_ambiguous") from None
    if (form.get("text") != [request.content]
            or form.get("aweme_id") != [target_video_id]
            or type(payload.get("status_code")) is not int
            or payload.get("status_code") != 0):
        raise DouyinActionFailure("douyin_action_receipt_ambiguous")
    comment = payload.get("comment")
    if not isinstance(comment, Mapping):
        raise DouyinActionFailure("douyin_action_receipt_ambiguous")
    cid = _stable_response_id(comment.get("cid"))
    aweme_id = _stable_response_id(comment.get("aweme_id"))
    user = comment.get("user")
    raw_sec_uid = (
        _stable_response_id(user.get("sec_uid"))
        if isinstance(user, Mapping) else None
    )
    if (cid is None or aweme_id != target_video_id
            or comment.get("text") != request.content
            or not isinstance(user, Mapping)
            or raw_sec_uid is None):
        raise DouyinActionFailure("douyin_action_receipt_ambiguous")
    try:
        response_account_handle = account_handle_for_raw_sec_uid(
            raw_sec_uid
        )
    except Exception:
        raise DouyinActionFailure(
            "douyin_action_receipt_ambiguous"
        ) from None
    if response_account_handle != request.account_handle:
        raise DouyinActionFailure("douyin_action_receipt_ambiguous")
    return f"douyin-comment:{cid}"


class DouyinActionExecutor:
    """Submit one frozen action through a caller-owned authenticated page."""

    def __init__(self, *, now: Callable[[], datetime] | None = None,
                 receipt_attempts: int = 30, receipt_poll_ms: int = 250,
                 control_wait_ms: int = 15_000,
                 control_poll_ms: int = 250,
                 verification_poll_ms: int = 250,
                 manual_verification_seconds: int = 120,
                 headless: bool = False,
                 visual_locator: VisualLocator | None = None,
                 account_identity_revalidator: Callable[[], str | None] | None = None,
                 require_account_identity_binding: bool = False,
                 ) -> None:
        if (receipt_attempts < 1 or receipt_poll_ms < 0
                or type(control_wait_ms) is not int
                or not 0 <= control_wait_ms <= 30_000
                or type(control_poll_ms) is not int
                or not 1 <= control_poll_ms <= 5_000
                or verification_poll_ms < 1
                or type(manual_verification_seconds) is not int
                or not 30 <= manual_verification_seconds <= 300):
            raise ValueError("invalid_action_receipt_wait")
        self._now = now or (lambda: datetime.now(UTC))
        self._receipt_attempts = receipt_attempts
        self._receipt_poll_ms = receipt_poll_ms
        self._control_wait_ms = control_wait_ms
        self._control_poll_ms = control_poll_ms
        self._verification_poll_ms = verification_poll_ms
        self._manual_verification_seconds = manual_verification_seconds
        self._headless = headless
        self._visual_locator = visual_locator
        self._account_identity_revalidator = account_identity_revalidator
        self._require_account_identity_binding = (
            require_account_identity_binding
        )
        if (require_account_identity_binding
                and account_identity_revalidator is None):
            raise ValueError("account_identity_revalidator_required")

    def _require_account_identity(
        self,
        request: ActionRequest,
    ) -> str | None:
        if self._account_identity_revalidator is None:
            return None
        try:
            sender_reference = self._account_identity_revalidator()
        except DouyinActionFailure:
            raise
        except ActionControlsFailure as error:
            raise DouyinActionFailure(error.code) from None
        except Exception:
            raise DouyinActionFailure(
                "douyin_account_identity_changed"
            ) from None
        if sender_reference is None:
            if self._require_account_identity_binding:
                raise DouyinActionFailure(
                    "douyin_account_identity_changed"
                )
            return None
        if not isinstance(sender_reference, str):
            raise DouyinActionFailure("douyin_account_identity_changed")
        try:
            bound_handle = account_handle_for_raw_sec_uid(sender_reference)
        except Exception:
            raise DouyinActionFailure(
                "douyin_account_identity_changed"
            ) from None
        if bound_handle != request.account_handle:
            raise DouyinActionFailure("douyin_account_identity_changed")
        return sender_reference

    @staticmethod
    def _require_exact_target(page: object, target_url: str) -> None:
        try:
            final_url = page.url  # type: ignore[attr-defined]
        except Exception:
            raise DouyinActionFailure("action_rejected") from None
        if not isinstance(final_url, str) or final_url != target_url:
            raise DouyinActionFailure("action_rejected")

    def _require_action_ready(
        self, page: object, request: ActionRequest, target_url: str,
    ) -> str | None:
        failure = detect_page_failure(page)
        if failure is not None:
            raise DouyinActionFailure(failure)
        self._require_exact_target(page, target_url)
        sender_reference = self._require_account_identity(request)
        if self._now() >= request.deadline_at:
            raise DouyinActionFailure("deadline_exceeded")
        return sender_reference

    def _bounded_timeout_ms(
        self, request: ActionRequest, preferred_ms: int,
    ) -> int:
        remaining_ms = math.ceil(
            (request.deadline_at - self._now()).total_seconds() * 1_000
        )
        if remaining_ms <= 0:
            raise DouyinActionFailure("deadline_exceeded")
        return min(preferred_ms, remaining_ms)

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
            failure = detect_page_failure(page)
            if failure is None:
                self._require_action_ready(page, request, target_url)
                return
            if failure != "douyin_verification_required":
                raise DouyinActionFailure(failure)

    def _wait_for_control(
        self,
        page: object,
        request: ActionRequest,
        target_url: str,
        locator: Callable[[object, str], object],
    ) -> object:
        remaining_budget_ms = self._control_wait_ms
        while True:
            self._require_action_ready(page, request, target_url)
            try:
                return locator(page, request.kind)
            except ActionControlsFailure as error:
                if error.code != "douyin_action_control_missing":
                    raise DouyinActionFailure(error.code) from None
                if remaining_budget_ms <= 0:
                    raise DouyinActionFailure(error.code) from None

            deadline_remaining_ms = math.ceil(
                (request.deadline_at - self._now()).total_seconds() * 1_000
            )
            if deadline_remaining_ms <= 0:
                raise DouyinActionFailure("deadline_exceeded")
            wait_ms = min(
                self._control_poll_ms,
                remaining_budget_ms,
                deadline_remaining_ms,
            )
            try:
                page.wait_for_timeout(wait_ms)  # type: ignore[attr-defined]
            except Exception:
                raise DouyinActionFailure(
                    "douyin_action_control_missing"
                ) from None
            remaining_budget_ms -= wait_ms

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
        failure = detect_page_failure(page)
        if failure == "douyin_verification_required":
            self._wait_for_manual_verification(page, request, target_url)
            failure = detect_page_failure(page)
        if failure is not None:
            raise DouyinActionFailure(failure)
        self._require_action_ready(page, request, target_url)
        if request.kind == "direct_message":
            def before_visual_entry_click() -> int:
                self._require_action_ready(page, request, target_url)
                return self._bounded_timeout_ms(request, 5_000)

            try:
                open_direct_message_panel(
                    page,
                    visual_locator=self._visual_locator,
                    deadline_at=request.deadline_at,
                    before_visual_click=before_visual_entry_click,
                )
            except ActionControlsFailure as error:
                raise DouyinActionFailure(error.code) from None
            self._require_action_ready(page, request, target_url)
        submit = None
        if request.kind == "direct_message":
            def locate_bound_composer(current_page: object, kind: str) -> object:
                candidate = pin_action_control(
                    locate_action_composer(current_page, kind)
                )
                require_direct_message_recipient_binding(
                    candidate,
                    target_url,
                )
                return candidate

            composer = self._wait_for_control(
                page, request, target_url, locate_bound_composer,
            )
        else:
            comment_composer_prepared = False

            def before_comment_entry_click() -> int:
                self._require_action_ready(page, request, target_url)
                return self._bounded_timeout_ms(request, 5_000)

            def locate_pinned_composer(current_page: object, kind: str) -> object:
                nonlocal comment_composer_prepared
                if not comment_composer_prepared:
                    open_comment_composer(
                        current_page,
                        before_click=before_comment_entry_click,
                    )
                    comment_composer_prepared = True
                return pin_action_control(
                    locate_action_composer(current_page, kind)
                )

            composer = self._wait_for_control(
                page, request, target_url, locate_pinned_composer,
            )
        self._require_action_ready(page, request, target_url)
        try:
            if request.kind == "direct_message":
                composer.click(  # type: ignore[attr-defined]
                    timeout=self._bounded_timeout_ms(request, 5_000),
                )
                composer.press(  # type: ignore[attr-defined]
                    "ControlOrMeta+A",
                    timeout=self._bounded_timeout_ms(request, 5_000),
                )
                composer.press(  # type: ignore[attr-defined]
                    "Backspace",
                    timeout=self._bounded_timeout_ms(request, 5_000),
                )
                type_action_content(
                    composer,
                    request.content,
                    delay=0,
                    timeout=self._bounded_timeout_ms(request, 5_000),
                )
            else:
                composer.click(  # type: ignore[attr-defined]
                    timeout=self._bounded_timeout_ms(request, 5_000),
                )
                page.keyboard.press("ControlOrMeta+A")  # type: ignore[attr-defined]
                page.keyboard.press("Backspace")  # type: ignore[attr-defined]
                typing_ms = max(1_000, len(request.content) * 10 + 1_000)
                type_action_content(
                    composer,
                    request.content,
                    delay=10,
                    timeout=self._bounded_timeout_ms(request, typing_ms),
                )
        except Exception:
            code = ("douyin_direct_message_unavailable"
                    if request.kind == "direct_message"
                    else "douyin_action_control_missing")
            raise DouyinActionFailure(code) from None
        if read_composer_content(composer) != request.content:
            raise DouyinActionFailure("douyin_action_content_mismatch")
        if request.kind == "direct_message":
            try:
                require_direct_message_recipient_binding(
                    composer,
                    target_url,
                )
            except ActionControlsFailure as error:
                raise DouyinActionFailure(error.code) from None
        baseline_sender_reference = self._require_action_ready(
            page, request, target_url,
        )
        try:
            baseline = capture_receipt_baseline(
                page,
                request,
                sender_reference=baseline_sender_reference,
            )
        except ActionControlsFailure as error:
            raise DouyinActionFailure(error.code) from None
        self._require_action_ready(page, request, target_url)
        if submit is None:
            if request.kind == "comment":
                def locate_pinned_submit(current_page: object, kind: str) -> object:
                    return pin_action_control(
                        locate_action_submit(current_page, kind)
                    )

                submit = self._wait_for_control(
                    page, request, target_url, locate_pinned_submit,
                )
            else:
                def locate_bound_submit(current_page: object, kind: str) -> object:
                    candidate = pin_action_control(
                        locate_action_submit(current_page, kind)
                    )
                    require_direct_message_recipient_binding(
                        candidate,
                        target_url,
                    )
                    return candidate

                try:
                    submit = self._wait_for_control(
                        page, request, target_url, locate_bound_submit,
                    )
                except DouyinActionFailure as error:
                    if (self._visual_locator is None
                            or error.code != "douyin_action_control_missing"):
                        raise
                    self._require_action_ready(page, request, target_url)
                    try:
                        submit = self._visual_locator.locate_control(
                            page,
                            purpose="direct_message_submit",
                            deadline_at=request.deadline_at,
                        )
                        submit = pin_action_control(submit)
                        require_direct_message_recipient_binding(
                            submit,
                            target_url,
                        )
                    except VisualLocatorFailure as visual_error:
                        raise DouyinActionFailure(visual_error.code) from None
                    except ActionControlsFailure as binding_error:
                        raise DouyinActionFailure(binding_error.code) from None
        sender_reference = self._require_action_ready(
            page, request, target_url,
        )
        if request.kind == "direct_message":
            try:
                require_direct_message_recipient_binding(
                    submit,
                    target_url,
                )
            except ActionControlsFailure as error:
                raise DouyinActionFailure(error.code) from None
        if sender_reference is not None:
            try:
                submit = prepare_guarded_action_submit(
                    page,
                    submit,
                    concrete_composer=composer,
                    approved_content=request.content,
                    kind=request.kind,
                    target_public_url=target_url,
                    sender_reference=sender_reference,
                )
            except ActionControlsFailure as error:
                raise DouyinActionFailure(error.code) from None
        elif self._require_account_identity_binding:
            raise DouyinActionFailure("douyin_account_identity_changed")
        submit_timeout_ms = self._bounded_timeout_ms(request, 5_000)
        publish_response = None
        response_capture = (
            getattr(page, "expect_response", None)
            if request.kind == "comment"
            else None
        )
        click_completed = False
        try:
            if callable(response_capture):
                with response_capture(
                    _is_comment_publish_response,
                    timeout=submit_timeout_ms,
                ) as response_info:
                    submit.click(  # type: ignore[attr-defined]
                        timeout=submit_timeout_ms,
                    )
                    click_completed = True
                publish_response = response_info.value
            else:
                submit.click(  # type: ignore[attr-defined]
                    timeout=submit_timeout_ms,
                )
                click_completed = True
        except ActionControlsFailure as error:
            raise DouyinActionFailure(error.code) from None
        except Exception:
            if not click_completed:
                # Playwright may dispatch the click before a navigation or DOM
                # detach makes the call raise. A click exception is therefore
                # an uncertain external write and must never be retried.
                raise DouyinActionFailure(
                    "douyin_action_receipt_ambiguous"
                ) from None
            # The click returned successfully but the bounded official-response
            # observer timed out or detached. Continue to the existing DOM
            # receipt proof; do not click a second time.
            publish_response = None
        if publish_response is not None:
            reference = _official_comment_receipt(
                publish_response,
                request,
                target.path.rsplit("/", 1)[-1],
            )
            return ActionReceipt(
                action_id=request.action_id,
                state="succeeded",
                platform_receipt_reference=reference,
                occurred_at=self._now(),
                failure_code=None,
            )
        for attempt in range(self._receipt_attempts):
            receipt_sender_reference = self._require_action_ready(
                page, request, target_url,
            )
            try:
                reference = find_visible_receipt(
                    page,
                    request,
                    baseline,
                    sender_reference=receipt_sender_reference,
                )
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
                try:
                    page.wait_for_timeout(  # type: ignore[attr-defined]
                        self._bounded_timeout_ms(
                            request, self._receipt_poll_ms,
                        )
                    )
                except DouyinActionFailure:
                    raise
                except Exception:
                    raise DouyinActionFailure(
                        "douyin_action_receipt_ambiguous"
                    ) from None
        # The final read above is the only late-success recovery path.  We
        # never submit again after an ambiguous timeout.
        raise DouyinActionFailure("douyin_action_timeout")


class DouyinActionReconciler:
    """Read-only proof for one uncertain action; never locates a send control."""

    def __init__(self, *, now: Callable[[], datetime] | None = None,
                 visual_locator: VisualLocator | None = None,
                 account_identity_revalidator: Callable[[], str | None] | None = None,
                 require_account_identity_binding: bool = False,
                 ) -> None:
        self._now = now or (lambda: datetime.now(UTC))
        self._visual_locator = visual_locator
        self._account_identity_revalidator = account_identity_revalidator
        self._require_account_identity_binding = (
            require_account_identity_binding
        )
        if (require_account_identity_binding
                and account_identity_revalidator is None):
            raise ValueError("account_identity_revalidator_required")

    def _require_account_identity(
        self,
        request: ActionReconciliationRequest,
    ) -> str | None:
        if self._account_identity_revalidator is None:
            return None
        try:
            sender_reference = self._account_identity_revalidator()
        except DouyinActionFailure:
            raise
        except Exception:
            raise DouyinActionFailure(
                "douyin_account_identity_changed"
            ) from None
        if sender_reference is None:
            if self._require_account_identity_binding:
                raise DouyinActionFailure(
                    "douyin_account_identity_changed"
                )
            return None
        if not isinstance(sender_reference, str):
            raise DouyinActionFailure("douyin_account_identity_changed")
        try:
            bound_handle = account_handle_for_raw_sec_uid(sender_reference)
        except Exception:
            raise DouyinActionFailure(
                "douyin_account_identity_changed"
            ) from None
        if bound_handle != request.account_handle:
            raise DouyinActionFailure("douyin_account_identity_changed")
        return sender_reference

    def reconcile(self, page: object,
                  request: ActionReconciliationRequest) -> ActionReceipt:
        target_url = str(request.target_public_url)
        expected = (
            r"https://www\.douyin\.com/video/[A-Za-z0-9_-]{1,300}"
            if request.kind == "comment"
            else r"https://www\.douyin\.com/user/[A-Za-z0-9_-]{1,300}"
        )
        if re.fullmatch(expected, target_url) is None:
            raise DouyinActionFailure("action_rejected")
        if self._now() >= request.deadline_at:
            raise DouyinActionFailure("deadline_exceeded")
        try:
            page.goto(target_url, wait_until="domcontentloaded")  # type: ignore[attr-defined]
        except Exception:
            raise DouyinActionFailure("action_unavailable") from None
        failure = detect_page_failure(page)
        if failure is not None:
            raise DouyinActionFailure(failure)
        DouyinActionExecutor._require_exact_target(page, target_url)
        self._require_account_identity(request)
        if request.kind == "direct_message":
            def before_visual_entry_click() -> int:
                failure = detect_page_failure(page)
                if failure is not None:
                    raise DouyinActionFailure(failure)
                DouyinActionExecutor._require_exact_target(page, target_url)
                self._require_account_identity(request)
                remaining_ms = math.ceil(
                    (request.deadline_at - self._now()).total_seconds()
                    * 1_000
                )
                if remaining_ms <= 0:
                    raise DouyinActionFailure("deadline_exceeded")
                return min(5_000, remaining_ms)

            try:
                open_direct_message_panel(
                    page,
                    visual_locator=self._visual_locator,
                    deadline_at=request.deadline_at,
                    before_visual_click=before_visual_entry_click,
                )
            except ActionControlsFailure as error:
                raise DouyinActionFailure(error.code) from None
            failure = detect_page_failure(page)
            if failure is not None:
                raise DouyinActionFailure(failure)
            DouyinActionExecutor._require_exact_target(page, target_url)
            self._require_account_identity(request)
        if self._now() >= request.deadline_at:
            raise DouyinActionFailure("deadline_exceeded")
        sender_reference = self._require_account_identity(request)
        try:
            reference = find_existing_outgoing_receipt(
                page,
                request,
                sender_reference=sender_reference,
            )
        except ActionControlsFailure as error:
            raise DouyinActionFailure(error.code) from None
        if reference is None:
            raise DouyinActionFailure("douyin_action_receipt_ambiguous")
        return ActionReceipt(
            action_id=request.action_id,
            state="succeeded",
            platform_receipt_reference=reference,
            occurred_at=self._now(),
            failure_code=None,
        )
