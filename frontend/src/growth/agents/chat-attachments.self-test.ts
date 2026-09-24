import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { mountChatAttachments } from './chat-attachments';
import type { GrowthHttpClient } from '../http';

const { document } = parseHTML('<html><body data-session-workspace-id="ws" data-session-user-id="user"><main></main></body></html>');
const host = document.querySelector('main')!;
const calls: Array<{ path: string; body: any }> = [];
const http: GrowthHttpClient = { async request(path, options) {
  calls.push({ path, body: options?.body });
  return { status: 200, etag: null, body: path.endsWith('/inspect') ? {
    documentId: '22345678-1234-4234-8234-123456789012', fileName: '附件.csv', expiresAt: new Date(Date.now() + 3600000).toISOString(),
    fileHash: `sha256:${'a'.repeat(64)}`, selectedForConversation: true, modelStatus: 'not_requested',
    classification: 'unknown', cells: [], regions: [], uncertain: [], observations: [], missingStatements: []
  } : undefined } as never;
} };
const options = { host, http, scope: 'scope', role: 'cost' as const, onChange() {} };
let view = mountChatAttachments(options);
await view.add([new File(['数据'], '附件.csv')]);
assert.equal(calls[0].body.readWithModel, false);
assert.equal(calls[0].body.attachmentScope.role, 'cost');
const first = view.source(); assert.equal(first?.documentId, '22345678-1234-4234-8234-123456789012');
view.dispose();
view = mountChatAttachments(options);
assert.deepEqual(view.source(), first, 'ordinary route remount preserves the exact parsed source without uploading again');
assert.equal(calls.length, 1);
view.setRole('tax'); assert.equal(view.source(), null, 'another role must not inherit attachments');
view.setRole('cost'); assert.deepEqual(view.source(), first);
await view.clear(); assert.equal(view.source(), null);
assert.equal(calls.at(-1)?.path, '/api/v1/finance/documents/attachments/clear');
assert.equal(calls.at(-1)?.body.conversationKey, first?.conversationKey);
await view.add([new File(['数据'], '附件.csv')]);
view.dispose();
document.dispatchEvent(new document.defaultView!.CustomEvent('goodjob:auth-state-changed', { detail: { authenticated: false } }));
view = mountChatAttachments(options); assert.equal(view.source(), null, 'logout clears even an unmounted role draft');
view.dispose();
console.log('chat attachment state tests passed');
