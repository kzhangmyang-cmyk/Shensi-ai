import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomBytes } from 'node:crypto';
import { emptyPlatformState } from '../platform-admin-domain.js';
import type { CentralReader } from './domain.js';
import express from 'express';
import jwt from 'jsonwebtoken';
import { requireAuth, signToken, publicUser } from '../auth.js';
import { getStore, setStore } from '../store.js';

// Breaks caught: unmanaged .allowed, inactive/team-mismatched users and operators
// must not become central readers/owners; one proof must never issue twice.
const reader: CentralReader = { subjectId: 'u_customer', workspaceId: 'w_customer', authVersion: 1, authorityRevision: 2 };
async function modules() {
  const authority = await import('./authority.js').catch(() => null);
  const binding = await import('./binding-service.js').catch(() => null);
  assert.ok(authority, 'central authority must be implemented');
  assert.ok(binding, 'one-time binding service must be implemented');
  return { ...authority, ...binding };
}
async function setup() {
  const { createReferenceAuthorityReader, BindingService } = await modules();
  let now = Date.parse('2026-10-08T00:00:00Z');
  const state = emptyPlatformState(); state.revision = 2;
  state.plans = [{ id: 'trial:1', code: 'trial', version: 1, features: ['agents'], published: true, seatLimit: 5, durationDays: 7 }];
  state.workspaces = [{ id: 'w_customer', name: 'Synthetic', contact: '', status: 'active', planVersionId: 'trial:1', startsAt: '2026-10-07T00:00:00Z', expiresAt: '2026-10-14T00:00:00Z', revision: 1 }];
  const user = { id: 'u_customer', teamId: 'w_customer', status: 'active', authVersion: 1 };
  const authority = createReferenceAuthorityReader({ readSnapshot: async (id: string) => ({ user: id === user.id ? { ...user } : null, platform: structuredClone(state) }), now: () => now });
  const { TestBindingRepository } = await import('./binding-test-support.js');
  const repository = new TestBindingRepository();
  const service = new BindingService({ authority, repository, issuer: 'https://library.example.test', now: () => now });
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const request = await service.create({ challenge }, '127.0.0.1');
  return { service, repository, authority, user, state, request, verifier, advance: (ms: number) => { now += ms; } };
}

