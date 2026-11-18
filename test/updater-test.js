'use strict';
// Update checker against a fake GitHub API on localhost.
const http = require('http'), crypto = require('crypto'), fs = require('fs'), assert = require('assert');
const { Updater, isNewer } = require('../src/main/updater');

const installer = crypto.randomBytes(300 * 1024);
const sha = crypto.createHash('sha256').update(installer).digest('hex');
let release = null, status = 200, badDigest = false;

const server = http.createServer((req, res) => {
  if (req.url === '/repos/acme/phone/releases/latest') {
    assert.ok(req.headers['user-agent'], 'GitHub requires a User-Agent');
    res.writeHead(status, { 'Content-Type': 'application/json' });
    return res.end(status === 200 ? JSON.stringify(release) : '{"message":"Not Found"}');
  }
  if (req.url === '/download/setup.exe') { res.writeHead(302, { Location: '/cdn/setup.exe' }); return res.end(); }
  if (req.url === '/cdn/setup.exe') { res.writeHead(200, { 'Content-Length': installer.length }); return res.end(installer); }
  res.writeHead(404); res.end();
});

(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const mk = (platform, ver = '1.0.2') => new Updater({ repo: 'acme/phone', currentVersion: ver, platform, fetch, apiBase: base });
  const rel = (tag) => ({ tag_name: tag, name: `Channel Blend Softphone ${tag}`, body: '## What\'s new\n- Thing', html_url: 'x', published_at: '2026-11-20T00:00:00Z',
    assets: [
      { name: `ChannelBlendSoftphone-Setup-${tag.slice(1)}.exe.blockmap`, browser_download_url: base + '/nope', size: 1 },
      { name: `ChannelBlendSoftphone-Setup-${tag.slice(1)}.exe`, browser_download_url: base + '/download/setup.exe', size: installer.length, digest: 'sha256:' + (badDigest ? '0'.repeat(64) : sha) },
      { name: `ChannelBlendSoftphone-${tag.slice(1)}.dmg`, browser_download_url: base + '/download/setup.exe', size: installer.length }] });

  assert.ok(isNewer('1.0.10', '1.0.9') && isNewer('v2.0.0', '1.9.9') && !isNewer('1.0.2', '1.0.2') && !isNewer('1.0.1', '1.0.2'));
  console.log('✓ version comparison (1.0.10 > 1.0.9, v-prefix ok)');

  release = rel('v1.0.2');
  assert.strictEqual((await mk('win32').check()).status, 'current');
  release = rel('v1.0.3');
  const u = mk('win32'); const r = await u.check();
  assert.strictEqual(r.status, 'available'); assert.strictEqual(r.update.version, '1.0.3');
  assert.ok(r.update.asset.name.endsWith('.exe') && !r.update.asset.name.includes('blockmap'));
  assert.ok((await mk('darwin').check()).update.asset.name.endsWith('.dmg'));
  console.log('✓ finds 1.0.3 and picks the right installer (.exe on Windows, .dmg on Mac)');

  const progress = []; u.on('progress', p => progress.push(p));
  const file = await u.download();
  assert.ok(fs.readFileSync(file).equals(installer)); assert.strictEqual(progress[progress.length - 1], 1);
  console.log('✓ downloaded through a redirect, checksum verified, progress reported');

  badDigest = true; release = rel('v1.0.3');
  const u2 = mk('win32'); await u2.check();
  await assert.rejects(() => u2.download(), /checksum/);
  console.log('✓ damaged download rejected');

  let opened = null; assert.strictEqual(mk('darwin').launchInstaller('/tmp/x.dmg', p => { opened = p; }), 'manual'); assert.strictEqual(opened, '/tmp/x.dmg');
  status = 404; const e = await mk('win32').check();
  assert.strictEqual(e.status, 'error'); assert.ok(/private/.test(e.error));
  status = 200;
  const off = await new Updater({ repo: 'acme/phone', currentVersion: '1.0.2', fetch, apiBase: 'http://127.0.0.1:1' }).check();
  assert.strictEqual(off.status, 'error');
  console.log('✓ 404 / offline handled gracefully');
  console.log('\nUPDATER TESTS PASSED');
  server.close();
})().catch(e => { console.error('FAILED', e); process.exit(1); });
