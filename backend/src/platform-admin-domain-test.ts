import assert from 'node:assert/strict';
import test from 'node:test';
import { emptyPlatformState, evaluatePlatformAccess, planDraftSchema, summarizeCustomerAccess } from './platform-admin-domain.js';

test('draft plans cannot silently publish undefined commercial rules', () => {
  const state = emptyPlatformState();
  assert.equal(state.plans.length, 3);
  for (const plan of state.plans) {
    const { id, version, ...draft } = plan;
    assert.equal(planDraftSchema.safeParse(draft).success, true);
    assert.equal(planDraftSchema.safeParse({ ...draft, published: true }).success, false);
  }
});

test('customer summary contains only own workspace and distinguishes every commercial state', () => {
  const state = emptyPlatformState(), now = Date.now();
  state.plans[0] = { ...state.plans[0], published: true, features: ['crm'], seatLimit: 2, durationDays: 7 };
  const workspace = { id: 'own', name: 'Own enterprise', contact: 'private contact', status: 'pending' as 'pending' | 'active' | 'suspended', planVersionId: null as string | null, startsAt: null as string | null, expiresAt: null as string | null, revision: 1 };
  state.workspaces.push(workspace, { ...workspace, id: 'other', name: 'Other secret enterprise' });
  assert.equal(summarizeCustomerAccess(state, 'legacy', now).status, 'unmanaged');
  assert.equal(summarizeCustomerAccess(state, 'own', now).status, 'pending');
  workspace.status = 'suspended'; assert.equal(summarizeCustomerAccess(state, 'own', now).status, 'suspended');
  workspace.status = 'active'; assert.equal(summarizeCustomerAccess(state, 'own', now).status, 'unconfigured');
  workspace.planVersionId = 'trial:1'; workspace.startsAt = new Date(now + 1000).toISOString(); workspace.expiresAt = new Date(now + 2000).toISOString();
  assert.equal(summarizeCustomerAccess(state, 'own', now).status, 'scheduled');
  workspace.startsAt = new Date(now - 1000).toISOString();
  const active = summarizeCustomerAccess(state, 'own', now);
  assert.equal(active.status, 'active'); assert.equal(active.canExecute, true); assert.deepEqual(active.features, ['crm']);
  assert.ok(!JSON.stringify(active).includes('secret')); assert.ok(!JSON.stringify(active).includes('private contact'));
  const expired = summarizeCustomerAccess(state, 'own', now + 2000);
  assert.equal(expired.status, 'expired'); assert.equal(expired.canRead, true); assert.equal(expired.canExecute, false);
  const provisional = summarizeCustomerAccess(state, 'own', now, true);
  assert.equal(provisional.canRead, false); assert.equal(provisional.canExecute, false); assert.deepEqual(provisional.features, []); assert.equal(provisional.workspaceName, null);
});

test('managed enterprise authorization covers expiry, module scope and suspension without changing unmanaged accounts', () => {
  const state = emptyPlatformState();
  const now = Date.UTC(2026, 8, 21);
  state.plans[0] = { ...state.plans[0], published: true, features: ['agents'], seatLimit: 2, durationDays: 7 };
  state.workspaces.push({ id: 'synthetic', name: 'Synthetic', contact: '', status: 'active', planVersionId: 'trial:1', startsAt: new Date(now - 1000).toISOString(), expiresAt: new Date(now).toISOString(), revision: 1 });
  assert.equal(evaluatePlatformAccess(state, 'existing-unmanaged', 'outreach', 'execute', now).allowed, true);
  assert.equal(evaluatePlatformAccess(state, 'synthetic', 'agents', 'execute', now).code, 'subscription_expired');
  assert.equal(evaluatePlatformAccess(state, 'synthetic', 'agents', 'read', now).allowed, true);
  assert.equal(evaluatePlatformAccess(state, 'synthetic', 'acquisition', 'read', now - 1).code, 'feature_forbidden');
  state.workspaces[0].status = 'suspended';
  assert.equal(evaluatePlatformAccess(state, 'synthetic', 'agents', 'read', now).allowed, false);
});
