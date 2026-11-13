import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { MemoryKnowledgeRepository } from '../knowledge/memory-repository.js';
import { KnowledgeRetriever } from '../knowledge/retrieval.js';
import type { KnowledgeEvidence } from '../knowledge/domain.js';
import { knowledgeContext, validInput } from '../../test/knowledge-fixture.js';
import { retrievalEnvironment, retrievalFixture } from './retrieval-test-support.js';
import { SystemReferenceService } from './retrieval.js';
import { ReferenceConnectionService } from './connection-service.js';
import { ReferenceAccessError } from './authority.js';
import { syntheticOwner } from './publication-fixture.js';
import type { ReferenceClient } from './client.js';
import { ReferenceTransport } from './client.js';
import type { ReferenceQuery, ConnectionStatus } from './domain.js';
import { buildKnowledgeModelEvidence, renderKnowledgeAnswer, knowledgeAnswerSchema } from '../knowledge/answer.js';

const question = '预算执行偏差分析';
const input = { question, role: 'finance' as const, knowledgeMode: 'auto' as const, referenceProtocol: 'system-v1' as const };
const privateTexts = Array.from({ length: 6 }, (_, n) => `预算执行偏差分析 私人方法${n} 应核对实际经营资料。`);
async function setup(texts = privateTexts) {
  const ctx = knowledgeContext(), repo = new MemoryKnowledgeRepository();
  const created = await repo.createDocument(ctx, { ...validInput, title: '合成私人资料', roles: ['finance'] }, randomUUID());
  await repo.completeUpload(ctx, created.version.id, { bytes: 120, storageKey: randomUUID(), sourceHash: 'a'.repeat(64) }, 1, randomUUID());
  const claim = (await repo.claimJob(randomUUID(), Date.now(), 60000))!;
  const parsed = await repo.commitParsed(ctx, claim, { parserVersion: 'fixture.v1', coverage: { totalPages: 1, extractedPages: 1, missingPages: [] }, warnings: ['private_quality'],
    chunks: texts.map((text, order) => ({ text, order, locator: { page: 1 }, warnings: ['table_unverified'] })) });
  await repo.publishReady(ctx, claim, parsed.revision);
  const privateRetriever = new KnowledgeRetriever(repo);
  let original: KnowledgeEvidence | undefined, privateCalls = 0;
  const privatePort = { retrieve: async (...args: Parameters<KnowledgeRetriever['retrieve']>) => { privateCalls++; original = await privateRetriever.retrieve(...args); return original; },
    assertCurrent: privateRetriever.assertCurrent.bind(privateRetriever) };
  const central = await retrievalEnvironment(), fixture = retrievalFixture(undefined, 6, 40, 300), release = await central.publish(fixture), binding = await central.connect();
  const service = new SystemReferenceService(central.repo, { corpusId: fixture.manifest.corpusId, now: central.now });
  const requests: ReferenceQuery[] = [];
  const remote: ReferenceClient = {
    query: async (value, signal) => { requests.push(structuredClone(value)); return service.query(binding.context, value, signal); },
    assertCurrent: async (grant, signal) => { await service.check(binding.context, grant, signal); },
    citation: (grant, ref, signal) => service.citation(binding.context, grant, ref, signal)
  };
  const connections = new ReferenceConnectionService({ mode: 'central', current: async value => ({ actorId: value.actorId, workspaceId: value.workspaceId, authVersion: 1 }), central: async () => remote });
  const removePrivate = async () => { const d = (await repo.getDocument(ctx, created.document.id))!; await repo.mutateDocument(ctx, d.id, { deleted: true }, d.revision, randomUUID()); };
  return { ctx, repo, privatePort, privateRetriever, original: () => original, privateCalls: () => privateCalls, connections, requests, remote,
    fixture, release, central, binding, removePrivate };
}
async function implementation() {
  const module = await import('./composite-retrieval.js').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ERR_MODULE_NOT_FOUND') return {} as typeof import('./composite-retrieval.js'); throw error;
  });
  assert.equal(typeof module.CompositeReferenceRetriever, 'function', 'composite preparation must exist');
  return module.CompositeReferenceRetriever;
}
async function prepared(e: Awaited<ReturnType<typeof setup>>) {
  const Composite = await implementation(); return new Composite({ private: e.privatePort, connections: e.connections }).prepare(e.ctx, input);
}

