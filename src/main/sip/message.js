'use strict';
// Minimal, robust SIP message parser/serializer (RFC 3261) for UDP.

const COMPACT = {
  v: 'via', f: 'from', t: 'to', i: 'call-id', m: 'contact', l: 'content-length',
  c: 'content-type', k: 'supported', s: 'subject', e: 'content-encoding',
  o: 'event', r: 'refer-to', u: 'allow-events', x: 'session-expires', b: 'referred-by'
};

const CANON = {
  'call-id': 'Call-ID', cseq: 'CSeq', 'www-authenticate': 'WWW-Authenticate',
  'proxy-authenticate': 'Proxy-Authenticate', 'proxy-authorization': 'Proxy-Authorization',
  'max-forwards': 'Max-Forwards', 'user-agent': 'User-Agent', 'record-route': 'Record-Route',
  'content-type': 'Content-Type', 'content-length': 'Content-Length', 'allow-events': 'Allow-Events',
  'p-asserted-identity': 'P-Asserted-Identity', 'remote-party-id': 'Remote-Party-ID'
};

// Headers that may carry comma separated lists and should be split.
const LIST_HEADERS = new Set(['via', 'contact', 'route', 'record-route', 'allow', 'supported', 'require']);

function canonName(lower) {
  if (CANON[lower]) return CANON[lower];
  return lower.split('-').map(p => p.charAt(0).toUpperCase() + p.slice(1)).join('-');
}

