import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createEnterpriseLocalBrowser, allowedEnterpriseNavigation } from '../src/main/enterprise-local-browser.ts';

test('remote browser rejects foreign navigation and privileges; account switch closes old session', async () => {
  let actor = 'a'; const windows: any[] = []; const preferences: any[] = []; const urls:string[]=[];
  const browser = createEnterpriseLocalBrowser({ authorize: async () => actor, captureScript: 'capture',
    createWindow: (options: any) => {
      preferences.push(options.webPreferences);
      const contents = Object.assign(new EventEmitter(), { session: { setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, on() {} },
        setWindowOpenHandler(this: any, fn: any) { this.popup = fn; }, getURL: () => 'https://aiqicha.baidu.com/s',
        executeJavaScriptInIsolatedWorld: async () => ({ ok: true, capture: { version: 1, sourceUrl: 'https://aiqicha.baidu.com/s', capturedAt: new Date().toISOString(), items: [{ company: '真实企业', sourceUrl: 'https://aiqicha.baidu.com/s' }] } }) });
      const win = Object.assign(new EventEmitter(), { webContents: contents, loadURL: async (url:string) => {urls.push(url);}, show() {}, focus() {}, isDestroyed: () => false, close(this: any) { this.closed = true; this.emit('closed'); } });
      windows.push(win); return win as any;
    } });
  await browser.open();
  await browser.open('郑州 塑料');
  assert.equal(urls.at(-1),'https://aiqicha.baidu.com/s?q=%E9%83%91%E5%B7%9E%20%E5%A1%91%E6%96%99');
  assert.equal(windows.length,1);
  await assert.rejects(browser.open({url:'https://evil.test'}),/关键词/);
  assert.equal(preferences[0].nodeIntegration, false); assert.equal(preferences[0].sandbox, true);
  assert.equal(preferences[0].preload, undefined); assert.equal(preferences[0].contextIsolation, true);
  assert.match(preferences[0].partition, /^persist:enterprise-/);
  let denied = false; windows[0].webContents.emit('will-navigate', { preventDefault() { denied = true; } }, 'file:///etc/passwd');
  assert.equal(denied, true);
  assert.equal((await browser.capture()).items[0].company, '真实企业');
  actor = 'b'; await assert.rejects(browser.capture(), /重新打开/);
  assert.equal(windows[0].closed, true);
  await browser.open(); assert.notEqual(preferences[0].partition, preferences[1].partition);
  browser.dispose();
});
test('only HTTPS exact website/login hosts allowed', () => {
  assert.equal(allowedEnterpriseNavigation('https://aiqicha.baidu.com/s?q=a'), true);
  assert.equal(allowedEnterpriseNavigation('https://passport.baidu.com/'), true);
  for (const url of ['http://aiqicha.baidu.com', 'https://aiqicha.baidu.com.evil.test', 'https://x@aiqicha.baidu.com', 'file:///tmp/a']) assert.equal(allowedEnterpriseNavigation(url), false);
});

test('exact query uses website controls and captures only after a successful result; membership never falls back',async()=>{
  let actor='a';let blocked=false;let captureCalls=0;let url='';let sitePage=1;let nextClicks=0;const urls:string[]=[];
  const contents=Object.assign(new EventEmitter(),{session:{setPermissionRequestHandler(){},setPermissionCheckHandler(){},on(){}},setWindowOpenHandler(){},getURL:()=>url,
    executeJavaScriptInIsolatedWorld:async(_id:number,scripts:{code:string}[])=>{
      const code=scripts[0].code;
      if(code==='capture'){captureCalls++;return {ok:true,capture:{version:1,sourceUrl:url,capturedAt:new Date().toISOString(),items:[{company:'可见企业',sourceUrl:'https://aiqicha.baidu.com/company_detail_123'}]}};}
      if(code.endsWith(',"prepare")'))return {status:'ready'};
      if(code.endsWith(',"submit")')){if(!blocked)url='https://aiqicha.baidu.com/advancesearch/list';return {status:'submitted'};}
      if(code.endsWith(',"result")'))return blocked?{status:'blocked',message:'需要高级搜索会员'}:{status:'results'};
      if(code.endsWith(',"ordinary-result")'))return {status:'results'};
      if(code.endsWith('("inspect",null)'))return {status:'ready',page:sitePage,signature:`可见企业${sitePage}`,keyword:'塑料',hasNext:sitePage<2,notice:''};
      if(code.endsWith('("next",1)')){sitePage++;nextClicks++;return {status:'clicked'};}
      throw new Error('unexpected script');
    }});
  const win=Object.assign(new EventEmitter(),{webContents:contents,loadURL:async(value:string)=>{url=value;urls.push(value);},show(){},focus(){},isDestroyed:()=>false,close(){win.emit('closed');}});
  const browser=createEnterpriseLocalBrowser({authorize:async()=>actor,captureScript:'capture',createWindow:()=>win as any});
  try {
    const ordinary=await browser.search('塑料');
    assert.equal(ordinary.items[0].company,'可见企业');assert.equal(urls.at(-1),'https://aiqicha.baidu.com/s?q=%E5%A1%91%E6%96%99');
    const next=await browser.next(ordinary.pagination!.batchId);assert.equal(next.pagination.page,2);assert.equal(nextClicks,1);assert.ok('capture' in next);assert.ok(next.capture);
    const end=await browser.next(ordinary.pagination!.batchId);assert.equal(end.pagination.hasNext,false);assert.equal(nextClicks,1);
    captureCalls=0;
    const query={keyword:'',region:['河南省','郑州市'],industry:['制造业']};
    const result=await browser.query(query);
    await assert.rejects(browser.next(ordinary.pagination!.batchId),/失效/);
    assert.equal(result.items[0].company,'可见企业');assert.equal(captureCalls,1);
    assert.equal(urls.at(-1),'https://aiqicha.baidu.com/advancesearch');
    blocked=true;
    await assert.rejects(browser.query(query),/会员/);assert.equal(captureCalls,1);
  } finally {browser.dispose();}
});
