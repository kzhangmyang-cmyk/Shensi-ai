import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import type { AddressInfo } from 'node:net';
import WebSocket, { WebSocketServer } from 'ws';
import { CfoRealtimeService } from '../src/main/cfo-realtime-service.ts';
import { openQwenRealtime } from '../src/main/cfo-realtime-provider.ts';
import { validateVoiceSettings } from '../src/main/cfo-realtime-settings.ts';
import type { VoiceEvent } from '../src/shared/cfo-realtime.ts';

test('production service/provider forwards synthetic PCM, ends on socket loss and explicitly reconnects', { timeout: 10000 }, async t => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>(resolve => server.once('listening', resolve));
  const peers: WebSocket[] = [], frames: string[] = [], events: VoiceEvent[] = [];
  const diagnostics: Record<string, string | number | boolean>[] = [];
  let stored: { apiKey: string; workspaceId: string } | null = null;
  let calls = 0;
  server.on('connection', peer => {
    peers.push(peer);
    peer.send(JSON.stringify({ type: 'session.created' }));
    peer.on('message', bytes => {
      const event = JSON.parse(bytes.toString());
      if (event.type === 'session.update') peer.send(JSON.stringify({ type: 'session.updated', session: event.session }));
      if (event.type === 'input_audio_buffer.append') frames.push(event.audio);
    });
  });
  const service = new CfoRealtimeService({
    store: { load: async () => stored, save: async (_scope, value) => { stored = validateVoiceSettings(value); }, remove: async () => { stored = null; } },
    connect: (settings, history, receive, signal) => openQwenRealtime(settings, history, receive, signal, {
      endpoint: 'dashscope', socket: () => new WebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}`),
    }),
    ask: async () => { calls++; return { answer: 'unused', model: 'synthetic' }; },
    emit: event => events.push(event), diagnostic: event => diagnostics.push(event),
  });
  t.after(async () => {
    service.dispose();
    for (const peer of server.clients) peer.terminate();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  async function until(predicate: () => boolean) {
    const deadline = Date.now() + 2000;
    while (!predicate() && Date.now() < deadline) await delay(10);
    assert.ok(predicate(), 'expected loopback event before deadline');
  }
  const scope = { actorId: 'synthetic', workspaceId: 'isolated' };
  await service.save(scope, { apiKey: 'synthetic-secret', workspaceId: '' });
  assert.equal((await service.check(scope)).state, 'ready');
  assert.equal(frames.length, 0);
  const first = await service.start(scope, []);
  await until(() => events.some(e => e.type === 'listening' && e.sessionId === first.sessionId));
  const pcm = Buffer.alloc(640, 1).toString('base64');
  service.audio(first.sessionId, pcm);
  await until(() => frames.length === 1);
  assert.equal(frames[0], pcm);
  peers.at(-1)!.terminate();
  await until(() => events.some(e => e.type === 'ended' && e.sessionId === first.sessionId));
  assert.equal(events.filter(e => e.type === 'ended').length, 1);
  assert.equal(service.activeSessionId, null);
  assert.equal((await service.settings(scope)).state, 'ready');
  assert.throws(() => service.audio(first.sessionId, pcm), /voice_not_ready/);
  const second = await service.start(scope, []);
  assert.notEqual(second.sessionId, first.sessionId);
  await until(() => events.some(e => e.type === 'listening' && e.sessionId === second.sessionId));
  service.audio(second.sessionId, pcm);
  await until(() => frames.length === 2);
  assert.equal(frames[1], pcm);
  assert.equal(peers.length, 3, 'check plus two explicitly started sessions');
  assert.equal(calls, 0);
  assert.equal(diagnostics.filter(e => e.stage === 'session_failed').length, 1);
  assert.doesNotMatch(JSON.stringify(diagnostics), /synthetic-secret/);
});
