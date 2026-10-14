import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { LocalBackendRuntime } from '../src/main/local-backend-runtime.ts';
import { embeddedReferenceEnvironment } from '../src/main/embedded-reference-pack.ts';

async function unusedPort() {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  await new Promise<void>(resolve => server.close(() => resolve()));
  return address.port;
}

function runtime(port: number, mode = 'normal') {
  return new LocalBackendRuntime({
    nodeExecutable: process.execPath,
    entrypoint: fileURLToPath(new URL('./fixtures/local-backend-fixture.mjs', import.meta.url)),
    port, environment: { FIXTURE_MODE: mode }, startupTimeoutMs: 1500, shutdownTimeoutMs: 1000,
  });
}

test('backend exposes origin only after its own listener and MySQL health; restart works', async () => {
  const port = await unusedPort(); const service = runtime(port);
  process.env.SHENSI_TEST_PARENT_SECRET = 'must-not-inherit';
  try {
    assert.throws(() => service.origin, /not_ready/);
    await service.start(new AbortController().signal);
    const health = await (await fetch(`${service.origin}/api/health`)).json();
    assert.equal(health.inheritedSecret, null);
    await assert.rejects(service.start(new AbortController().signal), /already_started/);
    await Promise.all([service.stop(), service.stop()]);
    assert.throws(() => service.origin, /not_ready/);
    await service.start(new AbortController().signal);
    assert.equal(service.origin, `http://127.0.0.1:${port}`);
  } finally { delete process.env.SHENSI_TEST_PARENT_SECRET; await service.stop(); }
});

test('occupied port fails without adopting or closing unrelated listener', async () => {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const service = runtime(address.port);
  try {
    await assert.rejects(service.start(new AbortController().signal), /start_failed/);
    assert.throws(() => service.origin, /not_ready/);
    await service.stop(); assert.equal(server.listening, true);
  } finally { await service.stop(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('startup cancellation stops pending child without reporting readiness', async () => {
  const service = runtime(await unusedPort(), 'hang'); const abort = new AbortController();
  const starting = service.start(abort.signal);
  const rejected = assert.rejects(starting, /start_cancelled/);
  abort.abort(); await rejected; await service.stop();
  assert.throws(() => service.origin, /not_ready/);
});

for (const mode of ['memory', 'exit', 'hang']) {
  test(`rejects ${mode} instead of reporting a usable backend`, async () => {
    const service = runtime(await unusedPort(), mode);
    try { await assert.rejects(service.start(new AbortController().signal), /start_failed/); }
    finally { await service.stop(); }
    assert.throws(() => service.origin, /not_ready/);
  });
}

test('post-readiness process exit immediately invalidates origin', async () => {
  const service = runtime(await unusedPort(), 'crash');
  try {
    await service.start(new AbortController().signal);
    await delay(250);
    assert.throws(() => service.origin, /not_ready/);
  } finally { await service.stop(); }
});

test('backend child receives only the Main-selected embedded pack, not inherited cloud configuration', async () => {
  const pack = { path: '/readonly/system-reference/books.json.gz', sha256: 'a'.repeat(64) };
  const prior = process.env.SHENSI_REFERENCE_MODE;
  process.env.SHENSI_REFERENCE_MODE = 'central';
  const service = new LocalBackendRuntime({ nodeExecutable: process.execPath,
    entrypoint: fileURLToPath(new URL('./fixtures/local-backend-fixture.mjs', import.meta.url)),
    port: await unusedPort(), environment: embeddedReferenceEnvironment(pack), startupTimeoutMs: 1500 });
  try {
    await service.start(new AbortController().signal);
    const health = await (await fetch(`${service.origin}/api/health`)).json();
    assert.deepEqual(health.reference, { mode: 'embedded', path: pack.path, sha256: pack.sha256 });
  } finally {
    await service.stop();
    if (prior === undefined) delete process.env.SHENSI_REFERENCE_MODE; else process.env.SHENSI_REFERENCE_MODE = prior;
  }
});
