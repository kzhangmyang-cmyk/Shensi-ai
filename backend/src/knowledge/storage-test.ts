import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { createKnowledgeCrypto } from './crypto.js';
import { createKnowledgeFileStore } from './file-store.js';
import { knowledgeContext, validInput } from '../../test/knowledge-fixture.js';
import { MemoryKnowledgeRepository } from './memory-repository.js';

const secret = 'synthetic-stable-key-'.repeat(3), ctx = knowledgeContext();
const contents = Buffer.from('合成预算参考：按企业实际情况分析，不作为硬性规则。');
async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'shensi-knowledge-store-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = new MemoryKnowledgeRepository();
  const { version } = await repo.createDocument(ctx, { ...validInput, bytes: contents.length }, 'create');
  const store = createKnowledgeFileStore({ root, secret });
  const receipt = await store.writeOriginal(ctx, version, Readable.from([contents]));
  const stored = await repo.completeUpload(ctx, version.id, receipt, version.revision, 'complete');
  return { root, store, stored, receipt };
}
test('explicit stable keys protect independent knowledge AAD', () => {
  assert.throws(() => createKnowledgeCrypto(''), /knowledge_key_required/);
  const crypto = createKnowledgeCrypto(secret);
  const aad = { workspaceId: ctx.workspaceId, actorId: ctx.actorId, kind: 'document', id: randomUUID() };
  const encrypted = crypto.seal(aad, { title: '私有参考资料' });
  assert.equal(encrypted.includes('私有'), false);
  assert.deepEqual(createKnowledgeCrypto(secret).open(aad, encrypted), { title: '私有参考资料' });
  for (const other of [{ ...aad, actorId: 'other' }, { ...aad, workspaceId: 'other' }, { ...aad, id: randomUUID() }]) {
    assert.throws(() => crypto.open(other, encrypted), /knowledge_authentication_invalid/);
  }
});
test('private original survives store restart, authenticates before consume and cleans plaintext', async t => {
  const { root, stored, receipt } = await fixture(t);
  assert.equal(receipt.sourceHash, createHash('sha256').update(contents).digest('hex'));
  const encryptedPath = join(root, 'originals', `${receipt.storageKey}.enc`);
  assert.equal((await stat(encryptedPath)).mode & 0o777, 0o600);
  assert.equal((await stat(join(root, 'originals'))).mode & 0o777, 0o700);
  assert.equal((await readFile(encryptedPath)).includes(contents), false);
  let temporary = '';
  await createKnowledgeFileStore({ root, secret }).withOriginal(ctx, stored, async path => {
    temporary = path; assert.deepEqual(await readFile(path), contents);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
  });
  await assert.rejects(stat(temporary), { code: 'ENOENT' });
  await assert.rejects(createKnowledgeFileStore({ root, secret }).withOriginal(ctx, stored, async () => {
    throw new Error('consumer_failed');
  }), /consumer_failed/);
  assert.deepEqual(await readdir(join(root, 'temporary')), []);
});
test('tamper, exchanged version and wrong actor cannot expose plaintext', async t => {
  const { root, store, stored, receipt } = await fixture(t);
  let consumed = false;
  await assert.rejects(store.withOriginal(knowledgeContext('other'), stored, async () => { consumed = true; }), /knowledge_not_found/);
  await assert.rejects(store.withOriginal(ctx, { ...stored, id: randomUUID() }, async () => { consumed = true; }), /knowledge_authentication_invalid/);
  const path = join(root, 'originals', `${receipt.storageKey}.enc`);
  const cipher = await readFile(path); cipher[cipher.length - 1] ^= 1; await writeFile(path, cipher, { mode: 0o600 });
  await assert.rejects(store.withOriginal(ctx, stored, async () => { consumed = true; }), /knowledge_authentication_invalid/);
  assert.equal(consumed, false);
  assert.deepEqual(await readdir(join(root, 'temporary')), []);
});
test('abort, oversized and incomplete originals leave no committed or pending file', async t => {
  const { root, store, stored } = await fixture(t);
  const before = await readdir(join(root, 'originals'));
  for (const body of [Buffer.alloc(stored.bytes - 1), Buffer.alloc(stored.bytes + 1)]) {
    await assert.rejects(store.writeOriginal(ctx, { ...stored, uploadComplete: false }, Readable.from([body])), /knowledge_upload_size_invalid/);
  }
  const abort = new AbortController(); abort.abort();
  await assert.rejects(store.writeOriginal(ctx, { ...stored, uploadComplete: false }, Readable.from([contents]), abort.signal), /abort/i);
  assert.deepEqual(await readdir(join(root, 'originals')), before);
});
test('symlink entries are refused and delete removes only the private copy', async t => {
  const { root, store, stored, receipt } = await fixture(t);
  const original = join(root, 'user-original.txt'); await writeFile(original, contents);
  const foreign = join(root, 'originals', 'foreign.enc'); await symlink(original, foreign);
  await assert.rejects(store.withOriginal(ctx, { ...stored, storageKey: 'foreign' }, async () => {}), /knowledge_storage_invalid/);
  await assert.rejects(store.removeOriginal(ctx, { ...stored, storageKey: 'foreign' }), /knowledge_storage_invalid/);
  await store.removeOriginal(ctx, stored);
  assert.deepEqual(await readFile(original), contents);
  await assert.rejects(stat(join(root, 'originals', `${receipt.storageKey}.enc`)), { code: 'ENOENT' });
  const alias = join(root, 'alias'); await symlink(root, alias);
  await assert.rejects(createKnowledgeFileStore({ root: alias, secret }).writeOriginal(ctx, stored, Readable.from([contents])), /knowledge_storage_invalid/);
  assert.throws(() => createKnowledgeFileStore({ root: 'relative', secret }), /knowledge_storage_root_required/);
});