// Break caught: enabling retrieval by default or forwarding unrelated input into the central query.
for (const knowledgeMode of [undefined, 'off'] as const) test(`knowledge ${knowledgeMode ?? 'omitted'} makes zero calls to either library`, async () => {
  const Composite = await implementation(); let calls = 0;
  const denied = async (): Promise<never> => { calls++; throw Error('must not run'); };
  const result = await new Composite({ private: { retrieve: denied, assertCurrent: denied }, connections: { status: denied, clientFor: denied } })
    .prepare(knowledgeContext(), { ...input, knowledgeMode });
  assert.deepEqual(result.evidence, { status: 'no_match', sources: [] });
  assert.deepEqual(result.libraryStatus, { private: 'off', system: 'off' }); await result.assertCurrent(); assert.equal(calls, 0);
});
test('no protocol keeps old private results and makes zero central calls', async () => {
  const Composite = await implementation(), e = await setup(); let calls = 0;
  const denied = async (): Promise<never> => { calls++; throw Error('must not run'); };
  const result = await new Composite({ private: e.privatePort, connections: { status: denied, clientFor: denied } }).prepare(e.ctx, { ...input, referenceProtocol: undefined });
  assert.equal(result.evidence.status, 'used'); assert.equal(result.evidence.sources.length, 6);
  assert.deepEqual(result.evidence.sources, e.original()!.sources); assert.equal(result.libraryStatus.system, 'off');
  await result.assertCurrent(); assert.equal(calls, 0);
});
test('public search off and private question fields cannot cross the fixed central boundary', async () => {
  const Composite = await implementation(), e = await setup();
  assert.equal((await e.connections.status(e.ctx)).status, 'session_ready');
  const result = await new Composite({ private: e.privatePort, connections: e.connections }).prepare(e.ctx, {
    ...input, question: '张三公司的预算执行偏差涉及987654元，请核对', webSearchMode: 'off', history: [{ text: '私人历史' }], privateExcerpt: '秘密', documentId: randomUUID()
  } as typeof input);
  assert.equal(result.libraryStatus.system, 'ready'); assert.equal(e.requests.length, 1);
  const body = e.requests[0]; assert.deepEqual(Object.keys(body).sort(), ['requestId', 'role', 'topicIds', 'vocabularyVersion']);
  assert.equal(body.role, 'finance'); assert.equal(body.vocabularyVersion, 'finance-topics.v1'); assert.deepEqual(body.topicIds, ['budget_variance']);
  assert.match(body.requestId, /^[0-9a-f-]{36}$/u); assert.doesNotMatch(JSON.stringify(body), /张三|987654|秘密|历史/u);
  await result.assertCurrent();
  assert.equal(e.requests.length, 1);
});
for (const selection of [undefined, []] as const) test(`no local topics (${selection ? 'explicit empty' : 'unmatched'}) issues no central query`, async () => {
  const Composite = await implementation(), e = await setup();
  const result = await new Composite({ private: e.privatePort, connections: e.connections }).prepare(e.ctx, { ...input, question: '问候语', referenceTopicIds: selection ? [] : undefined });
  assert.equal(result.libraryStatus.system, 'no_match'); assert.equal(e.requests.length, 0);
});
test('explicit topics replace local projection; topics without protocol fail before retrieval', async () => {
  const Composite = await implementation(), e = await setup(), retriever = new Composite({ private: e.privatePort, connections: e.connections });
  await assert.rejects(retriever.prepare(e.ctx, { ...input, referenceProtocol: undefined, referenceTopicIds: ['budget_variance'] }));
  assert.equal(e.privateCalls(), 0); assert.equal(e.requests.length, 0);
  await retriever.prepare(e.ctx, { ...input, question: '张三987654元', referenceTopicIds: ['budget_variance'] });
  assert.deepEqual(e.requests[0].topicIds, ['budget_variance']);
});

