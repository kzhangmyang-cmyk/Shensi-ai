"""Private, process-owned Playwright boundary for MediaCrawler login state."""

from __future__ import annotations

import base64
import logging
import multiprocessing
import os
import re
import secrets
import select
import shutil
import signal
import socket
import subprocess
import sys
import threading
import time
from collections.abc import Callable
from io import BytesIO
from multiprocessing.connection import Connection
from pathlib import Path
from typing import Protocol
from urllib.parse import urlsplit

from PIL import Image
from pydantic import TypeAdapter

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
from .douyin_spider_private_message import (
    DouyinSpiderPrivateMessageExecutor,
)
from .schemas import (
    ActionReconciliationRequest,
    ActionRequest,
    LoginInteractionRequest,
)
from .visual_locator import (
    VisualLocator,
    configured_visual_locator,
    create_visual_locator,
)


LOGGER = logging.getLogger(__name__)
DEFAULT_ACTION_MANUAL_VERIFICATION_SECONDS = 120
MIN_ACTION_MANUAL_VERIFICATION_SECONDS = 30
MAX_ACTION_MANUAL_VERIFICATION_SECONDS = 300
ACTION_DEADLINE_OVERHEAD_SECONDS = 30
ACTION_IPC_OVERHEAD_SECONDS = 20
ACTION_AUTHORITY_CHECK_TIMEOUT_SECONDS = 5
ACTION_RESULT_REVIEW_MS = 10_000
IDENTITY_DOM_ATTEMPTS = 9
IDENTITY_DOM_POLL_MS = 250
LOGIN_NAVIGATION_ATTEMPTS = 3
LOGIN_NAVIGATION_TIMEOUT_MS = 10_000
LOGIN_NAVIGATION_RETRY_DELAY_MS = 500
LOGIN_PANEL_WAIT_MS = 5_000
LOGIN_QR_WAIT_MS = 25_000
LOGIN_QR_POLL_MS = 250
LOGIN_QR_CAPTURE_TIMEOUT_MS = 5_000
DEFAULT_BROWSER_COMMAND_TIMEOUT_SECONDS = 65
LOGIN_VIEWPORT_WIDTH = 1280
LOGIN_VIEWPORT_HEIGHT = 800
LOGIN_JPEG_QUALITY = 80
LIVE_DISPLAY_STARTUP_TIMEOUT_SECONDS = 8
LIVE_PROCESS_STOP_TIMEOUT_SECONDS = 2
DOUYIN_LOGIN_ALLOWED_HOSTS = frozenset({
    "douyin.com",
    "www.douyin.com",
    "passport.douyin.com",
    "open.douyin.com",
})
DOUYIN_LOGIN_PANEL_SELECTORS = (
    "#login-panel-new",
    "#login-pannel",
    '[id^="login-full-panel-"]',
)
DOUYIN_LOGIN_BUTTON_SELECTORS = (
    'button:has-text("登录")',
    '[role="button"]:has-text("登录")',
    "xpath=//p[text() = '登录']",
)
DOUYIN_LOGIN_QR_TAB_SELECTORS = (
    'button:has-text("扫码登录")',
    '[role="tab"]:has-text("扫码登录")',
    '[role="button"]:has-text("扫码登录")',
)
DOUYIN_LOGIN_QR_CONTAINER_SELECTOR = "#animate_qrcode_container"
DOUYIN_LOGIN_QR_SELECTORS = (
    # Douyin's current login panel renders the QR bitmap as an SVG <image>
    # without an HTML src attribute. Keep the selector panel-scoped so other
    # page artwork cannot be mistaken for the login QR; _visible_locator also
    # rejects more than one visible match.
    "#login-panel-new svg image",
    "#login-pannel svg image",
    '[id^="login-full-panel-"] svg image',
    "#animate_qrcode_container img",
    "#animate_qrcode_container canvas",
    'img[aria-label="二维码"]',
    'img[alt="二维码"]',
    'canvas[aria-label="二维码"]',
    'svg[aria-label="二维码"]',
)
DOUYIN_VERIFICATION_SELECTORS = (
    "#captcha_container",
    "#captcha-verify-image",
    'iframe[src*="captcha"]',
    'iframe[src*="verify"]',
    '[data-e2e="verification"]',
)
DOUYIN_QR_EXPIRED_TEXT = "二维码失效"
DOUYIN_NETWORK_ERROR_TEXT = "当前网络异常"
_LOGIN_QR_LOG_STAGES = frozenset({
    "open_result",
    "poll_transition",
    "refresh_result",
})
_LOGIN_QR_LOG_STATUSES = frozenset({
    "opening",
    "ready",
    "expired",
    "network_error",
    "verification_required",
    "active",
    "unknown",
})
_LOGIN_QR_REFRESH_ENTRIES = frozenset({"open", "interaction"})
_LOGIN_QR_REFRESH_OUTCOMES = frozenset({
    "clicked",
    "unavailable",
    "click_failed",
})
_REFRESH_NETWORK_RESOURCE_TYPES = frozenset({
    "document",
    "stylesheet",
    "image",
    "media",
    "font",
    "script",
    "texttrack",
    "xhr",
    "fetch",
    "eventsource",
    "websocket",
    "manifest",
    "other",
})
_REFRESH_NETWORK_MAX_GROUPS = 16
_REFRESH_NETWORK_MAX_COUNT = 10_000
_REFRESH_TIMING_STAGES = frozenset({
    "start",
    "status_before",
    "reload",
    "status_after_reload",
    "expired_refresh",
    "panel_probe",
    "open_login",
    "panel_reprobe",
    "activate_qr",
    "wait_qr",
    "capture_page",
    "finish",
})


def _log_login_qr_diagnostic(
    *,
    stage: str,
    status: object,
    poll_count: int,
    refresh_count: int,
) -> None:
    safe_stage = stage if stage in _LOGIN_QR_LOG_STAGES else "poll_transition"
    safe_status = (
        status
        if isinstance(status, str) and status in _LOGIN_QR_LOG_STATUSES
        else "unknown"
    )
    LOGGER.info(
        "douyin_login_qr stage=%s status=%s poll_count=%d refresh_count=%d",
        safe_stage,
        safe_status,
        max(poll_count, 0),
        max(refresh_count, 0),
    )


def _log_expired_qr_refresh_diagnostic(
    *,
    entry: str,
    outcome: str,
) -> None:
    safe_entry = (
        entry if entry in _LOGIN_QR_REFRESH_ENTRIES else "interaction"
    )
    safe_outcome = (
        outcome
        if outcome in _LOGIN_QR_REFRESH_OUTCOMES
        else "unavailable"
    )
    LOGGER.info(
        "douyin_login_qr_refresh entry=%s outcome=%s",
        safe_entry,
        safe_outcome,
    )


def _log_refresh_timing(
    *,
    stage: str,
    started_at: float,
    diagnostic_timeout_ms: int,
    observed_at: float | None = None,
) -> None:
    safe_stage = stage if stage in _REFRESH_TIMING_STAGES else "finish"
    now = time.monotonic() if observed_at is None else observed_at
    elapsed_ms = max(0, int(round((now - started_at) * 1_000)))
    remaining_ms = max(0, diagnostic_timeout_ms - elapsed_ms)
    LOGGER.info(
        "douyin_login_refresh_timing stage=%s elapsed_ms=%d remaining_ms=%d",
        safe_stage,
        elapsed_ms,
        remaining_ms,
    )


