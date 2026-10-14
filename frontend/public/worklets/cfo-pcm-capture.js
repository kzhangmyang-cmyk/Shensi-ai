// The capture graph is silent. Only explicit realtime Start loads this worklet.
class CfoPcmCapture extends AudioWorkletProcessor {
  constructor() {
    super(); this.phase = 0; this.sum = 0; this.count = 0;
    this.frames = new Int16Array(1600); this.offset = 0;
  }
  process(inputs) {
    const input = inputs[0]?.[0]; if (!input) return true;
    const ratio = sampleRate / 16000;
    for (const sample of input) {
      this.sum += sample; this.count++; this.phase++;
      if (this.phase >= ratio) {
        this.phase -= ratio;
        const value = Math.max(-1, Math.min(1, this.sum / this.count));
        this.frames[this.offset++] = Math.round(value * (value < 0 ? 32768 : 32767));
        this.sum = 0; this.count = 0;
        if (this.offset === this.frames.length) {
          this.port.postMessage(this.frames.buffer, [this.frames.buffer]);
          this.frames = new Int16Array(1600); this.offset = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor('shensi-cfo-pcm', CfoPcmCapture);
