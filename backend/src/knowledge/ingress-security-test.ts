import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import { requireAuth, signToken, publicUser } from '../auth.js';
import { createMemoryStore, getStore, setStore } from '../store.js';
import { installKnowledgeIngress } from './router.js';

test('real shared auth rejects unauthorized and invalid CSRF before knowledge body parsing', async t => {
  const previous = getStore();
  const user = { id: 'synthetic-knowledge-user', name: 'synthetic', email: 'synthetic@invalid.local', password: 'not-used',
    role: 'admin' as const, teamId: 'synthetic-team', avatar: '', status: 'active' as const, authVersion: 1 };
  const store = createMemoryStore({ users: [user], platformAdminStates: [] }); setStore(store); t.after(() => setStore(previous));
  const token = signToken(publicUser(user)), app = express(); let reached = 0;
  installKnowledgeIngress(app, requireAuth);
  app.use(express.json({ limit: '2mb' }));
  const path = '/api/v1/knowledge/documents/12345678-1234-1234-1234-123456789abc/versions/abcdef01-1234-1234-1234-123456789abc/content';
  app.put(path, (req, res) => { reached++; req.resume(); req.once('end', () => res.json({ ok: true })); });
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const address = server.address(); assert.ok(address && typeof address === 'object'); const url = `http://127.0.0.1:${address.port}${path}`;
  const anonymous = await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{malformed' });
  assert.equal(anonymous.status, 401);
  assert.deepEqual(Object.keys(await anonymous.json()), ['error']);
  const cookie = `gj_session=${token}; gj_csrf=synthetic-csrf`;
  const csrf = await fetch(url, { method: 'PUT', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: '{malformed' });
  assert.equal(csrf.status, 403); assert.equal((await csrf.json()).error.code, 'csrf_validation_failed');
  const mime = await fetch(url, { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: '{malformed' });
  assert.equal(mime.status, 415); assert.equal(reached, 0);
  const allowed = await fetch(url, { method: 'PUT', headers: { Cookie: cookie, 'X-CSRF-Token': 'synthetic-csrf', 'Content-Type': 'application/octet-stream' }, body: 'synthetic' });
  assert.equal(allowed.status, 200); assert.equal(reached, 1);
  store.users[0].status = 'disabled';
  const revoked = await fetch(url, { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream' }, body: 'synthetic' });
  assert.equal(revoked.status, 401); assert.equal(reached, 1);
});
