import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from browser_login import BrowserImState
from sessions import Owner, SessionManager
from single_send import SendJournal
import test_sessions


class RuntimeTests(unittest.IsolatedAsyncioTestCase):
    account = '00000000-0000-4000-8000-000000000002'

    def setup_runtime(self, enabled=False):
        self.assertIsNotNone(importlib.util.find_spec('worker_runtime'), 'worker orchestration exists')
        from worker_runtime import WorkerRuntime
        directory = tempfile.TemporaryDirectory(dir=Path(tempfile.gettempdir()).resolve())
        self.addCleanup(directory.cleanup)
        journal = SendJournal(Path(directory.name) / 'journal.sqlite')
        self.addCleanup(journal.close)
        class Browser:
            opened = False
            async def open(self, account): self.opened = True
            async def capture_im_state(self, account):
                if not self.opened: raise ValueError('login_not_open')
                return BrowserImState('platform-user', 'secret', 'device', 'fingerprint', {})
            async def close(self, account): self.opened = False
            async def close_all(self): self.opened = False
        clients = []
        def factory(auth, **kwargs):
            client = test_sessions.SessionTests.Client()
            clients.append(client)
            return client
        runtime = WorkerRuntime(Owner('workspace','actor','device'), Browser(),
                                SessionManager(journal, enabled=enabled, clock=lambda:100), factory)
        self.addAsyncCleanup(runtime.close_all)
        return runtime, clients

    async def request(self, runtime, operation, **fields):
        return await runtime.request(json.dumps({'id':'00000000-0000-4000-8000-000000000001',
                                                 'operation':operation, **fields}))

    async def test_connect_requires_owned_login_and_returns_no_credentials(self):
        runtime, clients = self.setup_runtime()
        result = await self.request(runtime, 'connect', accountId=self.account)
        self.assertEqual(result['error'], 'login_not_open')
        await self.request(runtime, 'open', accountId=self.account)
        result = await self.request(runtime, 'connect', accountId=self.account)
        self.assertEqual(result['result']['platformUserId'], 'platform-user')
        self.assertEqual(result['result']['state'], 'ready')
        self.assertNotIn('secret', json.dumps(result))
        await self.request(runtime, 'close', accountId=self.account)
        self.assertTrue(clients[0].closed)

    async def test_execute_uses_approved_identity_and_preserves_disabled_default(self):
        runtime, clients = self.setup_runtime()
        await self.request(runtime,'open',accountId=self.account)
        connected = (await self.request(runtime,'connect',accountId=self.account))['result']
        command = dict(commandId='00000000-0000-4000-8000-000000000003',accountId=self.account,
                       workspaceId='workspace',actorId='actor',deviceId='device',recipientId='recipient',
                       body='synthetic',revision=1,clientMessageId='00000000-0000-4000-8000-000000000004',
                       generation=connected['generation'],expiresAt=200000)
        result = await self.request(runtime,'execute',command=command)
        self.assertEqual(result['error'],'sending_disabled')
        result = await self.request(runtime,'execute',command={**command,'actorId':'other'})
        self.assertEqual(result['error'],'invalid_request')
        self.assertEqual(clients[0].sent,[])

    async def test_exact_ack_and_duplicate_command_have_only_one_write(self):
        runtime, clients = self.setup_runtime(enabled=True)
        await self.request(runtime,'open',accountId=self.account)
        connected = (await self.request(runtime,'connect',accountId=self.account))['result']
        command = dict(commandId='00000000-0000-4000-8000-000000000003',accountId=self.account,
                       workspaceId='workspace',actorId='actor',deviceId='device',recipientId='recipient',
                       body='synthetic',revision=1,clientMessageId='00000000-0000-4000-8000-000000000004',
                       generation=connected['generation'],expiresAt=200000)
        for _ in range(2):
            result = await self.request(runtime,'execute',command=command)
            self.assertEqual(result['result'],{'status':'confirmed','serverMessageId':'server'})
        self.assertEqual(len(clients[0].sent),1)

    async def test_untrusted_exception_text_never_leaves_process(self):
        runtime, _ = self.setup_runtime()
        async def broken(account): raise RuntimeError('secret-cookie-value')
        runtime.browser.open = broken
        result = await self.request(runtime,'open',accountId=self.account)
        self.assertEqual(result['error'],'worker_operation_failed')
        self.assertNotIn('secret',json.dumps(result))
