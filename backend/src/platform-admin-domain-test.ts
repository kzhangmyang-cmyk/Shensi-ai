import assert from 'node:assert/strict';
import test from 'node:test';
import { emptyPlatformState, evaluatePlatformAccess, planDraftSchema } from './platform-admin-domain.js';

test('draft plans cannot silently publish undefined commercial rules', () => {
  const state = emptyPlatformState();
  assert.equal(state.plans.length, 3);
  for (const plan of state.plans) {
    const { id, version, ...draft } = plan;
    assert.equal(planDraftSchema.safeParse(draft).success, true);
    assert.equal(planDraftSchema.safeParse({ ...draft, published: true }).success, false);
  }
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
