// js/ai/keystore.js — Anthropic API key storage for browser-local and desktop.
// Desktop uses the narrow preload bridge for OS-encrypted persistence and never
// falls back to browser storage when that protection is unavailable.
//
// In cloud mode the key lives server-side, encrypted, in the users table
// (server/ai/user-keys.js) and the browser never sees it. There is no server
// in static mode, so the key has to live in the browser instead — which is a
// genuinely weaker posture, not an equivalent one. Anything running on this
// origin can read it. Settings says so in as many words; do not soften that
// copy.
//
// Every localStorage access is guarded: Safari in private mode throws on
// access rather than returning null, and a throw here would take down AI
// availability checks that run on every render.

const KEY = 'bv.ai.key';

function store() {
  try {
    return (typeof localStorage !== 'undefined') ? localStorage : null;
  } catch {
    return null;
  }
}

/** @returns {string|null} the stored key, or null when unset/unavailable. */
export function getLocalKey() {
  if (globalThis.bunvelopeDesktop) {
    try {
      let key = globalThis.bunvelopeDesktop.getKey();
      const legacy = store()?.getItem(KEY)?.trim();
      if (!key && legacy) {
        globalThis.bunvelopeDesktop.setKey(legacy);
        key = legacy;
      }
      if (key) store()?.removeItem(KEY);
      return key || null;
    } catch { return null; } // Never fall back to plaintext on desktop.
  }
  const s = store();
  if (!s) return null;
  try {
    const raw = s.getItem(KEY);
    const trimmed = (raw || '').trim();
    return trimmed || null;
  } catch {
    return null;
  }
}

/**
 * Store (or clear, when given an empty value) the local API key.
 * @param {string} key
 */
export function setLocalKey(key) {
  if (globalThis.bunvelopeDesktop) {
    globalThis.bunvelopeDesktop.setKey(String(key || '').trim());
    try { store()?.removeItem(KEY); } catch { /* OS store already committed. */ }
    return;
  }
  const s = store();
  if (!s) return;
  const trimmed = String(key || '').trim();
  try {
    if (trimmed) s.setItem(KEY, trimmed);
    else s.removeItem(KEY);
  } catch { /* quota or private mode — nothing sensible to do */ }
}

export function clearLocalKey() {
  if (globalThis.bunvelopeDesktop) { setLocalKey(''); return; }
  const s = store();
  if (!s) return;
  try { s.removeItem(KEY); } catch { /* see setLocalKey */ }
}

/** @returns {boolean} */
export function hasLocalKey() {
  return getLocalKey() !== null;
}

/**
 * Masked form for display — never render the key itself back into the DOM.
 * @param {string|null} key
 * @returns {string}
 */
export function maskKey(key) {
  const k = String(key || '');
  if (!k) return '';
  if (k.length <= 12) return '•'.repeat(k.length);
  return `${k.slice(0, 7)}…${k.slice(-4)}`;
}
