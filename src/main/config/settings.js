'use strict';
// Settings store (JSON in the app's userData folder). Passwords are encrypted at rest with
// the OS keychain (Windows DPAPI / macOS Keychain) via a pluggable `secure` object.

const fs = require('fs');
const path = require('path');

const emptyLine = (i) => ({
  enabled: i === 0,
  label: i === 0 ? 'Line 1' : 'Line 2',
  displayName: '', username: '', authUsername: '', domain: '',
  password: null, // { enc, data }
  provisioned: false
});

function defaults(desktopDir) {
  return {
    version: 1,
    theme: 'system',
    activeLine: 0,
    lines: [emptyLine(0), emptyLine(1)],
    audio: { speakerId: 'default', micId: 'default', speakerVolume: 0.85, micVolume: 1.0, ringVolume: 0.7 },
    calls: { autoMute: false, autoRecord: false, clearAfterCall: true, dtmfTones: true, endSound: true, endNotify: true },
    recording: { folder: path.join(desktopDir, 'Channel Blend Recordings'), keepMka: false },
    network: { sipPort: 0, rtpPortMin: 5000, rtpPortMax: 36385, registerExpires: 3600, keepAliveSec: 30, usePublicAddress: true }
  };
}

function merge(base, over) {
  if (Array.isArray(base)) return Array.isArray(over) ? base.map((b, i) => merge(b, over[i])) : base;
  if (base && typeof base === 'object') {
    const out = { ...base };
    if (over && typeof over === 'object') for (const k of Object.keys(over)) out[k] = k in base ? merge(base[k], over[k]) : over[k];
    return out;
  }
  return over === undefined ? base : over;
}

class SettingsStore {
  constructor({ dir, desktopDir, secure }) {
    this.file = path.join(dir, 'settings.json');
    this.secure = secure; // { encrypt(str)->{enc,data}, decrypt({enc,data})->str }
    this.data = merge(defaults(desktopDir), this._load());
    this.data.lines = this.data.lines.slice(0, 2);
  }

  _load() { try { return JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch (_) { return {}; } }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }

  get() { return this.data; }

  update(patch) {
    const lines = this.data.lines;
    this.data = merge(this.data, { ...patch, lines: undefined });
    this.data.lines = lines;
    this.save();
  }

  password(i) {
    const p = this.data.lines[i] && this.data.lines[i].password;
    if (!p) return '';
    try { return this.secure.decrypt(p); } catch (_) { return ''; }
  }

  /** Account with decrypted password, for the SIP stack only. */
  account(i) { return { ...this.data.lines[i], password: this.password(i) }; }

  setLine(i, fields) {
    const line = { ...this.data.lines[i] };
    for (const k of ['enabled', 'label', 'displayName', 'username', 'authUsername', 'domain', 'provisioned']) {
      if (fields[k] !== undefined) line[k] = typeof fields[k] === 'string' ? fields[k].trim() : fields[k];
    }
    if (typeof fields.password === 'string' && fields.password.length) line.password = this.secure.encrypt(fields.password);
    if (fields.clearPassword) line.password = null;
    this.data.lines[i] = line;
    this.save();
  }

  clearLine(i) { this.data.lines[i] = emptyLine(i); this.save(); }

  /** Settings safe to send to the UI: never includes passwords. */
  publicView() {
    const d = JSON.parse(JSON.stringify(this.data));
    d.lines = d.lines.map(l => ({ ...l, password: undefined, hasPassword: !!l.password }));
    return d;
  }
}

module.exports = { SettingsStore, defaults };
