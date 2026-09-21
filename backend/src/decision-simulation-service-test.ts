import assert from 'node:assert/strict';
import test from 'node:test';
import { DecisionSimulationService, MemoryDecisionSimulationRepository } from './decision-simulation-service.js';
const scope = { workspaceId: 'workspace-one', actorId: 'actor-one' };
const request = { runId: '7707614e-521a-479e-9e3d-b8da6d76eab1', title: '隔离示例', dataKind: 'synthetic', assumptionNote: '假设区间，仅用于验收',
  baseline: { cashMinor: 10000, monthlyOrders: 10, backlogUnits: 0, capacityUnits: 10, priceMinor: 1000, unitCostMinor: 400, fixedCostMinor: 1000, collectionMonths: 1, receivables: [], payables: [] },
  alternatives: [], options: { seed: 7, samples: 2, months: 2, assumptions: { demand: [1, 1], procurement: [1, 1], collectionDelay: [0, 0], delivery: [1, 1], persistence: 0, commonWeight: 0 } } };

test('explicit generation persists immutable input, paths and report; get does not regenerate', async () => {
  const service = new DecisionSimulationService(new MemoryDecisionSimulationRepository());
  const saved = await service.create(scope, request);
  assert.ok(saved);
  assert.equal(saved.input.dataKind, 'synthetic');
  assert.equal(saved.paths.length, 2);
  assert.equal(saved.report.plans[0].sampleCount, 2);
  assert.ok(saved.report.recommendations?.length);
  assert.deepEqual(await service.get(scope, request.runId), saved);
  assert.deepEqual(await service.create(scope, request), saved);
  await assert.rejects(service.create(scope, { ...request, title: 'changed' }), /decision_simulation_conflict/);
});
test('records never cross either actor or workspace scope', async () => {
  const service = new DecisionSimulationService(new MemoryDecisionSimulationRepository());
  await service.create(scope, request);
  await assert.rejects(service.get({ ...scope, actorId: 'other' }, request.runId), /decision_simulation_not_found/);
  await assert.rejects(service.get({ ...scope, workspaceId: 'other' }, request.runId), /decision_simulation_not_found/);
  assert.deepEqual(await service.list({ ...scope, actorId: 'other' }), []);
  assert.equal((await service.list(scope)).length, 1);
});
test('rejects supplied tenant identity, oversized computation and unsupported versions before storage', async () => {
  const service = new DecisionSimulationService(new MemoryDecisionSimulationRepository());
  await assert.rejects(service.create(scope, { ...request, actorId: 'forged' }), /decision_simulation_input_invalid/);
  await assert.rejects(service.create(scope, { ...request, options: { ...request.options, samples: 1001 } }), /decision_simulation_input_invalid/);
  await assert.rejects(service.create({ ...scope, workspaceId: '' }, request), /workspace_required/);
  assert.deepEqual(await service.list(scope), []);
});
test('optional events persist through scoped read and use the same realized path in both plans',async()=>{
  const service=new DecisionSimulationService(new MemoryDecisionSimulationRepository());
  const event={template:'staffing_shortage',startMonth:1,durationMonths:1,value:.5,probability:1,assumption:'合成假设'};
  const input={...request,alternatives:[{id:'double',demandMultiplier:1,capacityMultiplier:2,priceMultiplier:1,costMultiplier:1,extraFixedCostMinor:0}],options:{...request.options,events:[event]}};
  const saved=await service.create(scope,input),reopened=await service.get(scope,request.runId);
  assert.equal(reopened.report.modelVersion,'operating-monthly-v2-events');
  assert.equal(reopened.report.replays[0].samples[0].months[0].delivered,5);
  assert.equal(reopened.report.replays[1].samples[0].months[0].delivered,10);
  assert.deepEqual(reopened.report.replays[0].samples[0].months[0].shock,reopened.report.replays[1].samples[0].months[0].shock);
  assert.deepEqual(reopened,saved);
  await assert.rejects(service.create(scope,{...input,options:{...input.options,events:[{...event,value:2}]}}),/input_invalid/);
});

test('confirmed preferences persist and assess cash floor without changing profit or paths',async()=>{
  const service=new DecisionSimulationService(new MemoryDecisionSimulationRepository());
  const plain=await service.create(scope,request);
  const preferred=await service.create(scope,{...request,runId:'8807614e-521a-479e-9e3d-b8da6d76eab1',decisionPreferences:{priority:'cash',cashFloorMinor:11000,pilotFirst:true,reviewCadence:'weekly',learningEnabled:false,confirmedFrom:'self_report'}});
  assert.deepEqual(preferred.paths,plain.paths);
  assert.deepEqual(preferred.report.replays,plain.report.replays);
  assert.equal(preferred.report.preferenceAssessment.plans[0].meetsCashFloor,false);
  assert.equal(preferred.report.preferenceAssessment.priority,'cash');
  assert.deepEqual(await service.get(scope,preferred.runId),preferred);
  await assert.rejects(service.create(scope,{...request,decisionPreferences:{priority:'MBTI'}}),/input_invalid/);
});

test('historical reads do not backfill advice or confirmed preferences',async()=>{
  const repository=new MemoryDecisionSimulationRepository(),service=new DecisionSimulationService(repository);
  const current=await service.create(scope,request);
  const {recommendations,...oldReport}=current.report;
  const old={...current,runId:'9907614e-521a-479e-9e3d-b8da6d76eab1',report:oldReport};
  await repository.insert(scope,old);
  const reopened=await service.get(scope,old.runId);
  assert.equal(reopened.report.recommendations,undefined);
  assert.equal(reopened.report.preferenceAssessment,undefined);
  assert.deepEqual(reopened,old);
});
