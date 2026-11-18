'use strict';
// Streaming Matroska audio (.mka) writer/reader for 16-bit PCM.
// The Segment is written with "unknown size" and every cluster is flushed and fsync'd
// as soon as it is complete, so the file is valid and playable at any moment — if the
// app or PC crashes, everything up to the last ~0.5 s is safe (same idea as OBS + .mkv).

const fs = require('fs');

const ID = {
  EBML: 0x1A45DFA3, EBMLVersion: 0x4286, EBMLReadVersion: 0x42F7, EBMLMaxIDLength: 0x42F2,
  EBMLMaxSizeLength: 0x42F3, DocType: 0x4282, DocTypeVersion: 0x4287, DocTypeReadVersion: 0x4285,
  Segment: 0x18538067, Info: 0x1549A966, TimestampScale: 0x2AD7B1, MuxingApp: 0x4D80, WritingApp: 0x5741,
  Title: 0x7BA9, DateUTC: 0x4461,
  Tracks: 0x1654AE6B, TrackEntry: 0xAE, TrackNumber: 0xD7, TrackUID: 0x73C5, TrackType: 0x83,
  FlagLacing: 0x9C, CodecID: 0x86, Audio: 0xE1, SamplingFrequency: 0xB5, Channels: 0x9F, BitDepth: 0x6264,
  Cluster: 0x1F43B675, Timestamp: 0xE7, SimpleBlock: 0xA3, BlockGroup: 0xA0, Block: 0xA1
};
const UNKNOWN_SIZE = Buffer.from([0x01, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF]);

function idBytes(id) {
  const out = [];
  while (id > 0) { out.unshift(id & 0xff); id = Math.floor(id / 256); }
  return Buffer.from(out);
}

function sizeBytes(n) {
  for (let len = 1; len <= 8; len++) {
    if (n < Math.pow(2, 7 * len) - 1) {
      const b = Buffer.alloc(len);
      let v = n;
      for (let i = len - 1; i >= 0; i--) { b[i] = v & 0xff; v = Math.floor(v / 256); }
      b[0] |= 0x80 >> (len - 1);
      return b;
    }
  }
  throw new Error('size too large');
}

function el(id, payload) { return Buffer.concat([idBytes(id), sizeBytes(payload.length), payload]); }
function uint(id, v) {
  const out = [];
  do { out.unshift(v & 0xff); v = Math.floor(v / 256); } while (v > 0);
  return el(id, Buffer.from(out));
}
function str(id, s) { return el(id, Buffer.from(s, 'utf8')); }
function f64(id, v) { const b = Buffer.alloc(8); b.writeDoubleBE(v); return el(id, b); }

class MkaWriter {
  constructor(path, { sampleRate = 8000, channels = 1, title = '' } = {}) {
    this.path = path; this.sampleRate = sampleRate; this.channels = channels;
    this.fd = fs.openSync(path, 'w');
    this.samplesWritten = 0;
    this.pending = [];
    this.pendingSamples = 0;
    this.clusterSamples = Math.floor(sampleRate / 2); // 0.5 s clusters
    const ebml = el(ID.EBML, Buffer.concat([
      uint(ID.EBMLVersion, 1), uint(ID.EBMLReadVersion, 1), uint(ID.EBMLMaxIDLength, 4),
      uint(ID.EBMLMaxSizeLength, 8), str(ID.DocType, 'matroska'), uint(ID.DocTypeVersion, 4), uint(ID.DocTypeReadVersion, 2)
    ]));
    const info = el(ID.Info, Buffer.concat([
      uint(ID.TimestampScale, 1000000), str(ID.MuxingApp, 'Channel Blend Softphone'),
      str(ID.WritingApp, 'Channel Blend Softphone'), ...(title ? [str(ID.Title, title)] : [])
    ]));
    const tracks = el(ID.Tracks, el(ID.TrackEntry, Buffer.concat([
      uint(ID.TrackNumber, 1), uint(ID.TrackUID, 1 + Math.floor(Math.random() * 0xffffff)), uint(ID.TrackType, 2),
      uint(ID.FlagLacing, 0), str(ID.CodecID, 'A_PCM/INT/LIT'),
      el(ID.Audio, Buffer.concat([f64(ID.SamplingFrequency, sampleRate), uint(ID.Channels, channels), uint(ID.BitDepth, 16)]))
    ])));
    const head = Buffer.concat([ebml, idBytes(ID.Segment), UNKNOWN_SIZE, info, tracks]);
    fs.writeSync(this.fd, head);
    fs.fsyncSync(this.fd);
  }

