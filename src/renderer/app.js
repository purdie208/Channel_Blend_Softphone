'use strict';
/* global cb, callAudio, icon, hydrateIcons */

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let S = null;              // latest state snapshot from main
let view = 'phone';
let editLine = 0;           // line shown in settings
let lineFormDirty = false;
let unlocked = { 0: false, 1: false };
let dtmfSent = '';
let lastCallId = null;
let tick = null;
let devices = { speakers: [], mics: [] };
let appInfo = {};

document.body.classList.toggle('mac', cb.platform === 'darwin');
hydrateIcons();

// ---------------------------------------------------------------- keypad
const KEYS = [['1', ''], ['2', 'ABC'], ['3', 'DEF'], ['4', 'GHI'], ['5', 'JKL'], ['6', 'MNO'], ['7', 'PQRS'], ['8', 'TUV'], ['9', 'WXYZ'], ['*', ''], ['0', '+'], ['#', '']];
$('#keypad').innerHTML = KEYS.map(([k, l]) => `<button class="key" data-key="${k}"><b>${k}</b><small>${l}</small></button>`).join('');
$$('#keypad .key').forEach(b => {
  b.addEventListener('mousedown', e => { e.preventDefault(); pressKey(b.dataset.key); });
});

function inCall() { return S && S.call && S.call.state !== 'ended'; }
function callConnected() { return inCall() && S.call.state === 'connected'; }

function flashKey(k) {
  const el = $(`#keypad .key[data-key="${CSS.escape(k)}"]`);
  if (!el) return;
  el.classList.add('pressed');
  setTimeout(() => el.classList.remove('pressed'), 120);
}

function pressKey(k) {
  flashKey(k);
  if (S && S.settings.calls.dtmfTones !== false) callAudio.dtmf(k);
  if (inCall()) {
    if (callConnected()) { cb.dtmf(k); dtmfSent = (dtmfSent + k).slice(-24); $('#dtmf-sent').textContent = dtmfSent; }
    return;
  }
  const inp = $('#number');
  const start = inp.selectionStart ?? inp.value.length, end = inp.selectionEnd ?? inp.value.length;
  if (document.activeElement === inp) { inp.setRangeText(k, start, end, 'end'); }
  else inp.value += k;
  updateIdle();
}

function backspace() {
  const inp = $('#number');
  if (document.activeElement === inp && inp.selectionStart !== inp.selectionEnd) inp.setRangeText('', inp.selectionStart, inp.selectionEnd, 'end');
  else inp.value = inp.value.slice(0, -1);
  updateIdle();
}

