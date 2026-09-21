import assert from 'node:assert/strict';
import test from 'node:test';
import { generateOperatingPaths, simulateOperatingPlans } from './decision-simulation-engine.js';

const baseline = {
  cashMinor: 10000, monthlyOrders: 10, backlogUnits: 0, capacityUnits: 10,
  priceMinor: 1000, unitCostMinor: 400, fixedCostMinor: 1000,
  collectionMonths: 1, receivables: [], payables: [],
};
const paths = [[
  { demand: 1, procurement: 1, collectionDelay: 0, delivery: 1 },
  { demand: 1, procurement: 1, collectionDelay: 0, delivery: 1 },
]];
const plans = [{ id: 'baseline', demandMultiplier: 1, capacityMultiplier: 1, priceMultiplier: 1, costMultiplier: 1, extraFixedCostMinor: 0 }];

test('delivered revenue accrues once; delayed receipts enter cash only on their due month', () => {
  const result = simulateOperatingPlans(baseline, plans, paths);
  assert.equal(result.length, 1);
  assert.deepEqual(result[0].samples[0].months.map(m => [m.revenueMinor, m.receiptsMinor, m.cashMinor, m.profitMinor, m.receivablesMinor]), [
    [10000, 0, 5000, 5000, 10000], [10000, 10000, 10000, 5000, 10000],
  ]);
  assert.equal(result[0].samples[0].minimumCashMinor, 5000);
});

test('changing plan execution order leaves each plan replay unchanged', () => {
  const alternative = { ...plans[0], id: 'capacity', capacityMultiplier: 2, extraFixedCostMinor: 1000 };
  const forward = simulateOperatingPlans(baseline, [...plans, alternative], paths);
  const reverse = simulateOperatingPlans(baseline, [alternative, ...plans], paths);
  assert.equal(forward.length, 2);
  assert.deepEqual(forward[0], reverse[1]);
  assert.deepEqual(forward[1], reverse[0]);
});

test('delivery constraint creates backlog, not fictitious revenue or collection', () => {
  const result = simulateOperatingPlans(baseline, plans, [[{ ...paths[0][0], delivery: 0.5 }]]);
  assert.equal(result.length, 1);
  assert.equal(result[0].samples[0].months[0].backlogUnits, 5);
  assert.equal(result[0].samples[0].months[0].revenueMinor, 5000);
  assert.equal(result[0].samples[0].months[0].receiptsMinor, 0);
});

test('opening receivables and payables settle once without entering current profit', () => {
  const result = simulateOperatingPlans({ ...baseline, monthlyOrders: 0, fixedCostMinor: 0, receivables: [{ dueMonth: 1, amountMinor: 3000 }], payables: [{ dueMonth: 1, amountMinor: 2000 }] }, plans, paths);
  assert.equal(result.length, 1);
  assert.deepEqual(result[0].samples[0].months.map(m => [m.cashMinor, m.profitMinor]), [[11000, 0], [11000, 0]]);
});

test('generated external paths replay exactly and are independent of requested sample count', () => {
  const assumptions = { demand: [0.8, 1.2], procurement: [0.9, 1.1], collectionDelay: [0, 2], delivery: [0.7, 1], persistence: 0.4, commonWeight: 0.2 };
  const options = { seed: 7, samples: 2, months: 3, assumptions };
  const generated = generateOperatingPaths(options);
  assert.equal(generated.length, 2);
  assert.equal(generated[0].length, 3);
  assert.deepEqual(generated, generateOperatingPaths(options));
  assert.deepEqual(generated[0], generateOperatingPaths({ ...options, samples: 1 })[0]);
  assert.notDeepEqual(generated, generateOperatingPaths({ ...options, seed: 8 }));
  for (const sample of generated) for (const month of sample) {
    assert.ok(month.demand >= 0.8 && month.demand <= 1.2);
    assert.ok(Number.isInteger(month.collectionDelay));
  }
});

test('invalid money and duplicate plan identity fail before producing results', () => {
  assert.throws(() => simulateOperatingPlans({ ...baseline, cashMinor: NaN }, plans, paths));
  assert.throws(() => simulateOperatingPlans(baseline, [plans[0], plans[0]], paths));
});

test('baseline, plan and shared shocks are not mutated by simulation', () => {
  const input = structuredClone({ baseline, plans, paths });
  simulateOperatingPlans(input.baseline, input.plans, input.paths);
  assert.deepEqual(input, { baseline, plans, paths });
});

test('excess cash outflow stays an explicit funding gap without injecting fictitious capital', () => {
  const result = simulateOperatingPlans({ ...baseline, cashMinor: 0 }, plans, paths);
  assert.equal(result[0].samples[0].minimumCashMinor, -5000);
  assert.equal(result[0].samples[0].fundingGapMinor, 5000);
});

test('invalid ranges, fractional lag and inconsistent horizons are rejected', () => {
  assert.throws(() => generateOperatingPaths({ seed: 7, samples: 1, months: 2, assumptions: { demand: [2, 1], procurement: [1, 1], delivery: [1, 1], collectionDelay: [0, 1], persistence: 0, commonWeight: 0 } }));
  assert.throws(() => simulateOperatingPlans(baseline, plans, [[{ ...paths[0][0], collectionDelay: 0.5 }]]));
  assert.throws(() => simulateOperatingPlans(baseline, plans, [...paths, [paths[0][0]]]));
});

test('selected events replace background once, persist provenance, and change actual deliveries',()=>{
  const options={seed:7,samples:2,months:3,assumptions:{demand:[1,1],procurement:[1,1],delivery:[.8,.8],collectionDelay:[0,0],persistence:0,commonWeight:0},events:[{template:'staffing_shortage',startMonth:1,durationMonths:2,value:.5,probability:1,assumption:'人工确认：人员缺勤影响产能，模拟假设'}]};
  const generated=generateOperatingPaths(options);
  assert.deepEqual(generated[0].map(month=>month.delivery),[.5,.5,.8]);
  assert.equal(generated[0][0].events![0].backgroundValue,.8);
  assert.equal(generated[0][2].events!.length,0);
  assert.deepEqual(generateOperatingPaths(options),generated);
  const result=simulateOperatingPlans(baseline,plans,generated);
  assert.equal(result[0].samples[0].months[0].delivered,5);
  assert.equal(result[0].samples[0].months[0].profitMinor,2000);
  assert.equal(result[0].samples[0].months[0].shock.events![0].template,'staffing_shortage');
});
test('conflicting same-factor events are rejected, zero-probability events do not change factors',()=>{
  const base={seed:7,samples:1,months:3,assumptions:{demand:[1,1],procurement:[1,1],delivery:[1,1],collectionDelay:[0,0],persistence:0,commonWeight:0}};
  const event={template:'sales_gain',startMonth:1,durationMonths:2,value:1.2,probability:0,assumption:'假设而非预测'};
  assert.equal(generateOperatingPaths({...base,events:[event]})[0][0].demand,1);
  assert.throws(()=>generateOperatingPaths({...base,events:[event,{...event,template:'sales_loss',value:.8}]}),/overlapping_operating_events/);
  assert.throws(()=>generateOperatingPaths({...base,events:[{...event,startMonth:3,durationMonths:2}]}));
});
