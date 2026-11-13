import assert from 'node:assert/strict';
import test from 'node:test';
import { LocalServiceLifecycle } from '../src/main/local-service-lifecycle.ts';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

test('backend starts only after database readiness; stop reverses order once', async () => {
  const dbReady = deferred();
  const calls: string[] = [];
  const runtime = new LocalServiceLifecycle({
    database: { start: async () => { calls.push('db:start'); await dbReady.promise; }, stop: async () => { calls.push('db:stop'); } },
    backend: { start: async () => { calls.push('api:start'); }, stop: async () => { calls.push('api:stop'); } },
  });
  const started = runtime.start();
  assert.deepEqual(calls, ['db:start']);
  assert.equal(runtime.getState(), 'starting');
  await assert.rejects(runtime.start(), /local_services_already_started/);
  dbReady.resolve();
  await started;
  assert.equal(runtime.getState(), 'ready');
  await Promise.all([runtime.stop(), runtime.stop()]);
  await runtime.stop();
  assert.deepEqual(calls, ['db:start', 'api:start', 'api:stop', 'db:stop']);
  assert.equal(runtime.getState(), 'stopped');
});

test('backend failure cleans both attempted services and hides connection details', async () => {
  const calls: string[] = [];
  const runtime = new LocalServiceLifecycle({
    database: { start: async () => {}, stop: async () => { calls.push('db'); } },
    backend: { start: async () => { throw new Error('mysql://secret'); }, stop: async () => { calls.push('api'); } },
  });
  await assert.rejects(runtime.start(), /^Error: local_services_start_failed$/);
  assert.deepEqual(calls, ['api', 'db']);
  assert.equal(runtime.getState(), 'stopped');
});

test('quit during database start aborts it and never launches backend', async () => {
  const calls: string[] = [];
  const runtime = new LocalServiceLifecycle({
    database: {
      start: signal => new Promise<void>((_, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })),
      stop: async () => { calls.push('db:stop'); },
    },
    backend: { start: async () => { calls.push('api:start'); }, stop: async () => { calls.push('api:stop'); } },
  });
  const starting = runtime.start();
  const rejection = assert.rejects(starting, /^Error: local_services_start_cancelled$/);
  await runtime.stop();
  await rejection;
  assert.deepEqual(calls, ['db:stop']);
});

test('database startup failure still cleans its partial process but never stops unstarted backend', async () => {
  const calls: string[] = [];
  const runtime = new LocalServiceLifecycle({
    database: { start: async () => { throw new Error('partial init'); }, stop: async () => { calls.push('db'); } },
    backend: { start: async () => { calls.push('api:start'); }, stop: async () => { calls.push('api:stop'); } },
  });
  await assert.rejects(runtime.start(), /local_services_start_failed/);
  assert.deepEqual(calls, ['db']);
});

test('failed stop still cleans database and prevents unsafe restart', async () => {
  const calls: string[] = [];
  const runtime = new LocalServiceLifecycle({
    database: { start: async () => {}, stop: async () => { calls.push('db'); } },
    backend: { start: async () => {}, stop: async () => { calls.push('api'); throw new Error('private path'); } },
  });
  await runtime.start();
  await assert.rejects(runtime.stop(), /^Error: local_services_stop_failed$/);
  assert.deepEqual(calls, ['api', 'db']);
  assert.equal(runtime.getState(), 'failed');
  await assert.rejects(runtime.start(), /local_services_cleanup_required/);
});

test('clean stop permits another start without retaining a cancelled signal', async () => {
  const signals: AbortSignal[] = [];
  const runtime = new LocalServiceLifecycle({
    database: { start: async signal => { signals.push(signal); assert.equal(signal.aborted, false); }, stop: async () => {} },
    backend: { start: async () => {}, stop: async () => {} },
  });
  await runtime.start(); await runtime.stop(); await runtime.start(); await runtime.stop();
  assert.equal(signals.length, 2);
  assert.notEqual(signals[0], signals[1]);
});
