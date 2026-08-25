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
from .schemas import ActionReceipt, ActionRequest


class ActionReplayConflict(RuntimeError):
    pass


def _semantic_hash(request: ActionRequest) -> str:
    payload = request.model_dump(mode="json")
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
                 now: Callable[[], datetime] | None = None) -> None:
        self._root = root.resolve() / "action-receipts"
        self._root.mkdir(mode=0o700, parents=True, exist_ok=True)
        os.chmod(self._root, 0o700)
        self._resolve, self._execute = account_resolver, executor
        self._now = now or (lambda: datetime.now(UTC))
        self._lock = threading.Lock()

    def _path(self, action_id: str) -> Path:
        digest = hashlib.sha256(action_id.encode("utf-8")).hexdigest()
        return self._root / f"{digest}.json"

    def _read(self, path: Path, request_hash: str) -> ActionReceipt | None:
        if not path.exists():
            return None
        value = json.loads(path.read_text(encoding="utf-8"))
        if value.get("request_hash") != request_hash:
            raise ActionReplayConflict("action_replay_conflict")
        return ActionReceipt.model_validate(value["receipt"])

    def _persist(self, path: Path, request_hash: str, receipt: ActionReceipt) -> None:
        temporary = path.with_suffix(".tmp")
        temporary.write_text(json.dumps({"request_hash": request_hash,
            "receipt": receipt.model_dump(mode="json")}, sort_keys=True,
            separators=(",", ":")), encoding="utf-8")
        os.chmod(temporary, 0o600)
        os.replace(temporary, path)
        os.chmod(path, 0o600)

    def execute(self, request: ActionRequest) -> ActionReceipt:
        request_hash = _semantic_hash(request)
        path = self._path(request.action_id)
        with self._lock:
            replay = self._read(path, request_hash)
            if replay is not None:
                return replay
            try:
                if _approved_content_hash(request.content) != request.approved_content_hash:
                    raise DouyinActionFailure("action_rejected")
                profile = self._resolve(request.account_handle,
                                        request.login_state_version)
                receipt = ActionReceipt.model_validate(self._execute(profile, request))
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

    def close(self) -> None:
        return None
