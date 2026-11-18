'use strict';
// G.711 mu-law / A-law codecs with lookup tables.

const ULAW_DEC = new Int16Array(256);
const ALAW_DEC = new Int16Array(256);

for (let i = 0; i < 256; i++) {
  let u = ~i & 0xff;
  let t = ((u & 0x0f) << 3) + 0x84;
  t <<= (u & 0x70) >> 4;
  ULAW_DEC[i] = (u & 0x80) ? (0x84 - t) : (t - 0x84);

  let a = i ^ 0x55;
  let tt = (a & 0x0f) << 4;
  const seg = (a & 0x70) >> 4;
  if (seg === 0) tt += 8;
  else if (seg === 1) tt += 0x108;
  else { tt += 0x108; tt <<= seg - 1; }
  ALAW_DEC[i] = (a & 0x80) ? tt : -tt;
}

function linearToUlaw(sample) {
  const BIAS = 0x84, CLIP = 32635;
  let sign = (sample >> 8) & 0x80;
  if (sign) sample = -sample;
  if (sample > CLIP) sample = CLIP;
  sample += BIAS;
  let exponent = 7;
  for (let mask = 0x4000; (sample & mask) === 0 && exponent > 0; exponent--, mask >>= 1);
  const mantissa = (sample >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

function linearToAlaw(sample) {
  let mask;
  if (sample >= 0) mask = 0xd5; else { mask = 0x55; sample = -sample - 1; }
  if (sample > 32767) sample = 32767;
  const segEnd = [0xff, 0x1ff, 0x3ff, 0x7ff, 0xfff, 0x1fff, 0x3fff, 0x7fff];
  let seg = 0;
  while (seg < 8 && sample > segEnd[seg]) seg++;
  if (seg >= 8) return 0x7f ^ mask;
  let aval = seg << 4;
  aval |= seg < 2 ? (sample >> 4) & 0x0f : (sample >> (seg + 3)) & 0x0f;
  return aval ^ mask;
}

const ULAW_ENC = new Uint8Array(65536);
const ALAW_ENC = new Uint8Array(65536);
for (let i = -32768; i < 32768; i++) {
  ULAW_ENC[i & 0xffff] = linearToUlaw(i);
  ALAW_ENC[i & 0xffff] = linearToAlaw(i);
}

function encode(pt, pcm) {
  const table = pt === 8 ? ALAW_ENC : ULAW_ENC;
  const out = Buffer.allocUnsafe(pcm.length);
  for (let i = 0; i < pcm.length; i++) out[i] = table[pcm[i] & 0xffff];
  return out;
}

function decode(pt, buf) {
  const table = pt === 8 ? ALAW_DEC : ULAW_DEC;
  const out = new Int16Array(buf.length);
  for (let i = 0; i < buf.length; i++) out[i] = table[buf[i]];
  return out;
}

module.exports = { encode, decode };
