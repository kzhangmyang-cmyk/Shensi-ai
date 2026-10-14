import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createMacGreetingOutput, registerCfoVoiceIpc } from '../src/main/cfo-voice-ipc.ts';
import { CfoVoiceService } from '../src/main/cfo-voice.ts';
import { exposeCfoVoiceApi } from '../src/preload/cfo-voice-api.ts';

test('voice preload exposes the closed greeting preference and preview surface', async () => {
  let exposed: any; const calls: unknown[] = [];
  exposeCfoVoiceApi({
    contextBridge: { exposeInMainWorld: (key, value) => { assert.equal(key, 'shensiCfoVoice'); exposed = value; } },
    ipcRenderer: { invoke: async (channel, value) => { calls.push([channel, value]); return { muted: false, speaking: false, voice: 'male', random: false }; } }
  });
  await exposed.setPreferences({ muted: false, voice: 'male', random: false });
  await exposed.preview('workspace-1');
  assert.deepEqual(calls, [
    ['shensi:cfo-voice:command', { action: 'preferences', preferences: { muted: false, voice: 'male', random: false } }],
    ['shensi:cfo-voice:command', { action: 'preview', workspaceId: 'workspace-1' }]
  ]);
});

test('voice main service implements once-per-launch greeting, mute, and explicit playback stop', async () => {
  const module = await import('../src/main/cfo-voice.ts');
  let played = 0; let stopped = 0; let muted = false; const calls: unknown[] = [];
  const voice = new module.CfoVoiceService({
    speak: async (text, scope) => { played++; calls.push({ text, scope }); }, stop: async () => { stopped++; },
    readMuted: async () => muted, writeMuted: async (value: boolean) => { muted = value; },
  });
  const scope = { workspaceId: 'workspace-1', actorId: 'actor-1' };
  await Promise.all([voice.greet(scope), voice.greet(scope)]);
  assert.equal(played, 1);
  assert.deepEqual(calls, [{ text: '老板，你来啦。今天咱们先忙点什么？', scope }]);
  await voice.setMuted(true);
  await voice.greet(scope);
  assert.equal(played, 1);
  assert.equal(stopped, 1);
  await voice.setMuted(false);
  await voice.greet(scope);
  assert.equal(played, 1);
  await voice.stop();
  assert.equal(stopped, 2);
});

test('startup greeting preferences persist a real voice choice and random mode, and preview bypasses the launch guard', async () => {
  const writes: unknown[] = []; const spoken: unknown[] = [];
  const voice = new CfoVoiceService({
    speak: async (text, scope, voiceName) => { spoken.push({ text, scope, voiceName }); },
    stop: async () => {},
    readPreferences: async () => ({ muted: false, voice: 'female', random: true }),
    writePreferences: async value => { writes.push(value); },
  });
  const scope = { workspaceId: 'workspace-1', actorId: 'actor-1' };
  assert.deepEqual(await voice.setPreferences({ muted: false, voice: 'male', random: false }), {
    muted: false, speaking: false, voice: 'male', random: false
  });
  assert.deepEqual(writes, [{ muted: false, voice: 'male', random: false }]);
  await voice.preview(scope);
  assert.deepEqual(spoken, [{ text: '老板，你来啦。今天咱们先忙点什么？', scope, voiceName: 'male' }]);
  await assert.rejects(voice.setPreferences({ muted: false, voice: 'other', random: false } as never), /input_invalid/);
});

test('a failed preference write leaves the active voice and mute state unchanged', async () => {
  const voice = new CfoVoiceService({
    speak: async () => {}, stop: async () => {},
    readPreferences: async () => ({ muted: false, voice: 'female', random: false }),
    writePreferences: async () => { throw new Error('fixture_write_failed'); }
  });
  await assert.rejects(voice.setPreferences({ muted: false, voice: 'male', random: true }), /fixture_write_failed/);
  assert.deepEqual(await voice.status(), { muted: false, speaking: false, voice: 'female', random: false });
  await assert.rejects(voice.setMuted(true), /fixture_write_failed/);
  assert.deepEqual(await voice.status(), { muted: false, speaking: false, voice: 'female', random: false });
});

test('a new application launch respects saved mute preference without opening microphone', async () => {
  const { CfoVoiceService } = await import('../src/main/cfo-voice.ts');
  const voice = new CfoVoiceService({ speak: async () => {}, stop: async () => {},
    readMuted: async () => true, writeMuted: async () => {} });
  assert.equal((await voice.status()).muted, true);
  assert.deepEqual(Object.keys(await voice.status()).sort(), ['muted', 'random', 'speaking', 'voice']);
  await voice.greet({ workspaceId: 'workspace-1', actorId: 'actor-1' });
  await assert.rejects(voice.setMuted('true' as never), /invalid/);
});

