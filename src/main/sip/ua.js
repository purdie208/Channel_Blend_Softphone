'use strict';
// SIP user agent for one "line" (account). UDP only: rport, CRLF keep-alives
// every 30 s, digest auth with a
// separate authorization user, RFC 2833 DTMF, PCMU/PCMA.

const dgram = require('dgram');
const dns = require('dns').promises;
const net = require('net');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { SipMessage, parseUri, parseNameAddr, parseVia } = require('./message');
const { pickChallenge, buildAuthorization } = require('./digest');
const { buildSdp, parseSdp } = require('./sdp');
const { MediaSession } = require('../media/mediaSession');

const T1 = 500, T2 = 4000, TIMEOUT = 32000;
const ALLOW = 'INVITE, ACK, CANCEL, BYE, OPTIONS, INFO, NOTIFY, UPDATE, MESSAGE';
const rand = (n = 8) => crypto.randomBytes(n).toString('hex');
const branchId = () => 'z9hG4bK-cb' + rand(8);
let USER_AGENT = 'Channel Blend Softphone';

function quoteDisplay(name) { return name ? `"${String(name).replace(/(["\\])/g, '\\$1')}" ` : ''; }

function splitHostPort(domain) {
  const d = String(domain || '').trim().replace(/^sips?:/i, '');
  const v6 = /^\[(.*)\](?::(\d+))?$/.exec(d);
  if (v6) return { host: v6[1], port: v6[2] ? +v6[2] : null };
  const [host, port] = d.split(':');
  return { host, port: port ? +port : null };
}

function localIpFor(host, port) {
  return new Promise(resolve => {
    const s = dgram.createSocket('udp4');
    s.on('error', () => { try { s.close(); } catch (_) {} resolve('127.0.0.1'); });
    s.connect(port, host, () => {
      let ip = '127.0.0.1';
      try { ip = s.address().address; } catch (_) {}
      try { s.close(); } catch (_) {}
      resolve(ip);
    });
  });
}

class SipUA extends EventEmitter {
  /**
   * @param {object} account { displayName, username, authUsername, password, domain }
   * @param {object} opts    { sipPort, registerExpires, keepAliveSec, usePublicAddress, rtpPortMin, rtpPortMax, userAgent }
   */
  constructor(account, opts = {}) {
    super();
    this.account = { ...account };
    this.opts = Object.assign({ sipPort: 0, registerExpires: 3600, keepAliveSec: 30, usePublicAddress: true, rtpPortMin: 5000, rtpPortMax: 36385 }, opts);
    if (opts.userAgent) USER_AGENT = opts.userAgent;
    this.status = 'idle';
    this.statusText = 'Not registered';
    this.socket = null;
    this.server = null; // { ip, port }
    this.localIp = null; this.localPort = 0;
    this.publicAddr = null; // learned from rport/received
    this.clientTx = new Map();
    this.serverTx = new Map();
    this.calls = new Map(); // callId -> Call
    this.reg = { callId: rand(12) + '@cb', tag: rand(6), cseq: 0, timer: null, retry: null, expires: 0, rinstance: rand(8) };
    this.keepAliveTimer = null;
    this.stopped = false;
  }

  get domainParts() { return splitHostPort(this.account.domain); }
  get aor() { return `sip:${this.account.username}@${this.domainParts.host}`; }
  get registrarUri() { return `sip:${String(this.account.domain).trim().replace(/^sips?:/i, '')}`; }
  get authUser() { return (this.account.authUsername || '').trim() || this.account.username; }

  contactAddr() {
    if (this.opts.usePublicAddress && this.publicAddr) return this.publicAddr;
    return { ip: this.localIp, port: this.localPort };
  }
  contactHeader() {
    const a = this.contactAddr();
    return `<sip:${this.account.username}@${a.ip}:${a.port};rinstance=${this.reg.rinstance};transport=udp>`;
  }

  _setStatus(status, text) {
    this.status = status; this.statusText = text;
    this.emit('status', { status, text });
  }

  async start() {
    this.stopped = false;
    const { host, port } = this.domainParts;
    if (!host || !this.account.username) { this._setStatus('failed', 'Missing domain or user name'); return; }
    this._setStatus('registering', 'Looking up server…');
    try {
      this.server = await this._resolve(host, port);
    } catch (e) {
      this._setStatus('failed', `Cannot find server "${host}"`);
      this._scheduleRetry(30);
      return;
    }
    this.localIp = await localIpFor(this.server.ip, this.server.port);
    if (!this.socket) await this._bind();
    this._startKeepAlive();
    this.register();
  }

