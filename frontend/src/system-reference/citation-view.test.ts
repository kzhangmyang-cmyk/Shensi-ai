import assert from 'node:assert/strict';
import test from 'node:test';
import { parseHTML } from 'linkedom';
import { systemCitationFixture as citation } from './test-fixtures';
import type { ReferenceApi, SystemReference } from './api';
const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function mount(){const mod=await import('./citation-view').catch(()=>null);assert.ok(mod,'system-only excerpt view required');return mod.mountSystemReferenceCitation;}
function fixture(){const {document}=parseHTML('<html><body><main></main></body></html>');assert.ok(document.defaultView);document.body.dataset.sessionUserId='a';document.body.dataset.sessionWorkspaceId='team-a';return {document,window:document.defaultView,host:document.querySelector('main')!};}
test('system citation opens only its exact grant, shows historical checked excerpt and never private/full-book/navigation links',async()=>{
  const render=await mount(),{document,host}=fixture();const calls:unknown[]=[];
  const api:Pick<ReferenceApi,'citation'>={citation:async(grant,ref)=>{calls.push([grant,ref]);return {...citation,sourceId:'K1'};}};
  const view=render(host,{api,identity:()=> 'local-a',citation,historical:true});
  assert.match(host.textContent!,/历史/);assert.doesNotMatch(host.textContent!,/合成预算参考/);assert.equal(calls.length,0);
  host.querySelector('button')!.click();await tick();
  assert.deepEqual(calls,[[citation.queryGrantId,citation.referenceId]]);assert.match(host.textContent!,/合成预算参考/);
  assert.match(host.textContent!,/物理页 17/);assert.match(host.textContent!,/表格待核对/);assert.match(host.textContent!,/OCR.*待核对/);
  assert.equal(host.querySelector('img'),null);assert.equal(host.querySelector('a'),null);assert.equal(host.querySelector('[data-next-page]'),null);
  assert.equal(host.querySelector('button')!.disabled,true);view.dispose();assert.equal(host.textContent,'');void document;
});
test('system citation rejects a changed version, text, hash, locator, warning or range rather than replacing history',async()=>{
  const render=await mount();
  for(const altered of [{...citation,releaseId:citation.corpusId},{...citation,excerpt:'更改预算参考'},
    {...citation,chunkHash:'c'.repeat(64)},{...citation,locator:{page:18}}, {...citation,warnings:[]}, {...citation,excerptRange:{start:1,end:7}}]){
    const {host}=fixture();let calls=0;const view=render(host,{api:{citation:async()=>{calls++;return altered;}},identity:()=> 'a',citation,historical:true});
    host.querySelector('button')!.click();await tick();assert.match(host.textContent!,/历史/);assert.match(host.textContent!,/不可用|无法核验/);
    assert.doesNotMatch(host.textContent!,/合成预算参考|更改预算参考/);assert.equal(calls,1);view.dispose();
  }
});
for(const change of ['dispose','local','workspace','auth','central'] as const)test(`system citation ${change} clears prior content and prevents a late read`,async()=>{
  const render=await mount(),{document,window,host}=fixture();let identity='a',resolve!:(v:SystemReference)=>void,signal:AbortSignal|undefined;
  const view=render(host,{api:{citation:async(_g,_r,s)=>{signal=s;return new Promise<SystemReference>(done=>{resolve=done;});}},identity:()=>identity,citation,historical:true});
  host.querySelector('button')!.click();await tick();
  if(change==='dispose')view.dispose();
  if(change==='local'){identity='b';document.body.dataset.sessionUserId='b';}
  if(change==='workspace')document.body.dataset.sessionWorkspaceId='other';
  if(change==='auth')document.dispatchEvent(new window.Event('goodjob:auth-state-changed'));
  if(change==='central')document.dispatchEvent(new window.Event('shensi:reference-connection-changed'));
  await tick();assert.equal(signal?.aborted,true);resolve(citation);await tick();assert.doesNotMatch(host.textContent!,/合成预算参考/);view.dispose();
});
test('an already displayed excerpt is removed immediately when central binding changes',async()=>{
  const render=await mount(),{document,window,host}=fixture();const view=render(host,{api:{citation:async()=>citation},identity:()=> 'a',citation,historical:false});
  host.querySelector('button')!.click();await tick();assert.match(host.textContent!,/合成预算参考/);
  document.dispatchEvent(new window.Event('shensi:reference-connection-changed'));assert.doesNotMatch(host.textContent!,/合成预算参考/);view.dispose();
});
test('retained citation suspends reads, discards a late result after resume and requires a fresh explicit click',async()=>{
  const render=await mount(),{host}=fixture();const requests:Array<{signal?:AbortSignal;resolve:(v:SystemReference)=>void}>=[];
  const view=render(host,{api:{citation:async(_g,_r,signal)=>new Promise<SystemReference>(resolve=>requests.push({signal,resolve}))},identity:()=> 'a',citation,historical:true});
  try{
    host.querySelector('button')!.click();await tick();view.suspend();assert.equal(requests[0].signal?.aborted,true);
    view.resume();assert.equal(requests.length,1);requests[0].resolve(citation);await tick();assert.doesNotMatch(host.textContent!,/合成预算参考/);
    host.querySelector('button')!.click();assert.equal(requests.length,2);requests[1].resolve(citation);await tick();assert.match(host.textContent!,/合成预算参考/);
    view.suspend();assert.doesNotMatch(host.textContent!,/合成预算参考/);view.resume();assert.equal(requests.length,2);assert.match(host.textContent!,/历史引用/);
  }finally{view.dispose();}
});