test('greeting IPC only accepts the app main frame and a closed command set', async () => {
  let handler!: (event: any, input: unknown) => unknown;
  const sender = { mainFrame: { url: 'http://127.0.0.1:5500/' }, isDestroyed: () => false };
  const voice = new CfoVoiceService({ speak: async () => {}, stop: async () => {}, readMuted: async () => false, writeMuted: async () => {} });
  const ipc = registerCfoVoiceIpc({ localOrigin: 'http://127.0.0.1:5500', voice, authorizedSender: () => sender,
    authorize: async workspaceId => ({ workspaceId, actorId: 'actor-1' }),
    ipcMain: { handle: (_key, value) => { handler = value; }, removeHandler: () => {} } });
  const event = { sender, senderFrame: sender.mainFrame };
  assert.deepEqual(Object.keys(await handler(event, { action: 'status' }) as object).sort(), ['muted', 'random', 'speaking', 'voice']);
  await handler(event, { action: 'greet', workspaceId: 'workspace-1' });
  for (const input of [{ action: 'greet' }, { action: 'greet', workspaceId: 'workspace-1', text: 'arbitrary' }, { action: 'transcribe', path: '/etc/hosts' },
    { action: 'mute', muted: 'false' }]) await assert.rejects(async () => handler(event, input), /input_invalid/);
  await assert.rejects(async () => handler({ ...event, senderFrame: { url: sender.mainFrame.url } }, { action: 'greet' }), /sender_invalid/);
  sender.mainFrame.url = 'https://example.com';
  await assert.rejects(async () => handler(event, { action: 'greet' }), /sender_invalid/);
  ipc.dispose();
});

test('Mac greeting output writes one private WAV cache and replays it without another cloud synthesis', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'shensi-greeting-'))); t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'voice'); let synthesized = 0; const played: string[] = [];
  const output = createMacGreetingOutput({ directory,
    store: { load: async () => ({ apiKey: 'fixture-key', workspaceId: '' }), save: async () => {}, remove: async () => {} },
    synthesize: async () => { synthesized++; return Buffer.alloc(480, 7); },
    play: async file => { played.push(file); }
  });
  const scope = { workspaceId: 'workspace-1', actorId: 'actor-1' };
  await output.speak('老板，你来啦。今天咱们先忙点什么？', scope);
  await output.speak('老板，你来啦。今天咱们先忙点什么？', scope);
  assert.equal(synthesized, 1); assert.deepEqual(played, [output.assetPath, output.assetPath]);
  const wave = await readFile(output.assetPath);
  assert.equal(wave.toString('ascii', 0, 4), 'RIFF'); assert.equal(wave.readUInt32LE(24), 24_000);
  assert.equal(wave.readUInt16LE(34), 16); assert.equal(wave.length, 524);
});

test('a fresh Mac seeds the private greeting cache from the packaged verified WAV without a cloud credential', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'shensi-greeting-bundled-'))); t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'voice'); const bundledDirectory = join(root, 'bundle');
  await mkdir(bundledDirectory); const bundledAssetPath = join(bundledDirectory, 'greeting.wav');
  const pcm = Buffer.alloc(480, 5); const wave = Buffer.alloc(44 + pcm.length);
  wave.write('RIFF', 0); wave.writeUInt32LE(36 + pcm.length, 4); wave.write('WAVEfmt ', 8);
  wave.writeUInt32LE(16, 16); wave.writeUInt16LE(1, 20); wave.writeUInt16LE(1, 22);
  wave.writeUInt32LE(24_000, 24); wave.writeUInt32LE(48_000, 28); wave.writeUInt16LE(2, 32);
  wave.writeUInt16LE(16, 34); wave.write('data', 36); wave.writeUInt32LE(pcm.length, 40); pcm.copy(wave, 44);
  await writeFile(bundledAssetPath, wave); await chmod(bundledAssetPath, 0o644);
  let settingsReads = 0; let synthesized = 0; const played: string[] = [];
  const output = createMacGreetingOutput({ directory, bundledAssetPath,
    store: { load: async () => { settingsReads++; return null; }, save: async () => {}, remove: async () => {} },
    synthesize: async () => { synthesized++; return pcm; }, play: async file => { played.push(file); } });
  await output.speak('老板，你来啦。今天咱们先忙点什么？', { workspaceId: 'workspace-1', actorId: 'actor-1' });
  assert.equal(settingsReads, 0); assert.equal(synthesized, 0); assert.deepEqual(played, [output.assetPath]);
  assert.deepEqual(await readFile(output.assetPath), wave);
});

test('stop invalidates a greeting still waiting for authorization', async () => {
  let handler!: (event: any, input: unknown) => unknown; let authorize!: (value: { workspaceId: string; actorId: string }) => void;
  const sender = { mainFrame: { url: 'http://127.0.0.1:5500/' }, isDestroyed: () => false }; let played = 0;
  const voice = new CfoVoiceService({ speak: async () => { played++; }, stop: async () => {}, readMuted: async () => false, writeMuted: async () => {} });
  const ipc = registerCfoVoiceIpc({ localOrigin: 'http://127.0.0.1:5500', voice, authorizedSender: () => sender,
    authorize: async () => new Promise(resolve => { authorize = resolve; }),
    ipcMain: { handle: (_key, value) => { handler = value; }, removeHandler: () => {} } });
  const event = { sender, senderFrame: sender.mainFrame };
  const pending = Promise.resolve(handler(event, { action: 'greet', workspaceId: 'workspace-1' }));
  await handler(event, { action: 'stop' }); authorize({ workspaceId: 'workspace-1', actorId: 'actor-1' });
  await pending; assert.equal(played, 0);
  ipc.dispose();
});
