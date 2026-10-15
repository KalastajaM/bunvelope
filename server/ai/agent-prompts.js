// server/ai/agent-prompts.js — server-side view of the agent intents.
//
// The prompts themselves live in js/ai/intents.js, which is a plain ES module
// with no browser globals so both sides can import it. One source of truth: a
// prompt cannot drift between cloud mode (where the server injects it) and
// static mode (where the client does).
//
// What this module adds is the enforcement the client cannot be trusted to do
// itself — resolving an intent name to a prompt, and refusing any tool the
// intent does not declare. Without that, POST /api/ai/messages would be an
// open proxy for the caller's own Anthropic key.

import { INTENTS, getIntent } from '../../js/ai/intents.js';

export { INTENTS, getIntent };

export const VALID_INTENTS = new Set(Object.keys(INTENTS));

/**
 * Check a client-supplied tool list against the intent's allowlist.
 * @param {string} intentName
 * @param {Array<{name?: string}>} tools
 * @returns {{ ok: true } | { ok: false, offending: string }}
 */
export function checkTools(intentName, tools) {
  const intent = getIntent(intentName);
  if (!intent) return { ok: false, offending: '' };
  for (const tool of (tools || [])) {
    const name = tool && typeof tool.name === 'string' ? tool.name : '';
    if (!intent.allowedTools.includes(name)) {
      return { ok: false, offending: name || '(unnamed)' };
    }
  }
  return { ok: true };
}
