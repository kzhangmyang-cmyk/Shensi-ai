"""Fail-closed exclusion for Chromium profiles shared by sidecar jobs."""

from __future__ import annotations

import errno
import fcntl
import hashlib
import os
from pathlib import Path


class ProfileLeaseBusy(RuntimeError):
    """The authenticated profile is already owned by another browser job."""


class ProfileLease:
    def __init__(self, descriptor: int) -> None:
        self._descriptor = descriptor

    def release(self) -> None:
        descriptor, self._descriptor = self._descriptor, -1
        if descriptor < 0:
            return
        try:
            fcntl.flock(descriptor, fcntl.LOCK_UN)
        finally:
            os.close(descriptor)

    def __enter__(self) -> ProfileLease:
        return self

    def __exit__(self, *_error: object) -> None:
        self.release()


def acquire_profile_lease(profile: Path, lease_root: Path) -> ProfileLease:
    """Acquire one non-blocking lease before launching persistent Chromium."""
    canonical_profile = profile.resolve()
    lease_directory = lease_root.resolve() / "profile-leases"
    lease_directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    if lease_directory.is_symlink() or not lease_directory.is_dir():
        raise RuntimeError("invalid_profile_lease_directory")
    os.chmod(lease_directory, 0o700)
    key = hashlib.sha256(os.fsencode(str(canonical_profile))).hexdigest()
    lock_path = lease_directory / f"{key}.lock"
    flags = os.O_CREAT | os.O_RDWR
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    descriptor = os.open(lock_path, flags, 0o600)
    try:
        os.fchmod(descriptor, 0o600)
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError as error:
        os.close(descriptor)
        if error.errno in {errno.EACCES, errno.EAGAIN}:
            raise ProfileLeaseBusy("douyin_profile_busy") from error
        raise
    return ProfileLease(descriptor)
