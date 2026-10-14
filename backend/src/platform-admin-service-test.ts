import assert from 'node:assert/strict';
import test from 'node:test';
import { TOTP } from 'otpauth';
import { getStore } from './store.js';
import { bootstrapPlatformOwner, platformMember, platformState, savePlatformPlan, verifyPlatformMfa, customerAccess } from './platform-admin-service.js';
import { beginPlatformMutation } from './account-mutation-state.js';
import { createPlatformEnterprise, updatePlatformEnterprise, createPlatformAccount, issuePlatformPasswordReset, consumePlatformPasswordReset, recoverPlatformMfaOffline } from './platform-admin-service.js';
import { verifyPassword } from './auth.js';

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

async function managedFixture() {
  const store = fixture();
  await bootstrapPlatformOwner(store, 'synthetic-owner', new TOTP().secret.base32);
  const revision = () => platformState(store).revision;
  const workspace = await createPlatformEnterprise(store, 'synthetic-owner', revision(), { name: 'Synthetic enterprise', contact: '', account: 'synthetic_admin', password: 'Synthetic-only123' }, 'test enterprise');
  const plan = await savePlatformPlan(store, 'synthetic-owner', revision(), { code: 'trial', features: ['crm'], seatLimit: 2, durationDays: 7, published: true }, 'synthetic plan');
  await updatePlatformEnterprise(store, 'synthetic-owner', revision(), workspace.id, { status: 'active', planVersionId: plan.id, startsAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 86400000).toISOString() }, 'grant');
  return { store, workspace, revision };
}

test('member creation enforces seats, normalized duplicate, managed scope and atomic rollback', async () => {
  const { store, workspace, revision } = await managedFixture();
  const input = { workspaceId: workspace.id, name: 'Synthetic member', account: 'synthetic_member', password: 'Synthetic-only123', role: 'sales' };
  await assert.rejects(createPlatformAccount(store, 'synthetic-owner', revision(), { ...input, workspaceId: 'unmanaged' }, 'test'), /纳管/);
  await assert.rejects(createPlatformAccount(store, 'synthetic-owner', revision(), { ...input, account: ' SYNTHETIC_ADMIN ' }, 'test'), /已存在/);
  const before = JSON.stringify(platformState(store)), count = store.users.length;
  store.persist = async () => { throw new Error('commit failed'); };
  await assert.rejects(createPlatformAccount(store, 'synthetic-owner', revision(), input, 'test'), /commit failed/);
  assert.equal(store.users.length, count); assert.equal(JSON.stringify(platformState(store)), before);
  store.persist = async () => {};
  const results = await Promise.allSettled([createPlatformAccount(store, 'synthetic-owner', revision(), input, 'test'), createPlatformAccount(store, 'synthetic-owner', revision(), { ...input, account: 'second_member' }, 'test')]);
  assert.equal(results.filter(row => row.status === 'fulfilled').length, 1);
  await assert.rejects(createPlatformAccount(store, 'synthetic-owner', revision(), { ...input, account: 'third_member' }, 'test'), /席位已满/);
});

test('password recovery stores hashes only, is expiring and single-use, rolls back and revokes sessions', async () => {
  const { store, workspace, revision } = await managedFixture();
  const user = store.users.find(row => row.teamId === workspace.id)!;
  const oldVersion = user.authVersion || 1, now = Date.now();
  const issued = await issuePlatformPasswordReset(store, 'synthetic-owner', revision(), user.id, 'recover', now);
  assert.equal(user.authVersion, oldVersion + 1);
  assert.ok(!JSON.stringify(platformState(store)).includes(issued.token));
  await assert.rejects(consumePlatformPasswordReset(store, { token: issued.token, password: 'Replacement123' }, now + 900000), /过期/);
  store.persist = async () => { throw new Error('commit failed'); };
  await assert.rejects(consumePlatformPasswordReset(store, { token: issued.token, password: 'Replacement123' }, now), /commit failed/);
  assert.equal(user.authVersion, oldVersion + 1);
  store.persist = async () => {};
  const results = await Promise.allSettled([consumePlatformPasswordReset(store, { token: issued.token, password: 'Replacement123' }, now), consumePlatformPasswordReset(store, { token: issued.token, password: 'Replacement123' }, now)]);
  assert.equal(results.filter(row => row.status === 'fulfilled').length, 1);
  assert.equal(user.authVersion, oldVersion + 2);
  assert.equal((await verifyPassword(user.password, 'Replacement123')).valid, true);
  assert.equal(platformState(store).passwordResets?.length, 0);
});

