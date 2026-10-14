"""Closed Douyin browser action adapter.

The adapter knows only allowlisted public URLs, bounded native controls, and
closed page states.  It compares only bounded comment-item text for a receipt
and never logs page text, cookies, storage, or approved content.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
import logging
import math
from typing import Callable, Mapping, NoReturn
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
_LOGGER = logging.getLogger(__name__)


def _ambiguous_official_comment_receipt(reason: str) -> NoReturn:
    """Record only a closed, non-content diagnostic before failing closed."""
    _LOGGER.warning(
        "douyin_comment_receipt_ambiguous reason=%s",
        reason,
    )
    raise DouyinActionFailure("douyin_action_receipt_ambiguous")


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
    *,
    sender_reference: str | None = None,
) -> str:
    """Bind one successful publish response to the frozen click and sender."""
    try:
        finish = getattr(response, "finished", None)
        if callable(finish):
            finish()
        status = response.status  # type: ignore[attr-defined]
        post_data = response.request.post_data  # type: ignore[attr-defined]
        payload = response.json()  # type: ignore[attr-defined]
    except Exception:
        _ambiguous_official_comment_receipt("response_unreadable")
    if (type(status) is not int or not 200 <= status < 300
            or not isinstance(post_data, str)
            or not isinstance(payload, Mapping)):
        _ambiguous_official_comment_receipt("response_envelope_invalid")
    try:
        form = parse_qs(post_data, keep_blank_values=True)
    except ValueError:
        _ambiguous_official_comment_receipt("request_form_invalid")
    if (form.get("text") != [request.content]
            or form.get("aweme_id") != [target_video_id]):
        _ambiguous_official_comment_receipt("request_binding_mismatch")
    platform_status = payload.get("status_code")
    if type(platform_status) is not int:
        _ambiguous_official_comment_receipt("platform_status_missing")
    if platform_status != 0:
        _ambiguous_official_comment_receipt(
            f"platform_status_{platform_status}"
        )
    comment = payload.get("comment")
    if not isinstance(comment, Mapping):
        _ambiguous_official_comment_receipt("comment_object_missing")
    cid = _stable_response_id(comment.get("cid"))
    response_aweme_id = comment.get("aweme_id")
    aweme_id = (
        _stable_response_id(response_aweme_id)
        if response_aweme_id is not None else None
    )
    user = comment.get("user")
    if user is not None and not isinstance(user, Mapping):
        _ambiguous_official_comment_receipt("response_author_invalid")
    response_sec_uid = user.get("sec_uid") if isinstance(user, Mapping) else None
    raw_sec_uid = (
        _stable_response_id(response_sec_uid)
        if response_sec_uid is not None else None
    )
    if cid is None:
        _ambiguous_official_comment_receipt("stable_comment_id_missing")
    if (("aweme_id" in comment and aweme_id != target_video_id)
            or ("text" in comment and comment.get("text") != request.content)
            or (response_sec_uid is not None and raw_sec_uid is None)):
        _ambiguous_official_comment_receipt("response_binding_mismatch")
    identity_reference = raw_sec_uid or sender_reference
    if identity_reference is None:
        _ambiguous_official_comment_receipt("sender_binding_missing")
    try:
        response_account_handle = account_handle_for_raw_sec_uid(
            identity_reference
        )
    except Exception:
        _ambiguous_official_comment_receipt("sender_binding_invalid")
    if response_account_handle != request.account_handle:
        _ambiguous_official_comment_receipt("sender_binding_mismatch")
    return f"douyin-comment:{cid}"


def _comment_list_receipts(
    response: object,
    request: ActionReconciliationRequest,
    observed_at: datetime,
    diagnostics: dict[str, int] | None = None,
) -> set[str]:
    """Read first-party list evidence, using the vendored Douyin client schema.

    Unlike comment-card DOM, this response supplies an author and an absolute
    creation time. Never make an API request, reconstruct a signature, or accept
    a matching text without all the frozen action bindings.
    """
    try:
        target = urlsplit(response.url)  # type: ignore[attr-defined]
        if (target.scheme != "https" or target.hostname != "www.douyin.com"
                or target.port not in {None, 443}
                or target.username is not None or target.password is not None
                or target.path not in {
                    "/aweme/v1/web/comment/list", "/aweme/v1/web/comment/list/",
                }
                or response.request.method != "GET"  # type: ignore[attr-defined]
                or response.status != 200):  # type: ignore[attr-defined]
            return set()
        video_id = str(request.target_public_url).rsplit("/", 1)[1]
        if parse_qs(target.query, max_num_fields=128).get("aweme_id") != [video_id]:
            return set()
        payload = response.json()  # type: ignore[attr-defined]
    except Exception:
        return set()
    if (not isinstance(payload, Mapping)
            or type(payload.get("status_code")) is not int
            or payload["status_code"] != 0
            or not isinstance(payload.get("comments"), list)
            or len(payload["comments"]) > 200):
        return set()
    references: set[str] = set()
    for comment in payload["comments"]:
        if diagnostics is not None:
            diagnostics["comments"] += 1
            if isinstance(comment, Mapping) and comment.get("text") == request.content:
                diagnostics["same_text"] += 1
        if (not isinstance(comment, Mapping)
                or comment.get("text") != request.content
                or str(comment.get("aweme_id")) != video_id
                or type(comment.get("reply_id")) not in {str, int}
                or comment.get("reply_id") not in ("0", 0)):
            continue
        user = comment.get("user")
        sender = user.get("sec_uid") if isinstance(user, Mapping) else None
        cid = _stable_response_id(comment.get("cid"))
        created = comment.get("create_time")
        if (cid is None or not isinstance(sender, str)
                or _stable_response_id(sender) is None
                or account_handle_for_raw_sec_uid(sender) != request.account_handle):
            continue
        if diagnostics is not None:
            diagnostics["same_author_target"] += 1
        if (type(created) is not int
                or not request.not_before.timestamp() <= created <= observed_at.timestamp()):
            continue
        references.add(f"douyin-comment:{cid}")
    return references


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

    def _require_receipt_ready(
        self, page: object, request: ActionRequest, target_url: str,
    ) -> str | None:
        """After a comment click, hand verification to the human, never resend."""
        try:
            return self._require_action_ready(page, request, target_url)
        except DouyinActionFailure as error:
            if (request.kind != "comment"
                    or error.code != "douyin_verification_required"):
                raise
        _LOGGER.warning("douyin_comment_manual_verification state=waiting")
        try:
            self._wait_for_manual_verification(page, request, target_url)
            sender_reference = self._require_action_ready(page, request, target_url)
        except DouyinActionFailure as error:
            # Submission already happened: verification timeout, a closed
            # window or changed authority cannot mean a safe-to-retry failure.
            _LOGGER.warning(
                "douyin_comment_manual_verification state=unresolved reason=%s",
                error.code,
            )
            raise DouyinActionFailure("douyin_action_receipt_ambiguous") from None
        _LOGGER.warning("douyin_comment_manual_verification state=cleared")
        return sender_reference

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
        comment_submit_trigger = "click"
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

                try:
                    submit = self._wait_for_control(
                        page, request, target_url, locate_pinned_submit,
                    )
                except DouyinActionFailure as error:
                    if (error.code != "douyin_action_control_missing"
                            or baseline_sender_reference is None):
                        raise
                    # Current Douyin video pages submit the focused comment
                    # composer with an unmodified Enter key and no longer
                    # expose a semantic send button. The same exact composer,
                    # content, URL and sender guards are bound below before the
                    # single keypress is allowed to reach the platform.
                    submit = composer
                    comment_submit_trigger = "enter"
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
                    trigger=comment_submit_trigger,
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
        official_receipt_failure = None
        if publish_response is not None:
            self._require_receipt_ready(page, request, target_url)
            try:
                reference = _official_comment_receipt(
                    publish_response,
                    request,
                    target.path.rsplit("/", 1)[-1],
                    sender_reference=sender_reference,
                )
            except DouyinActionFailure as error:
                official_receipt_failure = error
            else:
                self._require_receipt_ready(page, request, target_url)
                return ActionReceipt(
                    action_id=request.action_id,
                    state="succeeded",
                    platform_receipt_reference=reference,
                    occurred_at=self._now(),
                    failure_code=None,
                )
        for attempt in range(self._receipt_attempts):
            receipt_sender_reference = self._require_receipt_ready(
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
        if official_receipt_failure is not None:
            raise official_receipt_failure
        raise DouyinActionFailure("douyin_action_timeout")


class DouyinActionReconciler:
    """Read-only proof for one uncertain action; never locates a send control."""

    def __init__(self, *, now: Callable[[], datetime] | None = None,
                 receipt_wait_ms: int = 10_000,
                 visual_locator: VisualLocator | None = None,
                 account_identity_revalidator: Callable[[], str | None] | None = None,
                 require_account_identity_binding: bool = False,
                 ) -> None:
        if type(receipt_wait_ms) is not int or not 0 <= receipt_wait_ms <= 30_000:
            raise ValueError("invalid_reconciliation_wait")
        self._receipt_wait_ms = receipt_wait_ms
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
        # Observe before navigation; a DOMContentLoaded event precedes the
        # asynchronously loaded comments. requestfinished avoids reading a body
        # while it is still streaming. Only retain a bounded set in this call.
        completed: list[object] = []

        def capture(finished_request: object) -> None:
            try:
                path = urlsplit(finished_request.url).path  # type: ignore[attr-defined]
                if (len(completed) < 20 and path.rstrip("/") == "/aweme/v1/web/comment/list"
                        and finished_request.method == "GET"):  # type: ignore[attr-defined]
                    response = finished_request.response()  # type: ignore[attr-defined]
                    if response is not None:
                        completed.append(response)
            except Exception:
                pass

        observing = (request.kind == "comment"
                     and callable(getattr(page, "on", None))
                     and callable(getattr(page, "remove_listener", None)))
        if observing:
            page.on("requestfinished", capture)  # type: ignore[attr-defined]
        try:
            return self._reconcile(page, request, completed, observing=observing)
        finally:
            if observing:
                page.remove_listener("requestfinished", capture)  # type: ignore[attr-defined]

    def _reconcile(self, page: object, request: ActionReconciliationRequest,
                   completed: list[object], *, observing: bool) -> ActionReceipt:
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
            references: set[str] = set()
            processed = 0
            diagnostics = {"comments": 0, "same_text": 0, "same_author_target": 0}
            attempts = math.ceil(self._receipt_wait_ms / 250) if observing else 0
            for attempt in range(attempts + 1):
                if self._now() >= request.deadline_at:
                    raise DouyinActionFailure("deadline_exceeded")
                failure = detect_page_failure(page)
                if failure is not None:
                    raise DouyinActionFailure(failure)
                DouyinActionExecutor._require_exact_target(page, target_url)
                while processed < len(completed):
                    response = completed[processed]
                    processed += 1
                    references.update(_comment_list_receipts(response, request, self._now(), diagnostics))
                if len(references) > 1:
                    raise DouyinActionFailure("douyin_action_receipt_ambiguous")
                if references:
                    self._require_account_identity(request)
                    reference = next(iter(references))
                    break
                if attempt < attempts:
                    remaining = math.ceil((request.deadline_at - self._now()).total_seconds() * 1000)
                    if remaining <= 0:
                        raise DouyinActionFailure("deadline_exceeded")
                    page.wait_for_timeout(min(250, remaining))  # type: ignore[attr-defined]
            if reference is None:
                if request.kind == "comment":
                    _LOGGER.warning(
                        "douyin_comment_reconciliation_unproven observed_lists=%d "
                        "comments=%d same_text=%d same_author_target=%d",
                        processed, diagnostics["comments"], diagnostics["same_text"],
                        diagnostics["same_author_target"],
                    )
                raise DouyinActionFailure("douyin_action_receipt_ambiguous")
        return ActionReceipt(
            action_id=request.action_id,
            state="succeeded",
            platform_receipt_reference=reference,
            occurred_at=self._now(),
            failure_code=None,
        )
