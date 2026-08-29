"""Private, process-owned Playwright boundary for MediaCrawler login state."""

from __future__ import annotations

import multiprocessing
import os
import re
import secrets
import signal
import threading
import time
from collections.abc import Callable
from multiprocessing.connection import Connection
from pathlib import Path
from typing import Protocol

from .douyin_actions import (
    DouyinActionExecutor,
    DouyinActionFailure,
    DouyinActionReconciler,
)
from .douyin_account_identity import (
    DouyinAccountIdentityFailure,
    account_handle_for_fingerprint,
    extract_douyin_account_reference_in_place,
    extract_douyin_account_identity,
    identity_fingerprint_for_raw_sec_uid,
)
from .schemas import ActionReconciliationRequest, ActionRequest
from .visual_locator import (
    VisualLocator,
    configured_visual_locator,
    create_visual_locator,
)


DEFAULT_ACTION_MANUAL_VERIFICATION_SECONDS = 120
MIN_ACTION_MANUAL_VERIFICATION_SECONDS = 30
MAX_ACTION_MANUAL_VERIFICATION_SECONDS = 300
ACTION_DEADLINE_OVERHEAD_SECONDS = 30
ACTION_IPC_OVERHEAD_SECONDS = 20
ACTION_AUTHORITY_CHECK_TIMEOUT_SECONDS = 5
ACTION_RESULT_REVIEW_MS = 10_000
IDENTITY_DOM_ATTEMPTS = 9
IDENTITY_DOM_POLL_MS = 250


def configured_action_manual_verification_seconds(value: object) -> int:
    if value is None:
        return DEFAULT_ACTION_MANUAL_VERIFICATION_SECONDS
    if type(value) is int:
        seconds = value
    elif isinstance(value, str) and re.fullmatch(r"[0-9]+", value):
        seconds = int(value)
    else:
        raise ValueError("manual verification seconds must be an integer")
    if not MIN_ACTION_MANUAL_VERIFICATION_SECONDS <= seconds <= MAX_ACTION_MANUAL_VERIFICATION_SECONDS:
        raise ValueError("manual verification seconds must be between 30 and 300")
    return seconds


_CLOSED_ACTION_FAILURE_CODES = frozenset({
    "action_unavailable",
    "action_rejected",
    "deadline_exceeded",
    "douyin_verification_required",
    "douyin_rate_limited",
    "douyin_account_warning",
    "douyin_account_identity_changed",
    "douyin_login_expired",
    "douyin_direct_message_unavailable",
    "douyin_action_control_missing",
    "douyin_action_control_ambiguous",
    "douyin_action_content_mismatch",
    "douyin_action_receipt_ambiguous",
    "douyin_action_timeout",
})


def _require_visible_action_browser(headless: bool) -> None:
    if headless:
        raise DouyinActionFailure("action_unavailable")


def _keep_action_result_visible(page: object) -> None:
    """Best-effort operator review window; never changes action truth."""
    try:
        page.bring_to_front()  # type: ignore[attr-defined]
    except Exception:
        pass
    try:
        page.wait_for_timeout(ACTION_RESULT_REVIEW_MS)  # type: ignore[attr-defined]
    except Exception:
        pass


class BrowserState(Protocol):
    def open_douyin_login(self, profile_path: Path) -> dict[str, str]: ...
    def close(self, context: object) -> None: ...
    def poll_douyin_login(self, context: object) -> dict[str, object]: ...
    def execute_douyin_action(self, profile_path: Path,
                              request: ActionRequest, *,
                              authority_validator: Callable[[], None]
                              ) -> dict[str, object]: ...
    def reconcile_douyin_action(self, profile_path: Path,
                                request: ActionRequest, *,
                                authority_validator: Callable[[], None]
                                ) -> dict[str, object]: ...


def _start_playwright(factory: Callable[[], object] | None) -> object:
    if factory is not None:
        return factory()
    from playwright.sync_api import sync_playwright

    return sync_playwright().start()