class _RefreshNetworkDiagnostic:
    def __init__(self, page: object) -> None:
        self._page = page
        self._phase = "before"
        self._listeners: list[tuple[str, Callable[[object], None]]] = []
        self._counts: dict[tuple[str, str, str, str, object], int] = {}
        self._callbacks = {
            "response": self._record_response,
            "requestfailed": self._record_failed_request,
        }

    @staticmethod
    def _hostname(value: object) -> str:
        if not isinstance(value, str):
            return "unknown"
        try:
            hostname = urlsplit(value).hostname
        except Exception:
            return "unknown"
        if not isinstance(hostname, str):
            return "unknown"
        try:
            normalized = hostname.encode("idna").decode("ascii").lower()
        except (UnicodeError, ValueError):
            return "unknown"
        if (not normalized or len(normalized) > 253
                or re.fullmatch(r"[a-z0-9.-]+", normalized) is None):
            return "unknown"
        if normalized == "douyin.com" or normalized.endswith(".douyin.com"):
            return normalized
        return "other"

    @staticmethod
    def _resource_type(value: object) -> str:
        return (
            value
            if isinstance(value, str)
            and value in _REFRESH_NETWORK_RESOURCE_TYPES
            else "other"
        )

    @staticmethod
    def _failure_code(value: object) -> str:
        if (isinstance(value, str)
                and re.fullmatch(r"net::ERR_[A-Z0-9_]+", value)):
            return value
        return "net::ERR_FAILED"

    def _increment(
        self,
        *,
        hostname: str,
        resource_type: str,
        kind: str,
        value: object,
    ) -> None:
        key = (self._phase, hostname, resource_type, kind, value)
        if key in self._counts:
            self._counts[key] = min(
                self._counts[key] + 1,
                _REFRESH_NETWORK_MAX_COUNT,
            )
        elif len(self._counts) < _REFRESH_NETWORK_MAX_GROUPS:
            self._counts[key] = 1

    def _record_failed_request(self, request: object) -> None:
        try:
            self._increment(
                hostname=self._hostname(getattr(request, "url", None)),
                resource_type=self._resource_type(
                    getattr(request, "resource_type", None)
                ),
                kind="error",
                value=self._failure_code(getattr(request, "failure", None)),
            )
        except BaseException:
            return

    def _record_response(self, response: object) -> None:
        try:
            status = getattr(response, "status", None)
            if type(status) is not int or not 100 <= status <= 599:
                return
            request = getattr(response, "request", None)
            self._increment(
                hostname=self._hostname(getattr(response, "url", None)),
                resource_type=self._resource_type(
                    getattr(request, "resource_type", None)
                ),
                kind="status",
                value=status,
            )
        except BaseException:
            return

    def start(self) -> None:
        for event, callback in self._callbacks.items():
            try:
                self._page.on(event, callback)  # type: ignore[attr-defined]
            except BaseException:
                continue
            self._listeners.append((event, callback))

    def mark_after(self) -> None:
        self._phase = "after"

    def finish(self) -> None:
        for event, callback in self._listeners:
            try:
                self._page.remove_listener(  # type: ignore[attr-defined]
                    event,
                    callback,
                )
            except BaseException:
                continue
        if not self._listeners:
            return
        for phase in ("before", "after"):
            phase_items = sorted(
                (
                    (key, count)
                    for key, count in self._counts.items()
                    if key[0] == phase
                ),
                key=lambda item: tuple(str(value) for value in item[0]),
            )
            if not phase_items:
                LOGGER.info(
                    "douyin_login_refresh_network phase=%s hostname=none "
                    "resource_type=other count=0",
                    phase,
                )
                continue
            for key, count in phase_items:
                _phase, hostname, resource_type, kind, value = key
                if kind == "error":
                    LOGGER.info(
                        "douyin_login_refresh_network phase=%s hostname=%s "
                        "resource_type=%s error=%s count=%d",
                        phase,
                        hostname,
                        resource_type,
                        value,
                        count,
                    )
                elif kind == "status":
                    LOGGER.info(
                        "douyin_login_refresh_network phase=%s hostname=%s "
                        "resource_type=%s status=%d count=%d",
                        phase,
                        hostname,
                        resource_type,
                        value,
                        count,
                    )


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
_CLOSED_LOGIN_OPEN_STAGES = frozenset({
    "live_display_start",
    "browser_context_open",
    "browser_launch",
    "browser_page_open",
    "douyin_navigation",
    "login_page_capture",
})
_CLOSED_LOGIN_OPEN_ERROR_CODES = frozenset({
    "douyin_browser_unavailable",
    "douyin_browser_command_timeout",
    "douyin_live_display_unavailable",
    "douyin_live_vnc_unavailable",
    "douyin_login_open_failed",
    "douyin_login_page_not_allowed",
    "douyin_login_page_unavailable",
    "douyin_login_ui_unsupported",
    "douyin_verification_required",
})


class DouyinLoginOpenFailure(RuntimeError):
    """A redacted, closed diagnostic from the browser worker."""

    def __init__(self, stage: str, error_code: str) -> None:
        self.stage = (
            stage
            if type(stage) is str and stage in _CLOSED_LOGIN_OPEN_STAGES
            else "browser_context_open"
        )
        self.error_code = (
            error_code
            if type(error_code) is str
            and error_code in _CLOSED_LOGIN_OPEN_ERROR_CODES
            else "douyin_login_open_failed"
        )
        super().__init__(self.error_code)


def _safe_login_open_error_code(
    error: BaseException,
    stage: str,
) -> str:
    try:
        candidate = str(error)
    except BaseException:
        candidate = ""
    if candidate in _CLOSED_LOGIN_OPEN_ERROR_CODES:
        return candidate
    if stage == "live_display_start":
        return "douyin_live_display_unavailable"
    return "douyin_login_open_failed"


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
    interaction_surface: str

    def open_douyin_login(self, profile_path: Path) -> dict[str, object]: ...
    def prepare_douyin_login(self, context: object) -> dict[str, object]: ...
    def live_vnc_port(self, context: object) -> int: ...
    def close(self, context: object) -> None: ...
    def poll_douyin_login(self, context: object) -> dict[str, object]: ...
    def interact_douyin_login(
        self,
        context: object,
        request: LoginInteractionRequest,
    ) -> dict[str, object]: ...
    def execute_douyin_action(self, profile_path: Path,
                              request: ActionRequest, *,
                              authority_validator: Callable[[], None]
                              ) -> dict[str, object]: ...
    def reconcile_douyin_action(self, profile_path: Path,
                                request: ActionRequest, *,
                                authority_validator: Callable[[], None]
                                ) -> dict[str, object]: ...


def _stop_live_process(process: subprocess.Popen[bytes] | None) -> None:
    if process is None or process.poll() is not None:
        return
    process.terminate()
    try:
        process.wait(timeout=LIVE_PROCESS_STOP_TIMEOUT_SECONDS)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=LIVE_PROCESS_STOP_TIMEOUT_SECONDS)


class _LiveDisplay:
    def __init__(
        self,
        display: str,
        vnc_port: int,
        xvfb_process: subprocess.Popen[bytes],
        vnc_process: subprocess.Popen[bytes],
    ) -> None:
        self.display = display
        self.vnc_port = vnc_port
        self._xvfb_process = xvfb_process
        self._vnc_process = vnc_process
        self._closed = False

    def browser_environment(self) -> dict[str, str]:
        return {**os.environ, "DISPLAY": self.display}

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        failures: list[BaseException] = []
        for process in (self._vnc_process, self._xvfb_process):
            try:
                _stop_live_process(process)
            except BaseException as error:
                failures.append(error)
        if len(failures) == 1:
            raise failures[0]
        if failures:
            raise BaseExceptionGroup("douyin_live_display_cleanup_failed", failures)


class _ManagedLoginContext:
    def __init__(self, context: object, live_display: object) -> None:
        self._context = context
        self._live_display = live_display
        self.vnc_port = live_display.vnc_port
        self._closed = False

    def __getattr__(self, name: str) -> object:
        return getattr(self._context, name)

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        failures: list[BaseException] = []
        try:
            self._context.close()  # type: ignore[attr-defined]
        except BaseException as error:
            failures.append(error)
        try:
            self._live_display.close()  # type: ignore[attr-defined]
        except BaseException as error:
            failures.append(error)
        if len(failures) == 1:
            raise failures[0]
        if failures:
            raise BaseExceptionGroup("douyin_login_context_cleanup_failed", failures)


def _read_xvfb_display(
    descriptor: int,
    process: subprocess.Popen[bytes],
) -> str:
    deadline = time.monotonic() + LIVE_DISPLAY_STARTUP_TIMEOUT_SECONDS
    payload = b""
    while time.monotonic() < deadline and b"\n" not in payload:
        if process.poll() is not None:
            break
        readable, _, _ = select.select(
            [descriptor],
            [],
            [],
            max(0.0, deadline - time.monotonic()),
        )
        if not readable:
            break
        chunk = os.read(descriptor, 32)
        if not chunk:
            break
        payload += chunk
    raw_display = payload.partition(b"\n")[0].decode("ascii", "strict")
    if re.fullmatch(r"[0-9]+", raw_display) is None:
        raise RuntimeError("douyin_live_display_unavailable")
    return f":{raw_display}"


def _reserve_loopback_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
        listener.bind(("127.0.0.1", 0))
        return int(listener.getsockname()[1])


def _wait_for_vnc_listener(
    process: subprocess.Popen[bytes],
    port: int,
) -> None:
    deadline = time.monotonic() + LIVE_DISPLAY_STARTUP_TIMEOUT_SECONDS
    while time.monotonic() < deadline:
        if process.poll() is not None:
            break
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.2):
                return
        except OSError:
            time.sleep(0.05)
    raise RuntimeError("douyin_live_vnc_unavailable")


