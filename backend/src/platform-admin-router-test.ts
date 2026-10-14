import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import { TOTP } from 'otpauth';
import { app } from './server.js';
import { getStore, setStore } from './store.js';
import { hashPassword, publicUser, signToken, requireAuth } from './auth.js';
import { bootstrapPlatformOwner, platformState, savePlatformPlan, updatePlatformEnterprise } from './platform-admin-service.js';
import { isolatedPreviewPasswordOnly } from './platform-admin-router.js';
import type { User } from './types.js';

test('password-only exception is confined to one user in the isolated loopback MySQL preview', () => {
  const env = { SHENSI_ADMIN_PREVIEW_PASSWORD_ONLY_USER_ID: 'preview-owner', DATABASE_URL: 'mysql://test:private@127.0.0.1:34999/shensi_admin_preview', BACKEND_HOST: '127.0.0.1', PORT: '5680', CORS_ORIGINS: 'http://localhost:5681,http://127.0.0.1:5680' };
  assert.equal(isolatedPreviewPasswordOnly('preview-owner', 'mysql', env), true);
  assert.equal(isolatedPreviewPasswordOnly('another-user', 'mysql', env), false);
  assert.equal(isolatedPreviewPasswordOnly('preview-owner', 'memory', env), false);
  for (const change of [{ DATABASE_URL: 'mysql://test:private@127.0.0.1:3306/shensi' }, { BACKEND_HOST: '0.0.0.0' }, { PORT: '4188' }, { CORS_ORIGINS: 'https://app.example.com' }]) {
    assert.equal(isolatedPreviewPasswordOnly('preview-owner', 'mysql', { ...env, ...change }), false);
  }
});

test('public registration waits for operator grant and returns safe access with atomic audit', async () => {
  const previous = getStore(), previousFlag = process.env.SHENSI_REQUIRE_PLATFORM_OWNER;
  process.env.SHENSI_REQUIRE_PLATFORM_OWNER = 'true';
  const owner: User = { id: 'registration-owner', name: 'Owner', email: 'owner@example.test', password: await hashPassword('synthetic-password'), role: 'admin', teamId: 'owner-workspace', avatar: 'SO', status: 'active', authVersion: 1 };
  const store = { ...previous, mode: 'memory' as const, users: [owner], platformAdminStates: [], persistMutation: undefined, persist: async () => {} };
  setStore(store);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('listen_failed');
  const base = `http://127.0.0.1:${address.port}`;
  const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const registration = { account: 'public_customer', password: 'synthetic-password' };
  try {
    assert.equal((await post('/api/auth/register', registration)).status, 503);
    assert.equal(store.users.length, 1);
    await bootstrapPlatformOwner(store, owner.id, new TOTP().secret.base32);
    const before = structuredClone(platformState(store));
    store.persist = async () => { throw new Error('synthetic_registration_commit_failed'); };
    assert.equal((await post('/api/auth/register', registration)).status, 500);
    assert.equal(store.users.length, 1); assert.deepEqual(platformState(store), before);
    store.persist = async () => {};
    const concurrent = await Promise.all([post('/api/auth/register', registration), post('/api/auth/register', registration)]);
    assert.deepEqual(concurrent.map(row => row.status).sort(), [201, 409]);
    const registered = await concurrent.find(row => row.status === 201)!.json() as { token: string; user: { teamId: string }; access: { status: string; canExecute: boolean; features: string[] } };
    assert.equal(registered.access.status, 'pending'); assert.equal(registered.access.canExecute, false); assert.deepEqual(registered.access.features, []);
    assert.equal(platformState(store).audits.filter(row => row.action === 'register_enterprise').length, 1);
    assert.equal(platformState(store).workspaces.length, 1);
    const authHeaders = { Authorization: `Bearer ${registered.token}` };
    const me = await fetch(`${base}/api/auth/me`, { headers: authHeaders });
    assert.equal((await me.json() as { access: { status: string } }).access.status, 'pending');
    assert.equal((await fetch(`${base}/api/customers`, { headers: authHeaders })).status, 403);
    const revision = () => platformState(store).revision;
    const plan = await savePlatformPlan(store, owner.id, revision(), { code: 'trial', features: ['crm'], seatLimit: 2, durationDays: 7, published: true }, 'synthetic grant');
    await updatePlatformEnterprise(store, owner.id, revision(), registered.user.teamId, { status: 'active', planVersionId: plan.id, startsAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 86400000).toISOString() }, 'manual grant');
    assert.equal((await fetch(`${base}/api/auth/me`, { headers: authHeaders })).status, 401);
    const login = await post('/api/auth/login', { email: registration.account, password: registration.password });
    assert.equal(login.status, 200);
    const granted = await login.json() as { token: string; access: { status: string; canExecute: boolean; features: string[] } };
    assert.equal(granted.access.status, 'active'); assert.equal(granted.access.canExecute, true); assert.deepEqual(granted.access.features, ['crm']);
    assert.equal((await fetch(`${base}/api/customers`, { headers: { Authorization: `Bearer ${granted.token}` } })).status, 200);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    setStore(previous);
    if (previousFlag === undefined) delete process.env.SHENSI_REQUIRE_PLATFORM_OWNER; else process.env.SHENSI_REQUIRE_PLATFORM_OWNER = previousFlag;
  }
});

