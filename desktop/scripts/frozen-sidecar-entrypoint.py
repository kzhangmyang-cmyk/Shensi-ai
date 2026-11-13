"""PyInstaller entry point for the desktop Sidecar and its crawl worker."""

from __future__ import annotations

import argparse
import multiprocessing
import os
from pathlib import Path
import stat
import sys
from typing import MutableMapping


def configure_frozen_node(
    *,
    frozen: bool | None = None,
    resource_root: Path | None = None,
    environment: MutableMapping[str, str] | None = None,
) -> Path | None:
    """Expose only Playwright's bundled Node to PyExecJS in a frozen process."""
    is_frozen = bool(getattr(sys, "frozen", False)) if frozen is None else frozen
    if not is_frozen:
        return None
    environ = os.environ if environment is None else environment
    raw_root_value = resource_root if resource_root is not None else getattr(sys, "_MEIPASS", None)
    if raw_root_value is None or not str(raw_root_value).strip():
        raise RuntimeError("frozen Sidecar resource root is missing")
    raw_root = Path(raw_root_value)
    if not raw_root.is_absolute():
        raise RuntimeError("frozen Sidecar resource root must be absolute")
    try:
        root = raw_root.resolve(strict=True)
    except OSError as error:
        raise RuntimeError("frozen Sidecar resource root is missing") from error
    node_name = "node.exe" if sys.platform == "win32" else "node"
    expected = root / "playwright" / "driver" / node_name
    try:
        resolved = expected.resolve(strict=True)
    except OSError as error:
        raise RuntimeError("bundled Playwright Node executable is missing") from error
    try:
        resolved.relative_to(root)
    except ValueError as error:
        raise RuntimeError("bundled Playwright Node executable escapes the frozen resource root") from error
    details = resolved.stat()
    if not stat.S_ISREG(details.st_mode):
        raise RuntimeError("bundled Playwright Node executable is not a regular file")
    if not os.access(resolved, os.X_OK):
        raise RuntimeError("bundled Playwright Node executable is not executable")
    previous = environ.get("PATH", "")
    environ["PATH"] = str(resolved.parent) if not previous else f"{resolved.parent}{os.pathsep}{previous}"
    return resolved


def main() -> int:
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--execute-crawl", type=Path)
    arguments, remaining = parser.parse_known_args()
    if arguments.execute_crawl is not None:
        if remaining:
            raise SystemExit("unexpected crawl worker arguments")
        from shensi_adapter.crawl_jobs import _execute_upstream

        _execute_upstream(arguments.execute_crawl)
        return 0
    if remaining:
        raise SystemExit("unexpected Sidecar arguments")
    from shensi_adapter.desktop_entrypoint import main as sidecar_main

    return sidecar_main()


def frozen_main() -> int:
    multiprocessing.freeze_support()
    configure_frozen_node()
    return main()


if __name__ == "__main__":
    raise SystemExit(frozen_main())