def _start_live_display() -> _LiveDisplay:
    if not sys.platform.startswith("linux"):
        raise RuntimeError("douyin_live_display_unavailable")
    xvfb_binary = shutil.which("Xvfb")
    vnc_binary = shutil.which("x11vnc")
    if xvfb_binary is None or vnc_binary is None:
        raise RuntimeError("douyin_live_display_unavailable")

    read_descriptor, write_descriptor = os.pipe()
    xvfb_process: subprocess.Popen[bytes] | None = None
    vnc_process: subprocess.Popen[bytes] | None = None
    try:
        xvfb_process = subprocess.Popen(
            [
                xvfb_binary,
                "-displayfd",
                str(write_descriptor),
                "-screen",
                "0",
                f"{LOGIN_VIEWPORT_WIDTH}x{LOGIN_VIEWPORT_HEIGHT}x24",
                "-ac",
                "-nolisten",
                "tcp",
            ],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            close_fds=True,
            pass_fds=(write_descriptor,),
        )
        os.close(write_descriptor)
        write_descriptor = -1
        display = _read_xvfb_display(read_descriptor, xvfb_process)
        port = _reserve_loopback_port()
        environment = {**os.environ, "DISPLAY": display}
        vnc_process = subprocess.Popen(
            [
                vnc_binary,
                "-display",
                display,
                "-rfbport",
                str(port),
                "-localhost",
                "-forever",
                "-shared",
                "-nopw",
                "-noxdamage",
                "-quiet",
            ],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            env=environment,
        )
        _wait_for_vnc_listener(vnc_process, port)
        return _LiveDisplay(display, port, xvfb_process, vnc_process)
    except BaseException:
        _stop_live_process(vnc_process)
        _stop_live_process(xvfb_process)
        raise
    finally:
        os.close(read_descriptor)
        if write_descriptor >= 0:
            os.close(write_descriptor)


def _start_playwright(factory: Callable[[], object] | None) -> object:
    if factory is not None:
        return factory()
    from playwright.sync_api import sync_playwright

    return sync_playwright().start()


def _launch_options(
    headless: bool,
    browser_channel: str | None,
    browser_proxy: str | None = None,
    *,
    interaction_surface: str = "remote_canvas",
) -> dict[str, object]:
    options: dict[str, object] = {
        "headless": headless,
        # The isolated runtime provisions a dedicated 1 GiB /dev/shm. Let
        # Chromium use it instead of Playwright's /tmp fallback, which can
        # terminate a Douyin page once the bounded /tmp tmpfs fills up.
        "ignore_default_args": ["--disable-dev-shm-usage"],
    }
    if interaction_surface == "external_window" and sys.platform == "darwin":
        options["chromium_sandbox"] = True
    if browser_channel:
        options["channel"] = browser_channel
    if browser_proxy:
        options["proxy"] = {"server": browser_proxy}
    else:
        options["args"] = ["--no-proxy-server"]
    return options


def _visible_locator(page: object, selectors: tuple[str, ...]) -> object | None:
    for selector in selectors:
        locator = page.locator(selector)  # type: ignore[attr-defined]
        try:
            count = min(locator.count(), 2)
        except Exception:
            continue
        visible = []
        for index in range(count):
            try:
                candidate = locator.nth(index)
                if candidate.is_visible():
                    visible.append(candidate)
            except Exception:
                continue
        if len(visible) > 1:
            raise RuntimeError("douyin_login_ui_unsupported")
        if visible:
            return visible[0]
    return None


def _verification_required(page: object) -> bool:
    try:
        title = page.title()  # type: ignore[attr-defined]
        if isinstance(title, str) and "验证码" in title:
            return True
    except Exception:
        pass
    return _visible_locator(page, DOUYIN_VERIFICATION_SELECTORS) is not None


def _login_page_text(page: object) -> str:
    try:
        value = page.locator("body").inner_text(  # type: ignore[attr-defined]
            timeout=1_000
        )
    except Exception:
        return ""
    return value if isinstance(value, str) else ""


def _non_ready_qr_status(page: object) -> str | None:
    if _verification_required(page):
        return "verification_required"
    text = _login_page_text(page)
    if DOUYIN_NETWORK_ERROR_TEXT in text:
        return "network_error"
    if DOUYIN_QR_EXPIRED_TEXT in text:
        return "expired"
    return None


def _non_ready_qr_status_before_deadline(
    page: object,
    deadline: float,
) -> str | None:
    try:
        title = page.title()  # type: ignore[attr-defined]
        if isinstance(title, str) and "验证码" in title:
            return "verification_required"
    except Exception:
        pass
    if _remaining_deadline_ms(deadline) <= 0:
        return None
    if _visible_locator_before_deadline(
        page,
        DOUYIN_VERIFICATION_SELECTORS,
        deadline,
    ) is not None:
        return "verification_required"
    remaining_ms = _remaining_deadline_ms(deadline)
    if remaining_ms <= 0:
        return None
    try:
        value = page.locator("body").inner_text(  # type: ignore[attr-defined]
            timeout=min(1_000, remaining_ms)
        )
    except Exception:
        return None
    text = value if isinstance(value, str) else ""
    if DOUYIN_NETWORK_ERROR_TEXT in text:
        return "network_error"
    if DOUYIN_QR_EXPIRED_TEXT in text:
        return "expired"
    return None


def _visible_exact_text_locator(page: object, text: str) -> object | None:
    try:
        locator = page.get_by_text(  # type: ignore[attr-defined]
            text,
            exact=True,
        )
        count = locator.count()
    except Exception:
        return None
    if count > 2:
        return None
    visible = []
    for index in range(count):
        try:
            candidate = locator.nth(index)
            if candidate.is_visible():
                visible.append(candidate)
        except Exception:
            return None
    if len(visible) > 1:
        return None
    return visible[0] if visible else None


def _click_expired_qr_refresh(page: object) -> bool:
    locator = _visible_exact_text_locator(page, "点击刷新")
    if locator is None:
        return False
    locator.click(timeout=5_000)  # type: ignore[attr-defined]
    return True


def _attempt_expired_qr_refresh(page: object, *, entry: str) -> bool:
    try:
        clicked = _click_expired_qr_refresh(page)
    except BaseException:
        _log_expired_qr_refresh_diagnostic(
            entry=entry,
            outcome="click_failed",
        )
        raise
    _log_expired_qr_refresh_diagnostic(
        entry=entry,
        outcome="clicked" if clicked else "unavailable",
    )
    return clicked


def _wait_for_refreshed_qr(page: object) -> tuple[str, str | None]:
    deadline = time.monotonic() + LOGIN_QR_WAIT_MS / 1_000
    last_status: str | None = None
    while time.monotonic() < deadline:
        qr_status = _non_ready_qr_status_before_deadline(page, deadline)
        last_status = qr_status
        if qr_status in {"network_error", "verification_required"}:
            return qr_status, None
        if qr_status != "expired":
            qr_image_data_url = _capture_visible_qr_image_before_deadline(
                page, deadline
            )
            if qr_image_data_url is not None:
                return "ready", qr_image_data_url
        remaining_ms = int((deadline - time.monotonic()) * 1_000)
        if remaining_ms <= 0:
            break
        page.wait_for_timeout(  # type: ignore[attr-defined]
            min(LOGIN_QR_POLL_MS, remaining_ms)
        )
    return ("expired" if last_status == "expired" else "opening"), None


def _wait_for_login_panel(page: object) -> bool:
    for index, selector in enumerate(DOUYIN_LOGIN_PANEL_SELECTORS):
        try:
            page.locator(selector).wait_for(  # type: ignore[attr-defined]
                state="visible",
                timeout=LOGIN_PANEL_WAIT_MS if index == 0 else 1_000,
            )
            return True
        except Exception:
            if _verification_required(page):
                raise RuntimeError("douyin_verification_required") from None
    return False


def _click_login_button(page: object) -> None:
    for selector in DOUYIN_LOGIN_BUTTON_SELECTORS:
        locator = _visible_locator(page, (selector,))
        if locator is None:
            continue
        try:
            locator.click(timeout=10_000)  # type: ignore[attr-defined]
            return
        except Exception:
            if _visible_locator(page, DOUYIN_LOGIN_PANEL_SELECTORS) is not None:
                return
            if _verification_required(page):
                raise RuntimeError("douyin_verification_required") from None
    try:
        page.get_by_text("登录", exact=True).last.click(  # type: ignore[attr-defined]
            timeout=10_000
        )
        return
    except Exception:
        if _visible_locator(page, DOUYIN_LOGIN_PANEL_SELECTORS) is not None:
            return
        if _verification_required(page):
            raise RuntimeError("douyin_verification_required") from None
        raise RuntimeError("douyin_login_ui_unsupported") from None


