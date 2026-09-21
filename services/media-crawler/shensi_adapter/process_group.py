"""Read-only liveness checks for an already-owned process group."""

from __future__ import annotations

import os
import sys
from pathlib import Path


_IS_LINUX = sys.platform.startswith("linux")
_PROC_ROOT = Path("/proc")


def owned_process_group_alive(pgid: int) -> bool:
    """Keep ownership on uncertainty; Linux zombies no longer hold resources.

    The caller supplies its already-owned positive process-group ID. No signal
    is delivered, and Linux inspection reads only numeric PID ``stat`` files.
    """
    try:
        os.killpg(pgid, 0)
    except ProcessLookupError:
        return False
    except OSError:
        return True
    if not _IS_LINUX:
        return True

    found_member = False
    try:
        for entry in _PROC_ROOT.iterdir():
            if not entry.name.isascii() or not entry.name.isdecimal():
                continue
            raw = (entry / "stat").read_text(encoding="utf-8")
            prefix, separator, suffix = raw.rpartition(")")
            fields = suffix.split()
            if (not separator or not prefix.startswith(f"{entry.name} (")
                    or len(fields) < 3 or len(fields[0]) != 1):
                return True
            # After comm's final ')': state (field 3), ppid (4), pgrp (5).
            if int(fields[2]) != pgid:
                continue
            found_member = True
            if fields[0] not in {"Z", "X", "x"}:
                return True
    except (OSError, UnicodeError, ValueError):
        return True
    return not found_member
