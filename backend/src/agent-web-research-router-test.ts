import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { AgentWebResearchService } from './agent-web-research.js';
import { createAgentWebResearchRouter } from './agent-web-research-router.js';
import { workspace } from './financial-council-repository-contract-test.js';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { loadGrowthContractRelease } from './growth-openapi.js';

test('public research HTTP rejects private payload and has scoped no-store source results', async () => {
  let searches = 0;
  const service = new AgentWebResearchService({ connections: async () => [{ id: 'search', provider: 'fixture', name: 'Fixture' }],
    search: async () => { searches++; return { provider: 'fixture', sources: [{ title: 'Evidence', url: 'https://example.org/source', snippet: 'Public excerpt', fetchedAt: '2026-09-24T10:00:00Z' }] }; },
    answer: async () => ({ answer: '公共摘要回答', citationIds: ['S1'], model: 'fixture', provider: 'fixture' }) });
  const app = express(); app.use(express.json());
  app.use(createAgentWebResearchRouter({ service, workspaceContext: () => ({ ...workspace('ws'), capabilities: ['finance.council.run'] }) }));
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/public-research`;
  try {
    const list = await fetch(base); assert.equal(list.status, 200); assert.equal(list.headers.get('cache-control'), 'no-store');
    assert.equal((await list.json()).connections[0].id, 'search');
    const post = (body: unknown) => fetch(base, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const input = { query: '公开查询', connectionId: 'search', role: 'cfo' };
    assert.equal((await post({ ...input, documentId: 'private-file' })).status, 422); assert.equal(searches, 0);
    const result = await post(input); assert.equal(result.status, 200); assert.equal(result.headers.get('cache-control'), 'no-store');
    const value = await result.json();
    assert.equal(value.sources[0].url, 'https://example.org/source'); assert.equal(searches, 1);
    const released = loadGrowthContractRelease().document as any;
    const components = structuredClone(released.components);
    for (const schema of Object.values(components.schemas)) if (schema && typeof schema === 'object') delete (schema as any).$id;
    const ajv = new Ajv2020({ strict: false, allErrors: true }); addFormats(ajv);
    const validate = ajv.compile({ $schema: 'https://json-schema.org/draft/2020-12/schema', components,
      ...released.paths['/api/v1/finance/public-research'].post.responses['200'].content['application/json'].schema });
    assert.equal(validate(value), true, JSON.stringify(validate.errors));
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});