def _activate_qr_login(page: object) -> None:
    if _visible_locator(page, DOUYIN_LOGIN_QR_SELECTORS) is not None:
        return
    for selector in DOUYIN_LOGIN_QR_TAB_SELECTORS:
        locator = _visible_locator(page, (selector,))
        if locator is None:
            continue
        try:
            locator.click(timeout=5_000)  # type: ignore[attr-defined]
            return
        except Exception:
            if _verification_required(page):
                raise RuntimeError("douyin_verification_required") from None
    try:
        locator = page.get_by_text(  # type: ignore[attr-defined]
            "扫码登录", exact=True
        ).last
        if locator.is_visible():
            locator.click(timeout=5_000)
    except Exception:
        if _verification_required(page):
            raise RuntimeError("douyin_verification_required") from None


def _qr_image_data_url(
    page: object,
    locator: object,
    *,
    capture_timeout_ms: int = LOGIN_QR_CAPTURE_TIMEOUT_MS,
) -> str:
    source = locator.get_attribute("src") or ""  # type: ignore[attr-defined]
    if isinstance(source, str) and source.startswith("data:image/"):
        return source
    if source:
        try:
            fetched = page.evaluate(  # type: ignore[attr-defined]
                """async (source) => {
                  const response = await fetch(source); const blob = await response.blob();
                  return await new Promise((resolve) => { const reader = new FileReader();
                    reader.onload = () => resolve(reader.result); reader.readAsDataURL(blob); });
                }""",
                source,
            )
            if isinstance(fetched, str) and fetched.startswith("data:image/"):
                return fetched
        except Exception:
            pass
    try:
        embedded = locator.evaluate(  # type: ignore[attr-defined]
            """element => {
              if (element.tagName === "CANVAS"
                  && typeof element.toDataURL === "function") {
                return element.toDataURL("image/png");
              }
              if (element.tagName === "SVG") {
                const serialized = new XMLSerializer().serializeToString(element);
                const bytes = new TextEncoder().encode(serialized);
                let binary = "";
                for (const byte of bytes) binary += String.fromCharCode(byte);
                return `data:image/svg+xml;base64,${btoa(binary)}`;
              }
              return null;
            }"""
        )
        if isinstance(embedded, str) and embedded.startswith("data:image/"):
            return embedded
    except Exception:
        pass
    try:
        screenshot = locator.screenshot(  # type: ignore[attr-defined]
            timeout=capture_timeout_ms
        )
    except Exception:
        raise RuntimeError("douyin_qr_image_unavailable") from None
    if not isinstance(screenshot, bytes) or not screenshot:
        raise RuntimeError("douyin_qr_image_unavailable")
    return "data:image/png;base64," + base64.b64encode(screenshot).decode("ascii")


def _qr_screenshot_has_modules(screenshot: bytes) -> bool:
    try:
        with Image.open(BytesIO(screenshot)) as source:
            image = source.convert("L")
    except Exception:
        return False
    width, height = image.size
    if (min(width, height) < 100 or max(width, height) > 600
            or abs(width - height) > max(width, height) * 0.2):
        return False
    pixels = image.load()
    left_end, right_start = int(width * 0.45), int(width * 0.55)
    top_end, bottom_start = int(height * 0.45), int(height * 0.55)
    quadrants = (
        (0, left_end, 0, top_end),
        (right_start, width, 0, top_end),
        (0, left_end, bottom_start, height),
        (right_start, width, bottom_start, height),
    )
    for x_start, x_end, y_start, y_end in quadrants:
        total = max((x_end - x_start) * (y_end - y_start), 1)
        dark = sum(
            1
            for y in range(y_start, y_end)
            for x in range(x_start, x_end)
            if pixels[x, y] < 180
        )
        if dark / total < 0.02:
            return False
    return True


def _css_qr_container_data_url(
    page: object,
    *,
    capture_timeout_ms: int = LOGIN_QR_CAPTURE_TIMEOUT_MS,
) -> str | None:
    locator = _visible_locator(page, (DOUYIN_LOGIN_QR_CONTAINER_SELECTOR,))
    if locator is None:
        return None
    try:
        screenshot = locator.screenshot(  # type: ignore[attr-defined]
            timeout=capture_timeout_ms
        )
    except Exception:
        return None
    if not isinstance(screenshot, bytes) or not _qr_screenshot_has_modules(
        screenshot
    ):
        return None
    return "data:image/png;base64," + base64.b64encode(screenshot).decode(
        "ascii"
    )


def _generic_qr_locator(page: object) -> object | None:
    locator = page.locator("img, canvas, svg")  # type: ignore[attr-defined]
    try:
        count = min(locator.count(), 200)
    except Exception:
        return None
    candidates = []
    for index in range(count):
        try:
            candidate = locator.nth(index)
            if not candidate.is_visible():
                continue
            metadata = candidate.evaluate(
                """el => {
                  const rect = el.getBoundingClientRect();
                  let hinted = false;
                  for (let node = el, depth = 0;
                       node && depth < 5;
                       node = node.parentElement, depth += 1) {
                    const marker = [node.id, node.className,
                      node.getAttribute?.("aria-label"), node.innerText]
                      .filter((value) => typeof value === "string")
                      .join(" ");
                    if (/扫码|二维码|qrcode|qr[-_]?code/i.test(marker)) {
                      hinted = true; break;
                    }
                  }
                  return { tag: el.tagName, source: el.getAttribute("src") || "",
                    width: rect.width, height: rect.height, hinted };
                }"""
            )
            if not isinstance(metadata, dict):
                continue
            width = metadata.get("width")
            height = metadata.get("height")
            source = metadata.get("source")
            if not isinstance(width, (int, float)) or not isinstance(
                height, (int, float)
            ):
                continue
            longest = max(width, height)
            if (min(width, height) < 100 or longest > 600
                    or abs(width - height) > longest * 0.2):
                continue
            if metadata.get("hinted") is True or (
                isinstance(source, str) and source.startswith("data:image/")
            ):
                candidates.append(candidate)
        except Exception:
            continue
    if len(candidates) > 1:
        raise RuntimeError("douyin_login_ui_unsupported")
    return candidates[0] if candidates else None


def _remaining_deadline_ms(deadline: float) -> int:
    return max(0, int((deadline - time.monotonic()) * 1_000))


def _bounded_capture_timeout_ms(deadline: float) -> int:
    return min(
        LOGIN_QR_CAPTURE_TIMEOUT_MS,
        _remaining_deadline_ms(deadline),
    )


def _visible_locator_before_deadline(
    page: object,
    selectors: tuple[str, ...],
    deadline: float,
) -> object | None:
    for selector in selectors:
        if _remaining_deadline_ms(deadline) <= 0:
            return None
        locator = page.locator(selector)  # type: ignore[attr-defined]
        try:
            count = min(locator.count(), 2)
        except Exception:
            continue
        visible = []
        for index in range(count):
            timeout_ms = _bounded_capture_timeout_ms(deadline)
            if timeout_ms <= 0:
                return None
            try:
                candidate = locator.nth(index)
                if candidate.is_visible(timeout=timeout_ms):
                    visible.append(candidate)
            except Exception:
                continue
        if len(visible) > 1:
            raise RuntimeError("douyin_login_ui_unsupported")
        if visible:
            return visible[0]
    return None


def _qr_image_data_url_before_deadline(
    locator: object,
    deadline: float,
) -> str:
    timeout_ms = _bounded_capture_timeout_ms(deadline)
    if timeout_ms <= 0:
        raise RuntimeError("douyin_qr_image_unavailable")
    try:
        source = locator.get_attribute(  # type: ignore[attr-defined]
            "src",
            timeout=timeout_ms,
        ) or ""
    except Exception:
        source = ""
    if isinstance(source, str) and source.startswith("data:image/"):
        return source

    timeout_ms = _bounded_capture_timeout_ms(deadline)
    if timeout_ms <= 0:
        raise RuntimeError("douyin_qr_image_unavailable")
    try:
        embedded = locator.evaluate(  # type: ignore[attr-defined]
            """element => {
              if (element.tagName === "CANVAS"
                  && typeof element.toDataURL === "function") {
                return element.toDataURL("image/png");
              }
              if (element.tagName === "SVG") {
                const serialized = new XMLSerializer().serializeToString(element);
                const bytes = new TextEncoder().encode(serialized);
                let binary = "";
                for (const byte of bytes) binary += String.fromCharCode(byte);
                return `data:image/svg+xml;base64,${btoa(binary)}`;
              }
              return null;
            }""",
            timeout=timeout_ms,
        )
        if isinstance(embedded, str) and embedded.startswith("data:image/"):
            return embedded
    except Exception:
        pass

    timeout_ms = _bounded_capture_timeout_ms(deadline)
    if timeout_ms <= 0:
        raise RuntimeError("douyin_qr_image_unavailable")
    try:
        screenshot = locator.screenshot(  # type: ignore[attr-defined]
            timeout=timeout_ms
        )
    except Exception:
        raise RuntimeError("douyin_qr_image_unavailable") from None
    if not isinstance(screenshot, bytes) or not screenshot:
        raise RuntimeError("douyin_qr_image_unavailable")
    return "data:image/png;base64," + base64.b64encode(screenshot).decode(
        "ascii"
    )


