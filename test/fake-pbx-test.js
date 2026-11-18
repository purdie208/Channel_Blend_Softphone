'use strict';
// End-to-end test: engine <-> fake Asterisk/FreePBX over real UDP on localhost.
// Run: node test/fake-pbx-test.js
const dgram = require('dgram');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { SipMessage, parseAuthHeader, parseNameAddr, parseUri } = require('../src/main/sip/message');
const { parseSdp } = require('../src/main/sip/sdp');
const { SettingsStore } = require('../src/main/config/settings');
const { Recorder } = require('../src/main/recording/recorder');
const { PhoneEngine } = require('../src/main/engine');
const { exportProvisioning, importProvisioning } = require('../src/main/config/provisioning');

const md5 = s => crypto.createHash('md5').update(s).digest('hex');
const PBX_PORT = 15060, RTP_PORT = 20000;
const USER = '1001', AUTH = 'auth1001', PASS = 's3cret!';
const log = [];
const results = { registered: false, inviteAuthed: false, audioRx: 0, dtmf: new Set(), bye: false, incomingAnswered: false, rtpFromClient: 0 };

const pbx = dgram.createSocket('udp4');
const rtp = dgram.createSocket('udp4');
let clientAddr = null, clientRtp = null, rtpTimer = null, currentDialog = null;

function respond(req, rinfo, status, reason, extra = {}, body = '') {
  const r = SipMessage.response(status, reason);
  for (const v of req.getAll('via')) r.add('via', v.replace(/;rport(?=;|$)/, `;rport=${rinfo.port};received=${rinfo.address}`));
  r.set('From', req.get('from'));
  let to = req.get('to'); if (extra.toTag && !/tag=/.test(to)) to += ';tag=' + extra.toTag; r.set('To', to);
  r.set('Call-ID', req.callId); r.set('CSeq', req.get('cseq'));
  for (const [k, v] of Object.entries(extra.headers || {})) r.set(k, v);
  r.body = body;
  pbx.send(r.toString(), rinfo.port, rinfo.address);
}

function checkAuth(req, method) {
  const h = req.get('authorization');
  if (!h) return false;
  const a = parseAuthHeader(h).params;
  assert.strictEqual(a.username, AUTH, 'auth username must be the authorization user');
  const ha1 = md5(`${a.username}:${a.realm}:${PASS}`), ha2 = md5(`${method}:${a.uri}`);
  const exp = md5(`${ha1}:${a.nonce}:${a.nc}:${a.cnonce}:${a.qop}:${ha2}`);
  return exp === a.response;
}
const challenge = { 'WWW-Authenticate': `Digest realm="asterisk",nonce="${crypto.randomBytes(8).toString('hex')}",qop="auth",algorithm=MD5` };

function serverSdp() {
  return `v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=Asterisk\r\nc=IN IP4 127.0.0.1\r\nt=0 0\r\nm=audio ${RTP_PORT} RTP/AVP 0 101\r\na=rtpmap:0 PCMU/8000\r\na=rtpmap:101 telephone-event/8000\r\na=fmtp:101 0-16\r\na=ptime:20\r\na=sendrecv\r\n`;
}

function startRtp() {
  let seq = 1, ts = 0;
  rtpTimer = setInterval(() => {
    if (!clientRtp) return;
    const h = Buffer.alloc(12); h[0] = 0x80; h[1] = 0; h.writeUInt16BE(seq++ & 0xffff, 2); h.writeUInt32BE(ts, 4); h.writeUInt32BE(0x1234, 8);
    const p = Buffer.alloc(160); for (let i = 0; i < 160; i++) p[i] = i % 2 ? 0x10 : 0x90; // loud-ish pattern
    ts += 160;
    rtp.send(Buffer.concat([h, p]), clientRtp.port, clientRtp.ip);
  }, 20);
}

rtp.on('message', (m) => {
  const pt = m[1] & 0x7f;
  results.rtpFromClient++;
  if (pt === 101) results.dtmf.add(m[12]);
});