def _launch_options(headless: bool, browser_channel: str | None) -> dict[str, object]:
    options: dict[str, object] = {"headless": headless}
    if browser_channel:
        options["channel"] = browser_channel
    return options


def _open_context(playwright: object, profile_path: str, *, headless: bool,
                  browser_channel: str | None) -> tuple[object, str]:
    context = playwright.chromium.launch_persistent_context(
        profile_path, **_launch_options(headless, browser_channel)
    )
    try:
        page = context.pages[0] if context.pages else context.new_page()
        page.goto("https://www.douyin.com/", wait_until="domcontentloaded")
        try:
            page.locator("xpath=//p[text() = '登录']").click(timeout=5_000)
        except Exception:
            pass
        image = page.locator("#animate_qrcode_container img")
        image.wait_for(timeout=25_000)
        source = image.get_attribute("src") or ""
        if not source.startswith("data:image/"):
            source = page.evaluate(
                """async (source) => {
                  const response = await fetch(source); const blob = await response.blob();
                  return await new Promise((resolve) => { const reader = new FileReader();
                    reader.onload = () => resolve(reader.result); reader.readAsDataURL(blob); });
                }""",
                source,
            )
        if not isinstance(source, str) or not source.startswith("data:image/"):
            raise RuntimeError("douyin_qr_image_unavailable")
        return context, source
    except BaseException:
        context.close()
        raise


def _extract_bound_identity_with_retry(page: object):
    retryable = {
        "douyin_account_identity_missing",
        "douyin_account_display_name_missing",
    }
    try:
        page.goto(  # type: ignore[attr-defined]
            "https://www.douyin.com/",
            wait_until="domcontentloaded",
            timeout=15_000,
        )
    except Exception:
        raise DouyinAccountIdentityFailure(
            "douyin_account_identity_missing"
        ) from None
    for attempt in range(IDENTITY_DOM_ATTEMPTS):
        try:
            return extract_douyin_account_identity(page)
        except DouyinAccountIdentityFailure as error:
            if (str(error) not in retryable
                    or attempt + 1 >= IDENTITY_DOM_ATTEMPTS):
                raise
        except Exception:
            if attempt + 1 >= IDENTITY_DOM_ATTEMPTS:
                raise DouyinAccountIdentityFailure(
                    "douyin_account_identity_missing"
                ) from None
        try:
            page.wait_for_timeout(  # type: ignore[attr-defined]
                IDENTITY_DOM_POLL_MS
            )
        except Exception:
            raise DouyinAccountIdentityFailure(
                "douyin_account_identity_missing"
            ) from None
    raise DouyinAccountIdentityFailure(
        "douyin_account_identity_missing"
    )


def _require_bound_action_identity(
    page: object, request: ActionRequest | ActionReconciliationRequest,
) -> None:
    """Verify the current authenticated profile before any target read/write."""
    try:
        identity = _extract_bound_identity_with_retry(page)
        current_handle = account_handle_for_fingerprint(
            identity.fingerprint
        )
    except Exception:
        raise DouyinActionFailure(
            "douyin_account_identity_changed"
        ) from None
    if current_handle != request.account_handle:
        raise DouyinActionFailure("douyin_account_identity_changed")


def _require_bound_action_identity_in_place(
    page: object, request: ActionRequest | ActionReconciliationRequest,
) -> str:
    """Revalidate the sender on the current target without navigation."""
    retryable = {"douyin_account_identity_missing"}
    for attempt in range(IDENTITY_DOM_ATTEMPTS):
        try:
            raw_reference = extract_douyin_account_reference_in_place(page)
            current_handle = account_handle_for_fingerprint(
                identity_fingerprint_for_raw_sec_uid(raw_reference)
            )
            if current_handle != request.account_handle:
                raise DouyinActionFailure(
                    "douyin_account_identity_changed"
                )
            return raw_reference
        except DouyinActionFailure:
            raise
        except DouyinAccountIdentityFailure as error:
            if (str(error) not in retryable
                    or attempt + 1 >= IDENTITY_DOM_ATTEMPTS):
                break
        except Exception:
            if attempt + 1 >= IDENTITY_DOM_ATTEMPTS:
                break
        try:
            page.wait_for_timeout(  # type: ignore[attr-defined]
                IDENTITY_DOM_POLL_MS
            )
        except Exception:
            break
    raise DouyinActionFailure("douyin_account_identity_changed")