// Split a header value on commas that are not inside quotes or <>.
function splitList(value) {
  const out = [];
  let cur = '', q = false, a = 0;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch === '"' && value[i - 1] !== '\\') q = !q;
    else if (!q && ch === '<') a++;
    else if (!q && ch === '>') a = Math.max(0, a - 1);
    if (ch === ',' && !q && a === 0) { if (cur.trim()) out.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function parseParams(str) {
  const params = {};
  if (!str) return params;
  for (const part of str.split(';')) {
    const p = part.trim();
    if (!p) continue;
    const eq = p.indexOf('=');
    if (eq < 0) params[p.toLowerCase()] = null;
    else params[p.slice(0, eq).trim().toLowerCase()] = p.slice(eq + 1).trim().replace(/^"(.*)"$/, '$1');
  }
  return params;
}

function parseUri(uri) {
  const m = /^(sips?|tel):(?:([^@]*)@)?([^;?]*)(;[^?]*)?(\?.*)?$/i.exec((uri || '').trim());
  if (!m) return null;
  let host = m[3], port = null;
  const v6 = /^\[(.*)\](?::(\d+))?$/.exec(host);
  if (v6) { host = v6[1]; port = v6[2] ? +v6[2] : null; }
  else { const hp = host.split(':'); host = hp[0]; port = hp[1] ? +hp[1] : null; }
  return { scheme: m[1].toLowerCase(), user: m[2] ? decodeURIComponent(m[2].split(':')[0]) : null,
    host, port, params: parseParams((m[4] || '').slice(1)) };
}

// '"Bob" <sip:1001@pbx>;tag=abc'  ->  { display, uri, params }
function parseNameAddr(value) {
  value = (value || '').trim();
  let display = '', uri, rest;
  const lt = value.indexOf('<');
  if (lt >= 0) {
    const gt = value.indexOf('>', lt);
    display = value.slice(0, lt).trim().replace(/^"(.*)"$/, '$1').replace(/\\"/g, '"');
    uri = value.slice(lt + 1, gt);
    rest = value.slice(gt + 1);
  } else {
    const sc = value.indexOf(';');
    uri = sc >= 0 ? value.slice(0, sc) : value;
    rest = sc >= 0 ? value.slice(sc) : '';
  }
  return { display, uri: uri.trim(), params: parseParams(rest.replace(/^\s*;/, '')) };
}

function parseVia(value) {
  const m = /^SIP\s*\/\s*2\.0\s*\/\s*(\w+)\s+([^;\s]+)\s*(;.*)?$/i.exec(value.trim());
  if (!m) return null;
  let host = m[2], port = null;
  const v6 = /^\[(.*)\](?::(\d+))?$/.exec(host);
  if (v6) { host = v6[1]; port = v6[2] ? +v6[2] : null; }
  else { const hp = host.split(':'); host = hp[0]; port = hp[1] ? +hp[1] : null; }
  return { transport: m[1].toUpperCase(), host, port, params: parseParams((m[3] || '').slice(1)) };
}

// 'Digest realm="x",nonce="y",qop="auth"' -> { scheme, params }
function parseAuthHeader(value) {
  const m = /^\s*(\w+)\s+(.*)$/s.exec(value || '');
  if (!m) return null;
  const params = {};
  const re = /([\w-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^,\s]+))/g;
  let r;
  while ((r = re.exec(m[2]))) params[r[1].toLowerCase()] = r[2] !== undefined ? r[2] : r[3];
  return { scheme: m[1], params };
}

class SipMessage {
  constructor() {
    this.isRequest = false;
    this.method = null; this.uri = null;
    this.status = 0; this.reason = '';
    this.headers = []; // [lowerName, value]
    this.body = '';
  }

  static request(method, uri) {
    const m = new SipMessage();
    m.isRequest = true; m.method = method; m.uri = uri;
    return m;
  }

  static response(status, reason) {
    const m = new SipMessage();
    m.status = status; m.reason = reason;
    return m;
  }

  static parse(data) {
    const text = Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
    if (!text.trim()) return null; // CRLF keep-alive
    let sep = text.indexOf('\r\n\r\n'), sepLen = 4;
    if (sep < 0) { sep = text.indexOf('\n\n'); sepLen = 2; }
    const head = sep >= 0 ? text.slice(0, sep) : text;
    let body = sep >= 0 ? text.slice(sep + sepLen) : '';
    const rawLines = head.split(/\r?\n/);
    const lines = [];
    for (const l of rawLines) {
      if (/^[ \t]/.test(l) && lines.length) lines[lines.length - 1] += ' ' + l.trim();
      else lines.push(l);
    }
    const msg = new SipMessage();
    const first = lines.shift().trim();
    let m;
    if ((m = /^SIP\/2\.0\s+(\d{3})\s*(.*)$/i.exec(first))) {
      msg.status = +m[1]; msg.reason = m[2];
    } else if ((m = /^([A-Z]+)\s+(\S+)\s+SIP\/2\.0$/i.exec(first))) {
      msg.isRequest = true; msg.method = m[1].toUpperCase(); msg.uri = m[2];
    } else return null;
    for (const l of lines) {
      const c = l.indexOf(':');
      if (c <= 0) continue;
      let name = l.slice(0, c).trim().toLowerCase();
      if (COMPACT[name]) name = COMPACT[name];
      const value = l.slice(c + 1).trim();
      if (LIST_HEADERS.has(name)) for (const v of splitList(value)) msg.headers.push([name, v]);
      else msg.headers.push([name, value]);
    }
    const cl = msg.get('content-length');
    if (cl !== undefined && !isNaN(+cl)) {
      const buf = Buffer.from(body, 'utf8');
      body = buf.slice(0, +cl).toString('utf8');
    }
    msg.body = body;
    return msg;
  }

  get(name) { name = name.toLowerCase(); const h = this.headers.find(x => x[0] === name); return h ? h[1] : undefined; }
  getAll(name) { name = name.toLowerCase(); return this.headers.filter(x => x[0] === name).map(x => x[1]); }
  set(name, value) { this.remove(name); this.headers.push([name.toLowerCase(), String(value)]); return this; }
  add(name, value) { this.headers.push([name.toLowerCase(), String(value)]); return this; }
  prepend(name, value) { this.headers.unshift([name.toLowerCase(), String(value)]); return this; }
  remove(name) { name = name.toLowerCase(); this.headers = this.headers.filter(x => x[0] !== name); return this; }

  get callId() { return this.get('call-id'); }
  get cseq() {
    const v = this.get('cseq') || '';
    const m = /^\s*(\d+)\s+(\w+)/.exec(v);
    return m ? { seq: +m[1], method: m[2].toUpperCase() } : { seq: 0, method: '' };
  }
  get topVia() { const v = this.get('via'); return v ? parseVia(v) : null; }
  get from() { return parseNameAddr(this.get('from')); }
  get to() { return parseNameAddr(this.get('to')); }

  toString() {
    const body = this.body || '';
    const lines = [this.isRequest ? `${this.method} ${this.uri} SIP/2.0` : `SIP/2.0 ${this.status} ${this.reason}`];
    for (const [n, v] of this.headers) if (n !== 'content-length') lines.push(`${canonName(n)}: ${v}`);
    lines.push(`Content-Length: ${Buffer.byteLength(body, 'utf8')}`);
    return lines.join('\r\n') + '\r\n\r\n' + body;
  }
}

module.exports = { SipMessage, parseUri, parseNameAddr, parseVia, parseAuthHeader, parseParams, splitList };