test('reader requires explicit managed central workspace and effective current user membership', async () => {
  const f = await setup();
  assert.deepEqual(await f.authority.current(reader.subjectId, reader.workspaceId), reader);
  await assert.rejects(f.authority.current(reader.subjectId, 'unknown'));
  await assert.rejects(f.authority.current('local_admin', reader.workspaceId));
  f.user.teamId = 'another'; await assert.rejects(f.authority.current(reader.subjectId, reader.workspaceId));
  f.user.teamId = reader.workspaceId; f.user.status = 'disabled'; await assert.rejects(f.authority.current(reader.subjectId, reader.workspaceId));
});
test('reader denies unmanaged compatibility, missing agents feature and expired grants', async () => {
  const f = await setup(); const workspace = f.state.workspaces.pop()!;
  await assert.rejects(f.authority.current(reader.subjectId, reader.workspaceId));
  f.state.workspaces.push(workspace); f.state.plans[0]!.features = ['crm'];
  await assert.rejects(f.authority.current(reader.subjectId, reader.workspaceId));
  f.state.plans[0]!.features = ['agents']; f.advance(7 * 86400000);
  await assert.rejects(f.authority.current(reader.subjectId, reader.workspaceId));
});
test('owner privilege is separate from local admin and platform operator', async () => {
  const f = await setup(); await assert.rejects(f.authority.assertOwner(reader.subjectId));
  f.state.memberships.push({ userId: reader.subjectId, role: 'operator', status: 'active', secretEncrypted: 'synthetic', lastOtpCounter: 0, sessionVersion: 1 });
  await assert.rejects(f.authority.assertOwner(reader.subjectId));
  f.state.memberships[0]!.role = 'owner';
  assert.deepEqual(await f.authority.assertOwner(reader.subjectId), { userId: reader.subjectId, authVersion: 1, platformRevision: 2, sessionVersion: 1 });
});
test('binding approval and proof exchange are distinct and exactly one concurrent exchange succeeds', async () => {
  const f = await setup();
  assert.match(f.request.displayCode, /^\d{8}$/u);
  await assert.rejects(f.service.exchange({ requestId: f.request.requestId, verifier: f.verifier }));
  await f.service.approve(reader, f.request.requestId, f.request.displayCode);
  const results = await Promise.allSettled([1, 2].map(() => f.service.exchange({ requestId: f.request.requestId, verifier: f.verifier })));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const success = results.find(result => result.status === 'fulfilled'); assert.equal(success?.status, 'fulfilled');
  if (success?.status !== 'fulfilled') return;
  assert.equal(Buffer.from(success.value.readerToken, 'base64url').length, 32);
  assert.deepEqual(await f.service.authenticate(success.value.readerToken), reader);
  const persisted = JSON.stringify([...f.repository.records.values()]);
  assert.ok(!persisted.includes(f.verifier)); assert.ok(!persisted.includes(success.value.readerToken));
});
test('display code is never proof; wrong verifier does not consume an approval', async () => {
  const f = await setup();
  await assert.rejects(f.service.approve(reader, f.request.requestId, 'wrong-code'));
  await f.service.approve(reader, f.request.requestId, f.request.displayCode);
  for (const verifier of [f.request.displayCode, randomBytes(32).toString('base64url')]) await assert.rejects(f.service.exchange({ requestId: f.request.requestId, verifier }));
  assert.ok((await f.service.exchange({ requestId: f.request.requestId, verifier: f.verifier })).readerToken);
});
test('second subject cannot replace an existing approval and expiry is durable', async () => {
  const f = await setup(); await f.service.approve(reader, f.request.requestId, f.request.displayCode);
  await assert.rejects(f.service.approve({ ...reader, subjectId: 'other' }, f.request.requestId, f.request.displayCode));
  f.advance(300000);
  await assert.rejects(f.service.exchange({ requestId: f.request.requestId, verifier: f.verifier }));
  assert.equal(f.repository.records.get(f.request.requestId)?.status, 'expired');
});
for (const kind of ['disabled', 'version', 'revision'] as const) test(`fresh authority denies ${kind} before exchange`, async () => {
  const f = await setup(); await f.service.approve(reader, f.request.requestId, f.request.displayCode);
  if (kind === 'disabled') f.user.status = 'disabled';
  if (kind === 'version') f.user.authVersion++;
  if (kind === 'revision') f.state.revision++;
  await assert.rejects(f.service.exchange({ requestId: f.request.requestId, verifier: f.verifier }));
  assert.equal(f.repository.records.get(f.request.requestId)?.tokenHash, null);
});
test('cancel after uncertain issuance revokes token and cannot undo cancellation', async () => {
  const f = await setup(); await f.service.approve(reader, f.request.requestId, f.request.displayCode);
  const issued = await f.service.exchange({ requestId: f.request.requestId, verifier: f.verifier });
  await f.service.cancel({ requestId: f.request.requestId, verifier: f.verifier });
  await assert.rejects(f.service.authenticate(issued.readerToken));
  await assert.rejects(f.service.exchange({ requestId: f.request.requestId, verifier: f.verifier }));
  assert.equal(f.repository.records.get(f.request.requestId)?.status, 'cancelled');
});
test('issued reader expires at seven days and cannot survive user revocation or wrong issuer', async () => {
  const f = await setup(); await f.service.approve(reader, f.request.requestId, f.request.displayCode);
  const issued = await f.service.exchange({ requestId: f.request.requestId, verifier: f.verifier });
  assert.equal(issued.expiresAt, '2026-10-15T00:00:00.000Z');
  f.user.authVersion++; await assert.rejects(f.service.authenticate(issued.readerToken)); f.user.authVersion--;
  const { BindingService } = await modules();
  const other = new BindingService({ authority: f.authority, repository: f.repository, issuer: 'https://other.example.test', now: () => Date.parse('2026-10-08T00:00:00Z') });
  await assert.rejects(other.authenticate(issued.readerToken));
  f.advance(7 * 86400000); await assert.rejects(f.service.authenticate(issued.readerToken));
});