def _execute_action(playwright: object, profile_path: str,
                    raw_request: object, *, headless: bool,
                    browser_channel: str | None,
                    manual_verification_seconds: int,
                    visual_locator: VisualLocator | None = None,
                    account_authority_revalidator: Callable[[], None] | None = None,
                    ) -> dict[str, object]:
    _require_visible_action_browser(headless)
    request = ActionRequest.model_validate(raw_request)
    context = playwright.chromium.launch_persistent_context(
        profile_path, **_launch_options(headless, browser_channel)
    )
    keep_result_visible = False
    try:
        page = context.pages[0] if context.pages else context.new_page()
        _require_bound_action_identity(page, request)

        def revalidate_account_authority() -> str:
            raw_reference = _require_bound_action_identity_in_place(
                page, request,
            )
            if account_authority_revalidator is None:
                return raw_reference
            try:
                account_authority_revalidator()
            except DouyinActionFailure:
                raise
            except Exception:
                raise DouyinActionFailure(
                    "douyin_account_identity_changed"
                ) from None
            return raw_reference

        try:
            receipt = DouyinActionExecutor(
                headless=headless,
                manual_verification_seconds=manual_verification_seconds,
                visual_locator=visual_locator,
                account_identity_revalidator=revalidate_account_authority,
                require_account_identity_binding=True,
            ).execute(page, request)
        except DouyinActionFailure as error:
            keep_result_visible = (
                request.kind == "comment"
                and error.code == "douyin_action_receipt_ambiguous"
            )
            raise
        keep_result_visible = (
            request.kind == "comment"
            and (
                receipt.state == "succeeded"
                or receipt.failure_code == "douyin_action_receipt_ambiguous"
            )
        )
        return receipt.model_dump(mode="json")
    finally:
        if keep_result_visible:
            _keep_action_result_visible(page)
        context.close()


def _reconcile_action(playwright: object, profile_path: str,
                      raw_request: object, *, headless: bool,
                      browser_channel: str | None,
                      visual_locator: VisualLocator | None = None,
                      account_authority_revalidator: Callable[[], None] | None = None,
                      ) -> dict[str, object]:
    _require_visible_action_browser(headless)
    request = ActionReconciliationRequest.model_validate(raw_request)
    context = playwright.chromium.launch_persistent_context(
        profile_path, **_launch_options(headless, browser_channel)
    )
    try:
        page = context.pages[0] if context.pages else context.new_page()
        _require_bound_action_identity(page, request)

        def revalidate_account_authority() -> str:
            raw_reference = _require_bound_action_identity_in_place(
                page, request,
            )
            if account_authority_revalidator is None:
                return raw_reference
            try:
                account_authority_revalidator()
            except DouyinActionFailure:
                raise
            except Exception:
                raise DouyinActionFailure(
                    "douyin_account_identity_changed"
                ) from None
            return raw_reference

        return DouyinActionReconciler(
            visual_locator=visual_locator,
            account_identity_revalidator=revalidate_account_authority,
            require_account_identity_binding=True,
        ).reconcile(page, request).model_dump(mode="json")
    finally:
        context.close()


