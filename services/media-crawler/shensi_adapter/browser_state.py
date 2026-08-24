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
