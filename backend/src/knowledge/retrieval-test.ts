import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { MemoryKnowledgeRepository } from './memory-repository.js';
import { KnowledgeRetriever } from './retrieval.js';
import { knowledgeContext, validInput } from '../../test/knowledge-fixture.js';
import type { KnowledgeScope, KnowledgeRole, KnowledgeDocumentRecord } from './domain.js';

const ctx = knowledgeContext();
async function ready(repo: MemoryKnowledgeRepository, text: string | string[], options: { ctx?: KnowledgeScope; title?: string; roles?: KnowledgeRole[] } = {}) {
  const owner = options.ctx ?? ctx;
  const created = await repo.createDocument(owner, { ...validInput, title: options.title ?? '参考资料', roles: options.roles ?? ['cfo'] }, randomUUID());
  await repo.completeUpload(owner, created.version.id, { bytes: 120, storageKey: randomUUID(), sourceHash: 'a'.repeat(64) }, 1, randomUUID());
  const claim = (await repo.claimJob(randomUUID(), Date.now(), 60000))!;
  const parsed = await repo.commitParsed(owner, claim, { parserVersion: 'fixture.v1', coverage: { totalPages: 1, extractedPages: 1, missingPages: [] }, warnings: ['layout_unverified'],
    chunks: (typeof text === 'string' ? [text] : text).map((text, order) => ({ text, order, locator: { page: 1, chapter: '经营方法' }, warnings: ['table_unverified'] })) });
  await repo.publishReady(owner, claim, parsed.revision);
  return { document: (await repo.getDocument(owner, created.document.id))!, versionId: created.version.id };
}

test('Chinese references match no-space budget and cash collection terms without cross-actor/workspace leakage', async () => {
  const repo = new MemoryKnowledgeRepository();
  const value = await ready(repo, '全面预算围绕经营目标展开。现金流预测应考虑到账时点和客户付款能力。');
  const retriever = new KnowledgeRetriever(repo);
  for (const question of ['全面预算怎么做', '如何预测回款', '资金回笼计划']) {
    const result = await retriever.retrieve(ctx, { question, role: 'cfo' });
    assert.equal(result.status, 'used', question); assert.equal(result.sources[0].documentId, value.document.id);
    assert.equal(result.sources[0].versionId, value.versionId); assert.equal(result.sources[0].locator.page, 1);
    assert.ok(result.sources[0].warnings.includes('table_unverified')); assert.ok(result.sources[0].warnings.includes('layout_unverified'));
  }
  assert.deepEqual(await retriever.retrieve(knowledgeContext('other'), { question: '全面预算', role: 'cfo' }), { status: 'no_match', sources: [] });
  assert.equal((await retriever.retrieve(knowledgeContext('actor-a', 'other-team'), { question: '全面预算', role: 'cfo' })).sources.length, 0);
  await assert.rejects(retriever.retrieve({ ...ctx, capabilities: [] }, { question: '预算', role: 'cfo' }));
});

test('exact financial terminology, company names and continuous identifiers do not fuzzy-match a different number', async () => {
  const repo = new MemoryKnowledgeRepository();
  await ready(repo, '神思科技有限公司。合同编号ABC20261006001，毛利率应区分含税收入与成本。');
  const retriever = new KnowledgeRetriever(repo);
  for (const question of ['毛利率', '神思科技有限公司', 'ABC20261006001']) assert.equal((await retriever.retrieve(ctx, { question, role: 'cfo' })).status, 'used');
  for (const question of ['ABC20261006002', 'ABC20261006002的毛利率', '你好', '谢谢你', '火星天气预报']) assert.deepEqual(await retriever.retrieve(ctx, { question, role: 'cfo' }), { status: 'no_match', sources: [] });
});

test('role filtering precedes top-k; exact duplicate excerpts and over-budget sources are excluded', async () => {
  const repo = new MemoryKnowledgeRepository();
  for (let n = 0; n < 7; n++) await ready(repo, `预算预算预算${n}。`, { roles: ['cfo'], title: '预算' });
  const tax = await ready(repo, '税务预算必须结合当前政策核对。', { roles: ['tax'] });
  const retriever = new KnowledgeRetriever(repo);
  const taxResult = await retriever.retrieve(ctx, { question: '预算', role: 'tax' });
  assert.equal(taxResult.status, 'used'); assert.deepEqual(taxResult.sources.map(s => s.documentId), [tax.document.id]);
  const longRepo = new MemoryKnowledgeRepository();
  await ready(longRepo, Array.from({ length: 10 }, (_, n) => `全面预算${n}。${'经营'.repeat(1900)}`));
  await ready(longRepo, '重复预算内容。'); await ready(longRepo, '重复预算内容。');
  const result = await new KnowledgeRetriever(longRepo).retrieve(ctx, { question: '预算', role: 'cfo' });
  assert.equal(result.status, 'used'); assert.ok(result.sources.length <= 6);
  assert.ok(result.sources.reduce((total, s) => total + s.excerpt.length, 0) <= 12000);
  assert.equal(new Set(result.sources.map(s => s.excerpt)).size, result.sources.length);
});

