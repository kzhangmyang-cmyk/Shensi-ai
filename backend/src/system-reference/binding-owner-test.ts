import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import jwt from 'jsonwebtoken';
import { TOTP } from 'otpauth';
import { getStore, setStore } from '../store.js';
import { publicUser, signToken } from '../auth.js';
import { createPlatformAdminRouter } from '../platform-admin-router.js';
import { bootstrapPlatformOwner, platformState } from '../platform-admin-service.js';
import { createReferenceAuthorityReader } from './authority.js';

test('reference owner subrouter requires real MFA and fresh owner, never legacy or preview password-only session', async () => {
  const previous = getStore(), previousKey = process.env.JWT_SECRET;
  process.env.JWT_SECRET = 'synthetic-reference-platform-key-at-least-32-characters';
  const user = { id: 'owner', name: 'Synthetic Owner', email: 'owner@example.test', password: 'unused', role: 'admin' as const, teamId: 'owner-space', status: 'active' as const, avatar: 'SO', authVersion: 1 };
  const store = { ...previous, mode: 'memory' as const, users: [user], platformAdminStates: [], persist: async () => {}, persistMutation: undefined }; setStore(store);
  const totp = new TOTP(); await bootstrapPlatformOwner(store, user.id, totp.secret.base32);
  const authority = createReferenceAuthorityReader({ readSnapshot: async () => ({ user, platform: platformState(store) }) });
  const routes = express.Router(); routes.post('/releases', (_req, res) => { res.sendStatus(204); });
  const app = express(); app.use(express.json()); app.use('/api/platform/v1', createPlatformAdminRouter({ reference: { authority, router: routes } }));
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string'); const base = `http://127.0.0.1:${address.port}`;
  const session = signToken(publicUser(user));
  const request = (path: string, platform: string, body: unknown = {}) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: `gj_session=${session}; gj_csrf=csrf; shensi_platform=${platform}`, 'X-CSRF-Token': 'csrf' }, body: JSON.stringify(body) });
  try {
    for (const extra of [{}, { mfaVerified: false }]) {
      const legacy = jwt.sign({ version: 1, authVersion: 1, ...extra }, process.env.JWT_SECRET, { subject: user.id, issuer: 'shensi-platform', audience: 'shensi-platform-console', expiresIn: '15m' });
      assert.equal((await request('/api/platform/v1/system-reference/releases', legacy)).status, 403);
    }
    const login = await request('/api/platform/v1/session', '', { code: totp.generate() }); assert.equal(login.status, 200);
    const mfaCookie = login.headers.getSetCookie().find(value => value.startsWith('shensi_platform='))!.split(';')[0]!.slice('shensi_platform='.length);
    assert.equal((await request('/api/platform/v1/system-reference/releases', mfaCookie)).status, 204);
    platformState(store).memberships[0]!.role = 'operator';
    assert.equal((await request('/api/platform/v1/system-reference/releases', mfaCookie)).status, 403);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve())); setStore(previous);
    if (previousKey === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = previousKey;
  }
});
