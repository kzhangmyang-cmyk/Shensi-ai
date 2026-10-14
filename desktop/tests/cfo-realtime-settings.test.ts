import assert from 'node:assert/strict';
import test from 'node:test';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdtemp, realpath, readFile, readdir, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('voice settings encrypt, isolate, replace, survive restart and remove without revealing Key', async t => {
  const module = await import('../src/main/cfo-realtime-settings.ts').catch(() => null);
  assert.ok(module, 'Main voice settings store must exist');
  const root = await realpath(await mkdtemp(join(tmpdir(), 'shensi-voice-test-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const key = randomBytes(32);
  const safeStorage = { isEncryptionAvailable: () => true,
    encryptString(text: string) { const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key, iv);
      const bytes = Buffer.concat([cipher.update(text), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), bytes]); },
    decryptString(bytes: Buffer) { const cipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
      cipher.setAuthTag(bytes.subarray(12, 28)); return Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString(); } };
  const options = { directory: join(root, 'voice'), safeStorage };
  const store = module.createCfoRealtimeSettingsStore(options);
  const scope = { workspaceId: 'ws-one', actorId: 'user-one' };
  const input = { apiKey: 'test-isolated-secret-12345', workspaceId: 'llm-fixture123' };
  assert.equal(await store.load(scope), null);
  await store.save(scope, input);
  assert.equal((await store.load(scope))?.apiKey, input.apiKey);
  assert.equal(await store.load({ ...scope, actorId: 'user-two' }), null);
  assert.equal(await store.load({ ...scope, workspaceId: 'ws-two' }), null);
  const filenames = await readdir(options.directory);
  assert.equal(filenames.length, 1);
  const file = join(options.directory, filenames[0]);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  const encrypted = await readFile(file, 'utf8');
  for (const secret of [input.apiKey, input.workspaceId, scope.actorId]) assert.ok(!encrypted.includes(secret));
  const restarted = module.createCfoRealtimeSettingsStore(options);
  assert.equal((await restarted.load(scope))?.apiKey, input.apiKey);
  await restarted.save(scope, { ...input, apiKey: 'replacement-fixture-secret' });
  assert.equal((await store.load(scope))?.apiKey, 'replacement-fixture-secret');
  for (const invalid of [{ ...input, apiKey: '' }, { ...input, apiKey: 'x\r\nAuthorization: bad' },
    { ...input, workspaceId: 'evil.example/path' }, { ...input, endpoint: 'https://evil.test' }])
    await assert.rejects(store.save(scope, invalid), /voice_(input|key|workspace)_invalid/);
  await assert.rejects(store.save(scope, { ...input, apiKey: '' }), /^Error: voice_key_invalid$/);
  await assert.rejects(store.save(scope, { ...input, workspaceId: 'https://not-a-workspace.test' }), /^Error: voice_workspace_invalid$/);
  const unavailable = module.createCfoRealtimeSettingsStore({ ...options, safeStorage: { ...safeStorage, isEncryptionAvailable: () => false } });
  await assert.rejects(unavailable.save(scope, input), /voice_storage_unavailable/);
  await store.remove(scope); assert.equal(await restarted.load(scope), null);
});