def _css_qr_container_data_url_before_deadline(
    page: object,
    deadline: float,
) -> str | None:
    locator = _visible_locator_before_deadline(
        page,
        (DOUYIN_LOGIN_QR_CONTAINER_SELECTOR,),
        deadline,
    )
    if locator is None:
        return None
    timeout_ms = _bounded_capture_timeout_ms(deadline)
    if timeout_ms <= 0:
        return None
    try:
        screenshot = locator.screenshot(  # type: ignore[attr-defined]
            timeout=timeout_ms
        )
    except Exception:
        return None
    if not isinstance(screenshot, bytes) or not _qr_screenshot_has_modules(
        screenshot
    ):
        return None
    return "data:image/png;base64," + base64.b64encode(screenshot).decode(
        "ascii"
    )


def _generic_qr_locator_before_deadline(
    page: object,
    deadline: float,
) -> object | None:
    if _remaining_deadline_ms(deadline) <= 0:
        return None
    locator = page.locator("img, canvas, svg")  # type: ignore[attr-defined]
    try:
        count = min(locator.count(), 200)
    except Exception:
        return None
    candidates = []
    for index in range(count):
        timeout_ms = _bounded_capture_timeout_ms(deadline)
        if timeout_ms <= 0:
            return None
        try:
            candidate = locator.nth(index)
            if not candidate.is_visible(timeout=timeout_ms):
                continue
            timeout_ms = _bounded_capture_timeout_ms(deadline)
            if timeout_ms <= 0:
                return None
            metadata = candidate.evaluate(
                """el => {
                  const rect = el.getBoundingClientRect();
                  let hinted = false;
                  for (let node = el, depth = 0;
                       node && depth < 5;
                       node = node.parentElement, depth += 1) {
                    const marker = [node.id, node.className,
                      node.getAttribute?.("aria-label"), node.innerText]
                      .filter((value) => typeof value === "string")
                      .join(" ");
                    if (/扫码|二维码|qrcode|qr[-_]?code/i.test(marker)) {
                      hinted = true; break;
                    }
                  }
                  return { tag: el.tagName, source: el.getAttribute("src") || "",
                    width: rect.width, height: rect.height, hinted };
                }""",
                timeout=timeout_ms,
            )
            if not isinstance(metadata, dict):
                continue
            width = metadata.get("width")
            height = metadata.get("height")
            source = metadata.get("source")
            if not isinstance(width, (int, float)) or not isinstance(
                height, (int, float)
            ):
                continue
            longest = max(width, height)
            if (min(width, height) < 100 or longest > 600
                    or abs(width - height) > longest * 0.2):
                continue
            if metadata.get("hinted") is True or (
                isinstance(source, str) and source.startswith("data:image/")
            ):
                candidates.append(candidate)
        except Exception:
            continue
    if len(candidates) > 1:
        raise RuntimeError("douyin_login_ui_unsupported")
    return candidates[0] if candidates else None


def _capture_visible_qr_image_before_deadline(
    page: object,
    deadline: float,
) -> str | None:
    locator = _visible_locator_before_deadline(
        page,
        DOUYIN_LOGIN_QR_SELECTORS,
        deadline,
    )
    if locator is not None:
        try:
            return _qr_image_data_url_before_deadline(locator, deadline)
        except RuntimeError:
            return None
    css_qr = _css_qr_container_data_url_before_deadline(page, deadline)
    if css_qr is not None:
        return css_qr
    if _remaining_deadline_ms(deadline) <= 0:
        return None
    locator = _generic_qr_locator_before_deadline(page, deadline)
    if locator is None:
        return None
    try:
        return _qr_image_data_url_before_deadline(locator, deadline)
    except RuntimeError:
        return None


def _capture_visible_qr_image(page: object) -> str | None:
    locator = _visible_locator(page, DOUYIN_LOGIN_QR_SELECTORS)
    if locator is not None:
        try:
            return _qr_image_data_url(page, locator)
        except RuntimeError:
            return None
    css_qr = _css_qr_container_data_url(page)
    if css_qr is not None:
        return css_qr
    locator = _generic_qr_locator(page)
    if locator is None:
        return None
    try:
        return _qr_image_data_url(page, locator)
    except RuntimeError:
        return None


def _wait_for_qr_image(page: object) -> str:
    deadline = time.monotonic() + LOGIN_QR_WAIT_MS / 1_000

    def capture_timeout() -> int | None:
        remaining_ms = int((deadline - time.monotonic()) * 1_000)
        if remaining_ms <= 0:
            return None
        return min(LOGIN_QR_CAPTURE_TIMEOUT_MS, remaining_ms)

    while time.monotonic() < deadline:
        blocked_status = _non_ready_qr_status(page)
        if blocked_status == "verification_required":
            raise RuntimeError("douyin_verification_required")
        if blocked_status in {"expired", "network_error"}:
            raise RuntimeError("douyin_qr_image_unavailable")
        locator = _visible_locator(page, DOUYIN_LOGIN_QR_SELECTORS)
        if locator is not None:
            timeout_ms = capture_timeout()
            if timeout_ms is None:
                break
            return _qr_image_data_url(
                page,
                locator,
                capture_timeout_ms=timeout_ms,
            )
        timeout_ms = capture_timeout()
        if timeout_ms is None:
            break
        css_qr = _css_qr_container_data_url(
            page,
            capture_timeout_ms=timeout_ms,
        )
        if css_qr is not None:
            return css_qr
        timeout_ms = capture_timeout()
        if timeout_ms is None:
            break
        locator = _generic_qr_locator(page)
        if locator is not None:
            return _qr_image_data_url(
                page,
                locator,
                capture_timeout_ms=timeout_ms,
            )
        remaining_ms = int((deadline - time.monotonic()) * 1_000)
        if remaining_ms <= 0:
            break
        page.wait_for_timeout(  # type: ignore[attr-defined]
            min(LOGIN_QR_POLL_MS, remaining_ms)
        )
    raise RuntimeError("douyin_qr_image_unavailable")


def _require_allowed_login_page(page: object) -> None:
    raw_url = getattr(page, "url", None)
    if not isinstance(raw_url, str):
        raise RuntimeError("douyin_login_page_not_allowed")
    try:
        parsed = urlsplit(raw_url)
        port = parsed.port
    except ValueError:
        raise RuntimeError("douyin_login_page_not_allowed") from None
    if (
        parsed.scheme.lower() != "https"
        or parsed.hostname is None
        or parsed.hostname.lower().rstrip(".") not in DOUYIN_LOGIN_ALLOWED_HOSTS
        or parsed.username is not None
        or parsed.password is not None
        or port not in {None, 443}
    ):
        raise RuntimeError("douyin_login_page_not_allowed")


def _login_context_page(context: object) -> object:
    raw_pages = getattr(context, "pages", None)
    if not isinstance(raw_pages, (list, tuple)):
        raise RuntimeError("douyin_login_page_unavailable")
    pages = []
    for page in raw_pages:
        try:
            is_closed = getattr(page, "is_closed", None)
            if callable(is_closed) and is_closed():
                continue
        except Exception:
            raise RuntimeError("douyin_login_page_unavailable") from None
        _require_allowed_login_page(page)
        pages.append(page)
    if not pages:
        raise RuntimeError("douyin_login_page_unavailable")
    return pages[-1]


def _capture_login_page(context: object) -> dict[str, object]:
    page = _login_context_page(context)
    try:
        screenshot = page.screenshot(  # type: ignore[attr-defined]
            type="jpeg",
            quality=LOGIN_JPEG_QUALITY,
            full_page=False,
            timeout=LOGIN_QR_CAPTURE_TIMEOUT_MS,
        )
    except Exception:
        raise RuntimeError("douyin_login_page_unavailable") from None
    _require_allowed_login_page(page)
    if not isinstance(screenshot, bytes) or not screenshot:
        raise RuntimeError("douyin_login_page_unavailable")
    return {
        "image_data_url": (
            "data:image/jpeg;base64,"
            + base64.b64encode(screenshot).decode("ascii")
        ),
        "width": LOGIN_VIEWPORT_WIDTH,
        "height": LOGIN_VIEWPORT_HEIGHT,
    }


