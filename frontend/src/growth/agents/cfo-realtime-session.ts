// Retained prototype/test contract, NOT the active Qwen adapter.
// Active implementation is cfo-realtime-client.ts + Main cfo-realtime-service.ts.
// A provider adapter must supply VAD events, playback acknowledgements and
// upstream cancel+truncate. Never translate generated text into a played event.
export type RealtimeEvent =
  | { type: 'speech_started' }
  | { type: 'user_final'; text: string }
  | { type: 'response_started'; responseId: string }
  | { type: 'played'; responseId: string; playedMs: number; heardText: string }
  | { type: 'response_finished'; responseId: string }
  | { type: 'disconnected' };
export interface RealtimePort {
  cancelAndTruncate(responseId: string, playedMs: number): Promise<void>;
  close(): void;
}
export type RealtimeState = 'idle' | 'unavailable' | 'connecting' | 'listening' | 'speaking' | 'interrupting' | 'disconnected' | 'ended';
export class CfoRealtimeSession {
  state: RealtimeState = 'idle';
  private turns: { role: 'user' | 'assistant'; text: string }[] = [];
  private generation = 0;
  private abort?: AbortController;
  private release?: () => void;
  private port?: RealtimePort;
  private response?: { id: string; playedMs: number; text: string };
  private retired = new Set<string>();
  constructor(private readonly options: {
    audio: { openMicrophone(): Promise<() => void>; clearPlayback(): void };
    connect?: (onEvent: (event: RealtimeEvent) => void, signal: AbortSignal) => Promise<RealtimePort>;
  }) {}
  get history() { return this.turns.map(turn => ({ ...turn })); }
  async start() {
    if (['connecting', 'listening', 'speaking', 'interrupting'].includes(this.state)) return;
    if (!this.options.connect) { this.state = 'unavailable'; return; }
    const generation = ++this.generation;
    this.retired.clear();
    this.state = 'connecting'; this.abort = new AbortController();
    try {
      const release = await this.options.audio.openMicrophone();
      if (generation !== this.generation) { release(); return; }
      this.release = release;
      const port = await this.options.connect(event => {
        if (generation === this.generation) this.receive(event);
      }, this.abort.signal);
      if (generation !== this.generation) { port.close(); return; }
      this.port = port; this.state = 'listening';
    } catch { if (generation === this.generation) this.finish('disconnected'); }
  }
  end() { this.finish('ended'); }
  private append(role: 'user' | 'assistant', text: string) {
    if (text.trim()) this.turns.push({ role, text: text.trim().slice(0, 4000) });
    this.turns = this.turns.slice(-10);
  }
  private commitPlayed() {
    if (this.response) { this.append('assistant', this.response.text); this.retired.add(this.response.id); }
    this.response = undefined;
  }
  private finish(state: 'ended' | 'disconnected') {
    ++this.generation; this.abort?.abort();
    this.options.audio.clearPlayback(); this.commitPlayed();
    this.release?.(); this.release = undefined;
    this.port?.close(); this.port = undefined; this.state = state;
  }
  private receive(event: RealtimeEvent) {
    if (event.type === 'disconnected') { this.finish('disconnected'); return; }
    if (event.type === 'speech_started') {
      this.options.audio.clearPlayback();
      const interrupted = this.response; this.commitPlayed();
      if (interrupted && this.port) {
        this.state = 'interrupting'; const generation = this.generation;
        void this.port.cancelAndTruncate(interrupted.id, interrupted.playedMs).then(() => {
          if (generation === this.generation) this.state = 'listening';
        }, () => { if (generation === this.generation) this.finish('disconnected'); });
      }
      return;
    }
    if (event.type === 'user_final') { this.append('user', event.text); return; }
    if (event.type === 'response_started') {
      if (this.state !== 'listening' || this.retired.has(event.responseId)) return;
      this.response = { id: event.responseId, playedMs: 0, text: '' }; this.state = 'speaking'; return;
    }
    if (!this.response || this.response.id !== event.responseId) return;
    if (event.type === 'played' && Number.isFinite(event.playedMs) && event.playedMs > this.response.playedMs) {
      this.response.playedMs = event.playedMs; this.response.text = event.heardText;
    } else if (event.type === 'response_finished') { this.commitPlayed(); this.state = 'listening'; }
  }
}
