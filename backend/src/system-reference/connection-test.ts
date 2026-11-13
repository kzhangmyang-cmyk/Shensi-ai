import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import type { KnowledgeScope } from '../knowledge/domain.js';
import { TestConnectionStore } from './connection-test-support.js';
import { ReferenceTransport } from './client.js';
const origin = 'https://library.example.test';
const token = Buffer.alloc(32, 9).toString('base64url');
const secret = 'synthetic-reference-connection-key-for-tests-only';
const ctx: KnowledgeScope = { actorId:'local-a',workspaceId:'local-team',teamId:'local-team',kind:'team',role:'admin',capabilities:['knowledge.read'],capabilityRegistryVersion:'test' };
const reader = {subjectId:'central-a',workspaceId:'central-team',authVersion:1,authorityRevision:2};
const query = { vocabularyVersion:'finance-topics.v1', topicIds:['budget_variance'],role:'finance',requestId:randomUUID() } as const;
function deferred<T>() { let resolve!: (value:T)=>void; const promise = new Promise<T>(done=>{resolve=done;}); return {resolve,promise}; }
async function setup() {
  const mod = await import('./connection-service.js').catch(()=>null); assert.ok(mod,'scoped durable connection service must be implemented');
  const store = new TestConnectionStore(); let actor = ctx.actorId, version = 1, clock = Date.now();
  const attempts = {exchange:0,cancel:0,query:0}; let exchangeFailure = false, cancelFailure = false;
  let gate: ReturnType<typeof deferred<Response>> | null = null; let sent = deferred<void>();
  const requestId = randomUUID(); let verifier = '', challenge = '';
  const transport = new ReferenceTransport({origin,fetch:async(url,init)=>{
    const path = new URL(String(url)).pathname;
    if(path.endsWith('/binding-requests')) { challenge=JSON.parse(String(init?.body)).challenge; return Response.json({requestId,displayCode:'12345678',expiresAt:new Date(clock+300000).toISOString()},{status:201}); }
    if(path.endsWith('/exchange')) {
      attempts.exchange++; verifier=JSON.parse(String(init?.body)).verifier;
      assert.equal(createHash('sha256').update(verifier).digest('base64url'),challenge); sent.resolve();
      if(gate) return gate.promise; if(exchangeFailure) throw new Error('raw-provider-secret');
      return Response.json({readerToken:token,reader,expiresAt:new Date(clock+86400000).toISOString()});
    }
    if(path.endsWith('/cancel')) { attempts.cancel++; if(cancelFailure) throw new Error('private-error'); return new Response(null,{status:204}); }
    if(path.endsWith('/query')) { attempts.query++; sent.resolve(); if(gate) return gate.promise; return Response.json({status:'no_match',sources:[]}); }
    throw new Error('unexpected path');
  }});
  const current = async (scope: KnowledgeScope) => { if(scope.actorId!==actor) throw new Error('session-invalid'); return {actorId:actor,workspaceId:scope.workspaceId,authVersion:version}; };
  const service = new mod.ReferenceConnectionService({mode:'client',backendInstanceId:'installation-a',issuer:origin,store,secret,current,transport,now:()=>clock});
  const restart = (issuer = origin) => new mod.ReferenceConnectionService({mode:'client',backendInstanceId:'installation-a',issuer,store,secret,current,
    transport:issuer===origin?transport:new ReferenceTransport({origin:issuer,fetch:async()=>{throw Error('no old issuer request');}}),now:()=>clock});
  return {service,store,attempts,requestId,restart,current,readVerifier:()=>verifier,
    actor:(next:string)=>{actor=next;}, version:()=>{version++;}, advance:(ms:number)=>{clock+=ms;},
    failures:(exchange:boolean,cancel=false)=>{exchangeFailure=exchange;cancelFailure=cancel;},
    delay:()=>{gate=deferred<Response>();sent=deferred<void>();return {result:gate,sent:sent.promise};}};
}
// Breaks caught: replay after uncertain exchange; credential exposure; wrong-AAD
// restoration; evidence released after logout/version/issuer/scope change.
test('binding exposes safe DTOs and encrypts proof/token under exact local scope', async()=>{
  const f=await setup(); const begin=await f.service.begin(ctx);
  assert.deepEqual(Object.keys(begin).sort(),['approvalUrl','displayCode','expiresAt','requestId']);
  assert.equal(new URL(begin.approvalUrl).origin,origin);
  const ready=await f.service.complete(ctx,begin.requestId); assert.equal(ready.status,'ready');
  const bytes=JSON.stringify([...f.store.records.values()]); assert.ok(!bytes.includes(token)); assert.ok(!bytes.includes(f.readVerifier()));
  assert.deepEqual(Object.keys(ready).sort(),['centralAccountLabel','expiresAt','generation','status']);
  await assert.rejects(f.service.complete(ctx,begin.requestId)); assert.equal(f.attempts.exchange,1);
});
test('service close cancels in-flight work, rejects late results and preserves durable bindings for restart', async()=>{
  const f=await setup();await f.service.complete(ctx,(await f.service.begin(ctx)).requestId);
  const before=JSON.stringify([...f.store.records]),client=await f.service.clientFor(ctx),delayed=f.delay();
  const queryPromise=client.query({...query,topicIds:[...query.topicIds]});
  const rejected=assert.rejects(queryPromise);
  await delayed.sent;
  assert.equal(typeof f.service.close,'function','owned service lifecycle must exist');
  f.service.close();f.service.close();
  delayed.result.resolve(Response.json({status:'no_match',sources:[]}));await rejected;
  await assert.rejects(f.service.status(ctx));await assert.rejects(f.service.begin(ctx));
  await assert.rejects(client.query({...query,topicIds:[...query.topicIds]}));
  assert.equal(JSON.stringify([...f.store.records]),before);
  assert.equal((await f.restart().status(ctx)).status,'ready');
  assert.equal(f.attempts.cancel,0);
});
test('close while a local transaction is queued cannot create a new pending binding afterward',async()=>{
  const f=await setup(),entered=deferred<void>(),resume=deferred<void>(),transaction=f.store.transaction.bind(f.store);
  f.store.transaction=async(...args)=>{entered.resolve();await resume.promise;return transaction(...args);};
  const beginning=f.service.begin(ctx),rejected=assert.rejects(beginning);
  await entered.promise;f.service.close();resume.resolve();await rejected;
  assert.ok([...f.store.records.values()].every(row=>row.connections.length===0));
});
for(const change of ['actor','logout','version','issuer'] as const) test(`pending ${change} cannot exchange/store a reader token`,async()=>{
  const f=await setup(); const begun=await f.service.begin(ctx);
  if(change==='actor') f.actor('local-b'); if(change==='logout') await f.service.fenceActor(ctx.actorId);
  if(change==='version') f.version(); const active=change==='issuer'?f.restart('https://other.example.test'):f.service;
  await assert.rejects(active.complete(ctx,begun.requestId)); assert.equal(f.attempts.exchange,0);
  assert.ok([...f.store.records.values()].every(row=>row.connections.every(slot=>slot.status!=='ready')));
});
test('uncertain exchange persists consumption before call, survives restart, and only explicit cancel permits new begin',async()=>{
  const f=await setup();const begin=await f.service.begin(ctx);f.failures(true,true);
  assert.equal((await f.service.complete(ctx,begin.requestId)).status,'unconfirmed');
  await assert.rejects(f.restart().complete(ctx,begin.requestId)); assert.equal(f.attempts.exchange,1);
  assert.equal((await f.service.unbind(ctx)).status,'unconfirmed'); await assert.rejects(f.service.begin(ctx));
  f.failures(false);assert.equal((await f.service.unbind(ctx)).status,'unbound');
  assert.equal((await f.service.begin(ctx)).requestId,f.requestId);
  assert.ok([...f.store.records.values()][0]!.tombstones.length>0);
});
test('exchange response after logout cannot restore a token',async()=>{
  const f=await setup();const begin=await f.service.begin(ctx), delayed=f.delay();
  const completing=f.service.complete(ctx,begin.requestId);await delayed.sent;
  await f.service.fenceActor(ctx.actorId);
  delayed.result.resolve(Response.json({readerToken:token,reader,expiresAt:new Date(Date.now()+60000).toISOString()}));
  await assert.rejects(completing); assert.equal((await f.service.status(ctx)).status,'unconfirmed');
  assert.ok([...f.store.records.values()].every(row=>row.connections.length===0));
});
test('late query after unbind releases no sources, and a captured client cannot request again',async()=>{
  const f=await setup();await f.service.complete(ctx,(await f.service.begin(ctx)).requestId);
  const client=await f.service.clientFor(ctx), delayed=f.delay();let released=0;
  const querying=client.query({...query,topicIds:[...query.topicIds]}).then(()=>{released++;});await delayed.sent;
  await f.service.unbind(ctx);delayed.result.resolve(Response.json({status:'no_match',sources:[]}));
  await assert.rejects(querying);assert.equal(released,0);
  await assert.rejects(client.query({...query,topicIds:[...query.topicIds]}));assert.equal(f.attempts.query,1);
});
test('same installation restart restores only same account/version/issuer and still uses fresh authenticated transport',async()=>{
  const f=await setup();await f.service.complete(ctx,(await f.service.begin(ctx)).requestId);
  const restarted=f.restart();assert.equal((await restarted.status(ctx)).status,'ready');
  await (await restarted.clientFor(ctx)).query({...query,topicIds:[...query.topicIds]});assert.equal(f.attempts.query,1);
  f.version();assert.notEqual((await restarted.status(ctx)).status,'ready');await assert.rejects(restarted.clientFor(ctx));
});
test('different workspace cannot consume an existing binding and expired credential is never restored',async()=>{
  const f=await setup();const begin=await f.service.begin(ctx);
  await assert.rejects(f.service.complete({...ctx,workspaceId:'other'},begin.requestId));assert.equal(f.attempts.exchange,0);
  await f.service.complete(ctx,begin.requestId);f.advance(86400001);assert.notEqual((await f.restart().status(ctx)).status,'ready');
});
test('explicit central mode alone may use legal current central identity without exporting credentials',async()=>{
  const mod=await import('./connection-service.js').catch(()=>null);assert.ok(mod);
  let checks=0; const f=await setup(); const central=new mod.ReferenceConnectionService({mode:'central',current:f.current,
    central:async(scope)=>{checks++; assert.equal(scope.actorId,ctx.actorId);return {query:async()=>({status:'no_match' as const,sources:[]}),assertCurrent:async()=>{},citation:async()=>{throw Error('unused');}};}});
  assert.deepEqual(await central.status(ctx),{status:'session_ready',generation:0});
  await (await central.clientFor(ctx)).query({...query,topicIds:[...query.topicIds]});assert.ok(checks>=2);
  await assert.rejects(central.begin(ctx));
  const disabled=new mod.ReferenceConnectionService({mode:'disabled',current:f.current});assert.equal((await disabled.status(ctx)).status,'unconfigured');await assert.rejects(disabled.clientFor(ctx));
});
test('cipher authentication binds every scope dimension and rejects copied ciphertext',async()=>{
  const mod=await import('./connection-store.js').catch(()=>null);assert.ok(mod,'connection crypto required');
  const crypto=mod.createConnectionCrypto(secret),scope={backendInstanceId:'a',actorId:'u',workspaceId:'w',authVersion:1,generation:1,issuer:origin};
  const sealed=crypto.seal(scope,{verifier:token,readerToken:token});
  assert.deepEqual(crypto.open(scope,sealed),{verifier:token,readerToken:token});
  for(const field of ['backendInstanceId','actorId','workspaceId','issuer','authVersion','generation'] as const) {
    await assert.rejects(async()=>crypto.open({...scope,[field]:typeof scope[field]==='number'?2:'changed'},sealed));
  }
  assert.throws(()=>mod.createConnectionCrypto('short')); assert.throws(()=>crypto.open(scope,sealed.slice(0,-3)+'aaa'));
});
test('logout while begin waits for local authority prevents even a new challenge',async()=>{
  const f=await setup(),mod=await import('./connection-service.js');const pending=deferred<void>(),started=deferred<void>();let calls=0;
  const service=new mod.ReferenceConnectionService({mode:'client',backendInstanceId:'installation-a',issuer:origin,store:f.store,secret,
    current:async(scope)=>{started.resolve();await pending.promise;return f.current(scope);},
    transport:new ReferenceTransport({origin,fetch:async()=>{calls++;return Response.json({requestId:randomUUID(),displayCode:'12345678',expiresAt:new Date(Date.now()+60000).toISOString()},{status:201});}})});
  const beginning=service.begin(ctx);await started.promise;await service.fenceActor(ctx.actorId);pending.resolve();
  await assert.rejects(beginning);assert.equal(calls,0);assert.equal([...f.store.records.values()][0]!.connections.length,0);
});
test('per-call signal cannot override cancellation of the owning question',async()=>{
  const f=await setup();await f.service.complete(ctx,(await f.service.begin(ctx)).requestId);
  const owner=new AbortController(),operation=new AbortController(),client=await f.service.clientFor(ctx,owner.signal);owner.abort();
  await assert.rejects(client.query({...query,topicIds:[...query.topicIds]},operation.signal));assert.equal(f.attempts.query,0);
});
