"""Private browser-context boundary for MediaCrawler login state.

The account manager owns the persistent profile directories.  Browser adapters
must not return cookies, storage state, or filesystem paths through this API.
"""

from pathlib import Path
from typing import Protocol


class BrowserState(Protocol):
    def open_douyin_login(self, profile_path: Path) -> dict[str, str]: ...

    def close(self, context: object) -> None: ...

    def poll_douyin_login(self, context: object) -> dict[str, object]: ...


class MediaCrawlerDouyinBrowserState:
    """Pinned Playwright adapter; it never exports browser storage or cookies."""

    def __init__(self) -> None:
        from playwright.sync_api import sync_playwright

        self._playwright = sync_playwright().start()

    def open_douyin_login(self, profile_path: Path) -> dict[str, object]:
        context = self._playwright.chromium.launch_persistent_context(
            str(profile_path), headless=True
        )
        page = context.pages[0] if context.pages else context.new_page()
        page.goto("https://www.douyin.com/", wait_until="domcontentloaded")
        try:
            page.locator("xpath=//p[text() = '登录']").click(timeout=5_000)
        except Exception:
            pass
        selector = "#animate_qrcode_container img"
        image = page.locator(selector)
        image.wait_for(timeout=10_000)
        src = image.get_attribute("src") or ""
        if not src.startswith("data:image/"):
            src = page.evaluate("""async (source) => {
              const response = await fetch(source); const blob = await response.blob();
              return await new Promise((resolve) => { const reader = new FileReader();
                reader.onload = () => resolve(reader.result); reader.readAsDataURL(blob); });
            }""", src)
        if not isinstance(src, str) or not src.startswith("data:image/"):
            context.close()
            raise RuntimeError("douyin_qr_image_unavailable")
        return {"context": context, "page": page, "qr_image_data_url": src}

    def poll_douyin_login(self, context: object) -> dict[str, object]:
        browser = context["context"]
        for page in browser.pages:
            try:
                if page.evaluate("() => window.localStorage.getItem('HasUserLogin')") == "1":
                    return {"active": True}
            except Exception:
                continue
        return {"active": False}

    def close(self, context: object) -> None:
        context["context"].close()
