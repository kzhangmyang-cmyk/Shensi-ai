"""Bridge to pinned Spider_XHS XHSWebSocket; never use its random-mid helper.

Constructor defaults match upstream send_private_message at 7077c88, but the
client message ID comes from the durable approved command. No HTTP fallback.
"""
import time
from receipts import _identifier


class UpstreamImTransport:
    def __init__(self, client, account_id, platform_user_id, *, clock=time.time):
        if not _identifier(account_id) or not _identifier(platform_user_id):
            raise ValueError('invalid_transport_identity')
        self.client, self.account_id = client, account_id
        self.platform_user_id, self.clock = platform_user_id, clock
        self._check_identity()

    def _check_identity(self):
        if str(self.client.auth.user_id) != self.platform_user_id or str(self.client.uid) != self.platform_user_id:
            raise ValueError('identity_changed')

    async def send(self, command):
        self._check_identity()
        if command.account_id != self.account_id:
            raise ValueError('wrong_transport_account')
        if self.client.ws is None:
            raise ConnectionError('im_disconnected')
        await self.client.send_chat_message(mid=command.client_message_id,
            ts=int(self.clock() * 1000), token='', sender=self.platform_user_id,
            receiver=command.recipient_id, content=command.body, content_type=1,
            nickname='', group_chat=False, command=None, ref_id='', trigger_source=1)
        # Transmission return is intentionally not a successful receipt.

    async def events(self):
        async for frame in self.client.events():
            self._check_identity()
            yield frame
