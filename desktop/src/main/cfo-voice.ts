import type { CfoVoiceStatus, GreetingPreferences, GreetingVoice } from '../shared/cfo-voice.ts';
import type { VoiceScope } from './cfo-realtime-settings.ts';

export const CFO_STARTUP_GREETING = '老板，你来啦。今天咱们先忙点什么？';
export const CFO_STARTUP_GREETINGS = [
  CFO_STARTUP_GREETING,
  '老板，欢迎回来。今天想先推进哪件事？',
  '老板，你来啦。需要我先帮你看看今天的重点吗？'
] as const;

const defaults: GreetingPreferences = { muted: false, voice: 'female', random: false };
function preferences(raw: unknown): GreetingPreferences {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)
    || Object.keys(raw).sort().join(',') !== 'muted,random,voice') throw new Error('cfo_voice_input_invalid');
  const value = raw as Record<string, unknown>;
  if (typeof value.muted !== 'boolean' || typeof value.random !== 'boolean'
    || (value.voice !== 'male' && value.voice !== 'female')) throw new Error('cfo_voice_input_invalid');
  return { muted: value.muted, voice: value.voice, random: value.random };
}

// Main owns the launch guard. Greeting never opens a microphone or business/tool turn.
export class CfoVoiceService {
  private greeted = false;
  private current: GreetingPreferences = { ...defaults };
  private speaking = false;
  private generation = 0;
  private readonly ready: Promise<void>;
  constructor(private readonly output: { speak(text: string, scope: VoiceScope, voice?: GreetingVoice): Promise<void>; stop(): Promise<void>;
    readMuted?(): Promise<boolean>; writeMuted?(value: boolean): Promise<void>;
    readPreferences?(): Promise<GreetingPreferences>; writePreferences?(value: GreetingPreferences): Promise<void> }) {
    this.ready = (output.readPreferences ? output.readPreferences() : output.readMuted!().then(muted => ({ ...defaults, muted, random: false })))
      .then(value => { this.current = preferences(value); });
    void this.ready.catch(() => undefined);
  }
  async status(): Promise<CfoVoiceStatus> {
    await this.ready;
    return { ...this.current, speaking: this.speaking };
  }
  async greet(scope: VoiceScope) {
    if (this.greeted) return this.status();
    this.greeted = true;
    const generation = this.generation;
    await this.ready;
    if (!this.current.muted && generation === this.generation) {
      this.speaking = true;
      const text = this.current.random
        ? CFO_STARTUP_GREETINGS[Math.floor(Math.random() * CFO_STARTUP_GREETINGS.length)]!
        : CFO_STARTUP_GREETING;
      try { await this.output.speak(text, scope, this.current.voice); }
      finally { if (generation === this.generation) this.speaking = false; }
    }
    return this.status();
  }
  async stop() {
    this.generation++; this.speaking = false;
    await this.output.stop();
    return this.status();
  }
  async setMuted(value: unknown) {
    if (typeof value !== 'boolean') throw new Error('cfo_voice_input_invalid');
    await this.ready;
    const next = { ...this.current, muted: value };
    if (this.output.writePreferences) await this.output.writePreferences(next);
    else await this.output.writeMuted!(value);
    this.current = next;
    if (value) await this.stop();
    return this.status();
  }
  async setPreferences(raw: unknown) {
    await this.ready;
    const next = preferences(raw);
    if (this.output.writePreferences) await this.output.writePreferences(next);
    else await this.output.writeMuted!(next.muted);
    this.current = next;
    if (next.muted) await this.stop();
    return this.status();
  }
  async preview(scope: VoiceScope, raw?: unknown) {
    await this.ready;
    const draft = raw === undefined ? this.current : preferences(raw);
    const generation = ++this.generation;
    await this.output.stop();
    this.speaking = true;
    const text = draft.random
      ? CFO_STARTUP_GREETINGS[Math.floor(Math.random() * CFO_STARTUP_GREETINGS.length)]!
      : CFO_STARTUP_GREETING;
    try { await this.output.speak(text, scope, draft.voice); }
    finally { if (generation === this.generation) this.speaking = false; }
    return this.status();
  }
}
