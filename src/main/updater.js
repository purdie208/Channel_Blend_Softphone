'use strict';
// Update checker: reads the latest GitHub Release, compares versions, downloads the
// installer for this platform and runs it. No Electron dependency (fetch is injected).

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');

function parseVersion(v) {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(v || ''));
  return m ? [+m[1], +m[2], +m[3]] : null;
}
function isNewer(latest, current) {
  const a = parseVersion(latest), b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i]; }
  return false;
}

class Updater extends EventEmitter {
  /**
   * @param {object} o { repo: 'owner/name', currentVersion, platform, fetch, apiBase?, log? }
   */
  constructor(o) {
    super();
    this.repo = o.repo;
    this.currentVersion = o.currentVersion;
    this.platform = o.platform || process.platform;
    this.fetch = o.fetch;
    this.apiBase = o.apiBase || 'https://api.github.com';
    this.log = o.log || (() => {});
    this.latest = null;      // last found update (or null)
    this.lastCheck = null;   // { at, status, error }
    this.downloading = false;
  }

  _pickAsset(assets) {
    const ext = this.platform === 'win32' ? '.exe' : this.platform === 'darwin' ? '.dmg' : null;
    if (!ext) return null;
    return (assets || []).find(a => a.name.toLowerCase().endsWith(ext) && !/blockmap|uninstall/i.test(a.name)) || null;
  }

  /** Returns { status: 'available' | 'current' | 'error', update?, error? } */
  async check() {
    if (!this.repo) return this._done({ status: 'error', error: 'No update source configured' });
    try {
      const res = await this.fetch(`${this.apiBase}/repos/${this.repo}/releases/latest`, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': `Channel-Blend-Softphone/${this.currentVersion}` }
      });
      if (res.status === 404) return this._done({ status: 'error', error: 'No published releases found (or the GitHub repository is private).' });
      if (res.status === 403 || res.status === 429) return this._done({ status: 'error', error: 'GitHub is limiting update checks right now. Try again later.' });
      if (!res.ok) return this._done({ status: 'error', error: `Update server answered ${res.status}` });
      const rel = await res.json();
      const version = (rel.tag_name || rel.name || '').replace(/^v/i, '');
      if (!isNewer(version, this.currentVersion)) { this.latest = null; return this._done({ status: 'current' }); }
      const asset = this._pickAsset(rel.assets);
      this.latest = {
        version, title: rel.name || `Version ${version}`, notes: rel.body || '', url: rel.html_url,
        publishedAt: rel.published_at,
        asset: asset ? { name: asset.name, url: asset.browser_download_url, size: asset.size, digest: asset.digest || null } : null
      };
      return this._done({ status: 'available', update: this.latest });
    } catch (e) {
      return this._done({ status: 'error', error: 'Could not reach the update server. Check your internet connection.' });
    }
  }

  _done(r) { this.lastCheck = { at: Date.now(), status: r.status, error: r.error || null }; return r; }

  /** Download the installer; emits 'progress' (0..1). Resolves to the file path. */
  async download() {
    const u = this.latest;
    if (!u || !u.asset) throw new Error('There is no installer for this computer in that release.');
    this.downloading = true;
    try {
      const dir = path.join(os.tmpdir(), 'ChannelBlendUpdate');
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, u.asset.name);
      const part = file + '.part';
      const res = await this.fetch(u.asset.url, { headers: { 'User-Agent': `Channel-Blend-Softphone/${this.currentVersion}`, Accept: 'application/octet-stream' } });
      if (!res.ok || !res.body) throw new Error(`Download failed (${res.status})`);
      const total = u.asset.size || +res.headers.get('content-length') || 0;
      const out = fs.createWriteStream(part);
      const hash = crypto.createHash('sha256');
      let got = 0;
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const buf = Buffer.from(value);
        hash.update(buf);
        got += buf.length;
        if (!out.write(buf)) await new Promise(r => out.once('drain', r));
        if (total) this.emit('progress', Math.min(1, got / total));
      }
      await new Promise((resolve, reject) => out.end(err => (err ? reject(err) : resolve())));
      if (total && got !== total) throw new Error('The download was incomplete. Please try again.');
      if (u.asset.digest && /^sha256:/i.test(u.asset.digest)) {
        if (u.asset.digest.slice(7).toLowerCase() !== hash.digest('hex')) throw new Error('The download is damaged (checksum mismatch). Please try again.');
      }
      try { fs.unlinkSync(file); } catch (_) {}
      fs.renameSync(part, file);
      this.emit('progress', 1);
      return file;
    } finally {
      this.downloading = false;
    }
  }

  /**
   * Start the installer. Windows: silent update that reopens the app when finished.
   * macOS: opens the disk image so the user can drag the app into Applications.
   */
  launchInstaller(file, openPath) {
    if (this.platform === 'win32') {
      const child = spawn(file, ['--updated', '/S', '--force-run'], { detached: true, stdio: 'ignore', windowsHide: false });
      child.unref();
      return 'restart';
    }
    openPath(file);
    return 'manual';
  }
}

module.exports = { Updater, isNewer, parseVersion };
