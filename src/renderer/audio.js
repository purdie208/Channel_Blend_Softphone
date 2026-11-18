'use strict';
// Renderer audio: plays call audio (8 kHz from the engine), captures the mic only when
// needed, generates DTMF/ring/ringback tones, and routes everything to the chosen device.


const DTMF_FREQ = { '1': [697, 1209], '2': [697, 1336], '3': [697, 1477], '4': [770, 1209], '5': [770, 1336], '6': [770, 1477],
  '7': [852, 1209], '8': [852, 1336], '9': [852, 1477], '*': [941, 1209], '0': [941, 1336], '#': [941, 1477] };

class CallAudio {
  constructor() {
    this.ctx = null; this.ready = null;
    this.speakerVolume = 0.85; this.micVolume = 1; this.ringVolume = 0.7;
    this.speakerId = 'default'; this.micId = 'default';
    this.mic = null; this.ringTimer = null; this.ringbackTimer = null;
    this.onMicFrame = null;
  }

  init() {
    if (this.ready) return this.ready;
    this.ready = (async () => {
      this.ctx = new AudioContext({ sampleRate: 8000, latencyHint: 'interactive' });
      await this.ctx.audioWorklet.addModule('worklets.js');
      this.callGain = this.ctx.createGain();
      this.toneGain = this.ctx.createGain();
      this.callGain.connect(this.ctx.destination);
      this.toneGain.connect(this.ctx.destination);
      this.playback = new AudioWorkletNode(this.ctx, 'cb-playback', { numberOfInputs: 0, outputChannelCount: [1] });
      this.playback.connect(this.callGain);
      this.setSpeakerVolume(this.speakerVolume);
      await this.setSpeaker(this.speakerId);
      if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
    })();
    return this.ready;
  }

  async setSpeaker(id) {
    this.speakerId = id || 'default';
    if (!this.ctx || typeof this.ctx.setSinkId !== 'function') return;
    try { await this.ctx.setSinkId(this.speakerId === 'default' ? '' : this.speakerId); }
    catch (e) { console.warn('setSinkId failed', e); this.speakerId = 'default'; try { await this.ctx.setSinkId(''); } catch (_) {} }
  }

  setSpeakerVolume(v) { this.speakerVolume = v; if (this.callGain) this.callGain.gain.value = v; }
  setMicVolume(v) { this.micVolume = v; if (this.mic) this.mic.gain.gain.value = v; }
  setRingVolume(v) { this.ringVolume = v; }

  play(int16) { if (this.playback) this.playback.port.postMessage(int16); }
  flush() { if (this.playback) this.playback.port.postMessage('flush'); }

  async openMic(id) {
    await this.init();
    if (this.mic && this.mic.id === (id || 'default')) return true;
    this.closeMic();
    const constraints = { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 };
    if (id && id !== 'default') constraints.deviceId = { exact: id };
    const stream = await navigator.mediaDevices.getUserMedia({ audio: constraints, video: false });
    const src = this.ctx.createMediaStreamSource(stream);
    const gain = this.ctx.createGain(); gain.gain.value = this.micVolume;
    const cap = new AudioWorkletNode(this.ctx, 'cb-capture', { numberOfOutputs: 1, outputChannelCount: [1] });
    const sink = this.ctx.createGain(); sink.gain.value = 0; // keeps the capture node running
    src.connect(gain); gain.connect(cap); cap.connect(sink); sink.connect(this.ctx.destination);
    cap.port.onmessage = (e) => this.onMicFrame && this.onMicFrame(e.data);
    this.mic = { id: id || 'default', stream, src, gain, cap, sink };
    return true;
  }

  closeMic() {
    if (!this.mic) return;
    const m = this.mic; this.mic = null;
    m.cap.port.onmessage = null;
    try { m.src.disconnect(); m.gain.disconnect(); m.cap.disconnect(); m.sink.disconnect(); } catch (_) {}
    m.stream.getTracks().forEach(t => t.stop());
  }

  _tone(freqs, start, dur, level) {
    const ctx = this.ctx;
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, start);
    env.gain.linearRampToValueAtTime(level, start + 0.01);
    env.gain.setValueAtTime(level, start + dur - 0.02);
    env.gain.linearRampToValueAtTime(0, start + dur);
    env.connect(this.toneGain);
    for (const f of freqs) {
      const o = ctx.createOscillator();
      o.frequency.value = f; o.connect(env);
      o.start(start); o.stop(start + dur + 0.02);
    }
    setTimeout(() => { try { env.disconnect(); } catch (_) {} }, (start - ctx.currentTime + dur + 0.2) * 1000);
  }

  async dtmf(digit) {
    await this.init();
    const f = DTMF_FREQ[digit]; if (!f) return;
    this._tone(f, this.ctx.currentTime + 0.005, 0.12, 0.18 * Math.max(0.2, this.speakerVolume));
  }

  async startRing() {
    await this.init(); this.stopRing();
    const burst = () => {
      const t = this.ctx.currentTime + 0.02, v = 0.22 * this.ringVolume;
      // Gentle two-note chime, twice
      [[0, 784], [0.18, 988], [0.5, 784], [0.68, 988]].forEach(([dt, f]) => this._tone([f, f * 2], t + dt, 0.16, v));
    };
    burst();
    this.ringTimer = setInterval(burst, 2600);
  }
  stopRing() { clearInterval(this.ringTimer); this.ringTimer = null; }

  async startRingback() {
    await this.init(); this.stopRingback();
    const cycle = () => this._tone([440, 480], this.ctx.currentTime + 0.02, 2, 0.12 * Math.max(0.3, this.speakerVolume));
    cycle();
    this.ringbackTimer = setInterval(cycle, 6000);
  }
  stopRingback() { clearInterval(this.ringbackTimer); this.ringbackTimer = null; }

  // Short descending two-note tone when a call ends.
  async endTone() {
    await this.init();
    const t = this.ctx.currentTime + 0.03, v = 0.2 * Math.max(0.25, this.speakerVolume);
    this._tone([660], t, 0.16, v);
    this._tone([440], t + 0.19, 0.24, v);
  }

  async testSpeaker() {
    await this.init();
    const t = this.ctx.currentTime + 0.02;
    [523, 659, 784].forEach((f, i) => this._tone([f], t + i * 0.18, 0.16, 0.25 * Math.max(0.2, this.speakerVolume)));
  }
}

window.callAudio = new CallAudio();
