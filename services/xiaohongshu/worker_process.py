"""Private stdio worker. No HTTP listener, renderer credentials or queue replay."""
import argparse
import asyncio
from contextlib import contextmanager, redirect_stdout
import fcntl
import hashlib
import json
import os
from pathlib import Path
import stat
import signal
import subprocess
import sys

from browser_login import BrowserLogin, private_directory
from protocol import parse_request
from sessions import Owner, SessionManager
from single_send import SendJournal
from worker_runtime import WorkerRuntime

PIN = '7077c88f82771f547cc1afdadaec4025be2355e6'


@contextmanager
def owned_storage(base, owner):
    private_directory(base)
    key = hashlib.sha256(json.dumps([owner.workspace_id, owner.actor_id, owner.device_id],
                                    ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()
    root = base / key
    root.mkdir(mode=0o700, exist_ok=True)
    private_directory(root)
    fd = os.open(root / 'worker.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o600 or info.st_nlink != 1:
            raise ValueError('invalid_worker_lock')
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise ValueError('worker_already_running') from None
        yield root
    finally:
        os.close(fd)


def load_upstream(root):
    try:
        root = root.resolve(strict=True)
        def git(*args):
            return subprocess.check_output(['git', '-C', str(root), *args], text=True,
                                           stderr=subprocess.DEVNULL, timeout=10).strip()
        if Path(git('rev-parse', '--show-toplevel')).resolve() != root or git('rev-parse', 'HEAD') != PIN:
            raise ValueError()
        if git('status', '--porcelain', '--untracked-files=all'):
            raise ValueError()
    except (OSError, ValueError, subprocess.SubprocessError):
        raise ValueError('invalid_upstream') from None
    sys.path.insert(0, str(root))
    from apis.xhs_live import XHSWebSocket
    return XHSWebSocket


async def serve(reader, write, runtime):
    pending = {}
    async def dispatch(raw, request_id):
        try:
            await write(await runtime.request(raw))
        finally:
            pending.pop(request_id, None)
    try:
        while True:
            try:
                line = await reader.readline()
            except ValueError:
                await write({'id': None, 'error': 'invalid_request'})
                break
            if not line:
                break
            try:
                raw = line.decode('utf-8')
                request = parse_request(raw)
            except (ValueError, UnicodeError):
                await write({'id': None, 'error': 'invalid_request'})
                continue
            request_id = request['id']
            if request_id in pending:
                # Ambiguous correlation is a protocol violation; never dispatch twice.
                break
            if len(pending) >= (33 if request['operation'] == 'close' else 32):
                await write({'id': request_id, 'error': 'worker_busy'})
                continue
            pending[request_id] = asyncio.create_task(dispatch(raw, request_id))
    finally:
        tasks = list(pending.values())
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        await runtime.close_all()


async def run(args, output):
    task = asyncio.current_task()
    asyncio.get_running_loop().add_signal_handler(signal.SIGTERM, task.cancel)
    owner = Owner(args.workspace, args.actor, args.device)
    websocket_type = load_upstream(Path(args.upstream))
    with owned_storage(Path(args.storage), owner) as root:
        profiles = root / 'profiles'
        profiles.mkdir(mode=0o700, exist_ok=True)
        private_directory(profiles)
        journal = SendJournal(root / 'journal.sqlite')
        try:
            from playwright.async_api import async_playwright
            async with async_playwright() as playwright:
                runtime = WorkerRuntime(owner, BrowserLogin(profiles, playwright.chromium),
                                        SessionManager(journal, enabled=args.enable_sending), websocket_type)
                reader = asyncio.StreamReader(limit=65536)
                transport, _ = await asyncio.get_running_loop().connect_read_pipe(
                    lambda: asyncio.StreamReaderProtocol(reader), sys.stdin.buffer)
                async def write(value):
                    output.write(json.dumps(value, ensure_ascii=False, separators=(',', ':')) + '\n')
                    output.flush()
                try:
                    await write({'event': 'ready'})
                    await serve(reader, write, runtime)
                finally:
                    transport.close()
        finally:
            journal.close()


def main():
    parser = argparse.ArgumentParser()
    for name in ('workspace', 'actor', 'device', 'storage', 'upstream'):
        parser.add_argument('--' + name, required=True)
    parser.add_argument('--enable-sending', action='store_true', default=False)
    args = parser.parse_args()
    output = sys.stdout
    # Third-party prints must never corrupt the private protocol or persist secrets.
    with open(os.devnull, 'w') as sink, redirect_stdout(sink):
        try:
            asyncio.run(run(args, output))
        except (Exception, KeyboardInterrupt, asyncio.CancelledError):
            output.write('{"event":"failed","error":"worker_start_or_runtime_failed"}\n')
            output.flush()
            return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
