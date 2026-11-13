import test from 'node:test';
import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';
import {createGrowthHttpClient} from '../growth/http';
import {mountCfoConversation} from '../growth/agents/cfo-conversation';
import {systemCitationFixture} from './test-fixtures';
import {mountRetainedCfoConversation,clearRetainedCfoConversation} from '../growth/agents/cfo-session-view';
import {createReferenceApi,type ReferenceApi} from './api';

const tick=()=>new Promise<void>(resolve=>setImmediate(resolve));
const sessionId='66666666-6666-4666-8666-666666666666';
const timestamp='2026-10-08T00:00:00.000Z';
const session={sessionId,revision:1,title:'合成会话',documentId:null,turns:[],createdAt:timestamp,updatedAt:timestamp};
const answer={answer:'本题合成分析',model:'fixture',provider:'fixture',material:null,answeredAt:timestamp,libraryStatus:{system:'unavailable',private:'used'}};
function fixture(role='finance',memory=false,withHistory=false,retained=false,referenceApi?:ReferenceApi){
  const {document}=parseHTML('<html><body data-session-workspace-id="synthetic" data-session-user-id="a"><main></main></body></html>');
  const host=document.querySelector('main')!,window=document.defaultView!;
  const calls:Array<{path:string;init?:RequestInit;body:Record<string,unknown>|null}>=[],unexpected:string[]=[];
  const http=createGrowthHttpClient({workspaceId:()=> 'synthetic',csrf:()=> 'synthetic-csrf',fetchImpl:async(path,init)=>{
    const body=typeof init?.body==='string'?JSON.parse(init.body):null;calls.push({path,init,body});
    const json=(v:unknown)=>new Response(JSON.stringify(v),{headers:{'content-type':'application/json'}});
    if(path.endsWith('/cfo-workflows/latest'))return json(null);
    if(path.endsWith('/cfo-sessions'))return json(init?.method==='POST'?session:withHistory?[session]:[]);
    if(path.endsWith(`/cfo-sessions/${sessionId}`))return json({...session,turns:[{role:'assistant',text:'历史摘要',knowledge:{status:'used',detailedText:'历史详细投影',sources:[systemCitationFixture],warnings:systemCitationFixture.warnings},libraryStatus:{system:'ready',private:'no_match'}}]});
    if(path.endsWith('/agent-memory/operating'))return json({revision:1,updatedAt:timestamp,profile:{enabled:true,preferences:{priority:'cash',pilotFirst:true,reviewCadence:'weekly',learningEnabled:true,confirmedFrom:'self_report'}},reviews:[]});
    if(path.endsWith('/cfo-conversation'))return json(answer);
    if(path.endsWith('/operating-memory-question'))return json({answer,...(body?.session?{session:{...session,revision:2}}:{})});
    if(path.endsWith('/turns'))return new Response(JSON.stringify({type:'stage',stage:'model_started'})+'\n'+JSON.stringify({type:'result',result:{session:{...session,revision:2},answer}})+'\n',{headers:{'content-type':'application/x-ndjson'}});
    unexpected.push(path);return new Response('',{status:404});
  }});
  const mount=()=> (retained?mountRetainedCfoConversation:mountCfoConversation)({host,http,scope:()=> 'synthetic:a',initialRole:role,referenceApi});
  const view=mount();
  return {host,window,calls,unexpected,view,remount:mount,async ready(){await tick();if(memory){host.querySelector<HTMLElement>('[data-agent-operating-workbench] > summary')!.click();await tick();host.querySelector<HTMLButtonElement>('[data-memory-use]')!.click();}},send(){host.querySelector('textarea')!.value='请解释预算偏差';host.querySelector('form[data-cfo-question-form]')!.dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true}));}};
}

test('ordinary chat selects only three fixed topics, sends system protocol and displays independent library statuses',async()=>{
  const f=fixture();try{
    await f.ready();const choices=[...f.host.querySelectorAll<HTMLInputElement>('[data-reference-topic]')];
    assert.equal(choices.length,12);
    for(const input of choices.slice(0,3)){input.checked=true;input.dispatchEvent(new f.window.Event('change',{bubbles:true}));}
    assert.equal(choices[3].disabled,true);assert.equal(f.calls.some(c=>c.init?.method==='POST'),false);
    f.send();await tick();
    const call=f.calls.find(c=>c.path.endsWith('/cfo-conversation'))!;
    assert.equal(call.body?.referenceProtocol,'system-v1');assert.deepEqual(call.body?.referenceTopicIds,['budget_variance','budget_planning','cost_driver']);
    assert.equal(call.body?.webSearchMode,'off');assert.equal(call.body?.knowledgeMode,'auto');
    assert.match(f.host.textContent!,/默认参考库不可用.*使用本人资料/s);assert.match(f.host.textContent!,/未使用公网搜索/);
    assert.deepEqual(f.unexpected,[]);
  }finally{f.view.dispose();}
});