async function withRoutes(run: (f: Awaited<ReturnType<typeof setup>>, base: string, session: string) => Promise<void>) {
  const routerModule = await import('./binding-router.js').catch(() => null);
  assert.ok(routerModule, 'bounded binding router must be implemented');
  const f = await setup(), previous = getStore();
  const user = { ...f.user, status: 'active' as const, name: 'Central Customer', email: 'customer@example.test', password: 'unused-synthetic', role: 'admin' as const, avatar: 'CC' };
  setStore({ ...previous, mode: 'memory', users: [user], platformAdminStates: [f.state], persist: async () => {}, persistMutation: undefined });
  const app = express();
  assert.equal(typeof routerModule.installReferenceBindingIngress, 'function', 'exact bounded ingress must be available before generic JSON');
  routerModule.installReferenceBindingIngress(app)({ service: f.service, authority: f.authority });
  app.use(express.json({ limit: '2mb' }));
  app.use(requireAuth); app.use((_req, res) => { res.json({ authorized: true }); });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  try { await run(f, `http://127.0.0.1:${address.port}`, signToken(publicUser(user))); }
  finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); setStore(previous); }
}
const prefix = '/api/v1/system-reference/binding-requests';
async function post(base: string, path: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
}
test('normal central cookie+CSRF approval is explicit, body-closed and never replaced by local JWT or reader token', async () => {
  await withRoutes(async (f, base, session) => {
    const path = `${prefix}/${f.request.requestId}/approve`, body = { displayCode: f.request.displayCode };
    assert.equal((await post(base, path, body)).status, 401);
    assert.equal((await post(base, path, body, { Authorization: `Bearer ${session}` })).status, 401);
    const headers = { Cookie: `gj_session=${session}; gj_csrf=synthetic-csrf`, 'X-CSRF-Token': 'synthetic-csrf' };
    assert.equal((await post(base, path, body, { Cookie: headers.Cookie })).status, 403);
    const local = jwt.sign({ ver: 1 }, 'a-separate-local-backend-signing-secret', { subject: reader.subjectId, issuer: 'goodjob-crm', audience: 'goodjob-crm-web' });
    assert.equal((await post(base, path, body, { ...headers, Cookie: `gj_session=${local}; gj_csrf=synthetic-csrf` })).status, 401);
    assert.equal((await post(base, path, { ...body, workspaceId: 'local' }, headers)).status, 400);
    assert.equal((await post(base, path, body, headers)).status, 204);
    const exchange = `${prefix}/${f.request.requestId}/exchange`;
    assert.equal((await post(base, exchange, { verifier: f.verifier, requestId: f.request.requestId })).status, 400);
    const response = await post(base, exchange, { verifier: f.verifier }); assert.equal(response.status, 200);
    const issued = await response.json() as { readerToken: string };
    for (const ordinary of ['/api/customers', '/api/platform/v1/system-reference/releases']) {
      assert.equal((await post(base, ordinary, {}, { Authorization: `Bearer ${issued.readerToken}` })).status, 401);
    }
    assert.equal((await post(base, exchange, { verifier: f.verifier })).status, 403);
  });
});
test('binding challenge routes enforce 4KiB, strict JSON and independent 10-per-IP limits ignoring untrusted forwarding headers', async () => {
  await withRoutes(async (f, base) => {
    assert.equal((await post(base, prefix, { challenge: 'x'.repeat(4500) })).status, 413);
    assert.equal((await post(base, prefix, { challenge: createHash('sha256').update(f.verifier).digest('base64url'), question: 'private' })).status, 400);
    for (let i = 0; i < 8; i++) assert.equal((await post(base, prefix, { challenge: createHash('sha256').update(f.verifier).digest('base64url') })).status, 201);
    assert.equal((await post(base, prefix, { challenge: createHash('sha256').update(f.verifier).digest('base64url') })).status, 429);
    for (const suffix of ['exchange', 'cancel']) {
      const path = `${prefix}/${f.request.requestId}/${suffix}`;
      for (let i = 0; i < 10; i++) assert.equal((await post(base, path, { verifier: randomBytes(32).toString('base64url') }, { 'X-Forwarded-For': `10.0.0.${i + 1}` })).status, 403);
      assert.equal((await post(base, path, { verifier: f.verifier })).status, 429);
    }
  });
});
test('system-reference is classified as agents rather than legacy CRM', async () => {
  await withRoutes(async (_f, base, session) => {
    assert.equal((await post(base, '/api/v1/system-reference/query', {}, { Authorization: `Bearer ${session}` })).status, 200);
    assert.equal((await post(base, '/api/customers', {}, { Authorization: `Bearer ${session}` })).status, 403);
  });
});
