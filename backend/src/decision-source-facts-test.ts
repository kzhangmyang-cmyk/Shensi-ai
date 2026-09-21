import assert from 'node:assert/strict';
import test from 'node:test';
import { proposeDecisionFacts } from './decision-source-facts.js';
import { inspectFinanceDocument } from './finance-document-inspection.js';
test('only unambiguous explicit units produce baseline candidates; missing values remain missing', () => {
  const source = inspectFinanceDocument({content: Buffer.from('项目,值,单位\n期初现金,60000,元\n月订单,100,件\n销售单价,100,\n月产能,120,件'),mediaType:'text/csv'});
  const facts = proposeDecisionFacts(source.cells);
  assert.equal(facts.find(fact=>fact.field==='cashMinor')?.candidates[0].value,6000000);
  assert.equal(facts.find(fact=>fact.field==='monthlyOrders')?.candidates[0].value,100);
  assert.equal(facts.find(fact=>fact.field==='priceMinor')?.status,'missing');
  assert.equal(facts.find(fact=>fact.field==='collectionMonths')?.status,'missing');
});
test('conflicting source rows stay visible instead of choosing the last value', () => {
  const source = inspectFinanceDocument({content: Buffer.from('项目,值,单位\n月订单,100,件\n月订单,200,件'),mediaType:'text/csv'});
  const fact=proposeDecisionFacts(source.cells).find(item=>item.field==='monthlyOrders')!;
  assert.equal(fact.status,'conflict');
  assert.deepEqual(fact.candidates.map(item=>item.value),[100,200]);
  assert.deepEqual(fact.candidates[0].sourceRefs,['cell:1:2:1','cell:1:2:2','cell:1:2:3']);
});
