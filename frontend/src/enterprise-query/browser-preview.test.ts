import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { mountBrowserEnterprisePreview } from './browser-preview';
import {renderEnterpriseCapture} from './capture-view';
test('load more appends unique companies, preserves detail, keeps failed results and clears new searches',async()=>{
  const {document,window}=parseHTML('<main></main><div id="results"></div>');const previous={window:globalThis.window,document:globalThis.document};Object.assign(globalThis,{window,document});
  const cap=(names:string[])=>({version:1 as const,sourceUrl:'https://aiqicha.baidu.com/s',capturedAt:new Date().toISOString(),items:names.map(company=>({company,sourceUrl:'https://aiqicha.baidu.com/s'}))});
  let count=0;let view:ReturnType<typeof renderEnterpriseCapture>|undefined;
  Object.assign(window,{shensiEnterpriseBrowser:{readPreview:async()=>cap([]),searchLocal:async()=>({...cap(['企业甲']),pagination:{batchId:'batch',page:1,hasNext:true,notice:''}}),nextLocal:async()=>{count++;if(count===1)throw new Error('网络失败');return {capture:cap(['企业甲','企业乙']),pagination:{batchId:'batch',page:2,hasNext:false,notice:'已到末页'}};}}});
  try{
    const root=document.querySelector('main')!;const host=document.querySelector('#results')!;
    const preview=mountBrowserEnterprisePreview(root as unknown as HTMLElement,(capture,append)=>{if(!capture){host.replaceChildren();view=undefined;}else if(append)view!.update(capture);else view=renderEnterpriseCapture(host as unknown as HTMLElement,capture);})!;
    await preview.search('塑料');host.querySelector('[data-capture-company="0"]')!.dispatchEvent(new window.Event('click',{bubbles:true}));
    const more=root.querySelector('[data-browser-more]')!;more.dispatchEvent(new window.Event('click'));await new Promise(resolve=>setImmediate(resolve));
    assert.equal(host.querySelectorAll('[data-capture-company]').length,1);assert.match(root.textContent!,/网络失败/);
    more.dispatchEvent(new window.Event('click'));await new Promise(resolve=>setImmediate(resolve));
    assert.equal(host.querySelectorAll('[data-capture-company]').length,2);assert.match(host.querySelector('aside')!.textContent!,/企业甲/);assert.equal(more.hasAttribute('hidden'),true);
    await preview.search('新词');assert.equal(host.querySelectorAll('[data-capture-company]').length,1);assert.doesNotMatch(host.textContent!,/企业乙/);
  }finally{Object.assign(globalThis,previous);}
});
test('failed preview offers one explicit retry and disables duplicate reads while pending',async()=>{
  const {document,window}=parseHTML('<main></main>');const previous={window:globalThis.window,document:globalThis.document};Object.assign(globalThis,{window,document});
  let calls=0;Object.assign(window,{shensiEnterpriseBrowser:{readPreview:async()=>{calls++;if(calls===1)throw new Error('连接失败');return {version:1,sourceUrl:'https://aiqicha.baidu.com/s',capturedAt:new Date().toISOString(),items:[{company:'企业甲'}]};}}});
  try{
    const root=document.querySelector('main')!;mountBrowserEnterprisePreview(root as unknown as HTMLElement);
    root.querySelector('[data-browser-read]')!.dispatchEvent(new window.Event('click'));
    assert.equal(root.querySelector('section')!.getAttribute('aria-busy'),'true');
    await new Promise(resolve=>setImmediate(resolve));
    const retry=root.querySelector('[data-browser-retry]');assert.ok(retry);assert.equal(retry.hasAttribute('hidden'),false);
    retry.dispatchEvent(new window.Event('click'));await new Promise(resolve=>setImmediate(resolve));
    assert.equal(calls,2);assert.match(root.querySelector('tbody')!.textContent!,/企业甲/);
    assert.equal(root.querySelector('section')!.getAttribute('aria-busy'),'false');
    assert.equal(retry.hasAttribute('hidden'),true);
  }finally{Object.assign(globalThis,previous);}
});
test('built-in open is explicit and capture displays the same preview', async () => {
  const { document, window } = parseHTML('<html><body><main></main></body></html>');
  const previous = { window: globalThis.window, document: globalThis.document };
  Object.assign(globalThis, { window, document });
  let opened = 0; let captured = 0; const keywords: (string|undefined)[]=[];
  Object.assign(window, { shensiEnterpriseBrowser: { readPreview: async () => { throw new Error('wrong source'); }, openLocal: async (keyword?:string) => { opened++; keywords.push(keyword); }, captureLocal: async () => { captured++; return { version: 1, capturedAt: new Date().toISOString(), sourceUrl: 'https://aiqicha.baidu.com/s', items: [{ company: '当前可见企业' }] }; } } });
  try {
    const root = document.querySelector('main')!; const preview=mountBrowserEnterprisePreview(root as unknown as HTMLElement);
    assert.equal(opened, 0); assert.equal(captured, 0);
    assert.ok(root.querySelector('[data-local-open]'));
    assert.match(root.querySelector('[data-browser-read]')!.textContent!, /可选.*Chrome 扩展/);
    assert.match(root.querySelector('[role="status"]')!.textContent!, /不需要安装 Chrome/);
    root.querySelector('[data-local-open]')!.dispatchEvent(new window.Event('click'));
    await new Promise(resolve => setImmediate(resolve)); assert.equal(opened, 1);
    await preview!.openSearch('郑州 塑料'); assert.deepEqual(keywords,[undefined,'郑州 塑料']);
    root.querySelector('[data-local-capture]')!.dispatchEvent(new window.Event('click'));
    await new Promise(resolve => setImmediate(resolve)); assert.equal(captured, 1);
    assert.match(root.querySelector('tbody')!.textContent!, /当前可见企业/);
  } finally { Object.assign(globalThis, previous); }
});
test('explicit read previews text safely without business writes, then clears', async () => {
  const { document, window } = parseHTML('<html><body><main></main></body></html>');
  const oldWindow = globalThis.window; const oldDocument = globalThis.document;
  Object.assign(globalThis, { window, document });
  let reads = 0;
  Object.assign(window, { shensiEnterpriseBrowser: { async readPreview() { reads++; return { version: 1, sourceUrl: 'https://aiqicha.baidu.com/s', capturedAt: new Date().toISOString(), items: [{ company: '<img src=x onerror=alert(1)>', sourceUrl: 'https://aiqicha.baidu.com/company_detail_123' }] }; } } });
  try {
    const root = document.querySelector('main')!;
    mountBrowserEnterprisePreview(root as unknown as HTMLElement); assert.equal(reads, 0);
    root.querySelector('[data-browser-read]')!.dispatchEvent(new window.Event('click'));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(reads, 1); assert.equal(root.querySelectorAll('tbody tr').length, 1);
    assert.equal(root.querySelector('img'), null);
    assert.match(root.textContent!, /尚未正式保存客户/);
    root.querySelector('[data-browser-clear]')!.dispatchEvent(new window.Event('click'));
    assert.equal(root.querySelector('table'), null);
  } finally { Object.assign(globalThis, { window: oldWindow, document: oldDocument }); }
});
test('structured query returns real capture to main panels, refuses unsupported depth and drops late cleared results',async()=>{
  const {document,window}=parseHTML('<main></main>');const previous={window:globalThis.window,document:globalThis.document};Object.assign(globalThis,{window,document});
  let calls=0;let resolve:((value:any)=>void)|undefined;const received:any[]=[];
  Object.assign(window,{shensiEnterpriseBrowser:{readPreview:async()=>{throw new Error('wrong source');},queryLocal:(query:any)=>{calls++;assert.deepEqual(query,{keyword:'',region:['河南省','郑州市'],industry:['制造业']});return new Promise(done=>resolve=done);}}});
  try{
    const root=document.querySelector('main')!;const preview=mountBrowserEnterprisePreview(root as unknown as HTMLElement,cap=>received.push(cap))!;
    await preview.query({keyword:'',region:[],industry:['制造业','橡胶和塑料制品业','塑料制品业']});assert.equal(calls,0);assert.match(root.textContent!,/二级/);
    const pending=preview.query({keyword:'',region:['河南省','郑州市'],industry:['制造业']});
    preview.clear();resolve!({items:[{company:'迟到结果'}]});await pending;
    assert.equal(received.some(x=>x?.items),false);
    const second=preview.query({keyword:'',region:['河南省','郑州市'],industry:['制造业']});
    resolve!({version:1,sourceUrl:'https://aiqicha.baidu.com/advancesearch/list',capturedAt:new Date().toISOString(),items:[{company:'真实结果'}]});await second;
    assert.equal(received.at(-1).items[0].company,'真实结果');assert.match(root.textContent!,/已回传 1 家/);
  }finally{Object.assign(globalThis,previous);}
});
test('ordinary search calls keyword-only non-member route and labels filters unapplied',async()=>{
  const {document,window}=parseHTML('<main></main>');const previous={window:globalThis.window,document:globalThis.document};Object.assign(globalThis,{window,document});
  let actual='';let received:any;
  Object.assign(window,{shensiEnterpriseBrowser:{searchLocal:async(keyword:string)=>{actual=keyword;return {version:1,sourceUrl:'https://aiqicha.baidu.com/s',capturedAt:new Date().toISOString(),items:[{company:'普通可见企业'}]};},readPreview:async()=>{throw new Error('wrong source');}}});
  try{
    const root=document.querySelector('main')!;const preview=mountBrowserEnterprisePreview(root as unknown as HTMLElement,cap=>received=cap)!;
    await preview.search('塑料');assert.equal(actual,'塑料');assert.equal(received.items[0].company,'普通可见企业');
    assert.match(root.textContent!,/普通搜索/);assert.match(root.textContent!,/未应用地区/);
  }finally{Object.assign(globalThis,previous);}
});