$('#backspace').addEventListener('click', backspace);
$('#number').addEventListener('input', () => {
  const inp = $('#number');
  const clean = inp.value.replace(/[^0-9*#+a-zA-Z@._-]/g, '');
  if (clean !== inp.value) inp.value = clean;
  updateIdle();
});

async function dial() {
  const num = $('#number').value.trim();
  if (!num) {
    // Like a desk phone: Call with an empty display redials the last number.
    const last = S && S.recents.find(r => r.direction === 'out');
    if (last) { $('#number').value = last.number; updateIdle(); }
    return;
  }
  await callAudio.init();
  const r = await cb.dial(num);
  if (r && !r.ok) toast({ type: 'error', title: 'Could not place call', text: r.error });
}

// ---------------------------------------------------------------- keyboard
document.addEventListener('keydown', (e) => {
  if (!$('#modal-wrap').classList.contains('hidden')) { if (e.key === 'Escape' && !updBusy) closeModal(); return; }
  if (S && S.call && S.call.state === 'incoming') {
    if (e.key === 'Enter') { e.preventDefault(); cb.answer(); }
    if (e.key === 'Escape') { e.preventDefault(); cb.reject(); }
    return;
  }
  const t = e.target;
  const typingElsewhere = (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA') && t.id !== 'number';
  if (typingElsewhere || view !== 'phone' || e.ctrlKey || e.metaKey || e.altKey) return;
  const k = e.key;
  if (/^[0-9*#]$/.test(k)) {
    e.preventDefault();
    if (!e.repeat) pressKey(k);
  } else if (k === 'Backspace' && !inCall()) {
    if (t.id !== 'number') { e.preventDefault(); backspace(); }
  } else if (k === 'Enter') {
    e.preventDefault();
    if (!inCall()) dial();
  } else if (k === 'Escape' && !inCall()) {
    $('#number').value = ''; updateIdle();
  } else if (k === '+' && !inCall()) {
    e.preventDefault(); pressKey('+');
  }
});

// ---------------------------------------------------------------- call controls
$('#btn-call').addEventListener('click', () => { if (inCall()) cb.hangup(); else dial(); });
$('#btn-mute').addEventListener('click', () => { if (inCall()) cb.mute(!S.call.muted); });
$('#btn-rec').addEventListener('click', () => { if (callConnected()) cb.toggleRecording(); });
$('#chip-hold').addEventListener('click', () => { if (callConnected()) cb.hold(!S.call.onHold); });
$('#chip-autorec').addEventListener('click', () => cb.updateSettings({ calls: { autoRecord: !S.settings.calls.autoRecord } }));
$('#chip-automute').addEventListener('click', () => cb.updateSettings({ calls: { autoMute: !S.settings.calls.autoMute } }));
$('#in-answer').addEventListener('click', () => cb.answer());
$('#in-decline').addEventListener('click', () => cb.reject());

// ---------------------------------------------------------------- navigation
function go(v) {
  view = v;
  for (const id of ['phone', 'recents', 'settings']) $('#view-' + id).classList.toggle('hidden', id !== v);
  $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.goto === v));
  if (v === 'settings') { lineFormDirty = false; renderSettings(true); refreshDevices(); }
  if (v === 'phone' && !inCall()) setTimeout(() => $('#number').focus(), 0);
}
document.addEventListener('click', (e) => {
  const g = e.target.closest('[data-goto]'); if (g) go(g.dataset.goto);
  const a = e.target.closest('[data-action="import"]'); if (a) startImport(view === 'settings' ? editLine : null);
  const pop = $('#devices-pop');
  if (!pop.classList.contains('hidden') && !e.target.closest('#devices-pop') && !e.target.closest('#devices-btn')) pop.classList.add('hidden');
});

// ---------------------------------------------------------------- rendering
function initials(name, number) {
  const n = (name || '').trim();
  if (n) return n.split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase();
  return (number || '?').replace(/[^\dA-Za-z]/g, '').slice(-2) || '#';
}
function fmtDur(sec) { sec = Math.max(0, Math.floor(sec)); const m = Math.floor(sec / 60), s = sec % 60; const h = Math.floor(m / 60); return h ? `${h}:${String(m % 60).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`; }

function render() {
  if (!S) return;
  renderLines();
  renderMonitor();
  renderPhone();
  renderRecents();
  if (view === 'settings') renderSettings(false);
  renderIncoming();
  syncAudio();
}

// ---------------------------------------------------------------- monitoring name
let monitorSaveTimer = null;
function renderMonitor() {
  const m = S.settings.monitor || { name: '', recent: [], showField: true };
  document.body.classList.toggle('no-monitor', m.showField === false);
  const inp = $('#monitor-name');
  if (document.activeElement !== inp && inp.value !== (m.name || '')) inp.value = m.name || '';
  $('#monitor-list').innerHTML = (m.recent || []).map(n => `<option value="${esc(n)}"></option>`).join('');
  const has = !!inp.value.trim();
  $('#monitor-row').classList.toggle('set', has);
  $('#monitor-clear').classList.toggle('hidden', !has);
  updateMonitorHint();
}
async function updateMonitorHint() {
  const name = $('#monitor-name').value.trim();
  const c = S && S.call;
  const hint = $('#monitor-hint');
  const rec = c && c.recording && c.recording.active ? c.recording : null;
  if (rec && rec.unnamed && !name) { hint.innerHTML = `Recording · <b>type a name above</b> to save it under that person`; return; }
  if (rec && !(rec.unnamed && name)) { hint.innerHTML = `Recording to <b>${esc(rec.file)}</b>`; return; }
  if (!name) {
    hint.textContent = S.lastUnnamedRecording ? 'Forgot the name? Type it here to name your last recording' : 'Recordings use the phone number unless you enter a name';
    return;
  }
  const r = await cb.nextRecordingName(name);
  if (!r || !r.name || $('#monitor-name').value.trim() !== name) return;
  if (rec) hint.innerHTML = `Recording · will be saved as <b>${esc(r.name)}.wav</b>`;
  else if (S.lastUnnamedRecording) hint.innerHTML = `Press Enter to name your last recording <b>${esc(r.name)}.wav</b>`;
  else hint.innerHTML = `Next recording: <b>${esc(r.name)}.wav</b>`;
}
function saveMonitor() {
  clearTimeout(monitorSaveTimer);
  monitorSaveTimer = setTimeout(() => cb.updateSettings({ monitor: { name: $('#monitor-name').value.trim() } }), 400);
}
$('#monitor-name').addEventListener('input', () => {
  const has = !!$('#monitor-name').value.trim();
  $('#monitor-row').classList.toggle('set', has);
  $('#monitor-clear').classList.toggle('hidden', !has);
  saveMonitor(); updateMonitorHint();
});
$('#monitor-name').addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); $('#monitor-name').blur(); $('#number').focus(); } });
$('#monitor-name').addEventListener('blur', async () => {
  const name = $('#monitor-name').value.replace(/\s+/g, ' ').trim();
  $('#monitor-name').value = name;
  clearTimeout(monitorSaveTimer);
  await cb.updateSettings({ monitor: { name } });
  // Name entered after an unnamed recording finished -> that recording gets the name.
  if (name && S && S.lastUnnamedRecording) cb.commitMonitorName(name);
});
$('#monitor-clear').addEventListener('click', () => { $('#monitor-name').value = ''; $('#monitor-name').dispatchEvent(new Event('input')); $('#monitor-name').focus(); });

function renderLines() {
  $('#lines').innerHTML = S.lines.map(l => {
    const usable = l.enabled && l.configured;
    const sub = usable ? (l.status === 'registered' ? `Ext ${esc(l.username)}` : esc(l.statusText)) : (l.enabled ? 'Not set up' : 'Off');
    return `<button class="line-pill ${S.activeLine === l.index ? 'active' : ''}" data-line="${l.index}" title="${esc(l.statusText)}">
      <span class="dot ${usable ? l.status : ''}"></span>
      <span class="meta"><span class="name">${esc(l.label)}</span><span class="sub">${sub}</span></span></button>`;
  }).join('');
  $$('#lines .line-pill').forEach(b => b.addEventListener('click', () => {
    const i = +b.dataset.line, l = S.lines[i];
    if (!l.configured) { editLine = i; go('settings'); return; }
    cb.setActiveLine(i);
  }));
}

let endedNote = null; // { text, until }
function updateIdle() {
  if (!S) return;
  const l = S.lines[S.activeLine];
  const sl = $('#status-line');
  sl.classList.remove('error');
  if (endedNote && Date.now() < endedNote.until && !inCall()) { sl.textContent = endedNote.text; sl.classList.toggle('error', endedNote.alert); }
  else if (!l.configured) sl.textContent = `${l.label} isn't set up yet`;
  else if (!l.enabled) sl.textContent = `${l.label} is turned off`;
  else if (l.status === 'registered') sl.textContent = `${l.displayName ? l.displayName + ' · ' : ''}Ready on ext ${l.username}`;
  else { sl.textContent = l.statusText; if (l.status === 'failed') sl.classList.add('error'); }
  $('#btn-call').disabled = !inCall() && !(l.enabled && l.configured);
}

