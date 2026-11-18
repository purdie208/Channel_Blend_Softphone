'use strict';
// Provisioning files (.cbprov): IT exports a verified line, the employee imports it with one
// click (or double-clicks the file). Contents are AES-256-GCM encrypted so the password can't
// be read by opening the file. An optional PIN adds a second factor IT can share separately.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const FORMAT = 'channel-blend-provisioning';

// The company key lives in provisioning.key next to this file. It is NOT stored in git
// (see .gitignore): create it with `npm run make-key`, and give GitHub the same value as the
// CB_PROVISIONING_KEY secret so cloud builds match local builds.
// Without it the app falls back to a public development key, which anyone could use.
const DEV_SECRET = 'channel-blend-development-key-not-for-production';
const KEY_FILE = path.join(__dirname, 'provisioning.key');
let APP_SECRET = DEV_SECRET;
try {
  const k = fs.readFileSync(KEY_FILE, 'utf8').trim();
  if (k.length >= 32) APP_SECRET = k;
} catch (_) { /* no key file: development key */ }
const usingDevKey = APP_SECRET === DEV_SECRET;

function key(salt, pin) {
  return crypto.scryptSync(APP_SECRET + '|' + (pin || ''), salt, 32, { N: 16384, r: 8, p: 1 });
}

function exportProvisioning({ account, prefs, pin, exportedBy }) {
  const payload = JSON.stringify({
    account: {
      label: account.label, displayName: account.displayName, username: account.username,
      authUsername: account.authUsername, domain: account.domain, password: account.password
    },
    prefs: prefs || null
  });
  const salt = crypto.randomBytes(16), iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(salt, pin), iv);
  const data = Buffer.concat([cipher.update(payload, 'utf8'), cipher.final()]);
  return JSON.stringify({
    format: FORMAT, version: 1,
    createdAt: new Date().toISOString(),
    exportedBy: exportedBy || undefined,
    extension: account.username, // shown before import so the user knows which file it is
    pinProtected: !!pin,
    salt: salt.toString('base64'), iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64')
  }, null, 2);
}

function inspectProvisioning(text) {
  let f;
  try { f = JSON.parse(text); } catch (_) { throw new Error('This is not a Channel Blend settings file.'); }
  if (!f || f.format !== FORMAT) throw new Error('This is not a Channel Blend settings file.');
  return { pinProtected: !!f.pinProtected, extension: f.extension, createdAt: f.createdAt };
}

function importProvisioning(text, pin) {
  const f = JSON.parse(text);
  if (f.format !== FORMAT) throw new Error('This is not a Channel Blend settings file.');
  if (f.pinProtected && !pin) { const e = new Error('This settings file needs a PIN from IT.'); e.needPin = true; throw e; }
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key(Buffer.from(f.salt, 'base64'), pin), Buffer.from(f.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(f.tag, 'base64'));
    const out = Buffer.concat([decipher.update(Buffer.from(f.data, 'base64')), decipher.final()]).toString('utf8');
    return JSON.parse(out);
  } catch (_) {
    const e = new Error(f.pinProtected ? 'Wrong PIN — please check with IT.' : 'The settings file is damaged.');
    e.needPin = !!f.pinProtected;
    throw e;
  }
}

module.exports = { exportProvisioning, importProvisioning, inspectProvisioning, usingDevKey };