pbx.on('message', (buf, rinfo) => {
  const msg = SipMessage.parse(buf);
  if (!msg) return;
  log.push('<< ' + (msg.isRequest ? msg.method : msg.status));
  if (!msg.isRequest) {
    if (msg.cseq.method === 'INVITE' && msg.status === 200) {
      results.incomingAnswered = true;
      const sdp = parseSdp(msg.body); clientRtp = { ip: '127.0.0.1', port: sdp.port };
      // ACK it
      const ack = SipMessage.request('ACK', parseNameAddr(msg.get('contact')).uri);
      ack.add('via', `SIP/2.0/UDP 127.0.0.1:${PBX_PORT};branch=z9hG4bKack${Date.now()}`);
      ack.set('From', msg.get('from')); ack.set('To', msg.get('to')); ack.set('Call-ID', msg.callId); ack.set('CSeq', `${msg.cseq.seq} ACK`);
      pbx.send(ack.toString(), rinfo.port, rinfo.address);
      currentDialog = { callId: msg.callId, from: msg.get('from'), to: msg.get('to'), contact: parseNameAddr(msg.get('contact')).uri, rinfo, server: true };
    }
    return;
  }
  clientAddr = rinfo;
  switch (msg.method) {
    case 'REGISTER':
      if (!checkAuth(msg, 'REGISTER')) return respond(msg, rinfo, 401, 'Unauthorized', { headers: challenge });
      results.registered = true;
      results.contact = msg.get('contact');
      return respond(msg, rinfo, 200, 'OK', { toTag: 'reg', headers: { Contact: msg.get('contact') + ';expires=' + msg.get('expires'), Expires: msg.get('expires') } });
    case 'INVITE': {
      if (!checkAuth(msg, 'INVITE')) return respond(msg, rinfo, 401, 'Unauthorized', { toTag: 'x', headers: challenge });
      results.inviteAuthed = true;
      assert.ok(/^sip:\*?\d+@/.test(msg.uri) || /%23/.test(msg.uri), 'request uri ' + msg.uri);
      const sdp = parseSdp(msg.body);
      clientRtp = { ip: sdp.ip, port: sdp.port };
      respond(msg, rinfo, 100, 'Trying');
      respond(msg, rinfo, 180, 'Ringing', { toTag: 'srv1', headers: { Contact: `<sip:pbx@127.0.0.1:${PBX_PORT}>` } });
      setTimeout(() => {
        respond(msg, rinfo, 200, 'OK', { toTag: 'srv1', headers: { Contact: `<sip:pbx@127.0.0.1:${PBX_PORT}>`, 'Record-Route': `<sip:127.0.0.1:${PBX_PORT};lr>`, 'Content-Type': 'application/sdp' } }, serverSdp());
        startRtp();
      }, 300);
      return;
    }
    case 'ACK': return;
    case 'BYE':
      results.bye = true; results.byeRoute = msg.get('route');
      clearInterval(rtpTimer);
      return respond(msg, rinfo, 200, 'OK');
    default:
      return respond(msg, rinfo, 200, 'OK');
  }
});

function sendIncomingInvite() {
  const c = parseNameAddr(results.contact).uri;
  const inv = SipMessage.request('INVITE', c);
  inv.add('via', `SIP/2.0/UDP 127.0.0.1:${PBX_PORT};branch=z9hG4bKinv${Date.now()};rport`);
  inv.set('From', `"QA Queue" <sip:5551234@127.0.0.1>;tag=pbxin`);
  inv.set('To', `<sip:${USER}@127.0.0.1>`);
  inv.set('Call-ID', 'incoming-' + Date.now());
  inv.set('CSeq', '102 INVITE');
  inv.set('Contact', `<sip:asterisk@127.0.0.1:${PBX_PORT}>`);
  inv.set('Content-Type', 'application/sdp');
  inv.body = serverSdp();
  const u = parseUri(c);
  pbx.send(inv.toString(), u.port, u.host);
}

function sendServerBye() {
  const d = currentDialog;
  const bye = SipMessage.request('BYE', d.contact);
  bye.add('via', `SIP/2.0/UDP 127.0.0.1:${PBX_PORT};branch=z9hG4bKbye${Date.now()}`);
  bye.set('From', d.from); bye.set('To', d.to); bye.set('Call-ID', d.callId); bye.set('CSeq', '103 BYE');
  const u = parseUri(d.contact);
  pbx.send(bye.toString(), u.port, u.host);
}