def _capture_login_page_best_effort(
    context: object,
) -> dict[str, object] | None:
    try:
        return _capture_login_page(context)
    except RuntimeError as error:
        if str(error) == "douyin_login_page_unavailable":
            return None
        raise


def _poll_login_context(context: object) -> dict[str, object]:
    _login_context_page(context)
    for page in context.pages:  # type: ignore[attr-defined]
        try:
            if page.evaluate(  # type: ignore[attr-defined]
                "() => window.localStorage.getItem('HasUserLogin')"
            ) == "1":
                identity = _extract_bound_identity_with_retry(page)
                return {
                    "active": True,
                    "identity_fingerprint": identity.fingerprint,
                    "display_name": identity.display_name,
                }
        except DouyinAccountIdentityFailure as error:
            return {
                "active": False,
                "identity_error": str(error),
            }
        except Exception:
            continue
    page = _login_context_page(context)
    qr_status = _non_ready_qr_status(page)
    qr_image_data_url = (
        None if qr_status is not None else _capture_visible_qr_image(page)
    )
    if qr_status is None:
        qr_status = "ready" if qr_image_data_url is not None else "opening"
    return {
        "active": False,
        "qr_status": qr_status,
        "qr_image_data_url": qr_image_data_url,
        "login_page": _capture_login_page_best_effort(context),
    }


def _poll_external_login_context(context: object) -> dict[str, object]:
    """Detect authentication without making remote-rendering data mandatory.

    The operator owns the visible browser window in desktop mode.  DOM
    screenshots and QR extraction are therefore diagnostics, not prerequisites
    for keeping the persistent Context alive.
    """
    _login_context_page(context)
    for page in context.pages:  # type: ignore[attr-defined]
        try:
            if page.evaluate(  # type: ignore[attr-defined]
                "() => window.localStorage.getItem('HasUserLogin')"
            ) == "1":
                identity = _extract_bound_identity_with_retry(page)
                return {
                    "active": True,
                    "identity_fingerprint": identity.fingerprint,
                    "display_name": identity.display_name,
                }
        except DouyinAccountIdentityFailure:
            raise RuntimeError(
                "douyin_account_identity_detection_unavailable"
            ) from None
        except Exception:
            continue

    qr_status = "opening"
    try:
        page = _login_context_page(context)
        if _verification_required(page):
            qr_status = "verification_required"
    except Exception:
        # The browser is still directly operable.  Selector drift must not
        # become a browser-lifecycle failure.
        pass
    return {
        "active": False,
        "qr_status": qr_status,
        "qr_image_data_url": None,
        "login_page": None,
    }


def _refresh_qr_login_context(
    context: object,
    *,
    diagnostic_timeout_ms: int = (
        DEFAULT_BROWSER_COMMAND_TIMEOUT_SECONDS * 1_000
    ),
) -> dict[str, object]:
    started_at = time.monotonic()
    _log_refresh_timing(
        stage="start",
        started_at=started_at,
        diagnostic_timeout_ms=diagnostic_timeout_ms,
    )
    page = _login_context_page(context)
    diagnostic = _RefreshNetworkDiagnostic(page)
    diagnostic.start()
    try:
        _log_refresh_timing(
            stage="status_before",
            started_at=started_at,
            diagnostic_timeout_ms=diagnostic_timeout_ms,
        )
        qr_status = _non_ready_qr_status(page)
        diagnostic.mark_after()
        if qr_status != "expired":
            _log_refresh_timing(
                stage="reload",
                started_at=started_at,
                diagnostic_timeout_ms=diagnostic_timeout_ms,
            )
            page.reload(  # type: ignore[attr-defined]
                wait_until="domcontentloaded",
                timeout=LOGIN_NAVIGATION_TIMEOUT_MS,
            )
            _require_allowed_login_page(page)
            _log_refresh_timing(
                stage="status_after_reload",
                started_at=started_at,
                diagnostic_timeout_ms=diagnostic_timeout_ms,
            )
            qr_status = _non_ready_qr_status(page)
        qr_image_data_url: str | None = None
        if qr_status == "expired":
            _log_refresh_timing(
                stage="expired_refresh",
                started_at=started_at,
                diagnostic_timeout_ms=diagnostic_timeout_ms,
            )
            if _attempt_expired_qr_refresh(page, entry="interaction"):
                _log_refresh_timing(
                    stage="wait_qr",
                    started_at=started_at,
                    diagnostic_timeout_ms=diagnostic_timeout_ms,
                )
                qr_status, qr_image_data_url = _wait_for_refreshed_qr(page)
        elif qr_status is None:
            try:
                _log_refresh_timing(
                    stage="panel_probe",
                    started_at=started_at,
                    diagnostic_timeout_ms=diagnostic_timeout_ms,
                )
                if not _wait_for_login_panel(page):
                    _log_refresh_timing(
                        stage="open_login",
                        started_at=started_at,
                        diagnostic_timeout_ms=diagnostic_timeout_ms,
                    )
                    _click_login_button(page)
                    _log_refresh_timing(
                        stage="panel_reprobe",
                        started_at=started_at,
                        diagnostic_timeout_ms=diagnostic_timeout_ms,
                    )
                    if not _wait_for_login_panel(page):
                        raise RuntimeError("douyin_login_ui_unsupported")
                _log_refresh_timing(
                    stage="activate_qr",
                    started_at=started_at,
                    diagnostic_timeout_ms=diagnostic_timeout_ms,
                )
                _activate_qr_login(page)
                _log_refresh_timing(
                    stage="wait_qr",
                    started_at=started_at,
                    diagnostic_timeout_ms=diagnostic_timeout_ms,
                )
                qr_image_data_url = _wait_for_qr_image(page)
                qr_status = "ready"
            except RuntimeError as error:
                error_code = str(error)
                if error_code == "douyin_verification_required":
                    qr_status = "verification_required"
                elif error_code in {
                    "douyin_login_ui_unsupported",
                    "douyin_qr_image_unavailable",
                }:
                    qr_status = _non_ready_qr_status(page) or "opening"
                else:
                    raise
        _log_refresh_timing(
            stage="capture_page",
            started_at=started_at,
            diagnostic_timeout_ms=diagnostic_timeout_ms,
        )
        return {
            "active": False,
            "qr_status": qr_status,
            "qr_image_data_url": qr_image_data_url,
            "login_page": _capture_login_page_best_effort(context),
        }
    finally:
        _log_refresh_timing(
            stage="finish",
            started_at=started_at,
            diagnostic_timeout_ms=diagnostic_timeout_ms,
        )
        diagnostic.finish()


def _interact_login_context(
    context: object,
    raw_request: object,
    *,
    diagnostic_timeout_ms: int = (
        DEFAULT_BROWSER_COMMAND_TIMEOUT_SECONDS * 1_000
    ),
) -> dict[str, object]:
    request = TypeAdapter(LoginInteractionRequest).validate_python(raw_request)
    if request.type == "refresh_qr":
        return _refresh_qr_login_context(
            context,
            diagnostic_timeout_ms=diagnostic_timeout_ms,
        )
    page = _login_context_page(context)
    if request.type == "click":
        x = min(
            LOGIN_VIEWPORT_WIDTH - 1,
            round(request.normalized_x * LOGIN_VIEWPORT_WIDTH),
        )
        y = min(
            LOGIN_VIEWPORT_HEIGHT - 1,
            round(request.normalized_y * LOGIN_VIEWPORT_HEIGHT),
        )
        page.mouse.click(x, y)  # type: ignore[attr-defined]
    elif request.type == "text":
        page.keyboard.insert_text(request.text)  # type: ignore[attr-defined]
    elif request.type == "key":
        page.keyboard.press(request.key)  # type: ignore[attr-defined]
    else:
        page.mouse.wheel(  # type: ignore[attr-defined]
            round(request.delta_x * LOGIN_VIEWPORT_WIDTH),
            round(request.delta_y * LOGIN_VIEWPORT_HEIGHT),
        )
    return _poll_login_context(context)


