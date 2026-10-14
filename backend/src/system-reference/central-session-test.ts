import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import * as access from './binding-service.js';
import { retrievalEnvironment, retrievalFixture } from './retrieval-test-support.js';
import { SystemReferenceService } from './retrieval.js';

test('central normal-session proof uses fresh authority without creating a reader binding and retains quotas', async () => {
  assert.equal(typeof access.createCentralSessionAccess, 'function', 'central session proof required');
  const e = await retrievalEnvironment(), f = retrievalFixture();
  await e.publish(f);
  // The authority remains real; only its persistence boundary is synthetic.
  const { createReferenceAuthorityReader } = await import('./authority.js');
  const authority = createReferenceAuthorityReader({ now: e.now, readSnapshot: async id => ({
    user: { id, teamId: 'workspace', ...e.user }, platform: e.state
  }) });
  const identity = { actorId: 'reader', workspaceId: 'workspace', authVersion: 1 };
  const a = await access.createCentralSessionAccess(authority, identity);
  assert.deepEqual(JSON.stringify(a), '{}');
  assert.throws(() => access.referenceAccessProof(JSON.parse(JSON.stringify(a))), /reader_invalid/);
  const b = await access.createCentralSessionAccess(authority, identity);
  assert.equal(access.referenceAccessProof(a).bindingId, access.referenceAccessProof(b).bindingId);
  assert.equal(e.bindings.records.size, 0);
  const service = new SystemReferenceService(e.repo, { corpusId: f.manifest.corpusId, now: e.now });
  const input = () => ({ vocabularyVersion: 'finance-topics.v1' as const, role: 'finance' as const, topicIds: ['budget_variance' as const], requestId: randomUUID() });
  const result = await service.query({ access: a, ip: 'central-internal' }, input());
  assert.equal(result.status, 'used');
  for (let n = 0; n < 4; n++) await service.query({ access: await access.createCentralSessionAccess(authority, identity), ip: 'central-internal' }, input());
  assert.equal((await service.query({ access: b, ip: 'central-internal' }, input())).status, 'rate_limited');
  e.state.revision++;
  await assert.rejects(access.referenceAccessProof(a).authorize(), /reader_invalid/);
  e.user.authVersion++;
  await assert.rejects(access.createCentralSessionAccess(authority, identity), /reader_invalid/);
});