for(const [role,memory] of [['cfo',false],['finance',true],['cfo',true]] as const)test(`reference negotiation survives ${role} memory=${memory} request path`,async()=>{
  const f=fixture(role,memory);try{
    await f.ready();const topic=f.host.querySelector<HTMLInputElement>('[data-reference-topic="budget_variance"]')!;
    topic.checked=true;topic.dispatchEvent(new f.window.Event('change',{bubbles:true}));
    f.send();await tick();await tick();
    const path=memory?'/operating-memory-question':'/turns';const call=f.calls.find(c=>c.path.endsWith(path));assert.ok(call);
    const input=(memory?call.body?.input:call.body) as Record<string,unknown>;
    assert.equal(input.referenceProtocol,'system-v1');assert.deepEqual(input.referenceTopicIds,['budget_variance']);
    assert.equal(input.knowledgeMode,'auto');assert.equal(input.webSearchMode,'off');
    if(memory){assert.deepEqual(call.body?.selection,{domain:'operating',revision:1});assert.equal(!!call.body?.session,role==='cfo');}
    assert.match(f.host.textContent!,/默认参考库不可用.*使用本人资料/s);assert.deepEqual(f.unexpected,[]);
    assert.equal(f.calls.filter(c=>c.path.endsWith(path)).length,1);
  }finally{f.view.dispose();}
});

test('history fetch negotiates system references on the wire and preserves history labels without eager citation reads',async()=>{
  const f=fixture('cfo',false,true);try{
    await f.ready();f.host.querySelector<HTMLButtonElement>('[data-cfo-session]')!.click();await tick();
    const read=f.calls.find(c=>c.path.endsWith(`/cfo-sessions/${sessionId}`))!;
    assert.equal(new Headers(read.init?.headers).get('X-Shensi-Reference-Protocol'),'system-v1');
    assert.equal(new Headers(f.calls.find(c=>c.path.endsWith('/cfo-sessions'))!.init?.headers).get('X-Shensi-Reference-Protocol'),null);
    assert.match(f.host.textContent!,/历史详细投影/);assert.match(f.host.textContent!,/历史引用/);assert.match(f.host.textContent!,/使用系统默认参考库/);
    assert.equal(f.host.querySelector('.system-reference-citation a'),null);assert.equal(f.calls.some(c=>c.path.includes('/grants/')),false);assert.deepEqual(f.unexpected,[]);
  }finally{f.view.dispose();}
});

test('actual retained chat detaches citation reads and restores only an explicit revalidation button',async()=>{
  const reads:Array<{path:string;signal?:AbortSignal|null;resolve:(r:Response)=>void}>=[];
  const api=createReferenceApi({workspaceId:()=> 'synthetic',fetchImpl:async(path,init)=>new Promise<Response>(resolve=>reads.push({path,signal:init?.signal,resolve}))});
  const f=fixture('cfo',false,true,true,api);let view=f.view;try{
    await f.ready();f.host.querySelector<HTMLButtonElement>('[data-cfo-session]')!.click();await tick();
    f.host.querySelector<HTMLButtonElement>('.system-reference-citation button')!.click();await tick();assert.equal(reads.length,1);
    const modelRequests=f.calls.filter(c=>c.init?.method==='POST').length;
    view.dispose();assert.equal(reads[0].signal?.aborted,true);view=f.remount();
    reads[0].resolve(new Response(JSON.stringify(systemCitationFixture),{headers:{'content-type':'application/json'}}));await tick();
    assert.doesNotMatch(f.host.querySelector('.system-reference-citation')!.textContent!,/合成预算参考/);assert.equal(reads.length,1);
    f.host.querySelector<HTMLButtonElement>('.system-reference-citation button')!.click();await tick();assert.equal(reads.length,2);
    reads[1].resolve(new Response(JSON.stringify(systemCitationFixture),{headers:{'content-type':'application/json'}}));await tick();
    assert.match(f.host.querySelector('.system-reference-citation')!.textContent!,/合成预算参考/);
    assert.equal(f.calls.filter(c=>c.init?.method==='POST').length,modelRequests);
    assert.ok(reads.every(r=>r.path===`/api/v1/reference-connection/grants/${systemCitationFixture.queryGrantId}/references/${systemCitationFixture.referenceId}`));assert.deepEqual(f.unexpected,[]);
  }finally{view.dispose();clearRetainedCfoConversation(f.host.ownerDocument);}
});

test('chat exposes lazy connection settings without exchanging credentials or issuing a model question',async()=>{
  let reads=0;const api=createReferenceApi({workspaceId:()=> 'synthetic',fetchImpl:async(path,init)=>{
    assert.equal(path,'/api/v1/reference-connection');assert.equal(init?.method,'GET');reads++;
    return new Response(JSON.stringify({status:'unconfigured',generation:0}),{headers:{'content-type':'application/json'}});
  }});
  const f=fixture('finance',false,false,false,api);try{
    await f.ready();assert.equal(reads,0);const summary=f.host.querySelector<HTMLElement>('[data-cfo-reference-connection] > summary');assert.ok(summary);
    summary.click();await tick();assert.equal(reads,1);assert.match(f.host.textContent!,/默认参考库尚未配置/);
    summary.click();await tick();assert.equal(reads,1);assert.equal(f.calls.some(c=>c.init?.method==='POST'),false);
  }finally{f.view.dispose();}
});
