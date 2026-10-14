import assert from 'node:assert/strict';
import { CfoRealtimeSession, type RealtimeEvent, type RealtimePort } from './cfo-realtime-session';

export async function runCfoRealtimeSessionTests() {
  let opened = 0; let released = 0; let cleared = 0; let closed = 0;
  let event!: (e: RealtimeEvent) => void;
  const cancellations: unknown[] = [];
  const port: RealtimePort = { cancelAndTruncate: async (id, ms) => { cancellations.push([id, ms]); },
    close: () => { closed++; } };
  const audio = { openMicrophone: async () => { opened++; return () => { released++; }; },
    clearPlayback: () => { cleared++; } };
  const absent = new CfoRealtimeSession({ audio });
  await absent.start();
  assert.equal(absent.state, 'unavailable'); assert.equal(opened, 0);
  const session = new CfoRealtimeSession({ audio, connect: async (callback) => { event = callback; return port; } });
  await session.start(); assert.equal(session.state, 'listening');
  event({ type: 'user_final', text: '收入怎么样' });
  event({ type: 'response_started', responseId: 'r1' });
  event({ type: 'played', responseId: 'r1', playedMs: 900, heardText: '目前缺少报表' });
  event({ type: 'speech_started' });
  await new Promise(r => setTimeout(r, 0));
  assert.deepEqual(cancellations, [['r1', 900]]);
  assert.ok(cleared > 0); assert.equal(session.state, 'listening');
  event({ type: 'response_started', responseId: 'r1' });
  event({ type: 'played', responseId: 'r1', playedMs: 3000, heardText: '未听到的内容' });
  assert.deepEqual(session.history, [{ role: 'user', text: '收入怎么样' }, { role: 'assistant', text: '目前缺少报表' }]);
  event({ type: 'disconnected' });
  assert.equal(session.state, 'disconnected'); assert.equal(released, 1); assert.equal(closed, 1);
  await session.start();
  assert.equal(session.state, 'listening'); assert.equal(opened, 2);
  session.end(); assert.equal(released, 2); assert.equal(session.state, 'ended');
  event({ type: 'response_started', responseId: 'late' });
  assert.equal(session.state, 'ended');

  let resolve!: (stop: () => void) => void;
  const slow = new CfoRealtimeSession({ audio: { ...audio, openMicrophone: () => new Promise(r => { resolve = r; }) },
    connect: async () => port });
  const starting = slow.start(); slow.end(); let stopped = false;
  resolve(() => { stopped = true; }); await starting;
  assert.equal(stopped, true); assert.equal(slow.state, 'ended');
}
