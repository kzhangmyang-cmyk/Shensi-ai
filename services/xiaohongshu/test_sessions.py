import asyncio
import importlib.util
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from dataclasses import replace
from single_send import ApprovedCommand, SendJournal


class SessionTests(unittest.IsolatedAsyncioTestCase):
    def setup_manager(self, *, enabled=False):
        self.assertIsNotNone(importlib.util.find_spec('sessions'), 'owned account sessions must exist')
        from sessions import SessionManager, Owner
        directory = tempfile.TemporaryDirectory(dir=Path(tempfile.gettempdir()).resolve())
        self.addCleanup(directory.cleanup)
        journal = SendJournal(Path(directory.name) / 'journal.sqlite')
        self.addCleanup(journal.close)
        clock = [100]
        manager = SessionManager(journal, enabled=enabled, clock=lambda: clock[0])
        self.addAsyncCleanup(manager.close_all)
        owner = Owner('workspace', 'actor', 'device')
        command = ApprovedCommand('cmd','workspace','actor','device','account','recipient','synthetic',1,'mid',200)
        return manager, owner, command, journal, clock

    class Client:
        def __init__(self):
            self.auth = SimpleNamespace(user_id='platform-user')
            self.uid = 'platform-user'
            self.ws = None
            self.sent = []
            self.closed = False
            self.started = asyncio.Event()
            self.release = asyncio.Event()
            self.release.set()

        async def connect(self):
            self.ws = object()

        async def close(self):
            self.closed = True
            self.ws = None

        async def send_chat_message(self, **fields):
            self.sent.append(fields)
            self.started.set()
            await self.release.wait()

        async def events(self):
            yield {'decoded': {'im': {'chatACK': {'mid': self.sent[-1]['mid'], 'messageid': 'server', 'code': 0}}}}

    async def test_owned_identity_and_disabled_default(self):
        manager, owner, command, journal, _ = self.setup_manager()
        client = self.Client()
        state = await manager.connect(owner, 'account', 'platform-user', client)
        self.assertEqual(state['state'], 'ready')
        self.assertNotIn('auth', state)
        with self.assertRaisesRegex(ValueError, 'sending_disabled'):
            await manager.execute(owner, state['generation'], command)
        self.assertIsNone(journal.result(command))
        self.assertEqual(client.sent, [])

    async def test_scope_and_generation_must_match_before_write(self):
        manager, owner, command, journal, _ = self.setup_manager(enabled=True)
        client = self.Client()
        state = await manager.connect(owner, 'account', 'platform-user', client)
        for field in ('workspace_id', 'actor_id', 'device_id'):
            with self.assertRaises(ValueError):
                await manager.execute(replace(owner, **{field:'other'}), state['generation'], command)
            with self.assertRaises(ValueError):
                await manager.execute(owner, state['generation'], replace(command, **{field:'other'}))
        with self.assertRaises(ValueError):
            await manager.execute(owner, 'stale-generation', command)
        self.assertIsNone(journal.result(command))
        self.assertEqual(client.sent, [])

    async def test_account_is_exclusive_and_identity_mismatch_closes_only_new_client(self):
        manager, owner, _, _, _ = self.setup_manager()
        client = self.Client()
        await manager.connect(owner, 'account', 'platform-user', client)
        duplicate = self.Client()
        with self.assertRaisesRegex(ValueError, 'account_busy'):
            await manager.connect(owner, 'account', 'platform-user', duplicate)
        self.assertFalse(client.closed)
        mismatch = self.Client()
        with self.assertRaisesRegex(ValueError, 'identity_changed'):
            await manager.connect(owner, 'other', 'wrong-user', mismatch)
        self.assertTrue(mismatch.closed)

    async def test_logout_cancels_send_and_keeps_durable_unknown(self):
        manager, owner, command, journal, _ = self.setup_manager(enabled=True)
        client = self.Client()
        client.release.clear()
        state = await manager.connect(owner, 'account', 'platform-user', client)
        task = asyncio.create_task(manager.execute(owner, state['generation'], command))
        await client.started.wait()
        await manager.close(owner, 'account')
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertTrue(client.closed)
        self.assertEqual(journal.result(command).status, 'unknown')
        replacement = self.Client()
        current = await manager.connect(owner, 'account', 'platform-user', replacement)
        self.assertNotEqual(current['generation'], state['generation'])
        self.assertEqual((await manager.execute(owner, current['generation'], command)).status, 'unknown')
        self.assertEqual(replacement.sent, [])

    async def test_waiting_command_rechecks_expiry_after_account_lock(self):
        manager, owner, command, journal, clock = self.setup_manager(enabled=True)
        client = self.Client()
        client.release.clear()
        state = await manager.connect(owner, 'account', 'platform-user', client)
        first = asyncio.create_task(manager.execute(owner, state['generation'], command))
        await client.started.wait()
        next_command = replace(command, command_id='next', client_message_id='next-mid')
        second = asyncio.create_task(manager.execute(owner, state['generation'], next_command))
        await asyncio.sleep(0)
        clock[0] = 201
        client.release.set()
        self.assertEqual((await first).status, 'confirmed')
        with self.assertRaisesRegex(ValueError, 'command_not_executable'):
            await second
        self.assertIsNone(journal.result(next_command))
        self.assertEqual(len(client.sent), 1)

    async def test_closing_one_account_does_not_close_another(self):
        manager, owner, _, _, _ = self.setup_manager()
        first, second = self.Client(), self.Client()
        await manager.connect(owner, 'account', 'platform-user', first)
        await manager.connect(owner, 'other-account', 'platform-user', second)
        await manager.close(owner, 'account')
        self.assertTrue(first.closed)
        self.assertFalse(second.closed)

    async def test_close_during_connect_cannot_resurrect_old_generation(self):
        manager, owner, _, _, _ = self.setup_manager()
        class Opening(self.Client):
            async def connect(self):
                self.started.set()
                await asyncio.Event().wait()
        client = Opening()
        opening = asyncio.create_task(manager.connect(owner, 'account', 'platform-user', client))
        await client.started.wait()
        await manager.close(owner, 'account')
        with self.assertRaises(asyncio.CancelledError):
            await opening
        self.assertTrue(client.closed)
        next_client = self.Client()
        self.assertEqual((await manager.connect(owner, 'account', 'platform-user', next_client))['state'], 'ready')

    async def test_failed_close_keeps_account_reserved_until_successful_cleanup(self):
        manager, owner, _, _, _ = self.setup_manager()
        class BrokenClose(self.Client):
            fail = True
            async def close(self):
                if self.fail:
                    raise ConnectionError('synthetic close failure')
                await super().close()
        client = BrokenClose()
        await manager.connect(owner, 'account', 'platform-user', client)
        with self.assertRaises(ConnectionError):
            await manager.close(owner, 'account')
        with self.assertRaisesRegex(ValueError, 'account_busy'):
            await manager.connect(owner, 'account', 'platform-user', self.Client())
        client.fail = False
        await manager.close(owner, 'account')
        self.assertTrue(client.closed)