  async _resolve(host, port) {
    if (net.isIP(host)) return { ip: host, port: port || 5060 };
    if (!port) {
      try {
        const srv = await dns.resolveSrv(`_sip._udp.${host}`);
        if (srv.length) {
          srv.sort((a, b) => a.priority - b.priority || b.weight - a.weight);
          const r = await dns.lookup(srv[0].name, { family: 4 });
          return { ip: r.address, port: srv[0].port };
        }
      } catch (_) { /* no SRV record; fall through */ }
    }
    const r = await dns.lookup(host, { family: 4 });
    return { ip: r.address, port: port || 5060 };
  }

  _bind() {
    const tryPort = p => new Promise((resolve, reject) => {
      const s = dgram.createSocket({ type: 'udp4' });
      s.once('error', e => { try { s.close(); } catch (_) {} reject(e); });
      s.bind(p, '0.0.0.0', () => { s.removeAllListeners('error'); resolve(s); });
    });
    return (async () => {
      let s;
      try { s = await tryPort(this.opts.sipPort || 0); } catch (_) { s = await tryPort(0); }
      s.on('error', e => this.emit('log', 'socket error ' + e.message));
      s.on('message', (buf, rinfo) => this._onMessage(buf, rinfo));
      this.socket = s;
      this.localPort = s.address().port;
    })();
  }

  _startKeepAlive() {
    clearInterval(this.keepAliveTimer);
    let ticks = 0;
    const sec = Math.max(10, this.opts.keepAliveSec | 0 || 30);
    this.keepAliveTimer = setInterval(async () => {
      if (!this.socket || !this.server) return;
      this.socket.send(Buffer.from('\r\n\r\n'), this.server.port, this.server.ip, () => {});
      // Laptop moved networks? Re-register with the new address.
      if (++ticks % 2 === 0) {
        const ip = await localIpFor(this.server.ip, this.server.port);
        if (ip !== this.localIp) {
          this.emit('log', `local IP changed ${this.localIp} -> ${ip}`);
          this.localIp = ip; this.publicAddr = null;
          if (this.status !== 'idle') this.register();
        }
      }
    }, sec * 1000);
  }

  _scheduleRetry(sec) {
    clearTimeout(this.reg.retry);
    if (this.stopped) return;
    this.reg.retry = setTimeout(() => this.start(), sec * 1000);
  }

  async stop() {
    this.stopped = true;
    clearTimeout(this.reg.timer); clearTimeout(this.reg.retry);
    clearInterval(this.keepAliveTimer);
    for (const c of [...this.calls.values()]) c.hangup();
    if (this.status === 'registered' && this.socket) {
      await new Promise(resolve => {
        const t = setTimeout(resolve, 1500);
        this.register(0, () => { clearTimeout(t); resolve(); });
      });
    }
    for (const tx of this.clientTx.values()) { clearTimeout(tx.timer); clearTimeout(tx.timeout); }
    this.clientTx.clear();
    for (const tx of this.serverTx.values()) clearTimeout(tx.timer);
    this.serverTx.clear();
    if (this.socket) { try { this.socket.close(); } catch (_) {} }
    this.socket = null;
    this._setStatus('idle', 'Not registered');
  }

  // ------------------------------------------------------------------ transport
  _sendRaw(str, ip, port) {
    if (!this.socket) return;
    this.emit('trace', { dir: 'out', to: `${ip}:${port}`, text: str });
    this.socket.send(Buffer.from(str, 'utf8'), port, ip, () => {});
  }

  _via(branch) {
    return `SIP/2.0/UDP ${this.localIp}:${this.localPort};branch=${branch};rport`;
  }

  /** Send a request through a client transaction. All requests go to the PBX (acts as outbound proxy). */
  sendRequest(req, onResponse, opts = {}) {
    const branch = opts.branch || branchId();
    req.remove('via').prepend('via', this._via(branch));
    if (!req.get('max-forwards')) req.set('Max-Forwards', '70');
    if (!req.get('user-agent')) req.set('User-Agent', USER_AGENT);
    const isInvite = req.method === 'INVITE';
    const tx = { branch, method: req.method, req, str: req.toString(), onResponse, interval: T1, done: false, provisional: false };
    this.clientTx.set(branch, tx);
    const dest = this.server;
    const fire = () => { if (!tx.done) this._sendRaw(tx.str, dest.ip, dest.port); };
    fire();
    if (req.method !== 'ACK') {
      const retransmit = () => {
        if (tx.done || (isInvite && tx.provisional)) return;
        fire();
        tx.interval = isInvite ? tx.interval * 2 : Math.min(tx.interval * 2, T2);
        tx.timer = setTimeout(retransmit, tx.interval);
      };
      tx.timer = setTimeout(retransmit, tx.interval);
      tx.timeout = setTimeout(() => {
        if (tx.done) return;
        tx.done = true;
        this.clientTx.delete(branch);
        const r = SipMessage.response(408, 'Request Timeout');
        r.timedOut = true;
        onResponse && onResponse(r, tx);
      }, TIMEOUT);
    } else {
      this.clientTx.delete(branch);
    }
    return tx;
  }

