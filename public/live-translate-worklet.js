// AudioWorklet：把麥克風/分頁音訊（任意取樣率 Float32）線性降頻到 16kHz、
// 轉 16-bit little-endian PCM，每滿 100ms（1600 取樣）postMessage 一塊。
// Gemini Live Translate 規格：raw 16-bit PCM, 16kHz, mono, 100ms chunk。
class PCMWorklet extends AudioWorkletProcessor {
  constructor() {
    super();
    this.inRate = sampleRate; // AudioWorkletGlobalScope 內建：實際 context 取樣率
    this.outRate = 16000;
    this.ratio = this.inRate / this.outRate;
    this.frame = 1600; // 100ms @ 16kHz
    this.acc = [];
    this.tail = new Float32Array(0);
    this.pos = 0;
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch && ch.length) {
      const buf = new Float32Array(this.tail.length + ch.length);
      buf.set(this.tail, 0);
      buf.set(ch, this.tail.length);

      let pos = this.pos;
      while (pos + 1 < buf.length) {
        const i = pos | 0;
        const frac = pos - i;
        this.acc.push(buf[i] * (1 - frac) + buf[i + 1] * frac);
        pos += this.ratio;
        if (this.acc.length >= this.frame) {
          const pcm = new Int16Array(this.frame);
          for (let k = 0; k < this.frame; k++) {
            const v = Math.max(-1, Math.min(1, this.acc[k]));
            pcm[k] = v < 0 ? v * 0x8000 : v * 0x7fff;
          }
          this.acc = this.acc.slice(this.frame);
          this.port.postMessage(pcm.buffer, [pcm.buffer]);
        }
      }
      const consumed = pos | 0;
      this.tail = buf.slice(consumed);
      this.pos = pos - consumed;
    }
    return true;
  }
}

registerProcessor('pcm-worklet', PCMWorklet);
