"""Visible, dedicated Playwright login; no QR generation or remote screen.

The caller supplies Chromium and a private root scoped to its authenticated
workspace/actor/device. Nothing reads a system browser or another adapter.
"""
import asyncio
import json
import math
import os
import stat
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import urlsplit
from receipts import _identifier

ORIGIN = 'https://www.xiaohongshu.com'
PUSH_HTTP = 'https://apppush-rws.xiaohongshu.com/rwp'


def private_directory(path):
    info = path.stat()
    if path.resolve() != path.absolute() or not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700:
        raise ValueError('login_directory_not_private')


@dataclass(repr=False)
class BrowserImState:
    user_id: str
    sid: str
    device_id: str
    fingerprint: str
    _cookies: dict = field(repr=False)

    def cookies_for_url(self, url):
        if url != PUSH_HTTP:
            raise ValueError('im_cookie_destination_denied')
        return dict(self._cookies)

    def create_client(self, websocket_type):
        return websocket_type(self, uid=self.user_id, sid=self.sid,
                              device_id=self.device_id, fingerprint=self.fingerprint)


class BrowserLogin:
    def __init__(self, root, chromium, *, clock=time.time):
        self.root = Path(root)
        private_directory(self.root)
        self.chromium, self.clock = chromium, clock
        self._entries = {}

    async def open(self, account_id):
        try:
            if str(uuid.UUID(account_id)) != account_id:
                raise ValueError()
        except (ValueError, TypeError, AttributeError):
            raise ValueError('invalid_login_account') from None
        if account_id in self._entries:
            raise ValueError('login_already_open')
        profile = self.root / account_id
        profile.mkdir(mode=0o700, exist_ok=True)
        private_directory(profile)
        entry = {'task':asyncio.current_task(), 'context':None}
        self._entries[account_id] = entry
        try:
            context = await self.chromium.launch_persistent_context(user_data_dir=str(profile), headless=False, timeout=30000)
            entry['context'] = context
            page = context.pages[0] if context.pages else await context.new_page()
            await page.goto(ORIGIN+'/', wait_until='domcontentloaded', timeout=20000)
        except BaseException:
            if entry['context'] is not None:
                await entry['context'].close()
            self._entries.pop(account_id, None)
            raise
        finally:
            entry['task'] = None

    async def capture_im_state(self, account_id):
        entry = self._entries.get(account_id)
        context = entry and entry['context']
        if context is None or not context.pages:
            raise ValueError('login_not_open')
        page = context.pages[0]
        parsed = urlsplit(page.url)
        if parsed.scheme != 'https' or parsed.netloc != 'www.xiaohongshu.com':
            raise ValueError('login_origin_changed')
        values = await page.evaluate('''() => location.origin !== 'https://www.xiaohongshu.com' ? null : ({
          token: localStorage.getItem('RWP_LOGIN_TOKEN'),
          device: sessionStorage.getItem('XHS_TAB_DEVICE_ID'),
          fingerprint: sessionStorage.getItem('XHS_RWP_FINGERPRINT')
        })''')
        try:
            raw = values['token']
            if not isinstance(raw,str) or len(raw)>16384:
                raise ValueError()
            token = json.loads(raw)
            expiry = token.get('expiredAt')
            now = self.clock()
            if type(expiry) not in (int,float) or not math.isfinite(expiry) or not math.isfinite(now) or expiry<=now*1000:
                raise ValueError()
            if not _identifier(token.get('uid')) or not all(isinstance(v,str) and 0<len(v)<=8192 for v in (token.get('aLt'), values.get('device'), values.get('fingerprint'))):
                raise ValueError()
        except (ValueError, TypeError, KeyError, AttributeError):
            raise ValueError('im_state_not_ready') from None
        cookies = await context.cookies(PUSH_HTTP)
        return BrowserImState(token['uid'], token['aLt'], values['device'], values['fingerprint'],
                              {cookie['name']:cookie['value'] for cookie in cookies})

    async def close(self, account_id):
        entry = self._entries.get(account_id)
        if entry is None:
            return
        task = entry['task']
        if task is not None and task is not asyncio.current_task():
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
            if account_id not in self._entries:
                return
        if entry['context'] is not None:
            await entry['context'].close()
        self._entries.pop(account_id, None)

    async def close_all(self):
        for account_id in list(self._entries):
            await self.close(account_id)
