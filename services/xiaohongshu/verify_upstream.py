"""Development-only pinned decoder compatibility check, with synthetic bytes."""
import base64
import json
import pathlib
import subprocess
import sys
import asyncio
import tempfile
from types import SimpleNamespace
from receipts import ReceiptTracker
from single_send import ApprovedCommand, SendJournal, SingleSendExecutor
from upstream_transport import UpstreamImTransport
from browser_login import BrowserImState

root = pathlib.Path(sys.argv[1]).resolve(strict=True)
revision = subprocess.check_output(["git", "-C", str(root), "rev-parse", "HEAD"], text=True).strip()
if revision != "7077c88f82771f547cc1afdadaec4025be2355e6":
    raise SystemExit("unexpected_upstream_revision")
if subprocess.check_output(["git", "-C", str(root), "status", "--porcelain"], text=True).strip():
    raise SystemExit("modified_upstream_source")
sys.path.insert(0, str(root))
from apis.xhs_live import XHSWebSocket

# Only reuse upstream's WS codec/client; no alternate QR/SMS/fingerprint factory.
owned_state = BrowserImState('synthetic-user', 'synthetic-sid', 'synthetic-device', 'synthetic-fingerprint', {})
owned_client = owned_state.create_client(XHSWebSocket)
owned_handshake = json.loads(owned_client.handshake())['b']['d']['b']
assert owned_handshake['authInfo']['uid'] == 'synthetic-user'
assert owned_handshake['authInfo']['sid'] == 'synthetic-sid'
assert owned_handshake['deviceInfo']['deviceId'] == 'synthetic-device'
assert owned_handshake['deviceInfo']['fingerprint'] == 'synthetic-fingerprint'
print('XHS_OWNED_BROWSER_STATE_COMPATIBILITY_OK: exact state, no network')

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


async def verify_send_boundary():
    from apis.xhs_live import _pb_read_fields
    class Wire:
        def __init__(self):
            self.sent = []
        async def send_str(self, text):
            self.sent.append(json.loads(text))
        def __aiter__(self):
            return self.incoming()
        async def incoming(self):
            yield SimpleNamespace(type=SimpleNamespace(name='TEXT'), data=json.dumps(frames[0]))
    client = XHSWebSocket(SimpleNamespace(user_id='sender-a'), uid='sender-a')
    client.ws = Wire()
    with tempfile.TemporaryDirectory(dir=pathlib.Path(tempfile.gettempdir()).resolve()) as directory:
        journal = SendJournal(pathlib.Path(directory) / 'journal.sqlite')
        try:
            command = ApprovedCommand('cmd-a','workspace-a','actor-a','device-a','account-a','recipient-a','synthetic',1,'client-a',200)
            sender = SingleSendExecutor(journal, UpstreamImTransport(client,'account-a','sender-a',clock=lambda:100),
                                        'account-a','generation-a',enabled=True)
            receipt = await sender.execute(command,now=100)
            assert receipt.status == 'confirmed' and receipt.server_message_id == 'server-a'
            await sender.execute(command,now=100)
            assert len(client.ws.sent) == 1
            data = client.ws.sent[0]['b']['d']
            assert data['biz'] == 'im' and data['c'] == 'sendMessage'
            outer = _pb_read_fields(base64.b64decode(data['b']))
            message = _pb_read_fields(outer[9][0][1])
            assert message[1][0][1] == b'client-a'
            assert message[4][0][1] == b'sender-a'
            assert message[5][0][1] == b'recipient-a'
            assert message[6][0][1] == b'synthetic'
        finally:
            journal.close()
    print('XHS_PINNED_SINGLE_SEND_OK: real encoder/decoder, synthetic socket, one write')


asyncio.run(verify_send_boundary())
