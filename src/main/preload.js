'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const invoke = (ch) => (...args) => ipcRenderer.invoke(ch, ...args);
const on = (ch) => (fn) => { const l = (_e, d) => fn(d); ipcRenderer.on(ch, l); return () => ipcRenderer.removeListener(ch, l); };

contextBridge.exposeInMainWorld('cb', {
  platform: process.platform,
  getState: invoke('state:get'),
  appInfo: invoke('app:info'),
  updateSettings: invoke('settings:update'),
  saveLine: invoke('line:save'),
  clearLine: invoke('line:clear'),
  reconnectLine: invoke('line:reconnect'),
  setActiveLine: invoke('line:set-active'),
  dial: invoke('call:dial'),
  answer: invoke('call:answer'),
  reject: invoke('call:reject'),
  hangup: invoke('call:hangup'),
  dtmf: invoke('call:dtmf'),
  mute: invoke('call:mute'),
  hold: invoke('call:hold'),
  toggleRecording: invoke('rec:toggle'),
  micUnavailable: invoke('mic:unavailable'),
  requestMicAccess: invoke('mic:request-access'),
  chooseRecordingFolder: invoke('rec:choose-folder'),
  openRecordingFolder: invoke('rec:open-folder'),
  showFile: invoke('file:show'),
  showLogs: invoke('logs:show'),
  clearRecents: invoke('recents:clear'),
  exportSettings: invoke('prov:export'),
  pickSettingsFile: invoke('prov:pick'),
  inspectSettingsFile: invoke('prov:inspect'),
  importSettings: invoke('prov:import'),
  pathForFile: (file) => { try { return webUtils.getPathForFile(file); } catch (_) { return null; } },
  sendMic: (int16) => ipcRenderer.send('audio:mic', int16.buffer),
  ready: () => ipcRenderer.send('renderer:ready'),
  onState: on('state'),
  onToast: on('toast'),
  onAudioCmd: on('audio-cmd'),
  onAudioFrame: on('audio-frame'),
  onProvFile: on('prov:file-opened'),
  onCallEnded: on('call-ended'),
  onTheme: on('theme')
});
