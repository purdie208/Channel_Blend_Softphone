'use strict';
// RTP media session: 20 ms G.711 frames, a small jitter buffer, RFC 4733 DTMF,
// symmetric-RTP latching, and a mixed feed for the call recorder.
// No microphone is required: when there is no mic (or the call is muted) we send silence,
// which also keeps NAT pinholes open and satisfies the PBX's RTP timeout.

const dgram = require('dgram');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const g711 = require('./g711');

const FRAME = 160; // 20 ms @ 8 kHz
const DTMF_CODES = { '0': 0, '1': 1, '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9, '*': 10, '#': 11, 'A': 12, 'B': 13, 'C': 14, 'D': 15 };

function now() { return Number(process.hrtime.bigint() / 1000000n); }

class MediaSession extends EventEmitter {
  constructor({ portMin = 5000, portMax = 36385, bindAddress = '0.0.0.0' } = {}) {
    super();
    this.portMin = portMin; this.portMax = portMax; this.bindAddress = bindAddress;
    this.socket = null; this.port = 0;
    this.remote = null; // { ip, port }
    this.pt = 0; this.tePt = null;
    this.ssrc = crypto.randomBytes(4).readUInt32BE(0);
    this.seq = crypto.randomBytes(2).readUInt16BE(0);
    this.ts = crypto.randomBytes(4).readUInt32BE(0);
    this.marker = true;
    this.muted = false;
    this.sending = true;
    this.micQueue = [];
    this.dtmfQueue = [];
    this.dtmf = null;
    this.rx = { expected: null, pending: new Map(), fifo: [], fifoLen: 0, playing: false, lastSsrc: null };
    this.latched = false;
    this.stats = { sent: 0, received: 0, lost: 0 };
    this.timer = null;
  }

  async bind() {
    const min = Math.max(1024, this.portMin | 0), max = Math.min(65534, this.portMax | 0);
    for (let attempt = 0; attempt < 40; attempt++) {
      let port = min + Math.floor(Math.random() * Math.max(1, max - min));
      port -= port % 2; // RTP on even ports
      if (port < min) port += 2;
      try {
        await this._tryBind(port);
        return this.port;
      } catch (_) { /* try another */ }
    }
    await this._tryBind(0);
    return this.port;
  }

  _tryBind(port) {
    return new Promise((resolve, reject) => {
      const s = dgram.createSocket({ type: 'udp4' });
      s.once('error', err => { try { s.close(); } catch (_) {} reject(err); });
      s.bind(port, this.bindAddress, () => {
        s.removeAllListeners('error');
        s.on('error', e => this.emit('warning', e));
        s.on('message', (msg, rinfo) => this._onPacket(msg, rinfo));
        this.socket = s; this.port = s.address().port;
        resolve();
      });
    });
  }

  setRemote({ ip, port, pt, tePt }) {
    if (ip && port) {
      if (!this.remote || this.remote.ip !== ip || this.remote.port !== port) this.latched = false;
      this.remote = { ip, port };
    }
    if (pt != null) this.pt = pt;
    this.tePt = tePt != null ? tePt : null;
  }

  start() {
    if (this.timer) return;
    this.next = now();
    this.timer = setInterval(() => {
      const t = now();
      let n = 0;
      while (t >= this.next && n < 6) { this._tick(); this.next += 20; n++; }
      if (t - this.next > 200) this.next = t; // we fell far behind (sleep/suspend); resync
    }, 4);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.socket) { try { this.socket.close(); } catch (_) {} }
    this.socket = null;
    this.removeAllListeners('frame'); this.removeAllListeners('mix');
  }

  pushMic(int16) {
    if (this.muted) return;
    this.micQueue.push(int16);
    if (this.micQueue.length > 6) this.micQueue.splice(0, this.micQueue.length - 3);
  }

  setMuted(m) { this.muted = !!m; if (this.muted) this.micQueue.length = 0; }

  // Returns true if sent in-band (RTP), false if caller should use SIP INFO.
  sendDtmf(digit) {
    if (this.tePt == null) return false;
    const code = DTMF_CODES[String(digit).toUpperCase()];
    if (code === undefined) return true;
    this.dtmfQueue.push(code);
    return true;
  }

  _rtpHeader(pt, marker, ts) {
    const h = Buffer.allocUnsafe(12);
    h[0] = 0x80; h[1] = (marker ? 0x80 : 0) | (pt & 0x7f);
    h.writeUInt16BE(this.seq, 2); this.seq = (this.seq + 1) & 0xffff;
    h.writeUInt32BE(ts >>> 0, 4); h.writeUInt32BE(this.ssrc, 8);
    return h;
  }

  _send(buf) {
    if (!this.socket || !this.remote) return;
    this.socket.send(buf, this.remote.port, this.remote.ip, () => {});
    this.stats.sent++;
  }

  _tick() {
    // ---- outgoing ----
    let local = null;
    if (!this.muted && this.micQueue.length) local = this.micQueue.shift();

    if (!this.dtmf && this.dtmfQueue.length) {
      this.dtmf = { code: this.dtmfQueue.shift(), ts: this.ts, dur: 0, total: 160 * 8, ends: 0, first: true, gap: 0 };
    }
    if (this.dtmf) {
      const d = this.dtmf;
      if (d.gap > 0) { // inter-digit gap: send normal audio again
        d.gap--; if (d.gap === 0) this.dtmf = null;
        this._sendAudio(local);
      } else {
        d.dur = Math.min(d.dur + FRAME, d.total);
        const end = d.dur >= d.total;
        const payload = Buffer.from([d.code, (end ? 0x80 : 0) | 10, (d.dur >> 8) & 0xff, d.dur & 0xff]);
        const reps = end ? 3 : 1;
        for (let i = 0; i < reps; i++) this._send(Buffer.concat([this._rtpHeader(this.tePt, d.first, d.ts), payload]));
        d.first = false;
        if (end) d.gap = 3;
      }
    } else {
      this._sendAudio(local);
    }
    this.ts = (this.ts + FRAME) >>> 0;

    // ---- incoming ----
    const remote = this._playout();
    if (remote) this.emit('frame', remote);
    this.emit('mix', remote, local);
  }

  _sendAudio(pcm) {
    if (!this.sending) return;
    const payload = pcm ? g711.encode(this.pt, pcm) : Buffer.alloc(FRAME, this.pt === 8 ? 0xd5 : 0xff);
    this._send(Buffer.concat([this._rtpHeader(this.pt, this.marker, this.ts), payload]));
    this.marker = false;
  }

  _onPacket(msg, rinfo) {
    if (msg.length < 12 || (msg[0] >> 6) !== 2) return;
    const pt = msg[1] & 0x7f;
    if (pt >= 72 && pt <= 76) return; // RTCP on same port
    // Symmetric RTP: latch to where the PBX actually sends from (handles NAT'd PBX / remote users).
    if (!this.latched && this.remote && (rinfo.address !== this.remote.ip || rinfo.port !== this.remote.port)) {
      this.remote = { ip: rinfo.address, port: rinfo.port };
    }
    this.latched = true;
    this.stats.received++;
    const cc = msg[0] & 0x0f;
    let off = 12 + cc * 4;
    if (msg[0] & 0x10) { if (msg.length < off + 4) return; off += 4 + msg.readUInt16BE(off + 2) * 4; }
    let end = msg.length;
    if (msg[0] & 0x20) end -= msg[end - 1];
    if (off >= end) return;
    if (pt !== 0 && pt !== 8) return; // DTMF events, comfort noise, etc. are not played
    const seq = msg.readUInt16BE(2), ssrc = msg.readUInt32BE(8);
    const rx = this.rx;
    if (rx.lastSsrc !== ssrc) { rx.lastSsrc = ssrc; rx.expected = seq; rx.pending.clear(); }
    if (rx.expected === null) rx.expected = seq;
    const diff = ((seq - rx.expected) << 16) >> 16; // signed 16-bit distance
    if (diff < 0) return; // late or duplicate
    rx.pending.set(seq, g711.decode(pt, msg.subarray(off, end)));
    this._drain();
  }

  _drain() {
    const rx = this.rx;
    while (rx.pending.has(rx.expected)) {
      const pcm = rx.pending.get(rx.expected);
      rx.pending.delete(rx.expected);
      rx.fifo.push(pcm); rx.fifoLen += pcm.length;
      rx.expected = (rx.expected + 1) & 0xffff;
    }
    if (rx.pending.size > 3) { // give up on the missing packet
      this.stats.lost++;
      let best = null;
      for (const s of rx.pending.keys()) {
        const d = ((s - rx.expected) << 16) >> 16;
        if (best === null || d < best.d) best = { s, d };
      }
      rx.expected = best.s;
      this._drain();
    }
    // Clock drift / burst protection: never keep more than 300 ms queued.
    while (rx.fifoLen > 2400) { const c = rx.fifo.shift(); rx.fifoLen -= c.length; }
  }

  _playout() {
    const rx = this.rx;
    if (!rx.playing) {
      if (rx.fifoLen < FRAME * 3) return null; // prefill 60 ms
      rx.playing = true;
    }
    if (rx.fifoLen < FRAME) { rx.playing = false; return null; }
    const out = new Int16Array(FRAME);
    let filled = 0;
    while (filled < FRAME) {
      const c = rx.fifo[0];
      const take = Math.min(c.length, FRAME - filled);
      out.set(c.subarray(0, take), filled);
      filled += take;
      if (take === c.length) rx.fifo.shift(); else rx.fifo[0] = c.subarray(take);
      rx.fifoLen -= take;
    }
    return out;
  }
}

module.exports = { MediaSession, FRAME };
