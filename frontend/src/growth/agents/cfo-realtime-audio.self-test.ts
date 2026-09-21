import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { CfoPcmPlayback, openCfoMicrophone } from './cfo-realtime-audio';

export async function runCfoRealtimeAudioTests() {
  const chunks: ArrayBuffer[] = []; let Processor: any;
  const source = await readFile(new URL('../../../public/worklets/cfo-pcm-capture.js', import.meta.url), 'utf8');
  vm.runInNewContext(source, { sampleRate: 48000, Int16Array, Float32Array,
    AudioWorkletProcessor: class { port = { postMessage: (data: ArrayBuffer) => chunks.push(data) }; },
    registerProcessor: (_name: string, implementation: any) => { Processor = implementation; } });
  const processor = new Processor();
  // 300 consecutive render quanta = 0.8s. No resetting the resampler at chunk boundaries.
  for (let i = 0; i < 300; i++) processor.process([[new Float32Array(128).fill(.5)]]);
  assert.equal(chunks.length, 8); assert.equal(chunks.reduce((n, c) => n + c.byteLength, 0), 25600);
  assert.ok(Array.from(new Int16Array(chunks[0])).every(value => Math.abs(value - 16384) <= 1));
  let clock = 0; let stopped = 0; const acknowledgements: any[] = []; const heard: string[] = [];
  const context = { currentTime: 0, getOutputTimestamp: () => ({ contextTime: clock }), destination: {},
    createBuffer: (_channels: number, frames: number, rate: number) => ({ duration: frames / rate, copyToChannel() {} }),
    createBufferSource: () => ({ buffer: null, connect() {}, disconnect() {}, start() {}, stop() { stopped++; } }) } as unknown as AudioContext;
  const player = new CfoPcmPlayback(context, (id, ms, complete, text) => { acknowledgements.push({ id, ms, complete }); if (complete) heard.push(text); });
  const pcm = Buffer.alloc(4800).toString('base64');
  player.append('one', pcm); player.done('one', '完整播报');
  clock = .06; player.tick(); assert.equal(heard.length, 0); assert.ok(acknowledgements.at(-1).ms < 100);
  clock = .3; player.tick(); assert.deepEqual(heard, ['完整播报']); player.tick(); assert.equal(heard.length, 1);
  player.append('two', pcm); clock = .32; player.tick(); player.clear(); assert.ok(stopped > 0);
  clock = 3; player.tick(); assert.deepEqual(heard, ['完整播报']);
  assert.throws(() => player.append('invalid', 'not-base64'), /voice_protocol_failed/);
  let resolveCapture!: (value: MediaStream) => void; let tracksStopped = 0;
  const abort = new AbortController();
  const capture = openCfoMicrophone(context, () => assert.fail('cancelled capture must be silent'), abort.signal,
    { getUserMedia: async () => new Promise(r => { resolveCapture = r; }) });
  abort.abort(); resolveCapture({ getTracks: () => [{ stop: () => { tracksStopped++; } }] } as unknown as MediaStream);
  await assert.rejects(capture, /voice_audio_unavailable/); assert.ok(tracksStopped > 0);
}