test('cached data cannot survive disable/delete or a ready replacement and indexing alone is not searchable', async () => {
  const repo = new MemoryKnowledgeRepository(), first = await ready(repo, '旧版预算控制。');
  const retriever = new KnowledgeRetriever(repo);
  assert.equal((await retriever.retrieve(ctx, { question: '旧版', role: 'cfo' })).status, 'used');
  const next = await repo.addVersion(ctx, first.document.id, validInput, first.document.revision, randomUUID());
  await repo.completeUpload(ctx, next.id, { bytes: 120, storageKey: randomUUID(), sourceHash: 'b'.repeat(64) }, next.revision, randomUUID());
  const claim = (await repo.claimJob('new-reader', Date.now(), 60000))!;
  const parsed = await repo.commitParsed(ctx, claim, { parserVersion: 'fixture.v1', coverage: { totalPages: 1, extractedPages: 1, missingPages: [] }, warnings: [], chunks: [{ order: 0, text: '新版成本削减。', locator: { page: 1 }, warnings: [] }] });
  await retriever.indexVersion(ctx, next.id);
  assert.equal((await retriever.retrieve(ctx, { question: '新版', role: 'cfo' })).status, 'no_match');
  assert.equal((await retriever.retrieve(ctx, { question: '旧版', role: 'cfo' })).status, 'used');
  await repo.publishReady(ctx, claim, parsed.revision);
  assert.equal((await retriever.retrieve(ctx, { question: '旧版', role: 'cfo' })).status, 'no_match');
  assert.equal((await retriever.retrieve(ctx, { question: '新版', role: 'cfo' })).sources[0].versionId, next.id);
  let current = (await repo.getDocument(ctx, first.document.id))!;
  current = await repo.mutateDocument(ctx, current.id, { enabled: false }, current.revision, randomUUID());
  assert.equal((await retriever.retrieve(ctx, { question: '新版', role: 'cfo' })).status, 'no_match');
  current = await repo.mutateDocument(ctx, current.id, { enabled: true }, current.revision, randomUUID());
  assert.equal((await retriever.retrieve(ctx, { question: '新版', role: 'cfo' })).status, 'used');
  await repo.mutateDocument(ctx, current.id, { deleted: true }, current.revision, randomUUID());
  assert.equal((await retriever.retrieve(ctx, { question: '新版', role: 'cfo' })).status, 'no_match');
});

test('a late tombstone and permission change are rechecked after cached search before returning excerpts', async () => {
  const repo = new MemoryKnowledgeRepository(), first = await ready(repo, '现金流参考。');
  const retriever = new KnowledgeRetriever(repo);
  await retriever.retrieve(ctx, { question: '现金流', role: 'cfo' });
  const getVersion = repo.getVersion.bind(repo); let removed = false;
  repo.getVersion = async (...args) => {
    const value = await getVersion(...args);
    if (!removed) { removed = true; const document = (await repo.getDocument(ctx, first.document.id))!;
      await repo.mutateDocument(ctx, document.id, { deleted: true }, document.revision, randomUUID()); }
    return value;
  };
  assert.deepEqual(await retriever.retrieve(ctx, { question: '现金流', role: 'cfo' }), { status: 'no_match', sources: [] });
});

test('indexes rebuild from the repository, keep only two scoped caches, and invalidate metadata edits', async () => {
  const repo = new MemoryKnowledgeRepository();
  const actors = [ctx, knowledgeContext('b'), knowledgeContext('c')];
  const values: KnowledgeDocumentRecord[] = [];
  for (const actor of actors) values.push((await ready(repo, '现金流参考。', { ctx: actor, title: '特定标题预算' })).document);
  const original = repo.listChunkPage.bind(repo); let reads = 0;
  repo.listChunkPage = async (...args) => { reads++; return original(...args); };
  const retriever = new KnowledgeRetriever(repo), query = { question: '现金流', role: 'cfo' as const };
  await retriever.retrieve(actors[0], query); const once = reads;
  await retriever.retrieve(actors[0], query); assert.equal(reads, once);
  await retriever.retrieve(actors[1], query); await retriever.retrieve(actors[2], query);
  const beforeEviction = reads; await retriever.retrieve(actors[0], query); assert.ok(reads > beforeEviction);
  await repo.mutateDocument(ctx, values[0].id, { title: '全新标题' }, values[0].revision, randomUUID());
  retriever.invalidate(ctx, values[0].id);
  assert.equal((await retriever.retrieve(ctx, { question: '特定', role: 'cfo' })).status, 'no_match');
  assert.equal((await new KnowledgeRetriever(repo).retrieve(ctx, query)).status, 'used');
});

test('repository/index input failure is unavailable, never no-match or silently truncated; cancellation rejects', async () => {
  const repo = new MemoryKnowledgeRepository(), value = await ready(repo, '预算'.repeat(1000));
  const retriever = new KnowledgeRetriever(repo, { maxInputBytes: 1024 });
  assert.deepEqual(await retriever.retrieve(ctx, { question: '预算', role: 'cfo' }), { status: 'unavailable', sources: [] });
  await repo.mutateDocument(ctx, value.document.id, { enabled: false }, value.document.revision, randomUUID());
  assert.equal((await retriever.retrieve(ctx, { question: '预算', role: 'cfo' })).status, 'no_match');
  repo.listDocuments = async () => { throw new Error('private database details'); };
  assert.deepEqual(await retriever.retrieve(ctx, { question: '预算', role: 'cfo' }), { status: 'unavailable', sources: [] });
  await assert.rejects(retriever.retrieve(ctx, { question: '预算', role: 'cfo' }, AbortSignal.abort()));
});

test('fresh application authorization can revoke an otherwise cached authorized scope', async () => {
  const repo = new MemoryKnowledgeRepository(); await ready(repo, '预算参考。'); let revoked = false;
  const retriever = new KnowledgeRetriever(repo, { authorizeScope: async () => { if (revoked) throw new Error('revoked'); return ctx; } });
  assert.equal((await retriever.retrieve(ctx, { question: '预算', role: 'cfo' })).status, 'used');
  revoked = true;
  assert.deepEqual(await retriever.retrieve(ctx, { question: '预算', role: 'cfo' }), { status: 'unavailable', sources: [] });
});
