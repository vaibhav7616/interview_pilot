// Converts the 2-channel audio graph (ch0 = computer audio, ch1 = mic) into
// 16 kHz 16-bit interleaved PCM chunks of 100 ms, and reports levels.
/* global sampleRate, registerProcessor, AudioWorkletProcessor */
const TARGET_RATE = 16000;
const FRAMES_PER_CHUNK = 1600; // 100 ms

class PcmWorklet extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / TARGET_RATE;
    this.acc = 0;
    this.sum0 = 0;
    this.sum1 = 0;
    this.count = 0;
    this.out = new Int16Array(FRAMES_PER_CHUNK * 2);
    this.frames = 0;
    this.level0 = 0;
    this.level1 = 0;
    this.levelCount = 0;
  }

  push(a, b) {
    const s0 = Math.max(-1, Math.min(1, a));
    const s1 = Math.max(-1, Math.min(1, b));
    this.out[this.frames * 2] = s0 < 0 ? s0 * 0x8000 : s0 * 0x7fff;
    this.out[this.frames * 2 + 1] = s1 < 0 ? s1 * 0x8000 : s1 * 0x7fff;
    this.level0 += s0 * s0;
    this.level1 += s1 * s1;
    this.levelCount++;
    this.frames++;
    if (this.frames === FRAMES_PER_CHUNK) {
      const chunk = this.out.slice().buffer;
      this.port.postMessage(
        {
          pcm: chunk,
          level0: Math.sqrt(this.level0 / this.levelCount),
          level1: Math.sqrt(this.level1 / this.levelCount),
        },
        [chunk],
      );
      this.frames = 0;
      this.level0 = 0;
      this.level1 = 0;
      this.levelCount = 0;
    }
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0 || !input[0]) return true;
    const ch0 = input[0];
    const ch1 = input[1] || ch0.map(() => 0);
    for (let i = 0; i < ch0.length; i++) {
      // Box-filter downsampling (average of the samples in each output slot).
      this.sum0 += ch0[i];
      this.sum1 += ch1[i];
      this.count++;
      this.acc += 1;
      if (this.acc >= this.ratio) {
        this.acc -= this.ratio;
        this.push(this.sum0 / this.count, this.sum1 / this.count);
        this.sum0 = 0;
        this.sum1 = 0;
        this.count = 0;
      }
    }
    return true;
  }
}

registerProcessor('pcm-worklet', PcmWorklet);
