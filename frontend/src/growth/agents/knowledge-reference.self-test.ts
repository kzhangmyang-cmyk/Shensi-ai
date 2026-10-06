import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { mountCfoChatMessages } from './cfo-chat-messages';
import { BUSINESS_AGENT_TEAM } from './agents';
import type { CfoConversationAnswer } from '../contracts';

export const referenceFixture: NonNullable<CfoConversationAnswer['knowledge']> = { status: 'used', detailedText: '结合资料详细分析，不将参考观点当作公司事实。', warnings: ['table_unverified'],
  sources: [{ sourceId: 'K1', documentId: '11111111-1111-4111-8111-111111111111', versionId: '22222222-2222-4222-8222-222222222222',
    chunkId: '44444444-4444-4444-8444-444444444444', sourceHash: 'a'.repeat(64), sourceLabel: '<img onerror=alert(1)>预算参考', excerpt: '预算原文', locator: { page: 17, chapter: '预算方法' }, warnings: ['table_unverified'] }] };
test('detailed text and private exact-version links remain separate from public research and use safe DOM', () => {
  const { document } = parseHTML('<html><body><main></main></body></html>'); const host = document.querySelector('main')!;
  const messages = mountCfoChatMessages({ host, agent: BUSINESS_AGENT_TEAM[0], userName: '测试' });
  messages.append({ role: 'assistant', text: '简短摘要', knowledge: referenceFixture });
  assert.match(host.querySelector('.cfo-chat-bubble > p')!.textContent!, /结合资料详细分析/);
  const source = host.querySelector<HTMLAnchorElement>('.cfo-message-knowledge a')!;
  assert.ok(source); assert.equal(source.getAttribute('target'), null);
  assert.equal(source.getAttribute('href'), `#knowledge?document=${referenceFixture.sources[0].documentId}&version=${referenceFixture.sources[0].versionId}&chunk=${referenceFixture.sources[0].chunkId}&hash=${referenceFixture.sources[0].sourceHash}`);
  assert.match(host.querySelector('.cfo-message-knowledge')!.textContent!, /物理页 17.*表格待核对/s);
  assert.equal(host.querySelector('.cfo-message-knowledge img'), null);
  assert.equal(host.querySelector('.cfo-message-research'), null);
  for (const status of ['no_match', 'unavailable'] as const) messages.append({ role: 'assistant', text: '一般回答', knowledge: { status, detailedText: '一般回答', sources: [], warnings: [] } });
  assert.match(host.textContent!, /知识库无相关命中/); assert.match(host.textContent!, /知识库暂不可用/);
  messages.append({ role: 'assistant', text: '语音短回答' });
  assert.equal(host.lastElementChild!.querySelector('.cfo-message-knowledge'), null);
  messages.dispose();
});
