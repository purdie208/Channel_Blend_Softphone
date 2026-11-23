'use strict';
// Call recorder: writes a crash-safe .mka while recording, converts to .wav when done,
// and on startup recovers any .mka left behind by a crash.

const fs = require('fs');
const path = require('path');
const { MkaWriter, readMka } = require('./mka');

const PREFIX = 'CB_';

function wavHeader(dataBytes, sampleRate, channels, bitDepth) {
  const h = Buffer.alloc(44);
  const blockAlign = channels * bitDepth / 8;
  h.write('RIFF', 0); h.writeUInt32LE(36 + dataBytes, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(sampleRate, 24); h.writeUInt32LE(sampleRate * blockAlign, 28); h.writeUInt16LE(blockAlign, 32);
  h.writeUInt16LE(bitDepth, 34); h.write('data', 36); h.writeUInt32LE(dataBytes, 40);
  return h;
}

/** Convert an .mka to .wav safely (temp file + rename). Returns the wav path. */
function convertMkaToWav(mkaPath, wavPath) {
  wavPath = wavPath || mkaPath.replace(/\.mka$/i, '.wav');
  const { sampleRate, channels, bitDepth, pcm } = readMka(mkaPath);
  const tmp = wavPath + '.part';
  const fd = fs.openSync(tmp, 'w');
  fs.writeSync(fd, wavHeader(pcm.length, sampleRate, channels, bitDepth));
  if (pcm.length) fs.writeSync(fd, pcm);
  fs.fsyncSync(fd);
  fs.closeSync(fd);
  let target = wavPath;
  if (fs.existsSync(target)) {
    const b = target.replace(/\.wav$/i, '');
    let i = 2; while (fs.existsSync(`${b} (${i}).wav`)) i++;
    target = `${b} (${i}).wav`;
  }
  fs.renameSync(tmp, target);
  return { wavPath: target, seconds: pcm.length / (sampleRate * channels * bitDepth / 8) };
}

// "Joe Smith" -> safe for Windows/macOS file names (keeps spaces, drops <>:"/\\|?* etc.)
function personName(s) {
  return String(s || '').replace(/[<>:"\/\\|?*\x00-\x1f]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '').slice(0, 60);
}
function shortDate(d = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())}-${String(d.getFullYear()).slice(-2)}`;
}
const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Files this app creates: CB_*.mka, or "<Name> MM-DD-YY (n).mka"
const OUR_MKA = /^(CB_.*|.+ \d{2}-\d{2}-\d{2} \(\d+\))\.mka$/i;

/** Next free "(n)" for this person today, counting finished .wav and in-progress .mka files.
 *  Also returns the spelling already used today, so "joe smith" continues "Joe Smith". */
function nextSequence(folder, name, date, withName) {
  const re = new RegExp('^(' + escRe(name) + ') ' + escRe(date) + ' \\((\\d+)\\)(?: \\(\\d+\\))?\\.(wav|mka)$', 'i');
  let max = 0, spelled = name;
  try {
    for (const f of fs.readdirSync(folder)) {
      const m = re.exec(f);
      if (m && +m[2] > max) { max = +m[2]; spelled = m[1]; }
    }
  } catch (_) {}
  return withName ? { n: max + 1, name: spelled } : max + 1;
}

function stamp(d = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}
const safe = s => String(s || '').replace(/\*/g, 'star').replace(/[^\w+#.-]+/g, '_').slice(0, 40) || 'unknown';

class Recorder {
  constructor({ journalPath, log = () => {} }) {
    this.journalPath = journalPath;
    this.log = log;
    this.active = null; // { writer, mka, startedAt }
  }

  _journal() { try { return JSON.parse(fs.readFileSync(this.journalPath, 'utf8')); } catch (_) { return { active: [] }; } }
  _saveJournal(j) {
    const tmp = this.journalPath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(j, null, 2));
    fs.renameSync(tmp, this.journalPath);
  }

  get isRecording() { return !!this.active; }
  get elapsed() { return this.active ? this.active.writer.durationSec : 0; }
  get file() { return this.active ? this.active.mka : null; }

  start({ folder, extension, number, person }) {
    if (this.active) return this.active.mka;
    fs.mkdirSync(folder, { recursive: true });
    let mka;
    const who = personName(person);
    if (who) {
      // "Joe Smith 11-18-26 (3)" — the sequence continues for the same person on the same day,
      // even after monitoring someone else or restarting the app.
      const date = shortDate();
      const next = nextSequence(folder, who, date, true);
      let n = next.n;
      mka = path.join(folder, `${next.name} ${date} (${n}).mka`);
      while (fs.existsSync(mka) || fs.existsSync(mka.replace(/\.mka$/, '.wav'))) mka = path.join(folder, `${next.name} ${date} (${++n}).mka`);
    } else {
      const base = `${PREFIX}${safe(extension)}_${safe(number)}_${stamp()}`;
      mka = path.join(folder, base + '.mka');
      let i = 2; while (fs.existsSync(mka)) mka = path.join(folder, `${base}_${i++}.mka`);
    }
    const writer = new MkaWriter(mka, { sampleRate: 8000, channels: 1, title: `Call with ${number}` });
    const j = this._journal();
    j.active.push({ mka, startedAt: Date.now(), pid: process.pid });
    this._saveJournal(j);
    this.active = { writer, mka, startedAt: Date.now(), person: who, folder };
    this.log(`recording started ${mka}`);
    return mka;
  }

  /** Mix remote + local 20 ms frames into the recording (either may be null). */
  write(remote, local) {
    if (!this.active) return;
    const n = 160;
    const out = new Int16Array(n);
    for (let i = 0; i < n; i++) {
      let v = (remote ? remote[i] : 0) + (local ? local[i] : 0);
      out[i] = v > 32767 ? 32767 : v < -32768 ? -32768 : v;
    }
    try { this.active.writer.write(out); } catch (e) { this.log('recording write failed: ' + e.message); }
  }

  /** True if the recording in progress was started without a person's name. */
  get isUnnamed() { return !!this.active && !this.active.person; }

  /** File name (without extension) a recording started at `startedAt` would get for `person`. */
  _namedBase(folder, person, startedAt) {
    const who = personName(person);
    if (!who) return null;
    const date = shortDate(new Date(startedAt));
    const next = nextSequence(folder, who, date, true);
    return `${next.name} ${date} (${next.n})`;
  }

  /**
   * Stop and convert. If the recording was started without a name and `person` is given now,
   * the .wav gets that person's name. Returns { wavPath, seconds, named, unnamed, startedAt, folder } or null.
   */
  stop({ keepMka = false, person = '' } = {}) {
    if (!this.active) return null;
    const { writer, mka, startedAt, folder } = this.active;
    const unnamedStart = !this.active.person;
    this.active = null;
    try { writer.close(); } catch (e) { this.log('close failed ' + e.message); }
    const base = unnamedStart ? this._namedBase(folder, person, startedAt) : null;
    const r = this._finalize(mka, keepMka, base ? path.join(folder, base + '.wav') : null);
    if (r) Object.assign(r, { named: !!base, unnamed: unnamedStart && !base, startedAt, folder });
    return r;
  }

  /**
   * Give an already-finished, unnamed recording a person's name, e.g.
   * "CB_1001_..._.wav" -> "Joe Smith 11-23-26 (1).wav". Returns the new path.
   */
  renameToPerson({ wavPath, startedAt, folder }, person) {
    const base = this._namedBase(folder, person, startedAt);
    if (!base) return null;
    const target = path.join(folder, base + '.wav');
    fs.renameSync(wavPath, target);
    const oldMka = wavPath.replace(/\.wav$/i, '.mka');
    if (fs.existsSync(oldMka)) { try { fs.renameSync(oldMka, path.join(folder, base + '.mka')); } catch (_) {} }
    return target;
  }

  _finalize(mka, keepMka, wavTarget) {
    let result = null;
    try {
      result = convertMkaToWav(mka, wavTarget || undefined);
      if (!keepMka) fs.unlinkSync(mka);
      else if (wavTarget) { try { fs.renameSync(mka, wavTarget.replace(/\.wav$/i, '.mka')); } catch (_) {} }
    } catch (e) {
      this.log(`conversion failed for ${mka}: ${e.message}`);
      return null; // leave the .mka + journal entry so the next start retries
    }
    const j = this._journal();
    j.active = j.active.filter(e => e.mka !== mka);
    this._saveJournal(j);
    return result;
  }

  /**
   * Called on startup: convert any .mka that was never finalized (crash / power loss).
   * Looks at the journal and also scans the recording folders for orphaned CB_*.mka files.
   */
  recover(folders = [], { keepMka = false } = {}) {
    const recovered = [];
    const j = this._journal();
    const candidates = new Set(j.active.map(e => e.mka));
    for (const f of folders) {
      try {
        for (const name of fs.readdirSync(f)) {
          if (OUR_MKA.test(name)) {
            const full = path.join(f, name);
            const wav = full.replace(/\.mka$/i, '.wav');
            if (!fs.existsSync(wav) || candidates.has(full)) candidates.add(full);
          }
        }
      } catch (_) { /* folder missing */ }
    }
    for (const mka of candidates) {
      if (this.active && this.active.mka === mka) continue;
      for (const stale of [mka.replace(/\.mka$/i, '.wav.part')]) { try { fs.unlinkSync(stale); } catch (_) {} }
      if (!fs.existsSync(mka)) {
        j.active = j.active.filter(e => e.mka !== mka);
        continue;
      }
      if (!j.active.find(e => e.mka === mka)) { j.active.push({ mka, startedAt: 0 }); }
      this._saveJournal(j);
      const r = this._finalize(mka, keepMka);
      if (r) recovered.push(r);
    }
    const j2 = this._journal();
    j2.active = j2.active.filter(e => fs.existsSync(e.mka));
    this._saveJournal(j2);
    return recovered;
  }
}

module.exports = { Recorder, convertMkaToWav, personName, shortDate, nextSequence };
