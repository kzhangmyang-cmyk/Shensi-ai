import assert from 'node:assert/strict';
import test from 'node:test';
import { getStore } from './store.js';
import { publicUser } from './auth.js';
import { createAccount, updateAccountAccess } from './account-command.js';
import { isAccountMutationPending } from './account-mutation-state.js';
import { createSerializedTaskQueue } from './mysql-store.js';

function fixture() {
  const owner = { id: 'operator', name: 'Operator', email: 'operator@example.test', password: 'unused', role: 'admin' as const, teamId: 'test-workspace', avatar: 'OP', status: 'active' as const, authVersion: 1 };
  const member = { ...owner, id: 'member', email: 'member@example.test', role: 'sales' as const };
  const store = { ...getStore(), users: [owner, member], accountAuditEvents: [], persist: async () => {}, persistMutation: undefined };
  return { store, owner: publicUser(owner), member };
}

test('failed disable restores status/version and does not retain successful audit', async () => {
  const { store, owner, member } = fixture();
  store.persist = async () => { throw new Error('storage unavailable'); };
  await assert.rejects(updateAccountAccess(store, owner, member.id, 'disable'), /storage unavailable/);
  assert.equal(member.status, 'active');
  assert.equal(member.authVersion, 1);
  assert.equal(store.accountAuditEvents.length, 0);
});

test('disable and restore each revoke old sessions and append redacted audit', async () => {
  const { store, owner, member } = fixture();
  await updateAccountAccess(store, owner, member.id, 'disable');
  assert.equal(member.status, 'disabled');
  await updateAccountAccess(store, owner, member.id, 'enable');
  assert.equal(member.status, 'active');
  assert.equal(member.authVersion, 3);
  assert.equal(store.accountAuditEvents.length, 2);
  assert.ok(!JSON.stringify(store.accountAuditEvents).includes('unused'));
});

test('cross-workspace and own-account suspension fail without writes', async () => {
  const { store, owner, member } = fixture();
  member.teamId = 'other';
  await assert.rejects(updateAccountAccess(store, owner, member.id, 'disable'), /账号不存在/);
  await assert.rejects(updateAccountAccess(store, owner, owner.id, 'disable'), /当前登录账号/);
  assert.equal(store.accountAuditEvents.length, 0);
});

test('concurrent normalized duplicate creation has one winner', async () => {
  const { store, owner } = fixture();
  const input = { name: 'Synthetic', email: ' New@Example.Test ', password: 'synthetic-password', role: 'sales' as const };
  const result = await Promise.allSettled([createAccount(store, owner, input), createAccount(store, owner, { ...input, email: 'new@example.test' })]);
  assert.equal(result.filter(row => row.status === 'fulfilled').length, 1);
  assert.equal(store.users.filter(row => row.email === 'new@example.test').length, 1);
  assert.equal(store.accountAuditEvents.length, 1);
});

test('failed account creation leaves no user or successful audit', async () => {
  const { store, owner } = fixture();
  store.persist = async () => { throw new Error('disk failed'); };
  await assert.rejects(createAccount(store, owner, { name: 'Synthetic', email: 'new@example.test', password: 'synthetic-password', role: 'sales' }), /disk failed/);
  assert.equal(store.users.length, 2);
  assert.equal(store.accountAuditEvents.length, 0);
});

test('uncommitted restoration stays unavailable and clears the fence after failure', async () => {
  const { store, owner, member } = fixture();
  await updateAccountAccess(store, owner, member.id, 'disable');
  store.persist = async () => {
    assert.equal(isAccountMutationPending(member.id), true);
    throw new Error('commit failed');
  };
  await assert.rejects(updateAccountAccess(store, owner, member.id, 'enable'), /commit failed/);
  assert.equal(member.status, 'disabled');
  assert.equal(member.authVersion, 2);
  assert.equal(isAccountMutationPending(member.id), false);
});

test('serialized MySQL-style queue allows consecutive revocations of one account', async () => {
  const { store, owner, member } = fixture();
  const enqueue = createSerializedTaskQueue();
  const serializedStore = { ...store, persistMutation: <T>(mutation: () => import('./store.js').PersistedStoreMutation<T>) => enqueue(async () => {
    const applied = mutation();
    try { await store.persist(); return applied.value; }
    catch (error) { applied.rollback(); throw error; }
  }) };
  await Promise.all([updateAccountAccess(serializedStore, owner, member.id, 'revoke'), updateAccountAccess(serializedStore, owner, member.id, 'revoke')]);
  assert.equal(member.authVersion, 3);
  assert.equal(isAccountMutationPending(member.id), false);
});

test('rollback never removes unrelated user if a provisional account is already absent', async () => {
  const { store, owner, member } = fixture();
  store.persist = async () => {
    store.users.splice(0, 1);
    throw new Error('persistence failed');
  };
  await assert.rejects(createAccount(store, owner, { name: 'Synthetic', email: 'new@example.test', password: 'synthetic-password', role: 'sales' }), /persistence failed/);
  assert.deepEqual(store.users.map(user => user.id), [owner.id, member.id]);
});
