import importlib.util
import json
import tempfile
import unittest
from pathlib import Path


class BrowserLoginTests(unittest.IsolatedAsyncioTestCase):
    account = '00000000-0000-4000-8000-000000000001'

    def setup_login(self):
        self.assertIsNotNone(importlib.util.find_spec('browser_login'), 'dedicated visible browser login exists')
        from browser_login import BrowserLogin
        directory = tempfile.TemporaryDirectory(dir=Path(tempfile.gettempdir()).resolve())
        self.addCleanup(directory.cleanup)
        class Page:
            url = 'https://www.xiaohongshu.com/'
            values = {'token':json.dumps({'uid':'platform-user','aLt':'synthetic-secret','expiredAt':200000}),
                      'device':'tab-device','fingerprint':'synthetic-fingerprint'}
            reads = 0
            async def goto(self,url,**options): self.url=url
            async def evaluate(self,script): self.reads+=1; return dict(self.values)
        class Context:
            def __init__(self): self.pages=[Page()]; self.closed=False; self.cookie_urls=[]
            async def cookies(self,url): self.cookie_urls.append(url);return [{'name':'web_session','value':'synthetic-cookie'}]
            async def close(self): self.closed=True
        class Chromium:
            def __init__(self): self.calls=[];self.contexts=[]
            async def launch_persistent_context(self,**options):
                self.calls.append(options);context=Context();self.contexts.append(context);return context
        chromium=Chromium()
        login=BrowserLogin(Path(directory.name),chromium,clock=lambda:100)
        self.addAsyncCleanup(login.close_all)
        return login,chromium

    async def test_launches_visible_dedicated_profile_without_remote_screen(self):
        login,chromium=self.setup_login()
        await login.open(self.account)
        self.assertIs(chromium.calls[0]['headless'],False)
        self.assertEqual(Path(chromium.calls[0]['user_data_dir']).name,self.account)
        self.assertEqual(Path(chromium.calls[0]['user_data_dir']).stat().st_mode & 0o777,0o700)
        self.assertEqual(chromium.contexts[0].pages[0].url,'https://www.xiaohongshu.com/')
        with self.assertRaisesRegex(ValueError,'login_already_open'):
            await login.open(self.account)

    async def test_reads_only_owned_im_state_and_limits_cookie_destination(self):
        login,chromium=self.setup_login()
        await login.open(self.account)
        state=await login.capture_im_state(self.account)
        self.assertEqual(state.user_id,'platform-user')
        self.assertEqual(chromium.contexts[0].cookie_urls,['https://apppush-rws.xiaohongshu.com/rwp'])
        self.assertNotIn('synthetic-secret',repr(state))
        self.assertEqual(state.cookies_for_url('https://apppush-rws.xiaohongshu.com/rwp'),{'web_session':'synthetic-cookie'})
        with self.assertRaises(ValueError): state.cookies_for_url('https://other.example/')

    async def test_nonofficial_page_is_not_read(self):
        login,chromium=self.setup_login()
        await login.open(self.account)
        page=chromium.contexts[0].pages[0];page.url='https://example.org/'
        with self.assertRaisesRegex(ValueError,'login_origin_changed'):
            await login.capture_im_state(self.account)
        self.assertEqual(page.reads,0)

    async def test_expired_or_missing_im_state_is_not_fabricated(self):
        login,chromium=self.setup_login()
        await login.open(self.account)
        page=chromium.contexts[0].pages[0]
        for values in [{}, {'token':'{}'}, {'token':json.dumps({'uid':'user','aLt':'secret','expiredAt':99999}),'device':'d','fingerprint':'f'}]:
            page.values=values
            with self.assertRaisesRegex(ValueError,'im_state_not_ready'):
                await login.capture_im_state(self.account)

    async def test_close_keeps_other_owned_browser_open_and_rejects_path_traversal(self):
        login,chromium=self.setup_login()
        with self.assertRaises(ValueError): await login.open('../outside')
        await login.open(self.account)
        other='00000000-0000-4000-8000-000000000002'
        await login.open(other)
        await login.close(self.account)
        self.assertTrue(chromium.contexts[0].closed)
        self.assertFalse(chromium.contexts[1].closed)
