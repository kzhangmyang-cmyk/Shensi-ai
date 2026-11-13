import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {TestReferenceRepository} from './publication-test-support.js';
import {createReferenceCrypto} from './crypto.js';
import {syntheticReferenceKey,fixtureHash} from './publication-fixture.js';
import type {CentralReader} from './domain.js';
const reader:CentralReader={subjectId:'reader-a',workspaceId:'workspace-a',authVersion:1,authorityRevision:1};
const DAY=86400000,base=Date.UTC(2026,9,8);
async function setup(){
  const m=await import('./grants.js').catch((e:NodeJS.ErrnoException)=>{if(e.code==='ERR_MODULE_NOT_FOUND')return {} as typeof import('./grants.js');throw e;});
  assert.equal(typeof m.recordReferenceGrant,'function','persistent grant transaction primitive must exist');
  const repository=new TestReferenceRepository(createReferenceCrypto(syntheticReferenceKey));
  const corpusId=randomUUID(),releaseId=randomUUID();let now=base;
  const tx=<T>(fn:Parameters<typeof repository.transaction<T>>[2])=>repository.transaction(corpusId,async()=>{},fn);
  const candidate=(n=0,length=30,indexedCharacters=2400000)=>({sourceHash:fixtureHash('source'),chunkHash:fixtureHash(`chunk-${n}-${length}`),excerpt:(`合成预算${n} `+ '参'.repeat(length)).slice(0,length),sourceLabel:'仅合成来源',locator:{page:n+1,chapter:'预算'},warnings:['text_precision_unverified'],indexedCharacters});
  const release=(candidates=[candidate()],who=reader,version=releaseId)=>tx(t=>m.recordReferenceGrant(t,{reader:who,corpusId,releaseId:version,requestId:randomUUID(),candidates,now}));
  const rate=(bindingId='binding-a',who=reader.subjectId,ip='127.0.0.1',operation:'query'|'read'='query')=>tx(t=>m.consumeReferenceRate(t,{subjectId:who,bindingId,ip,operation,now}));
  return {m,repository,tx,corpusId,releaseId,candidate,release,rate,time:(t:number)=>{now=t;},get now(){return now;}};
}
test('binding and account minute limits are independent, persistent and sliding',async()=>{
  const e=await setup();for(let i=0;i<5;i++)assert.equal(await e.rate(),true);assert.equal(await e.rate(),false);
  e.time(base+59999);assert.equal(await e.rate(),false);e.time(base+60000);assert.equal(await e.rate(),true);
  const f=await setup();for(let i=0;i<10;i++)assert.equal(await f.rate(`binding-${i%3}`),true);
  assert.equal(await f.rate('binding-2'),false); // binding has only three calls, account has ten.
});
test('UTC-day binding and account limits cannot be bypassed by pacing or rebinding',async()=>{
  const e=await setup();for(let i=0;i<60;i++){e.time(base+i*60001);assert.equal(await e.rate(),true);}e.time(base+61*60001);assert.equal(await e.rate(),false);
  e.time(base+DAY);assert.equal(await e.rate(),true);
  const f=await setup();for(let i=0;i<100;i++){f.time(base+i*60001);assert.equal(await f.rate(`binding-${i%3}`),true);}f.time(base+101*60001);assert.equal(await f.rate('new-binding'),false);
});
test('query IP and combined read/check IP limits are distinct from account limits',async()=>{
  const e=await setup();for(let i=0;i<60;i++)assert.equal(await e.rate(`b-${i}`,`u-${i}`),true);
  assert.equal(await e.rate('b-new','u-new'),false);
  for(let i=0;i<60;i++)assert.equal(await e.rate(`b-${i}`,`r-${i}`,'127.0.0.1','read'),true);
  assert.equal(await e.rate('b-last','r-last','127.0.0.1','read'),false);
  const f=await setup();for(let i=0;i<60;i++)assert.equal(await f.rate('b',reader.subjectId,'127.0.0.1','read'),true);
  assert.equal(await f.rate('other-binding',reader.subjectId,'127.0.0.2','read'),false);
});
test('grants bind exact immutable excerpt, locator, hashes and warnings to reader and release',async()=>{
  const e=await setup(),c=e.candidate(),r=await e.release([c]);assert.equal(r.status,'used');if(r.status!=='used')return;
  const source=r.sources[0];assert.deepEqual({text:source.excerpt,locator:source.locator,hash:source.chunkHash,warnings:source.warnings},{text:c.excerpt,locator:c.locator,hash:c.chunkHash,warnings:c.warnings});
  assert.deepEqual(source.excerptRange,{start:0,end:c.excerpt.length});
  const input={reader,corpusId:e.corpusId,releaseId:e.releaseId,grantId:r.grantId,now:e.now};
  assert.deepEqual(await e.tx(t=>e.m.readReferenceCitation(t,{...input,referenceId:source.referenceId})),source);
  for(const changed of [{...input,reader:{...reader,subjectId:'other'}},{...input,reader:{...reader,workspaceId:'other'}},{...input,reader:{...reader,authVersion:2}},{...input,releaseId:randomUUID()},{...input,now:base+30*DAY}])await assert.rejects(e.tx(t=>e.m.assertReferenceGrant(t,changed)),/grant_invalid/);
  await assert.rejects(e.tx(t=>e.m.readReferenceCitation(t,{...input,referenceId:randomUUID()})),/grant_invalid/);
  await assert.rejects(e.tx(t=>e.m.readReferenceCitation(t,{...input,referenceId:source.referenceId,range:{start:0,end:1}} as never)));
  r.sources[0].excerpt='client mutation';assert.equal((await e.tx(t=>e.m.readReferenceCitation(t,{...input,referenceId:source.referenceId}))).excerpt,c.excerpt);
  assert.equal(JSON.stringify([...e.repository.rows.values()]).includes(c.excerpt),false);
});
test('daily twelve-new-chunk budget survives a same-hash new release and repeats do not double-charge',async()=>{
  const e=await setup();for(let i=0;i<12;i++)assert.equal((await e.release([e.candidate(i)])).status,'used');
  assert.equal((await e.release([e.candidate(12)],reader,randomUUID())).status,'rate_limited');
  assert.equal((await e.release([e.candidate(0)],reader,randomUUID())).status,'used');
  e.time(base+DAY);assert.equal((await e.release([e.candidate(12)])).status,'used');
});
test('daily character and rolling five-percent budgets never truncate a chunk',async()=>{
  const e=await setup();for(let i=0;i<6;i++)assert.equal((await e.release([e.candidate(i,4000)])).status,'used');
  assert.equal((await e.release([e.candidate(7,30)])).status,'rate_limited');
  const f=await setup(),c=f.candidate(1,31,600);assert.equal((await f.release([c])).status,'rate_limited');
  const exact=f.candidate(0,30,600);assert.equal((await f.release([exact])).status,'used');
  f.time(base+DAY);assert.equal((await f.release([f.candidate(2,1,600)])).status,'rate_limited');
});
test('rolling thirty-day boundary and 120000-character ceiling survive release changes',async()=>{
  const e=await setup();for(let day=0;day<5;day++){e.time(base+day*DAY);for(let n=0;n<6;n++)assert.equal((await e.release([e.candidate(day*6+n,4000,10000000)])).status,'used');}
  e.time(base+29*DAY);assert.equal((await e.release([e.candidate(99,4000,10000000)],reader,randomUUID())).status,'rate_limited');
  e.time(base+30*DAY-1);assert.equal((await e.release([e.candidate(99,4000,10000000)])).status,'rate_limited');
  e.time(base+30*DAY);assert.equal((await e.release([e.candidate(99,4000,10000000)])).status,'used');
});
test('concurrent final allowance permits one release and audit failure rolls back grant and accounting',async()=>{
  const e=await setup();for(let n=0;n<11;n++)await e.release([e.candidate(n)]);
  const results=await Promise.all([e.release([e.candidate(11)]),e.release([e.candidate(12)])]);assert.deepEqual(results.map(r=>r.status).sort(),['rate_limited','used']);
  const f=await setup(),before=[...f.repository.rows];f.repository.fault=kind=>{if(kind==='audit')throw Error('synthetic audit fault');};
  await assert.rejects(f.release(),/synthetic audit fault/);assert.deepEqual([...f.repository.rows],before);
  f.repository.fault=undefined;assert.equal((await f.release()).status,'used');
});
test('no-match and quota results stay distinct, responses stay bounded, and audit omits all source text',async()=>{
  const e=await setup();assert.deepEqual(await e.release([]),{status:'no_match',releaseId:e.releaseId,sources:[]});
  const result=await e.release([e.candidate(0,4000),e.candidate(1,4000),e.candidate(2,4000),e.candidate(3,4000)]);
  assert.equal(result.status,'used');assert.equal(result.sources.length,3);assert.equal(result.sources.reduce((n,s)=>n+s.excerpt.length,0),12000);
  for(const [key,sealed] of e.repository.rows){const [corpusId,kind,parts]=JSON.parse(key);if(kind==='audit'){
    const audit=e.repository.crypto.open({corpusId,kind,key:parts},sealed) as Record<string,unknown>;
    assert.deepEqual(Object.keys(audit).sort(),['action','at','characters','reason','releaseId','requestId','sourceCount','subjectId','workspaceId'].sort());
    assert.equal(JSON.stringify(audit).includes('合成预算'),false);
  }}
});
test('backwards clocks and a changed excerpt under one chunk identity fail without changing accounting',async()=>{
  const e=await setup();await e.rate();await e.release();const before=[...e.repository.rows];
  e.time(base-1);await assert.rejects(e.rate(),/clock_invalid/);await assert.rejects(e.release(),/clock_invalid/);
  e.time(base);await assert.rejects(e.release([{...e.candidate(),excerpt:'错'.repeat(30)}]),/source_identity_invalid/);
  assert.deepEqual([...e.repository.rows],before);
});
test('identical excerpts in different chunks do not double-charge characters but new chunks still count',async()=>{
  const e=await setup(),c=e.candidate(0,30,600);
  for(let i=0;i<12;i++)assert.equal((await e.release([{...c,chunkHash:fixtureHash(`duplicate-${i}`)}])).status,'used');
  assert.equal((await e.release([{...c,chunkHash:fixtureHash('duplicate-13')}])).status,'rate_limited');
  e.time(base+DAY);assert.equal((await e.release([{...c,chunkHash:fixtureHash('duplicate-next-day')}])).status,'used');
  assert.equal((await e.release([e.candidate(1,1,600)])).status,'rate_limited');
});
test('commit-time authority denial rolls back rate, disclosure, grant and safe audit together',async()=>{
  const e=await setup(),before=[...e.repository.rows];let checks=0;
  await assert.rejects(e.repository.transaction(e.corpusId,async()=>{if(++checks===2)throw Error('synthetic authority changed');},async tx=>{
    assert.equal(await e.m.consumeReferenceRate(tx,{subjectId:reader.subjectId,bindingId:'b',ip:'127.0.0.1',operation:'query',now:base}),true);
    return e.m.recordReferenceGrant(tx,{reader,corpusId:e.corpusId,releaseId:e.releaseId,requestId:randomUUID(),candidates:[e.candidate()],now:base});
  }),/synthetic authority changed/);
  assert.equal(checks,2);assert.deepEqual([...e.repository.rows],before);
});
