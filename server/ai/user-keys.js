// server/ai/user-keys.js — DB-backed CRUD for per-user Anthropic API keys
// (BYOK). Wraps the encryption helper in secrets.js around plain SQL on
// the users table (columns added in migration 0007).
//
// Validation note: we only do shape validation here ("looks like an
// Anthropic key"). The /api/ai/key/test endpoint exercises the key
// against Anthropic to confirm it's actually live before saving.

import Anthropic from '@anthropic-ai/sdk';
import { query } from '../db.js';
import { encryptApiKey, decryptApiKey, previewApiKey } from './secrets.js';
import { AiError } from './client.js';

// Anthropic console keys all start with this prefix; reject obvious junk
// before paying for a round-trip to validate. Don't bake in a length —
// Anthropic has historically lengthened keys without warning.
const KEY_PREFIX = 'sk-ant-';
const KEY_MIN_LEN = 20; // prefix + a few chars

/**
 * Quick shape validation. Throws AiError('bad_api_key') with status 400
 * on anything obviously malformed. Doesn't talk to Anthropic.
 */
export function validateApiKeyShape(key) {
  if (typeof key !== 'string') {
    throw new AiError('bad_api_key', 'API key must be a string', 400);
  }
  const trimmed = key.trim();
  if (trimmed.length < KEY_MIN_LEN) {
    throw new AiError('bad_api_key', 'API key looks too short', 400);
  }
  if (!trimmed.startsWith(KEY_PREFIX)) {
    throw new AiError('bad_api_key', `API key must start with "${KEY_PREFIX}"`, 400);
  }
  return trimmed;
}

/**
 * Read the saved API key for `userId` and decrypt it. Returns null when
 * the user has no key configured. Throws on decryption failure (e.g. the
 * master key was rotated without re-encrypting).
 */
export async function loadUserApiKey(userId) {
  const { rows } = await query(
    `select ai_api_key_alg, ai_api_key_iv, ai_api_key_tag, ai_api_key_ct
       from users where id = $1`,
    [userId],
  );
  const row = rows[0];
  if (!row || !row.ai_api_key_alg || !row.ai_api_key_ct) return null;
  return decryptApiKey({
    alg: row.ai_api_key_alg,
    iv: row.ai_api_key_iv,
    tag: row.ai_api_key_tag,
    ct: row.ai_api_key_ct,
  });
}

/**
 * Read non-secret status fields (for the settings UI). Never returns the
 * key itself or the ciphertext. `hasKey` is true when there's something
 * stored regardless of algorithm.
 */
export async function getUserApiKeyStatus(userId) {
  const { rows } = await query(
    `select ai_api_key_alg, ai_api_key_preview, ai_api_key_set_at
       from users where id = $1`,
    [userId],
  );
  const row = rows[0];
  if (!row || !row.ai_api_key_alg) {
    return { hasKey: false, alg: null, preview: null, setAt: null };
  }
  return {
    hasKey: true,
    alg: row.ai_api_key_alg,
    preview: row.ai_api_key_preview || null,
    setAt: row.ai_api_key_set_at ? row.ai_api_key_set_at.toISOString() : null,
  };
}

/**
 * Encrypt and persist `key` for `userId`. Overwrites any existing key.
 * Returns the same shape as getUserApiKeyStatus.
 */
export async function saveUserApiKey(userId, key) {
  const trimmed = validateApiKeyShape(key);
  const enc = encryptApiKey(trimmed);
  const preview = previewApiKey(trimmed);
  await query(
    `update users
        set ai_api_key_alg     = $2,
            ai_api_key_iv      = $3,
            ai_api_key_tag     = $4,
            ai_api_key_ct      = $5,
            ai_api_key_preview = $6,
            ai_api_key_set_at  = now()
      where id = $1`,
    [userId, enc.alg, enc.iv, enc.tag, enc.ct, preview],
  );
  return getUserApiKeyStatus(userId);
}

/**
 * Clear the saved key for `userId`. No-op if there was none.
 */
export async function deleteUserApiKey(userId) {
  await query(
    `update users
        set ai_api_key_alg     = null,
            ai_api_key_iv      = null,
            ai_api_key_tag     = null,
            ai_api_key_ct      = null,
            ai_api_key_preview = null,
            ai_api_key_set_at  = null
      where id = $1`,
    [userId],
  );
}

/**
 * Validate a key by issuing a tiny live request to Anthropic. Returns
 * `{ ok: true }` on 2xx, `{ ok: false, code }` on auth failure, or
 * throws on network / unexpected upstream errors so the caller can
 * decide whether to surface them.
 *
 * Cost: 1 input + 1 output token on the cheapest model. Under $0.0001.
 */
export async function testApiKeyAgainstAnthropic(key) {
  const trimmed = validateApiKeyShape(key);
  const client = new Anthropic({ apiKey: trimmed });
  try {
    await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1,
      messages: [{ role: 'user', content: 'hi' }],
    });
    return { ok: true };
  } catch (err) {
    const s = err?.status || 0;
    if (s === 401 || s === 403) return { ok: false, code: 'invalid_user_api_key' };
    if (s === 429) return { ok: false, code: 'upstream_rate_limited' };
    if (s >= 500) return { ok: false, code: 'upstream_unavailable' };
    if (s >= 400) return { ok: false, code: 'upstream_bad_request' };
    return { ok: false, code: 'ai_internal' };
  }
}