  _ackNon2xx(tx, res) {
    const inv = tx.req;
    const ack = SipMessage.request('ACK', inv.uri);
    ack.add('via', inv.get('via'));
    ack.set('Max-Forwards', '70');
    for (const r of inv.getAll('route')) ack.add('route', r);
    ack.set('From', inv.get('from'));
    ack.set('To', res.get('to'));
    ack.set('Call-ID', inv.callId);
    ack.set('CSeq', `${inv.cseq.seq} ACK`);
    this._sendRaw(ack.toString(), this.server.ip, this.server.port);
  }

  _onMessage(buf, rinfo) {
    const msg = SipMessage.parse(buf);
    if (!msg) return; // keep-alive pong
    this.emit('trace', { dir: 'in', from: `${rinfo.address}:${rinfo.port}`, text: buf.toString('utf8') });
    try {
      if (msg.isRequest) this._onRequest(msg, rinfo);
      else this._onResponse(msg, rinfo);
    } catch (e) {
      this.emit('log', 'error handling SIP message: ' + (e && e.stack || e));
    }
  }

  _onResponse(res) {
    const via = res.topVia;
    if (!via) return;
    // Learn our public address from the server's rport/received parameters.
    if (via.params.received || via.params.rport) {
      const ip = via.params.received || this.localIp;
      const port = via.params.rport ? +via.params.rport : this.localPort;
      if (ip && port) this._learnedAddr = { ip, port };
    }
    const tx = this.clientTx.get(via.params.branch);
    const cseq = res.cseq;
    if (!tx || tx.method !== cseq.method) {
      // Retransmitted 2xx to an INVITE whose transaction is gone -> dialog re-ACKs.
      if (cseq.method === 'INVITE' && res.status >= 200 && res.status < 300) {
        const call = this.calls.get(res.callId);
        if (call) call._onInviteResponse(res, null);
      }
      return;
    }
    if (res.status < 200) {
      tx.provisional = true;
      if (tx.method !== 'INVITE') { clearTimeout(tx.timer); tx.interval = T2; tx.timer = setTimeout(() => !tx.done && this._sendRaw(tx.str, this.server.ip, this.server.port), T2); }
      tx.onResponse && tx.onResponse(res, tx);
      return;
    }
    if (tx.done) { // retransmitted final
      if (tx.method === 'INVITE' && res.status >= 300) this._ackNon2xx(tx, res);
      else if (tx.method === 'INVITE') { const call = this.calls.get(res.callId); if (call) call._onInviteResponse(res, null); }
      return;
    }
    tx.done = true;
    clearTimeout(tx.timer); clearTimeout(tx.timeout);
    if (tx.method === 'INVITE' && res.status >= 300) this._ackNon2xx(tx, res);
    setTimeout(() => this.clientTx.delete(tx.branch), TIMEOUT); // absorb retransmissions
    tx.onResponse && tx.onResponse(res, tx);
  }

  /** Build and send a response to `req`. */
  reply(req, rinfo, status, reason, { headers = {}, body = '', toTag = null, contact = false } = {}) {
    const res = SipMessage.response(status, reason);
    const vias = req.getAll('via');
    vias.forEach((v, i) => {
      if (i === 0) {
        const pv = parseVia(v);
        let nv = v;
        if (pv && pv.host !== rinfo.address && !/;\s*received=/i.test(nv)) nv += `;received=${rinfo.address}`;
        nv = nv.replace(/;\s*rport(?=;|$)/i, `;rport=${rinfo.port}`);
        res.add('via', nv);
      } else res.add('via', v);
    });
    res.set('From', req.get('from'));
    let to = req.get('to');
    if (toTag && !/;\s*tag=/i.test(to) && status > 100) to += `;tag=${toTag}`;
    res.set('To', to);
    res.set('Call-ID', req.callId);
    res.set('CSeq', req.get('cseq'));
    if (contact) res.set('Contact', this.contactHeader());
    res.set('User-Agent', USER_AGENT);
    for (const [k, v] of Object.entries(headers)) res.set(k, v);
    if (body) res.body = body;
    const str = res.toString();
    this._sendRaw(str, rinfo.address, rinfo.port);
    const key = (req.topVia && req.topVia.params.branch) + ':' + req.method;
    const stx = this.serverTx.get(key);
    if (stx) stx.last = str;
    return str;
  }