def _prepare_login_context(context: object) -> dict[str, object]:
    page = _login_context_page(context)
    qr_image_data_url: str | None = None
    qr_status = _non_ready_qr_status(page)
    if qr_status == "expired":
        if _attempt_expired_qr_refresh(page, entry="open"):
            qr_status, qr_image_data_url = _wait_for_refreshed_qr(page)
    elif qr_status is None:
        try:
            if not _wait_for_login_panel(page):
                _click_login_button(page)
                if not _wait_for_login_panel(page):
                    raise RuntimeError("douyin_login_ui_unsupported")
            _activate_qr_login(page)
            qr_image_data_url = _wait_for_qr_image(page)
            qr_status = "ready"
        except RuntimeError as error:
            error_code = str(error)
            if error_code == "douyin_verification_required":
                qr_status = "verification_required"
            elif error_code == "douyin_login_ui_unsupported":
                qr_status = "opening"
            elif error_code == "douyin_qr_image_unavailable":
                qr_status = _non_ready_qr_status(page) or "opening"
                if (qr_status == "expired"
                        and _attempt_expired_qr_refresh(
                            page,
                            entry="open",
                        )):
                    qr_status, qr_image_data_url = (
                        _wait_for_refreshed_qr(page)
                    )
            else:
                raise
    return {
        "login_page": _capture_login_page_best_effort(context),
        "qr_status": qr_status,
        "qr_image_data_url": qr_image_data_url,
    }


