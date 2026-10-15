// server/ai/secrets.js — at-rest encryption for per-user secrets
// (currently only the user's Anthropic API key for BYOK).
//
// Set BUNVELOPE_SECRETS_KEY to a base64-encoded 32-byte random value to
// enable AES-256-GCM at rest. Generate one with:
//
//   openssl rand -base64 32
//
// When the env var is unset, the encryptApiKey() return falls through to
// a 'plaintext' record. The UI surfaces a warning in that case so users
// know their key is stored unencrypted at rest. Never log the plaintext
// or the master key — both are treated as secrets.

import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';

const ALG = 'aes-256-gcm';
const IV_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32;

let _masterKeyChecked = false;
let _masterKey = null;

function loadMasterKey() {
  if (_masterKeyChecked) return _masterKey;
  const raw = process.env.BUNVELOPE_SECRETS_KEY;
  if (!raw) {
    console.warn(
      'secrets: BUNVELOPE_SECRETS_KEY is not set; per-user API keys will '
      + 'be stored UNENCRYPTED. Set it to a base64-encoded 32-byte value '
      + 'to enable AES-256-GCM at rest.',
    );
    _masterKey = null;
    _masterKeyChecked = true;
    return null;
  }
  let buf;
  try { buf = Buffer.from(raw, 'base64'); }
  catch { buf = null; }
  if (!buf || buf.length !== KEY_LEN) {
    throw new Error(
      `BUNVELOPE_SECRETS_KEY must decode to ${KEY_LEN} bytes (got `
      + `${buf ? buf.length : 'invalid'}). Generate with: `
      + 'openssl rand -base64 32',
    );
  }
  _masterKey = buf;
  // Cache only a successfully resolved configuration; a bad key must keep
  // failing on every request, never become the unconfigured plaintext mode.
  _masterKeyChecked = true;
  return buf;
}

/**
 * Algorithm reported to clients via /api/ai/key. 'aes-256-gcm' when a
 * master key is configured; 'none' otherwise.
 */
export function secretsAlg() {
  return loadMasterKey() ? 'aes-256-gcm' : 'none';
}

/**
 * Encrypt an API key. Returns a record with `alg` set to 'aes-256-gcm'
 * when a master key is configured, or 'plaintext' otherwise. Callers
 * persist all four fields verbatim and pass them back to decryptApiKey.
 *
 * @param {string} plaintext
 * @returns {{ alg: 'aes-256-gcm'|'plaintext', iv: Buffer|null, tag: Buffer|null, ct: Buffer }}
 */
export function encryptApiKey(plaintext) {
  if (typeof plaintext !== 'string' || !plaintext) {
    throw new Error('encryptApiKey: plaintext must be a non-empty string');
  }
  const key = loadMasterKey();
  if (!key) {
    return { alg: 'plaintext', iv: null, tag: null, ct: Buffer.from(plaintext, 'utf8') };
  }
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALG, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { alg: 'aes-256-gcm', iv, tag, ct };
}

/**
 * Decrypt a stored API key record. Throws on tag mismatch or unknown alg.
 *
 * @param {{ alg: string|null, iv: Buffer|null, tag: Buffer|null, ct: Buffer|null }} stored
 * @returns {string}
 */
export function decryptApiKey(stored) {
  if (!stored || !stored.alg || !stored.ct) {
    throw new Error('decryptApiKey: missing record');
  }
  if (stored.alg === 'plaintext') {
    return Buffer.from(stored.ct).toString('utf8');
  }
  if (stored.alg === 'aes-256-gcm') {
    const key = loadMasterKey();
    if (!key) {
      throw new Error(
        'decryptApiKey: stored record uses aes-256-gcm but '
        + 'BUNVELOPE_SECRETS_KEY is not configured',
      );
    }
    if (!stored.iv || stored.iv.length !== IV_LEN) {
      throw new Error('decryptApiKey: bad iv length');
    }
    if (!stored.tag || stored.tag.length !== TAG_LEN) {
      throw new Error('decryptApiKey: bad tag length');
    }
    const decipher = createDecipheriv(ALG, key, stored.iv);
    decipher.setAuthTag(stored.tag);
    const pt = Buffer.concat([decipher.update(stored.ct), decipher.final()]);
    return pt.toString('utf8');
  }
  throw new Error(`decryptApiKey: unknown alg "${stored.alg}"`);
}

/**
 * Last-4-character preview for UI confirmation. Never returns more than
 * 4 chars and never the prefix, so a leak of the preview alone doesn't
 * meaningfully reduce search space against the key.
 */
export function previewApiKey(plaintext) {
  if (typeof plaintext !== 'string') return '';
  return plaintext.slice(-4);
}

/** Reset cached master-key state. Test-only. */
export function _resetSecretsCacheForTests() {
  _masterKeyChecked = false;
  _masterKey = null;
}