function renderPhone() {
  const c = S.call;
  const anyConfigured = S.lines.some(l => l.configured);
  $('#welcome').classList.toggle('hidden', anyConfigured || !!c);
  document.body.classList.toggle('first-run', !anyConfigured && !c);
  $('#idle-display').classList.toggle('hidden', !anyConfigured || !!c);
  $('#call-display').classList.toggle('hidden', !c);

  const callBtn = $('#btn-call');
  callBtn.classList.toggle('hangup', !!c);
  callBtn.title = c ? 'Hang up' : 'Call (Enter)';

  if (c) {
    if (c.id !== lastCallId) { lastCallId = c.id; dtmfSent = ''; $('#dtmf-sent').textContent = ''; }
    $('#call-avatar').textContent = initials(c.name, c.number);
    $('#call-who').textContent = c.name || c.number;
    const mon = S.settings.monitor && S.settings.monitor.showField !== false ? (S.settings.monitor.name || '') : '';
    $('#call-num').textContent = (mon ? `Monitoring ${mon} · ` : '') + (c.name ? c.number : (c.direction === 'in' ? 'Incoming call' : `via ${S.lines[c.line].label}`));
    const badges = [];
    if (c.recording.active) badges.push('<span class="badge rec"><i></i>REC</span>');
    if (c.onHold) badges.push('<span class="badge hold">HOLD</span>');
    if (c.muted) badges.push(`<span class="badge muted">${c.micMissing ? 'LISTEN ONLY' : 'MUTED'}</span>`);
    $('#call-badges').innerHTML = badges.join('');
    const m = $('#btn-mute');
    m.innerHTML = icon(c.muted ? 'micoff' : 'mic');
    m.classList.toggle('on', c.muted);
    m.disabled = c.state !== 'connected';
    $('#lbl-mute').textContent = c.muted ? (c.micMissing ? 'No mic' : 'Unmute') : 'Mute';
    const r = $('#btn-rec');
    r.innerHTML = icon(c.recording.active ? 'stop' : 'record');
    r.classList.toggle('rec-on', c.recording.active);
    r.disabled = c.state !== 'connected';
    $('#chip-hold').classList.toggle('hidden', c.state !== 'connected');
    $('#chip-hold').classList.toggle('on', !!c.onHold);
    $('#chip-hold').innerHTML = icon('pause') + (c.onHold ? 'Resume' : 'Hold');
    updateCallTimer();
    if (!tick) tick = setInterval(updateCallTimer, 500);
  } else {
    lastCallId = null;
    clearInterval(tick); tick = null;
    const m = $('#btn-mute'); m.innerHTML = icon('mic'); m.classList.remove('on'); m.disabled = true; $('#lbl-mute').textContent = 'Mute';
    const r = $('#btn-rec'); r.innerHTML = icon('record'); r.classList.remove('rec-on'); r.disabled = true; $('#lbl-rec').textContent = 'Record';
    $('#chip-hold').classList.add('hidden');
    updateIdle();
  }
  $('#chip-autorec').classList.toggle('on', !!S.settings.calls.autoRecord);
  $('#chip-autorec').classList.toggle('red', !!S.settings.calls.autoRecord);
  $('#chip-automute').classList.toggle('on', !!S.settings.calls.autoMute);
}

function updateCallTimer() {
  const c = S && S.call; if (!c) return;
  const st = { calling: 'Calling…', ringing: 'Ringing…', early: 'Ringing…', incoming: 'Incoming call…' }[c.state];
  const live = c.state === 'connected';
  $('#call-state').classList.toggle('live', live);
  $('#call-state').classList.toggle('held', live && !!c.onHold);
  $('#call-state').textContent = live ? fmtDur((Date.now() - c.connectedAt) / 1000) : (st || '');
  $('#lbl-rec').textContent = c.recording.active ? fmtDur((Date.now() - c.recording.startedAt) / 1000) : 'Record';
}

function renderIncoming() {
  const c = S.call;
  const show = !!c && c.state === 'incoming';
  $('#incoming').classList.toggle('hidden', !show);
  if (!show) return;
  $('#in-avatar').textContent = initials(c.name, c.number);
  $('#in-who').textContent = c.name || c.number;
  $('#in-num').textContent = c.name ? c.number : '';
  $('#in-line').textContent = `Incoming call · ${S.lines[c.line].label}`;
}

const clock = ts => new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
function relTime(ts) {
  const d = new Date(ts), now = new Date();
  const time = clock(ts); // with seconds, so QA knows exactly when a session started
  if (d.toDateString() === now.toDateString()) return time;
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return 'Yesterday ' + time;
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + time;
}

function renderRecents() {
  const list = S.recents || [];
  $('#recents').innerHTML = list.length ? list.map((r, i) => `
    <div class="recent" data-i="${i}" title="Started ${new Date(r.at).toLocaleDateString()} ${clock(r.at)}${r.connectedAt ? ' · connected ' + clock(r.connectedAt) : ''}\nClick to fill in · double-click to call">
      <div class="dir ${r.missed ? 'missed' : ''}">${icon(r.direction === 'in' ? 'incoming' : 'outgoing')}</div>
      <div class="who"><b>${esc(r.name || r.number)}</b><span>${r.monitored ? 'Monitoring ' + esc(r.monitored) + ' · ' : ''}${r.name ? esc(r.number) + ' · ' : ''}${r.missed ? 'Missed' : r.duration ? fmtDur(r.duration) : esc(r.result || '')}</span></div>
      <div class="when">${relTime(r.at)}<br>${esc((S.lines[r.line] || {}).label || '')}</div>
    </div>`).join('') : '<div class="empty">No calls yet</div>';
  $$('#recents .recent').forEach(el => {
    el.addEventListener('click', () => { if (inCall()) return; $('#number').value = list[+el.dataset.i].number; go('phone'); updateIdle(); });
    el.addEventListener('dblclick', () => { if (inCall()) return; $('#number').value = list[+el.dataset.i].number; go('phone'); dial(); });
  });
}
$('#clear-recents').addEventListener('click', () => cb.clearRecents());

