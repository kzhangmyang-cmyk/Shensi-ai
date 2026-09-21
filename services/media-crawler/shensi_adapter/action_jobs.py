"""Durable, exact-replay wrapper for per-account Douyin actions."""

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
    ActionAcknowledgement,
    DesktopActionRequest,
    DesktopActionReconciliationRequest,
    DesktopActionReceipt,
)
from .profile_lease import ProfileLeaseBusy, acquire_profile_lease


class ActionReplayConflict(RuntimeError):
    pass


def _semantic_hash(request: ActionRequest | DesktopActionRequest) -> str:
    payload = request.model_dump(mode="json")
    payload.pop("deadline_at", None)
    payload.pop("request_hash", None)
    if isinstance(request, DesktopActionReconciliationRequest):
        payload.pop("observation_login_state_version", None)
    encoded = json.dumps(payload, ensure_ascii=False, sort_keys=True,
                         separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _receipt_hash(receipt: ActionReceipt) -> str:
    canonical = DesktopActionReceipt.model_validate(receipt.model_dump())
    encoded = json.dumps(canonical.model_dump(mode="json"), ensure_ascii=False,
                         sort_keys=True, separators=(",", ":")).encode("utf-8")
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
        self._ack_root = root.resolve() / "action-acknowledgements"
        self._ack_root.mkdir(mode=0o700, parents=True, exist_ok=True)
        os.chmod(self._ack_root, 0o700)
        self._lease_root = root.resolve()
        self._resolve, self._execute = account_resolver, executor
        self._reconcile = reconciler
        self._now = now or (lambda: datetime.now(UTC))
        self._keyed_locks_guard = threading.Lock()
        self._action_locks: dict[str, threading.Lock] = {}
        self._account_locks: dict[str, threading.Lock] = {}

    def _keyed_lock(
        self,
        locks: dict[str, threading.Lock],
        key: str,
    ) -> threading.Lock:
        with self._keyed_locks_guard:
            return locks.setdefault(
                key,
                threading.Lock(),
            )

    def _action_lock(self, action_id: str) -> threading.Lock:
        return self._keyed_lock(self._action_locks, action_id)

    def _account_lock(self, account_handle: str) -> threading.Lock:
        return self._keyed_lock(self._account_locks, account_handle)

    def _path(self, action_id: str) -> Path:
        digest = hashlib.sha256(action_id.encode("utf-8")).hexdigest()
        return self._root / f"{digest}.json"

    def _read(self, path: Path, request_hash: str,
              action_id: str) -> ActionReceipt | None:
        if not path.exists():
            path = self._ack_root / path.name
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
        receipt = (DesktopActionReceipt if "receipt_hash" in value else ActionReceipt).model_validate(value["receipt"])
        if "receipt_hash" in value and value["receipt_hash"] != _receipt_hash(receipt):
            raise ActionReplayConflict("action_replay_conflict")
        return receipt

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
        if isinstance(receipt, DesktopActionReceipt):
            value["receipt_hash"] = _receipt_hash(receipt)
        if path.exists():
            previous = json.loads(path.read_text(encoding="utf-8"))
            started_at = previous.get("started_at")
            if isinstance(started_at, str):
                value["started_at"] = started_at
        self._persist_value(path, value)

    def execute(self, request: ActionRequest | DesktopActionRequest) -> ActionReceipt:
        if isinstance(request, DesktopActionReconciliationRequest):
            raise ActionReplayConflict("reconciliation_only")
        request_hash = _semantic_hash(request)
        desktop = isinstance(request, DesktopActionRequest)
        if desktop and request_hash != request.request_hash:
            raise ActionReplayConflict("action_replay_conflict")
        path = self._path(request.action_id)
        with (
            self._action_lock(request.action_id),
            self._account_lock(request.account_handle),
        ):
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
                        self._execute(profile, request.executor_request() if desktop else request)
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
            if desktop:
                receipt = DesktopActionReceipt.model_validate(receipt.model_dump())
            self._persist(path, request_hash, receipt)
            return receipt

    def reconcile(self, request: ActionRequest | DesktopActionRequest) -> ActionReceipt:
        """Reconcile an uncertain action using a strictly read-only adapter."""
        request_hash = _semantic_hash(request)
        desktop = isinstance(request, DesktopActionRequest)
        if desktop and request_hash != request.request_hash:
            raise ActionReplayConflict("action_replay_conflict")
        path = self._path(request.action_id)
        with (
            self._action_lock(request.action_id),
            self._account_lock(request.account_handle),
        ):
            acknowledged_source = False
            if not path.exists():
                acknowledged = self._ack_root / path.name
                if acknowledged.exists():
                    path = acknowledged
                    acknowledged_source = True
                else:
                    raise ActionReplayConflict("action_reconciliation_not_uncertain")
            value = json.loads(path.read_text(encoding="utf-8"))
            if value.get("request_hash") != request_hash:
                raise ActionReplayConflict("action_replay_conflict")
            if value.get("state") == "completed":
                previous = self._read(path, request_hash, request.action_id)
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
                observation_version = (
                    request.observation_login_state_version
                    if isinstance(request, DesktopActionReconciliationRequest)
                    else None
                ) or request.login_state_version
                profile = self._resolve(request.account_handle, observation_version)
                payload = (request.executor_request() if desktop else request).model_dump()
                payload["login_state_version"] = observation_version
                reconciliation_request = ActionReconciliationRequest(
                    **payload, not_before=not_before,
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
            if desktop:
                receipt = DesktopActionReceipt.model_validate(receipt.model_dump())
            if receipt.state == "succeeded" and not acknowledged_source:
                self._persist(path, request_hash, receipt)
            return receipt

    def acknowledge(self, action_id: str, request_hash: str,
                    receipt_hash: str) -> ActionAcknowledgement:
        """Remove only a matching completed desktop receipt after central commit."""
        path = self._path(action_id)
        with self._action_lock(action_id):
            acknowledged_path = self._ack_root / path.name
            source = path if path.exists() else acknowledged_path
            try:
                if source.is_symlink():
                    raise ValueError("invalid journal")
                value = json.loads(source.read_text(encoding="utf-8"))
                if (not isinstance(value, dict) or value.get("state") != "completed"
                        or value.get("request_hash") != request_hash
                        or value.get("receipt_hash") != receipt_hash):
                    raise ValueError("conflicting journal")
                receipt = DesktopActionReceipt.model_validate(value["receipt"])
                if receipt.action_id != action_id or _receipt_hash(receipt) != receipt_hash:
                    raise ValueError("conflicting receipt")
                acknowledged_at = value.get("acknowledged_at")
                result = ActionAcknowledgement(
                    action_id=action_id,
                    acknowledged_at=acknowledged_at or self._now(),
                )
            except (OSError, ValueError, TypeError, KeyError) as error:
                raise ActionReplayConflict("action_acknowledgement_conflict") from error
            if source == acknowledged_path:
                return result
            # A retained sanitized tombstone makes lost acknowledgement replies
            # retryable and prevents the same action entering execute again.
            value["acknowledged_at"] = result.model_dump(mode="json")["acknowledged_at"]
            self._persist_value(path, value)
            os.replace(path, acknowledged_path)
            for directory in (path.parent, acknowledged_path.parent):
                descriptor = os.open(directory, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
                try:
                    os.fsync(descriptor)
                finally:
                    os.close(descriptor)
            return result

    def close(self) -> None:
        return None
