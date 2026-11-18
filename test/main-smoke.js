'use strict';
// Loads src/main/main.js against a stubbed Electron API to catch wiring errors.
const Module = require('module');
const os = require('os'), fs = require('fs'), path = require('path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cbmain-'));
const handlers = {}, sent = [];
let readyResolve; const ready = new Promise(r => readyResolve = r);
const ee = () => ({ on() {}, once() {} });
const fakeWin = function () { return { ...ee(), loadURL(u) { this.url = u; }, webContents: { send: (c, p) => sent.push(c), setWindowOpenHandler() {}, on() {} }, isDestroyed: () => false, isMinimized: () => false, isMaximized: () => false, getBounds: () => ({}), show() {}, focus() {}, flashFrame() {}, setTitleBarOverlay() {} }; };
const electron = {
  app: { setName() {}, setAppUserModelId() {}, commandLine: { appendSwitch() {} }, requestSingleInstanceLock: () => true, quit() {}, exit() {}, on() {},
    whenReady: () => ready, getPath: k => k === 'desktop' ? path.join(tmp, 'Desktop') : path.join(tmp, k), getVersion: () => '1.0.0' },
  protocol: { registerSchemesAsPrivileged() {}, handle(s, fn) { electron._proto = fn; } },
  net: { fetch: async u => ({ url: u }) },
  BrowserWindow: fakeWin, Menu: { setApplicationMenu() {}, buildFromTemplate: () => ({}) },
  ipcMain: { handle: (c, f) => handlers[c] = f, on: (c, f) => handlers['on:' + c] = f },
  nativeTheme: { themeSource: 'system', shouldUseDarkColors: true, on() {} },
  dialog: {}, shell: {}, safeStorage: { isEncryptionAvailable: () => false },
  Notification: { isSupported: () => false }, systemPreferences: {},
  session: { defaultSession: { setPermissionRequestHandler() {}, setPermissionCheckHandler() {} } }
};
const orig = Module._load;
Module._load = function (req, ...rest) { return req === 'electron' ? electron : orig.call(this, req, ...rest); };
require('../src/main/main.js');
readyResolve();
setTimeout(async () => {
  const call = (c, ...a) => handlers[c]({}, ...a);
  const st = await call('state:get');
  if (!st.lines || st.lines.length !== 2) throw new Error('bad state');
  await call('line:save', 1, { username: '2002', password: 'pw', domain: '127.0.0.1:1', enabled: true });
  const st2 = await call('state:get');
  if (!st2.lines[1].hasPassword || JSON.stringify(st2).includes('"pw"')) throw new Error('password handling');
  await call('settings:update', { theme: 'dark', calls: { autoRecord: true } });
  if (electron.nativeTheme.themeSource !== 'dark') throw new Error('theme');
  const r = await electron._proto({ url: 'app://cbs/index.html' });
  if (!r.url.endsWith('index.html')) throw new Error('protocol');
  const bad = await electron._proto({ url: 'app://cbs/..%2F..%2Fmain%2Fmain.js' });
  if (bad.url) throw new Error('path traversal not blocked');
  console.log('main smoke OK; handlers:', Object.keys(handlers).length, 'window url:', 'app://cbs/index.html');
  process.exit(0);
}, 300);
