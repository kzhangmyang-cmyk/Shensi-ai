import assert from 'node:assert/strict';
import { test } from 'node:test';
import { capabilitiesForHumanRole } from '../growth-capabilities.js';
import { knowledgeUploadInputSchema, documentProjection, versionProjection } from './domain.js';
import { MemoryKnowledgeRepository } from './memory-repository.js';
import { knowledgeContext, parsedFixture, validInput } from '../../test/knowledge-fixture.js';

test('knowledge scope and limits: reject forged ownership, paths, oversize and invalid roles', () => {
  assert.equal(knowledgeUploadInputSchema.safeParse(validInput).success, true);
  for (const patch of [{ bytes: 50 * 1024 * 1024 + 1 }, { bytes: 0 },
    { roles: ['unknown'] }, { roles: ['cfo', 'cfo'] }, { owner: 'other' },
    { path: '/etc/passwd' }, { filename: '../secret.txt' }, { format: 'epub' }]) {
    assert.equal(knowledgeUploadInputSchema.safeParse({ ...validInput, ...patch }).success, false);
  }
});

test('knowledge scope and limits: same-team other actor and other workspace cannot discover records', async () => {
  const repo = new MemoryKnowledgeRepository();
  const ctx = knowledgeContext();
  const { document, version } = await repo.createDocument(ctx, validInput, 'create-1');
  for (const denied of [knowledgeContext('other'), knowledgeContext('actor-a', 'other-team')]) {
    assert.equal(await repo.getDocument(denied, document.id), null);
    assert.equal(await repo.getVersion(denied, document.id, version.id), null);
    assert.deepEqual((await repo.listDocuments(denied, { limit: 20 })).items, []);
    assert.deepEqual(await repo.listChunks(denied, version.id), []);
    await assert.rejects(repo.mutateDocument(denied, document.id, { enabled: false }, 1, 'denied'),
      (e: any) => e.status === 404);
  }
  await assert.rejects(repo.createDocument(knowledgeContext('actor-a', 'all'), validInput, 'all'),
    (e: any) => e.code === 'workspace_required');
  const projected = { ...documentProjection(document), ...versionProjection(version) };
  assert.equal('actorId' in projected, false);
  assert.equal('workspaceId' in projected, false);
  assert.equal('storageKey' in projected, false);
});

test('knowledge scope and limits: personal library grants do not grant council access', async () => {
  for (const role of ['sales', 'manager', 'admin', 'super_admin'] as const) {
    const caps = capabilitiesForHumanRole(role);
    assert.ok(caps.includes('knowledge.read'));
    assert.ok(caps.includes('knowledge.upload'));
    assert.ok(caps.includes('knowledge.manage_own'));
  }
  assert.equal(capabilitiesForHumanRole('sales').includes('finance.council.run'), false);
  assert.equal(capabilitiesForHumanRole('manager').includes('finance.council.run'), false);
  const repo = new MemoryKnowledgeRepository();
  await assert.rejects(repo.createDocument({ ...knowledgeContext(), capabilities: [] }, validInput, 'no-cap'),
    (e: any) => e.code === 'capability_forbidden');
});

test('knowledge commands replay only exact requests and reject stale revisions', async () => {
  const repo = new MemoryKnowledgeRepository(); const ctx = knowledgeContext();
  const first = await repo.createDocument(ctx, validInput, 'create-1');
  assert.deepEqual(await repo.createDocument(ctx, validInput, 'create-1'), first);
  await assert.rejects(repo.createDocument(ctx, { ...validInput, title: 'different' }, 'create-1'),
    (e: any) => e.code === 'idempotency_conflict');
  const changed = await repo.mutateDocument(ctx, first.document.id, { title: 'changed' }, 1, 'edit');
  assert.equal(changed.revision, 2);
  assert.deepEqual(await repo.mutateDocument(ctx, first.document.id, { title: 'changed' }, 1, 'edit'), changed);
  await assert.rejects(repo.mutateDocument(ctx, first.document.id, { enabled: false }, 1, 'stale'),
    (e: any) => e.status === 412);
  first.document.title = 'caller mutation';
  assert.equal((await repo.getDocument(ctx, changed.id))?.title, 'changed');
});

