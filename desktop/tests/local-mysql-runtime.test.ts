import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes } from 'node:crypto';
import { mkdtemp, realpath, rm, writeFile, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { LocalMysqlRuntime } from '../src/main/local-mysql-runtime.ts';

const credentials = () => ({ rootPassword: randomBytes(32).toString('hex'), appPassword: randomBytes(32).toString('hex') });

test('incomplete initialization stops without deleting or recreating user data', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'shensi-native-db-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'initialization.json'), '{"version":1,"state":"initializing"}', { mode: 0o600 });
  await writeFile(join(root, 'preserve-me'), 'existing-data');
  const service = new LocalMysqlRuntime({ directory: root, runtimeDirectory: '/not-used', ...credentials() });
  await assert.rejects(service.start(new AbortController().signal), /initialization_incomplete/);
  assert.equal(await readFile(join(root, 'preserve-me'), 'utf8'), 'existing-data');
  await service.stop();
});

test('nonempty unrecognized directory is never initialized', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'shensi-native-db-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'existing-data'), 'preserve');
  const service = new LocalMysqlRuntime({ directory: root, runtimeDirectory: '/not-used', ...credentials() });
  await assert.rejects(service.start(new AbortController().signal), /directory_not_empty/);
  assert.equal(await readFile(join(root, 'existing-data'), 'utf8'), 'preserve');
});

test('native MySQL creates limited credentials, retains data across restart, and rejects wrong credentials',
  { skip: !process.env.SHENSI_TEST_MYSQL_RUNTIME }, async t => {
    const root = await realpath(await mkdtemp(join(tmpdir(), `shensi-native-db-${'long-user-data-'.repeat(5)}`)));
    const options = { directory: root, runtimeDirectory: process.env.SHENSI_TEST_MYSQL_RUNTIME!, ...credentials() };
    const service = new LocalMysqlRuntime(options);
    t.after(async () => { await service.stop(); await rm(root, { recursive: true, force: true }); });
    const require = createRequire(new URL('../../backend/package.json', import.meta.url));
    const mysql = require('mysql2/promise');
    assert.throws(() => service.databaseUrl, /not_ready/);
    await service.start(new AbortController().signal);
    const socket = new URL(service.databaseUrl).searchParams.get('socketPath')!;
    assert.ok(Buffer.byteLength(socket) <= 100);
    assert.equal((await stat(dirname(socket))).mode & 0o777, 0o700);
    assert.ok(!socket.startsWith(root));
    let connection = await mysql.createConnection(service.databaseUrl);
    try {
      await connection.query('CREATE TABLE acceptance (id INT PRIMARY KEY, label VARCHAR(50))');
      await connection.execute('INSERT INTO acceptance VALUES (?,?)', [1, '单机持久化']);
      await assert.rejects(connection.query('SELECT * FROM mysql.user'), /denied/i);
      const [rows] = await connection.query('SELECT @@skip_networking AS isolated');
      assert.equal(rows[0].isolated, 1);
      const [clockRows] = await connection.query('SELECT TIMESTAMPDIFF(SECOND, UTC_TIMESTAMP(), CURRENT_TIMESTAMP()) AS utc_offset_seconds');
      assert.equal(clockRows[0].utc_offset_seconds, 0, 'lease database clock must use UTC');
    } finally { await connection.end(); }
    await service.stop();
    await assert.rejects(stat(dirname(socket)), { code: 'ENOENT' });
    await service.start(new AbortController().signal);
    connection = await mysql.createConnection(service.databaseUrl);
    try { const [rows] = await connection.query('SELECT label FROM acceptance'); assert.equal(rows[0].label, '单机持久化'); }
    finally { await connection.end(); }
    await service.stop();
    const wrong = new LocalMysqlRuntime({ ...options, appPassword: randomBytes(32).toString('hex') });
    try { await assert.rejects(wrong.start(new AbortController().signal), /credentials_invalid/); }
    finally { await wrong.stop(); }
    assert.match(await readFile(join(root, 'initialization.json'), 'utf8'), /ready/);
  });
