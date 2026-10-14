"""Owned IM sessions. No browser discovery, credential loading or public API.

The trusted local process supplies a client from its dedicated login session.
Approval authentication belongs to the backend, not this lifecycle manager.
"""
import asyncio
import time
import uuid
from dataclasses import dataclass, field
from receipts import _identifier
from single_send import SingleSendExecutor
from upstream_transport import UpstreamImTransport


@dataclass(frozen=True)
class Owner:
    workspace_id: str
    actor_id: str
    device_id: str

    def __post_init__(self):
        if not all(_identifier(value) for value in (self.workspace_id, self.actor_id, self.device_id)):
            raise ValueError('invalid_session_owner')


@dataclass
class _Session:
    owner: Owner
    client: object
    generation: str = field(default_factory=lambda: str(uuid.uuid4()))
    state: str = 'opening'
    executor: object = None
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    tasks: set = field(default_factory=set)


class SessionManager:
    def __init__(self, journal, *, enabled=False, clock=time.time):
        self.journal, self.enabled, self.clock = journal, enabled is True, clock
        self._sessions = {}

    async def connect(self, owner, account_id, platform_user_id, client):
        if not isinstance(owner, Owner) or not _identifier(account_id):
            raise ValueError('invalid_session_owner')
        if account_id in self._sessions:
            raise ValueError('account_busy')
        entry = _Session(owner, client)
        self._sessions[account_id] = entry  # Reserve before the first await.
        task = asyncio.current_task()
        entry.tasks.add(task)
        try:
            transport = UpstreamImTransport(client, account_id, platform_user_id, clock=self.clock)
            await asyncio.wait_for(client.connect(), 20)
            transport._check_identity()
            if client.ws is None:
                raise ConnectionError('im_disconnected')
            entry.executor = SingleSendExecutor(self.journal, transport, account_id, entry.generation, enabled=self.enabled)
            entry.state = 'ready'
            return {'account_id': account_id, 'generation': entry.generation, 'state': entry.state}
        except BaseException:
            if entry.state != 'closing':
                await self.close(owner, account_id)
            raise
        finally:
            entry.tasks.discard(task)

    def _owned(self, owner, account_id, generation=None):
        entry = self._sessions.get(account_id)
        if entry is None or owner != entry.owner or (generation is not None and generation != entry.generation):
            raise ValueError('session_not_owned')
        return entry

    async def execute(self, owner, generation, command):
        entry = self._owned(owner, command.account_id, generation)
        if (command.workspace_id, command.actor_id, command.device_id) != (owner.workspace_id, owner.actor_id, owner.device_id):
            raise ValueError('command_not_owned')
        task = asyncio.current_task()
        entry.tasks.add(task)
        try:
            async with entry.lock:
                if entry.state != 'ready' or self._sessions.get(command.account_id) is not entry:
                    raise ValueError('session_not_ready')
                # Sample after waiting; a queued command may have expired.
                return await entry.executor.execute(command, now=self.clock())
        finally:
            entry.tasks.discard(task)

    async def close(self, owner, account_id):
        entry = self._owned(owner, account_id)
        if entry.state == 'closing':
            return
        entry.state = 'closing'
        pending = [task for task in entry.tasks if task is not asyncio.current_task()]
        for task in pending:
            task.cancel()
        if pending:
            await asyncio.gather(*pending, return_exceptions=True)
        try:
            await asyncio.wait_for(entry.client.close(), 5)
        except BaseException:
            entry.state = 'close_failed'
            raise
        if self._sessions.get(account_id) is entry:
            del self._sessions[account_id]

    async def close_all(self):
        for account_id, entry in list(self._sessions.items()):
            await self.close(entry.owner, account_id)
