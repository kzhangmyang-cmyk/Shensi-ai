"""Private, process-owned Playwright boundary for MediaCrawler login state."""

from __future__ import annotations

import multiprocessing
import os
import secrets
import signal
import threading
from collections.abc import Callable
from multiprocessing.connection import Connection
from pathlib import Path
from typing import Protocol


class BrowserState(Protocol):
    def open_douyin_login(self, profile_path: Path) -> dict[str, str]: ...
    def close(self, context: object) -> None: ...
    def poll_douyin_login(self, context: object) -> dict[str, object]: ...


def _start_playwright(factory: Callable[[], object] | None) -> object:
    if factory is not None:
        return factory()
    from playwright.sync_api import sync_playwright

    return sync_playwright().start()


def _open_context(playwright: object, profile_path: str) -> tuple[object, str]:
    context = playwright.chromium.launch_persistent_context(
        profile_path, headless=True
    )
    try:
        page = context.pages[0] if context.pages else context.new_page()
        page.goto("https://www.douyin.com/", wait_until="domcontentloaded")
        try:
            page.locator("xpath=//p[text() = '登录']").click(timeout=5_000)
        except Exception:
            pass
        image = page.locator("#animate_qrcode_container img")
        image.wait_for(timeout=10_000)
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


def _browser_worker(connection: Connection, factory: Callable[[], object] | None) -> None:
    playwright = None
    contexts: dict[str, object] = {}
    shutdown_requested = False
    shutdown_failure: BaseException | None = None
    try:
        if os.name == "posix":
            try:
                os.setsid()
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
                        playwright, str(command["profile_path"])
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
    ) -> None:
        if startup_timeout <= 0 or command_timeout <= 0:
            raise ValueError("browser timeouts must be positive")
        context = multiprocessing.get_context("spawn")
        parent, child = context.Pipe()
        self._connection = parent
        self._process = context.Process(
            target=_browser_worker,
            args=(child, playwright_factory),
            name="douyin-browser",
        )
        self._timeout = command_timeout
        self._lock = threading.Lock()
        self._closed = False
        self._shutdown_failed = False
        self._next_command_id = 1
        self._process.start()
        child.close()
        if not self._connection.poll(startup_timeout):
            self._hard_stop()
            raise RuntimeError("douyin_browser_startup_timeout")
        try:
            startup = self._connection.recv()
        except (EOFError, OSError) as error:
            self._hard_stop()
            raise RuntimeError("douyin_browser_startup_failed") from error
        if startup.get("kind") != "ready":
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
        owned_process_group = False
        if os.name == "posix" and self._process.pid is not None:
            try:
                owned_process_group = os.getpgid(self._process.pid) == self._process.pid
            except OSError:
                pass
        grace = min(max(self._timeout, 0.1), 1.0)

        for _attempt in range(2):
            try:
                alive = self._process.is_alive()
            except (AssertionError, OSError, ValueError):
                alive = False
            if not alive:
                break
            try:
                if owned_process_group and self._process.pid is not None:
                    os.killpg(self._process.pid, signal.SIGKILL)
                else:
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
            alive = False
        if alive and owned_process_group:
            try:
                self._process.kill()
                self._process.join(timeout=grace)
            except (AssertionError, OSError, ValueError):
                pass
            try:
                alive = self._process.is_alive()
            except (AssertionError, OSError, ValueError):
                alive = False
        if not alive:
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
