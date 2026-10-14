interface Segment { node: AudioBufferSourceNode; start: number; duration: number; }
interface Playing { id: string; segments: Segment[]; done: boolean; text: string; acknowledged: boolean; }
export class CfoPcmPlayback {
  private output?: Playing; private end = 0;
  constructor(private readonly context: AudioContext,
    private readonly acknowledge: (responseId: string, playedMs: number, complete: boolean, text: string) => void) {}
  append(id: string, pcm: string) {
    if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(pcm) || pcm.length > 65536) throw new Error('voice_protocol_failed');
    const binary = atob(pcm); if (!binary.length || binary.length % 2) throw new Error('voice_protocol_failed');
    if (this.output && this.output.id !== id) this.clear();
    this.output ??= { id, segments: [], text: '', done: false, acknowledged: false };
    const samples = new Float32Array(binary.length / 2);
    for (let i = 0; i < samples.length; i++) {
      const unsigned = binary.charCodeAt(i * 2) | (binary.charCodeAt(i * 2 + 1) << 8);
      samples[i] = (unsigned >= 32768 ? unsigned - 65536 : unsigned) / 32768;
    }
    const buffer = this.context.createBuffer(1, samples.length, 24000); buffer.copyToChannel(samples, 0);
    const node = this.context.createBufferSource(); node.buffer = buffer; node.connect(this.context.destination);
    const start = Math.max(this.context.currentTime + .03, this.end);
    // Model audio arrives much faster than realtime; long answers legitimately queue >30s.
    if (start - this.context.currentTime > 200) { node.disconnect(); throw new Error('voice_backpressure'); }
    this.end = start + buffer.duration; node.start(start);
    this.output.segments.push({ node, start, duration: buffer.duration });
  }
  done(id: string, text: string) { if (this.output?.id === id) { this.output.done = true; this.output.text = text; } }
  tick() {
    const output = this.output; if (!output || output.acknowledged) return;
    // Device output clock, not generation completion or AudioContext render-ahead.
    const clock = this.context.getOutputTimestamp?.().contextTime
      ?? Math.max(0, this.context.currentTime - (this.context.outputLatency || this.context.baseLatency || .1));
    const seconds = output.segments.reduce((sum, part) => sum + Math.max(0, Math.min(part.duration, clock - part.start)), 0);
    const total = output.segments.reduce((sum, part) => sum + part.duration, 0);
    const complete = output.done && !!output.text.trim() && total > 0 && seconds >= total - .00001;
    output.acknowledged = complete;
    this.acknowledge(output.id, seconds * 1000, complete, complete ? output.text : '');
  }
  clear() {
    this.tick();
    for (const part of this.output?.segments ?? []) { try { part.node.stop(); } catch { /* already ended */ } part.node.disconnect(); }
    this.output = undefined; this.end = 0;
  }
}

export async function openCfoMicrophone(context: AudioContext, onPcm: (pcm: string) => void, signal: AbortSignal,
  devices: Pick<MediaDevices, 'getUserMedia'> = navigator.mediaDevices,
  onFault?: (code: string) => void) {
  let stream: MediaStream | undefined; let source: MediaStreamAudioSourceNode | undefined;
  let worklet: AudioWorkletNode | undefined; let silent: GainNode | undefined; let ended = false;
  const tracks: MediaStreamTrack[] = [];
  const onTrackEnded = () => {
    if (ended) return;
    onFault?.('voice_audio_stalled');
  };
  const release = () => {
    ended = true;
    for (const track of tracks) {
      try { track.removeEventListener('ended', onTrackEnded); } catch { /* ignore */ }
      try { track.stop(); } catch { /* ignore */ }
    }
    tracks.length = 0;
    stream?.getTracks().forEach(track => { try { track.stop(); } catch { /* ignore */ } });
    source?.disconnect(); if (worklet) { worklet.port.onmessage = null; worklet.port.close(); worklet.disconnect(); }
    silent?.disconnect(); signal.removeEventListener('abort', release);
  };
  signal.addEventListener('abort', release, { once: true });
  try {
    if (signal.aborted || !devices?.getUserMedia) throw new Error('voice_audio_unavailable');
    stream = await devices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
    if (ended || signal.aborted) { release(); throw new Error('voice_audio_unavailable'); }
    for (const track of stream.getAudioTracks()) {
      tracks.push(track);
      track.addEventListener('ended', onTrackEnded);
    }
    await context.audioWorklet.addModule('/worklets/cfo-pcm-capture.js');
    if (ended || signal.aborted) { release(); throw new Error('voice_audio_unavailable'); }
    source = context.createMediaStreamSource(stream); worklet = new AudioWorkletNode(context, 'shensi-cfo-pcm');
    silent = context.createGain(); silent.gain.value = 0;
    worklet.port.onmessage = event => {
      if (ended || !(event.data instanceof ArrayBuffer) || event.data.byteLength !== 3200) return;
      const bytes = new Uint8Array(event.data); let binary = ''; for (const value of bytes) binary += String.fromCharCode(value);
      onPcm(btoa(binary));
    };
    source.connect(worklet); worklet.connect(silent); silent.connect(context.destination);
    return release;
  } catch (error) { release(); throw new Error(error instanceof DOMException && ['NotAllowedError', 'SecurityError'].includes(error.name)
    ? 'voice_microphone_denied' : 'voice_audio_unavailable'); }
}
