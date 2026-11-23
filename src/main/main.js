'use strict';
const { app, protocol, net, BrowserWindow, ipcMain, nativeTheme, dialog, shell, safeStorage, Notification, systemPreferences, session, Menu } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { pathToFileURL } = require('url');
const { SettingsStore } = require('./config/settings');
const { Recorder, personName, shortDate, nextSequence } = require('./recording/recorder');
const { PhoneEngine } = require('./engine');
const { Updater } = require('./updater');
const PKG = require('../../package.json');
const { exportProvisioning, importProvisioning, inspectProvisioning, usingDevKey } = require('./config/provisioning');

const APP_NAME = 'Channel Blend Softphone';
app.setName(APP_NAME);
if (process.platform === 'win32') app.setAppUserModelId('com.channelblend.softphone');
// Ring and call audio must play without the user clicking first.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

// The UI is served from app://cbs/ (a secure, same-origin scheme) so AudioWorklets,
// setSinkId and getUserMedia all work exactly like on https.
const RENDERER_DIR = path.join(__dirname, '..', 'renderer');
protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

// One instance only: two copies would fight over the SIP registration and recordings.
if (!app.requestSingleInstanceLock()) { app.quit(); }

let win = null, store = null, engine = null, logStream = null, quitting = false;
let updater = null, updatePromptPending = false, updateTimer = null;
let pendingProvFile = findProvArg(process.argv);

function findProvArg(argv) { return (argv || []).find(a => /\.cbprov$/i.test(a) && fs.existsSync(a)) || null; }

// ------------------------------------------------------------------ logging
function openLog() {
  const dir = path.join(app.getPath('userData'), 'logs');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'softphone.log');
  try { if (fs.statSync(file).size > 5 * 1024 * 1024) fs.renameSync(file, file + '.1'); } catch (_) {}
  logStream = fs.createWriteStream(file, { flags: 'a' });
  return file;
}
function log(msg) {
  if (!logStream) return;
  logStream.write(`[${new Date().toISOString()}] ${String(msg).replace(/(Authorization: Digest[^\r\n]*response=")[^"]*/gi, '$1…')}\n`);
}

// ------------------------------------------------------------------ password protection at rest
function fallbackKey() {
  return crypto.createHash('sha256').update(`${os.hostname()}|${os.userInfo().username}|cb-local`).digest();
}
const secure = {
  encrypt(str) {
    if (safeStorage.isEncryptionAvailable()) return { enc: 'os', data: safeStorage.encryptString(str).toString('base64') };
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', fallbackKey(), iv);
    const d = Buffer.concat([c.update(str, 'utf8'), c.final()]);
    return { enc: 'local', data: Buffer.concat([iv, c.getAuthTag(), d]).toString('base64') };
  },
  decrypt(p) {
    const buf = Buffer.from(p.data, 'base64');
    if (p.enc === 'os') return safeStorage.decryptString(buf);
    const dc = crypto.createDecipheriv('aes-256-gcm', fallbackKey(), buf.subarray(0, 12));
    dc.setAuthTag(buf.subarray(12, 28));
    return Buffer.concat([dc.update(buf.subarray(28)), dc.final()]).toString('utf8');
  }
};

// ------------------------------------------------------------------ window
function overlayColors() {
  const dark = nativeTheme.shouldUseDarkColors;
  return { color: '#00000000', symbolColor: dark ? '#e6ecff' : '#13203f', height: 40 };
}

function createWindow() {
  const b = store.get().windowBounds || {};
  win = new BrowserWindow({
    width: b.width || 400, height: b.height || 780, x: b.x, y: b.y,
    minWidth: 360, minHeight: 640,
    title: APP_NAME,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0b1430' : '#f4f7fd',
    icon: path.join(__dirname, '..', 'renderer', 'assets', 'logo-256.png'),
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    titleBarOverlay: process.platform === 'darwin' ? undefined : overlayColors(),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, sandbox: true, nodeIntegration: false,
      backgroundThrottling: false, spellcheck: false
    }
  });
  Menu.setApplicationMenu(process.platform === 'darwin' ? Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }]) : null);
  win.loadURL('app://cbs/index.html');
  win.once('ready-to-show', () => win.show());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('app://cbs/')) e.preventDefault(); });
  const saveBounds = () => { if (!win.isMinimized() && !win.isMaximized()) { store.get().windowBounds = win.getBounds(); } };
  win.on('resize', saveBounds); win.on('move', saveBounds);
  win.on('close', (e) => {
    store.save();
    if (!quitting && engine && engine.active) {
      const r = dialog.showMessageBoxSync(win, { type: 'warning', buttons: ['Hang up and quit', 'Cancel'], defaultId: 1, cancelId: 1, message: 'You are on a call.', detail: 'Closing Channel Blend will end the call.' });
      if (r === 1) e.preventDefault();
    }
  });
  win.on('closed', () => { win = null; });
}