  _onRequest(req, rinfo) {
    const branch = req.topVia && req.topVia.params.branch;
    const key = branch + ':' + req.method;
    if (req.method !== 'ACK') {
      const existing = this.serverTx.get(key);
      if (existing) { if (existing.last) this._sendRaw(existing.last, rinfo.address, rinfo.port); return; }
      const stx = { key, last: null };
      this.serverTx.set(key, stx);
      stx.timer = setTimeout(() => this.serverTx.delete(key), TIMEOUT);
    }
    const toTag = req.to.params.tag;
    const call = this.calls.get(req.callId);

    switch (req.method) {
      case 'OPTIONS':
        this.reply(req, rinfo, 200, 'OK', { headers: { Allow: ALLOW, Accept: 'application/sdp' } });
        return;
      case 'ACK':
        if (call) call._onAck(req);
        return;
      case 'CANCEL':
        if (call) call._onCancel(req, rinfo);
        else this.reply(req, rinfo, 481, 'Call/Transaction Does Not Exist');
        return;
      case 'INVITE':
        if (!toTag) {
          if (call) return; // retransmission already being handled
          this._incomingInvite(req, rinfo);
          return;
        }
        break;
      case 'NOTIFY':
        if (!call) {
          const ev = (req.get('event') || '').toLowerCase();
          if (ev.startsWith('message-summary')) {
            const m = /Messages-Waiting:\s*(yes|no)/i.exec(req.body || '');
            const v = /Voice-Message:\s*(\d+)\/(\d+)/i.exec(req.body || '');
            this.emit('mwi', { waiting: m ? /yes/i.test(m[1]) : false, newCount: v ? +v[1] : 0, oldCount: v ? +v[2] : 0 });
          }
          this.reply(req, rinfo, 200, 'OK');
          return;
        }
        break;
      case 'MESSAGE':
      case 'INFO':
        if (!call) { this.reply(req, rinfo, 200, 'OK'); return; }
        break;
      default:
        if (!call && !['BYE', 'UPDATE', 'REFER', 'PRACK'].includes(req.method)) {
          this.reply(req, rinfo, 405, 'Method Not Allowed', { headers: { Allow: ALLOW } });
          return;
        }
    }
    if (call) call._onRequest(req, rinfo);
    else this.reply(req, rinfo, 481, 'Call/Transaction Does Not Exist');
  }

  _incomingInvite(req, rinfo) {
    if (this.listenerCount('incoming') === 0 || this.busy) {
      this.reply(req, rinfo, 486, 'Busy Here', { toTag: rand(6) });
      return;
    }
    const call = new Call(this, { direction: 'in', invite: req, rinfo });
    this.calls.set(req.callId, call);
    this.reply(req, rinfo, 100, 'Trying');
    call._prepareIncoming().then(ok => {
      if (!ok) return;
      this.emit('incoming', call);
    });
  }

