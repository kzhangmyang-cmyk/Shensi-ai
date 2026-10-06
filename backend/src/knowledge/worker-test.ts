import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { MemoryKnowledgeRepository } from './memory-repository.js';
import { createKnowledgeFileStore } from './file-store.js';
import { KnowledgeIngestionWorker } from './ingestion-worker.js';
import { knowledgeContext, validInput, parsedFixture } from '../../test/knowledge-fixture.js';

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'shensi-knowledge-worker-')); t.after(() => rm(root, { recursive: true, force: true }));
  let now = Date.now(); const repository = new MemoryKnowledgeRepository({ now: () => now }), ctx = knowledgeContext();
  const files = createKnowledgeFileStore({ root, secret: 'synthetic-worker-key-'.repeat(3) }), body = Buffer.from('合成参考');
  const { document, version } = await repository.createDocument(ctx, { ...validInput, bytes: body.length }, 'create');
  const receipt = await files.writeOriginal(ctx, version, Readable.from([body]));
  await repository.completeUpload(ctx, version.id, receipt, 1, 'upload');
  return { root, repository, files, ctx, document, version, advance: (ms: number) => { now += ms; }, now: () => now };
}
test('knowledge reader coverage and fenced publication: no ready until real index callback', async t => {
  const f = await fixture(t); let parsed = 0;
  const worker = new KnowledgeIngestionWorker({ ...f, authorizeJob: async () => f.ctx,
    reader: { read: async () => { parsed++; return parsedFixture; } } }); t.after(() => worker.close());
  assert.equal(worker.start(), false, 'do not poll/reparse forever before an index exists');
  assert.equal(await worker.runOnce(), true); assert.equal(parsed, 1);
  assert.equal((await f.repository.getVersion(f.ctx, f.document.id, f.version.id))?.status, 'indexing');
  assert.equal((await f.repository.getDocument(f.ctx, f.document.id))?.activeVersionId, null);
  assert.deepEqual(await readdir(join(f.root, 'temporary')), []);
});
test('knowledge worker reauthorizes before publishing and uses a single active reader', async t => {
  const f = await fixture(t); let release!: () => void, authorize = 0, indexed = 0, reads = 0;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const worker = new KnowledgeIngestionWorker({ ...f,
    authorizeJob: async () => { authorize++; return f.ctx; },
    reader: { read: async () => { reads++; await waiting; return parsedFixture; } },
    indexVersion: async () => { indexed++; } }); t.after(() => worker.close());
  const first = worker.runOnce(), second = worker.runOnce(); assert.equal(first, second);
  release(); assert.equal(await first, true); assert.equal(reads, 1); assert.equal(indexed, 1); assert.ok(authorize >= 3);
  assert.equal((await f.repository.getDocument(f.ctx, f.document.id))?.activeVersionId, f.version.id);
});
test('deleted or revoked knowledge cannot publish late parsed/indexed results', async t => {
  for (const state of ['deleted', 'revoked']) {
    const f = await fixture(t); let calls = 0;
    const worker = new KnowledgeIngestionWorker({ ...f,
      authorizeJob: async () => { if (state === 'revoked' && calls++ > 0) throw new Error('forbidden'); return f.ctx; },
      reader: { read: async () => { if (state === 'deleted') await f.repository.mutateDocument(f.ctx, f.document.id, { deleted: true }, 1, 'delete'); return parsedFixture; } },
      indexVersion: async () => assert.fail('revoked source must not enter index') }); t.after(() => worker.close());
    assert.equal(await worker.runOnce(), false);
    assert.equal((await f.repository.getDocument(f.ctx, f.document.id))?.activeVersionId ?? null, null);
  }
});
test('worker close aborts reader, awaits cleanup and cannot publish after lease reclaim', async t => {
  const f = await fixture(t); let entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const worker = new KnowledgeIngestionWorker({ ...f, authorizeJob: async () => f.ctx,
    reader: { read: async (_input, signal) => { entered(); return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })); } },
    indexVersion: async () => assert.fail('aborted source must not publish') });
  const running = worker.runOnce(); await ready; await worker.close(); assert.equal(await running, false);
  assert.deepEqual(await readdir(join(f.root, 'temporary')), []);
  const next = await f.repository.claimJob('restarted', f.now() + 60_001, 60_000); assert.ok(next);
  const indexed = await f.repository.commitParsed(f.ctx, next, parsedFixture);
  await f.repository.publishReady(f.ctx, next, indexed.revision);
  assert.equal((await f.repository.getDocument(f.ctx, f.document.id))?.activeVersionId, f.version.id);
});
test('worker renews lease and aborts on renewal failure without publishing', async t => {
  const f = await fixture(t); let renewals = 0;
  f.repository.renewClaim = async () => { renewals++; return false; };
  const worker = new KnowledgeIngestionWorker({ ...f, renewIntervalMs: 10, authorizeJob: async () => f.ctx,
    reader: { read: async (_input, signal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })) },
    indexVersion: async () => assert.fail('lost lease must not publish') }); t.after(() => worker.close());
  assert.equal(await worker.runOnce(), false); assert.equal(renewals, 1);
  assert.equal((await f.repository.getDocument(f.ctx, f.document.id))?.activeVersionId, null);
});
test('owned job cancellation stops its reader immediately but another job id cannot stop it', async t => {
  const f = await fixture(t); let entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const worker = new KnowledgeIngestionWorker({ ...f, authorizeJob: async () => f.ctx,
    reader: { read: async (_input, signal) => { entered(); return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })); } },
    indexVersion: async () => assert.fail('cancelled source cannot publish') }); t.after(() => worker.close());
  const running = worker.runOnce(); await ready;
  assert.equal(worker.cancel('another-job'), false);
  const version = await f.repository.getVersion(f.ctx, f.document.id, f.version.id); assert.ok(version?.jobId);
  await f.repository.cancelJob(f.ctx, version.jobId); assert.equal(worker.cancel(version.jobId), true);
  assert.equal(await running, false); assert.equal((await f.repository.getVersion(f.ctx, f.document.id, f.version.id))?.status, 'cancelled');
  assert.deepEqual(await readdir(join(f.root, 'temporary')), []);
});
test('a late old reader cannot overwrite a successfully published replacement', async t => {
  const f = await fixture(t); let entered!: () => void, release!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; }), waiting = new Promise<void>(resolve => { release = resolve; });
  const worker = new KnowledgeIngestionWorker({ ...f, authorizeJob: async () => f.ctx,
    reader: { read: async () => { entered(); await waiting; return parsedFixture; } }, indexVersion: async () => {} }); t.after(() => worker.close());
  const running = worker.runOnce(); await ready;
  const body = Buffer.from('新合成版本');
  const replacement = await f.repository.addVersion(f.ctx, f.document.id, { ...validInput, bytes: body.length }, 1, 'replace');
  const receipt = await f.files.writeOriginal(f.ctx, replacement, Readable.from([body]));
  await f.repository.completeUpload(f.ctx, replacement.id, receipt, 1, 'replacement-upload');
  const claim = await f.repository.claimJob('replacement-worker', f.now(), 60_000); assert.ok(claim);
  const indexed = await f.repository.commitParsed(f.ctx, claim, parsedFixture); await f.repository.publishReady(f.ctx, claim, indexed.revision);
  release(); assert.equal(await running, false);
  assert.equal((await f.repository.getDocument(f.ctx, f.document.id))?.activeVersionId, replacement.id);
});
test('partial coverage and parse failures are not disguised as complete ready versions', async t => {
  const f = await fixture(t);
  const worker = new KnowledgeIngestionWorker({ ...f, authorizeJob: async () => f.ctx,
    reader: { read: async () => ({ ...parsedFixture, coverage: { totalPages: 3, extractedPages: 2, missingPages: [2] }, warnings: ['pages_without_reliable_text'] }) } }); t.after(() => worker.close());
  assert.equal(await worker.runOnce(), true);
  const version = await f.repository.getVersion(f.ctx, f.document.id, f.version.id);
  assert.deepEqual(version?.coverage?.missingPages, [2]); assert.equal(version?.status, 'indexing');
  const g = await fixture(t);
  const failing = new KnowledgeIngestionWorker({ ...g, authorizeJob: async () => g.ctx,
    reader: { read: async () => { throw new Error('knowledge_password_required'); } }, indexVersion: async () => assert.fail('failed parse cannot index') }); t.after(() => failing.close());
  assert.equal(await failing.runOnce(), false);
  assert.equal((await g.repository.getVersion(g.ctx, g.document.id, g.version.id))?.status, 'failed');
  assert.equal((await g.repository.getVersion(g.ctx, g.document.id, g.version.id))?.failureCode, 'knowledge_password_required');
});