const wait = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  await new Promise(r => pbx.bind(PBX_PORT, '127.0.0.1', r));
  await new Promise(r => rtp.bind(RTP_PORT, '127.0.0.1', r));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cbtest-'));
  const store = new SettingsStore({ dir, desktopDir: dir, secure: { encrypt: s => ({ enc: 'plain', data: s }), decrypt: p => p.data } });
  store.setLine(0, { username: USER, authUsername: AUTH, password: PASS, domain: `127.0.0.1:${PBX_PORT}`, displayName: 'Test Agent' });
  store.update({ calls: { autoRecord: true, autoMute: true }, network: { rtpPortMin: 30000, rtpPortMax: 30100 } });
  const recorder = new Recorder({ journalPath: path.join(dir, 'journal.json') });
  const engine = new PhoneEngine({ store, recorder, dataDir: dir });
  const frames = { n: 0 };
  engine.on('audio-frame', () => frames.n++);
  const toasts = []; engine.on('toast', t => toasts.push(t));
  const ended = []; engine.on('call-ended', e => ended.push(e));
  engine.start();
  await wait(800);
  let snap = engine.snapshot();
  assert.strictEqual(snap.lines[0].status, 'registered', 'line should register: ' + snap.lines[0].statusText);
  assert.ok(!JSON.stringify(snap).includes(PASS), 'password must never be sent to UI');
  console.log('✓ registered with digest auth (separate authorization user)');

  // Outgoing call (dial *555#1 style feature code)
  const r = await engine.dial('*5551001');
  assert.ok(r.ok, r.error);
  await wait(900);
  snap = engine.snapshot();
  assert.strictEqual(snap.call.state, 'connected');
  assert.strictEqual(snap.call.muted, true, 'auto-mute');
  assert.strictEqual(snap.call.recording.active, true, 'auto-record');
  console.log('✓ outgoing call connected (INVITE auth), auto-muted, auto-recording');
  for (const d of '12#') { engine.dtmf(d); await wait(350); }
  await wait(500);
  assert.ok(frames.n > 40, 'remote audio frames played: ' + frames.n);
  assert.ok(results.dtmf.has(1) && results.dtmf.has(2) && results.dtmf.has(11), 'RFC2833 DTMF received by PBX');
  assert.ok(results.rtpFromClient > 50, 'client sends RTP even with no mic');
  console.log(`✓ audio rx ${frames.n} frames, client sent ${results.rtpFromClient} RTP pkts with no mic, DTMF via RFC2833`);
  engine.hangup();
  await wait(400);
  assert.ok(results.bye, 'BYE sent'); assert.ok(results.byeRoute, 'BYE carries Route from Record-Route');
  snap = engine.snapshot();
  assert.strictEqual(snap.call, null);
  const e1 = ended[0];
  assert.ok(e1 && e1.connected && e1.number === '*5551001' && e1.duration >= 1 && !e1.missed, 'call-ended info ' + JSON.stringify(e1));
  const wav = { path: e1.recording && e1.recording.wavPath };
  assert.ok(wav.path && fs.existsSync(wav.path), 'wav saved');
  const sz = fs.statSync(wav.path).size;
  assert.ok(sz > 44 + 8000, 'wav has audio ' + sz);
  assert.ok(!fs.readdirSync(path.dirname(wav.path)).some(f => f.endsWith('.mka')), 'mka removed after conversion');
  console.log('✓ hangup BYE, recording converted to', path.basename(wav.path), sz, 'bytes');

  // Incoming call
  store.update({ calls: { autoRecord: false, autoMute: false } });
  let incoming = null; engine.once('incoming', i => incoming = i);
  sendIncomingInvite();
  await wait(300);
  assert.ok(incoming && incoming.number === '5551234' && incoming.name === 'QA Queue', 'incoming caller id');
  engine.answer();
  await wait(400);
  assert.ok(results.incomingAnswered, 'incoming answered with 200');
  assert.strictEqual(engine.snapshot().call.state, 'connected');
  sendServerBye();
  await wait(300);
  assert.strictEqual(engine.snapshot().call, null, 'remote BYE ends call');
  assert.ok(ended[1] && ended[1].connected && ended[1].name === 'QA Queue' && ended[1].reason === 'Call ended by other party', 'remote hangup reported');
  console.log('✓ incoming call answered, remote BYE handled → call-ended event for sound/notification');
  assert.strictEqual(engine.snapshot().recents.length, 2);

  // Provisioning round-trip
  const file = exportProvisioning({ account: store.account(0), prefs: { autoRecord: true } });
  assert.ok(!file.includes(PASS), 'password not readable in export file');
  const back = importProvisioning(file);
  assert.strictEqual(back.account.password, PASS);
  const pinned = exportProvisioning({ account: store.account(0), pin: '4321' });
  assert.throws(() => importProvisioning(pinned), /PIN/);
  assert.throws(() => importProvisioning(pinned, '0000'), /Wrong PIN/);
  assert.strictEqual(importProvisioning(pinned, '4321').account.username, USER);
  console.log('✓ provisioning export/import (with and without PIN)');

  await engine.shutdown();
  console.log('\nALL TESTS PASSED');
  process.exit(0);
})().catch(e => { console.error('FAILED:', e && e.stack || e); console.error(log.join('\n')); process.exit(1); });
