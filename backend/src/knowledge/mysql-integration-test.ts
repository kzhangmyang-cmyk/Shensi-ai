import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import type { Pool } from 'mysql2/promise';
import { createFinancialCouncilMysqlTestDatabase } from '../financial-council-mysql-test-support.js';
import { knowledgeContext, validInput, parsedFixture } from '../../test/knowledge-fixture.js';
import { createKnowledgeCrypto } from './crypto.js';
import { ensureKnowledgeMysqlSchema, MysqlKnowledgeRepository } from './mysql-repository.js';

const options = { skip: !process.env.MYSQL_TEST_ADMIN_URL && 'explicit isolated MYSQL_TEST_ADMIN_URL not configured' };
const crypto = createKnowledgeCrypto('synthetic-stable-knowledge-key-'.repeat(2)), ctx = knowledgeContext();
const receipt = { storageKey: 'private-original', sourceHash: createHash('sha256').update('synthetic').digest('hex'), bytes: validInput.bytes };
test('knowledge persisted and isolated after pool restart with encrypted metadata and chunks', options, async t => {
  const db = await createFinancialCouncilMysqlTestDatabase({ initializeSchemas: false });
  let restartedPool: Pool | undefined, initialClosed = false;
  await ensureKnowledgeMysqlSchema(db.pool); await ensureKnowledgeMysqlSchema(db.pool);
  const initialPool = db.openPool();
  t.after(async () => {
    if (!initialClosed) await initialPool.end();
    await restartedPool?.end();
    await db.close();
  });
  const first = new MysqlKnowledgeRepository(initialPool, crypto);
  const { document, version } = await first.createDocument(ctx, validInput, 'create');
  const uploaded = await first.completeUpload(ctx, version.id, receipt, version.revision, 'upload');
  const claim = await first.claimJob('worker', Date.now(), 60_000); assert.ok(claim);
  const indexed = await first.commitParsed(ctx, claim, parsedFixture);
  await first.publishReady(ctx, claim, indexed.revision);
  await initialPool.end(); initialClosed = true;
  const pool = db.openPool(); restartedPool = pool;
  const restarted = new MysqlKnowledgeRepository(pool, crypto);
  assert.equal((await restarted.getVersion(ctx, document.id, version.id))?.sourceHash, uploaded.sourceHash);
  assert.equal((await restarted.getDocument(ctx, document.id))?.activeVersionId, version.id);
  assert.equal((await restarted.listChunks(ctx, version.id))[0]?.text, parsedFixture.chunks[0].text);
  for (const other of [knowledgeContext('other'), knowledgeContext(ctx.actorId, 'other')]) {
    assert.equal(await restarted.getDocument(other, document.id), null);
    assert.equal(await restarted.getVersion(other, document.id, version.id), null);
    assert.deepEqual(await restarted.listChunks(other, version.id), []);
  }
  for (const table of ['knowledge_documents', 'knowledge_versions', 'knowledge_chunks', 'knowledge_commands']) {
    const [rows] = await pool.query(`SELECT payload FROM ${table}`);
    assert.equal(JSON.stringify(rows).includes(validInput.title), false);
    assert.equal(JSON.stringify(rows).includes(parsedFixture.chunks[0].text), false);
  }
  assert.deepEqual(await restarted.createDocument(ctx, validInput, 'create'), { document, version });
  await assert.rejects(restarted.createDocument(ctx, { ...validInput, title: 'different' }, 'create'), /idempotency_conflict/);
});
test('SQL lease reclaim, atomic rollback and scoped encrypted chunk authentication', options, async t => {
  const db = await createFinancialCouncilMysqlTestDatabase({ initializeSchemas: false }); t.after(() => db.close());
  await ensureKnowledgeMysqlSchema(db.pool);
  let now = 1000;
  const repo = new MysqlKnowledgeRepository(db.pool, crypto, { now: () => now });
  const { document, version } = await repo.createDocument(ctx, validInput, 'create');
  await repo.completeUpload(ctx, version.id, receipt, 1, 'upload');
  const old = await repo.claimJob('old', now, 100); assert.ok(old);
  now = 1101;
  const current = await repo.claimJob('current', now, 100); assert.ok(current);
  assert.ok(current.fence > old.fence);
  await assert.rejects(repo.commitParsed(ctx, old, parsedFixture), /knowledge_stale_job/);
  const indexed = await repo.commitParsed(ctx, current, parsedFixture);
  await assert.rejects(repo.publishReady(ctx, current, indexed.revision - 1), /revision_mismatch/);
  assert.equal((await repo.getDocument(ctx, document.id))?.activeVersionId, null);
  assert.equal((await repo.getVersion(ctx, document.id, version.id))?.status, 'indexing');
  await repo.publishReady(ctx, current, indexed.revision);
  const chunk = (await repo.listChunks(ctx, version.id))[0];
  await db.pool.execute(`UPDATE knowledge_chunks SET payload=? WHERE id=?`, [crypto.seal({ workspaceId: ctx.workspaceId,
    actorId: 'other', kind: 'chunk', id: chunk.id, versionId: version.id }, chunk), chunk.id]);
  await assert.rejects(repo.listChunks(ctx, version.id), /knowledge_authentication_invalid/);
  assert.equal(await repo.renewClaim(current, now, 100), false);
});
test('concurrent SQL revisions, worker fences and deleted command replay never revive references', options, async t => {
  const db = await createFinancialCouncilMysqlTestDatabase({ initializeSchemas: false }); t.after(() => db.close());
  await ensureKnowledgeMysqlSchema(db.pool);
  const repo = new MysqlKnowledgeRepository(db.pool, crypto);
  const { document, version } = await repo.createDocument(ctx, validInput, 'create');
  await repo.completeUpload(ctx, version.id, receipt, 1, 'upload');
  const claim = await repo.claimJob('worker', Date.now(), 60_000); assert.ok(claim);
  const results = await Promise.allSettled(['a', 'b'].map(key => repo.mutateDocument(ctx, document.id, { title: key }, 1, key)));
  assert.equal(results.filter(value => value.status === 'fulfilled').length, 1);
  const current = (await repo.getDocument(ctx, document.id))!;
  const replacement = await repo.addVersion(ctx, document.id, validInput, current.revision, 'replace');
  await assert.rejects(repo.commitParsed(ctx, claim, parsedFixture), /knowledge_stale_job/);
  await repo.completeUpload(ctx, replacement.id, receipt, 1, 'upload-new');
  const next = await repo.claimJob('new-worker', Date.now(), 60_000); assert.ok(next);
  const updated = (await repo.getDocument(ctx, document.id))!;
  const deleted = await repo.mutateDocument(ctx, document.id, { deleted: true }, updated.revision, 'delete');
  assert.deepEqual(await repo.mutateDocument(ctx, document.id, { deleted: true }, updated.revision, 'delete'), deleted);
  assert.equal(await repo.renewClaim(next, Date.now(), 60_000), false);
  await assert.rejects(repo.commitParsed(ctx, next, parsedFixture), /knowledge_stale_job/);
  assert.equal(await repo.getDocument(ctx, document.id), null);
  assert.deepEqual(await repo.listChunks(ctx, replacement.id), []);
  assert.equal(await repo.claimJob('worker', Date.now(), 60_000), null);
});
