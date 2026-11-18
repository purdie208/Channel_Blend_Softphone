'use strict';
// PhoneEngine: ties lines (SIP UAs), the active call, recording and recents together.
// Independent of Electron so it can be tested headless.

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { SipUA } = require('./sip/ua');

class PhoneEngine extends EventEmitter {
  constructor({ store, recorder, dataDir, userAgent = 'Channel Blend Softphone', log = () => {} }) {
    super();
    this.store = store;
    this.recorder = recorder;
    this.dataDir = dataDir;
    this.userAgent = userAgent;
    this.log = log;
    this.uas = [null, null];
    this.mwi = [null, null];
    this.active = null; // { call, line, muted, micMissing, rec }
    this.recentsFile = path.join(dataDir, 'recents.json');
    try { this.recents = JSON.parse(fs.readFileSync(this.recentsFile, 'utf8')); } catch (_) { this.recents = []; }
    this._emitTimer = null;
  }

  // ------------------------------------------------------------- lifecycle
  start() {
    const s = this.store.get();
    let recovered = [];
    try { recovered = this.recorder.recover([s.recording.folder], { keepMka: s.recording.keepMka }); } catch (e) { this.log('recover failed ' + e.message); }
    if (recovered.length) {
      this.emit('toast', { type: 'info', title: 'Recording recovered', text: `${recovered.length} recording${recovered.length > 1 ? 's were' : ' was'} saved after an unexpected shutdown.`, path: recovered[0].wavPath });
    }
    for (let i = 0; i < 2; i++) this.restartLine(i);
  }

  async shutdown() {
    if (this.active) { try { this.active.call.hangup(); } catch (_) {} this._finishRecording(); }
    await Promise.all(this.uas.map(ua => ua ? ua.stop().catch(() => {}) : null));
  }

  configured(i) {
    const l = this.store.get().lines[i];
    return !!(l && l.username && l.domain);
  }

  async restartLine(i) {
    const old = this.uas[i];
    this.uas[i] = null;
    if (old) { old.removeAllListeners(); await old.stop().catch(() => {}); }
    const line = this.store.get().lines[i];
    if (!line.enabled || !this.configured(i)) { this._emitState(); return; }
    const n = this.store.get().network;
    const ua = new SipUA(this.store.account(i), {
      sipPort: n.sipPort ? n.sipPort + i * 2 : 0, registerExpires: n.registerExpires, keepAliveSec: n.keepAliveSec,
      usePublicAddress: n.usePublicAddress, rtpPortMin: n.rtpPortMin, rtpPortMax: n.rtpPortMax, userAgent: this.userAgent
    });
    ua.busy = !!this.active;
    ua.on('status', () => this._emitState());
    ua.on('log', m => this.log(`[line${i + 1}] ${m}`));
    ua.on('trace', t => this.log(`[line${i + 1}] ${t.dir === 'in' ? '<<< from ' + t.from : '>>> to ' + t.to}\n${t.text}`));
    ua.on('mwi', m => { this.mwi[i] = m; this._emitState(); });
    ua.on('incoming', call => this._onIncoming(i, call));
    this.uas[i] = ua;
    this._emitState();
    ua.start().catch(e => this.log('ua start failed ' + e.message));
  }

  // ------------------------------------------------------------- state
  snapshot() {
    const s = this.store.publicView();
    const lines = s.lines.map((l, i) => {
      const ua = this.uas[i];
      let status = 'disabled', statusText = 'Turned off';
      if (l.enabled && !this.configured(i)) { status = 'unconfigured'; statusText = 'Not set up'; }
      else if (ua) { status = ua.status; statusText = ua.statusText; }
      return { index: i, label: l.label, enabled: l.enabled, configured: this.configured(i), status, statusText,
        username: l.username, displayName: l.displayName, domain: l.domain, authUsername: l.authUsername,
        provisioned: l.provisioned, hasPassword: l.hasPassword, mwi: this.mwi[i] };
    });
    let call = null;
    if (this.active) {
      const a = this.active;
      call = { ...a.call.info(), line: a.line, muted: a.muted, micMissing: a.micMissing,
        wantMic: a.call.state === 'connected' && !a.muted,
        recording: this.recorder.isRecording ? { active: true, startedAt: a.recStartedAt, file: path.basename(this.recorder.file).replace(/\.mka$/i, '.wav'), person: a.recPerson || '' } : { active: false } };
    }
    return { lines, activeLine: s.activeLine, call, settings: s, recents: this.recents.slice(0, 100) };
  }

  _emitState() {
    if (this._emitTimer) return;
    this._emitTimer = setImmediate(() => { this._emitTimer = null; this.emit('state', this.snapshot()); });
  }

  // ------------------------------------------------------------- calls
  async dial(number, lineIdx) {
    number = String(number || '').trim();
    if (!number) return { ok: false, error: 'Enter a number first' };
    if (this.active) return { ok: false, error: 'You are already on a call' };
    const i = lineIdx != null ? lineIdx : this.store.get().activeLine;
    const ua = this.uas[i];
    if (!ua || !ua.server || !ua.socket) return { ok: false, error: `${this.store.get().lines[i].label} is not connected` };
    try {
      this.active = { call: null, line: i, muted: false, micMissing: false };
      const call = await ua.call(number);
      this._attach(i, call);
      return { ok: true };
    } catch (e) {
      this.active = null;
      return { ok: false, error: e.message };
    }
  }

  _onIncoming(i, call) {
    if (this.active) { call.reject(486, 'Busy Here'); return; }
    this.active = { call: null, line: i, muted: false, micMissing: false };
    this._attach(i, call);
    this.emit('audio-cmd', { cmd: 'ring-start' });
    this.emit('incoming', { number: call.remoteNumber, name: call.remoteName, line: i });
  }

