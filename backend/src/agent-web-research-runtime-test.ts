import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgentWebResearchRuntime } from './agent-web-research-runtime.js';
import { createDefaultProviderCatalog } from './provider-catalog.js';
import { workspace } from './financial-council-repository-contract-test.js';
import type { ProviderConnection } from './types.js';
import { encryptAiModelApiKey } from './credential-security.js';
import type { DurableModelRuntimeStore } from './model-providers/runtime.js';

test('web runtime selects only current owned real search connections and preserves provider evidence', async () => {
  const context = { ...workspace('team-a'), actorId: 'owner-a', teamId: 'team-a', capabilities: ['finance.council.run'] as const };
  const connection = { id: 'real-search', providerId: 'tavily', ownerId: 'owner-a', teamId: 'team-a', scope: 'personal', status: 'active' } as ProviderConnection;
  let queries = 0; let persisted = 0;
  const store = { providerConnections: [connection, { ...connection, id: 'foreign', ownerId: 'other' }, { ...connection, id: 'fake', providerId: 'ai_search' }],
    providerCatalog: createDefaultProviderCatalog(), providerRequestLogs: [], async persist() { persisted++; } };
  const runtime = createAgentWebResearchRuntime(store as never, {
    executeSearch: async input => {
      queries++; assert.equal(input.query.goal, '政策公开资料'); assert.equal(input.query.customerType, '');
      assert.equal(input.query.productKeywords, ''); assert.equal(input.context.ownerId, context.actorId);
      input.onLogs([{ id: 'log-fixture', ownerId: context.actorId, teamId: context.teamId, connectionId: connection.id, providerId: 'tavily',
        runId: input.context.runId, runShardId: input.context.runShardId, requestFingerprint: 'a'.repeat(64), endpointCode: 'search', httpStatus: 200,
        attempt: 1, quotaUnits: 1, costAmount: 0, currency: '', durationMs: 1, responseSize: 50, errorCode: '', requestedAt: '2026-09-24T10:00:00Z' }]);
      return { records: [{ company: '公开依据', sourceUrl: 'https://example.org/source', description: '来自提供商的摘要', fetchedAt: '2026-09-24T10:00:00Z' }] } as never;
    },
    answer: async input => { assert.equal(input.sources[0].snippet, '来自提供商的摘要'); return { answer: '依据摘要，仍需核对原文。', citationIds: ['S1'], model: 'fixture', provider: 'fixture' }; }
  });
  assert.deepEqual((await runtime.connections(context)).map(item => item.id), ['real-search']);
  const result = await runtime.run(context, { query: '政策公开资料', connectionId: 'real-search', role: 'tax' });
  assert.equal(result.sources[0].fetchedAt, '2026-09-24T10:00:00.000Z');
  assert.equal(queries, 1); assert.equal(persisted, 1);
  await assert.rejects(runtime.run(context, { query: '政策公开资料', connectionId: 'foreign', role: 'tax' }));
  assert.equal(queries, 1);
});

test('configured model gateway receives only public sources and rejects invented citations', async () => {
  const previous = process.env.PROVIDER_CREDENTIAL_KEY; process.env.PROVIDER_CREDENTIAL_KEY = 'isolated-web-research-fixture-key';
  try {
    const context = { ...workspace('web-model'), actorId: 'fixture-owner', teamId: 'web-model', capabilities: ['finance.council.run'] as const };
    const config = { id: 'web-fixture-model', provider: 'moonshot', protocol: 'openai-compatible', name: 'fixture',
      baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k', apiKey: '', enabled: true, temperature: 0.1,
      useLeadFinder: false, useWebsiteParse: false, useScoring: false, useEmailDraft: false, useExam: false,
      lastTestStatus: 'untested', lastTestMessage: '', ownerId: context.actorId, teamId: context.teamId, credentialVersion: 1,
      capabilitySnapshot: { structuredOutput: true, toolCalling: true, parallelToolCalling: false, streaming: true, modelListing: true },
      createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' } as const;
    const models: DurableModelRuntimeStore = { aiModelConfigs: [config], modelCredentialVersions: [{ connectionId: config.id, provider: config.provider,
      ownerId: config.ownerId, teamId: config.teamId, version: 1, credentialRef: 'fixture-v1', apiKeyEncrypted: encryptAiModelApiKey(config, 'synthetic-key-only'),
      keyMask: 'fixture', createdBy: context.actorId, createdAt: config.createdAt }], aiJobModelSnapshots: [], pendingAiJobModelSnapshots: [], modelCallRecords: [], pendingModelCallRecords: [], async persist() {} };
    const store = { ...models, providerConnections: [{ id: 'search', providerId: 'tavily', ownerId: context.actorId, teamId: context.teamId, scope: 'personal', status: 'active' } as ProviderConnection], providerCatalog: createDefaultProviderCatalog(), providerRequestLogs: [] };
    let invalid = false; let modelCalls = 0;
    const service = createAgentWebResearchRuntime(store, {
      executeSearch: async input => {
        input.onLogs([{ id: `log-${modelCalls}`, ownerId: context.actorId, teamId: context.teamId, connectionId: 'search', providerId: 'tavily', runId: input.context.runId,
          runShardId: input.context.runShardId, requestFingerprint: 'a'.repeat(64), endpointCode: 'search', httpStatus: 200, attempt: 1, quotaUnits: 1,
          costAmount: 0, currency: '', durationMs: 1, responseSize: 50, errorCode: '', requestedAt: '2026-09-24T10:00:00Z' }]);
        return { records: [{ company: '公开方法', sourceUrl: 'https://example.org/method', description: '方法摘要', fetchedAt: '2026-09-24T10:00:00Z' }] } as never;
      },
      modelFetch: async (_url, init) => {
        modelCalls++; const outgoing = JSON.parse(String(init?.body));
        const firstUser = outgoing.messages.find((item: any) => item.role === 'user');
        const payload = JSON.parse(firstUser.content.replace(/^BEGIN_UNTRUSTED_DATA\n/, '').replace(/\nEND_UNTRUSTED_DATA$/, ''));
        assert.deepEqual(Object.keys(payload).sort(), ['evidenceKind', 'question', 'sources']);
        assert.equal(payload.sources[0].url, 'https://example.org/method');
        return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ answer: '公开方法建议核对来源。', citationIds: [invalid ? 'S9' : 'S1'] }) }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
    });
    const result = await service.run(context, { query: '公开方法', connectionId: 'search', role: 'cost' });
    assert.equal(result.model, 'moonshot-v1-8k'); assert.deepEqual(result.citationIds, ['S1']); assert.equal(modelCalls, 1);
    invalid = true;
    await assert.rejects(service.run(context, { query: '公开方法', connectionId: 'search', role: 'cost' }));
  } finally { if (previous === undefined) delete process.env.PROVIDER_CREDENTIAL_KEY; else process.env.PROVIDER_CREDENTIAL_KEY = previous; }
});
