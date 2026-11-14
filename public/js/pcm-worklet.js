// AudioWorklet: turns the microphone signal into 16 kHz, 16-bit mono PCM chunks of ~100 ms.
const TARGET_RATE = 16000;
const CHUNK = 1600; // samples = 100 ms

class Pcm16k extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / TARGET_RATE; // sampleRate is a global inside the worklet scope
    this.pos = 0; // fractional read position into the incoming stream
    this.out = new Int16Array(CHUNK);
    this.n = 0;
    this.prev = 0;
  }

  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input) return true;
    // Linear interpolation resampling. `pos` is relative to the start of this block; -1 means the last
    // sample of the previous block (kept in `prev`).
    while (this.pos < input.length - 1) {
      const i = Math.floor(this.pos);
      const frac = this.pos - i;
      const a = i < 0 ? this.prev : input[i];
      const b = input[i + 1];
      const v = Math.max(-1, Math.min(1, a + (b - a) * frac));
      this.out[this.n++] = v < 0 ? v * 0x8000 : v * 0x7fff;
      if (this.n === CHUNK) {
        this.port.postMessage(this.out.buffer, [this.out.buffer]);
        this.out = new Int16Array(CHUNK);
        this.n = 0;
      }
      this.pos += this.ratio;
    }
    this.pos -= input.length;
    this.prev = input[input.length - 1];
    return true;
  }
}

registerProcessor("pcm16k", Pcm16k);