  // ------------------------------------------------------------------ registration
  register(expires = this.opts.registerExpires, done) {
    if (!this.socket || !this.server) return;
    clearTimeout(this.reg.timer);
    if (expires > 0) this._setStatus('registering', 'Registering…');
    let challenges = 0;
    const send = (authHeader) => {
      const req = SipMessage.request('REGISTER', this.registrarUri);
      req.set('From', `${quoteDisplay(this.account.displayName)}<${this.aor}>;tag=${this.reg.tag}`);
      req.set('To', `${quoteDisplay(this.account.displayName)}<${this.aor}>`);
      req.set('Call-ID', this.reg.callId);
      req.set('CSeq', `${++this.reg.cseq} REGISTER`);
      req.set('Contact', this.contactHeader());
      req.set('Expires', String(expires));
      req.set('Allow', ALLOW);
      req.set('Supported', 'replaces');
      if (authHeader) req.set(authHeader.name, authHeader.value);
      this.sendRequest(req, (res) => {
        if (res.status < 200) return;
        if (res.status === 401 || res.status === 407) {
          const ch = pickChallenge(res);
          const stale = ch && /true/i.test(ch.params.stale || '');
          if (!ch || (challenges >= 1 && !stale) || challenges > 3) {
            if (expires === 0) return done && done();
            this._setStatus('failed', 'Authentication failed — check the password and authorization user name');
            return this._scheduleRetry(60);
          }
          challenges++;
          return send({
            name: res.status === 407 ? 'Proxy-Authorization' : 'Authorization',
            value: buildAuthorization({ challenge: ch, method: 'REGISTER', uri: this.registrarUri, username: this.authUser, password: this.account.password || '' })
          });
        }
        if (expires === 0) { this.reg.expires = 0; return done && done(); }
        if (res.status === 423) {
          const min = parseInt(res.get('min-expires'), 10);
          if (min > expires) return this.register(min, done);
        }
        if (res.status >= 200 && res.status < 300) {
          // Did rport show we're behind NAT? Update the Contact once and re-register.
          if (this.opts.usePublicAddress && this._learnedAddr &&
              (!this.publicAddr || this.publicAddr.ip !== this._learnedAddr.ip || this.publicAddr.port !== this._learnedAddr.port) &&
              (this._learnedAddr.ip !== this.localIp || this._learnedAddr.port !== this.localPort)) {
            this.publicAddr = { ...this._learnedAddr };
            return this.register(expires, done);
          }
          let granted = expires;
          const e = parseInt(res.get('expires'), 10);
          if (!isNaN(e)) granted = e;
          for (const c of res.getAll('contact')) {
            const na = parseNameAddr(c);
            if (na.params.expires && na.uri.includes(this.reg.rinstance)) granted = +na.params.expires;
          }
          this.reg.expires = granted;
          this._setStatus('registered', `Registered · ext ${this.account.username}`);
          const refresh = Math.max(15, granted - Math.min(60, Math.ceil(granted * 0.15)));
          this.reg.timer = setTimeout(() => this.register(), refresh * 1000);
          done && done();
          return;
        }
        const reason = res.timedOut ? 'No response from the PBX' : `${res.status} ${res.reason}`;
        this._setStatus('failed', `Registration failed: ${reason}`);
        this._scheduleRetry(res.status === 403 || res.status === 404 ? 120 : 30);
        done && done();
      });
    };
    send(null);
  }

  // ------------------------------------------------------------------ calls
  async call(number) {
    const target = String(number).trim();
    const call = new Call(this, { direction: 'out', target });
    this.calls.set(call.callId, call);
    await call._startOutgoing();
    return call;
  }
}

