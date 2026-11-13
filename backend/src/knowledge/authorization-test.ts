import assert from 'node:assert/strict';
import test from 'node:test';
import { createMemoryStore } from '../store.js';
import { createKnowledgeJobAuthorizer } from './authorization.js';

test('knowledge persisted job uses current account, membership and platform authorization', async () => {
  const store = createMemoryStore({ users: [{ id: 'actor', name: 'synthetic', email: 'synthetic@invalid.local', password: 'not-used',
    role: 'admin', teamId: 'team-a', avatar: '', status: 'active', authVersion: 1 }], platformAdminStates: [] });
  const authorize = createKnowledgeJobAuthorizer(store), claim = { jobId: 'job', documentId: 'doc', versionId: 'version', actorId: 'actor', workspaceId: 'team-a', fence: 1, leaseUntil: Date.now() + 60_000 };
  assert.equal((await authorize(claim)).actorId, 'actor');
  store.users[0].teamId = 'team-b'; await assert.rejects(authorize(claim), /knowledge_authorization_revoked/);
  store.users[0].teamId = 'team-a'; store.users[0].status = 'disabled'; await assert.rejects(authorize(claim), /knowledge_authorization_revoked/);
  store.users[0].status = 'active';
  store.platformAdminStates.push({ revision: 1, memberships: [], plans: [], audits: [], workspaces: [{ id: 'team-a', name: 'synthetic', contact: '', status: 'suspended', planVersionId: null, startsAt: null, expiresAt: null, revision: 1 }] });
  await assert.rejects(authorize(claim), /knowledge_authorization_revoked/);
});
