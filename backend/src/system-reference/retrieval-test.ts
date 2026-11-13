import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {retrievalEnvironment,retrievalFixture} from './retrieval-test-support.js';
import {fixtureHash,parsedFixtureHash,syntheticOwner} from './publication-fixture.js';
import {ReferenceIndexBudget} from './index-budget.js';
import {referenceChunkKey} from './repository.js';
import type {ReferenceTransaction,ReferenceRepository} from './repository.js';
import type {ReferenceQuery,QueryResult} from './domain.js';
const input=():ReferenceQuery=>({vocabularyVersion:'finance-topics.v1',topicIds:['budget_variance'],role:'finance',requestId:randomUUID()});
async function setup(f=retrievalFixture()){
  const m=await import('./retrieval.js').catch((e:NodeJS.ErrnoException)=>{if(e.code==='ERR_MODULE_NOT_FOUND')return {} as typeof import('./retrieval.js');throw e;});
  assert.equal(typeof m.SystemReferenceService,'function','bounded current-publication service must exist');
  const e=await retrievalEnvironment(),release=await e.publish(f),connection=await e.connect();
  const service=new m.SystemReferenceService(e.repo,{corpusId:f.manifest.corpusId,now:e.now});
  return {...e,m,f,release,context:connection.context,cancel:connection.cancel,service};
}
function used(result:QueryResult){assert.equal(result.status,'used');if(result.status!=='used')throw Error('expected used');return result;}
const errorStatus=(status:number)=>(e:unknown)=>typeof e==='object'&&e!==null&&'status' in e&&e.status===status;
test('closed fixed-topic query rejects raw fields, unknown roles and vocabulary before disclosure',async()=>{
  const e=await setup(),before=[...e.repo.rows];
  for(const bad of [{...input(),question:'private company value'},{...input(),role:'owner'},{...input(),vocabularyVersion:'future'}, {...input(),topicIds:[]},{...input(),topicIds:['unknown']}]){
    await assert.rejects(e.service.query(e.context,bad as ReferenceQuery),errorStatus(400));
  }
  await assert.rejects(e.service.query({...e.context,access:JSON.parse('{}')},input()),errorStatus(401));
  assert.deepEqual([...e.repo.rows],before);
});
test('topic lexical retrieval returns exact original full chunk, immutable hash, locator and complete warnings',async()=>{
  const e=await setup(),r=used(await e.service.query(e.context,input())),s=r.sources[0],c=e.f.parsed.chunks[0];
  assert.equal(r.sources.length,1);assert.equal(s.excerpt,c.text);assert.deepEqual(s.excerptRange,{start:0,end:40});
  // Independent fixture canonicalization rather than the production hash helper.
  const ordered={locator:{chapter:'合成章节',page:1},order:0,text:c.text,warnings:['table_precision_unverified']};
  assert.equal(s.chunkHash,fixtureHash(JSON.stringify(ordered)));assert.equal(s.sourceHash,e.f.manifest.sources[0].sourceHash);
  assert.deepEqual(s.locator,{page:1,chapter:'合成章节'});assert.equal(s.sourceLabel,'合成参考手册');
  assert.deepEqual(s.warnings,['source_incomplete','text_precision_unverified','table_precision_unverified']);
  assert.deepEqual(await e.service.check(e.context,r.grantId),{valid:true,grantId:r.grantId,releaseId:e.release.id});
  assert.deepEqual(await e.service.citation(e.context,r.grantId,s.referenceId),s);
  await e.service.assertCurrent(e.context,r.grantId);
  assert.equal((await e.service.query(e.context,{...input(),role:'cost'})).status,'no_match');
  assert.equal((await e.service.query(e.context,{...input(),topicIds:['cost_structure']})).status,'no_match');
});
test('ranking keeps complete excerpts under six-source and twelve-thousand-character limits',async()=>{
  const e=await setup(retrievalFixture(undefined,7,2000,140)),r=used(await e.service.query(e.context,input()));
  assert.equal(r.sources.length,6);assert.equal(r.sources.reduce((n,s)=>n+s.excerpt.length,0),12000);
  for(const s of r.sources)assert.ok(e.f.parsed.chunks.some(c=>c.text===s.excerpt));
});
test('grants cannot be guessed, reused across subjects or redirected to another reference',async()=>{
  const e=await setup(),r=used(await e.service.query(e.context,input())),other=await e.connect('other');
  await assert.rejects(e.service.check(other.context,r.grantId),errorStatus(404));
  await assert.rejects(e.service.citation(e.context,r.grantId,randomUUID()),errorStatus(404));
  await assert.rejects(e.service.check(e.context,randomUUID()),errorStatus(404));
  assert.deepEqual(await e.service.citation(e.context,r.grantId,r.sources[0].referenceId),r.sources[0]);
});
test('a superseded published release is not current and its old grants never switch to the new release',async()=>{
  const e=await setup(),r=used(await e.service.query(e.context,input()));const next=await e.publish(e.f);
  await assert.rejects(e.service.check(e.context,r.grantId),errorStatus(404));
  await assert.rejects(e.service.citation(e.context,r.grantId,r.sources[0].referenceId),errorStatus(404));
  const fresh=used(await e.service.query(e.context,input()));assert.equal(fresh.releaseId,next.id);assert.notEqual(fresh.grantId,r.grantId);
});
test('no active release is unavailable rather than no_match; withdrawal invalidates the old grant',async()=>{
  const e=await setup(),r=used(await e.service.query(e.context,input()));
  await e.publication.revokeRelease(syntheticOwner,e.release.id,e.release.revision,'test withdrawal','withdraw');
  await assert.rejects(e.service.query(e.context,input()),errorStatus(503));await assert.rejects(e.service.check(e.context,r.grantId),errorStatus(404));
});
test('incomplete, altered or wrongly-accounted source data fails closed without grants or deductions',async()=>{
  for(const mode of ['incomplete','chunk','characters','manifest','bytes'] as const){
    const e=await setup(),corpus=e.f.manifest.corpusId,hash=e.f.manifest.sources[0].sourceHash;
    if(mode==='chunk')e.replace(corpus,'chunk',referenceChunkKey(e.release.id,hash,0),{...e.f.parsed.chunks[0],text:'corrupted'});
    else if(mode==='incomplete'||mode==='characters'){const key=[e.release.id,hash],row=e.stored(corpus,'source',key) as Record<string,unknown>;e.replace(corpus,'source',key,{...row,...(mode==='incomplete'?{complete:false}:{indexedCharacters:1})});}
    else {const key=['release',e.release.id],row=e.stored(corpus,'release',key) as Record<string,unknown>;e.replace(corpus,'release',key,{...row,...(mode==='manifest'?{manifestHash:'0'.repeat(64)}:{inputBytes:1})});}
    const before=[...e.repo.rows];await assert.rejects(e.service.query(e.context,input()),errorStatus(503));assert.deepEqual([...e.repo.rows],before);
  }
});
test('check validates the whole granted set against source content, not only DTO shape or requested reference',async()=>{
  const e=await setup(retrievalFixture(undefined,2)),r=used(await e.service.query(e.context,input()));assert.equal(r.sources.length,2);
  const key=[r.grantId],grant=e.stored(e.f.manifest.corpusId,'grant',key) as {result:typeof r};
  grant.result.sources[1].locator={page:99};e.replace(e.f.manifest.corpusId,'grant',key,grant);
  await assert.rejects(e.service.check(e.context,r.grantId),errorStatus(503));
  await assert.rejects(e.service.citation(e.context,r.grantId,r.sources[0].referenceId),errorStatus(503));
});
test('cancellation immediately before transaction commit rolls back the whole disclosure',async()=>{
  const e=await setup(),before=[...e.repo.rows];e.repo.beforeCommit=e.cancel;
  await assert.rejects(e.service.query(e.context,input()),errorStatus(401));assert.deepEqual([...e.repo.rows],before);
});
test('cancellation and shared input-budget exhaustion never fake no_match and release their reservation',async()=>{
  const e=await setup(),budget=new ReferenceIndexBudget(64*1024*1024),hold=budget.reserve(64*1024*1024);
  const service=new e.m.SystemReferenceService(e.repo,{corpusId:e.f.manifest.corpusId,now:e.now,indexBudget:budget});
  await assert.rejects(service.query(e.context,input()),errorStatus(503));hold();
  const abort=new AbortController();abort.abort('private reason');await assert.rejects(service.query(e.context,input(),abort.signal),errorStatus(503));
  used(await service.query(e.context,input()));
});
test('combined quality warnings are never silently truncated',async()=>{
  const f=retrievalFixture();f.parsed.warnings=Array.from({length:100},(_,n)=>`synthetic_${n}`);f.manifest.sources[0].warnings=[...f.parsed.warnings];f.manifest.sources[0].parsedHash=parsedFixtureHash(f.parsed);
  const e=await setup(f);await assert.rejects(e.service.query(e.context,input()),errorStatus(503));
});
test('integrated query rate rejects sixth binding request and eleventh account request across three bindings',async()=>{
  const e=await setup();for(let n=0;n<5;n++)used(await e.service.query(e.context,input()));
  assert.equal((await e.service.query(e.context,input())).status,'rate_limited');
  const b=await e.connect(),c=await e.connect();for(let n=0;n<5;n++)used(await e.service.query(b.context,input()));
  assert.equal((await e.service.query(c.context,input())).status,'rate_limited');
});
test('invalid grant guesses still consume the independent read budget',async()=>{
  const e=await setup();for(let n=0;n<60;n++)await assert.rejects(e.service.check(e.context,randomUUID()),errorStatus(404));
  await assert.rejects(e.service.check(e.context,randomUUID()),errorStatus(429));
});
test('the active-pointer revision is fenced again at commit and partial disclosure rolls back',async()=>{
  const e=await setup(),before=[...e.repo.rows];let transaction:ReferenceTransaction|undefined;
  const repo:ReferenceRepository={corpusForRelease:e.repo.corpusForRelease.bind(e.repo),transaction:(corpus,auth,op)=>e.repo.transaction(corpus,auth,tx=>{transaction=tx;return op(tx);})};
  const service=new e.m.SystemReferenceService(repo,{corpusId:e.f.manifest.corpusId,now:e.now});
  e.repo.beforeCommit=async()=>{await transaction!.set('release',['active'],{id:e.release.id,revision:999});};
  await assert.rejects(service.query(e.context,input()),errorStatus(404));assert.deepEqual([...e.repo.rows],before);
});
test('an abort during source loading releases no grant and does not poison the next question',async()=>{
  const e=await setup(),before=[...e.repo.rows],abort=new AbortController();
  const repo:ReferenceRepository={corpusForRelease:e.repo.corpusForRelease.bind(e.repo),transaction:(corpus,auth,op)=>e.repo.transaction(corpus,auth,tx=>op({...tx,get:async(kind,key,schema)=>{
    const result=await tx.get(kind,key,schema);if(kind==='chunk')abort.abort('private details');return result;
  }}))};
  const service=new e.m.SystemReferenceService(repo,{corpusId:e.f.manifest.corpusId,now:e.now});
  await assert.rejects(service.query(e.context,input(),abort.signal),errorStatus(503));assert.deepEqual([...e.repo.rows],before);
  used(await e.service.query(e.context,input()));
});
test('role filtering happens before selecting the best six ranked sources',async()=>{
  const f=retrievalFixture(),cost=retrievalFixture(f.manifest.corpusId,7,40,140),source=cost.manifest.sources[0];
  source.sourceHash=fixtureHash('another synthetic source');source.roles=['cost'];source.title='预算偏差 预算执行偏差 budget variance';
  f.manifest.sources.unshift(source);f.pages.unshift(...cost.pages.map(p=>({...p,sourceHash:source.sourceHash})));
  const e=await setup(f),r=used(await e.service.query(e.context,input()));assert.equal(r.sources.length,1);assert.equal(r.sources[0].sourceHash,f.manifest.sources[1].sourceHash);
});
test('grant expiry during a read is rejected at commit even with a fresh valid binding',async()=>{
  const e=await setup(),r=used(await e.service.query(e.context,input())),base=e.now(),DAY=86400000;
  e.time(base+29*DAY);const fresh=await e.connect(),before=[...e.repo.rows];
  e.repo.beforeCommit=async()=>{e.time(base+30*DAY);};
  await assert.rejects(e.service.check(fresh.context,r.grantId),errorStatus(404));assert.deepEqual([...e.repo.rows],before);
});
