import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentWebResearchService } from './agent-web-research.js';
import { workspace } from './financial-council-repository-contract-test.js';

const context = { ...workspace('web-test'), capabilities: ['finance.council.run'] as const };
test('retrieval alone returns five unique safe sources without generating a second answer', async () => {
  let searches = 0; let answers = 0;
  const source = (url: string) => ({ title: '公开政策', url, snippet: '政策摘要', fetchedAt: '2026-09-24T10:00:00Z' });
  const service = new AgentWebResearchService({
    connections: async () => [{ id: 'search-1', provider: 'fixture', name: '搜索' }],
    search: async () => { searches++; return { provider: 'fixture', sources: [
      source('javascript:alert(1)'), source('https://example.org/1'), source('https://example.org/1'),
      ...[2, 3, 4, 5, 6].map(i => source(`https://example.org/${i}`))] }; },
    answer: async () => { answers++; return { answer: '独立答案', citationIds: ['S1'], model: 'fixture', provider: 'fixture' }; }
  });
  const result = await service.retrieve(context, { query: '公开政策', connectionId: 'search-1', role: 'tax' });
  assert.deepEqual(result.sources.map(s => [s.id, s.url]), [
    ['S1','https://example.org/1'], ['S2','https://example.org/2'], ['S3','https://example.org/3'],
    ['S4','https://example.org/4'], ['S5','https://example.org/5']]);
  assert.equal(result.evidenceKind, 'search_index_snippets');
  assert.equal(result.query, '公开政策'); assert.equal(result.searchProvider, 'fixture');
  assert.ok(Number.isFinite(Date.parse(result.retrievedAt)));
  assert.equal(searches, 1); assert.equal(answers, 0);
});

test('retrieval cancellation prevents exposing late sources or starting an answer', async () => {
  const controller = new AbortController(); let answers = 0;
  const service = new AgentWebResearchService({
    connections: async () => [{ id: 'search-1', provider: 'fixture', name: '搜索' }],
    search: async () => { controller.abort(); return { provider: 'fixture', sources: [
      { title: '公开政策', url: 'https://example.org/1', snippet: '摘要', fetchedAt: '2026-09-24T10:00:00Z' }] }; },
    answer: async () => { answers++; return { answer: '不应生成', citationIds: ['S1'], model: 'fixture', provider: 'fixture' }; }
  });
  await assert.rejects(service.retrieve(context, { query: '公开政策', connectionId: 'search-1', role: 'cfo' }, controller.signal), { name: 'AbortError' });
  assert.equal(answers, 0);
});

test('web research sends only explicit public keywords and returns provider-backed citations', async () => {
  const calls: unknown[] = [];
  const service = new AgentWebResearchService({
    connections: async () => [{ id: 'search-1', provider: 'tavily', name: '搜索连接' }],
    search: async input => { calls.push(input); return { provider: 'tavily', sources: [
      { title: '公开依据', url: 'https://example.org/policy', snippet: '公开政策摘要', fetchedAt: '2026-09-24T10:00:00Z' },
      { title: '非法链接', url: 'javascript:alert(1)', snippet: '不应出现', fetchedAt: '2026-09-24T10:00:00Z' }
    ] }; },
    answer: async input => { calls.push(input); return { answer: '公开来源说明了政策，适用情况还需核对。', citationIds: ['S1'], model: 'fixture', provider: 'fixture' }; }
  });
  const result = await service.run(context, { query: '公共政策', connectionId: 'search-1', role: 'tax' });
  assert.equal(result.sources.length, 1); assert.equal(result.sources[0].url, 'https://example.org/policy');
  assert.deepEqual(result.citationIds, ['S1']);
  assert.equal((calls[0] as any).query, '公共政策');
  assert.deepEqual(Object.keys(calls[0] as object).sort(), ['connectionId', 'context', 'query', 'signal']);
  assert.equal((calls[1] as any).role, 'tax');
  await assert.rejects(service.run(context, { query: '公共政策', connectionId: 'search-1', role: 'tax', history: ['秘密'] }), /agent_web_input_invalid/);
  await assert.rejects(service.run(context, { query: '公共政策', connectionId: 'foreign', role: 'tax' }), /agent_web_connection_unavailable/);
  assert.equal(calls.length, 2);
});

test('search failure and missing evidence cannot produce an invented researched answer', async () => {
  let answers = 0;
  const base = { connections: async () => [{ id: 'search-1', provider: 'tavily', name: '搜索连接' }],
    answer: async () => { answers++; return { answer: '不应调用', citationIds: ['S9'], model: 'fixture', provider: 'fixture' }; } };
  const missing = new AgentWebResearchService({ ...base, search: async () => ({ provider: 'tavily', sources: [] }) });
  await assert.rejects(missing.run(context, { query: '公开资料', connectionId: 'search-1', role: 'cfo' }), /agent_web_no_sources/);
  const failure = new AgentWebResearchService({ ...base, search: async () => { throw new Error('provider failed'); } });
  await assert.rejects(failure.run(context, { query: '公开资料', connectionId: 'search-1', role: 'cfo' }));
  assert.equal(answers, 0);
  const badCitation = new AgentWebResearchService({ ...base, search: async () => ({ provider: 'tavily', sources: [
    { title: '公开依据', url: 'https://example.org/source', snippet: '公开摘要', fetchedAt: '2026-09-24T10:00:00Z' }
  ] }) });
  await assert.rejects(badCitation.run(context, { query: '公开资料', connectionId: 'search-1', role: 'cfo' }), /agent_web_answer_invalid/);
});
