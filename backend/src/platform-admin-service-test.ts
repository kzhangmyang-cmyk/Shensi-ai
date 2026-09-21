import assert from 'node:assert/strict';
import test from 'node:test';
import { TOTP } from 'otpauth';
import { getStore } from './store.js';
import { bootstrapPlatformOwner, platformMember, platformState, savePlatformPlan, verifyPlatformMfa } from './platform-admin-service.js';

function fixture() {
  const store = { ...getStore(), users: [{ id: 'synthetic-owner', name: 'Synthetic owner', email: 'owner@example.test', password: 'unused', role: 'admin' as const, teamId: 'synthetic-workspace', avatar: 'SO', status: 'active' as const }], platformAdminStates: [], persistMutation: undefined, persist: async () => {} };
  return store;
}

test('customer admin has no implicit platform authority; bootstrap stores only encrypted MFA secret', async () => {
  const store = fixture();
  assert.throws(() => platformMember(store, 'synthetic-owner'), /无平台运营权限/);
  const totp = new TOTP();
  await bootstrapPlatformOwner(store, 'synthetic-owner', totp.secret.base32);
  assert.equal(platformMember(store, 'synthetic-owner').role, 'owner');
  assert.ok(!JSON.stringify(platformState(store)).includes(totp.secret.base32));
  await assert.rejects(bootstrapPlatformOwner(store, 'synthetic-owner', totp.secret.base32), /已经初始化/);
});

test('MFA proof is single-use and failed commit does not consume it', async () => {
  const store = fixture(), totp = new TOTP();
  await bootstrapPlatformOwner(store, 'synthetic-owner', totp.secret.base32);
  const now = Date.now(), token = totp.generate({ timestamp: now });
  store.persist = async () => { throw new Error('commit failed'); };
  await assert.rejects(verifyPlatformMfa(store, 'synthetic-owner', token, now), /commit failed/);
  store.persist = async () => {};
  assert.equal(await verifyPlatformMfa(store, 'synthetic-owner', token, now), 1);
  await assert.rejects(verifyPlatformMfa(store, 'synthetic-owner', token, now), /已使用/);
});

test('plan versions preserve old grants and failed mutation preserves state/audit', async () => {
  const store = fixture();
  await bootstrapPlatformOwner(store, 'synthetic-owner', new TOTP().secret.base32);
  const before = structuredClone(platformState(store));
  const input = { code: 'trial', features: ['agents'], seatLimit: 2, durationDays: 7, published: true };
  store.persist = async () => { throw new Error('commit failed'); };
  await assert.rejects(savePlatformPlan(store, 'synthetic-owner', before.revision, input, 'synthetic configuration'), /commit failed/);
  assert.deepEqual(platformState(store), before);
  store.persist = async () => {};
  const plan = await savePlatformPlan(store, 'synthetic-owner', before.revision, input, 'synthetic configuration');
  assert.equal(plan.id, 'trial:2');
  assert.equal(platformState(store).plans.find(row => row.id === 'trial:1')?.published, false);
  await assert.rejects(savePlatformPlan(store, 'synthetic-owner', before.revision, input, 'stale write'), /记录已更新/);
});
