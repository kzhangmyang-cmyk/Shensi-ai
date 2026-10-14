"""Local once-only transport boundary. Callers must authenticate approvals.

No platform credentials or message bodies are persisted. A committed unknown
record precedes any possible network write; recovery never retries that record.
"""
import asyncio
import hashlib
import json
import math
import os
import sqlite3
import stat
from dataclasses import asdict, dataclass
from pathlib import Path
from receipts import Receipt, ReceiptTracker, _identifier


@dataclass(frozen=True)
class ApprovedCommand:
    command_id: str
    workspace_id: str
    actor_id: str
    device_id: str
    account_id: str
    recipient_id: str
    body: str
    revision: int
    client_message_id: str
    expires_at: float

    def __post_init__(self):
        ids = (self.command_id, self.workspace_id, self.actor_id, self.device_id,
               self.account_id, self.recipient_id, self.client_message_id)
        if not all(_identifier(value) for value in ids):
            raise ValueError('invalid_command_identity')
        if not isinstance(self.body, str) or not self.body.strip() or len(self.body) > 800:
            raise ValueError('invalid_command_body')
        if type(self.revision) is not int or self.revision < 1:
            raise ValueError('invalid_approval_revision')
        if type(self.expires_at) not in (int, float) or not math.isfinite(self.expires_at) or self.expires_at <= 0:
            raise ValueError('invalid_command_expiry')


def _binding(command):
    return hashlib.sha256(json.dumps(asdict(command), sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()).hexdigest()


class SendJournal:
    def __init__(self, path: Path):
        path = Path(path)
        parent = path.parent.stat()
        if path.parent.resolve() != path.parent.absolute() or parent.st_uid != os.getuid() or stat.S_IMODE(parent.st_mode) != 0o700:
            raise ValueError('journal_directory_not_private')
        try:
            fd = os.open(path, os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        except FileExistsError:
            if path.is_symlink():
                raise ValueError('journal_symlink')
            fd = os.open(path, os.O_RDWR | os.O_NOFOLLOW)
        try:
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o600 or info.st_nlink != 1:
                raise ValueError('journal_file_not_private')
        finally:
            os.close(fd)
        self.db = sqlite3.connect(path, timeout=5)
        self.db.execute('PRAGMA synchronous=FULL')
        self.db.execute('CREATE TABLE IF NOT EXISTS sends (command_id TEXT PRIMARY KEY, binding TEXT NOT NULL, account_id TEXT NOT NULL, mid TEXT NOT NULL, receipt TEXT NOT NULL, UNIQUE(account_id, mid))')
        self.db.commit()

    def close(self):
        self.db.close()

    def result(self, command):
        row = self.db.execute('SELECT binding, receipt FROM sends WHERE command_id=?', (command.command_id,)).fetchone()
        if row is None:
            return None
        if row[0] != _binding(command):
            raise ValueError('command_conflict')
        return Receipt(**json.loads(row[1]))

    def begin(self, command):
        # INSERT and durable commit are atomic across adapter processes.
        try:
            with self.db:
                self.db.execute('INSERT INTO sends VALUES (?,?,?,?,?)', (command.command_id, _binding(command), command.account_id,
                    command.client_message_id, json.dumps(asdict(Receipt('unknown')))))
            return True
        except sqlite3.IntegrityError:
            if self.result(command) is None:
                raise ValueError('message_id_reused') from None
            return False

    def resolve(self, command, receipt):
        self.result(command)  # Validate immutable approval binding before update.
        if receipt.status not in ('confirmed', 'rejected'):
            return
        with self.db:
            self.db.execute("UPDATE sends SET receipt=? WHERE command_id=? AND binding=? AND json_extract(receipt,'$.status')='unknown'",
                            (json.dumps(asdict(receipt)), command.command_id, _binding(command)))


class SingleSendExecutor:
    def __init__(self, journal, transport, account_id, generation, *, enabled=False, timeout=15):
        ReceiptTracker(account_id, generation, 'validation')
        if not 0 < timeout <= 30:
            raise ValueError('invalid_timeout')
        self.journal, self.transport = journal, transport
        self.account_id, self.generation = account_id, generation
        self.enabled, self.timeout = enabled is True, timeout
        self._lock = asyncio.Lock()  # One owner per account; no global lock.

    async def execute(self, command, *, now):
        if not self.enabled:
            raise ValueError('sending_disabled')
        async with self._lock:
            if command.account_id != self.account_id or not math.isfinite(now) or now >= command.expires_at:
                raise ValueError('command_not_executable')
            if not self.journal.begin(command):
                return self.journal.result(command)
            tracker = ReceiptTracker(self.account_id, self.generation, command.client_message_id)

            async def transmit():
                await self.transport.send(command)
                async for frame in self.transport.events():
                    receipt = tracker.observe(self.account_id, self.generation, frame)
                    if receipt.status in ('confirmed', 'rejected'):
                        self.journal.resolve(command, receipt)
                        return
            try:
                await asyncio.wait_for(transmit(), self.timeout)
            except (TimeoutError, ConnectionError, OSError):
                pass  # Durable unknown remains; no alternate transport or retry.
            return self.journal.result(command)
