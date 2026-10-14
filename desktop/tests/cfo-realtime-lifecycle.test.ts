import assert from 'node:assert/strict';
import test from 'node:test';
import { CfoRealtimeService } from '../src/main/cfo-realtime-service.ts';

// External socket/audio are synthetic; the service owns actual cancellation,
// generation fencing, saved-state transitions and inactivity timers.
function fixture() {
  let stored: any = null;
  const peers: any[] = [], events: any[] = [], diagnostics: any[] = [], tools: any[] = [];
  const service = new CfoRealtimeService({
    store: { load: async () => stored && structuredClone(stored),
      save: async (_scope, value) => { stored = structuredClone(value); }, remove: async () => { stored = null; } },
    connect: async (_settings, _history, receive, signal) => {
      const peer = { receive, signal, closed: false, send() {}, close() { peer.closed = true; } };
      peers.push(peer); return peer;
    },
    ask: (_scope, _input, signal) => new Promise(resolve => tools.push({ signal, resolve })),
    emit: event => events.push(event), diagnostic: row => diagnostics.push(row),
  });
  return { service, peers, events, diagnostics, tools, stored: () => stored, scope: { workspaceId: 'isolated', actorId: 'fixture' } };
}

test('network close aborts business work, fences late events and permits an explicit fresh session without erasing settings', async t => {
  const f = fixture(); t.after(() => f.service.dispose());
  await f.service.save(f.scope, { apiKey: 'synthetic-private-key', workspaceId: '' });
  await f.service.check(f.scope); const first = await f.service.start(f.scope, []);
  const old = f.peers.at(-1);
  old.receive({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'q', transcript: 'synthetic-private-business' });
  assert.equal(f.tools.length, 1);
  old.receive({ type: 'closed', code: 'voice_network_failed' });
  assert.equal(f.tools[0].signal.aborted, true); assert.equal(old.closed, true);
  assert.equal(f.events.filter(e => e.type === 'ended').length, 1);
  assert.equal(f.stored().apiKey, 'synthetic-private-key');
  assert.equal((await f.service.settings(f.scope)).state, 'ready');
  const second = await f.service.start(f.scope, []); assert.notEqual(second.sessionId, first.sessionId);
  const boundary = f.events.length;
  old.receive({ type: 'closed', code: 'voice_protocol_failed' });
  old.receive({ type: 'response.audio.delta', response_id: 'late', delta: 'AAA=' });
  f.tools[0].resolve({ answer: 'late private business result', model: 'fixture' });
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(f.events.slice(boundary).every(e => e.type === 'listening' && e.sessionId === second.sessionId));
  assert.equal(f.diagnostics.filter(e => e.stage === 'session_failed').length, 1);
  assert.doesNotMatch(JSON.stringify(f.diagnostics), /synthetic-private|late private/);
});

test('missing microphone frames ends once with a distinct diagnostic and clears its monitor', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval', 'setTimeout'], now: 1000 });
  const f = fixture(); t.after(() => f.service.dispose());
  await f.service.save(f.scope, { apiKey: 'synthetic-private-key', workspaceId: '' }); await f.service.check(f.scope);
  await f.service.start(f.scope, []); await Promise.resolve();
  t.mock.timers.tick(65000);
  assert.equal(f.events.find(e => e.type === 'error')?.code, 'voice_audio_unavailable');
  assert.equal(f.events.filter(e => e.type === 'ended').length, 1);
  t.mock.timers.tick(120000);
  assert.equal(f.events.filter(e => e.type === 'ended').length, 1);
  assert.equal(f.peers.at(-1).closed, true);
  assert.equal(f.diagnostics.find(e => e.stage === 'session_failed')?.audioGapMs, 20000);
  assert.equal((await f.service.settings(f.scope)).state, 'ready');
});

test('stop during socket startup closes the late socket without reviving playback', async t => {
  let resolveSocket!: (port: any) => void;
  let connections = 0, closed = 0; const events: any[] = [];
  const service = new CfoRealtimeService({
    store: { load: async () => ({ apiKey: 'synthetic', workspaceId: '' }), save: async () => {}, remove: async () => {} },
    connect: async () => { if (++connections === 1) return { send() {}, close() {} }; return new Promise(resolve => { resolveSocket = resolve; }); },
    ask: async () => ({ answer: 'unused', model: 'fixture' }), emit: event => events.push(event),
  });
  t.after(() => service.dispose()); const scope = { workspaceId: 'isolated', actorId: 'fixture' };
  await service.check(scope); await service.start(scope, []); service.stop();
  resolveSocket({ send() { throw Error('late socket must not send'); }, close() { closed++; } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(closed, 1); assert.deepEqual(events.map(e => e.type), ['ended']);
});
