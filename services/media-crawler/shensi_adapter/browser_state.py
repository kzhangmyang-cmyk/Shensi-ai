"""Private browser-context boundary for MediaCrawler login state.

The account manager owns the persistent profile directories.  Browser adapters
must not return cookies, storage state, or filesystem paths through this API.
"""

from pathlib import Path
from queue import Queue
from threading import Thread
from typing import Protocol


class BrowserState(Protocol):
    def open_douyin_login(self, profile_path: Path) -> dict[str, str]: ...

    def close(self, context: object) -> None: ...

    def poll_douyin_login(self, context: object) -> dict[str, object]: ...


class MediaCrawlerDouyinBrowserState:
    """Pinned Playwright adapter; it never exports browser storage or cookies."""

    def __init__(self) -> None:
        self._requests: Queue[tuple[object, Queue[object]]] = Queue()
        self._thread = Thread(target=self._run, name="douyin-browser", daemon=True)
        self._thread.start()

    def _run(self) -> None:
        from playwright.sync_api import sync_playwright

        playwright = sync_playwright().start()
        while True:
            request, result = self._requests.get()
            if request is None:
                playwright.stop()
                result.put(None)
                return
            try:
                result.put((True, request(playwright)))
            except Exception as error:
                result.put((False, error))

    def _call(self, request):
        result: Queue[object] = Queue(maxsize=1)
        self._requests.put((request, result))
        ok, value = result.get()
        if not ok:
            raise value
        return value

    def open_douyin_login(self, profile_path: Path) -> dict[str, object]:
        def open_context(playwright):
            context = playwright.chromium.launch_persistent_context(
                str(profile_path), headless=True
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
            except Exception:
                context.close()
                raise
        return self._call(open_context)

    def poll_douyin_login(self, context: object) -> dict[str, object]:
        def poll(_playwright):
            browser = context["context"]
            for page in browser.pages:
                try:
                    if page.evaluate("() => window.localStorage.getItem('HasUserLogin')") == "1":
                        return {"active": True}
                except Exception:
                    continue
            return {"active": False}
        return self._call(poll)

    def close(self, context: object) -> None:
        self._call(lambda _playwright: context["context"].close())

    def close_browser(self) -> None:
        result: Queue[object] = Queue(maxsize=1)
        self._requests.put((None, result))
        result.get()