test('offline MFA recovery replaces seed and revokes both sessions with transactional rollback', async () => {
  const store = fixture(), oldTotp = new TOTP(), replacement = new TOTP();
  await bootstrapPlatformOwner(store, 'synthetic-owner', oldTotp.secret.base32);
  store.persist = async () => { throw new Error('commit failed'); };
  await assert.rejects(recoverPlatformMfaOffline(store, 'synthetic-owner', replacement.secret.base32, 'lost device'), /commit failed/);
  assert.equal(platformMember(store, 'synthetic-owner').sessionVersion, 1);
  store.persist = async () => {};
  await recoverPlatformMfaOffline(store, 'synthetic-owner', replacement.secret.base32, 'lost device');
  assert.equal(platformMember(store, 'synthetic-owner').sessionVersion, 2);
  assert.equal(store.users[0].authVersion, 2);
  assert.equal(await verifyPlatformMfa(store, 'synthetic-owner', replacement.generate()), 2);
  await assert.rejects(verifyPlatformMfa(store, 'synthetic-owner', oldTotp.generate()), /无效/);
});

test('pending members can be prepared before grant, but activation enforces every active seat', async () => {
  const store = fixture();
  await bootstrapPlatformOwner(store, 'synthetic-owner', new TOTP().secret.base32);
  const revision = () => platformState(store).revision;
  const workspace = await createPlatformEnterprise(store, 'synthetic-owner', revision(), { name: 'Pending', contact: '', account: 'pending_admin', password: 'Synthetic123' }, 'test');
  await createPlatformAccount(store, 'synthetic-owner', revision(), { workspaceId: workspace.id, name: 'Prepared', account: 'pending_member', password: 'Synthetic123', role: 'manager' }, 'test');
  const plan = await savePlatformPlan(store, 'synthetic-owner', revision(), { code: 'trial', features: ['crm'], seatLimit: 1, durationDays: 7, published: true }, 'test');
  await assert.rejects(updatePlatformEnterprise(store, 'synthetic-owner', revision(), workspace.id, { status: 'active', planVersionId: plan.id, startsAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 86400000).toISOString() }, 'test'), /席位/);
  assert.equal(platformState(store).workspaces[0].status, 'pending');
});

test('customer summary fails closed while platform persistence is in flight', async () => {
  const { store, workspace } = await managedFixture();
  assert.equal(customerAccess(store, workspace.id).status, 'active');
  const finish = beginPlatformMutation(store);
  try {
    const access = customerAccess(store, workspace.id);
    assert.equal(access.status, 'unconfigured'); assert.equal(access.canRead, false); assert.equal(access.canExecute, false); assert.deepEqual(access.features, []);
  } finally { finish(); }
  assert.equal(customerAccess(store, workspace.id).status, 'active');
});

test('issuing recovery rolls back revocation on failure; replacement invalidates previous token', async () => {
  const { store, workspace, revision } = await managedFixture();
  const user = store.users.find(row => row.teamId === workspace.id)!;
  const version = user.authVersion;
  store.persist = async () => { throw new Error('commit failed'); };
  await assert.rejects(issuePlatformPasswordReset(store, 'synthetic-owner', revision(), user.id, 'test'), /commit failed/);
  assert.equal(user.authVersion, version); assert.equal(platformState(store).passwordResets, undefined);
  store.persist = async () => {};
  const first = await issuePlatformPasswordReset(store, 'synthetic-owner', revision(), user.id, 'test');
  const second = await issuePlatformPasswordReset(store, 'synthetic-owner', revision(), user.id, 'test');
  await assert.rejects(consumePlatformPasswordReset(store, { token: first.token, password: 'Synthetic-new123' }), /无效/);
  await consumePlatformPasswordReset(store, { token: second.token, password: 'Synthetic-new123' });
});