function send(channel, payload) { if (win && !win.isDestroyed()) win.webContents.send(channel, payload); }

function applyTheme() {
  nativeTheme.themeSource = store.get().theme || 'system';
}

// ------------------------------------------------------------------ provisioning helpers
function applyProvisioning(lineIdx, data) {
  const a = data.account;
  store.setLine(lineIdx, { enabled: true, displayName: a.displayName || '', username: a.username, authUsername: a.authUsername || '', domain: a.domain, password: a.password || '', clearPassword: !a.password, provisioned: true, label: lineIdx === 0 ? 'Line 1' : (a.label && a.label !== 'Line 1' ? a.label : 'Line 2') });
  if (data.prefs) {
    const p = data.prefs, calls = {};
    if (typeof p.autoRecord === 'boolean') calls.autoRecord = p.autoRecord;
    if (typeof p.autoMute === 'boolean') calls.autoMute = p.autoMute;
    store.update({ calls });
  }
  store.update({ activeLine: lineIdx });
  engine.restartLine(lineIdx);
}

function offerProvFile(file) {
  if (!file) return;
  try {
    const info = inspectProvisioning(fs.readFileSync(file, 'utf8'));
    send('prov:file-opened', { path: file, ...info });
  } catch (e) { send('toast', { type: 'error', title: 'Could not open file', text: e.message }); }
}

// ------------------------------------------------------------------ updates
function updateState() {
  const u = store.get().updates;
  return { current: app.getVersion(), latest: updater.latest, lastCheck: updater.lastCheck, auto: u.auto !== false, skipped: u.skipped, downloading: updater.downloading, source: PKG.updateRepo || null };
}

/** Ask the UI to show the update window — never in the middle of a call. */
function promptUpdate() {
  if (engine && engine.active) { updatePromptPending = true; return; }
  updatePromptPending = false;
  send('update:available', updateState());
}

async function checkForUpdates(manual) {
  const r = await updater.check();
  log(`update check: ${r.status}${r.update ? ' ' + r.update.version : ''}${r.error ? ' (' + r.error + ')' : ''}`);
  send('update:state', updateState());
  if (r.status === 'available') {
    const u = store.get().updates;
    const quiet = !manual && (u.skipped === r.update.version || Date.now() < (u.remindAfter || 0));
    if (!quiet) promptUpdate();
  }
  return { ...r, state: updateState() };
}

function scheduleUpdateChecks() {
  clearInterval(updateTimer);
  if (store.get().updates.auto === false) return;
  setTimeout(() => checkForUpdates(false), 20 * 1000);
  updateTimer = setInterval(() => checkForUpdates(false), 6 * 60 * 60 * 1000);
}