// ---------------------------------------------------------------- settings
function setChecked(id, v) { $(id).checked = !!v; }

function renderSettings(full) {
  const s = S.settings;
  $$('#line-tabs button').forEach(b => { const i = +b.dataset.line; b.classList.toggle('active', i === editLine); b.textContent = S.lines[i].label; });
  const l = S.lines[editLine];
  const dot = $('#ls-dot'); dot.className = 'dot ' + (l.enabled && l.configured ? l.status : '');
  $('#ls-text').textContent = l.enabled ? (l.configured ? l.statusText : 'Not set up yet') : 'Turned off';
  $('#ls-reconnect').classList.toggle('hidden', !(l.enabled && l.configured));
  if (full || !lineFormDirty) {
    $('#f-enabled').checked = l.enabled;
    $('#f-display').value = l.displayName || '';
    $('#f-user').value = l.username || '';
    $('#f-auth').value = l.authUsername || '';
    $('#f-domain').value = l.domain || '';
    $('#f-pass').value = '';
    $('#f-pass').placeholder = l.hasPassword ? '•••••••• saved — type to change' : 'Password';
    $('#line-enabled-hint').textContent = editLine === 0 ? 'Your main extension' : 'Handy for testing another extension without touching Line 1';
    const locked = l.provisioned && !unlocked[editLine];
    $('#prov-banner').classList.toggle('hidden', !l.provisioned);
    $('#prov-unlock').classList.toggle('hidden', !locked);
    for (const id of ['#f-display', '#f-user', '#f-auth', '#f-domain', '#f-pass']) $(id).disabled = locked;
  }
  if (full) {
    setChecked('#s-autorec', s.calls.autoRecord); setChecked('#s-automute', s.calls.autoMute);
    setChecked('#s-clear', s.calls.clearAfterCall); setChecked('#s-tones', s.calls.dtmfTones !== false);
    setChecked('#s-endsound', s.calls.endSound !== false); setChecked('#s-endnotify', s.calls.endNotify !== false);
    setChecked('#s-showmonitor', !s.monitor || s.monitor.showField !== false);
    setChecked('#s-keepmka', s.recording.keepMka);
    $('#a-micvol').value = Math.round(s.audio.micVolume * 100);
    $('#a-ringvol').value = Math.round(s.audio.ringVolume * 100);
    $('#n-sip').value = s.network.sipPort; $('#n-exp').value = s.network.registerExpires;
    $('#n-rtpmin').value = s.network.rtpPortMin; $('#n-rtpmax').value = s.network.rtpPortMax;
    $('#n-ka').value = s.network.keepAliveSec; setChecked('#n-public', s.network.usePublicAddress);
  }
  $('#rec-folder').textContent = s.recording.folder;
  $$('#theme-seg button').forEach(b => b.classList.toggle('active', b.dataset.theme === s.theme));
}

$$('#line-tabs button').forEach(b => b.addEventListener('click', () => { editLine = +b.dataset.line; lineFormDirty = false; renderSettings(true); }));
for (const id of ['#f-display', '#f-user', '#f-auth', '#f-domain', '#f-pass']) $(id).addEventListener('input', () => { lineFormDirty = true; });
$('#f-enabled').addEventListener('change', () => cb.saveLine(editLine, { enabled: $('#f-enabled').checked }));
$('#prov-unlock').addEventListener('click', () => {
  confirmModal('Edit IT settings?', 'These settings were set up by IT. Changing them may stop your phone from working.', 'Edit anyway').then(ok => {
    if (ok) { unlocked[editLine] = true; renderSettings(true); }
  });
});
$('#ls-reconnect').addEventListener('click', () => cb.reconnectLine(editLine));
$('#line-save').addEventListener('click', async () => {
  const fields = {
    enabled: $('#f-enabled').checked || editLine === 0,
    displayName: $('#f-display').value, username: $('#f-user').value, authUsername: $('#f-auth').value, domain: $('#f-domain').value
  };
  if (!fields.username.trim() || !fields.domain.trim()) { toast({ type: 'error', title: 'Missing details', text: 'User name and domain are required.' }); return; }
  if ($('#f-pass').value) fields.password = $('#f-pass').value;
  if (unlocked[editLine]) fields.provisioned = false;
  await cb.saveLine(editLine, fields);
  if (editLine !== S.activeLine && !S.lines[S.activeLine].configured) cb.setActiveLine(editLine);
  lineFormDirty = false; unlocked[editLine] = false;
  toast({ type: 'success', title: 'Saved', text: `Connecting ${S.lines[editLine].label}…` });
});
$('#line-clear').addEventListener('click', async () => {
  if (await confirmModal('Remove settings?', `This removes the user name, password and domain from ${S.lines[editLine].label}.`, 'Remove', true)) {
    await cb.clearLine(editLine); lineFormDirty = false; renderSettings(true);
  }
});
$('#line-export').addEventListener('click', () => exportFlow(editLine));

