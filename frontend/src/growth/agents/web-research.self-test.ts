import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { mountAgentWebResearch } from './web-research';
import type { GrowthHttpClient } from '../http';

const { document } = parseHTML('<html><body data-session-workspace-id="ws" data-session-user-id="user"><main></main></body></html>');
const host = document.querySelector('main')!;
const calls: any[] = []; let fail = false;
const http: GrowthHttpClient = { async request(path, options) {
  if (!options?.method) return { body: { connections: [{ id: 'search', provider: 'tavily', name: 'Tavily' }] } } as never;
  calls.push(options.body);
  if (fail) throw new Error('provider failed');
  return { body: { answer: '这是公开摘要结论', citationIds: ['S1'], model: 'fixture', provider: 'fixture', searchProvider: 'tavily', query: '公开政策',
    retrievedAt: '2026-09-24T10:00:00Z', evidenceKind: 'search_index_snippets',
    sources: [{ id: 'S1', title: '来源标题', url: 'https://example.org/source', snippet: '实际摘要', fetchedAt: '2026-09-24T10:00:00Z' }] } } as never;
} };
const options = { host, http, scope: 'ws:user', role: 'tax' as const };
let panel = mountAgentWebResearch(options); await new Promise(resolve => setTimeout(resolve, 0));
assert.equal(calls.length, 0, 'opening tool makes no search/model call');
const input = host.querySelector<HTMLInputElement>('[data-web-query]')!; input.value = '公开政策';
input.dispatchEvent(new document.defaultView!.Event('input'));
host.querySelector<HTMLButtonElement>('[data-web-run]')!.click(); await new Promise(resolve => setTimeout(resolve, 0));
assert.deepEqual(calls[0], { query: '公开政策', connectionId: 'search', role: 'tax' });
assert.equal(host.querySelector<HTMLAnchorElement>('[data-web-results] a')?.href, 'https://example.org/source');
assert.match(host.textContent!, /实际摘要/);
panel.dispose(); panel = mountAgentWebResearch(options); await new Promise(resolve => setTimeout(resolve, 0));
assert.equal(host.querySelector<HTMLInputElement>('[data-web-query]')!.value, '公开政策');
assert.match(host.textContent!, /这是公开摘要结论/); assert.equal(calls.length, 1);
panel.setRole('cost'); assert.equal(host.querySelector<HTMLInputElement>('[data-web-query]')!.value, '');
panel.setRole('tax'); fail = true; host.querySelector<HTMLButtonElement>('[data-web-run]')!.click(); await new Promise(resolve => setTimeout(resolve, 0));
assert.match(host.textContent!, /未完成/); assert.equal(calls.length, 2);
panel.dispose();
document.dispatchEvent(new document.defaultView!.CustomEvent('goodjob:auth-state-changed', { detail: { authenticated: false } }));
panel = mountAgentWebResearch(options); await new Promise(resolve => setTimeout(resolve, 0));
assert.equal(host.querySelector<HTMLInputElement>('[data-web-query]')!.value, ''); panel.dispose();

let resolveLate: ((value: any) => void) | undefined; let requestSignal: AbortSignal | undefined;
const delayed: GrowthHttpClient = { async request(path, request) {
  if (!request?.method) return http.request(path, request) as never;
  requestSignal = request.signal;
  return new Promise(resolve => { resolveLate = resolve; }) as never;
} };
panel = mountAgentWebResearch({ ...options, http: delayed }); await new Promise(resolve => setTimeout(resolve, 0));
const delayedQuery = host.querySelector<HTMLInputElement>('[data-web-query]')!;
delayedQuery.value = '新的公开问题'; delayedQuery.dispatchEvent(new document.defaultView!.Event('input'));
host.querySelector<HTMLButtonElement>('[data-web-run]')!.click();
assert.equal(host.querySelector<HTMLButtonElement>('[data-web-run]')!.disabled, true);
panel.clear(); assert.equal(requestSignal?.aborted, true, 'new dialogue aborts pending public research');
assert.equal(delayedQuery.value, '');
resolveLate?.({ body: { answer: '迟到结果不可恢复' } }); await new Promise(resolve => setTimeout(resolve, 0));
assert.doesNotMatch(host.textContent!, /迟到结果不可恢复/);
delayedQuery.value = '退出前的公开问题'; delayedQuery.dispatchEvent(new document.defaultView!.Event('input'));
host.querySelector<HTMLButtonElement>('[data-web-run]')!.click();
document.dispatchEvent(new document.defaultView!.CustomEvent('goodjob:auth-state-changed', { detail: { authenticated: false } }));
assert.equal(requestSignal?.aborted, true, 'logout aborts pending public research');
assert.equal(delayedQuery.value, ''); assert.equal(host.querySelector<HTMLButtonElement>('[data-web-run]')!.disabled, true);
resolveLate?.({ body: { answer: '旧身份结果不可恢复' } }); await new Promise(resolve => setTimeout(resolve, 0));
assert.doesNotMatch(host.textContent!, /旧身份结果不可恢复/); panel.dispose();
console.log('web research panel tests passed');
