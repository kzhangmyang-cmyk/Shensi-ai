import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { mountCfoConversation } from './cfo-conversation';
import type { GrowthHttpClient } from '../http';

const { document } = parseHTML('<html><body data-session-workspace-id="ws" data-session-user-id="user"><main></main></body></html>');
const host = document.querySelector('main')!;
const requests: Array<{ path: string; body: any }> = [];
const http: GrowthHttpClient = { async request(path, options) {
  requests.push({ path, body: options?.body });
  if (path.endsWith('/cfo-sessions')) return { status: 200, etag: null, body: [] } as never;
  if (path.endsWith('/inspect')) return { status: 200, etag: null, body: {
    documentId: '22345678-1234-4234-8234-123456789012', fileName: '聊天.csv', expiresAt: new Date(Date.now() + 3600000).toISOString(),
    fileHash: `sha256:${'a'.repeat(64)}`, selectedForConversation: true, modelStatus: 'not_requested',
    classification: 'unknown', cells: [], regions: [], uncertain: [], observations: [], missingStatements: []
  } } as never;
  if (path.endsWith('/cfo-conversation')) return { status: 200, etag: null, body: { answer: '资料回答', model: 'fixture', material: null } } as never;
  return { status: 200, etag: null, body: null } as never;
} };
const view = mountCfoConversation({ host, http, scope: () => 'ws:user' });
const picker = host.querySelector<HTMLInputElement>('[data-chat-files]');
assert.ok(picker, 'the actual conversation composer must expose file upload');
Object.defineProperty(picker, 'files', { value: [new File(['项目,金额\n材料,100'], '聊天.csv')] });
picker.dispatchEvent(new document.defaultView!.Event('change'));
await new Promise(resolve => setTimeout(resolve, 0));
const upload = requests.find(request => request.path.endsWith('/inspect'))!;
assert.equal(upload.body.readWithModel, false);
assert.equal(requests.filter(request => request.path.endsWith('/cfo-conversation')).length, 0);
host.querySelector<HTMLTextAreaElement>('textarea')!.value = '解读附件';
host.querySelector('[data-cfo-question-form]')!.dispatchEvent(new document.defaultView!.Event('submit', { bubbles: true, cancelable: true }));
await new Promise(resolve => setTimeout(resolve, 0));
const ask = requests.find(request => request.path.endsWith('/cfo-conversation'))!;
assert.equal(ask.body.documentId, '22345678-1234-4234-8234-123456789012');
assert.equal(ask.body.conversationKey, upload.body.attachmentScope.conversationKey);
assert.equal(ask.body.role, 'cfo');
assert.equal(requests.filter(request => /cfo-sessions/.test(request.path) && request.body).length, 0, 'temporary attachments must not enter persisted legacy sessions');
view.dispose();
console.log('real chat attachment integration passed');
