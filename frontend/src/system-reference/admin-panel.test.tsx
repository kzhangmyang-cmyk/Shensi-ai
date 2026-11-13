import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { releaseDetail, releaseId } from './admin-test-fixtures';
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
test('owner inspects exact candidate metadata then explicitly publishes once using its release revision', async () => {
  const panel = await import('./admin-panel').catch(() => null), apiModule = await import('./admin-api').catch(() => null);
  assert.ok(panel && apiModule, 'owner maintenance entry and its bounded normal-session API are required');
  const { document, window } = parseHTML('<html><body><main></main></body></html>');
  const previous = { document: globalThis.document, window: globalThis.window };
  Object.assign(globalThis, { document, window, IS_REACT_ACT_ENVIRONMENT: true });
  const calls: Array<{ path: string; init?: RequestInit }> = [];
  const api = apiModule.createReferenceAdminApi({ csrf: () => 'synthetic-csrf', fetchImpl: async (path, init) => {
    calls.push({ path, init });
    if (init?.method === 'POST') return json({ ...releaseDetail.release, revision: 3, status: 'published' });
    assert.equal(path, `/api/platform/v1/system-reference/releases/${releaseId}`); return json(releaseDetail);
  } });
  const root = createRoot(document.querySelector('main')!);
  try {
    await act(async () => root.render(<panel.PlatformReferencePanel api={api} role="owner" platformRevision={99}/>));
    assert.equal(calls.length, 0);
    document.querySelector<HTMLInputElement>('[name=releaseId]')!.value = releaseId;
    await act(async () => document.querySelector('form')!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })));
    assert.match(document.body.textContent!, /source_incomplete/); assert.match(document.body.textContent!, /ocr_table_formula_review_required/);
    for (const hash of ['a','b','c','d']) assert.ok(document.body.textContent!.includes(hash.repeat(64)));
    assert.equal(!!document.querySelector('img'), false); assert.equal(document.querySelectorAll('a').length, 0);
    assert.equal(document.querySelector<HTMLButtonElement>('[data-reference-publish]')!.disabled, true);
    const reason = document.querySelector<HTMLInputElement>('[name=reason]')!;
    const check = document.querySelector<HTMLInputElement>('[name=confirm]')!;
    await act(async () => { reason.value = '确认合成候选的缺页标记'; reason.dispatchEvent(new window.Event('input', { bubbles: true })); check.checked = true; check.dispatchEvent(new window.Event('click', { bubbles: true })); });
    assert.equal(document.querySelector<HTMLButtonElement>('[data-reference-publish]')!.disabled, false);
    await act(async () => { document.querySelector<HTMLButtonElement>('[data-reference-publish]')!.click(); document.querySelector<HTMLButtonElement>('[data-reference-publish]')!.click(); });
    const writes = calls.filter(c => c.init?.method === 'POST'); assert.equal(writes.length, 1);
    assert.equal(writes[0].path, `/api/platform/v1/system-reference/releases/${releaseId}/publish`);
    const init = writes[0].init!, headers = new Headers(init.headers);
    assert.equal(headers.get('if-match'), '"2"'); assert.equal(headers.get('x-csrf-token'), 'synthetic-csrf'); assert.equal(headers.has('authorization'), false);
    assert.match(headers.get('idempotency-key')!, /^[A-Za-z0-9_.:-]{1,191}$/u);
    assert.equal(init.credentials, 'same-origin'); assert.deepEqual(JSON.parse(String(init.body)), { reason: '确认合成候选的缺页标记' });
    assert.match(document.body.textContent!, /已发布/);
  } finally { await act(async () => root.unmount()); Object.assign(globalThis, previous); }
});
test('leaving the owner pane aborts a pending read and requires a new explicit selection', async () => {
  const {PlatformReferencePanel}=await import('./admin-panel'),{createReferenceAdminApi}=await import('./admin-api');
  const {document,window}=parseHTML('<html><body><main></main></body></html>');
  const previous={document:globalThis.document,window:globalThis.window};Object.assign(globalThis,{document,window,IS_REACT_ACT_ENVIRONMENT:true});
  let resolve!: (value:Response)=>void,signal:AbortSignal|undefined,reads=0;
  const api=createReferenceAdminApi({csrf:()=> 'synthetic-csrf',fetchImpl:async(_path,init)=>{reads++;signal=init?.signal??undefined;return await new Promise<Response>(done=>{resolve=done;});}});
  const root=createRoot(document.querySelector('main')!);
  try{
    await act(async()=>root.render(<PlatformReferencePanel api={api} role="owner" platformRevision={1}/>));
    document.querySelector<HTMLInputElement>('[name=releaseId]')!.value=releaseId;
    await act(async()=>document.querySelector('form')!.dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true})));
    await act(async()=>window.dispatchEvent(new window.Event('blur')));assert.equal(signal?.aborted,true);
    await act(async()=>resolve(json(releaseDetail)));assert.equal(!!document.querySelector('[name=confirm]'),false);assert.match(document.body.textContent!,/重新读取/);assert.equal(reads,1);
  }finally{await act(async()=>root.unmount());Object.assign(globalThis,previous);}
});
test('an uncertain publication is checked by the original command key and is never re-posted', async () => {
  const {PlatformReferencePanel}=await import('./admin-panel'),{createReferenceAdminApi}=await import('./admin-api');
  const {document,window}=parseHTML('<html><body><main></main></body></html>');
  const previous={document:globalThis.document,window:globalThis.window};Object.assign(globalThis,{document,window,IS_REACT_ACT_ENVIRONMENT:true});
  let posts=0,checks=0,commandKey='';
  const api=createReferenceAdminApi({csrf:()=> 'synthetic-csrf',fetchImpl:async(path,init)=>{
    if(init?.method==='POST'){posts++;commandKey=new Headers(init.headers).get('idempotency-key')!;throw new Error('synthetic_uncertain');}
    if(path.includes('/commands/status?')){checks++;assert.equal(new Headers(init?.headers).get('idempotency-key'),commandKey);assert.ok(path.includes(`corpusId=${releaseDetail.release.corpusId}&operation=publish`));return json({operation:'publish',outcome:'not_observed'});}
    return json(releaseDetail);
  }});
  const root=createRoot(document.querySelector('main')!);
  try{
    await act(async()=>root.render(<PlatformReferencePanel api={api} role="owner" platformRevision={99}/>));
    document.querySelector<HTMLInputElement>('[name=releaseId]')!.value=releaseId;
    await act(async()=>document.querySelector('form')!.dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true})));
    await act(async()=>{const reason=document.querySelector<HTMLInputElement>('[name=reason]')!;reason.value='核对合成版本';reason.dispatchEvent(new window.Event('input',{bubbles:true}));const check=document.querySelector<HTMLInputElement>('[name=confirm]')!;check.checked=true;check.dispatchEvent(new window.Event('click',{bubbles:true}));});
    await act(async()=>document.querySelector<HTMLButtonElement>('[data-reference-publish]')!.click());
    assert.equal(posts,1);assert.match(document.body.textContent!,/结果未确认/);
    await act(async()=>window.dispatchEvent(new window.Event('blur')));
    assert.equal(document.querySelector('[name=confirm]'),null);
    const verify=document.querySelector<HTMLButtonElement>('[data-reference-command-check]');assert.ok(verify,'uncertain commands need an explicit status check');
    await act(async()=>verify.click());assert.equal(checks,1);assert.match(document.body.textContent!,/未查到.*不会重发/);
    assert.equal(document.querySelector<HTMLButtonElement>('form button')!.disabled,true);assert.equal(posts,1);
  }finally{await act(async()=>root.unmount());Object.assign(globalThis,previous);}
});
test('owner revision and permission changes discard pending metadata and prior confirmation',async()=>{
  const {PlatformReferencePanel}=await import('./admin-panel'),{createReferenceAdminApi}=await import('./admin-api');
  const {document,window}=parseHTML('<html><body><main></main></body></html>');
  const previous={document:globalThis.document,window:globalThis.window};Object.assign(globalThis,{document,window,IS_REACT_ACT_ENVIRONMENT:true});
  const reads:Array<{signal?:AbortSignal|null;resolve:(v:Response)=>void}>=[];let writes=0;
  const api=createReferenceAdminApi({csrf:()=> 'synthetic',fetchImpl:async(_path,init)=>{
    if(init?.method==='POST'){writes++;throw Error('unexpected');}
    return await new Promise<Response>(resolve=>reads.push({signal:init?.signal,resolve}));
  }});
  const root=createRoot(document.querySelector('main')!);
  const inspect=async()=>{document.querySelector<HTMLInputElement>('[name=releaseId]')!.value=releaseId;await act(async()=>document.querySelector('form')!.dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true})));};
  try{
    await act(async()=>root.render(<PlatformReferencePanel api={api} role="owner" platformRevision={1}/>));await inspect();
    await act(async()=>root.render(<PlatformReferencePanel api={api} role="owner" platformRevision={2}/>));assert.equal(reads[0].signal?.aborted,true);
    await act(async()=>reads[0].resolve(json(releaseDetail)));assert.equal(!!document.querySelector('[name=confirm]'),false);
    await inspect();await act(async()=>reads[1].resolve(json(releaseDetail)));
    await act(async()=>{const reason=document.querySelector<HTMLInputElement>('[name=reason]')!;reason.value='合成权限切换';reason.dispatchEvent(new window.Event('input',{bubbles:true}));const check=document.querySelector<HTMLInputElement>('[name=confirm]')!;check.checked=true;check.dispatchEvent(new window.Event('click',{bubbles:true}));});
    assert.equal(document.querySelector<HTMLButtonElement>('[data-reference-publish]')!.disabled,false);
    await act(async()=>root.render(<PlatformReferencePanel api={api} role="operator" platformRevision={2}/>));assert.equal(!!document.querySelector('form'),false);assert.match(document.body.textContent!,/没有维护权限/);
    await act(async()=>root.render(<PlatformReferencePanel api={api} role="owner" platformRevision={3}/>));assert.equal(!!document.querySelector('[name=confirm]'),false);assert.equal(document.querySelector<HTMLInputElement>('[name=releaseId]')!.value,'');
    assert.equal(reads.length,2);assert.equal(writes,0);
  }finally{await act(async()=>root.unmount());Object.assign(globalThis,previous);}
});
test('a publication interrupted by blur retains only its original read-only command check until identity changes',async()=>{
  const {PlatformReferencePanel}=await import('./admin-panel'),{createReferenceAdminApi}=await import('./admin-api');
  const {document,window}=parseHTML('<html><body><main></main></body></html>');
  const previous={document:globalThis.document,window:globalThis.window};Object.assign(globalThis,{document,window,IS_REACT_ACT_ENVIRONMENT:true});
  let posts=0,checks=0,commandKey='',resolve!:(v:Response)=>void,signal:AbortSignal|null|undefined;
  const api=createReferenceAdminApi({csrf:()=> 'synthetic',fetchImpl:async(path,init)=>{
    if(init?.method==='POST'){posts++;commandKey=new Headers(init.headers).get('idempotency-key')!;signal=init.signal;return await new Promise<Response>(done=>{resolve=done;});}
    if(path.includes('/commands/status?')){checks++;assert.equal(new Headers(init?.headers).get('idempotency-key'),commandKey);return json({operation:'publish',outcome:'not_observed'});}
    return json(releaseDetail);
  }});
  const root=createRoot(document.querySelector('main')!);
  try{
    await act(async()=>root.render(<PlatformReferencePanel api={api} role="owner" platformRevision={1}/>));
    document.querySelector<HTMLInputElement>('[name=releaseId]')!.value=releaseId;
    await act(async()=>document.querySelector('form')!.dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true})));
    await act(async()=>{const reason=document.querySelector<HTMLInputElement>('[name=reason]')!;reason.value='合成发布';reason.dispatchEvent(new window.Event('input',{bubbles:true}));const check=document.querySelector<HTMLInputElement>('[name=confirm]')!;check.checked=true;check.dispatchEvent(new window.Event('click',{bubbles:true}));});
    await act(async()=>document.querySelector<HTMLButtonElement>('[data-reference-publish]')!.click());assert.equal(posts,1);
    await act(async()=>window.dispatchEvent(new window.Event('blur')));assert.equal(signal?.aborted,true);
    assert.equal(document.querySelector('[name=confirm]'),null);assert.equal(document.querySelector('dl'),null);
    const verify=document.querySelector<HTMLButtonElement>('[data-reference-command-check]');assert.ok(verify,'in-flight command handle must survive blur');
    await act(async()=>verify.click());assert.equal(checks,1);assert.equal(posts,1);
    await act(async()=>resolve(json({...releaseDetail.release,status:'published',revision:3})));
    assert.equal(document.querySelector('dl'),null);assert.ok(document.querySelector('[data-reference-command-check]'));
    await act(async()=>root.render(<PlatformReferencePanel api={api} role="owner" platformRevision={2}/>));
    assert.equal(document.querySelector('[data-reference-command-check]'),null);assert.equal(posts,1);
  }finally{await act(async()=>root.unmount());Object.assign(globalThis,previous);}
});
