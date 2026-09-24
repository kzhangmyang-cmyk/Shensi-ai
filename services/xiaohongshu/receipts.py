"""Correlate Spider_XHS decoded IM acknowledgements, never transport ACKs.

The owning adapter supplies account and connection generation from its own
session, not from incoming network data. This module performs no network I/O.
"""
from dataclasses import dataclass
from typing import Literal


@dataclass(frozen=True)
class Receipt:
    status: Literal["pending", "unknown", "confirmed", "rejected"]
    server_message_id: str | None = None
    platform_code: int | None = None


def _identifier(value):
    return isinstance(value, str) and 0 < len(value) <= 255 and all(ord(c) > 32 and ord(c) != 127 for c in value)


class ReceiptTracker:
    def __init__(self, account_id: str, generation: str, client_message_id: str):
        if not all(_identifier(v) for v in (account_id, generation, client_message_id)):
            raise ValueError("invalid_receipt_identity")
        self._identity = (account_id, generation, client_message_id)
        self.receipt = Receipt("pending")

    def disconnected(self) -> Receipt:
        if self.receipt.status == "pending":
            self.receipt = Receipt("unknown")
        return self.receipt

    def observe(self, account_id: str, generation: str, frame: object) -> Receipt:
        if self.receipt.status in ("confirmed", "rejected") or (account_id, generation) != self._identity[:2]:
            return self.receipt
        ack = frame
        for key in ("decoded", "im"):
            if not isinstance(ack, dict):
                return self.receipt
            ack = ack.get(key)
        if isinstance(ack, list):
            for item in ack:
                if isinstance(item, dict):
                    self.observe(account_id, generation, {"decoded": {"im": item}})
            return self.receipt
        if not isinstance(ack, dict):
            return self.receipt
        ack = ack.get("chatACK")
        if not isinstance(ack, dict) or ack.get("mid") != self._identity[2]:
            return self.receipt
        code = ack.get("code")
        if type(code) is not int or not 0 <= code <= 2**32 - 1:
            return self.receipt
        if code != 0:
            self.receipt = Receipt("rejected", platform_code=code)
        elif _identifier(ack.get("messageid")):
            self.receipt = Receipt("confirmed", server_message_id=ack["messageid"], platform_code=0)
        return self.receipt
