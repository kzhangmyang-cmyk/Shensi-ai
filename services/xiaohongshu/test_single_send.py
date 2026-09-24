import asyncio
import importlib.util
import os
import tempfile
import unittest
from pathlib import Path


class SingleSendTests(unittest.IsolatedAsyncioTestCase):
    def setup_adapter(self):
        self.assertIsNotNone(importlib.util.find_spec('single_send'), 'single-send adapter exists')
        from single_send import ApprovedCommand, SendJournal, SingleSendExecutor
        directory = tempfile.TemporaryDirectory(dir=Path(tempfile.gettempdir()).resolve())
        self.addCleanup(directory.cleanup)
        journal = SendJournal(Path(directory.name) / 'journal.sqlite')
        self.addCleanup(journal.close)
        command = ApprovedCommand('cmd-a', 'workspace-a', 'actor-a', 'device-a', 'account-a', 'recipient-a', 'synthetic message', 1, 'mid-a', 200)
        return directory, journal, command, SingleSendExecutor

    class Transport:
        def __init__(self, journal, command, frames=(), fail=False):
            self.journal, self.command, self.frames, self.fail = journal, command, frames, fail
            self.calls = 0

        async def send(self, command):
            self.calls += 1
            assert self.journal.result(command).status == 'unknown', 'durable uncertainty precedes network write'
            if self.fail:
                raise ConnectionError('synthetic transport failure')

        async def events(self):
            for frame in self.frames:
                yield frame

    def ack(self):
        return {'decoded': {'im': {'chatACK': {'mid': 'mid-a', 'messageid': 'server-a', 'code': 0}}}}

    async def test_disabled_is_default_and_does_not_claim_or_send(self):
        _, journal, command, executor = self.setup_adapter()
        transport = self.Transport(journal, command)
        with self.assertRaisesRegex(ValueError, 'sending_disabled'):
            await executor(journal, transport, 'account-a', 'generation-a').execute(command, now=100)
        self.assertIsNone(journal.result(command))
        self.assertEqual(transport.calls, 0)

    async def test_exact_ack_confirms_and_duplicate_never_resends(self):
        _, journal, command, executor = self.setup_adapter()
        transport = self.Transport(journal, command, [self.ack()])
        sender = executor(journal, transport, 'account-a', 'generation-a', enabled=True)
        first = await sender.execute(command, now=100)
        self.assertEqual(first.status, 'confirmed')
        self.assertEqual(await sender.execute(command, now=100), first)
        self.assertEqual(transport.calls, 1)

    async def test_network_error_persists_unknown_across_reopen(self):
        directory, journal, command, executor = self.setup_adapter()
        transport = self.Transport(journal, command, fail=True)
        result = await executor(journal, transport, 'account-a', 'generation-a', enabled=True).execute(command, now=100)
        self.assertEqual(result.status, 'unknown')
        from single_send import SendJournal
        reopened = SendJournal(Path(directory.name) / 'journal.sqlite')
        self.addCleanup(reopened.close)
        retry = self.Transport(reopened, command)
        self.assertEqual((await executor(reopened, retry, 'account-a', 'generation-b', enabled=True).execute(command, now=100)).status, 'unknown')
        self.assertEqual(retry.calls, 0)

    async def test_changed_approval_and_cross_scope_replay_are_rejected(self):
        from dataclasses import replace
        _, journal, command, executor = self.setup_adapter()
        journal.begin(command)
        for changes in [{'body': 'changed'}, {'recipient_id': 'other'}, {'revision': 2}, {'workspace_id': 'other'}, {'actor_id': 'other'}, {'device_id': 'other'}, {'account_id': 'other'}, {'client_message_id': 'other'}]:
            with self.subTest(changes=changes), self.assertRaisesRegex(ValueError, 'command_conflict'):
                journal.begin(replace(command, **changes))

    async def test_expired_or_wrong_account_never_claims(self):
        _, journal, command, executor = self.setup_adapter()
        transport = self.Transport(journal, command)
        for account, now in [('other', 100), ('account-a', 200)]:
            with self.assertRaises(ValueError):
                await executor(journal, transport, account, 'generation-a', enabled=True).execute(command, now=now)
        self.assertIsNone(journal.result(command))
        self.assertEqual(transport.calls, 0)

    async def test_two_instances_share_atomic_claim(self):
        directory, journal, command, executor = self.setup_adapter()
        from single_send import SendJournal
        other = SendJournal(Path(directory.name) / 'journal.sqlite')
        self.addCleanup(other.close)
        a, b = self.Transport(journal, command, [self.ack()]), self.Transport(other, command, [self.ack()])
        await asyncio.gather(executor(journal,a,'account-a','g',enabled=True).execute(command,now=100), executor(other,b,'account-a','g',enabled=True).execute(command,now=100))
        self.assertEqual(a.calls + b.calls, 1)

    async def test_journal_is_private_and_does_not_store_body(self):
        directory, journal, command, _ = self.setup_adapter()
        journal.begin(command)
        target = Path(directory.name) / 'journal.sqlite'
        self.assertEqual(target.stat().st_mode & 0o777, 0o600)
        self.assertNotIn(command.body.encode(), target.read_bytes())

    async def test_symlink_target_is_refused(self):
        directory, _, _, _ = self.setup_adapter()
        from single_send import SendJournal
        link = Path(directory.name) / 'alias.sqlite'
        link.symlink_to(Path(directory.name) / 'journal.sqlite')
        with self.assertRaises(ValueError):
            SendJournal(link)

    async def test_cancel_after_claim_is_unknown_and_not_retried(self):
        _, journal, command, executor = self.setup_adapter()
        started = asyncio.Event()
        class Hanging(self.Transport):
            async def send(self, command):
                await super().send(command)
                started.set()
                await asyncio.Event().wait()
        transport = Hanging(journal, command)
        sender = executor(journal, transport, 'account-a', 'g', enabled=True)
        task = asyncio.create_task(sender.execute(command, now=100))
        await started.wait()
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertEqual(journal.result(command).status, 'unknown')
        await sender.execute(command, now=100)
        self.assertEqual(transport.calls, 1)

    async def test_missing_ack_times_out_without_second_send(self):
        _, journal, command, executor = self.setup_adapter()
        class Hanging(self.Transport):
            async def events(self):
                await asyncio.Event().wait()
                yield None
        transport = Hanging(journal, command)
        sender = executor(journal, transport, 'account-a', 'g', enabled=True, timeout=0.01)
        self.assertEqual((await sender.execute(command, now=100)).status, 'unknown')
        self.assertEqual((await sender.execute(command, now=100)).status, 'unknown')
        self.assertEqual(transport.calls, 1)

    async def test_new_command_cannot_reuse_prior_client_message_id(self):
        from dataclasses import replace
        _, journal, command, _ = self.setup_adapter()
        journal.begin(command)
        with self.assertRaisesRegex(ValueError, 'message_id_reused'):
            journal.begin(replace(command, command_id='cmd-b'))
