import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeDecisionSources } from './decision-five-agents.js';
import { inspectFinanceDocument } from './finance-document-inspection.js';
import { workspace } from './financial-council-repository-contract-test.js';

const source = inspectFinanceDocument({ content: Buffer.from('项目,值\n月订单,100'), mediaType: 'text/csv' });
const context = workspace('decision-agents');
test('five distinct roles retain real model attribution and judge receives earlier sourced summaries', async () => {
  const updates: string[] = [];
  const result = await analyzeDecisionSources({ context, inspection: source, consent: true,
    model: async input => {
      if (input.operatingRole === 'judge') assert.ok(input.history?.some(item => item.text.includes('founder')));
      return { inspection: { ...input.inspection, modelStatus: 'completed', observations: [{ text: `${input.operatingRole}: 资料中的月订单100`, sourceRefs: ['cell:1:2:2'] }] }, provider: 'test-provider', model: 'test-model' };
    }, onUpdate: records => updates.push(records.map(record => record.state).join(',')) });
  assert.deepEqual(result.map(record => record.role), ['founder', 'market', 'operations', 'finance', 'judge']);
  assert.ok(result.every(record => record.state === 'completed' && record.provider === 'test-provider'));
  assert.ok(updates.includes('running,queued,queued,queued,queued'));
  assert.deepEqual(result[4].observations[0].sourceRefs, ['cell:1:2:2']);
});
test('unavailable or empty model output cannot become successful AI analysis', async () => {
  const result = await analyzeDecisionSources({ context, inspection: source, consent: true,
    model: async input => ({ inspection: { ...input.inspection, modelStatus: input.operatingRole === 'market' ? 'unavailable' : 'completed', observations: [] }, provider: 'test-provider', model: 'test-model' }) });
  assert.equal(result[1].state, 'failed');
  assert.equal(result[0].state, 'insufficient');
  assert.ok(result.every(record => record.observations.length === 0));
});
test('without explicit model consent no role is executed', async () => {
  await assert.rejects(analyzeDecisionSources({ context, inspection: source, consent: false,
    model: async () => { assert.fail('no model traffic before consent'); } }), /consent_required/);
});