const bindToggle = (id, fn) => $(id).addEventListener('change', e => cb.updateSettings(fn(e.target.checked)));
bindToggle('#s-autorec', v => ({ calls: { autoRecord: v } }));
bindToggle('#s-automute', v => ({ calls: { autoMute: v } }));
bindToggle('#s-clear', v => ({ calls: { clearAfterCall: v } }));
bindToggle('#s-tones', v => ({ calls: { dtmfTones: v } }));
bindToggle('#s-endsound', v => { if (v) callAudio.endTone(); return { calls: { endSound: v } }; });
bindToggle('#s-endnotify', v => ({ calls: { endNotify: v } }));
bindToggle('#s-showmonitor', v => ({ monitor: { showField: v } }));
bindToggle('#s-keepmka', v => ({ recording: { keepMka: v } }));
$('#rec-change').addEventListener('click', () => cb.chooseRecordingFolder());
$('#rec-open').addEventListener('click', () => cb.openRecordingFolder());
$$('#theme-seg button').forEach(b => b.addEventListener('click', () => cb.updateSettings({ theme: b.dataset.theme })));
$('#a-micvol').addEventListener('input', e => { const v = e.target.value / 100; callAudio.setMicVolume(v); });
$('#a-micvol').addEventListener('change', e => cb.updateSettings({ audio: { micVolume: e.target.value / 100 } }));
$('#a-ringvol').addEventListener('change', e => { const v = e.target.value / 100; callAudio.setRingVolume(v); cb.updateSettings({ audio: { ringVolume: v } }); callAudio.startRing().then(() => setTimeout(() => callAudio.stopRing(), 1200)); });
$('#a-test').addEventListener('click', () => callAudio.testSpeaker());
$('#n-save').addEventListener('click', async () => {
  const n = {
    sipPort: +$('#n-sip').value || 0, registerExpires: Math.max(60, +$('#n-exp').value || 3600),
    rtpPortMin: +$('#n-rtpmin').value || 5000, rtpPortMax: +$('#n-rtpmax').value || 36385,
    keepAliveSec: Math.max(10, +$('#n-ka').value || 30), usePublicAddress: $('#n-public').checked
  };
  if (n.rtpPortMax <= n.rtpPortMin) { toast({ type: 'error', title: 'Check the RTP port range' }); return; }
  await cb.updateSettings({ network: n });
  toast({ type: 'success', title: 'Network settings saved', text: 'Lines are reconnecting.' });
});
$('#show-logs').addEventListener('click', () => cb.showLogs());

// ---------------------------------------------------------------- audio devices
async function refreshDevices() {
  try {
    const list = await navigator.mediaDevices.enumerateDevices();
    const label = (d, i, kind) => d.label || `${kind} ${i + 1}`;
    devices.speakers = list.filter(d => d.kind === 'audiooutput' && d.deviceId !== 'communications');
    devices.mics = list.filter(d => d.kind === 'audioinput' && d.deviceId !== 'communications');
    const opts = (arr, kind, sel) => {
      const items = arr.filter(d => d.deviceId !== 'default').map((d, i) => `<option value="${esc(d.deviceId)}" ${d.deviceId === sel ? 'selected' : ''}>${esc(label(d, i, kind))}</option>`);
      return `<option value="default" ${sel === 'default' ? 'selected' : ''}>System default</option>` + items.join('');
    };
    const s = S.settings.audio;
    const micSel = devices.mics.some(d => d.deviceId === s.micId) ? s.micId : 'default';
    const spkSel = devices.speakers.some(d => d.deviceId === s.speakerId) ? s.speakerId : 'default';
    const micHtml = devices.mics.length ? opts(devices.mics, 'Microphone', micSel) : '<option value="default">No microphone found (listen only)</option>';
    $('#a-speaker').innerHTML = $('#q-speaker').innerHTML = opts(devices.speakers, 'Speaker', spkSel);
    $('#a-mic').innerHTML = $('#q-mic').innerHTML = micHtml;
    $('#a-speaker').value = $('#q-speaker').value = spkSel;
    $('#a-mic').value = $('#q-mic').value = micSel;
    if (spkSel !== callAudio.speakerId) callAudio.setSpeaker(spkSel);
    const spk = devices.speakers.find(d => d.deviceId === spkSel);
    $('#devices-btn').title = `Audio devices — ${spk ? spk.label || 'Speaker' : 'System default'}`;
  } catch (e) { console.warn(e); }
}
navigator.mediaDevices.addEventListener('devicechange', () => refreshDevices());

async function chooseSpeaker(id) {
  await callAudio.setSpeaker(id);
  await cb.updateSettings({ audio: { speakerId: id } });
  refreshDevices();
}
async function chooseMic(id) {
  await cb.updateSettings({ audio: { micId: id } });
  if (callAudio.mic) { callAudio.closeMic(); syncAudio(); }
  refreshDevices();
}
for (const id of ['#a-speaker', '#q-speaker']) $(id).addEventListener('change', e => chooseSpeaker(e.target.value));
for (const id of ['#a-mic', '#q-mic']) $(id).addEventListener('change', e => chooseMic(e.target.value));
$('#devices-btn').addEventListener('click', () => { $('#devices-pop').classList.toggle('hidden'); refreshDevices(); });

$('#speaker-vol').addEventListener('input', e => { callAudio.setSpeakerVolume(e.target.value / 100); volIcon(); });
$('#speaker-vol').addEventListener('change', e => cb.updateSettings({ audio: { speakerVolume: e.target.value / 100 } }));
let preMuteVol = 85;
$('#vol-icon').addEventListener('click', () => {
  const r = $('#speaker-vol');
  if (+r.value > 0) { preMuteVol = +r.value; r.value = 0; } else r.value = preMuteVol || 85;
  r.dispatchEvent(new Event('input')); r.dispatchEvent(new Event('change'));
});
function volIcon() { $('#vol-icon').innerHTML = icon(+$('#speaker-vol').value === 0 ? 'volumex' : 'volume'); }

