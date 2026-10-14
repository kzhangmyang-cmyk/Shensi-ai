import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import Ajv from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { projectGrowthBootstrapCapabilities } from '../growth-bootstrap-router.js';
import { capabilitiesForHumanRole } from '../growth-capabilities.js';
import { documentProjection, versionProjection, knowledgeUploadInputSchema } from './domain.js';
import { MemoryKnowledgeRepository } from './memory-repository.js';
import { knowledgeContext, validInput } from '../../test/knowledge-fixture.js';

async function validator(definition: string) {
  const ajv = new Ajv({ strict: false, allErrors: true }); addFormats(ajv);
  const schema = JSON.parse(await readFile(new URL('../../../contracts/json-schema/knowledge.v1.schema.json', import.meta.url), 'utf8'));
  ajv.addSchema(JSON.parse(await readFile(new URL('../../../contracts/json-schema/system-reference.v1.schema.json', import.meta.url), 'utf8')));
  ajv.addSchema(schema); return ajv.compile({ $ref: `${schema.$id}#/$defs/${definition}` });
}
test('knowledge generated input contract rejects the same ownership, format and byte breaks as runtime', async () => {
  const validate = await validator('UploadInput');
  for (const [input, expected] of [[validInput, true], [{ ...validInput, filename: '../secret' }, false],
    [{ ...validInput, bytes: 52428801 }, false], [{ ...validInput, filename: '.' }, false], [{ ...validInput, filename: '..' }, false],
    [{ ...validInput, roles: ['cfo', 'cfo'] }, false], [{ ...validInput, owner: 'forged' }, false], [{ ...validInput, format: 'epub' }, false]] as const) {
    assert.equal(validate(input), expected, JSON.stringify(input));
    assert.equal(knowledgeUploadInputSchema.safeParse(input).success, expected, JSON.stringify(input));
  }
});
test('knowledge public records conform to closed DTOs without internal ownership and storage', async () => {
  const repo = new MemoryKnowledgeRepository();
  const result = await repo.createDocument(knowledgeContext(), validInput, 'create');
  for (const [definition, value] of [['Document', documentProjection(result.document)], ['Version', versionProjection(result.version)]] as const) {
    const validate = await validator(definition);
    assert.equal(validate(value), true, JSON.stringify(validate.errors));
    assert.equal(validate({ ...value, storageKey: 'private' }), false);
    assert.equal(validate({ ...value, actorId: 'private' }), false);
  }
});
test('optional knowledge projection preserves legacy CFO and voice payloads and bounded citations', async () => {
  const ajv = new Ajv({ strict: false }); addFormats(ajv);
  for (const name of ['knowledge', 'system-reference', 'finance-document', 'cfo-conversation', 'cfo-session']) {
    ajv.addSchema(JSON.parse(await readFile(new URL(`../../../contracts/json-schema/${name}.v1.schema.json`, import.meta.url), 'utf8')));
  }
  const input = ajv.compile({ $ref: 'https://schemas.goodjob.ai/cfo-conversation.v1.schema.json#/$defs/Input' });
  assert.equal(input({ question: '如何改善预算？', history: [] }), true);
  assert.equal(input({ question: '如何改善预算？', history: [], knowledgeMode: 'auto' }), true);
  assert.equal(input({ question: '如何改善预算？', history: [], knowledgeMode: 'always' }), false);
  const answer = await validator('Answer');
  assert.equal(answer({ status: 'no_match', detailedText: '', sources: [], warnings: [] }), true);
  assert.equal(answer({ status: 'used', detailedText: 'x'.repeat(12001), sources: [], warnings: [] }), false);
  const reply = ajv.compile({ $ref: 'https://schemas.goodjob.ai/cfo-conversation.v1.schema.json' });
  const legacy = { answer: '先分析已有经营数据。', provider: 'fixture', model: 'fixture', material: null, answeredAt: '2026-10-06T00:00:00Z' };
  assert.equal(reply(legacy), true);
  assert.equal(reply({ ...legacy, knowledge: { status: 'no_match', detailedText: '', sources: [], warnings: [] } }), true);
  assert.equal(reply({ ...legacy, answer: 'x'.repeat(4001) }), false);
});

test('real granted knowledge capabilities remain consumable through the bootstrap contract', async () => {
  const ajv = new Ajv({ strict: false }); addFormats(ajv);
  const schema = JSON.parse(await readFile(new URL('../../../contracts/json-schema/growth-bootstrap.v1.schema.json', import.meta.url), 'utf8'));
  ajv.addSchema(schema);
  const validate = ajv.compile({ $ref: `${schema.$id}#/$defs/contractFields/properties/capabilities` });
  for (const role of ['sales', 'manager', 'admin', 'super_admin'] as const) {
    const publicCaps = projectGrowthBootstrapCapabilities(capabilitiesForHumanRole(role));
    assert.equal(validate(publicCaps), true, JSON.stringify(validate.errors));
    assert.equal(publicCaps.includes('acquisition.outcome.reconcile.internal' as any), false);
  }
});
