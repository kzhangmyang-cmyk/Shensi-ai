"""Development-only pinned decoder compatibility check, with synthetic bytes."""
import base64
import json
import pathlib
import subprocess
import sys
from receipts import ReceiptTracker

root = pathlib.Path(sys.argv[1]).resolve(strict=True)
revision = subprocess.check_output(["git", "-C", str(root), "rev-parse", "HEAD"], text=True).strip()
if revision != "7077c88f82771f547cc1afdadaec4025be2355e6":
    raise SystemExit("unexpected_upstream_revision")
if subprocess.check_output(["git", "-C", str(root), "status", "--porcelain"], text=True).strip():
    raise SystemExit("modified_upstream_source")
sys.path.insert(0, str(root))
from apis.xhs_live import XHSWebSocket

# Hand-built protobuf: outer ChatACK field 5; mid field 1 and messageid field 2.
# Zero status is omitted on the wire by protobuf's default-value convention.
payload = base64.b64encode(bytes.fromhex("2a140a08636c69656e742d6112087365727665722d61")).decode()
frames = [
    {"v": 1, "t": 3, "b": {"a": {"c": 0, "b": payload}}},
    {"v": 1, "t": 4, "b": {"d": {"biz": "im", "b": [{"d": payload}]}}},
]
for frame in frames:
    tracker = ReceiptTracker("account-a", "generation-a", "client-a")
    result = tracker.observe("account-a", "generation-a", XHSWebSocket._decode_text_frame(json.dumps(frame)))
    assert result.status == "confirmed" and result.server_message_id == "server-a"
print("XHS_PINNED_DECODER_COMPATIBILITY_OK: direct and push-batch ACK; no network")