// ------------------------------------------------------------------ IPC
function registerIpc() {
  const h = (ch, fn) => ipcMain.handle(ch, async (_e, ...args) => {
    try { return await fn(...args); } catch (e) { log(`ipc ${ch} failed: ${e.stack || e}`); return { ok: false, error: e.message }; }
  });

  h('state:get', () => engine.snapshot());
  h('app:info', () => ({ version: app.getVersion(), platform: process.platform, devKey: usingDevKey, logPath: path.join(app.getPath('userData'), 'logs', 'softphone.log') }));

  h('settings:update', (patch) => {
    const before = JSON.stringify(store.get().network);
    store.update(patch || {});
    if (patch && patch.theme) applyTheme();
    if (JSON.stringify(store.get().network) !== before) { engine.restartLine(0); engine.restartLine(1); }
    engine._emitState();
    return { ok: true };
  });

  h('line:save', (i, fields) => {
    store.setLine(i, fields || {});
    engine.restartLine(i);
    return { ok: true };
  });
  h('line:clear', (i) => { store.clearLine(i); engine.restartLine(i); return { ok: true }; });
  h('line:reconnect', (i) => { engine.restartLine(i); return { ok: true }; });
  h('line:set-active', (i) => { store.update({ activeLine: i }); engine._emitState(); return { ok: true }; });

  h('call:dial', (num) => engine.dial(num));
  h('call:answer', () => engine.answer());
  h('call:reject', () => engine.reject());
  h('call:hangup', () => engine.hangup());
  h('call:dtmf', (d) => engine.dtmf(d));
  h('call:mute', (m) => engine.setMute(m));
  h('call:hold', (v) => engine.setHold(v));
  h('rec:toggle', () => engine.toggleRecording());
  h('monitor:commit', (name) => engine.commitPerson(name));
  h('rec:next-name', (person) => {
    const who = personName(person);
    if (!who) return { name: null };
    const date = shortDate();
    const next = nextSequence(store.get().recording.folder, who, date, true);
    return { name: `${next.name} ${date} (${next.n})` };
  });
  h('mic:unavailable', (reason) => engine.micUnavailable(reason));
  h('mic:request-access', async () => {
    if (process.platform !== 'darwin') return true;
    if (systemPreferences.getMediaAccessStatus('microphone') === 'granted') return true;
    return systemPreferences.askForMediaAccess('microphone');
  });
  h('recents:clear', () => engine.clearRecents());

  h('update:state', () => updateState());
  h('update:check', () => checkForUpdates(true));
  h('update:show', () => { if (updater.latest) send('update:available', updateState()); });
  h('update:later', () => { store.update({ updates: { remindAfter: Date.now() + 24 * 60 * 60 * 1000 } }); return updateState(); });
  h('update:skip', (version) => { store.update({ updates: { skipped: version || '' } }); return updateState(); });
  h('update:auto', (on) => { store.update({ updates: { auto: !!on } }); scheduleUpdateChecks(); return updateState(); });
  h('update:install', async () => {
    if (engine.active) return { ok: false, error: 'Finish your call first, then update.' };
    try {
      const file = await updater.download();
      log(`update downloaded to ${file}`);
      const mode = updater.launchInstaller(file, (p) => shell.openPath(p));
      if (mode === 'restart') setTimeout(() => app.quit(), 300); // installer closes us and reopens the new version
      return { ok: true, mode };
    } catch (e) {
      log('update failed: ' + e.message);
      return { ok: false, error: e.message };
    }
  });
  h('app:quit', () => app.quit());

  h('rec:choose-folder', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Choose where recordings are saved', defaultPath: store.get().recording.folder, properties: ['openDirectory', 'createDirectory'] });
    if (r.canceled || !r.filePaths[0]) return { ok: false };
    store.update({ recording: { folder: r.filePaths[0] } });
    engine._emitState();
    return { ok: true, folder: r.filePaths[0] };
  });
  h('rec:open-folder', async () => {
    const f = store.get().recording.folder;
    fs.mkdirSync(f, { recursive: true });
    await shell.openPath(f);
  });
  h('file:show', (p) => { if (p && fs.existsSync(p)) shell.showItemInFolder(p); });
  h('logs:show', () => shell.showItemInFolder(path.join(app.getPath('userData'), 'logs', 'softphone.log')));

  h('prov:export', async (i, opts = {}) => {
    const acct = store.account(i);
    if (!acct.username || !acct.domain) return { ok: false, error: 'Set up this line first.' };
    const r = await dialog.showSaveDialog(win, {
      title: 'Export settings for an employee',
      defaultPath: path.join(app.getPath('desktop'), `ChannelBlend_${acct.username}.cbprov`),
      filters: [{ name: 'Channel Blend settings', extensions: ['cbprov'] }]
    });
    if (r.canceled || !r.filePath) return { ok: false, canceled: true };
    const c = store.get().calls;
    const text = exportProvisioning({ account: acct, pin: opts.pin || '', prefs: opts.includePrefs ? { autoRecord: c.autoRecord, autoMute: c.autoMute } : null });
    fs.writeFileSync(r.filePath, text);
    return { ok: true, path: r.filePath };
  });

  h('prov:pick', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Choose the settings file from IT', defaultPath: app.getPath('downloads'), filters: [{ name: 'Channel Blend settings', extensions: ['cbprov'] }], properties: ['openFile'] });
    if (r.canceled || !r.filePaths[0]) return { ok: false, canceled: true };
    const info = inspectProvisioning(fs.readFileSync(r.filePaths[0], 'utf8'));
    return { ok: true, path: r.filePaths[0], ...info };
  });
  h('prov:inspect', (file) => ({ ok: true, path: file, ...inspectProvisioning(fs.readFileSync(file, 'utf8')) }));
  h('prov:import', (file, lineIdx, pin) => {
    try {
      const data = importProvisioning(fs.readFileSync(file, 'utf8'), pin);
      applyProvisioning(lineIdx, data);
      return { ok: true, extension: data.account.username };
    } catch (e) { return { ok: false, error: e.message, needPin: !!e.needPin }; }
  });

  ipcMain.on('audio:mic', (_e, buf) => { if (engine) engine.pushMic(new Int16Array(buf)); });
  ipcMain.on('renderer:ready', () => { if (pendingProvFile) { offerProvFile(pendingProvFile); pendingProvFile = null; } });
}