  /** @param {Int16Array} pcm interleaved samples */
  write(pcm) {
    if (this.fd === null) return;
    this.pending.push(Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength));
    this.pendingSamples += pcm.length / this.channels;
    if (this.pendingSamples >= this.clusterSamples) this.flush();
  }

  flush() {
    if (this.fd === null || !this.pendingSamples) return;
    const data = Buffer.concat(this.pending);
    const ms = Math.round(this.samplesWritten * 1000 / this.sampleRate);
    const block = Buffer.concat([Buffer.from([0x81, 0x00, 0x00, 0x80]), data]); // track 1, rel ts 0, keyframe
    const cluster = el(ID.Cluster, Buffer.concat([uint(ID.Timestamp, ms), el(ID.SimpleBlock, block)]));
    fs.writeSync(this.fd, cluster);
    try { fs.fdatasyncSync(this.fd); } catch (_) { fs.fsyncSync(this.fd); }
    this.samplesWritten += this.pendingSamples;
    this.pending = []; this.pendingSamples = 0;
  }

  close() {
    if (this.fd === null) return;
    this.flush();
    fs.closeSync(this.fd);
    this.fd = null;
  }

  get durationSec() { return (this.samplesWritten + this.pendingSamples) / this.sampleRate; }
}

// ---------------------------------------------------------------- reader (tolerates truncation)
function readVint(buf, pos, keepMarker) {
  if (pos >= buf.length) return null;
  const first = buf[pos];
  let len = 1, mask = 0x80;
  while (len <= 8 && !(first & mask)) { len++; mask >>= 1; }
  if (len > 8 || pos + len > buf.length) return null;
  let value = keepMarker ? first : first & (mask - 1);
  let allOnes = (first & (mask - 1)) === mask - 1;
  for (let i = 1; i < len; i++) { value = value * 256 + buf[pos + i]; if (buf[pos + i] !== 0xff) allOnes = false; }
  return { value, len, unknown: !keepMarker && allOnes };
}

function readUInt(buf, start, len) { let v = 0; for (let i = 0; i < len; i++) v = v * 256 + buf[start + i]; return v; }

const MASTER = new Set([ID.Segment, ID.Cluster, ID.Tracks, ID.TrackEntry, ID.Audio, ID.BlockGroup]);

/**
 * Extract PCM from an .mka produced by MkaWriter (or any simple PCM mka).
 * Returns { sampleRate, channels, bitDepth, pcm: Buffer } — never throws on a truncated tail.
 */
function readMka(path) {
  const buf = fs.readFileSync(path);
  const fmt = { sampleRate: 8000, channels: 1, bitDepth: 16 };
  const chunks = [];
  let pos = 0;
  const end = buf.length;
  while (pos < end) {
    const id = readVint(buf, pos, true); if (!id) break;
    const size = readVint(buf, pos + id.len, false); if (!size) break;
    const dataStart = pos + id.len + size.len;
    const elId = id.value;
    if (MASTER.has(elId)) { pos = dataStart; continue; } // descend into masters (sizes may be unknown)
    const dataEnd = size.unknown ? end : dataStart + size.value;
    const avail = Math.min(dataEnd, end);
    switch (elId) {
      case ID.SamplingFrequency:
        if (avail - dataStart === 8) fmt.sampleRate = Math.round(buf.readDoubleBE(dataStart));
        else if (avail - dataStart === 4) fmt.sampleRate = Math.round(buf.readFloatBE(dataStart));
        break;
      case ID.Channels: fmt.channels = readUInt(buf, dataStart, avail - dataStart) || 1; break;
      case ID.BitDepth: fmt.bitDepth = readUInt(buf, dataStart, avail - dataStart) || 16; break;
      case ID.SimpleBlock:
      case ID.Block: {
        const tn = readVint(buf, dataStart, false);
        if (!tn) break;
        const hdr = tn.len + 3;
        let payload = buf.subarray(dataStart + hdr, avail);
        const frame = fmt.channels * 2;
        payload = payload.subarray(0, payload.length - (payload.length % frame));
        if (payload.length) chunks.push(payload);
        break;
      }
      default: break;
    }
    if (dataEnd > end) break; // truncated element; we kept what was there
    pos = dataEnd;
  }
  return { ...fmt, pcm: Buffer.concat(chunks) };
}

module.exports = { MkaWriter, readMka };
