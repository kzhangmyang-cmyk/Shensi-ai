import importlib.util
import unittest
from types import SimpleNamespace
from single_send import ApprovedCommand


class TransportTests(unittest.IsolatedAsyncioTestCase):
    def make(self):
        self.assertIsNotNone(importlib.util.find_spec('upstream_transport'), 'upstream transport adapter exists')
        from upstream_transport import UpstreamImTransport
        class Client:
            auth = SimpleNamespace(user_id='platform-user')
            uid = 'platform-user'
            ws = object()
            calls = []

            async def send_chat_message(self, **fields):
                self.calls.append(fields)
                return {'mid': fields['mid']}

            async def events(self):
                yield {'decoded': {'im': {'chatACK': {'mid': 'mid', 'code': 0, 'messageid': 'server'}}}}
        client = Client()
        client.calls = []
        command = ApprovedCommand('cmd','workspace','actor','device','account','recipient','正文',1,'mid',200)
        return client, command, UpstreamImTransport(client, 'account', 'platform-user', clock=lambda:100)

    async def test_preserves_approved_message_id_and_exact_recipient_and_text(self):
        client, command, transport = self.make()
        self.assertIsNone(await transport.send(command))
        self.assertEqual(client.calls, [{'mid':'mid','ts':100000,'token':'','sender':'platform-user','receiver':'recipient',
            'content':'正文','content_type':1,'nickname':'','group_chat':False,'command':None,'ref_id':'','trigger_source':1}])
        event = await anext(transport.events())
        self.assertEqual(event['decoded']['im']['chatACK']['messageid'], 'server')

    async def test_changed_platform_identity_stops_before_write(self):
        client, command, transport = self.make()
        client.auth = SimpleNamespace(user_id='other')
        with self.assertRaisesRegex(ValueError, 'identity_changed'):
            await transport.send(command)
        self.assertEqual(client.calls, [])

    async def test_other_account_or_disconnected_client_is_rejected(self):
        from dataclasses import replace
        client, command, transport = self.make()
        with self.assertRaises(ValueError):
            await transport.send(replace(command, account_id='other'))
        client.ws = None
        with self.assertRaises(ConnectionError):
            await transport.send(command)
        self.assertEqual(client.calls, [])
