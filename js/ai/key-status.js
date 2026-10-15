// js/ai/key-status.js — does the signed-in cloud user have an Anthropic API
// key on the server?
//
// The relay answers 412 no_user_api_key on every AI call without one, so a
// client that did not know offered Ask AI, AI Reconcile and the Insights
// cards, fired their requests on each page load and showed a raw
// "412 Precondition Failed". The app shell reads the key status once after
// sign-in (GET /api/ai/key, which never returns the key itself) and before
// the first page renders; isAiAvailable() then treats AI as unavailable while
// the server reports no key. Settings updates it when a key is saved or
// removed, and a 412 from any AI call records it, so the next render hides
// the entry points.
//
// `null` means not known (static mode, a guest, or the status request
// failed): AI stays as available as it was before this module existed, and an
// AI call that then meets a 412 records it.

/** @type {boolean | null} */
let serverHasKey = null;

/** True only when the server has said this user has no key. */
export function serverKeyMissing() {
  return serverHasKey === false;
}

/** @param {boolean | null} hasKey */
export function setServerHasKey(hasKey) {
  serverHasKey = hasKey;
}

/** Record a failed AI call: a 412 no_user_api_key means the key is missing. */
export function noteAiError(err) {
  if (err && err.code === 'no_user_api_key') serverHasKey = false;
}

/**
 * Read the status from the server. Never throws: a failure leaves the status
 * unknown.
 *
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<boolean | null>}
 */
export async function loadServerKeyStatus(fetchImpl = fetch) {
  try {
    const res = await fetchImpl('/api/ai/key', { credentials: 'same-origin', headers: { accept: 'application/json' } });
    if (!res.ok) return serverHasKey;
    const json = await res.json();
    if (typeof json?.hasKey === 'boolean') serverHasKey = json.hasKey;
  } catch { /* unknown stays unknown */ }
  return serverHasKey;
}
