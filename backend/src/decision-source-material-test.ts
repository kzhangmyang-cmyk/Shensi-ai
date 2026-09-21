import assert from 'node:assert/strict';
import test from 'node:test';
import { workspace } from './financial-council-repository-contract-test.js';
import { inspectDecisionSources } from './decision-source-material.js';

const context = { ...workspace('decision-files'), capabilities: ['finance.council.run'] as const };
const csv = (fileName: string, text: string) => ({ fileName, mediaType: 'text/csv', contentBase64: Buffer.from(text).toString('base64') });

test('enterprise files retain separate original coordinates without requiring financial statements', async () => {
  const result = await inspectDecisionSources(context, { dataKind: 'synthetic', files: [
    csv('合成订单.csv', '项目,数量\n月订单,100'), csv('合成产能.csv', '项目,数量\n月产能,120')
  ] });
  assert.equal(result.dataKind, 'synthetic');
  assert.deepEqual(result.files.map(file => file.fileName), ['合成订单.csv', '合成产能.csv']);
  assert.equal(result.cells.find(cell => cell.sourceRef === 'file:1:cell:1:2:2')?.text, '100');
  assert.equal(result.cells.find(cell => cell.sourceRef === 'file:2:cell:1:2:2')?.text, '120');
  assert.equal(result.modelStatus, 'not_requested');
  assert.equal(result.observations.length, 0);
});

test('one invalid file fails the whole material set instead of silently analyzing a partial upload', async () => {
  await assert.rejects(inspectDecisionSources(context, { dataKind: 'synthetic', files: [
    csv('orders.csv', '订单,100'), { fileName: 'broken.pdf', mediaType: 'application/pdf', contentBase64: Buffer.from('not a pdf').toString('base64') }
  ] }));
});

test('source intake rejects actor injection, empty collections and noncanonical binary encoding', async () => {
  await assert.rejects(inspectDecisionSources(context, { dataKind: 'synthetic', files: [] }));
  await assert.rejects(inspectDecisionSources(context, { dataKind: 'synthetic', actorId: 'other', files: [csv('a.csv', 'a,b')] }));
  await assert.rejects(inspectDecisionSources(context, { dataKind: 'synthetic', files: [{ ...csv('a.csv', 'a,b'), contentBase64: '!!!aGVsbG8=' }] }));
});