test('platform MFA and enterprise lifecycle use isolated accounts; legacy customer admin has no platform access', async () => {
  const previous = getStore();
  const owner = { id: 'synthetic-operator', name: 'Synthetic', email: 'synthetic@example.test', password: await hashPassword('synthetic-password'), role: 'admin' as const, teamId: 'synthetic-owner-space', avatar: 'SO', status: 'active' as const, authVersion: 1 };
  const store = { ...previous, mode: 'memory' as const, users: [owner] as User[], platformAdminStates: [], accountAuditEvents: [], persistMutation: undefined, persist: async () => {} };
  setStore(store);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('test_listen_failed');
  const base = `http://127.0.0.1:${address.port}`;
  // Exercise the real auth middleware independently of unavailable finance repositories.
  const guarded = express();
  guarded.use(requireAuth);
  guarded.use((_req, res) => { res.json({ authorized: true }); });
  const guardServer = guarded.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => guardServer.once('listening', resolve));
  const guardAddress = guardServer.address(); if (!guardAddress || typeof guardAddress === 'string') throw new Error('guard_listen_failed');
  const guardBase = `http://127.0.0.1:${guardAddress.port}`;
  let cookie = '';
  const token = signToken(publicUser(owner));
  async function request(path: string, value?: unknown, method = value === undefined ? 'GET' : 'POST', bearer = token, origin = base) {
    const response = await fetch(`${origin}${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bearer}`, Cookie: cookie }, ...(value === undefined ? {} : { body: JSON.stringify(value) }) });
    return { status: response.status, body: await response.json(), response };
  }
  async function command(path: string, value: unknown, method = 'POST') {
    return request(`/api/platform/v1${path}`, { revision: platformState(store).revision, reason: 'Synthetic acceptance only', value }, method);
  }
  try {
    assert.equal((await request('/api/platform/v1/overview')).status, 401);
    assert.equal((await request('/api/platform/v1/session', { code: '123456' })).status, 403);
    const totp = new TOTP();
    await bootstrapPlatformOwner(store, owner.id, totp.secret.base32);
    const session = await request('/api/platform/v1/session', { code: totp.generate() });
    assert.equal(session.status, 200);
    cookie = session.response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
    const overview = await request('/api/platform/v1/overview');
    assert.equal(overview.status, 200); assert.equal(overview.body.plans.length, 3);
    assert.ok(!JSON.stringify(overview.body).includes('secretEncrypted'));
    const created = await command('/enterprises', { name: 'Synthetic Enterprise', contact: '', account: 'synthetic-customer', password: 'synthetic-password' });
    assert.equal(created.status, 201);
    const member = await command('/accounts', { workspaceId: created.body.id, name: 'Synthetic member', account: 'synthetic-member', password: 'synthetic-password', role: 'sales' });
    assert.equal(member.status, 201);
    assert.equal(member.body.role, 'sales');
    assert.ok(!JSON.stringify(member.body).includes('password'));
    const customer = store.users.find(user => user.teamId === created.body.id)!;
    let customerToken = signToken(publicUser(customer));
    assert.equal((await request('/api/customers', undefined, 'GET', customerToken)).status, 403);
    assert.equal((await request('/api/platform/v1/overview', undefined, 'GET', customerToken)).status, 401);
    const plan = await command('/plans', { code: 'trial', features: ['crm'], seatLimit: 2, durationDays: 7, published: true });
    assert.equal(plan.status, 201);
    const grant = { status: 'active', planVersionId: plan.body.id, startsAt: new Date(Date.now() - 60000).toISOString(), expiresAt: new Date(Date.now() + 86400000).toISOString() };
    assert.equal((await command(`/enterprises/${created.body.id}`, grant, 'PATCH')).status, 200);
    assert.equal((await request('/api/customers', undefined, 'GET', customerToken)).status, 401);
    customerToken = signToken(publicUser(customer));
    assert.equal((await request('/api/customers', undefined, 'GET', customerToken)).status, 200);
    const reset = await command(`/accounts/${member.body.id}/password-reset`, {});
    assert.equal(reset.status, 200);
    assert.equal(typeof reset.body.token, 'string');
    const auditSearch = await request('/api/platform/v1/overview?q=issue_password_reset');
    assert.equal(auditSearch.body.auditCount, 1);
    assert.ok(!JSON.stringify(auditSearch.body).includes(reset.body.token));
    // Anonymous bearer-token recovery: no operator cookie or customer session.
    const recovery = await fetch(`${base}/api/auth/reset-password`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: reset.body.token, password: 'replacement-password' }) });
    assert.equal(recovery.status, 200);
    const replay = await fetch(`${base}/api/auth/reset-password`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: reset.body.token, password: 'replacement-password' }) });
    assert.equal(replay.status, 400);
    assert.equal((await command(`/accounts/${customer.id}`, { action: 'disable' }, 'PATCH')).status, 200);
    assert.equal((await request('/api/auth/me', undefined, 'GET', customerToken)).status, 401);
    assert.equal((await command(`/accounts/${customer.id}`, { action: 'enable' }, 'PATCH')).status, 200);
    assert.equal((await request('/api/auth/me', undefined, 'GET', customerToken)).status, 401);
    customerToken = signToken(publicUser(customer));
    assert.equal((await request('/api/auth/me', undefined, 'GET', customerToken)).status, 200);
    const expired = { ...grant, startsAt: new Date(Date.now() - 120000).toISOString(), expiresAt: new Date(Date.now() - 60000).toISOString() };
    assert.equal((await command(`/enterprises/${created.body.id}`, expired, 'PATCH')).status, 200);
    customerToken = signToken(publicUser(customer));
    assert.equal((await request('/api/customers', {}, 'POST', customerToken)).body.code, 'subscription_expired');
    assert.equal((await request('/api/customers', undefined, 'GET', customerToken)).status, 200);
    assert.equal((await command(`/enterprises/${created.body.id}`, grant, 'PATCH')).status, 200);
    assert.ok(platformState(store).audits.some(event => event.action === 'account_enable'));
    assert.equal((await request(`/api/accounts/${customer.id}/disable`, {}, 'PATCH')).status, 403);
    const encoded = `%${customer.id.charCodeAt(0).toString(16)}${customer.id.slice(1)}`;
    assert.equal((await request(`/api/accounts/${encoded}/disable`, {}, 'PATCH')).status, 403);
    assert.equal((await request(`/api/accounts/${encoded}`, undefined, 'DELETE')).status, 403);
    const legacy = { ...owner, id: 'synthetic-legacy-super', role: 'super_admin' as const, teamId: 'all' };
    store.users.push(legacy);
    assert.equal((await request('/api/accounts', { name: 'Bypass', email: 'bypass@example.test', password: 'synthetic-password', role: 'sales', teamId: ` ${customer.teamId} ` }, 'POST', signToken(publicUser(legacy)))).status, 403);
    const agentsPlan = await command('/plans', { code: 'pro', features: ['agents'], seatLimit: 2, durationDays: 7, published: true });
    assert.equal((await command(`/enterprises/${created.body.id}`, { ...grant, planVersionId: agentsPlan.body.id }, 'PATCH')).status, 200);
    customerToken = signToken(publicUser(customer));
    for (const path of ['/api/v1/finance/cfo-sessions', '/api/v1/finance/council-runs']) {
      const response = await request(path, undefined, 'GET', customerToken, guardBase);
      assert.equal(response.status, 200, path);
    }
    const growthPlan = await command('/plans', { code: 'basic', features: ['growth'], seatLimit: 2, durationDays: 7, published: true });
    assert.equal((await command(`/enterprises/${created.body.id}`, { ...grant, planVersionId: growthPlan.body.id }, 'PATCH')).status, 200);
    customerToken = signToken(publicUser(customer));
    for (const path of ['/api/v1/finance/cfo-sessions', '/api/v1/finance/council-runs', '/api/v1/finance/operating-memory-question']) {
      assert.equal((await request(path, undefined, 'GET', customerToken, guardBase)).body.code, 'feature_forbidden', path);
    }
    const copiedCookie = cookie;
    assert.equal((await request('/api/platform/v1/session', undefined, 'DELETE')).status, 200);
    cookie = copiedCookie;
    assert.equal((await request('/api/platform/v1/overview')).status, 401);
  } finally {
    await Promise.all([server, guardServer].map(instance => new Promise<void>((resolve, reject) => instance.close(error => error ? reject(error) : resolve()))));
    setStore(previous);
  }
});
