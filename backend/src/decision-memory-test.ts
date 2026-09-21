import assert from 'node:assert/strict';
import test from 'node:test';
import {DecisionMemoryService} from './decision-memory.js';
import {MemoryDecisionMemoryRepository} from './decision-memory-repository.js';
import {DecisionSimulationService,MemoryDecisionSimulationRepository} from './decision-simulation-service.js';

const scope={workspaceId:'team-one',actorId:'one'};
const preferences={priority:'cash',pilotFirst:true,reviewCadence:'weekly',learningEnabled:true,confirmedFrom:'self_report'};
const runId='7707614e-521a-479e-9e3d-b8da6d76eab1';
const input={runId,title:'isolated synthetic',dataKind:'synthetic',assumptionNote:'test',baseline:{cashMinor:10000,monthlyOrders:10,backlogUnits:0,capacityUnits:10,priceMinor:1000,unitCostMinor:400,fixedCostMinor:1000,collectionMonths:1,receivables:[],payables:[]},alternatives:[],options:{seed:7,samples:2,months:2,assumptions:{demand:[1,1],procurement:[1,1],collectionDelay:[0,0],delivery:[1,1],persistence:0,commonWeight:0}}};
async function fixture(){
  const reports=new DecisionSimulationService(new MemoryDecisionSimulationRepository());
  const report=await reports.create(scope,input);
  const repository=new MemoryDecisionMemoryRepository();
  return {reports,report,repository,service:new DecisionMemoryService(repository,reports)};
}
const plan={action:'test one purchase batch',metric:'unit cost',unit:'yuan/unit',baseline:100,target:80,dueDate:'2026-10-01',source:'signed quote'};
test('shared operating preference selection is explicit, current, enabled and rejects other domains',async()=>{
  const {service}=await fixture();
  assert.equal(typeof service.confirmed,'function');
  await service.saveProfile(scope,{expectedRevision:0,enabled:true,preferences});
  assert.equal((await service.confirmed(scope,{domain:'operating',revision:1})).priority,'cash');
  await assert.rejects(service.confirmed(scope,{domain:'acquisition',revision:1}),/input_invalid/);
  await assert.rejects(service.confirmed({...scope,actorId:'other'},{domain:'operating',revision:1}),/revision_conflict/);
  await service.saveProfile(scope,{expectedRevision:1,enabled:false,preferences});
  await assert.rejects(service.confirmed(scope,{domain:'operating',revision:1}),/revision_conflict/);
  await assert.rejects(service.confirmed(scope,{domain:'operating',revision:2}),/disabled/);
});
test('profile CAS survives deletion, isolation and reopening; report snapshots stay immutable',async()=>{
  const {service,repository,reports,report}=await fixture();
  assert.equal((await service.get(scope)).profile,null);
  const saved=await service.saveProfile(scope,{expectedRevision:0,enabled:true,preferences});
  assert.equal(saved.revision,1);
  assert.equal((await new DecisionMemoryService(repository,reports).get(scope)).profile?.preferences.priority,'cash');
  for(const other of [{...scope,actorId:'two'},{...scope,workspaceId:'two'}]){
    assert.equal((await service.export(other)).profile,null);
    assert.deepEqual((await service.export(other)).reviews,[]);
  }
  await assert.rejects(service.saveProfile(scope,{expectedRevision:0,enabled:true,preferences}),/revision_conflict/);
  const deleted=await service.deleteProfile(scope,{expectedRevision:1});
  assert.equal(deleted.profile,null);assert.equal(deleted.revision,2);
  await assert.rejects(service.saveProfile(scope,{expectedRevision:0,enabled:true,preferences}),/revision_conflict/);
  assert.deepEqual(await reports.get(scope,runId),report);
  await assert.rejects(service.saveProfile(scope,{expectedRevision:2,enabled:true,preferences,actorId:'forged'}),/input_invalid/);
});
test('manual review compares the stated metric, proposes only explicit opt-in feedback and adopts separately',async()=>{
  const {service,reports,report}=await fixture();
  await service.saveProfile(scope,{expectedRevision:0,enabled:true,preferences});
  const claimed=await service.saveReview(scope,{expectedRevision:1,runId,recommendationId:'procurement',plan});
  assert.equal(claimed.reviews[0].state,'planned');assert.equal(claimed.reviews[0].candidate,null);
  const result={actual:90,observedDate:'2026-09-20',source:'invoice sample',attribution:'mixed supplier and volume effects',feedbackPriority:'profit'};
  const reviewed=await service.saveReview(scope,{expectedRevision:2,runId,recommendationId:'procurement',plan,result});
  assert.deepEqual(reviewed.reviews[0].comparison,{actualMinusTarget:10,actualMinusBaseline:-10});
  assert.equal(reviewed.reviews[0].candidate,'profit');
  assert.equal(reviewed.profile?.preferences.priority,'cash');
  assert.equal(reviewed.reviews[0].sourceKind,'manual_observation');
  const adopted=await service.adopt(scope,{expectedRevision:3,runId,recommendationId:'procurement'});
  assert.equal(adopted.profile?.preferences.priority,'profit');
  assert.equal(adopted.profile?.preferences.confirmedFrom,'explicit_feedback');
  assert.equal(adopted.reviews[0].candidate,null);
  const corrected=await service.saveReview(scope,{expectedRevision:4,runId,recommendationId:'procurement',plan,result:{...result,attribution:'corrected observation'}});
  assert.equal(corrected.reviews[0].candidate,null,'editing an observation must not regenerate an already adopted candidate');
  assert.deepEqual(await reports.get(scope,runId),report);
  assert.equal((await service.export(scope)).reviews.length,1);
});
test('disabled/deleted learning rejects stale adoption and never generates a new candidate',async()=>{
  const {service}=await fixture();
  await service.saveProfile(scope,{expectedRevision:0,enabled:true,preferences});
  const review={runId,recommendationId:'procurement',plan,result:{actual:90,observedDate:'2026-09-20',source:'invoice',attribution:'uncertain',feedbackPriority:'profit'}};
  await service.saveReview(scope,{runId,recommendationId:'procurement',plan,expectedRevision:1});
  await service.saveReview(scope,{...review,expectedRevision:2});
  const off=await service.saveProfile(scope,{expectedRevision:3,enabled:false,preferences});
  assert.equal(off.reviews[0].candidate,null);
  await assert.rejects(service.adopt(scope,{expectedRevision:3,runId,recommendationId:'procurement'}),/revision_conflict/);
  await assert.rejects(service.adopt(scope,{expectedRevision:4,runId,recommendationId:'procurement'}),/learning_disabled/);
  const next=await service.saveReview(scope,{...review,expectedRevision:4});assert.equal(next.reviews[0].candidate,null);
  await service.deleteProfile(scope,{expectedRevision:5});
  const deleted=await service.saveReview(scope,{...review,expectedRevision:6});assert.equal(deleted.reviews[0].candidate,null);
  await assert.rejects(service.saveReview({...scope,actorId:'two'},{...review,expectedRevision:0}),/not_found/);
  await assert.rejects(service.saveReview(scope,{...review,expectedRevision:7,recommendationId:'invented'}),/recommendation_not_found/);
});
test('actual result requires a saved plan and cannot revise its target after seeing the outcome',async()=>{
  const {service}=await fixture();
  const result={actual:90,observedDate:'2026-09-20',source:'invoice',attribution:'uncertain'};
  await assert.rejects(service.saveReview(scope,{expectedRevision:0,runId,recommendationId:'procurement',plan,result}),/plan_required/);
  await service.saveReview(scope,{expectedRevision:0,runId,recommendationId:'procurement',plan});
  await assert.rejects(service.saveReview(scope,{expectedRevision:1,runId,recommendationId:'procurement',plan:{...plan,target:90},result}),/plan_locked/);
});
test('concurrent writes cannot both win; invalid metrics and forged timestamps are rejected',async()=>{
  const {service}=await fixture();
  const outcomes=await Promise.allSettled([service.saveProfile(scope,{expectedRevision:0,enabled:true,preferences}),service.saveProfile(scope,{expectedRevision:0,enabled:false,preferences})]);
  assert.equal(outcomes.filter(item=>item.status==='fulfilled').length,1);
  await assert.rejects(service.saveReview(scope,{expectedRevision:1,runId,recommendationId:'procurement',plan:{...plan,target:Infinity}}),/input_invalid/);
  await assert.rejects(service.saveReview(scope,{expectedRevision:1,runId,recommendationId:'procurement',plan,recordedAt:'forged'}),/input_invalid/);
});