  _attach(i, call) {
    this.active.call = call;
    for (const ua of this.uas) if (ua) ua.busy = true;
    let hooked = false;
    const hookMedia = () => {
      if (hooked || !call.media) return;
      hooked = true;
      call.media.on('frame', f => this.emit('audio-frame', f));
      call.media.on('mix', (r, l) => { if (this.recorder.isRecording) this.recorder.write(r, l); });
    };
    call.on('state', (st, extra) => {
      const a = this.active;
      if (!a || a.call !== call) return;
      if (st === 'ringing') this.emit('audio-cmd', { cmd: 'ringback-start' });
      if (st === 'early') { this.emit('audio-cmd', { cmd: 'ringback-stop' }); hookMedia(); }
      if (st === 'connected' && !a.connectedOnce) {
        a.connectedOnce = true;
        hookMedia();
        this.emit('audio-cmd', { cmd: 'ringback-stop' });
        this.emit('audio-cmd', { cmd: 'ring-stop' });
        const c = this.store.get().calls;
        if (c.autoMute) this.setMute(true);
        if (c.autoRecord) this.startRecording();
      }
      if (st === 'ended') this._onEnded(call, extra.reason);
      this._emitState();
    });
    this._emitState();
  }

  _onEnded(call, reason) {
    const a = this.active;
    if (!a || a.call !== call) return;
    const saved = this._finishRecording();
    const duration = call.connectedAt ? Math.round((Date.now() - call.connectedAt) / 1000) : 0;
    const missed = call.direction === 'in' && !call.connectedAt;
    const monitored = (this.store.get().monitor.name || '').trim();
    this.recents.unshift({ number: call.remoteNumber, name: call.remoteName, direction: call.direction, line: a.line, monitored: call.connectedAt ? monitored : '',
      at: call.startedAt, connectedAt: call.connectedAt || null, duration, missed, result: call.connectedAt ? 'answered' : reason });
    this.recents = this.recents.slice(0, 200);
    try { fs.writeFileSync(this.recentsFile, JSON.stringify(this.recents)); } catch (_) {}
    this.active = null;
    for (const ua of this.uas) if (ua) ua.busy = false;
    this.emit('audio-cmd', { cmd: 'call-ended' });
    this.emit('call-ended', {
      reason, duration, missed, connected: !!call.connectedAt, direction: call.direction,
      number: call.remoteNumber, name: call.remoteName, line: a.line,
      recording: saved ? { wavPath: saved.wavPath, file: path.basename(saved.wavPath) } : null
    });
    this._emitState();
  }

  answer() { if (this.active && this.active.call.state === 'incoming') { this.emit('audio-cmd', { cmd: 'ring-stop' }); this.active.call.answer(); } }
  reject() { if (this.active && this.active.call.state === 'incoming') { this.emit('audio-cmd', { cmd: 'ring-stop' }); this.active.call.reject(486, 'Busy Here'); } }
  hangup() { if (this.active && this.active.call) this.active.call.hangup(); }
  dtmf(d) { if (this.active && this.active.call) this.active.call.sendDtmf(d); }
  setHold(h) { if (this.active && this.active.call) this.active.call.setHold(!!h); }

  setMute(m) {
    if (!this.active) return;
    this.active.muted = !!m;
    if (!m) this.active.micMissing = false; // let the UI try the mic again
    if (this.active.call.media) this.active.call.media.setMuted(!!m);
    this._emitState();
  }

  micUnavailable(reason) {
    if (!this.active) return;
    this.active.micMissing = true;
    this.setMute(true);
    this.active.micMissing = true;
    this.emit('toast', { type: 'info', title: 'Listening only', text: reason || 'No microphone found. You can still hear the call.' });
    this._emitState();
  }

  pushMic(int16) { const a = this.active; if (a && a.call && a.call.media && !a.muted) a.call.media.pushMic(int16); }

  // ------------------------------------------------------------- recording
  startRecording() {
    const a = this.active;
    if (!a || a.call.state !== 'connected' || this.recorder.isRecording) return;
    const s = this.store.get();
    try {
      const person = (s.monitor && s.monitor.name || '').trim();
      this.recorder.start({ folder: s.recording.folder, extension: s.lines[a.line].username, number: a.call.remoteNumber, person });
      a.recStartedAt = Date.now();
      a.recPerson = person;
      if (person) this.rememberPerson(person);
    } catch (e) {
      this.emit('toast', { type: 'error', title: 'Could not start recording', text: e.message });
    }
    this._emitState();
  }

  _finishRecording() {
    if (!this.recorder.isRecording) return null;
    return this.recorder.stop({ keepMka: this.store.get().recording.keepMka });
  }

  toggleRecording() {
    if (this.recorder.isRecording) {
      const saved = this._finishRecording();
      if (saved) this.emit('toast', { type: 'success', title: 'Recording saved', text: path.basename(saved.wavPath), path: saved.wavPath });
      this._emitState();
    } else this.startRecording();
  }

  /** Keep the last 15 monitored names (case-insensitive, newest first) for the quick-pick list. */
  rememberPerson(name) {
    const m = this.store.get().monitor;
    const recent = [name, ...(m.recent || []).filter(n => n.toLowerCase() !== name.toLowerCase())].slice(0, 15);
    this.store.update({ monitor: { recent } });
  }

  clearRecents() { this.recents = []; try { fs.writeFileSync(this.recentsFile, '[]'); } catch (_) {} this._emitState(); }
}

module.exports = { PhoneEngine };