// Mic is opened only when a connected call is unmuted — never required.
let micBusy = false;
async function syncAudio() {
  const c = S.call;
  const want = !!(c && c.wantMic);
  if (want && !callAudio.mic && !micBusy) {
    micBusy = true;
    try {
      const mics = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'audioinput');
      if (!mics.length) throw new Error('No microphone is connected. You can still hear the call.');
      if (!(await cb.requestMicAccess())) throw new Error('Microphone access is blocked for Channel Blend in system settings.');
      await callAudio.openMic(S.settings.audio.micId);
    } catch (e) {
      cb.micUnavailable(e && e.message && !/Permission|NotFound|NotAllowed|Overconstrained|Requested device/i.test(e.name || '') ? e.message : 'No usable microphone. You can still hear the call.');
    }
    micBusy = false;
  } else if (!want && callAudio.mic) {
    callAudio.closeMic();
  }
}
callAudio.onMicFrame = (f) => cb.sendMic(f);

cb.onAudioFrame(f => callAudio.play(f));
cb.onAudioCmd(c => {
  switch (c.cmd) {
    case 'ring-start': callAudio.startRing(); break;
    case 'ring-stop': callAudio.stopRing(); break;
    case 'ringback-start': callAudio.startRingback(); break;
    case 'ringback-stop': callAudio.stopRingback(); break;
    case 'call-ended':
      callAudio.stopRing(); callAudio.stopRingback(); callAudio.closeMic(); callAudio.flush();
      if (S && S.settings.calls.clearAfterCall !== false) { $('#number').value = ''; }
      dtmfSent = '';
      setTimeout(() => { updateIdle(); if (view === 'phone') $('#number').focus(); }, 0);
      break;
  }
});

// ---------------------------------------------------------------- toasts & modals
function toast({ type = 'info', title = '', text = '', path = null }) {
  const el = document.createElement('div');
  el.className = `toast ${type} ${path ? 'click' : ''}`;
  el.innerHTML = `<div class="ic">${icon(type === 'success' ? 'check' : type === 'error' ? 'x' : 'info')}</div><div><b>${esc(title)}</b>${text ? `<span>${esc(text)}${path ? ' — click to show' : ''}</span>` : ''}</div>`;
  if (path) el.addEventListener('click', () => cb.showFile(path));
  $('#toasts').appendChild(el);
  setTimeout(() => { el.style.transition = 'opacity .3s'; el.style.opacity = '0'; setTimeout(() => el.remove(), 300); }, type === 'error' ? 6500 : 4500);
}
cb.onToast(toast);

let modalResolve = null;
function openModal(html) {
  $('#modal').innerHTML = html;
  hydrateIcons($('#modal'));
  $('#modal-wrap').classList.remove('hidden');
  return new Promise(r => { modalResolve = r; });
}
function closeModal(v) { $('#modal-wrap').classList.add('hidden'); const r = modalResolve; modalResolve = null; r && r(v); }
$('#modal-wrap').addEventListener('mousedown', e => { if (e.target.id === 'modal-wrap' && !updBusy) closeModal(); });

function confirmModal(title, text, okLabel = 'OK', danger = false) {
  const p = openModal(`<h3>${esc(title)}</h3><p>${esc(text)}</p><div class="btn-row"><button class="btn ghost" id="m-cancel">Cancel</button><button class="btn ${danger ? '' : 'primary'}" id="m-ok" style="${danger ? 'color:var(--danger)' : ''}">${esc(okLabel)}</button></div>`);
  $('#m-cancel').onclick = () => closeModal(false);
  $('#m-ok').onclick = () => closeModal(true);
  return p;
}

async function exportFlow(i) {
  const l = S.lines[i];
  if (!l.configured) { toast({ type: 'error', title: 'Nothing to export', text: 'Set up this line first.' }); return; }
  const warn = l.status !== 'registered' ? `<div class="banner" style="background:var(--danger-soft)">${icon('info')}<div>This line isn't registered right now. It's best to export once you've confirmed it works.</div></div>` : '';
  const p = openModal(`<h3>Export settings</h3><p>Creates a file for extension <b>${esc(l.username)}</b>. Send it to the employee — they click <b>Import settings file</b> (or double-click the file) and they're done. The password inside is encrypted.</p>
    ${warn}
    ${appInfo.devKey ? `<div class="banner" style="background:var(--danger-soft)">${icon('lock')}<div><b>Test build:</b> this copy has no company key, so the file is only protected by the public test key. Build with your company key before sending files to staff.</div></div>` : ''}
    <label class="check"><input type="checkbox" id="m-prefs" checked> Include auto-record / auto-mute choices</label>
    <div class="field"><label>Optional PIN</label><input class="input" id="m-pin" placeholder="Leave blank for none" maxlength="12"><span class="hint">If set, give the PIN to the employee separately.</span></div>
    <div class="btn-row"><button class="btn ghost" id="m-cancel">Cancel</button><button class="btn primary" id="m-ok">${icon('upload')}Export…</button></div>`);
  $('#m-cancel').onclick = () => closeModal(null);
  $('#m-ok').onclick = () => closeModal({ includePrefs: $('#m-prefs').checked, pin: $('#m-pin').value.trim() });
  const opts = await p;
  if (!opts) return;
  const r = await cb.exportSettings(i, opts);
  if (r && r.ok) toast({ type: 'success', title: 'Settings exported', text: r.path, path: r.path });
  else if (r && !r.canceled) toast({ type: 'error', title: 'Export failed', text: r.error });
}

async function startImport(lineIdx, file) {
  let info = file;
  if (!info) {
    const r = await cb.pickSettingsFile();
    if (!r || !r.ok) { if (r && r.error) toast({ type: 'error', title: 'Could not open file', text: r.error }); return; }
    info = r;
  }
  importModal(info, lineIdx);
}