def _worker_account_authority_revalidator(
    connection: Connection,
    command_id: object,
) -> Callable[[], None]:
    """Ask the owning process to re-read account/login-version authority."""
    next_check_id = 0

    def revalidate() -> None:
        nonlocal next_check_id
        next_check_id += 1
        try:
            connection.send({
                "id": command_id,
                "kind": "authority_check",
                "check_id": next_check_id,
            })
            if not connection.poll(ACTION_AUTHORITY_CHECK_TIMEOUT_SECONDS):
                raise RuntimeError("authority_check_timeout")
            response = connection.recv()
        except Exception:
            raise DouyinActionFailure(
                "douyin_account_identity_changed"
            ) from None
        expected = {
            "id": command_id,
            "kind": "authority_ok",
            "check_id": next_check_id,
        }
        if response != expected:
            raise DouyinActionFailure(
                "douyin_account_identity_changed"
            )

    return revalidate


def _browser_worker(connection: Connection, factory: Callable[[], object] | None,
                    headless: bool, browser_channel: str | None,
                    manual_verification_seconds: int,
                    visual_locator_mode: str = "disabled") -> None:
    playwright = None
    visual_locator = None
    contexts: dict[str, object] = {}
    shutdown_requested = False
    shutdown_failure: BaseException | None = None
    try:
        if os.name == "posix":
            try:
                os.setsid()
                process_group_id = os.getpgrp()
                if process_group_id != os.getpid():
                    raise OSError("browser worker does not own its process group")
                connection.send(
                    {"kind": "process_group", "pgid": process_group_id}
                )
            except OSError:
                connection.send(
                    {
                        "kind": "startup_error",
                        "message": "douyin_browser_process_isolation_failed",
                    }
                )
                return
        try:
            visual_locator = create_visual_locator(visual_locator_mode)
        except BaseException:
            connection.send({
                "kind": "startup_error",
                "message": "douyin_visual_locator_unavailable",
            })
            return
        try:
            playwright = _start_playwright(factory)
        except BaseException as error:
            connection.send({"kind": "startup_error", "message": str(error)})
            return
        connection.send({"kind": "ready"})
        while True:
            try:
                command = connection.recv()
            except EOFError:
                break
            command_id = command.get("id")
            operation = command.get("operation")
            if operation == "shutdown":
                shutdown_requested = True
                break
            try:
                if operation == "open":
                    context, qr_image_data_url = _open_context(
                        playwright, str(command["profile_path"]),
                        headless=headless, browser_channel=browser_channel
                    )
                    handle = secrets.token_urlsafe(24)
                    contexts[handle] = context
                    value: object = {
                        "handle": handle,
                        "qr_image_data_url": qr_image_data_url,
                    }
                elif operation == "poll":
                    context = contexts.get(str(command["handle"]))
                    if context is None:
                        raise RuntimeError("douyin_browser_context_closed")
                    active = False
                    poll_value: dict[str, object] = {"active": False}
                    for page in context.pages:
                        try:
                            if page.evaluate(
                                "() => window.localStorage.getItem('HasUserLogin')"
                            ) == "1":
                                identity = _extract_bound_identity_with_retry(
                                    page
                                )
                                poll_value = {
                                    "active": True,
                                    "identity_fingerprint": (
                                        identity.fingerprint
                                    ),
                                    "display_name": identity.display_name,
                                }
                                active = True
                                break
                        except DouyinAccountIdentityFailure as error:
                            poll_value = {
                                "active": False,
                                "identity_error": str(error),
                            }
                            break
                        except Exception:
                            continue
                    value = poll_value
                elif operation == "close":
                    handle = str(command["handle"])
                    context = contexts.get(handle)
                    if context is None:
                        raise RuntimeError("douyin_browser_context_closed")
                    context.close()
                    contexts.pop(handle, None)
                    value = None
                elif operation == "action":
                    try:
                        authority_revalidator = (
                            _worker_account_authority_revalidator(
                                connection, command_id,
                            )
                        )
                        value = _execute_action(playwright,
                            str(command["profile_path"]), command["request"],
                            headless=headless, browser_channel=browser_channel,
                            manual_verification_seconds=(
                                manual_verification_seconds
                            ),
                            visual_locator=visual_locator,
                            account_authority_revalidator=(
                                authority_revalidator
                            ),
                        )
                    except DouyinActionFailure:
                        raise
                    except BaseException as error:
                        raise DouyinActionFailure("action_unavailable") from error
                elif operation == "reconcile":
                    try:
                        authority_revalidator = (
                            _worker_account_authority_revalidator(
                                connection, command_id,
                            )
                        )
                        value = _reconcile_action(
                            playwright,
                            str(command["profile_path"]),
                            command["request"],
                            headless=headless,
                            browser_channel=browser_channel,
                            visual_locator=visual_locator,
                            account_authority_revalidator=(
                                authority_revalidator
                            ),
                        )
                    except DouyinActionFailure:
                        raise
                    except BaseException as error:
                        raise DouyinActionFailure("action_unavailable") from error
                else:
                    raise RuntimeError("douyin_browser_invalid_command")
                connection.send({"id": command_id, "kind": "ok", "value": value})
            except DouyinActionFailure as error:
                code = (error.code if error.code in _CLOSED_ACTION_FAILURE_CODES
                        else "action_unavailable")
                connection.send({
                    "id": command_id,
                    "kind": "action_failure",
                    "code": code,
                })
            except BaseException as error:
                connection.send(
                    {"id": command_id, "kind": "error", "message": str(error)}
                )
    finally:
        for context in list(contexts.values()):
            try:
                context.close()
            except BaseException as error:
                shutdown_failure = shutdown_failure or error
        if playwright is not None:
            try:
                playwright.stop()
            except BaseException as error:
                shutdown_failure = shutdown_failure or error
        if shutdown_requested:
            try:
                connection.send(
                    {"kind": "shutdown_error"}
                    if shutdown_failure
                    else {"kind": "shutdown_ok"}
                )
            except (BrokenPipeError, EOFError, OSError):
                pass
        connection.close()


