import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {TestReferenceRepository} from './publication-test-support.js';
import {syntheticOwner as owner,syntheticReferenceKey as stableKey,fixtureHash as hash,fixture,parsedFixtureHash} from './publication-fixture.js';
async function modules(){
  const m=await import('./publication.js').catch((e:NodeJS.ErrnoException)=>{if(e.code==='ERR_MODULE_NOT_FOUND')return {} as typeof import('./publication.js');throw e;});
  assert.equal(typeof m.ReferencePublication,'function','publication service must exist');
  return {m,c:await import('./crypto.js')};
}
async function setup(){const {m,c}=await modules();const repo=new TestReferenceRepository(c.createReferenceCrypto(stableKey));let current={...owner};
  const authority={assertOwner:async()=>({...current}),current:async()=>{throw Error('not used');}};
  return {repo,service:new m.ReferencePublication(repo,authority),changeOwner:()=>{current={...current,platformRevision:2};},c};
}
async function ready(env:Awaited<ReturnType<typeof setup>>,f=fixture(),key='create'){
  let draft=await env.service.stageRelease(owner,f.manifest,key);
  for(const page of f.pages)draft=await env.service.stageSource(owner,draft.id,page,draft.revision,`${key}-page-${page.pageIndex}`);
  assert.equal(draft.status,'ready');return draft;
}
test('only complete hash-checked and indexed source sets become ready and publishable',async()=>{
  const env=await setup(),f=fixture(undefined,101);let d=await env.service.stageRelease(owner,f.manifest,'manifest');
  assert.equal(d.status,'staging');await assert.rejects(env.service.publishRelease(owner,d.id,d.revision,'publish','early'),/not_ready/);
  await assert.rejects(env.service.stageSource(owner,d.id,f.pages[1],d.revision,'out-of-order'),/page_sequence/);
  d=await env.service.stageSource(owner,d.id,f.pages[0],d.revision,'page0');assert.equal(d.status,'staging');
  const changed={...f.pages[1],chunks:[{...f.pages[1].chunks[0],text:'wrong bytes'}]};
  await assert.rejects(env.service.stageSource(owner,d.id,changed,d.revision,'bad-hash'),/parsed_hash/);
  d=await env.service.stageSource(owner,d.id,f.pages[1],d.revision,'page1');assert.equal(d.status,'ready');
  d=await env.service.publishRelease(owner,d.id,d.revision,'synthetic acceptance','publish');assert.equal(d.status,'published');
  assert.equal((await env.service.inspect(owner,d.id)).activeReleaseId,d.id);
  assert.equal(JSON.stringify([...env.repo.rows.values()]).includes(f.parsed.chunks[0].text),false);
});
test('atomic pointer and audit rollback retain old release on an interrupted publication',async()=>{
  const env=await setup(),f=fixture();let old=await ready(env,f,'old');old=await env.service.publishRelease(owner,old.id,old.revision,'old','old-publish');
  const candidate=await ready(env,f,'new');env.repo.fault=kind=>{if(kind==='audit')throw Error('synthetic interruption');};
  await assert.rejects(env.service.publishRelease(owner,candidate.id,candidate.revision,'switch','new-publish'),/synthetic interruption/);
  env.repo.fault=undefined;assert.equal((await env.service.inspect(owner,candidate.id)).activeReleaseId,old.id);
  assert.equal((await env.service.inspect(owner,candidate.id)).release.status,'ready');
});
test('concurrent same-key stages create one release, changed bytes conflict and duplicates do not append chunks',async()=>{
  const env=await setup(),f=fixture();const [a,b]=await Promise.all([env.service.stageRelease(owner,f.manifest,'same'),env.service.stageRelease(owner,f.manifest,'same')]);assert.equal(a.id,b.id);
  await assert.rejects(env.service.stageRelease(owner,{...f.manifest,sources:[{...f.manifest.sources[0],title:'changed'}]},'same'),/idempotency_conflict/);
  const r=await env.service.stageSource(owner,a.id,f.pages[0],a.revision,'page');
  assert.deepEqual(await env.service.stageSource(owner,a.id,f.pages[0],a.revision,'page'),r);
  await assert.rejects(env.service.stageSource(owner,a.id,f.pages[0],r.revision,'duplicate'),/page_sequence|immutable/);
});
test('fresh owner revision is checked before commit so revoked ownership never publishes',async()=>{
  const env=await setup(),f=fixture(),d=await ready(env,f);env.repo.beforeCommit=async()=>{env.changeOwner();};
  await assert.rejects(env.service.publishRelease(owner,d.id,d.revision,'publish','revoked-owner'),/owner_stale/);
});
test('revocation clears the active pointer and no idempotent old publish resurrects it',async()=>{
  const env=await setup();let d=await ready(env);const rev=d.revision;d=await env.service.publishRelease(owner,d.id,rev,'publish','p');
  d=await env.service.revokeRelease(owner,d.id,d.revision,'withdraw','r');assert.equal(d.status,'revoked');
  const old=await env.service.publishRelease(owner,d.id,rev,'publish','p');assert.equal(old.status,'revoked');
  assert.equal((await env.service.inspect(owner,d.id)).activeReleaseId,null);
});
test('ciphertext authenticates corpus/release/source/page and cannot cross kinds or keys',async()=>{
  const {c}=await modules();assert.throws(()=>c.createReferenceCrypto('short'),/configuration/);
  const crypto=c.createReferenceCrypto(stableKey),scope={corpusId:randomUUID(),kind:'chunk' as const,key:[randomUUID(),hash('source'),'00000']};
  const sealed=crypto.seal(scope,{text:'synthetic private snippet'});assert.deepEqual(crypto.open(scope,sealed),{text:'synthetic private snippet'});
  for(const changed of [{...scope,corpusId:randomUUID()},{...scope,kind:'source' as const},...scope.key.map((_,i)=>({...scope,key:scope.key.map((k,j)=>j===i?'different':k)}))])assert.throws(()=>crypto.open(changed,sealed),/authentication/);
});
test('candidate plus active raw input limit rejects new candidate without replacing the active release',async()=>{
  const env=await setup(),{m}=await modules(),service=new m.ReferencePublication(env.repo,{assertOwner:async()=>owner,current:async()=>{throw Error('unused');}},{maxInputBytes:1200});
  const f=fixture();let d=await service.stageRelease(owner,f.manifest,'small');d=await service.stageSource(owner,d.id,f.pages[0],d.revision,'small-p0');d=await service.publishRelease(owner,d.id,d.revision,'first','small-publish');
  const g=fixture(f.manifest.corpusId,10),next=await service.stageRelease(owner,g.manifest,'large');
  await assert.rejects(service.stageSource(owner,next.id,g.pages[0],next.revision,'large-p0'),/index_limit/);
  assert.equal((await service.inspect(owner,d.id)).activeReleaseId,d.id);
});
test('source page rejects unknown identity, inconsistent totals and broken physical coverage',async()=>{
  const env=await setup(),f=fixture(undefined,101);let d=await env.service.stageRelease(owner,f.manifest,'m');
  await assert.rejects(env.service.stageSource(owner,d.id,{...f.pages[0],sourceHash:hash('unknown')},d.revision,'unknown'),/source_unknown/);
  d=await env.service.stageSource(owner,d.id,f.pages[0],d.revision,'p0');
  await assert.rejects(env.service.stageSource(owner,d.id,{...f.pages[1],totalChunks:102,chunks:[f.pages[1].chunks[0],{...f.pages[1].chunks[0],order:101}]},d.revision,'total'),/source_total/);
  const g=fixture();g.parsed.chunks[0]!.locator.page=2;
  g.manifest.sources[0]!.parsedHash=parsedFixtureHash(g.parsed);
  const invalid=await env.service.stageRelease(owner,g.manifest,'coverage');
  await assert.rejects(env.service.stageSource(owner,invalid.id,g.pages[0],invalid.revision,'coverage-page'),/coverage_invalid/);
});
