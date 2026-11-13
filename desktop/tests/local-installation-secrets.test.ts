import assert from 'node:assert/strict';
import test from 'node:test';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdtemp, realpath, readFile, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalInstallationSecretStore } from '../src/main/local-installation-secrets.ts';
import type { SafeStorage } from '../src/main/device-credential-store.ts';

// OS encryption boundary substitute; filesystem, validation and persistence are real.
function encryption(): SafeStorage {
  const key = randomBytes(32);
  return { isEncryptionAvailable: () => true,
    encryptString(text) {
      const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key, iv);
      const bytes = Buffer.concat([cipher.update(text), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), bytes]);
    },
    decryptString(bytes) {
      const cipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
      cipher.setAuthTag(bytes.subarray(12, 28));
      return Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString('utf8');
    } };
}

test('independent installations have distinct encrypted credentials, retained on reopen', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'shensi-installation-secrets-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'secrets'); const safeStorage = encryption();
  const store = createLocalInstallationSecretStore({ directory, safeStorage });
  await assert.rejects(store.loadOrCreate(false), /missing/);
  const first = await store.loadOrCreate(true);
  const reopened = await createLocalInstallationSecretStore({ directory, safeStorage }).loadOrCreate(false);
  assert.deepEqual(reopened, first);
  const second = await createLocalInstallationSecretStore({ directory: join(root, 'second'), safeStorage }).loadOrCreate(true);
  const values = [first.mysqlRootPassword, first.mysqlAppPassword, first.bootstrapPassword, ...Object.values(first.backend)];
  assert.equal(new Set(values).size, 16);
  for (const value of values) { assert.match(value, /^[a-f0-9]{64}$/); assert.ok(!JSON.stringify(second).includes(value)); }
  const file = await readFile(join(directory, 'installation.json'), 'utf8');
  for (const value of values) assert.ok(!file.includes(value));
  assert.deepEqual(Object.keys(JSON.parse(file)).sort(), ['ciphertext', 'version']);
});

test('simultaneous first reads keep one stable installation key set', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'shensi-installation-secrets-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const options = { directory: join(root, 'secrets'), safeStorage: encryption() };
  const values = await Promise.all(Array.from({ length: 3 }, () => createLocalInstallationSecretStore(options).loadOrCreate(true)));
  assert.deepEqual(values[0], values[1]); assert.deepEqual(values[1], values[2]);
});

test('unavailable encryption, lost encryption key and unsafe permissions never replace credentials', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'shensi-installation-secrets-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'secrets'); const safeStorage = encryption();
  const store = createLocalInstallationSecretStore({ directory, safeStorage });
  await store.loadOrCreate(true);
  const path = join(directory, 'installation.json'); const prior = await readFile(path, 'utf8');
  await assert.rejects(createLocalInstallationSecretStore({ directory,
    safeStorage: { ...safeStorage, isEncryptionAvailable: () => false } }).loadOrCreate(true), /encryption_unavailable/);
  await assert.rejects(createLocalInstallationSecretStore({ directory, safeStorage: encryption() }).loadOrCreate(true), /decryption_failed/);
  await chmod(path, 0o644); await assert.rejects(store.loadOrCreate(true), /private_storage_invalid/);
  assert.equal(await readFile(path, 'utf8'), prior);
});
