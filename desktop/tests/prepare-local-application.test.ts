import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, realpath, rm, mkdir, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareLocalApplication } from '../src/main/prepare-local-application.ts';

test('existing database without installation credentials does not create replacement keys', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'shensi-prepare-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'database'), { mode: 0o700 });
  await writeFile(join(root, 'database', 'existing-data'), 'preserve');
  let encrypted = false;
  await assert.rejects(prepareLocalApplication({ userData: root, mysqlRuntimeDirectory: '/unused',
    nodeExecutable: process.execPath, backendEntrypoint: '/unused', buildDigest: 'a'.repeat(64),
    safeStorage: { isEncryptionAvailable: () => true,
      encryptString: () => { encrypted = true; return Buffer.from('unexpected'); }, decryptString: () => '' } }), /secrets_missing/);
  assert.equal(encrypted, false);
});

test('preparation keeps the OS encryption adapter out of cloneable runtime configuration', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'shensi-prepare-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = join(root, 'mysql', 'bin'); await mkdir(bin, { recursive: true });
  // Resources are only checked here; this test never launches these placeholders.
  for (const name of ['mysql', 'mysqld']) await writeFile(join(bin, name), '', { mode: 0o700 });
  const entrypoint = join(root, 'backend.js'); await writeFile(entrypoint, '');
  const runtime = await prepareLocalApplication({ userData: join(root, 'application'),
    mysqlRuntimeDirectory: join(root, 'mysql'), nodeExecutable: process.execPath,
    backendEntrypoint: entrypoint, buildDigest: 'a'.repeat(64), safeStorage: {
      isEncryptionAvailable: () => true, encryptString: () => Buffer.from('opaque-test-ciphertext'), decryptString: () => '' },
    requestInitialAccount: async () => ({ account: 'customer', password: 'synthetic-password-123' }) });
  assert.throws(() => runtime.origin, /not_ready/);
  assert.equal((await stat(join(root, 'application/knowledge'))).mode & 0o777, 0o700);
  await runtime.stop();
});

test('fresh database requires customer setup instead of silently creating a hidden account', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'shensi-prepare-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(prepareLocalApplication({ userData: join(root, 'application'), mysqlRuntimeDirectory: '/unused',
    nodeExecutable: process.execPath, backendEntrypoint: '/unused', buildDigest: 'a'.repeat(64), safeStorage: {
      isEncryptionAvailable: () => true, encryptString: () => Buffer.from('opaque-test-ciphertext'), decryptString: () => '' },
    requestInitialAccount: async () => null }), /setup_cancelled/);
});