async function importModal(info, lineIdx, error) {
  const target = lineIdx != null ? lineIdx : (S.lines[0].configured && S.lines[0].username !== info.extension ? null : 0);
  const lineChoice = target == null
    ? `<div class="field"><label>Put it on</label><div class="seg" id="m-line"><button data-l="0" class="active">Line 1 (replace)</button><button data-l="1">Line 2</button></div></div>` : '';
  const p = openModal(`<h3>Import settings</h3><p>Settings for extension <b>${esc(info.extension || '')}</b>${info.createdAt ? ` · created ${esc(new Date(info.createdAt).toLocaleDateString())}` : ''}.</p>
    ${lineChoice}
    ${info.pinProtected ? `<div class="field"><label>PIN from IT</label><input class="input" id="m-pin" maxlength="12" autofocus></div>` : ''}
    ${error ? `<p style="color:var(--danger);margin-top:10px">${esc(error)}</p>` : ''}
    <div class="btn-row"><button class="btn ghost" id="m-cancel">Cancel</button><button class="btn primary" id="m-ok">${icon('download')}Import</button></div>`);
  let chosen = target == null ? 0 : target;
  $$('#m-line button').forEach(b => b.onclick = () => { chosen = +b.dataset.l; $$('#m-line button').forEach(x => x.classList.toggle('active', x === b)); });
  $('#m-cancel').onclick = () => closeModal(null);
  $('#m-ok').onclick = () => closeModal({ line: chosen, pin: $('#m-pin') ? $('#m-pin').value.trim() : '' });
  const pin = $('#m-pin'); if (pin) setTimeout(() => pin.focus(), 50);
  const r = await p;
  if (!r) return;
  const res = await cb.importSettings(info.path, r.line, r.pin);
  if (res && res.ok) {
    toast({ type: 'success', title: 'All set!', text: `Extension ${res.extension} imported. Connecting…` });
    editLine = r.line; lineFormDirty = false;
    go('phone');
  } else importModal(info, lineIdx, res && res.error);
}
cb.onProvFile(info => importModal(info, null));

// ---------------------------------------------------------------- call ended: sound + notice
cb.onCallEnded(info => {
  const calls = (S && S.settings.calls) || {};
  const who = info.name || info.number;
  // Tone for any call that was answered or that we placed; a missed incoming call already stopped ringing.
  if (calls.endSound !== false && !info.missed && (info.connected || info.direction === 'out')) callAudio.endTone();
  const detail = info.missed ? `Missed call from ${who}` : info.connected ? `${who} · ${fmtDur(info.duration)}` : `${who} · ${info.reason}`;
  endedNote = { text: info.missed ? detail : `Call ended — ${detail}`, until: Date.now() + 6000, alert: info.missed || !info.connected };
  updateIdle();
  setTimeout(updateIdle, 6100);
  const rec = info.recording;
  if (calls.endNotify !== false) {
    toast({ type: info.missed || !info.connected ? 'error' : 'info', title: info.missed ? 'Missed call' : 'Call ended',
      text: detail + (rec ? ` · Recording saved: ${rec.file}` : ''), path: rec ? rec.wavPath : null });
  } else if (rec) {
    toast({ type: 'success', title: 'Recording saved', text: rec.file, path: rec.wavPath });
  }
});

// Drag a .cbprov onto the window
let dragDepth = 0;
window.addEventListener('dragenter', e => { e.preventDefault(); if (++dragDepth === 1) $('#drop-hint').classList.remove('hidden'); });
window.addEventListener('dragleave', e => { e.preventDefault(); if (--dragDepth <= 0) { dragDepth = 0; $('#drop-hint').classList.add('hidden'); } });
window.addEventListener('dragover', e => e.preventDefault());
window.addEventListener('drop', async e => {
  e.preventDefault(); dragDepth = 0; $('#drop-hint').classList.add('hidden');
  const f = e.dataTransfer.files[0]; if (!f) return;
  const p = cb.pathForFile(f);
  if (!p || !/\.cbprov$/i.test(p)) { toast({ type: 'error', title: 'Not a settings file', text: 'Drop the .cbprov file from IT.' }); return; }
  const info = await cb.inspectSettingsFile(p);
  if (info && info.ok !== false) importModal(info, null); else toast({ type: 'error', title: 'Could not open file', text: info && info.error });
});

// ---------------------------------------------------------------- updates
let upd = null;          // latest update state from main
let updBusy = false;