test('two six-candidate libraries alternate private first, preserve rank and release only six total', async () => {
  const e = await setup(), result = await prepared(e), sources = result.evidence.sources;
  assert.equal(sources.length, 6); assert.deepEqual(sources.map(s => s.sourceId), ['K1', 'K2', 'K3', 'K4', 'K5', 'K6']);
  assert.deepEqual(sources.map(s => s.sourceType ?? 'private'), ['private', 'system', 'private', 'system', 'private', 'system']);
  assert.deepEqual(sources.filter(s => s.sourceType !== 'system').map(s => s.excerpt), e.original()!.sources.slice(0, 3).map(s => s.excerpt));
  assert.deepEqual(sources.filter(s => s.sourceType === 'system').map(s => s.excerpt), e.fixture.parsed.chunks.slice(0, 3).map(s => s.text));
  assert.deepEqual(e.original()!.sources.map(s => s.sourceId), ['K1', 'K2', 'K3', 'K4', 'K5', 'K6']);
  await e.privateRetriever.assertCurrent(e.ctx, { role: 'finance', evidence: e.original()! }); await result.assertCurrent();
});
test('normalized duplicate excerpts are emitted once without rewriting their original text', async () => {
  const e = await setup(['预算执行偏差分析步骤 ０\n' + '树'.repeat(27)]);
  const result = await prepared(e), texts = result.evidence.sources.map(s => s.excerpt);
  const normalized = texts.map(s => s.normalize('NFKC').replace(/\s+/gu, ' ').trim());
  assert.equal(new Set(normalized).size, normalized.length);
  assert.equal(texts[0], '预算执行偏差分析步骤 ０\n' + '树'.repeat(27));
  assert.ok(!texts.includes(e.fixture.parsed.chunks[0].text));
});
test('total budget skips an over-budget whole candidate, keeps later smaller ones and never truncates', async () => {
  const texts = Array.from({ length: 3 }, (_, n) => (`预算执行偏差 私人${n} `).padEnd(4000, '甲'));
  const e = await setup(texts), result = await prepared(e), sources = result.evidence.sources;
  assert.equal(sources.length, 6); assert.equal(sources.filter(s => s.sourceType !== 'system').length, 2);
  assert.equal(sources.filter(s => s.sourceType === 'system').length, 4);
  assert.equal(sources.reduce((n, s) => n + s.excerpt.length, 0), 8160);
  for (const s of sources) assert.ok(s.sourceType === 'system' ? e.fixture.parsed.chunks.some(c => c.text === s.excerpt) : texts.includes(s.excerpt));
});
for (const [status, want] of [[401, 'auth_required'], [403, 'forbidden'], [429, 'rate_limited'], [503, 'unavailable']] as const) test(`private used preserves independent system ${want} status`, async () => {
  const e = await setup(); e.remote.query = async () => { throw new ReferenceAccessError(status, 'reference_unavailable'); };
  const result = await prepared(e); assert.equal(result.evidence.status, 'used');
  assert.deepEqual(result.libraryStatus, { private: 'used', system: want }); await result.assertCurrent();
});
for (const [status, want] of [['unconfigured', 'unconfigured'], ['unbound', 'unbound'], ['pending', 'unbound'], ['unconfirmed', 'unavailable']] as const) test(`non-ready ${status} never sends central query`, async () => {
  const Composite = await implementation(), e = await setup(); let queries = 0;
  const result = await new Composite({ private: e.privatePort, connections: { status: async (): Promise<ConnectionStatus> => ({ status, generation: 1 }), clientFor: async () => { queries++; return e.remote; } } }).prepare(e.ctx, input);
  assert.equal(result.libraryStatus.system, want); assert.equal(queries, 0);
});

// Break caught: replacing original WeakMap evidence, losing either revocation proof or trusting a changed merged object.
for (const change of ['excerpt', 'identity', 'status', 'replace', 'scope'] as const) test(`merged ${change} mutation invalidates release`, async () => {
  const e = await setup(), result = await prepared(e);
  if (change === 'excerpt') result.evidence.sources[0].excerpt = '篡改';
  if (change === 'identity') result.evidence.sources[1].sourceId = 'K6';
  if (change === 'status') result.libraryStatus.system = 'unavailable';
  if (change === 'replace') result.evidence = structuredClone(result.evidence);
  if (change === 'scope') e.ctx.actorId = 'another-actor';
  await assert.rejects(result.assertCurrent());
});
for (const change of ['private deletion', 'central cancellation', 'central withdrawal', 'local generation'] as const) test(`${change} blocks the entire prepared release without requery`, async () => {
  const e = await setup(), result = await prepared(e);
  if (change === 'private deletion') await e.removePrivate();
  if (change === 'central cancellation') await e.binding.cancel();
  if (change === 'central withdrawal') await e.central.publication.revokeRelease(syntheticOwner, e.release.id, e.release.revision, 'test', randomUUID());
  if (change === 'local generation') await e.connections.fenceActor(e.ctx.actorId);
  await assert.rejects(result.assertCurrent()); assert.equal(e.requests.length, 1);
});
test('private deletion while central query is in flight is caught before model handoff', async () => {
  const e = await setup(), query = e.remote.query; e.remote.query = async (...args) => { const value = await query(...args); await e.removePrivate(); return value; };
  await assert.rejects(prepared(e)); assert.equal(e.requests.length, 1);
});
test('merged mutation during async proof verification is fenced again before release', async () => {
  const e = await setup(), result = await prepared(e), check = e.remote.assertCurrent;
  e.remote.assertCurrent = async (...args) => { await check(...args); result.evidence.sources[0].excerpt = '篡改'; };
  await assert.rejects(result.assertCurrent());
});
test('cancellation rejects preparation and later release instead of downgrading to unavailable', async () => {
  const Composite = await implementation(), e = await setup(), controller = new AbortController();
  const query = e.remote.query; e.remote.query = async (...args) => { const value = await query(...args); controller.abort(); return value; };
  await assert.rejects(new Composite({ private: e.privatePort, connections: e.connections }).prepare(e.ctx, input, controller.signal));
  e.remote.query = query; const result = await prepared(e); await assert.rejects(result.assertCurrent(AbortSignal.abort()));
});

