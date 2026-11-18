'use strict';
const crypto = require('crypto');
const { parseAuthHeader } = require('./message');

const ALGS = { 'MD5': 'md5', 'MD5-SESS': 'md5', 'SHA-256': 'sha256', 'SHA-256-SESS': 'sha256' };

function h(alg, s) { return crypto.createHash(alg).update(s, 'utf8').digest('hex'); }

// Pick the challenge we can answer from a 401/407 response.
function pickChallenge(response) {
  const name = response.status === 407 ? 'proxy-authenticate' : 'www-authenticate';
  const list = response.getAll(name).map(parseAuthHeader).filter(c => c && /^digest$/i.test(c.scheme));
  const norm = c => (c.params.algorithm || 'MD5').toUpperCase();
  // Prefer MD5 (what Asterisk/FreePBX always offers), fall back to SHA-256.
  return list.find(c => norm(c) === 'MD5') || list.find(c => ALGS[norm(c)]) || null;
}

/**
 * Build an Authorization / Proxy-Authorization header value.
 */
function buildAuthorization({ challenge, method, uri, username, password, nc = 1, body = '' }) {
  const p = challenge.params;
  const algName = (p.algorithm || 'MD5').toUpperCase();
  const alg = ALGS[algName] || 'md5';
  const realm = p.realm || '';
  const nonce = p.nonce || '';
  const cnonce = crypto.randomBytes(8).toString('hex');
  const qops = (p.qop || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  const qop = qops.includes('auth') ? 'auth' : (qops.includes('auth-int') ? 'auth-int' : null);
  const ncStr = nc.toString(16).padStart(8, '0');

  let ha1 = h(alg, `${username}:${realm}:${password}`);
  if (algName.endsWith('-SESS')) ha1 = h(alg, `${ha1}:${nonce}:${cnonce}`);
  const ha2 = qop === 'auth-int' ? h(alg, `${method}:${uri}:${h(alg, body)}`) : h(alg, `${method}:${uri}`);
  const response = qop
    ? h(alg, `${ha1}:${nonce}:${ncStr}:${cnonce}:${qop}:${ha2}`)
    : h(alg, `${ha1}:${nonce}:${ha2}`);

  const parts = [
    `username="${username}"`, `realm="${realm}"`, `nonce="${nonce}"`, `uri="${uri}"`,
    `response="${response}"`, `algorithm=${p.algorithm || 'MD5'}`
  ];
  if (p.opaque !== undefined) parts.push(`opaque="${p.opaque}"`);
  if (qop) parts.push(`qop=${qop}`, `nc=${ncStr}`, `cnonce="${cnonce}"`);
  return 'Digest ' + parts.join(', ');
}

module.exports = { pickChallenge, buildAuthorization };
