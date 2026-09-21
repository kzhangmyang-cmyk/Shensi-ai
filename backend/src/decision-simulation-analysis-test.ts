import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeOperatingPlans } from './decision-simulation-analysis.js';

const baseline = { cashMinor: 10000, monthlyOrders: 10, backlogUnits: 0, capacityUnits: 20, priceMinor: 1000, unitCostMinor: 400, fixedCostMinor: 1000, collectionMonths: 0, receivables: [], payables: [] };
const alternative = { id: 'expand', demandMultiplier: 2, capacityMultiplier: 2, priceMultiplier: 1, costMultiplier: 1, extraFixedCostMinor: 2000 };
const paths = [[{ demand: 1, procurement: 1, collectionDelay: 0, delivery: 1 }]];

test('analysis always includes unchanged baseline and paired differences', () => {
  const result = analyzeOperatingPlans(baseline, [alternative], paths);
  assert.ok(result);
  assert.equal(result.plans[0].planId, 'baseline');
  assert.deepEqual(result.plans[0].profitRangeMinor, [5000, 5000]);
  assert.deepEqual(result.plans[1].profitRangeMinor, [9000, 9000]);
  assert.deepEqual(result.plans[1].pairedProfitDifferenceMinor, [4000]);
});

test('cost perturbation measures actual profit changes, collection lag changes cash not profit', () => {
  const result = analyzeOperatingPlans(baseline, [], paths);
  assert.ok(result);
  const cost = result.sensitivity.find(item => item.factor === 'procurement' && item.direction === 'up');
  assert.deepEqual(cost.plans[0].profitRangeMinor, [4600, 4600]);
  const lag = result.sensitivity.find(item => item.factor === 'collectionDelay' && item.direction === 'up');
  assert.deepEqual(lag.plans[0].profitRangeMinor, [5000, 5000]);
  assert.equal(lag.plans[0].worstMinimumCashMinor, 5000);
});

test('conditional break-even units reports insufficient capacity rather than an impossible recommendation', () => {
  const result = analyzeOperatingPlans({ ...baseline, fixedCostMinor: 13000 }, [], paths);
  assert.ok(result);
  assert.equal(result.threshold.unitsForMonthlyOperatingBreakEven, 22);
  assert.equal(result.threshold.withinBaselineCapacity, false);
});

test('nonpositive contribution produces no finite break-even demand', () => {
  const result = analyzeOperatingPlans({ ...baseline, unitCostMinor: 1000 }, [], paths);
  assert.ok(result);
  assert.equal(result.threshold.unitsForMonthlyOperatingBreakEven, null);
});

test('zero fixed cost and zero contribution are already at operating break-even', () => {
  const result = analyzeOperatingPlans({ ...baseline, unitCostMinor: 1000, fixedCostMinor: 0 }, [], paths);
  assert.equal(result.threshold.unitsForMonthlyOperatingBreakEven, 0);
});

test('operating recommendations attach computed evidence and conditional scenarios, never invented ROI',()=>{
  const result=analyzeOperatingPlans({...baseline,capacityUnits:5,collectionMonths:2},[],paths);
  const procurement=result.recommendations.find(item=>item.id==='procurement');
  assert.ok(procurement);assert.equal(procurement.evidenceKind,'simulation_signal');
  assert.deepEqual(procurement.scenarioComparison.baselineProfitRangeMinor,[2000,2000]);
  assert.deepEqual(procurement.scenarioComparison.changedProfitRangeMinor,[2200,2200]);
  assert.match(procurement.costAndPrerequisites,/质量|质量标准/);
  assert.ok(result.recommendations.some(item=>item.id==='delivery'));
  assert.ok(result.recommendations.some(item=>item.id==='collections'));
  for(const item of result.recommendations){
    assert.ok(item.evidenceRefs.length);assert.ok(item.action);assert.ok(item.mechanism);assert.ok(item.costAndPrerequisites);assert.ok(item.ownerRole);assert.ok(item.timeframe);assert.ok(item.reviewMetric);
    assert.equal('roi' in item,false);assert.equal('guaranteedSavingsMinor' in item,false);
  }
});

test('recommendations do not invent procurement or capacity problems when there is no demand or cost',()=>{
  const result=analyzeOperatingPlans({...baseline,monthlyOrders:0,unitCostMinor:0,fixedCostMinor:0},[],paths);
  assert.equal(result.recommendations.some(item=>item.id==='procurement'||item.id==='delivery'),false);
  assert.ok(result.recommendations.some(item=>item.id==='demand_validation'));
});