class Call extends EventEmitter {
  constructor(ua, { direction, target, invite, rinfo }) {
    super();
    this.ua = ua;
    this.direction = direction;
    this.state = direction === 'out' ? 'calling' : 'incoming';
    this.media = null;
    this.remoteSdp = null;
    this.localSdpVersion = 1;
    this.sdpSessionId = Math.floor(Math.random() * 1e9);
    this.onHold = false;
    this.startedAt = Date.now();
    this.connectedAt = null;
    this.endReason = null;
    this.localCseq = Math.floor(Math.random() * 1000) + 1;
    this.remoteCseq = 0;

    if (direction === 'out') {
      const d = ua.domainParts;
      this.callId = rand(12) + '@cb';
      this.localTag = rand(6);
      this.remoteTag = null;
      const host = String(ua.account.domain).trim().replace(/^sips?:/i, '');
      const user = target.replace(/[^\w*#+.-]/g, '').replace(/#/g, '%23');
      this.remoteUri = /^sips?:[^@]+@/i.test(target) ? target : `sip:${user}@${host}`;
      this.localHeader = `${quoteDisplay(ua.account.displayName)}<sip:${ua.account.username}@${d.host}>;tag=${this.localTag}`;
      this.remoteHeader = `<${this.remoteUri}>`;
      this.remoteTarget = this.remoteUri;
      this.routeSet = [];
      this.remoteNumber = target;
      this.remoteName = '';
    } else {
      this.invite = invite; this.inviteRinfo = rinfo;
      this.callId = invite.callId;
      this.localTag = rand(6);
      this.remoteTag = invite.from.params.tag;
      this.localHeader = `${invite.get('to')};tag=${this.localTag}`;
      this.remoteHeader = invite.get('from');
      const c = invite.get('contact');
      this.remoteTarget = c ? parseNameAddr(c).uri : parseNameAddr(invite.get('from')).uri;
      this.routeSet = invite.getAll('record-route');
      this.remoteCseq = invite.cseq.seq;
      const idHdr = invite.get('p-asserted-identity') || invite.get('remote-party-id') || invite.get('from');
      const na = parseNameAddr(idHdr);
      const u = parseUri(na.uri);
      this.remoteNumber = (u && u.user) || na.uri;
      this.remoteName = na.display || '';
    }
  }

  info() {
    return {
      id: this.callId, direction: this.direction, state: this.state, number: this.remoteNumber, name: this.remoteName,
      startedAt: this.startedAt, connectedAt: this.connectedAt, onHold: this.onHold, endReason: this.endReason
    };
  }

  _setState(state, extra) {
    this.state = state;
    this.emit('state', state, extra || {});
  }

  async _newMedia() {
    this.media = new MediaSession({ portMin: this.ua.opts.rtpPortMin, portMax: this.ua.opts.rtpPortMax });
    await this.media.bind();
  }

  _sdpIp() { return this.ua.contactAddr().ip; }

  _localSdp(answerTo) {
    const dir = this.onHold ? 'sendonly' : 'sendrecv';
    const args = { ip: this._sdpIp(), port: this.media.port, sessionId: this.sdpSessionId, version: this.localSdpVersion++, direction: dir };
    if (answerTo) {
      args.codecs = answerTo.codec ? [answerTo.codec.pt] : [0];
      args.tePt = answerTo.tePt;
    }
    return buildSdp(args);
  }

  _applyRemoteSdp(sdpText) {
    const sdp = parseSdp(sdpText);
    if (!sdp || !sdp.codec) return false;
    this.remoteSdp = sdp;
    this.media.setRemote({ ip: sdp.ip, port: sdp.port, pt: sdp.codec.pt, tePt: sdp.tePt });
    this.remoteHeld = sdp.direction === 'sendonly' || sdp.direction === 'inactive' || sdp.ip === '0.0.0.0';
    return true;
  }

  // ---------------- outgoing
  async _startOutgoing() {
    await this._newMedia();
    this.offer = this._localSdp();
    this._sendInvite(null);
  }

  _baseRequest(method, uri) {
    const req = SipMessage.request(method, uri || this.remoteTarget);
    for (const r of this.routeSet) req.add('route', r);
    req.set('From', this.localHeader);
    req.set('To', this.remoteTag ? `${this.remoteHeader.replace(/;\s*tag=[^;]*/i, '')};tag=${this.remoteTag}` : this.remoteHeader);
    req.set('Call-ID', this.callId);
    return req;
  }

  _sendInvite(auth) {
    const req = this._baseRequest('INVITE', this.remoteUri);
    req.set('CSeq', `${++this.localCseq} INVITE`);
    req.set('Contact', this.ua.contactHeader());
    req.set('Allow', ALLOW);
    req.set('Supported', 'replaces');
    req.set('Content-Type', 'application/sdp');
    if (auth) req.set(auth.name, auth.value);
    req.body = this.offer;
    this.authTries = (this.authTries || 0) + (auth ? 1 : 0);
    this.inviteTx = this.ua.sendRequest(req, (res, tx) => this._onInviteResponse(res, tx));
  }

  _onInviteResponse(res, tx) {
    if (this.state === 'ended' && !(res.status >= 200 && res.status < 300)) return;
    if (tx && tx !== this.inviteTx) {
      // response to an old (challenged/re-INVITE) transaction
      if (tx.reinvite) return tx.reinvite(res);
      return;
    }
    const s = res.status;
    if (s < 200) {
      if (s > 100) {
        const tag = res.to.params.tag;
        if (tag && !this.remoteTag) this.earlyTag = tag;
        if (this.pendingCancel) { this._sendCancel(); return; }
        if (res.body && /application\/sdp/i.test(res.get('content-type') || '') && this._applyRemoteSdp(res.body)) {
          this.media.start();
          this._setState('early', { earlyMedia: true });
        } else if (this.state === 'calling') {
          this._setState('ringing', { earlyMedia: false });
        }
      }
      return;
    }
    if (s < 300) {
      if (this.state === 'connected' || this.state === 'ended') {
        if (!this.remoteTag) {
          this.remoteTag = res.to.params.tag;
          const c0 = res.get('contact');
          if (c0) this.remoteTarget = parseNameAddr(c0).uri;
          this.routeSet = res.getAll('record-route').reverse();
        }
        this._sendAck(res);
        if (this.state === 'ended' && !this.byeSent) { this.byeSent = true; this._sendBye(); }
        return;
      }
      this.remoteTag = res.to.params.tag;
      const c = res.get('contact');
      if (c) this.remoteTarget = parseNameAddr(c).uri;
      this.routeSet = res.getAll('record-route').reverse();
      this._sendAck(res);
      if (this.pendingCancel) { this._sendBye(); this._end('Cancelled'); return; }
      if (res.body) this._applyRemoteSdp(res.body);
      this.media.start();
      this.connectedAt = Date.now();
      this._setState('connected');
      return;
    }
    if ((s === 401 || s === 407) && (this.authTries || 0) < 2 && !this.pendingCancel) {
      const ch = pickChallenge(res);
      if (ch) {
        return this._sendInvite({
          name: s === 407 ? 'Proxy-Authorization' : 'Authorization',
          value: buildAuthorization({ challenge: ch, method: 'INVITE', uri: this.remoteUri, username: this.ua.authUser, password: this.ua.account.password || '' })
        });
      }
    }
    const reasons = { 404: 'Number not found', 480: 'Unavailable', 486: 'Busy', 600: 'Busy', 603: 'Declined', 487: 'Cancelled', 408: 'No answer', 403: 'Not allowed', 484: 'Incomplete number', 503: 'Service unavailable' };
    this._end(this.pendingCancel ? 'Cancelled' : (res.timedOut ? 'No response from the PBX' : (reasons[s] || `${s} ${res.reason}`)));
  }

  _sendAck(res) {
    const ack = this._baseRequest('ACK');
    const cs = res.cseq.seq;
    ack.set('CSeq', `${cs} ACK`);
    ack.set('Contact', this.ua.contactHeader());
    this.ua.sendRequest(ack, null);
  }

  _sendCancel() {
    const tx = this.inviteTx;
    if (!tx || this.cancelSent) return;
    this.cancelSent = true;
    const inv = tx.req;
    const c = SipMessage.request('CANCEL', inv.uri);
    for (const r of inv.getAll('route')) c.add('route', r);
    c.set('From', inv.get('from'));
    c.set('To', inv.get('to'));
    c.set('Call-ID', inv.callId);
    c.set('CSeq', `${inv.cseq.seq} CANCEL`);
    this.ua.sendRequest(c, () => {}, { branch: tx.branch });
    setTimeout(() => this._end('Cancelled'), 4000); // in case 487 never arrives
  }

  _sendBye() {
    const bye = this._baseRequest('BYE');
    bye.set('CSeq', `${++this.localCseq} BYE`);
    let tries = 0;
    const send = (auth) => {
      if (auth) bye.set(auth.name, auth.value);
      this.ua.sendRequest(bye, (res) => {
        if ((res.status === 401 || res.status === 407) && tries++ < 1) {
          const ch = pickChallenge(res);
          if (ch) {
            bye.set('CSeq', `${++this.localCseq} BYE`);
            send({ name: res.status === 407 ? 'Proxy-Authorization' : 'Authorization', value: buildAuthorization({ challenge: ch, method: 'BYE', uri: bye.uri, username: this.ua.authUser, password: this.ua.account.password || '' }) });
          }
        }
      });
    };
    send(null);
  }

  // ---------------- incoming
  async _prepareIncoming() {
    await this._newMedia();
    this.ua.reply(this.invite, this.inviteRinfo, 180, 'Ringing', { toTag: this.localTag, contact: true });
    return this.state === 'incoming';
  }

  answer() {
    if (this.direction !== 'in' || this.state !== 'incoming') return;
    const offer = parseSdp(this.invite.body);
    if (offer && !offer.codec) { this.reject(488, 'Not Acceptable Here'); return; }
    if (offer) this._applyRemoteSdp(this.invite.body);
    const sdp = this._localSdp(offer || undefined);
    if (!offer) this.awaitAckSdp = true;
    const str = this.ua.reply(this.invite, this.inviteRinfo, 200, 'OK', {
      toTag: this.localTag, contact: true, body: sdp,
      headers: { 'Content-Type': 'application/sdp', Allow: ALLOW, Supported: 'replaces' }
    });
    // Retransmit 200 OK until ACK (RFC 3261 timer G/H)
    let iv = T1, elapsed = 0;
    const re = () => {
      if (this.acked || this.state === 'ended') return;
      elapsed += iv;
      if (elapsed >= TIMEOUT) { this._sendBye(); this._end('No ACK from the PBX'); return; }
      this.ua._sendRaw(str, this.inviteRinfo.address, this.inviteRinfo.port);
      iv = Math.min(iv * 2, T2);
      this.okTimer = setTimeout(re, iv);
    };
    this.okTimer = setTimeout(re, iv);
    this.media.start();
    this.connectedAt = Date.now();
    this._setState('connected');
  }

  reject(code = 486, reason = 'Busy Here') {
    if (this.direction !== 'in' || this.state !== 'incoming') return;
    this.ua.reply(this.invite, this.inviteRinfo, code, reason, { toTag: this.localTag });
    this._end(code === 486 ? 'Declined' : reason);
  }

  _onAck(req) {
    this.acked = true;
    clearTimeout(this.okTimer);
    if (this.awaitAckSdp && req.body) { this.awaitAckSdp = false; this._applyRemoteSdp(req.body); }
    if (this.reinviteOk) { clearTimeout(this.reinviteOk); this.reinviteOk = null; if (req.body) this._applyRemoteSdp(req.body); }
  }

  _onCancel(req, rinfo) {
    this.ua.reply(req, rinfo, 200, 'OK');
    if (this.direction === 'in' && this.state === 'incoming') {
      this.ua.reply(this.invite, this.inviteRinfo, 487, 'Request Terminated', { toTag: this.localTag });
      this._end('Missed call');
    }
  }

  // ---------------- in-dialog requests
  _onRequest(req, rinfo) {
    if (req.cseq.seq) this.remoteCseq = Math.max(this.remoteCseq, req.cseq.seq);
    switch (req.method) {
      case 'BYE':
        this.ua.reply(req, rinfo, 200, 'OK');
        this._end('Call ended by other party');
        return;
      case 'INVITE':
      case 'UPDATE': {
        const hasSdp = !!req.body && /sdp/i.test(req.get('content-type') || 'application/sdp');
        if (hasSdp) this._applyRemoteSdp(req.body);
        const body = this._localSdp(hasSdp ? parseSdp(req.body) : undefined);
        const str = this.ua.reply(req, rinfo, 200, 'OK', { contact: true, body, headers: { 'Content-Type': 'application/sdp', Allow: ALLOW } });
        if (req.method === 'INVITE') {
          let iv = T1;
          const re = () => { if (!this.reinviteOk) return; this.ua._sendRaw(str, rinfo.address, rinfo.port); iv = Math.min(iv * 2, T2); this.reinviteOk = setTimeout(re, iv); };
          this.reinviteOk = setTimeout(re, iv);
          setTimeout(() => { clearTimeout(this.reinviteOk); this.reinviteOk = null; }, TIMEOUT);
        }
        this.emit('state', this.state, {});
        return;
      }
      case 'INFO': {
        this.ua.reply(req, rinfo, 200, 'OK');
        return;
      }
      default:
        this.ua.reply(req, rinfo, 200, 'OK');
    }
  }

  // ---------------- controls
  hangup() {
    switch (this.state) {
      case 'calling': case 'ringing': case 'early':
        this.pendingCancel = true;
        if (this.inviteTx && this.inviteTx.provisional) this._sendCancel();
        else setTimeout(() => this._end('Cancelled'), 6000);
        this._setState(this.state, { cancelling: true });
        break;
      case 'incoming':
        this.reject(486, 'Busy Here');
        break;
      case 'connected':
        this._sendBye();
        this._end('Call ended');
        break;
    }
  }

  sendDtmf(digit) {
    if (this.state !== 'connected' || !this.media) return;
    if (this.media.sendDtmf(digit)) return;
    const info = this._baseRequest('INFO');
    info.set('CSeq', `${++this.localCseq} INFO`);
    info.set('Content-Type', 'application/dtmf-relay');
    info.body = `Signal=${digit}\r\nDuration=160\r\n`;
    this.ua.sendRequest(info, () => {});
  }

  setHold(hold) {
    if (this.state !== 'connected' || this.onHold === hold || this.reinvitePending) return;
    this.onHold = hold;
    this.reinvitePending = true;
    const send = (auth, tries) => {
      const req = this._baseRequest('INVITE');
      req.set('CSeq', `${++this.localCseq} INVITE`);
      req.set('Contact', this.ua.contactHeader());
      req.set('Content-Type', 'application/sdp');
      if (auth) req.set(auth.name, auth.value);
      req.body = this._localSdp();
      const tx = this.ua.sendRequest(req, (res) => tx.reinvite(res));
      tx.reinvite = (res) => {
        if (res.status < 200) return;
        if (res.status < 300) {
          this._sendAck(res);
          if (res.body) this._applyRemoteSdp(res.body);
          this.reinvitePending = false;
          this._setState('connected');
          return;
        }
        if ((res.status === 401 || res.status === 407) && tries < 1) {
          const ch = pickChallenge(res);
          if (ch) return send({ name: res.status === 407 ? 'Proxy-Authorization' : 'Authorization', value: buildAuthorization({ challenge: ch, method: 'INVITE', uri: req.uri, username: this.ua.authUser, password: this.ua.account.password || '' }) }, tries + 1);
        }
        this.reinvitePending = false;
        this.onHold = !hold; // revert
        if (res.status === 491) setTimeout(() => this.setHold(hold), 1500);
        this._setState('connected');
      };
    };
    send(null, 0);
  }

  _end(reason) {
    if (this.state === 'ended') return;
    this.endReason = reason;
    clearTimeout(this.okTimer);
    clearTimeout(this.reinviteOk);
    if (this.media) this.media.stop();
    this.state = 'ended';
    this.ua.calls.delete(this.callId);
    this.emit('state', 'ended', { reason });
    this.emit('ended', reason);
  }
}

module.exports = { SipUA, Call, splitHostPort };
