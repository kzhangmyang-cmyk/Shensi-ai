import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
// A missing new module is an explicit RED assertion, not a skipped test.
const topics = await import('./topics.js').catch(error => {
  if (error.code === 'ERR_MODULE_NOT_FOUND') return undefined;
  throw error;
});
const domain = await import('./domain.js').catch(error => {
  if (error.code === 'ERR_MODULE_NOT_FOUND') return undefined;
  throw error;
});
const id = '11111111-1111-4111-8111-111111111111';
const privateSource = { sourceId: 'K1', documentId: id, versionId: id, chunkId: id, sourceHash: 'a'.repeat(64), sourceLabel: 'Synthetic source', locator: { page: 1 }, excerpt: '仅合成文本', warnings: [] };
const systemSource = { sourceType: 'system', sourceId: 'K1', referenceKey: `system:${id}:${id}`, queryGrantId: id, referenceId: id, corpusId: id, releaseId: id, sourceHash: 'a'.repeat(64), chunkHash: 'b'.repeat(64), excerptRange: { start: 0, end: 5 }, sourceLabel: 'Synthetic system source', locator: { page: 1 }, excerpt: '仅合成文本', warnings: [] };

test('fixed topics project only IDs, never private query content', () => {
  assert.ok(topics, 'topic projection is implemented');
  assert.deepEqual(topics.projectReferenceTopics('甲公司预算偏差987万元，密码secret'), ['budget_variance']);
  assert.deepEqual(topics.projectReferenceTopics('你好，今天怎么样'), []);
  assert.deepEqual(topics.projectReferenceTopics('预算偏差 预算编制 成本动因 成本结构'), ['budget_variance', 'budget_planning', 'cost_driver']);
  assert.deepEqual(topics.projectReferenceTopics('预算偏差 预算偏差 成本动因 成本动因分析'), ['cost_driver', 'budget_variance']);
  assert.deepEqual(topics.projectReferenceTopics('ｂｕｄｇｅｔ ｖａｒｉａｎｃｅ'), ['budget_variance']);
});
test('explicit topics replace automatic matches and reject duplicates, unknown values and overflow', () => {
  assert.ok(topics);
  assert.deepEqual(topics.projectReferenceTopics('预算偏差', ['cashflow_forecast']), ['cashflow_forecast']);
  assert.deepEqual(topics.projectReferenceTopics('预算偏差', []), []);
  for (const selected of [['secret'], ['cost_driver', 'cost_driver'], ['budget_variance', 'budget_planning', 'cost_driver', 'cost_structure']]) {
    assert.throws(() => topics.projectReferenceTopics('预算偏差', selected as never));
  }
});
test('query schema is closed, bounded and cannot carry raw company inputs', () => {
  assert.ok(domain);
  const value = { vocabularyVersion: 'finance-topics.v1', topicIds: ['budget_variance'], role: 'finance', requestId: id };
  assert.equal(domain.systemReferenceQuerySchema.safeParse(value).success, true);
  for (const key of ['question', 'history', 'company', 'documentId', 'text', 'url', 'actorId', 'workspaceId']) {
    assert.equal(domain.systemReferenceQuerySchema.safeParse({ ...value, [key]: '私密' }).success, false, key);
  }
  for (const patch of [{ vocabularyVersion: 'unknown' }, { topicIds: [] }, { topicIds: ['unknown'] }, { topicIds: ['cost_driver', 'cost_driver'] }, { role: 'admin' }, { requestId: 'not-uuid' }]) {
    assert.equal(domain.systemReferenceQuerySchema.safeParse({ ...value, ...patch }).success, false);
  }
});
test('source decoder preserves legacy private and rejects cross-library masquerading', () => {
  assert.ok(domain);
  assert.deepEqual(domain.referenceCitationSchema.parse(privateSource), privateSource);
  assert.equal(domain.referenceCitationSchema.safeParse({ ...privateSource, sourceType: 'private' }).success, true);
  assert.equal(domain.referenceCitationSchema.safeParse(systemSource).success, true);
  assert.equal(domain.privateReferenceSchema.safeParse(systemSource).success, false);
  assert.equal(domain.referenceCitationSchema.safeParse({ ...privateSource, sourceType: 'system' }).success, false);
  assert.equal(domain.referenceCitationSchema.safeParse({ ...systemSource, documentId: id }).success, false);
  const { sourceType: _type, ...untypedSystem } = systemSource;
  assert.equal(domain.referenceCitationSchema.safeParse(untypedSystem).success, false);
});
test('system references validate immutable key, UTF-16 range and bounded content', () => {
  assert.ok(domain);
  for (const patch of [{ referenceKey: `private:${id}` }, { referenceId: '22222222-2222-4222-8222-222222222222' }, { excerptRange: { start: 4, end: 2 } }, { excerptRange: { start: 0, end: 4 } }, { excerpt: 'x'.repeat(4001), excerptRange: { start: 0, end: 4001 } }, { excerpt: '\ud800', excerptRange: { start: 0, end: 1 } }, { excerpt: '\udc00', excerptRange: { start: 0, end: 1 } }]) {
    assert.equal(domain.systemReferenceSchema.safeParse({ ...systemSource, ...patch }).success, false);
  }
  assert.equal(domain.systemReferenceSchema.safeParse({ ...systemSource, excerpt: '😀', excerptRange: { start: 2, end: 4 } }).success, true);
});
test('topic catalog and public schema have exactly the same version and IDs', async () => {
  assert.ok(topics); assert.ok(domain);
  const schema = JSON.parse(await readFile(new URL('../../../contracts/json-schema/system-reference.v1.schema.json', import.meta.url), 'utf8'));
  assert.equal(schema.$defs.ReferenceQuery.properties.vocabularyVersion.const, topics.REFERENCE_VOCABULARY_VERSION);
  assert.deepEqual(schema.$defs.ReferenceTopicId.enum, topics.REFERENCE_TOPIC_IDS);
  for (const topic of topics.REFERENCE_TOPICS) assert.deepEqual(topics.projectReferenceTopics(topic.label), [topic.id]);
});