test('reference-aware answer projection hides system routing metadata and preserves exact union citations', async () => {
  const e = await setup(), system = await e.remote.query({ vocabularyVersion: 'finance-topics.v1', topicIds: ['budget_variance'], role: 'finance', requestId: randomUUID() });
  assert.equal(system.status, 'used');
  const evidence = { status: 'used' as const, sources: [system.sources[0]] };
  const model = buildKnowledgeModelEvidence(evidence);
  assert.deepEqual(Object.keys(model.sources[0]).sort(), ['excerpt', 'locator', 'sourceId', 'warnings']);
  const result = renderKnowledgeAnswer({ template: '参考：{{knowledge:K1}}', citationIds: ['K1'] }, { evidence, renderCompanyText: value => value });
  assert.equal(result.detailedText, `参考：「${system.sources[0].excerpt}」`); assert.deepEqual(result.sources, evidence.sources);
  assert.deepEqual(result.warnings, ['source_incomplete', 'text_precision_unverified', 'table_precision_unverified']);
  assert.equal(knowledgeAnswerSchema.safeParse(result).success, true);
});
test('answer refuses warning overflow instead of dropping quality markers', async () => {
  const e = await setup(), evidence = await e.privateRetriever.retrieve(e.ctx, { question, role: 'finance' });
  evidence.sources = evidence.sources.slice(0, 2); evidence.sources.forEach((s, i) => { s.warnings = Array.from({ length: 60 }, (_, n) => `quality_${i}_${n}`); });
  assert.throws(() => renderKnowledgeAnswer({ template: '{{knowledge:K1}}{{knowledge:K2}}', citationIds: ['K1', 'K2'] }, { evidence, renderCompanyText: value => value }));
});

