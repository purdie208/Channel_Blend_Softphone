'use strict';
// AudioWorklet processors (loaded with audioWorklet.addModule).

class CbPlayback extends AudioWorkletProcessor {
  constructor() {
    super();
    this.q = []; this.len = 0; this.cur = null; this.off = 0; this.started = false;
    this.port.onmessage = (e) => {
      const d = e.data;
      if (d === 'flush') { this.q = []; this.len = 0; this.cur = null; this.started = false; return; }
      this.q.push(d); this.len += d.length;
      while (this.len > 3200 && this.q.length > 1) { const c = this.q.shift(); this.len -= c.length; } // >400 ms: drop
    };
  }
  process(_inputs, outputs) {
    const out = outputs[0][0];
    if (!this.started) { if (this.len < 480) { out.fill(0); return true; } this.started = true; }
    for (let i = 0; i < out.length; i++) {
      if (!this.cur || this.off >= this.cur.length) {
        this.cur = this.q.shift(); this.off = 0;
        if (!this.cur) { this.started = false; out.fill(0, i); return true; }
        this.len -= this.cur.length;
      }
      out[i] = this.cur[this.off++] / 32768;
    }
    return true;
  }
}
class CbCapture extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Int16Array(160); this.n = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      const s = ch[i] < -1 ? -1 : ch[i] > 1 ? 1 : ch[i];
      this.buf[this.n++] = s * 32767;
      if (this.n === 160) { this.port.postMessage(this.buf, [this.buf.buffer]); this.buf = new Int16Array(160); this.n = 0; }
    }
    return true;
  }
}
registerProcessor('cb-playback', CbPlayback);
registerProcessor('cb-capture', CbCapture);
