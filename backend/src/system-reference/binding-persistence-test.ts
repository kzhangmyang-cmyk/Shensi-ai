import assert from 'node:assert/strict';
import test from 'node:test';
import type { Pool, PoolConnection } from 'mysql2/promise';
import { createMysqlReferenceAuthority } from './authority.js';
import { emptyPlatformState } from '../platform-admin-domain.js';
import type { BindingRecord } from './binding-repository.js';
const row: BindingRecord = { id: '11111111-1111-4111-8111-111111111111', challenge: 'a'.repeat(43), displayCode: '01234567', issuer: 'https://library.example.test', purpose: 'system-reference-reader', status: 'pending', createdAt: 1000, expiresAt: 301000, generation: 1, reader: null, tokenHash: null, tokenExpiresAt: null };

test('durable binding adapter locks a single row, commits state, and never replays uncertain commits', async () => {
  const module = await import('./mysql-bindings.js').catch(() => null); assert.ok(module, 'durable binding adapter required');
  const calls: { sql: string; values?: unknown[] }[] = []; let commitFails = false;
  const connection = { beginTransaction: async () => { calls.push({ sql: 'begin' }); },
    execute: async (sql: string, values?: unknown[]) => { calls.push({ sql, values }); return [sql.startsWith('SELECT') ? [{ payload: JSON.stringify(row) }] : { affectedRows: 1 }, []]; },
    commit: async () => { calls.push({ sql: 'commit' }); if (commitFails) throw new Error('private database detail'); },
    rollback: async () => { calls.push({ sql: 'rollback' }); }, release: () => calls.push({ sql: 'release' }), destroy: () => calls.push({ sql: 'destroy' }) };
  const pool = { getConnection: async () => connection, execute: connection.execute } as unknown as Pool;
  const repo = new module.MysqlBindingRepository(pool);
  const result = await repo.transaction(row.id, async (record, tx) => {
    assert.equal(tx, connection); assert.ok(record); record.status = 'cancelled'; return 'cancelled';
  });
  assert.equal(result, 'cancelled'); assert.match(calls[1]!.sql, /WHERE id=\? FOR UPDATE$/u);
  const update = calls.find(call => call.sql.startsWith('UPDATE'))!;
  assert.match(String(update.values?.find(value => typeof value === 'string' && value.startsWith('{'))), /"status":"cancelled"/u);
  assert.deepEqual(calls.slice(-2).map(call => call.sql), ['commit', 'release']);
  calls.length = 0; commitFails = true;
  await assert.rejects(repo.transaction(row.id, async () => 'secret-outcome'), error => error instanceof Error && error.message === 'reference_persistence_unconfirmed');
  assert.equal(calls.filter(call => call.sql === 'commit').length, 1);
  assert.equal(calls.filter(call => call.sql === 'destroy').length, 1);
});
test('authority uses transaction connection and locks minimal durable user before platform state', async () => {
  const platform = emptyPlatformState(); platform.revision = 3;
  platform.plans = [{ id: 'plan', code: 'trial', version: 1, published: true, features: ['agents'], seatLimit: 1, durationDays: 1 }];
  platform.workspaces = [{ id: 'workspace', name: '', contact: '', status: 'active', planVersionId: 'plan', startsAt: '2020-01-01T00:00:00Z', expiresAt: '2099-01-01T00:00:00Z', revision: 1 }];
  const statements: string[] = [];
  const connection = { execute: async (sql: string) => { statements.push(sql); return [sql.includes('FROM users') ? [{ id: 'user', team_id: 'workspace', status: 'active', auth_version: 4 }] : [{ payload: platform }], []]; } } as unknown as PoolConnection;
  const pool = { execute: async () => { throw new Error('must not escape transaction'); } } as unknown as Pool;
  assert.deepEqual(await createMysqlReferenceAuthority(pool).current('user', 'workspace', connection), { subjectId: 'user', workspaceId: 'workspace', authVersion: 4, authorityRevision: 3 });
  assert.deepEqual(statements, ['SELECT id,team_id,status,auth_version FROM users WHERE id=? FOR SHARE', 'SELECT payload FROM platform_administration_state WHERE id=1 FOR SHARE']);
});
test('reader binding check borrows the exact caller connection and retains its shared lock until caller commit',async()=>{
  const {MysqlBindingRepository}=await import('./mysql-bindings.js');
  assert.equal(typeof MysqlBindingRepository.prototype.readForReferenceTransaction,'function','borrowed reference transaction binding read required');
  const statements:string[]=[];
  const connection={execute:async(sql:string,values:unknown[])=>{statements.push(sql);assert.deepEqual(values,[row.id]);return [[{payload:JSON.stringify(row)}],[]];}} as unknown as PoolConnection;
  const pool={getConnection:async()=>{throw Error('must not open a nested transaction');},execute:async()=>{throw Error('must not escape caller connection');}} as unknown as Pool;
  const repo=new MysqlBindingRepository(pool);
  assert.deepEqual(await repo.readForReferenceTransaction(row.id,connection),row);
  assert.deepEqual(statements,['SELECT payload FROM system_reference_bindings WHERE id=? FOR SHARE']);
  await assert.rejects(repo.readForReferenceTransaction(row.id),/persistence_unconfirmed/);
});