def _open_context(playwright: object, profile_path: str, *, headless: bool,
                  browser_channel: str | None,
                  browser_proxy: str | None = None,
                  browser_environment: dict[str, str] | None = None,
                  defer_auxiliary: bool = False,
                  interaction_surface: str = "remote_canvas",
                  ) -> tuple[object, dict[str, object]]:
    launch_options = _launch_options(
        headless,
        browser_channel,
        browser_proxy,
        interaction_surface=interaction_surface,
    )
    launch_options["viewport"] = {
        "width": LOGIN_VIEWPORT_WIDTH,
        "height": LOGIN_VIEWPORT_HEIGHT,
    }
    if browser_environment is not None:
        launch_options["headless"] = False
        launch_options["env"] = browser_environment
    try:
        context = playwright.chromium.launch_persistent_context(
            profile_path, **launch_options
        )
    except BaseException as error:
        raise DouyinLoginOpenFailure(
            "browser_launch",
            _safe_login_open_error_code(error, "browser_launch"),
        ) from None
    try:
        try:
            page = context.pages[0] if context.pages else context.new_page()
        except BaseException as error:
            raise DouyinLoginOpenFailure(
                "browser_page_open",
                _safe_login_open_error_code(error, "browser_page_open"),
            ) from None
        try:
            navigation_error: Exception | None = None
            for _attempt in range(LOGIN_NAVIGATION_ATTEMPTS):
                try:
                    page.goto(
                        "https://www.douyin.com/",
                        wait_until="domcontentloaded",
                        timeout=LOGIN_NAVIGATION_TIMEOUT_MS,
                    )
                    navigation_error = None
                    break
                except Exception as error:
                    navigation_error = error
                    if _attempt + 1 < LOGIN_NAVIGATION_ATTEMPTS:
                        page.close()
                        page = context.new_page()
                        page.wait_for_timeout(LOGIN_NAVIGATION_RETRY_DELAY_MS)
            if navigation_error is not None:
                raise RuntimeError("douyin_login_page_unavailable") from None
            _require_allowed_login_page(page)
            page.wait_for_timeout(1_000)
        except BaseException as error:
            raise DouyinLoginOpenFailure(
                "douyin_navigation",
                _safe_login_open_error_code(error, "douyin_navigation"),
            ) from None
        if defer_auxiliary:
            return context, {
                "login_page": None,
                "qr_status": "opening",
                "qr_image_data_url": None,
            }
        try:
            return context, _prepare_login_context(context)
        except RuntimeError as error:
            raise DouyinLoginOpenFailure(
                "douyin_navigation",
                _safe_login_open_error_code(
                    error,
                    "douyin_navigation",
                ),
            ) from None
    except BaseException:
        try:
            context.close()
        except BaseException:
            pass
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
                    browser_proxy: str | None = None,
                    manual_verification_seconds: int,
                    visual_locator: VisualLocator | None = None,
                    account_authority_revalidator: Callable[[], None] | None = None,
                    ) -> dict[str, object]:
    _require_visible_action_browser(headless)
    request = ActionRequest.model_validate(raw_request)
    context = playwright.chromium.launch_persistent_context(
        profile_path, **_launch_options(
            headless, browser_channel, browser_proxy
        )
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
            if request.kind == "direct_message":
                receipt = DouyinSpiderPrivateMessageExecutor().execute(
                    context,
                    page,
                    request,
                    account_authority_revalidator=(
                        revalidate_account_authority
                    ),
                )
            else:
                receipt = DouyinActionExecutor(
                    headless=headless,
                    manual_verification_seconds=(
                        manual_verification_seconds
                    ),
                    visual_locator=visual_locator,
                    account_identity_revalidator=(
                        revalidate_account_authority
                    ),
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
                      browser_proxy: str | None = None,
                      visual_locator: VisualLocator | None = None,
                      account_authority_revalidator: Callable[[], None] | None = None,
                      ) -> dict[str, object]:
    _require_visible_action_browser(headless)
    request = ActionReconciliationRequest.model_validate(raw_request)
    context = playwright.chromium.launch_persistent_context(
        profile_path, **_launch_options(
            headless, browser_channel, browser_proxy
        )
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
                    visual_locator_mode: str = "disabled",
                    browser_proxy: str | None = None,
                    live_display_factory: Callable[[], object] | None = None,
                    interaction_surface: str = "remote_canvas",
                    ) -> None:
    playwright = None
    visual_locator = None
    contexts: dict[str, object] = {}
    login_diagnostics: dict[str, dict[str, object]] = {}
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
                    live_display = None
                    open_stage = (
                        "live_display_start"
                        if live_display_factory is not None
                        else "browser_context_open"
                    )
                    try:
                        if live_display_factory is not None:
                            live_display = live_display_factory()
                        open_stage = "browser_context_open"
                        context, opened_login = _open_context(
                            playwright, str(command["profile_path"]),
                            headless=headless,
                            browser_channel=browser_channel,
                            browser_proxy=browser_proxy,
                            browser_environment=(
                                live_display.browser_environment()
                                if live_display is not None else None
                            ),
                            defer_auxiliary=True,
                            interaction_surface=interaction_surface,
                        )
                        if live_display is not None:
                            context = _ManagedLoginContext(
                                context,
                                live_display,
                            )
                    except BaseException as error:
                        if live_display is not None:
                            try:
                                live_display.close()
                            except BaseException:
                                pass
                        if isinstance(error, DouyinLoginOpenFailure):
                            raise
                        raise DouyinLoginOpenFailure(
                            open_stage,
                            _safe_login_open_error_code(error, open_stage),
                        ) from None
                    handle = secrets.token_urlsafe(24)
                    contexts[handle] = context
                    value: object = {"handle": handle, **opened_login}
                    login_diagnostics[handle] = {
                        "last_status": opened_login.get("qr_status"),
                        "poll_count": 0,
                        "refresh_count": 0,
                    }
                    _log_login_qr_diagnostic(
                        stage="open_result",
                        status=opened_login.get("qr_status"),
                        poll_count=0,
                        refresh_count=0,
                    )
                    vnc_port = getattr(context, "vnc_port", None)
                    if type(vnc_port) is int:
                        value["vnc_port"] = vnc_port
                elif operation == "poll":
                    handle = str(command["handle"])
                    context = contexts.get(handle)
                    if context is None:
                        raise RuntimeError("douyin_browser_context_closed")
                    value = (
                        _poll_external_login_context(context)
                        if interaction_surface == "external_window"
                        else _poll_login_context(context)
                    )
                    diagnostic = login_diagnostics.get(handle)
                    if diagnostic is not None:
                        diagnostic["poll_count"] = (
                            int(diagnostic["poll_count"]) + 1
                        )
                        status = (
                            "active" if value.get("active") is True
                            else value.get("qr_status")
                        )
                        if status != diagnostic["last_status"]:
                            diagnostic["last_status"] = status
                            _log_login_qr_diagnostic(
                                stage="poll_transition",
                                status=status,
                                poll_count=int(diagnostic["poll_count"]),
                                refresh_count=int(
                                    diagnostic["refresh_count"]
                                ),
                            )
                elif operation == "prepare_login":
                    handle = str(command["handle"])
                    context = contexts.get(handle)
                    if context is None:
                        raise RuntimeError("douyin_browser_context_closed")
                    value = _prepare_login_context(context)
                    diagnostic = login_diagnostics.get(handle)
                    if diagnostic is not None:
                        diagnostic["last_status"] = value.get("qr_status")
                        _log_login_qr_diagnostic(
                            stage="prepare_result",
                            status=value.get("qr_status"),
                            poll_count=int(diagnostic["poll_count"]),
                            refresh_count=int(diagnostic["refresh_count"]),
                        )
                elif operation == "interact":
                    handle = str(command["handle"])
                    context = contexts.get(handle)
                    if context is None:
                        raise RuntimeError("douyin_browser_context_closed")
                    interaction_options: dict[str, object] = {}
                    raw_request = command["request"]
                    if (
                        isinstance(raw_request, dict)
                        and raw_request.get("type") == "refresh_qr"
                    ):
                        interaction_options["diagnostic_timeout_ms"] = int(
                            command.get(
                                "diagnostic_timeout_ms",
                                DEFAULT_BROWSER_COMMAND_TIMEOUT_SECONDS * 1_000,
                            )
                        )
                    value = _interact_login_context(
                        context,
                        raw_request,
                        **interaction_options,
                    )
                    request = command.get("request")
                    if (isinstance(request, dict)
                            and request.get("type") == "refresh_qr"):
                        diagnostic = login_diagnostics.get(handle)
                        if diagnostic is not None:
                            diagnostic["refresh_count"] = (
                                int(diagnostic["refresh_count"]) + 1
                            )
                            diagnostic["last_status"] = value.get("qr_status")
                            _log_login_qr_diagnostic(
                                stage="refresh_result",
                                status=value.get("qr_status"),
                                poll_count=int(diagnostic["poll_count"]),
                                refresh_count=int(
                                    diagnostic["refresh_count"]
                                ),
                            )
                elif operation == "close":
                    handle = str(command["handle"])
                    context = contexts.get(handle)
                    if context is None:
                        raise RuntimeError("douyin_browser_context_closed")
                    context.close()
                    contexts.pop(handle, None)
                    login_diagnostics.pop(handle, None)
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
                            browser_proxy=browser_proxy,
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
                            browser_proxy=browser_proxy,
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
            except DouyinLoginOpenFailure as error:
                connection.send({
                    "id": command_id,
                    "kind": "login_open_error",
                    "stage": error.stage,
                    "error_code": error.error_code,
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

    _RESTARTABLE_FRESH_COMMANDS = frozenset({"open", "action"})

    def __init__(
        self,
        playwright_factory: Callable[[], object] | None = None,
        startup_timeout: float = 15,
        command_timeout: float = DEFAULT_BROWSER_COMMAND_TIMEOUT_SECONDS,
        headless: bool = True,
        browser_channel: str | None = None,
        browser_proxy: str | None = None,
        manual_verification_seconds: int | None = None,
        visual_locator: str | None = None,
        live_display_factory: Callable[[], object] | None = None,
        interaction_surface: str = "remote_canvas",
    ) -> None:
        if startup_timeout <= 0 or command_timeout <= 0:
            raise ValueError("browser timeouts must be positive")
        if interaction_surface not in {"external_window", "remote_canvas"}:
            raise ValueError("invalid browser interaction surface")
        if interaction_surface == "external_window" and headless:
            raise ValueError("external_window requires headless=False")
        manual_seconds = configured_action_manual_verification_seconds(
            os.environ.get("DOUYIN_ACTION_MANUAL_VERIFICATION_SECONDS")
            if manual_verification_seconds is None else manual_verification_seconds
        )
        visual_locator_mode = configured_visual_locator(
            os.environ.get("DOUYIN_ACTION_VISUAL_LOCATOR")
            if visual_locator is None else visual_locator
        )
        self._multiprocessing_context = multiprocessing.get_context("spawn")
        self._playwright_factory = playwright_factory
        self._interaction_surface = interaction_surface
        self._live_display_factory = (
            None
            if interaction_surface == "external_window"
            else live_display_factory
            if live_display_factory is not None
            else _start_live_display if playwright_factory is None
            else None
        )
        self._browser_channel = browser_channel
        self._browser_proxy = browser_proxy
        self._manual_seconds = manual_seconds
        self._visual_locator_mode = visual_locator_mode
        self._startup_timeout = startup_timeout
        self._timeout = command_timeout
        self._action_timeout = (
            manual_seconds + ACTION_DEADLINE_OVERHEAD_SECONDS
            + ACTION_IPC_OVERHEAD_SECONDS
        )
        self._headless = bool(headless)
        self._lock = threading.Lock()
        self._abort_lock = threading.Lock()
        self._closed = False
        self._faulted = False
        self._terminally_closed = False
        self._shutdown_failed = False
        self._next_command_id = 1
        self._owned_pgid: int | None = None
        self._start_worker()

    def _start_worker(self) -> None:
        if getattr(self, "_terminally_closed", False):
            raise RuntimeError("douyin_browser_closed")
        context = self._multiprocessing_context
        parent, child = context.Pipe()
        self._connection = parent
        self._process = context.Process(
            target=_browser_worker,
            args=(
                child,
                self._playwright_factory,
                self._headless,
                self._browser_channel,
                self._manual_seconds,
                self._visual_locator_mode,
                self._browser_proxy,
                self._live_display_factory,
                self._interaction_surface,
            ),
            name="douyin-browser",
        )
        self._owned_pgid = None
        self._closed = False
        self._faulted = False
        try:
            self._process.start()
        except BaseException as error:
            self._closed = True
            self._faulted = True
            child.close()
            parent.close()
            try:
                self._process.close()
            except (OSError, ValueError):
                pass
            raise RuntimeError("douyin_browser_startup_failed") from error
        child.close()
        startup_deadline = time.monotonic() + self._startup_timeout
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

    def _prepare_fresh_command(self, operation: str) -> None:
        if getattr(self, "_terminally_closed", False):
            raise RuntimeError("douyin_browser_closed")
        process = getattr(self, "_process", None)
        if not self._closed and process is not None:
            try:
                alive = process.is_alive()
            except (AssertionError, OSError, ValueError):
                alive = False
            if not alive:
                self._hard_stop()
        if not self._closed:
            return
        if (not getattr(self, "_faulted", False)
                or operation not in self._RESTARTABLE_FRESH_COMMANDS):
            raise RuntimeError("douyin_browser_unavailable")
        # Recovery happens only before a new caller command. A command that was
        # already sent or timed out is never replayed inside _call.
        self._start_worker()

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
        self._faulted = not getattr(self, "_terminally_closed", False)
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
            self._prepare_fresh_command(operation)
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
            if response.get("kind") == "login_open_error":
                stage = response.get("stage")
                error_code = response.get("error_code")
                if (operation != "open"
                        or set(response) != {
                            "id", "kind", "stage", "error_code",
                        }
                        or type(stage) is not str
                        or stage not in _CLOSED_LOGIN_OPEN_STAGES
                        or type(error_code) is not str
                        or error_code not in _CLOSED_LOGIN_OPEN_ERROR_CODES):
                    self._hard_stop()
                    raise RuntimeError("douyin_browser_protocol_error")
                raise DouyinLoginOpenFailure(stage, error_code)
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

    @property
    def interaction_surface(self) -> str:
        return self._interaction_surface

    def prepare_douyin_login(self, context: object) -> dict[str, object]:
        return self._call(
            "prepare_login",
            handle=self._handle(context),
        )  # type: ignore[return-value]

    def poll_douyin_login(self, context: object) -> dict[str, object]:
        return self._call("poll", handle=self._handle(context))  # type: ignore[return-value]

    def live_vnc_port(self, context: object) -> int:
        if not isinstance(context, dict):
            raise RuntimeError("douyin_live_login_unavailable")
        port = context.get("vnc_port")
        if type(port) is not int or not 1 <= port <= 65_535:
            raise RuntimeError("douyin_live_login_unavailable")
        return port

    def interact_douyin_login(
        self,
        context: object,
        request: LoginInteractionRequest,
    ) -> dict[str, object]:
        payload: dict[str, object] = {
            "handle": self._handle(context),
            "request": request.model_dump(mode="json"),
        }
        if request.type == "refresh_qr":
            payload["diagnostic_timeout_ms"] = max(
                1,
                int(round(self._timeout * 1_000)),
            )
        return self._call(
            "interact",
            **payload,
        )  # type: ignore[return-value]

    def close(self, context: object) -> None:
        self._call("close", handle=self._handle(context))

    def abort_browser(self) -> None:
        """Immediately stop this dedicated worker without waiting on IPC.

        LocalBrowserSessionManager creates one worker per account session, so
        this cannot terminate a different account's Context.
        """
        with self._abort_lock:
            if getattr(self, "_terminally_closed", False):
                return
            self._terminally_closed = True
            self._faulted = False
            self._hard_stop()
            self._faulted = False

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
            if getattr(self, "_terminally_closed", False):
                if self._shutdown_failed:
                    raise RuntimeError("douyin_browser_shutdown_failed")
                return
            self._terminally_closed = True
            if self._closed:
                self._faulted = False
                return
            self._closed = True
            self._faulted = False
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
