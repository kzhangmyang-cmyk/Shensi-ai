import assert from 'node:assert/strict';
import test from 'node:test';
import {ReferencePublication} from './publication.js';
import {TestReferenceRepository} from './publication-test-support.js';
import {createReferenceCrypto} from './crypto.js';
import {syntheticOwner as owner,syntheticReferenceKey,fixture} from './publication-fixture.js';
async function module(){const m=await import('./index-budget.js').catch((e:NodeJS.ErrnoException)=>{if(e.code==='ERR_MODULE_NOT_FOUND')return null;throw e;});assert.ok(m,'shared index input reservation is required');return m;}
test('index input reservations bound concurrent corpora and failed construction releases its capacity',async()=>{
  const {ReferenceIndexBudget}=await module();const budget=new ReferenceIndexBudget(500);
  const release=budget.reserve(400);assert.throws(()=>budget.reserve(101),/index_limit/);
  release();release();const releaseAgain=budget.reserve(500);releaseAgain();
  const repo=new TestReferenceRepository(createReferenceCrypto(syntheticReferenceKey));
  const service=new ReferencePublication(repo,{assertOwner:async()=>owner,current:async()=>{throw Error('unused');}},{indexBudget:budget});
  const f=fixture();const d=await service.stageRelease(owner,f.manifest,'m');
  const occupied=budget.reserve(500);
  await assert.rejects(service.stageSource(owner,d.id,f.pages[0],d.revision,'p'),/index_limit/);
  occupied();assert.equal((await service.stageSource(owner,d.id,f.pages[0],d.revision,'p')).status,'ready');
  const wrong=fixture();wrong.pages[0]!.chunks[0]!.text='synthetic changed bytes';
  const draft=await service.stageRelease(owner,wrong.manifest,'bad');
  await assert.rejects(service.stageSource(owner,draft.id,wrong.pages[0],draft.revision,'bad-p'),/parsed_hash/);
  const recovered=budget.reserve(500);recovered();
});