test('the transport preserves only the formal query vocabulary error, without exposing its message', async () => {
  const e = await setup(); let calls = 0;
  const transport = new ReferenceTransport({ origin: 'https://reference.example.test', fetch: async () => {
    calls++; return Response.json({ error: { code: 'reference_vocabulary_mismatch', message: 'private body must not escape' } }, { status: 400 });
  } });
  e.remote.query = transport.reader(Buffer.alloc(32, 9).toString('base64url')).query;
  const result = await prepared(e); assert.equal(result.evidence.status, 'used');
  assert.equal(result.libraryStatus.system, 'vocabulary_mismatch'); assert.equal(calls, 1);
  const codeOnly = new ReferenceTransport({ origin: 'https://reference.example.test', fetch: async () => Response.json({ error: { code: 'reference_vocabulary_mismatch', message: 'private body must not escape' } }, { status: 400 }) });
  await assert.rejects(codeOnly.reader(Buffer.alloc(32, 9).toString('base64url')).query({ vocabularyVersion: 'finance-topics.v1', topicIds: ['budget_variance'], role: 'finance', requestId: randomUUID() }),
    (error: unknown) => error instanceof ReferenceAccessError && error.status === 400 && error.code === 'reference_vocabulary_mismatch' && !String(error).includes('private body'));
});
for (const kind of ['unknown-code', 'extra-field', 'missing-message', 'bytes', 'bad-json', 'mime', 'body-timeout', 'redirect'] as const) test(`400 ${kind} cannot spoof vocabulary status or escape bounded transport`, async () => {
  let calls = 0, cancelled = false;
  const transport = new ReferenceTransport({ origin: 'https://reference.example.test', timeoutMs: 25, fetch: async () => {
    calls++;
    if (kind === 'body-timeout') return new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status: 400, headers: { 'content-type': 'application/json' } });
    const body = kind === 'bytes' ? ' '.repeat(262145) : kind === 'bad-json' ? '{' : JSON.stringify({ error: {
      code: kind === 'unknown-code' ? 'private error' : 'reference_vocabulary_mismatch',
      ...(kind === 'missing-message' ? {} : { message: 'private body' }), ...(kind === 'extra-field' ? { private: true } : {})
    } });
    const response = new Response(body, { status: 400, headers: { 'content-type': kind === 'mime' ? 'text/html' : 'application/json' } });
    if (kind === 'redirect') Object.defineProperty(response, 'redirected', { value: true });
    return response;
  } });
  await assert.rejects(transport.reader(Buffer.alloc(32, 9).toString('base64url')).query({ vocabularyVersion: 'finance-topics.v1', topicIds: ['budget_variance'], role: 'finance', requestId: randomUUID() }),
    (error: unknown) => error instanceof ReferenceAccessError && error.status === 503 && !String(error).includes('private body'));
  assert.equal(calls, 1); if (kind === 'body-timeout') assert.equal(cancelled, true);
});
test('an all-deduplicated system grant is still rechecked on release', async () => {
  const texts = Array.from({ length: 6 }, (_, n) => `预算执行偏差分析步骤 ${n} ` + '树'.repeat(27));
  const e = await setup(texts), result = await prepared(e);
  assert.equal(result.evidence.sources.length, 6); assert.ok(result.evidence.sources.every(s => s.sourceType !== 'system'));
  await e.binding.cancel(); await assert.rejects(result.assertCurrent()); assert.equal(e.requests.length, 1);
});
test('private storage failure remains visible alongside usable system evidence', async () => {
  const e = await setup(); e.repo.listDocuments = async () => { throw Error('private storage'); };
  const result = await prepared(e); assert.deepEqual(result.libraryStatus, { private: 'unavailable', system: 'ready' });
  assert.equal(result.evidence.sources.length, 6); assert.ok(result.evidence.sources.every(s => s.sourceType === 'system')); await result.assertCurrent();
});
test('neither source matching is distinct from missing configuration and exhausted central budget', async () => {
  const Composite = await implementation(), e = await setup();
  const none = await new Composite({ private: e.privatePort, connections: e.connections }).prepare(e.ctx, { ...input, question: '现金流预测' });
  assert.deepEqual(none.libraryStatus, { private: 'no_match', system: 'no_match' }); assert.equal(none.evidence.status, 'no_match');
  const absent = await new Composite().prepare(e.ctx, input); assert.equal(absent.evidence.status, 'unavailable');
  assert.deepEqual(absent.libraryStatus, { private: 'unavailable', system: 'unconfigured' });
  e.remote.query = async () => ({ status: 'rate_limited', sources: [] });
  const limited = await new Composite({ connections: e.connections }).prepare(e.ctx, input); assert.equal(limited.libraryStatus.system, 'rate_limited');
  assert.equal(limited.evidence.status, 'unavailable');
});
test('oversize or malformed upstream evidence fails its library closed, never truncates into valid evidence', async () => {
  const Composite = await implementation(), e = await setup();
  const original = await e.privateRetriever.retrieve(e.ctx, { question, role: 'finance' });
  const invalid = structuredClone(original); invalid.sources[0].excerpt = '甲'.repeat(4001);
  const result = await new Composite({ private: { retrieve: async () => invalid, assertCurrent: e.privatePort.assertCurrent }, connections: e.connections }).prepare(e.ctx, input);
  assert.deepEqual(result.libraryStatus, { private: 'unavailable', system: 'ready' }); assert.ok(result.evidence.sources.every(s => s.sourceType === 'system'));
  assert.equal(invalid.sources[0].excerpt.length, 4001);
});
test('wrong scope and invalid topics fail locally before retrieval', async () => {
  const Composite = await implementation(), e = await setup(), retriever = new Composite({ private: e.privatePort, connections: e.connections });
  for (const ctx of [{ ...e.ctx, actorId: 'all' }, { ...e.ctx, workspaceId: 'all' }, { ...e.ctx, capabilities: [] }]) await assert.rejects(retriever.prepare(ctx, input));
  for (const ids of [['invalid'], ['budget_variance', 'budget_variance'], ['budget_variance', 'cost_driver', 'cashflow_forecast', 'working_capital']]) {
    await assert.rejects(retriever.prepare(e.ctx, { ...input, referenceTopicIds: ids as never }));
  }
  assert.equal(e.privateCalls(), 0); assert.equal(e.requests.length, 0);
});
test('local identity fencing during query is cancellation, not a degraded private-only answer', async () => {
  const e = await setup(), query = e.remote.query;
  e.remote.query = async (...args) => { const value = await query(...args); await e.connections.fenceActor(e.ctx.actorId); return value; };
  await assert.rejects(prepared(e)); assert.equal(e.requests.length, 1);
});
