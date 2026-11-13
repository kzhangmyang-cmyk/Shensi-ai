import type { CfoRealtimeBridge, VoiceEvent, VoiceTurn } from '../../../../desktop/src/shared/cfo-realtime';
import { CfoPcmPlayback, openCfoMicrophone } from './cfo-realtime-audio';
export interface CfoVoicePreview { responseId: string; text: string; state: 'streaming' | 'interrupted'; }

export class CfoRealtimeClient {
  private epoch = 0; private sessionId?: string; private abort?: AbortController;
  private context?: AudioContext; private player?: CfoPcmPlayback; private release?: () => void;
  private unsubscribe?: () => void; private timer?: ReturnType<typeof setInterval>; private starting = false;
  private replyEpoch = 0; private preview?: CfoVoicePreview; private retired = new Set<string>();
  private onContextState?: () => void;
  constructor(private readonly options: { bridge: CfoRealtimeBridge;
    createAudio?(): AudioContext; microphone?: typeof openCfoMicrophone;
    onState(state: 'idle' | 'connecting' | 'listening' | 'thinking' | 'speaking' | 'interrupting'): void;
    onPreview?(preview: CfoVoicePreview): void;
    onTurn(turn: VoiceTurn): void; onError(code: string): void; onBusiness(text: string, model: string): void }) {}
  async start(workspaceId: string, history: VoiceTurn[], documentId?: string | null) {
    if (this.starting || this.abort) return; this.starting = true;
    const epoch = ++this.epoch; const abort = new AbortController(); this.abort = abort;
    this.options.onState('connecting'); let early: VoiceEvent[] = [];
    const current = () => epoch === this.epoch && !abort.signal.aborted;
    try {
      // Resume in the user's click, before IPC/network awaits consume activation.
      const context = (this.options.createAudio ?? (() => new AudioContext()))(); this.context = context;
      await context.resume(); if (!current()) return;
      // Sleep / device switch can suspend WebAudio; try one resume, else recoverable stall.
      this.onContextState = () => {
        if (!current() || context.state !== 'suspended') return;
        void context.resume().then(() => {
          if (current() && context.state === 'suspended') this.fail('voice_audio_stalled');
        }, () => { if (current()) this.fail('voice_audio_stalled'); });
      };
      if (typeof context.addEventListener === 'function') {
        context.addEventListener('statechange', this.onContextState);
      }
      const player = new CfoPcmPlayback(context, (id, ms, complete, text) => {
        if (!current() || !this.sessionId) return;
        const replyEpoch = this.replyEpoch;
        void this.options.bridge.played(this.sessionId, id, ms, complete).then(() => {
          if (current() && replyEpoch === this.replyEpoch && !this.retired.has(id) && complete && text.trim()) {
            this.retired.add(id); this.preview = undefined;
            this.options.onTurn({ role: 'assistant', text }); this.options.onState('listening'); }
        }, () => {
          // Playback ACK is best-effort. A late/failed ACK must not tear down the mic session.
        });
      }); this.player = player;
      this.unsubscribe = this.options.bridge.onEvent(event => {
        if (!current()) return;
        if (!this.sessionId) { if (early.length < 512) early.push(event); return; }
        this.receive(event);
      });
      const { sessionId } = await this.options.bridge.start(workspaceId, history, documentId);
      if (!current()) { await this.options.bridge.stop(); return; } this.sessionId = sessionId;
      for (const event of early) this.receive(event); early = [];
      if (!current()) return;
      let inFlight = 0;
      const release = await (this.options.microphone ?? openCfoMicrophone)(context, pcm => {
        if (!current()) return;
        // ~10 PCM frames/sec. Under Electron IPC backlog, drop frames instead of killing
        // the whole customer session (former hard limit of 5 was too aggressive).
        if (inFlight >= 12) return;
        inFlight += 1;
        void this.options.bridge.audio(sessionId, pcm).catch(error => {
          if (!current()) return;
          const code = error instanceof Error ? error.message : '';
          if (code === 'voice_not_ready') return;
          this.fail(/^voice_[a-z_]+$/u.test(code) ? code : 'voice_network_failed');
        }).finally(() => { inFlight -= 1; });
      }, abort.signal, undefined, code => { if (current()) this.fail(code); });
      if (!current()) { release(); return; } this.release = release;
      this.timer = setInterval(() => { try { player.tick(); } catch (error) {
        this.fail(error instanceof Error && /^voice_[a-z_]+$/u.test(error.message) ? error.message : 'voice_audio_unavailable');
      } }, 100);
      this.options.onState('listening');
    } catch (error) { if (current()) this.fail(error instanceof Error && /^voice_[a-z_]+$/u.test(error.message) ? error.message : 'voice_audio_unavailable'); }
    finally { early = []; this.starting = false; }
  }
  private receive(event: VoiceEvent) {
    if (event.sessionId !== this.sessionId || !this.abort || this.abort.signal.aborted) return;
    try {
      if (event.type === 'ended') { this.stop(); return; }
      // Always tear down on provider error so a failed mic/session cannot linger and block later text turns.
      if (event.type === 'error') { this.fail(typeof event.code === 'string' ? event.code : 'voice_network_failed'); return; }
      if (event.type === 'reconnecting') { this.player?.clear(); this.options.onState('connecting'); return; }
      if (event.type === 'listening') { this.options.onState(this.release ? 'listening' : 'connecting'); return; }
      if (event.type === 'thinking') { this.options.onState('thinking'); return; }
      if (event.type === 'interrupted') { this.retireReply(); this.player?.clear(); this.options.onState('interrupting'); return; }
      if ('responseId' in event && this.retired.has(event.responseId)) return;
      if (event.type === 'transcript') {
        if (typeof event.text !== 'string' || event.text.length > 4000) { this.fail('voice_protocol_failed'); return; }
        if (this.preview?.responseId === event.responseId && this.preview.text === event.text) return;
        this.preview = { responseId: event.responseId, text: event.text, state: 'streaming' };
        this.options.onPreview?.(this.preview); return;
      }
      if (event.type === 'audio') { this.player?.append(event.responseId, event.pcm); this.options.onState('speaking'); return; }
      if (event.type === 'response_done') { this.player?.done(event.responseId, event.text); return; }
      if (event.type === 'user') this.options.onTurn({ role: 'user', text: event.text });
      if (event.type === 'business') this.options.onBusiness(event.text, event.model);
    } catch (error) {
      this.fail(error instanceof Error && /^voice_[a-z_]+$/u.test(error.message) ? error.message : 'voice_audio_unavailable');
    }
  }
  private fail(code: string) { this.stop(); this.options.onError(code); }
  private retireReply() {
    ++this.replyEpoch;
    if (this.preview) { this.retired.add(this.preview.responseId);
      this.options.onPreview?.({ ...this.preview, state: 'interrupted' }); this.preview = undefined; }
    if (this.retired.size > 100) this.retired.delete(this.retired.values().next().value!);
  }
  stop() {
    this.retireReply();
    const active = !!this.abort; ++this.epoch; this.abort?.abort(); this.abort = undefined;
    this.unsubscribe?.(); this.unsubscribe = undefined; clearInterval(this.timer); this.timer = undefined;
    this.player?.clear(); this.player = undefined; this.release?.(); this.release = undefined;
    if (this.context && this.onContextState && typeof this.context.removeEventListener === 'function') {
      try { this.context.removeEventListener('statechange', this.onContextState); } catch { /* ignore */ }
    }
    this.onContextState = undefined;
    void this.context?.close().catch(() => {}); this.context = undefined; this.sessionId = undefined;
    if (active) { void this.options.bridge.stop().catch(() => {}); this.options.onState('idle'); }
  }
}