class MediaCrawlerDouyinBrowserState:
    """Own Playwright in a killable child process with bounded IPC commands."""

    def __init__(
        self,
        playwright_factory: Callable[[], object] | None = None,
        startup_timeout: float = 15,
        command_timeout: float = 30,
        headless: bool = True,
        browser_channel: str | None = None,
        manual_verification_seconds: int | None = None,
        visual_locator: str | None = None,
    ) -> None:
        if startup_timeout <= 0 or command_timeout <= 0:
            raise ValueError("browser timeouts must be positive")
        manual_seconds = configured_action_manual_verification_seconds(
            os.environ.get("DOUYIN_ACTION_MANUAL_VERIFICATION_SECONDS")
            if manual_verification_seconds is None else manual_verification_seconds
        )
        visual_locator_mode = configured_visual_locator(
            os.environ.get("DOUYIN_ACTION_VISUAL_LOCATOR")
            if visual_locator is None else visual_locator
        )
        context = multiprocessing.get_context("spawn")
        parent, child = context.Pipe()
        self._connection = parent
        self._process = context.Process(
            target=_browser_worker,
            args=(child, playwright_factory, headless, browser_channel,
                  manual_seconds, visual_locator_mode),
            name="douyin-browser",
        )
        self._timeout = command_timeout
        self._action_timeout = (
            manual_seconds + ACTION_DEADLINE_OVERHEAD_SECONDS
            + ACTION_IPC_OVERHEAD_SECONDS
        )
        self._headless = bool(headless)
        self._lock = threading.Lock()
        self._closed = False
        self._shutdown_failed = False
        self._next_command_id = 1
        self._owned_pgid: int | None = None
        self._process.start()
        child.close()
        startup_deadline = time.monotonic() + startup_timeout
        while True:
            remaining = max(0.0, startup_deadline - time.monotonic())
            if not self._connection.poll(remaining):
                self._hard_stop()
                raise RuntimeError("douyin_browser_startup_timeout")
            try:
                startup = self._connection.recv()
            except (EOFError, OSError) as error:
                self._hard_stop()
                raise RuntimeError("douyin_browser_startup_failed") from error
            if startup.get("kind") == "process_group":
                pgid = startup.get("pgid")
                if (
                    os.name != "posix"
                    or type(pgid) is not int
                    or pgid <= 0
                    or self._owned_pgid is not None
                    or self._process.pid is None
                    or pgid != self._process.pid
                ):
                    self._hard_stop()
                    raise RuntimeError("douyin_browser_process_isolation_failed")
                self._owned_pgid = pgid
                continue
            if startup.get("kind") == "ready":
                if os.name == "posix" and self._owned_pgid is None:
                    self._hard_stop()
                    raise RuntimeError("douyin_browser_process_isolation_failed")
                break
            message = str(startup.get("message") or "douyin_browser_startup_failed")
            self._hard_stop()
            raise RuntimeError(message)

    @staticmethod
    def _handle(context: object) -> str:
        if not isinstance(context, dict):
            raise RuntimeError("douyin_browser_context_invalid")
        handle = context.get("handle")
        if not isinstance(handle, str) or not handle:
            raise RuntimeError("douyin_browser_context_invalid")
        return handle

    def _hard_stop(self) -> None:
        self._closed = True
        try:
            self._connection.close()
        except OSError:
            pass
        owned_pgid = getattr(self, "_owned_pgid", None)
        if os.name == "posix" and owned_pgid is not None:
            try:
                os.killpg(owned_pgid, signal.SIGKILL)
            except (OSError, ValueError):
                pass
        grace = min(max(self._timeout, 0.1), 1.0)

        try:
            self._process.join(timeout=grace)
        except (AssertionError, OSError, ValueError):
            pass
        try:
            alive: bool | None = self._process.is_alive()
        except (AssertionError, OSError, ValueError):
            alive = None

        for _attempt in range(2):
            if alive is False:
                break
            try:
                self._process.kill()
            except (OSError, ValueError):
                pass
            try:
                self._process.join(timeout=grace)
            except (AssertionError, OSError, ValueError):
                pass
            try:
                alive = self._process.is_alive()
            except (AssertionError, OSError, ValueError):
                alive = None
        if alive is False:
            try:
                self._process.close()
            except (OSError, ValueError):
                pass

    def _call(
        self,
        operation: str,
        *,
        authority_validator: Callable[[], None] | None = None,
        **payload: object,
    ) -> object:
        with self._lock:
            if self._closed:
                raise RuntimeError("douyin_browser_closed")
            command_id = self._next_command_id
            self._next_command_id += 1
            try:
                self._connection.send(
                    {"id": command_id, "operation": operation, **payload}
                )
            except (BrokenPipeError, EOFError, OSError) as error:
                self._hard_stop()
                raise RuntimeError("douyin_browser_unavailable") from error
            command_timeout = (
                self._action_timeout
                if operation in {"action", "reconcile"}
                else self._timeout
            )
            command_deadline = time.monotonic() + command_timeout
            while True:
                remaining = max(0.0, command_deadline - time.monotonic())
                if not self._connection.poll(remaining):
                    self._hard_stop()
                    raise RuntimeError("douyin_browser_command_timeout")
                try:
                    response = self._connection.recv()
                except (EOFError, OSError) as error:
                    self._hard_stop()
                    raise RuntimeError("douyin_browser_unavailable") from error
                if response.get("kind") != "authority_check":
                    break
                check_id = response.get("check_id")
                if (operation not in {"action", "reconcile"}
                        or set(response) != {
                            "id", "kind", "check_id",
                        }
                        or response.get("id") != command_id
                        or type(check_id) is not int
                        or check_id < 1):
                    self._hard_stop()
                    raise RuntimeError("douyin_browser_protocol_error")
                authority_ok = False
                if authority_validator is not None:
                    try:
                        authority_validator()
                        authority_ok = True
                    except Exception:
                        authority_ok = False
                try:
                    self._connection.send({
                        "id": command_id,
                        "kind": (
                            "authority_ok" if authority_ok
                            else "authority_failed"
                        ),
                        "check_id": check_id,
                    })
                except (BrokenPipeError, EOFError, OSError) as error:
                    self._hard_stop()
                    raise RuntimeError(
                        "douyin_browser_unavailable"
                    ) from error
            if response.get("id") != command_id:
                self._hard_stop()
                raise RuntimeError("douyin_browser_protocol_error")
            if response.get("kind") == "action_failure":
                code = response.get("code")
                if (operation not in {"action", "reconcile"}
                        or set(response) != {"id", "kind", "code"}
                        or not isinstance(code, str)
                        or code not in _CLOSED_ACTION_FAILURE_CODES):
                    self._hard_stop()
                    raise RuntimeError("douyin_browser_protocol_error")
                raise DouyinActionFailure(code)
            if response.get("kind") == "error":
                raise RuntimeError(
                    str(response.get("message") or "douyin_browser_command_failed")
                )
            if response.get("kind") != "ok":
                self._hard_stop()
                raise RuntimeError("douyin_browser_protocol_error")
            return response.get("value")

    def open_douyin_login(self, profile_path: Path) -> dict[str, object]:
        return self._call("open", profile_path=str(profile_path))  # type: ignore[return-value]

    def poll_douyin_login(self, context: object) -> dict[str, object]:
        return self._call("poll", handle=self._handle(context))  # type: ignore[return-value]

    def close(self, context: object) -> None:
        self._call("close", handle=self._handle(context))

    def execute_douyin_action(self, profile_path: Path,
                              request: ActionRequest, *,
                              authority_validator: Callable[[], None] | None = None,
                              ) -> dict[str, object]:
        _require_visible_action_browser(self._headless)
        return self._call("action", authority_validator=authority_validator,
                          profile_path=str(profile_path),
                          request=request.model_dump(mode="json"))  # type: ignore[return-value]

    def reconcile_douyin_action(self, profile_path: Path,
                                request: ActionRequest, *,
                                authority_validator: Callable[[], None] | None = None,
                                ) -> dict[str, object]:
        _require_visible_action_browser(self._headless)
        return self._call(
            "reconcile",
            authority_validator=authority_validator,
            profile_path=str(profile_path),
            request=request.model_dump(mode="json"),
        )  # type: ignore[return-value]

    def close_browser(self) -> None:
        with self._lock:
            if self._closed:
                if self._shutdown_failed:
                    raise RuntimeError("douyin_browser_shutdown_failed")
                return
            self._closed = True
            try:
                self._connection.send(
                    {"id": self._next_command_id, "operation": "shutdown"}
                )
            except (BrokenPipeError, EOFError, OSError):
                self._hard_stop()
                raise RuntimeError("douyin_browser_shutdown_failed")
            if not self._connection.poll(self._timeout):
                self._hard_stop()
                raise RuntimeError("douyin_browser_shutdown_timeout")
            try:
                response = self._connection.recv()
            except (EOFError, OSError):
                self._hard_stop()
                raise RuntimeError("douyin_browser_shutdown_failed")
            failed = response.get("kind") != "shutdown_ok"
            self._shutdown_failed = failed
            self._process.join(timeout=self._timeout)
            if self._process.is_alive():
                self._hard_stop()
                code = (
                    "douyin_browser_shutdown_failed"
                    if failed else "douyin_browser_shutdown_timeout"
                )
                raise RuntimeError(code)
            self._connection.close()
            self._process.close()
            if failed:
                raise RuntimeError("douyin_browser_shutdown_failed")