test('knowledge worker cannot claim partial upload or publish without indexing', async () => {
  const repo = new MemoryKnowledgeRepository({ now: () => 100 }); const ctx = knowledgeContext();
  const { document, version } = await repo.createDocument(ctx, validInput, 'create');
  assert.equal(await repo.claimJob('worker', 100, 60_000), null);
  await repo.completeUpload(ctx, version.id, { storageKey: version.id, sourceHash: 'a'.repeat(64), bytes: 120 }, 1, 'upload');
  const claim = await repo.claimJob('worker', 100, 60_000);
  assert.ok(claim);
  await assert.rejects(repo.publishReady(ctx, claim, 2), (e: any) => e.code === 'knowledge_not_indexed');
  const indexed = await repo.commitParsed(ctx, claim, parsedFixture);
  assert.equal(indexed.status, 'indexing');
  assert.equal((await repo.getDocument(ctx, document.id))?.activeVersionId, null);
  const ready = await repo.publishReady(ctx, claim, indexed.revision);
  assert.equal(ready.status, 'ready');
  assert.equal((await repo.getDocument(ctx, document.id))?.activeVersionId, version.id);
  assert.equal((await repo.listChunks(ctx, version.id))[0]?.locator.page, 1);
});

test('late knowledge workers cannot revive cancelled, superseded or deleted versions', async () => {
  const repo = new MemoryKnowledgeRepository({ now: () => 202 }); const ctx = knowledgeContext();
  const { document, version } = await repo.createDocument(ctx, validInput, 'create');
  await repo.completeUpload(ctx, version.id, { storageKey: version.id, sourceHash: 'b'.repeat(64), bytes: 120 }, 1, 'upload');
  const oldClaim = await repo.claimJob('old', 100, 100);
  assert.ok(oldClaim);
  const reclaimed = await repo.claimJob('new', 201, 100);
  assert.ok(reclaimed); assert.notEqual(reclaimed.fence, oldClaim.fence);
  assert.equal(await repo.renewClaim(oldClaim, 202, 100), false);
  await assert.rejects(repo.commitParsed(ctx, oldClaim, parsedFixture), (e: any) => e.code === 'knowledge_stale_job');
  await repo.addVersion(ctx, document.id, validInput, 1, 'replacement');
  await assert.rejects(repo.commitParsed(ctx, reclaimed, parsedFixture), (e: any) => e.code === 'knowledge_stale_job');
  const current = await repo.getDocument(ctx, document.id); assert.ok(current);
  await repo.mutateDocument(ctx, document.id, { deleted: true }, current.revision, 'delete');
  assert.equal(await repo.getDocument(ctx, document.id), null);
  assert.equal(await repo.getVersion(ctx, document.id, version.id), null);
});

test('knowledge pagination rejects cross-scope cursors and applies role filters before paging', async () => {
  const repo = new MemoryKnowledgeRepository(); const ctx = knowledgeContext();
  await repo.createDocument(ctx, { ...validInput, title: 'Cost only', roles: ['cost'] }, 'a');
  await repo.createDocument(ctx, { ...validInput, title: 'CFO one' }, 'b');
  await repo.createDocument(ctx, { ...validInput, title: 'CFO two' }, 'c');
  const first = await repo.listDocuments(ctx, { limit: 1, role: 'cfo' });
  assert.equal(first.items.length, 1); assert.ok(first.nextCursor);
  const second = await repo.listDocuments(ctx, { limit: 1, role: 'cfo', cursor: first.nextCursor });
  assert.equal(second.items.length, 1); assert.notEqual(second.items[0].id, first.items[0].id);
  await assert.rejects(repo.listDocuments(knowledgeContext('other'), { limit: 1, role: 'cfo', cursor: first.nextCursor }),
    (e: any) => e.code === 'knowledge_cursor_invalid');
});

test('knowledge delete retries preserve command identity without reviving access', async () => {
  const repo = new MemoryKnowledgeRepository(); const ctx = knowledgeContext();
  const { document } = await repo.createDocument(ctx, validInput, 'create');
  const first = await repo.mutateDocument(ctx, document.id, { deleted: true }, 1, 'delete');
  assert.deepEqual(await repo.mutateDocument(ctx, document.id, { deleted: true }, 1, 'delete'), first);
  assert.equal(await repo.getDocument(ctx, document.id), null);
});
