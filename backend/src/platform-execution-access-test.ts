import assert from 'node:assert/strict';
import test from 'node:test';
import { emptyPlatformState } from './platform-admin-domain.js';
import { createPlatformExecutionAccess } from './platform-execution-access.js';
import { MysqlAcquisitionOutreachBatchRepository } from './acquisition-outreach-batch-mysql-repository.js';

test('fresh managed execution authority follows suspension, expiry, feature and recovery', async () => {
  const state = emptyPlatformState();
  state.plans[0] = { ...state.plans[0]!, published: true, features: ['outreach'], seatLimit: 1, durationDays: 1 };
  const workspace = { id: 'managed', name: 'Synthetic', contact: '', status: 'active' as 'active' | 'suspended',
    planVersionId: state.plans[0]!.id, startsAt: '2026-08-25T00:00:00.000Z', expiresAt: '2026-08-26T00:00:00.000Z', revision: 1 };
  state.workspaces.push(workspace);
  let pending = false;
  const access = createPlatformExecutionAccess({ readState: async () => state, isMutationPending: () => pending });
  assert.equal(await access('managed', workspace.startsAt), true);
  pending = true;
  assert.equal(await access('managed', workspace.startsAt), false);
  assert.equal(await access('unmanaged', workspace.startsAt), true);
  pending = false;
  workspace.status = 'suspended';
  assert.equal(await access('managed', workspace.startsAt), false);
  workspace.status = 'active';
  assert.equal(await access('managed', workspace.expiresAt), false);
  workspace.expiresAt = '2026-08-27T00:00:00.000Z';
  assert.equal(await access('managed', '2026-08-26T00:00:00.000Z'), true);
  state.plans[0]!.features = ['crm'];
  assert.equal(await access('managed', workspace.startsAt), false);
  assert.equal(await access('unmanaged', workspace.startsAt), true);
  assert.equal(await createPlatformExecutionAccess({ readState: async () => { throw new Error('unavailable'); } })('managed', workspace.startsAt), false);
  assert.equal(await createPlatformExecutionAccess({})('managed', workspace.startsAt), false);
});

test('MySQL authority uses fresh durable payload and transaction current-read lock', async () => {
  const sql: string[] = [];
  const mysql = { execute: async (query: string) => { sql.push(query); return [[{ payload: JSON.stringify(emptyPlatformState()) }]]; } };
  const access = createPlatformExecutionAccess({ mysql: mysql as never });
  assert.equal(await access('unmanaged', '2026-08-25T00:00:00.000Z'), true);
  assert.equal(await access('unmanaged', '2026-08-25T00:00:00.000Z', mysql as never), true);
  assert.match(sql[1]!, /FOR SHARE$/u);
  assert.equal(sql.length, 2);
});

test('MySQL desktop denied start reaches no action mutation and rolls back', async () => {
  const calls: string[] = [];
  const connection = { beginTransaction: async () => { calls.push('begin'); },
    commit: async () => { calls.push('commit'); }, rollback: async () => { calls.push('rollback'); },
    release: () => { calls.push('release'); }, execute: async () => { throw new Error('no action SQL permitted'); } };
  const repository = new MysqlAcquisitionOutreachBatchRepository({
    getConnection: async () => connection, execute: connection.execute
  } as never, undefined, undefined, async (workspaceId, _now, transaction) => {
    assert.equal(workspaceId, 'managed');
    assert.equal(transaction, connection);
    return false;
  });
  await assert.rejects(repository.markDesktopActionStarted({ workspaceId: 'managed',
    now: '2026-08-25T00:00:00.000Z' } as never), /desktop_outreach_completion_not_authorized/u);
  assert.deepEqual(calls, ['begin', 'rollback', 'release']);
});