// ------------------------------------------------------------------ app lifecycle
app.on('open-file', (e, file) => { // macOS double-click on a .cbprov
  e.preventDefault();
  if (win) offerProvFile(file); else pendingProvFile = file;
});

app.on('second-instance', (_e, argv) => {
  if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); }
  const f = findProvArg(argv);
  if (f) offerProvFile(f);
});

app.whenReady().then(() => {
  protocol.handle('app', (req) => {
    const u = new URL(req.url);
    const file = path.normalize(path.join(RENDERER_DIR, decodeURIComponent(u.pathname)));
    if (!file.startsWith(RENDERER_DIR + path.sep)) return new Response('Not found', { status: 404 });
    return net.fetch(pathToFileURL(file).toString());
  });
  const logPath = openLog();
  log(`--- ${APP_NAME} ${app.getVersion()} starting on ${process.platform} ---`);
  if (usingDevKey) log('WARNING: no provisioning.key in this build; settings files use the public development key');
  store = new SettingsStore({ dir: app.getPath('userData'), desktopDir: app.getPath('desktop'), secure });
  applyTheme();
  const recorder = new Recorder({ journalPath: path.join(app.getPath('userData'), 'recording-journal.json'), log });
  engine = new PhoneEngine({ store, recorder, dataDir: app.getPath('userData'), userAgent: `Channel Blend Softphone ${app.getVersion()}`, log });

  // Microphone / speaker access for our own page only.
  session.defaultSession.setPermissionRequestHandler((_wc, perm, cb) => cb(['media', 'speaker-selection', 'notifications'].includes(perm)));
  session.defaultSession.setPermissionCheckHandler((_wc, perm) => ['media', 'speaker-selection', 'notifications'].includes(perm));

  registerIpc();
  engine.on('state', s => send('state', s));
  engine.on('toast', t => send('toast', t));
  engine.on('audio-cmd', c => send('audio-cmd', c));
  engine.on('audio-frame', f => send('audio-frame', f));
  engine.on('incoming', info => {
    if (win) { if (win.isMinimized()) win.restore(); win.show(); win.flashFrame(true); }
    if (Notification.isSupported()) {
      const n = new Notification({ title: 'Incoming call', body: info.name ? `${info.name} (${info.number})` : info.number, silent: true });
      n.on('click', () => { if (win) { win.show(); win.focus(); } });
      n.show();
    }
  });
  engine.on('call-ended', (info) => {
    if (win) win.flashFrame(false);
    if (updatePromptPending) setTimeout(promptUpdate, 4000);
    send('call-ended', info);
    // Desktop notification only when the softphone isn't the window in front
    // (when it is, the in-app notice is enough).
    if (store.get().calls.endNotify !== false && Notification.isSupported() && !(win && win.isFocused() && !win.isMinimized())) {
      const who = info.name ? `${info.name} (${info.number})` : info.number;
      const mm = Math.floor(info.duration / 60), ss = String(info.duration % 60).padStart(2, '0');
      const body = info.missed ? `From ${who}`
        : info.connected ? `${who} · ${mm}:${ss}${info.recording ? '\nRecording saved' : ''}`
        : `${who} · ${info.reason}`;
      const n = new Notification({ title: info.missed ? 'Missed call' : 'Call ended', body, silent: true });
      n.on('click', () => { if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); } });
      n.show();
    }
  });
  nativeTheme.on('updated', () => { if (win && process.platform !== 'darwin') { try { win.setTitleBarOverlay(overlayColors()); } catch (_) {} } send('theme', nativeTheme.shouldUseDarkColors ? 'dark' : 'light'); });

  updater = new Updater({ repo: PKG.updateRepo, currentVersion: app.getVersion(), platform: process.platform, fetch: (u, o) => net.fetch(u, o), log });
  updater.on('progress', p => send('update:progress', p));

  createWindow();
  engine.start();
  scheduleUpdateChecks();
  log(`log file ${logPath}`);
});

app.on('before-quit', (e) => {
  if (quitting) return;
  e.preventDefault();
  quitting = true;
  const done = () => { try { store && store.save(); } catch (_) {} if (logStream) logStream.end(); app.exit(0); };
  const t = setTimeout(done, 3000);
  (engine ? engine.shutdown() : Promise.resolve()).then(() => { clearTimeout(t); done(); });
});

app.on('window-all-closed', () => app.quit());
app.on('activate', () => { if (!win && store) createWindow(); });
