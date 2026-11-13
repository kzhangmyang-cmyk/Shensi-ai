import assert from 'node:assert/strict';
import { CfoRealtimeClient } from './cfo-realtime-client';
import type { CfoRealtimeBridge, VoiceEvent } from '../../../../desktop/src/shared/cfo-realtime';
export async function runCfoRealtimeClientTests() {
  let receive!: (event: VoiceEvent) => void; let released = 0; let stops = 0; let unsubscribed = 0;
  let resolveMic!: (release: () => void) => void; let closed = 0;
  const turns: any[] = []; const errors: string[] = [];
  const sourceIds: (string | null | undefined)[] = [];
  const bridge = { start: async (_workspace: string, _history: unknown, documentId?: string | null) => { sourceIds.push(documentId); return { sessionId: 'test-session' }; }, stop: async () => { stops++; },
    onEvent: (listener: typeof receive) => { receive = listener; return () => { unsubscribed++; }; },
    audio: async () => {}, played: async () => {} } as unknown as CfoRealtimeBridge;
  const context = { resume: async () => {}, close: async () => { closed++; }, currentTime: 0 } as unknown as AudioContext;
  const client = new CfoRealtimeClient({ bridge, createAudio: () => context,
    microphone: async () => new Promise(resolve => { resolveMic = resolve; }), onState() {},
    onTurn: turn => turns.push(turn), onError: code => errors.push(code), onBusiness() {} });
  const starting = client.start('workspace', [], 'doc-voice'); await new Promise(r => setTimeout(r, 0));
  assert.equal(sourceIds[0], 'doc-voice', 'voice session must freeze the explicitly selected source');
  client.stop(); resolveMic(() => { released++; }); await starting;
  assert.equal(released, 1); assert.equal(closed, 1); assert.ok(stops > 0); assert.equal(unsubscribed, 1);
  receive({ sessionId: 'test-session', type: 'user', text: '迟到输入' }); assert.deepEqual(turns, []);
  assert.equal(errors.length, 0);
  const denied = new CfoRealtimeClient({ bridge, createAudio: () => context,
    microphone: async () => { throw new Error('voice_microphone_denied'); }, onState() {}, onTurn() {}, onBusiness() {}, onError: code => errors.push(code) });
  await denied.start('workspace', []); assert.deepEqual(errors, ['voice_microphone_denied']); assert.equal(closed, 2);

  const previews: any[] = []; const streamedTurns: any[] = []; const states: string[] = [];
  let acknowledge!: () => void;
  const audio = { ...context, currentTime: 0, getOutputTimestamp: () => ({ contextTime: audio.currentTime }), destination: {},
    createBuffer: (_channels: number, size: number, rate: number) => ({ duration: size / rate, copyToChannel() {} }),
    createBufferSource: () => ({ connect() {}, disconnect() {}, start() {}, stop() {} }) } as unknown as AudioContext;
  const streaming = new CfoRealtimeClient({ bridge: { ...bridge, played: async () => new Promise<void>(r => { acknowledge = r; }) },
    createAudio: () => audio, microphone: async () => () => {}, onState: state => states.push(state),
    onTurn: turn => streamedTurns.push(turn), onPreview: preview => previews.push(preview), onError() {}, onBusiness() {} });
  await streaming.start('workspace', []);
  receive({ sessionId: 'test-session', type: 'thinking' }); assert.equal(states.at(-1), 'thinking');
  receive({ sessionId: 'test-session', type: 'reconnecting' }); assert.equal(states.at(-1), 'connecting');
  receive({ sessionId: 'test-session', type: 'transcript', responseId: 'one', text: '利润' });
  receive({ sessionId: 'test-session', type: 'transcript', responseId: 'one', text: '利润不等于现金。' });
  assert.equal(previews.at(-1).text, '利润不等于现金。'); assert.deepEqual(streamedTurns, []);
  receive({ sessionId: 'test-session', type: 'audio', responseId: 'one', pcm: btoa('\0'.repeat(480)) });
  receive({ sessionId: 'test-session', type: 'response_done', responseId: 'one', text: '利润不等于现金。' });
  (audio as any).currentTime = 1;
  await new Promise(r => setTimeout(r, 115));
  receive({ sessionId: 'test-session', type: 'interrupted' });
  acknowledge(); await new Promise(r => setTimeout(r, 0));
  assert.deepEqual(streamedTurns, [], 'late playback ACK cannot commit an interrupted response');
  assert.equal(previews.at(-1).state, 'interrupted');
  const previewCount = previews.length;
  receive({ sessionId: 'test-session', type: 'transcript', responseId: 'one', text: '迟到改写' });
  assert.equal(previews.length, previewCount);
  receive({ sessionId: 'test-session', type: 'transcript', responseId: 'two', text: '新的回答' });
  assert.equal(previews.at(-1).responseId, 'two'); streaming.stop();
}
