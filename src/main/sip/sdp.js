'use strict';

// Payload types we can encode/decode natively.
const SUPPORTED = { 0: 'PCMU', 8: 'PCMA' };
const NAME_TO_PT = { PCMU: 0, PCMA: 8 };

function buildSdp({ ip, port, sessionId, version, codecs = [0, 8], tePt = 101, direction = 'sendrecv' }) {
  const fmts = [...codecs];
  if (tePt != null) fmts.push(tePt);
  const lines = [
    'v=0',
    `o=- ${sessionId} ${version} IN IP4 ${ip}`,
    's=Channel Blend Softphone',
    `c=IN IP4 ${ip}`,
    't=0 0',
    `m=audio ${port} RTP/AVP ${fmts.join(' ')}`
  ];
  for (const pt of codecs) lines.push(`a=rtpmap:${pt} ${SUPPORTED[pt]}/8000`);
  if (tePt != null) lines.push(`a=rtpmap:${tePt} telephone-event/8000`, `a=fmtp:${tePt} 0-16`);
  lines.push('a=ptime:20', `a=${direction}`);
  return lines.join('\r\n') + '\r\n';
}

function parseSdp(text) {
  if (!text) return null;
  const res = { ip: null, port: 0, formats: [], rtpmap: {}, direction: 'sendrecv', ptime: 20 };
  let inAudio = false, sessionIp = null, mediaIp = null, sawAudio = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const type = line[0], val = line.slice(2);
    if (type === 'm') {
      inAudio = /^audio\s/.test(val) && !sawAudio;
      if (inAudio) {
        sawAudio = true;
        const p = val.split(/\s+/);
        res.port = parseInt(p[1], 10);
        res.formats = p.slice(3).map(Number);
      }
    } else if (type === 'c') {
      const ip = (val.split(/\s+/)[2] || '').split('/')[0];
      if (inAudio) mediaIp = ip; else if (!sawAudio) sessionIp = ip;
    } else if (type === 'a' && (inAudio || !sawAudio)) {
      let m;
      if ((m = /^rtpmap:(\d+)\s+([\w-]+)\/(\d+)/i.exec(val)) && inAudio) res.rtpmap[+m[1]] = { name: m[2], rate: +m[3] };
      else if (/^(sendrecv|sendonly|recvonly|inactive)$/i.test(val)) res.direction = val.toLowerCase();
      else if ((m = /^ptime:(\d+)/.exec(val))) res.ptime = +m[1];
    }
  }
  if (!sawAudio) return null;
  res.ip = mediaIp || sessionIp;
  // Static payload types may be omitted from rtpmap.
  for (const f of res.formats) if (!res.rtpmap[f] && SUPPORTED[f]) res.rtpmap[f] = { name: SUPPORTED[f], rate: 8000 };
  res.codec = null;
  for (const f of res.formats) {
    const n = (res.rtpmap[f] && res.rtpmap[f].name || '').toUpperCase();
    if (NAME_TO_PT[n] !== undefined && res.rtpmap[f].rate === 8000) { res.codec = { pt: f, name: n }; break; }
  }
  res.tePt = null;
  for (const f of res.formats) if (/telephone-event/i.test(res.rtpmap[f] && res.rtpmap[f].name || '')) { res.tePt = f; break; }
  return res;
}

module.exports = { buildSdp, parseSdp, SUPPORTED };
