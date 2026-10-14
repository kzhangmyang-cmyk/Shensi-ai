import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { open, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { CFO_VOICE_CHANNEL, type GreetingPreferences, type GreetingVoice } from '../shared/cfo-voice.ts';
import { CfoVoiceService } from './cfo-voice.ts';
import { synthesizeQwenGreeting } from './cfo-greeting-synthesis.ts';
import type { VoiceScope, VoiceSettingsStore } from './cfo-realtime-settings.ts';
import { ensurePrivateDirectory, readPrivateFile, serialized, writePrivateFile } from './private-storage.ts';

export const CFO_GREETING_ASSET_FILENAME = 'startup-greeting-qwen35-tina-v1.wav';
const MAX_WAVE_BYTES = 1_000_044;
const DEFAULT_PREFERENCES: GreetingPreferences = { muted: false, voice: 'female', random: false };

function parsePreferences(raw: string | null): GreetingPreferences {
  if (raw === null) return { ...DEFAULT_PREFERENCES };
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (typeof value.muted !== 'boolean') throw new Error();
    if (value.voice === undefined && value.random === undefined) return { ...DEFAULT_PREFERENCES, muted: value.muted };
    if (Object.keys(value).sort().join(',') !== 'muted,random,voice'
      || (value.voice !== 'male' && value.voice !== 'female') || typeof value.random !== 'boolean') throw new Error();
    return { muted: value.muted, voice: value.voice, random: value.random };
  } catch { throw new Error('cfo_greeting_preferences_invalid'); }
}

function pcmWave(pcm: Buffer): Buffer {
  if (!pcm.length || pcm.length % 2 || pcm.length > MAX_WAVE_BYTES - 44) throw new Error('cfo_greeting_unavailable');
  const wave = Buffer.alloc(44 + pcm.length);
  wave.write('RIFF', 0); wave.writeUInt32LE(36 + pcm.length, 4); wave.write('WAVEfmt ', 8);
  wave.writeUInt32LE(16, 16); wave.writeUInt16LE(1, 20); wave.writeUInt16LE(1, 22);
  wave.writeUInt32LE(24_000, 24); wave.writeUInt32LE(48_000, 28); wave.writeUInt16LE(2, 32);
  wave.writeUInt16LE(16, 34); wave.write('data', 36); wave.writeUInt32LE(pcm.length, 40); pcm.copy(wave, 44);
  return wave;
}

function validWaveBytes(contents: Buffer): boolean {
  return contents.length >= 46 && contents.length <= MAX_WAVE_BYTES
    && contents.toString('ascii', 0, 4) === 'RIFF' && contents.toString('ascii', 8, 16) === 'WAVEfmt '
    && contents.readUInt16LE(20) === 1 && contents.readUInt16LE(22) === 1
    && contents.readUInt32LE(24) === 24_000 && contents.readUInt16LE(34) === 16
    && contents.toString('ascii', 36, 40) === 'data'
    && contents.readUInt32LE(40) === contents.length - 44;
}

async function readWave(file: string, privateCache: boolean): Promise<Buffer | null> {
  let handle;
  try { handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size < 46 || info.size > MAX_WAVE_BYTES
      || (privateCache
        ? ((process.getuid && info.uid !== process.getuid()) || (info.mode & 0o7777) !== 0o600)
        : (info.mode & 0o022) !== 0)) return null;
    const contents = Buffer.alloc(info.size); const { bytesRead } = await handle.read(contents, 0, contents.length, 0);
    return bytesRead === info.size && validWaveBytes(contents) ? contents : null;
  } finally { await handle.close(); }
}

async function writeWave(directory: string, file: string, wave: Buffer): Promise<void> {
  await ensurePrivateDirectory(directory);
  const temporary = path.join(directory, `.pending-greeting-${randomBytes(16).toString('hex')}`);
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    try { await handle.writeFile(wave); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, file);
  } finally { await unlink(temporary).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }); }
}

function playWave(file: string, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new Error('cfo_greeting_cancelled')); return; }
    const child = spawn('/usr/bin/afplay', [file], { shell: false, stdio: 'ignore' });
    let settled = false;
    const finish = (error?: Error) => { if (settled) return; settled = true; signal.removeEventListener('abort', cancelled);
      if (error) reject(error); else resolve(); };
    const cancelled = () => { child.kill('SIGTERM'); finish(new Error('cfo_greeting_cancelled')); };
    signal.addEventListener('abort', cancelled, { once: true });
    child.once('error', () => finish(new Error('cfo_greeting_unavailable')));
    child.once('exit', code => finish(code === 0 ? undefined : signal.aborted
      ? new Error('cfo_greeting_cancelled') : new Error('cfo_greeting_unavailable')));
  });
}

