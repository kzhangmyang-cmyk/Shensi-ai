"""Owned browser/IM orchestration behind a parent-only private pipe."""
import asyncio
from protocol import parse_request, approved_command, public_receipt


PUBLIC_ERRORS = frozenset({
    'login_not_open', 'login_already_open', 'login_origin_changed', 'im_state_not_ready',
    'sending_disabled', 'account_busy', 'session_not_owned', 'session_not_ready',
    'command_not_executable', 'command_conflict', 'message_id_reused',
})


class WorkerRuntime:
    def __init__(self, owner, browser, sessions, websocket_type):
        self.owner, self.browser, self.sessions = owner, browser, sessions
        self.websocket_type = websocket_type
        self._tasks = {}
        self._accounts = set()
        self._closing = set()

    async def request(self, raw):
        request_id = None
        account = None
        task = asyncio.current_task()
        try:
            try:
                request = parse_request(raw)
                request_id = request['id']
                operation = request['operation']
                command = generation = None
                if operation == 'execute':
                    command, generation = approved_command(self.owner, request['command'])
                    account = command.account_id
                else:
                    account = request['accountId']
            except (ValueError, TypeError, OverflowError):
                return {'id': request_id, 'error': 'invalid_request'}
            if account in self._closing:
                raise ValueError('account_busy')
            self._accounts.add(account)
            if operation == 'close':
                await self._close(account)
                result = {'accountId': account, 'state': 'closed'}
            else:
                self._tasks.setdefault(account, set()).add(task)
                if operation == 'open':
                    await self.browser.open(account)
                    result = {'accountId': account, 'state': 'login_open'}
                elif operation == 'connect':
                    state = await self.browser.capture_im_state(account)
                    connected = await self.sessions.connect(self.owner, account, state.user_id,
                                                            state.create_client(self.websocket_type))
                    result = {'accountId': account, 'platformUserId': state.user_id,
                              'generation': connected['generation'], 'state': connected['state']}
                else:
                    result = public_receipt(await self.sessions.execute(self.owner, generation, command))
            return {'id': request_id, 'result': result}
        except Exception as error:
            # Platform and browser exceptions can contain cookies and page data.
            code = str(error) if type(error) is ValueError and str(error) in PUBLIC_ERRORS else 'worker_operation_failed'
            return {'id': request_id, 'error': code}
        finally:
            if account in self._tasks:
                self._tasks[account].discard(task)
                if not self._tasks[account]:
                    del self._tasks[account]

    async def _close(self, account):
        self._closing.add(account)
        try:
            pending = [task for task in self._tasks.get(account, ()) if task is not asyncio.current_task()]
            for task in pending:
                task.cancel()
            await asyncio.gather(*pending, return_exceptions=True)
            try:
                await self.sessions.close(self.owner, account)
            except ValueError as error:
                if str(error) != 'session_not_owned':
                    raise
            await self.browser.close(account)
            self._accounts.discard(account)
        finally:
            self._closing.discard(account)

    async def close_all(self):
        failures = []
        for account in list(self._accounts):
            try:
                await self._close(account)
            except Exception as error:
                failures.append(error)
        if failures:
            raise RuntimeError('worker_cleanup_failed') from None
