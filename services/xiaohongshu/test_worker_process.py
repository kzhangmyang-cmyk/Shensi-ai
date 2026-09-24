import asyncio
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from sessions import Owner


class WorkerProcessTests(unittest.IsolatedAsyncioTestCase):
    def module(self):
        self.assertIsNotNone(importlib.util.find_spec('worker_process'), 'private worker process exists')
        import worker_process
        return worker_process

    async def test_identity_scoped_directory_lease_prevents_duplicate_process(self):
        module = self.module()
        with tempfile.TemporaryDirectory(dir=Path(tempfile.gettempdir()).resolve()) as root:
            owner = Owner('workspace','actor','device')
            with module.owned_storage(Path(root), owner) as first:
                self.assertEqual(first.stat().st_mode & 0o777,0o700)
                with self.assertRaisesRegex(ValueError,'worker_already_running'):
                    with module.owned_storage(Path(root), owner): pass
                with module.owned_storage(Path(root), Owner('other','actor','device')) as other:
                    self.assertNotEqual(first,other)
            with module.owned_storage(Path(root),owner) as reopened:
                self.assertEqual(first,reopened)

    async def test_eof_cancels_inflight_and_closes_runtime_without_raw_errors(self):
        module = self.module()
        reader = asyncio.StreamReader(limit=65536)
        started = asyncio.Event()
        class Runtime:
            closed = False
            cancelled = False
            async def request(self, raw):
                started.set()
                try: await asyncio.Event().wait()
                finally: self.cancelled = True
            async def close_all(self): self.closed = True
        runtime=Runtime(); output=[]
        async def write(value): output.append(value)
        reader.feed_data(b'{"id":"00000000-0000-4000-8000-000000000001","operation":"open","accountId":"00000000-0000-4000-8000-000000000002"}\n')
        serving=asyncio.create_task(module.serve(reader,write,runtime))
        await asyncio.wait_for(started.wait(),1)
        reader.feed_eof()
        await serving
        self.assertTrue(runtime.closed)
        self.assertTrue(runtime.cancelled)
        self.assertEqual(output,[])

    async def test_oversized_line_closes_instead_of_buffering_unlimited_data(self):
        module=self.module()
        reader=asyncio.StreamReader(limit=65536)
        class Runtime:
            closed=False
            async def request(self,raw): raise AssertionError('must not dispatch')
            async def close_all(self): self.closed=True
        runtime=Runtime();output=[]
        async def write(value):output.append(value)
        reader.feed_data(b'x'*65538+b'\n');reader.feed_eof()
        await module.serve(reader,write,runtime)
        self.assertTrue(runtime.closed)
        self.assertEqual(output,[{'id':None,'error':'invalid_request'}])

    async def test_upstream_rejects_project_repository_before_import(self):
        module=self.module()
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(ValueError,'invalid_upstream'):
                module.load_upstream(Path(directory))
