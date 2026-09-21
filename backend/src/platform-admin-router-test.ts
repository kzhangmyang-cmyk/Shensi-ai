import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import { TOTP } from 'otpauth';
import { app } from './server.js';
import { getStore, setStore } from './store.js';
import { hashPassword, publicUser, signToken, requireAuth } from './auth.js';
import { bootstrapPlatformOwner, platformState } from './platform-admin-service.js';
import type { User } from './types.js';

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
