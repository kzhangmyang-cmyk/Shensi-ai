"""Private, process-owned Playwright boundary for MediaCrawler login state."""

from __future__ import annotations

import multiprocessing
import os
import secrets
import signal
import threading
import time
from collections.abc import Callable
from multiprocessing.connection import Connection
from pathlib import Path
from typing import Protocol

from .douyin_actions import DouyinActionExecutor, DouyinActionFailure
from .schemas import ActionRequest


class BrowserState(Protocol):
    def open_douyin_login(self, profile_path: Path) -> dict[str, str]: ...
    def close(self, context: object) -> None: ...
    def poll_douyin_login(self, context: object) -> dict[str, object]: ...
    def execute_douyin_action(self, profile_path: Path,
                              request: ActionRequest) -> dict[str, object]: ...


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


def _execute_action(playwright: object, profile_path: str,
                    raw_request: object, *, headless: bool,
                    browser_channel: str | None) -> dict[str, object]:
    request = ActionRequest.model_validate(raw_request)
    context = playwright.chromium.launch_persistent_context(
        profile_path, **_launch_options(headless, browser_channel)
    )
    try:
        page = context.pages[0] if context.pages else context.new_page()
        return DouyinActionExecutor().execute(page, request).model_dump(mode="json")
    finally:
        context.close()


def _browser_worker(connection: Connection, factory: Callable[[], object] | None,
                    headless: bool, browser_channel: str | None) -> None:
    playwright = None
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
                    for page in context.pages:
                        try:
                            if page.evaluate(
                                "() => window.localStorage.getItem('HasUserLogin')"
                            ) == "1":
                                active = True
                                break
                        except Exception:
                            continue
                    value = {"active": active}
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
                        value = _execute_action(playwright,
                            str(command["profile_path"]), command["request"],
                            headless=headless, browser_channel=browser_channel)
                    except DouyinActionFailure:
                        raise
                    except BaseException as error:
                        raise DouyinActionFailure("action_unavailable") from error
                else:
                    raise RuntimeError("douyin_browser_invalid_command")
                connection.send({"id": command_id, "kind": "ok", "value": value})
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
    ) -> None:
        if startup_timeout <= 0 or command_timeout <= 0:
            raise ValueError("browser timeouts must be positive")
        context = multiprocessing.get_context("spawn")
        parent, child = context.Pipe()
        self._connection = parent
        self._process = context.Process(
            target=_browser_worker,
            args=(child, playwright_factory, headless, browser_channel),
            name="douyin-browser",
        )
        self._timeout = command_timeout
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

    def _call(self, operation: str, **payload: object) -> object:
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
            if not self._connection.poll(self._timeout):
                self._hard_stop()
                raise RuntimeError("douyin_browser_command_timeout")
            try:
                response = self._connection.recv()
            except (EOFError, OSError) as error:
                self._hard_stop()
                raise RuntimeError("douyin_browser_unavailable") from error
            if response.get("id") != command_id:
                self._hard_stop()
                raise RuntimeError("douyin_browser_protocol_error")
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
                              request: ActionRequest) -> dict[str, object]:
        return self._call("action", profile_path=str(profile_path),
                          request=request.model_dump(mode="json"))  # type: ignore[return-value]

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
            self._process.join(timeout=self._timeout)
            if self._process.is_alive():
                self._hard_stop()
                raise RuntimeError("douyin_browser_shutdown_timeout")
            self._connection.close()
            self._process.close()
            self._shutdown_failed = failed
            if failed:
                raise RuntimeError("douyin_browser_shutdown_failed")
