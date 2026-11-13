import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import { mkdtemp, readdir, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { createServer, request } from 'node:http';
import { knowledgeContext, validInput, parsedFixture } from '../../test/knowledge-fixture.js';
import { MemoryKnowledgeRepository } from './memory-repository.js';
import { createKnowledgeCrypto } from './crypto.js';
import { createKnowledgeFileStore } from './file-store.js';
import { KnowledgeService } from './service.js';
import { createKnowledgeRouter, installKnowledgeIngress } from './router.js';
import Ajv from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const secret = 'synthetic-stable-knowledge-key-'.repeat(2), body = Buffer.from('合成预算参考，结合实际经营情况。');
async function fixture(t: test.TestContext, repository = new MemoryKnowledgeRepository()) {
  const root = await mkdtemp(join(tmpdir(), 'shensi-knowledge-http-')); t.after(() => rm(root, { recursive: true, force: true }));
  const service = new KnowledgeService({ repository, files: createKnowledgeFileStore({ root, secret }), crypto: createKnowledgeCrypto(secret) });
  const app = express();
  const auth: express.RequestHandler = (req, res, next) => {
    if (!req.headers.authorization) { res.status(401).json({ error: { code: 'unauthorized', message: '未登录' } }); return; }
    if (req.headers.cookie && !['GET', 'HEAD'].includes(req.method) && req.header('x-csrf-token') !== 'synthetic-csrf') {
      res.status(403).json({ error: { code: 'csrf_validation_failed', message: '安全校验失败' } }); return;
    }
    req.activeWorkspace = knowledgeContext(req.header('authorization') === 'other' ? 'other' : 'actor-a'); next();
  };
  installKnowledgeIngress(app, auth);
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/v1/knowledge', createKnowledgeRouter({ service, workspaceContext: req => req.activeWorkspace! }));
  const server = createServer(app); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const address = server.address(); assert.ok(address && typeof address === 'object'); const origin = `http://127.0.0.1:${address.port}`;
  const headers = { Authorization: 'owner', 'Content-Type': 'application/json', 'Idempotency-Key': 'create' };
  const created = await fetch(`${origin}/api/v1/knowledge/documents`, { method: 'POST', headers, body: JSON.stringify({ ...validInput, bytes: body.length }) });
  assert.equal(created.status, 201); const records = await created.json();
  const ajv = new Ajv({ strict: false }); addFormats(ajv);
  const schema = JSON.parse(await readFile(new URL('../../../contracts/json-schema/knowledge.v1.schema.json', import.meta.url), 'utf8')); ajv.addSchema(schema);
  for (const [name, record] of [['Document', records.document], ['Version', records.version]]) {
    const validate = ajv.compile({ $ref: `${schema.$id}#/$defs/${name}` }); assert.equal(validate(record), true, JSON.stringify(validate.errors));
  }
  const path = `/api/v1/knowledge/documents/${records.document.id}/versions/${records.version.id}/content`;
  return { root, repository, service, origin, path, records };
}
test('knowledge authenticated binary upload is scoped, finite and not ready before parsing', async t => {
  const f = await fixture(t);
  assert.equal((await fetch(`${f.origin}${f.path}`)).status, 401);
  assert.equal((await fetch(`${f.origin}${f.path}`, { headers: { Authorization: 'other' } })).status, 404);
  const uploadHeaders = { Authorization: 'owner', 'Content-Type': 'application/octet-stream', 'If-Match': '"1"', 'Idempotency-Key': 'upload' };
  const response = await fetch(`${f.origin}${f.path}`, { method: 'PUT', headers: uploadHeaders, body });
  assert.equal(response.status, 200); const version = await response.json();
  assert.equal(version.uploadComplete, true); assert.equal(version.status, 'queued'); assert.equal('storageKey' in version, false);
  assert.equal(response.headers.get('etag'), '"2"');
  const download = await fetch(`${f.origin}${f.path}`, { headers: { Authorization: 'owner' } });
  assert.equal(download.status, 200); assert.deepEqual(Buffer.from(await download.arrayBuffer()), body);
  assert.equal(download.headers.get('content-type'), 'application/octet-stream');
  assert.equal((await fetch(`${f.origin}${f.path}`, { headers: { Authorization: 'other' } })).status, 404);
  assert.equal((await fetch(`${f.origin}${f.path}`, { method: 'PUT', headers: uploadHeaders, body })).status, 200, 'exact manual replay preserves command identity');
  assert.equal((await fetch(`${f.origin}${f.path}`, { method: 'PUT', headers: uploadHeaders, body: Buffer.alloc(body.length, 65) })).status, 409);
  for (let attempt = 0; attempt < 100 && (await readdir(join(f.root, 'temporary'))).length; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.deepEqual(await readdir(join(f.root, 'temporary')), []);
});
test('knowledge upload rejects missing preconditions, CSRF, MIME, signature and byte mismatch', async t => {
  const f = await fixture(t); const headers = { Authorization: 'owner', 'Content-Type': 'application/octet-stream', 'If-Match': '"1"', 'Idempotency-Key': 'upload' };
  assert.equal((await fetch(`${f.origin}${f.path}`, { method: 'PUT', headers: { ...headers, Cookie: 'gj_session=synthetic' }, body })).status, 403);
  assert.equal((await fetch(`${f.origin}${f.path}`, { method: 'PUT', headers: { ...headers, 'Content-Type': 'application/json' }, body: '{}' })).status, 415);
  const missingRevision = { ...headers }; delete (missingRevision as Partial<typeof headers>)['If-Match'];
  assert.equal((await fetch(`${f.origin}${f.path}`, { method: 'PUT', headers: missingRevision, body })).status, 428);
  assert.equal((await fetch(`${f.origin}${f.path}`, { method: 'PUT', headers, body: Buffer.alloc(body.length + 1) })).status, 400);
  const { document, version } = await f.repository.createDocument(knowledgeContext(), { ...validInput, filename: 'synthetic.pdf', format: 'pdf', bytes: body.length }, 'pdf');
  const pdfPath = `/api/v1/knowledge/documents/${document.id}/versions/${version.id}/content`;
  assert.equal((await fetch(`${f.origin}${pdfPath}`, { method: 'PUT', headers, body })).status, 415);
  assert.equal((await f.repository.getVersion(knowledgeContext(), document.id, version.id))?.uploadComplete, false);
  assert.deepEqual(await readdir(join(f.root, 'originals')), []);
  const large = await fetch(`${f.origin}/api/v1/knowledge/documents`, { method: 'POST',
    headers: { Authorization: 'owner', 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'a'.repeat(1_048_576) }) });
  assert.equal(large.status, 413);
});
test('knowledge preview is paged, contract conformant and cursor is bound to the owner and version', async t => {
  const f = await fixture(t), ctx = knowledgeContext();
  await f.service.acceptOriginal(ctx, f.records.document.id, f.records.version.id, Readable.from([body]), 1, 'upload');
  const claim = await f.repository.claimJob('fixture', Date.now(), 60_000); assert.ok(claim);
  const chunks = Array.from({ length: 3 }, (_, order) => ({ ...parsedFixture.chunks[0], order }));
  await f.repository.commitParsed(ctx, claim, { ...parsedFixture, chunks });
  const pathname = f.path.replace(/content$/u, 'chunks'), headers = { Authorization: 'owner' };
  const first = await (await fetch(`${f.origin}${pathname}?limit=1`, { headers })).json();
  assert.equal(first.items.length, 1); assert.ok(first.nextCursor);
  const ajv = new Ajv({ strict: false }); addFormats(ajv);
  const schema = JSON.parse(await readFile(new URL('../../../contracts/json-schema/knowledge.v1.schema.json', import.meta.url), 'utf8')); ajv.addSchema(schema);
  const validate = ajv.compile({ type: 'object', additionalProperties: false, required: ['items', 'nextCursor'],
    properties: { items: { type: 'array', maxItems: 100, items: { $ref: `${schema.$id}#/$defs/Chunk` } }, nextCursor: { type: ['string', 'null'] } } });
  assert.equal(validate(first), true, JSON.stringify(validate.errors));
  const second = await (await fetch(`${f.origin}${pathname}?limit=1&cursor=${encodeURIComponent(first.nextCursor)}`, { headers })).json();
  assert.equal(second.items[0].order, 1);
  assert.equal((await fetch(`${f.origin}${pathname}?limit=101`, { headers })).status, 400);
  assert.equal((await fetch(`${f.origin}${pathname}?cursor=${encodeURIComponent(first.nextCursor)}`, { headers: { Authorization: 'other' } })).status, 404);
  await f.repository.mutateDocument(ctx, f.records.document.id, { deleted: true }, 1, 'delete');
  assert.equal((await fetch(`${f.origin}${pathname}`, { headers })).status, 404);
});
test('client abort leaves upload incomplete and no task or original', async t => {
  const f = await fixture(t);
  await new Promise<void>(resolve => {
    const req = request(`${f.origin}${f.path}`, { method: 'PUT', headers: { Authorization: 'owner', 'Content-Type': 'application/octet-stream',
      'If-Match': '"1"', 'Idempotency-Key': 'abort' } });
    req.on('error', () => resolve()); req.write(body.subarray(0, 4)); setTimeout(() => req.destroy(), 20);
  });
  // Await the service's observable cleanup, not a fixed browser delay.
  for (let attempt = 0; attempt < 100; attempt++) {
    if ((await readdir(join(f.root, 'originals'))).length === 0) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal((await f.repository.getVersion(knowledgeContext(), f.records.document.id, f.records.version.id))?.uploadComplete, false);
  assert.equal(await f.repository.claimJob('test', Date.now(), 60000), null);
  assert.deepEqual(await readdir(join(f.root, 'originals')), []);
});
test('explicit delete revokes download and removes only the owned encrypted original, including exact retry', async t => {
  const f = await fixture(t);
  const headers = { Authorization: 'owner', 'Content-Type': 'application/octet-stream', 'If-Match': '"1"', 'Idempotency-Key': 'upload' };
  assert.equal((await fetch(`${f.origin}${f.path}`, { method: 'PUT', headers, body })).status, 200);
  const target = `${f.origin}/api/v1/knowledge/documents/${f.records.document.id}`;
  for (let repeat = 0; repeat < 2; repeat++) {
    assert.equal((await fetch(target, { method: 'DELETE', headers: { Authorization: 'owner', 'If-Match': '"1"', 'Idempotency-Key': 'delete' } })).status, 204);
  }
  assert.equal((await fetch(`${f.origin}${f.path}`, { headers: { Authorization: 'owner' } })).status, 404);
  assert.deepEqual(await readdir(join(f.root, 'originals')), []);
});
test('confirmed database rollback removes private copy, uncertain commit preserves it for status reconciliation', async t => {
  const root = await mkdtemp(join(tmpdir(), 'shensi-knowledge-rollback-')); t.after(() => rm(root, { recursive: true, force: true }));
  const repository = new MemoryKnowledgeRepository(), ctx = knowledgeContext();
  const { document, version } = await repository.createDocument(ctx, { ...validInput, bytes: body.length }, 'create');
  const service = new KnowledgeService({ repository, files: createKnowledgeFileStore({ root, secret }), crypto: createKnowledgeCrypto(secret) });
  repository.completeUpload = async () => { throw new Error('synthetic_database_failed'); };
  await assert.rejects(service.acceptOriginal(ctx, document.id, version.id, Readable.from([body]), 1, 'upload'), /knowledge_upload_unavailable/);
  assert.deepEqual(await readdir(join(root, 'originals')), []);
  repository.getVersion = async () => { throw new Error('synthetic_database_unavailable'); };
  // The initial authorization must succeed; make only the post-write lookup fail.
  let lookups = 0; repository.getVersion = async () => { if (lookups++ === 0) return version; throw new Error('unavailable'); };
  await assert.rejects(service.acceptOriginal(ctx, document.id, version.id, Readable.from([body]), 1, 'uncertain'), /knowledge_upload_unavailable/);
  assert.equal((await readdir(join(root, 'originals'))).length, 1);
});