// Tiny, safe Markdown -> HTML for release notes (headings, bullets, bold, code).
function mdToHtml(md) {
  const inline = t => esc(t).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
  let html = '', inList = false;
  for (const raw of String(md || '').split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (/^```/.test(line.trim())) continue;
    const li = /^\s*[-*]\s+(.*)$/.exec(line);
    if (li) { if (!inList) { html += '<ul>'; inList = true; } html += `<li>${inline(li[1])}</li>`; continue; }
    if (inList) { html += '</ul>'; inList = false; }
    const h = /^#{1,6}\s+(.*)$/.exec(line);
    if (h) html += `<h4>${inline(h[1])}</h4>`;
    else if (line.trim() && !/^\|?\s*-{3,}/.test(line)) html += `<p>${inline(line.replace(/^\|\s*|\s*\|$/g, '').replace(/\s*\|\s*/g, ' · '))}</p>`;
  }
  if (inList) html += '</ul>';
  return html || '<p>No details were provided for this update.</p>';
}

function renderUpdateChip() {
  const show = !!(upd && upd.latest && upd.latest.version !== upd.skipped);
  $('#tb-update').classList.toggle('hidden', !show);
  document.body.classList.toggle('has-update', show);
  if (show) $('#tb-update').textContent = `Update ${upd.latest.version}`;
  const st = $('#upd-status');
  if (!upd || !st) return;
  $('#s-autoupd').checked = upd.auto;
  if (upd.latest) st.textContent = `Version ${upd.latest.version} is available (you have ${upd.current}).`;
  else if (upd.lastCheck && upd.lastCheck.status === 'current') st.textContent = `You're up to date (version ${upd.current}).`;
  else if (upd.lastCheck && upd.lastCheck.error) st.textContent = upd.lastCheck.error;
  else st.textContent = 'Checks when the app opens and every few hours';
}

function showUpdateModal(state) {
  upd = state; renderUpdateChip();
  const u = state.latest; if (!u) return;
  const date = u.publishedAt ? new Date(u.publishedAt).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }) : '';
  const onCall = inCall();
  const mac = cb.platform === 'darwin';
  openModal(`<h3>Update available</h3>
    <div class="meta">Version <b>${esc(u.version)}</b>${date ? ' · ' + esc(date) : ''} · you have ${esc(state.current)}</div>
    <div class="notes">${mdToHtml(u.notes)}</div>
    <div class="progress hidden" id="upd-progress"><i></i></div>
    <p id="upd-msg" style="margin-top:10px">${onCall ? 'Finish your call first — you can update right after.' : (mac ? 'The installer opens; drag Channel Blend Softphone into Applications.' : 'Takes about a minute. The softphone closes and reopens by itself.')}</p>
    <div class="upd-actions"><button class="btn ghost" id="upd-later">Later</button><button class="btn primary" id="upd-now" ${onCall || !u.asset ? 'disabled' : ''}>${icon('download')}Update now</button></div>
    <button class="upd-skip" id="upd-skip">Skip this version</button>`);
  if (!u.asset) $('#upd-msg').textContent = 'This release has no installer for your computer yet. Ask IT.';
  $('#upd-later').onclick = async () => { upd = await cb.updateLater(); closeModal(); renderUpdateChip(); };
  $('#upd-skip').onclick = async () => { upd = await cb.skipUpdate(u.version); closeModal(); renderUpdateChip(); };
  $('#upd-now').onclick = async () => {
    updBusy = true;
    $('#upd-now').disabled = true; $('#upd-later').disabled = true; $('#upd-skip').classList.add('hidden');
    $('#upd-progress').classList.remove('hidden');
    $('#upd-msg').textContent = 'Downloading…';
    const r = await cb.installUpdate();
    updBusy = false;
    if (!r || !r.ok) {
      $('#upd-msg').innerHTML = `<span style="color:var(--danger)">${esc((r && r.error) || 'The update failed.')}</span>`;
      $('#upd-now').disabled = false; $('#upd-later').disabled = false;
      return;
    }
    if (r.mode === 'restart') $('#upd-msg').textContent = 'Installing… the softphone will reopen in a moment.';
    else {
      $('#upd-msg').innerHTML = 'The installer is open. <b>Quit Channel Blend</b>, then drag the app into <b>Applications</b> and choose <b>Replace</b>.';
      $('#upd-later').textContent = 'Close'; $('#upd-later').disabled = false;
      $('#upd-later').onclick = () => closeModal();
      $('#upd-now').innerHTML = 'Quit Channel Blend'; $('#upd-now').disabled = false;
      $('#upd-now').onclick = () => cb.quitApp();
    }
  };
}

cb.onUpdateAvailable(state => { if (!updBusy && $('#modal-wrap').classList.contains('hidden')) showUpdateModal(state); else { upd = state; renderUpdateChip(); } });
cb.onUpdateState(state => { upd = state; renderUpdateChip(); });
cb.onUpdateProgress(p => {
  const bar = $('#upd-progress i'); if (bar) bar.style.width = Math.round(p * 100) + '%';
  const m = $('#upd-msg'); if (m && p < 1) m.textContent = `Downloading… ${Math.round(p * 100)}%`;
});
$('#tb-update').addEventListener('click', () => { if (upd && upd.latest) showUpdateModal(upd); });
$('#upd-check').addEventListener('click', async () => {
  const b = $('#upd-check'); b.disabled = true; $('#upd-status').textContent = 'Checking…';
  const r = await cb.checkForUpdates();
  b.disabled = false;
  upd = r.state; renderUpdateChip();
  if (r.status === 'current') toast({ type: 'success', title: "You're up to date", text: `Version ${upd.current} is the latest.` });
  else if (r.status === 'error') toast({ type: 'error', title: 'Could not check for updates', text: r.error });
});
$('#s-autoupd').addEventListener('change', async e => { upd = await cb.setAutoUpdate(e.target.checked); renderUpdateChip(); });

// ---------------------------------------------------------------- boot
cb.onState(s => {
  const first = !S;
  S = s;
  if (first) applyAudioSettings();
  render();
});

function applyAudioSettings() {
  const a = S.settings.audio;
  callAudio.speakerId = a.speakerId; callAudio.setSpeakerVolume(a.speakerVolume); callAudio.setMicVolume(a.micVolume); callAudio.setRingVolume(a.ringVolume);
  $('#speaker-vol').value = Math.round(a.speakerVolume * 100); volIcon();
}

(async () => {
  S = await cb.getState();
  applyAudioSettings();
  render();
  callAudio.init().then(refreshDevices).catch(() => refreshDevices());
  const info = await cb.appInfo();
  appInfo = info;
  $('#about').innerHTML = `Channel Blend Softphone ${esc(info.version)} · ${esc(info.platform)}<br>SIP over UDP · G.711 µ-law/A-law · RFC 2833 DTMF`;
  $('#number').focus();
  cb.ready();
  upd = await cb.updateState(); renderUpdateChip();
})();
