"""Private, thread-owned Playwright boundary for MediaCrawler login state."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from queue import Queue
from threading import Event, Thread
from typing import Callable, Protocol


class BrowserState(Protocol):
    def open_douyin_login(self, profile_path: Path) -> dict[str, str]: ...
    def close(self, context: object) -> None: ...
    def poll_douyin_login(self, context: object) -> dict[str, object]: ...


@dataclass
class _Command:
    operation: Callable[[object], object]
    complete: Event
    value: object | None = None
    error: BaseException | None = None


class MediaCrawlerDouyinBrowserState:
    """Runs every Playwright operation on one owned browser thread.

    No FastAPI worker owns or touches a Playwright object.  Startup and every
    queued command have a bounded completion handoff so a broken browser never
    strands a request thread indefinitely.
    """

    def __init__(self, playwright_factory: Callable[[], object] | None = None,
                 startup_timeout: float = 15, command_timeout: float = 30) -> None:
        self._factory = playwright_factory
        self._timeout = command_timeout
        self._requests: Queue[_Command | None] = Queue()
        self._ready = Event()
        self._stopped = Event()
        self._startup_error: BaseException | None = None
        self._shutdown_error: BaseException | None = None
        self._closed = False
        self._thread = Thread(target=self._run, name="douyin-browser", daemon=True)
        self._thread.start()
        if not self._ready.wait(startup_timeout):
            self.close_browser()
            raise RuntimeError("douyin_browser_startup_timeout")
        if self._startup_error is not None:
            self._thread.join(timeout=startup_timeout)
            raise self._startup_error

    def _playwright(self) -> object:
        if self._factory is not None:
            return self._factory()
        from playwright.sync_api import sync_playwright
        return sync_playwright().start()

    def _run(self) -> None:
        playwright = None
        try:
            playwright = self._playwright()
        except BaseException as error:
            self._startup_error = error
            self._ready.set()
            self._stopped.set()
            return
        self._ready.set()
        try:
            while True:
                command = self._requests.get()
                if command is None:
                    break
                try:
                    command.value = command.operation(playwright)
                except BaseException as error:
                    command.error = error
                finally:
                    command.complete.set()
        finally:
            try:
                if playwright is not None:
                    playwright.stop()
            except BaseException as error:
                self._shutdown_error = error
            finally:
                self._stopped.set()

    def _call(self, operation: Callable[[object], object]) -> object:
        if self._closed:
            raise RuntimeError("douyin_browser_closed")
        if self._startup_error is not None:
            raise self._startup_error
        command = _Command(operation, Event())
        self._requests.put(command)
        if not command.complete.wait(self._timeout):
            raise RuntimeError("douyin_browser_command_timeout")
        if command.error is not None:
            raise command.error
        return command.value

    def open_douyin_login(self, profile_path: Path) -> dict[str, object]:
        def open_context(playwright: object) -> dict[str, object]:
            context = playwright.chromium.launch_persistent_context(str(profile_path), headless=True)
            try:
                page = context.pages[0] if context.pages else context.new_page()
                page.goto("https://www.douyin.com/", wait_until="domcontentloaded")
                try:
                    page.locator("xpath=//p[text() = '登录']").click(timeout=5_000)
                except Exception:
                    pass
                image = page.locator("#animate_qrcode_container img")
                image.wait_for(timeout=10_000)
                src = image.get_attribute("src") or ""
                if not src.startswith("data:image/"):
                    src = page.evaluate("""async (source) => {
                      const response = await fetch(source); const blob = await response.blob();
                      return await new Promise((resolve) => { const reader = new FileReader();
                        reader.onload = () => resolve(reader.result); reader.readAsDataURL(blob); });
                    }""", src)
                if not isinstance(src, str) or not src.startswith("data:image/"):
                    raise RuntimeError("douyin_qr_image_unavailable")
                return {"context": context, "qr_image_data_url": src}
            except BaseException:
                context.close()
                raise
        return self._call(open_context)  # type: ignore[return-value]

    def poll_douyin_login(self, context: object) -> dict[str, object]:
        def poll(_playwright: object) -> dict[str, object]:
            browser = context["context"]
            for page in browser.pages:
                try:
                    if page.evaluate("() => window.localStorage.getItem('HasUserLogin')") == "1":
                        return {"active": True}
                except Exception:
                    continue
            return {"active": False}
        return self._call(poll)  # type: ignore[return-value]

    def close(self, context: object) -> None:
        self._call(lambda _playwright: context["context"].close())

    def close_browser(self) -> None:
        if self._closed:
            if self._shutdown_error is not None:
                raise self._shutdown_error
            return
        self._closed = True
        self._requests.put(None)
        if not self._stopped.wait(self._timeout):
            raise RuntimeError("douyin_browser_shutdown_timeout")
        self._thread.join(timeout=self._timeout)
        if self._thread.is_alive():
            raise RuntimeError("douyin_browser_shutdown_timeout")
        if self._shutdown_error is not None:
            raise self._shutdown_error
