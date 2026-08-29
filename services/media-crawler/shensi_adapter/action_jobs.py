"""Durable, exact-replay wrapper for one-at-a-time Douyin actions."""

from __future__ import annotations

import hashlib
import json
import os
import threading
from datetime import UTC, datetime
from pathlib import Path
from typing import Callable

from .douyin_actions import DouyinActionFailure
from .schemas import (
    ActionReceipt,
    ActionReconciliationRequest,
    ActionRequest,
)
from .profile_lease import ProfileLeaseBusy, acquire_profile_lease


class ActionReplayConflict(RuntimeError):
    pass


def _semantic_hash(request: ActionRequest) -> str:
    payload = request.model_dump(mode="json")
    payload.pop("deadline_at", None)
    encoded = json.dumps(payload, ensure_ascii=False, sort_keys=True,
                         separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _approved_content_hash(content: str) -> str:
    encoded = json.dumps({"content": content}, ensure_ascii=False, sort_keys=True,
                         separators=(",", ":")).encode("utf-8")
    return f"sha256:{hashlib.sha256(encoded).hexdigest()}"


class ActionJobManager:
    """Persist only a semantic digest and sanitized receipt before replying."""

    def __init__(self, root: Path,
                 account_resolver: Callable[[str, int], Path],
                 executor: Callable[[Path, ActionRequest], object],
                 reconciler: Callable[
                     [Path, ActionReconciliationRequest], object
                 ] | None = None,
                 now: Callable[[], datetime] | None = None) -> None:
        self._root = root.resolve() / "action-receipts"
        self._root.mkdir(mode=0o700, parents=True, exist_ok=True)
        os.chmod(self._root, 0o700)
        self._lease_root = root.resolve()
        self._resolve, self._execute = account_resolver, executor
        self._reconcile = reconciler
        self._now = now or (lambda: datetime.now(UTC))
        self._lock = threading.Lock()

    def _path(self, action_id: str) -> Path:
        digest = hashlib.sha256(action_id.encode("utf-8")).hexdigest()
        return self._root / f"{digest}.json"

    def _read(self, path: Path, request_hash: str,
              action_id: str) -> ActionReceipt | None:
        if not path.exists():
            return None
        value = json.loads(path.read_text(encoding="utf-8"))
        if value.get("request_hash") != request_hash:
            raise ActionReplayConflict("action_replay_conflict")
        if value.get("state") == "started":
            return ActionReceipt(
                action_id=action_id,
                state="failed",
                platform_receipt_reference=None,
                occurred_at=self._now(),
                failure_code="douyin_action_receipt_ambiguous",
            )
        return ActionReceipt.model_validate(value["receipt"])

    def _persist_value(self, path: Path, value: dict[str, object]) -> None:
        temporary = path.with_suffix(".tmp")
        encoded = json.dumps(
            value,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
        file_flags = os.O_CREAT | os.O_TRUNC | os.O_WRONLY
        if hasattr(os, "O_CLOEXEC"):
            file_flags |= os.O_CLOEXEC
        if hasattr(os, "O_NOFOLLOW"):
            file_flags |= os.O_NOFOLLOW
        descriptor = os.open(temporary, file_flags, 0o600)
        try:
            os.fchmod(descriptor, 0o600)
            with os.fdopen(descriptor, "wb", closefd=False) as stream:
                stream.write(encoded)
                stream.flush()
                os.fsync(descriptor)
        finally:
            os.close(descriptor)
        os.replace(temporary, path)
        directory_flags = os.O_RDONLY
        if hasattr(os, "O_CLOEXEC"):
            directory_flags |= os.O_CLOEXEC
        if hasattr(os, "O_DIRECTORY"):
            directory_flags |= os.O_DIRECTORY
        parent_descriptor = os.open(path.parent, directory_flags)
        try:
            os.fsync(parent_descriptor)
        finally:
            os.close(parent_descriptor)

    def _persist_started(self, path: Path, request_hash: str) -> None:
        self._persist_value(path, {
            "version": 1,
            "state": "started",
            "request_hash": request_hash,
            "started_at": self._now().isoformat(),
        })

    def _persist(self, path: Path, request_hash: str,
                 receipt: ActionReceipt) -> None:
        value: dict[str, object] = {
            "version": 1,
            "state": "completed",
            "request_hash": request_hash,
            "receipt": receipt.model_dump(mode="json"),
        }
        if path.exists():
            previous = json.loads(path.read_text(encoding="utf-8"))
            started_at = previous.get("started_at")
            if isinstance(started_at, str):
                value["started_at"] = started_at
        self._persist_value(path, value)

    def execute(self, request: ActionRequest) -> ActionReceipt:
        request_hash = _semantic_hash(request)
        path = self._path(request.action_id)
        with self._lock:
            replay = self._read(path, request_hash, request.action_id)
            if replay is not None:
                return replay
            try:
                if _approved_content_hash(request.content) != request.approved_content_hash:
                    raise DouyinActionFailure("action_rejected")
                profile = self._resolve(request.account_handle,
                                        request.login_state_version)
                try:
                    lease = acquire_profile_lease(profile, self._lease_root)
                except ProfileLeaseBusy:
                    return ActionReceipt(
                        action_id=request.action_id,
                        state="failed",
                        platform_receipt_reference=None,
                        occurred_at=self._now(),
                        failure_code="douyin_profile_busy",
                    )
                with lease:
                    self._persist_started(path, request_hash)
                    receipt = ActionReceipt.model_validate(
                        self._execute(profile, request)
                    )
            except KeyError:
                receipt = ActionReceipt(action_id=request.action_id, state="failed",
                    platform_receipt_reference=None, occurred_at=self._now(),
                    failure_code="douyin_login_expired")
            except DouyinActionFailure as error:
                receipt = ActionReceipt(action_id=request.action_id, state="failed",
                    platform_receipt_reference=None, occurred_at=self._now(),
                    failure_code=error.code)
            if receipt.action_id != request.action_id:
                raise RuntimeError("douyin_action_receipt_mismatch")
            self._persist(path, request_hash, receipt)
            return receipt

    def reconcile(self, request: ActionRequest) -> ActionReceipt:
        """Reconcile an uncertain action using a strictly read-only adapter."""
        request_hash = _semantic_hash(request)
        path = self._path(request.action_id)
        with self._lock:
            if not path.exists():
                raise ActionReplayConflict("action_reconciliation_not_uncertain")
            value = json.loads(path.read_text(encoding="utf-8"))
            if value.get("request_hash") != request_hash:
                raise ActionReplayConflict("action_replay_conflict")
            if value.get("state") == "completed":
                previous = ActionReceipt.model_validate(value.get("receipt"))
                if previous.state == "succeeded":
                    return previous
                if previous.failure_code not in {
                    "action_unavailable",
                    "douyin_action_timeout",
                    "douyin_action_receipt_ambiguous",
                }:
                    raise ActionReplayConflict(
                        "action_reconciliation_not_uncertain"
                    )
            elif value.get("state") != "started":
                raise ActionReplayConflict("action_reconciliation_not_uncertain")
            if (_approved_content_hash(request.content)
                    != request.approved_content_hash):
                raise ActionReplayConflict("action_replay_conflict")
            if self._reconcile is None:
                return ActionReceipt(
                    action_id=request.action_id,
                    state="failed",
                    platform_receipt_reference=None,
                    occurred_at=self._now(),
                    failure_code="action_unavailable",
                )
            started_at = value.get("started_at")
            if not isinstance(started_at, str):
                return ActionReceipt(
                    action_id=request.action_id,
                    state="failed",
                    platform_receipt_reference=None,
                    occurred_at=self._now(),
                    failure_code="action_unavailable",
                )
            try:
                not_before = datetime.fromisoformat(
                    started_at.replace("Z", "+00:00")
                )
            except ValueError:
                return ActionReceipt(
                    action_id=request.action_id,
                    state="failed",
                    platform_receipt_reference=None,
                    occurred_at=self._now(),
                    failure_code="action_unavailable",
                )
            if not_before.utcoffset() is None:
                return ActionReceipt(
                    action_id=request.action_id,
                    state="failed",
                    platform_receipt_reference=None,
                    occurred_at=self._now(),
                    failure_code="action_unavailable",
                )
            try:
                profile = self._resolve(
                    request.account_handle,
                    request.login_state_version,
                )
                reconciliation_request = ActionReconciliationRequest(
                    **request.model_dump(),
                    not_before=not_before,
                )
                try:
                    lease = acquire_profile_lease(profile, self._lease_root)
                except ProfileLeaseBusy:
                    return ActionReceipt(
                        action_id=request.action_id,
                        state="failed",
                        platform_receipt_reference=None,
                        occurred_at=self._now(),
                        failure_code="douyin_profile_busy",
                    )
                with lease:
                    receipt = ActionReceipt.model_validate(
                        self._reconcile(profile, reconciliation_request)
                    )
            except KeyError:
                receipt = ActionReceipt(
                    action_id=request.action_id,
                    state="failed",
                    platform_receipt_reference=None,
                    occurred_at=self._now(),
                    failure_code="douyin_login_expired",
                )
            except DouyinActionFailure as error:
                receipt = ActionReceipt(
                    action_id=request.action_id,
                    state="failed",
                    platform_receipt_reference=None,
                    occurred_at=self._now(),
                    failure_code=error.code,
                )
            if receipt.action_id != request.action_id:
                raise RuntimeError("douyin_action_receipt_mismatch")
            if receipt.state == "succeeded":
                self._persist(path, request_hash, receipt)
            return receipt

    def close(self) -> None:
        return None
