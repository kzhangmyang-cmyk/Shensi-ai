import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { createFinanceDocumentRouter } from './finance-document-router.js';
import { FinanceDocumentService } from './finance-document-service.js';
import { workspace } from './financial-council-repository-contract-test.js';

test('attachment removal checks exact conversation and role and preserves unrelated selections', async () => {
  const service = new FinanceDocumentService();
  const context = { ...workspace('attachment-router'), capabilities: ['finance.council.run'] as const };
  const app = express(); app.use(express.json());
  app.use('/api/v1/finance', createFinanceDocumentRouter({ service, workspaceContext: () => context }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/finance/documents`;
  const post = (path: string, body: unknown) => fetch(`${base}/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const scope = { conversationKey: '12345678-1234-4234-8234-123456789012', role: 'cost' as const };
  try {
    const upload = await post('inspect', { fileName: 'sample.csv', mediaType: 'text/csv', contentBase64: Buffer.from('项目,金额\n材料,100').toString('base64'), readWithModel: false, attachmentScope: scope });
    assert.equal(upload.status, 200);
    const { documentId } = await upload.json();
    assert.equal((await post('attachments/clear', { documentId, ...scope, role: 'tax' })).status, 409);
    assert.ok(service.selected(context, documentId, scope));
    assert.equal((await post('attachments/clear', { documentId, ...scope, workspaceId: 'other' })).status, 422);
    assert.equal((await post('attachments/clear?extra=1', { documentId, ...scope })).status, 422);
    const removed = await post('attachments/clear', { documentId, ...scope });
    assert.equal(removed.status, 204);
    assert.equal(removed.headers.get('cache-control'), 'no-store');
    assert.throws(() => service.selected(context, documentId, scope), /finance_document_expired/);
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});

test('document inspect route is versioned, closed and only selects after explicit AI read', async () => {
  let calls = 0;
  const service = new FinanceDocumentService({ model: async input => { calls++; return {
    inspection: { ...input.inspection, modelStatus: 'completed', observations: [] }, provider: 'stub', model: 'stub'
  }; } });
  const context = { ...workspace('doc-router'), capabilities: ['finance.council.run'] as const };
  const app = express(); app.use(express.json());
  app.use('/api/v1/finance', createFinanceDocumentRouter({ service, workspaceContext: () => context }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/finance/documents/inspect`;
  const body = { fileName: 'single.csv', mediaType: 'text/csv', contentBase64: Buffer.from('备注\n待核对').toString('base64'), readWithModel: false };
  const post = (value: unknown) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
  try {
    const local = await post(body); assert.equal(local.status, 200); assert.equal(local.headers.get('cache-control'), 'no-store');
    assert.equal((await local.json()).selectedForConversation, false); assert.equal(calls, 0);
    const read = await post({ ...body, readWithModel: true }); assert.equal(read.status, 200);
    const selected = await read.json(); assert.equal(selected.selectedForConversation, true);
    assert.equal(service.selected(context)?.material.documentId, selected.documentId); assert.equal(calls, 1);
    const selectionUrl = url.replace('/documents/inspect', '/documents/selection');
    assert.equal((await fetch(`${selectionUrl}?unexpected=1`, { method: 'DELETE' })).status, 422);
    assert.equal((await fetch(selectionUrl, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 422);
    assert.ok(service.selected(context));
    assert.equal((await fetch(selectionUrl, { method: 'DELETE' })).status, 204);
    assert.equal(service.selected(context), null);
    assert.equal((await fetch(selectionUrl, { method: 'DELETE' })).status, 204);
    assert.equal((await post({ ...body, packageId: 'invented' })).status, 422);
    for (const mediaType of ['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document']) {
      const invalid = await post({ ...body, mediaType, readWithModel: true });
      assert.equal(invalid.status, 422);
      const error = await invalid.json();
      assert.equal(error.code, 'finance_document_artifact_invalid');
      assert.deepEqual(Object.keys(error).sort(), ['code', 'details', 'message', 'requestId', 'retryable']);
      assert.equal(service.selected(context), null); assert.equal(calls, 1);
    }
    assert.equal((await fetch(url, { method: 'GET' })).status, 404);
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});