export function createMacGreetingOutput(options: {
  directory: string;
  bundledAssetPath?: string;
  store: VoiceSettingsStore;
  synthesize?: typeof synthesizeQwenGreeting;
  play?: (file: string, signal: AbortSignal) => Promise<void>;
  diagnostic?: (value: Record<string, unknown>) => void;
}) {
  const { directory, store } = options;
  const assetPath = path.join(directory, CFO_GREETING_ASSET_FILENAME);
  let active: AbortController | undefined;
  return {
    assetPath,
    readPreferences: async () => parsePreferences(await readPrivateFile(directory, 'greeting.json')),
    writePreferences: async (value: GreetingPreferences) => { await serialized(directory, async () => {
      await writePrivateFile(directory, 'greeting.json', JSON.stringify(value));
    }); },
    readMuted: async () => (await parsePreferences(await readPrivateFile(directory, 'greeting.json'))).muted,
    writeMuted: async (muted: boolean) => { await serialized(directory, async () => {
      const current = parsePreferences(await readPrivateFile(directory, 'greeting.json'));
      await writePrivateFile(directory, 'greeting.json', JSON.stringify({ ...current, muted }));
    }); },
    stop: async () => { active?.abort(); active = undefined; },
    speak: async (text: string, scope: VoiceScope, voice: GreetingVoice = 'female') => {
      active?.abort(); const operation = new AbortController(); active = operation;
      const cachePath = voice === 'female' && text === '老板，你来啦。今天咱们先忙点什么？'
        ? assetPath
        : path.join(directory, `startup-greeting-${voice}-${createHash('sha256').update(text).digest('hex').slice(0, 12)}.wav`);
      let phase = 'cache';
      try {
        if (!(await readWave(cachePath, true))) {
          phase = 'bundled_asset';
          const bundled = voice === 'female' && text === '老板，你来啦。今天咱们先忙点什么？' && options.bundledAssetPath
            ? await readWave(options.bundledAssetPath, false) : null;
          if (bundled) {
            operation.signal.throwIfAborted();
            await writeWave(directory, cachePath, bundled);
            options.diagnostic?.({ stage: 'seeded', audioBytes: bundled.length - 44 });
          } else {
            phase = 'settings';
            const settings = await store.load(scope); if (!settings) throw new Error('cfo_greeting_unavailable');
            const startedAt = Date.now();
            phase = 'synthesis';
            const pcm = await (options.synthesize ?? synthesizeQwenGreeting)(settings, text, operation.signal, {
              voice: voice === 'male' ? 'Ethan' : 'Tina',
              onDiagnostic: value => options.diagnostic?.({ stage: 'provider', ...value })
            });
            operation.signal.throwIfAborted();
            phase = 'storage';
            await writeWave(directory, cachePath, pcmWave(pcm));
            options.diagnostic?.({ stage: 'generated', durationMs: Date.now() - startedAt, audioBytes: pcm.length });
          }
        }
        operation.signal.throwIfAborted();
        phase = 'playback';
        await (options.play ?? playWave)(cachePath, operation.signal);
        options.diagnostic?.({ stage: 'played' });
      } catch (error) {
        if (!operation.signal.aborted) options.diagnostic?.({ stage: 'failed', phase, code: 'cfo_greeting_unavailable' });
        throw error;
      } finally { if (active === operation) active = undefined; }
    }
  };
}

export function registerCfoVoiceIpc(options: {
  localOrigin: string; voice: CfoVoiceService;
  authorize(workspaceId: string): Promise<VoiceScope>;
  authorizedSender(): { mainFrame: { url?: string }; isDestroyed(): boolean } | undefined;
  ipcMain: { handle(channel: string, handler: (event: any, value: unknown) => unknown): void; removeHandler(channel: string): void };
}) {
  let epoch = 0;
  options.ipcMain.handle(CFO_VOICE_CHANNEL, async (event, raw) => {
    const sender = options.authorizedSender();
    if (!sender || sender.isDestroyed() || event.sender !== sender || event.senderFrame !== sender.mainFrame)
      throw new Error('cfo_voice_sender_invalid');
    let origin: string;
    try { origin = new URL(event.senderFrame.url).origin; } catch { throw new Error('cfo_voice_sender_invalid'); }
    if (origin !== options.localOrigin) throw new Error('cfo_voice_sender_invalid');
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('cfo_voice_input_invalid');
    const value = raw as Record<string, unknown>;
    const keys = Object.keys(value).sort().join(',');
    if (value.action === 'mute' && keys === 'action,muted') {
      if (value.muted === true) epoch++;
      return options.voice.setMuted(value.muted);
    }
    if (value.action === 'greet' && keys === 'action,workspaceId' && typeof value.workspaceId === 'string') {
      const requestEpoch = epoch; const scope = await options.authorize(value.workspaceId);
      return requestEpoch === epoch ? options.voice.greet(scope) : options.voice.status();
    }
    if (value.action === 'preview'
      && (keys === 'action,workspaceId' || keys === 'action,preferences,workspaceId')
      && typeof value.workspaceId === 'string') {
      const requestEpoch = epoch; const scope = await options.authorize(value.workspaceId);
      return requestEpoch === epoch ? options.voice.preview(scope, value.preferences) : options.voice.status();
    }
    if (value.action === 'preferences' && keys === 'action,preferences') {
      return options.voice.setPreferences(value.preferences);
    }
    if (keys !== 'action') throw new Error('cfo_voice_input_invalid');
    if (value.action === 'status') return options.voice.status();
    if (value.action === 'stop') { epoch++; return options.voice.stop(); }
    throw new Error('cfo_voice_input_invalid');
  });
  return { dispose() { epoch++; options.ipcMain.removeHandler(CFO_VOICE_CHANNEL); void options.voice.stop().catch(() => undefined); } };
}
