// js/ai/client.js — thin browser wrapper around /api/ai/*. The server is a
// relay; the budget context built here is decrypted in browser memory and
// posted to the server, which forwards to Anthropic.

import { state } from '../app.js';
import { getLang } from '../ui/i18n.js';
import { buildContextFor } from './dispatch.js';
import { withCurrency } from './context-builder.js';
import { hasLocalKey } from './keystore.js';
import { serverKeyMissing, noteAiError, setServerHasKey } from './key-status.js';
import { sendMessages } from './transport.js';
// Importing consent.js also installs transport.js's consent gate. client.js
// is loaded by the app shell at startup, so the gate is in place before any
// AI surface can send; without it the transport refuses every request.
import { assertFreshConsent } from './consent.js';

export function isCloudMode() {
  return !!(typeof window !== 'undefined'
    && window.__BUNVELOPE_MODE
    && window.__BUNVELOPE_MODE.kind === 'cloud');
}

export function isGuestSession() {
  return !!state.budgetFolder?.__guest;
}

export function isAiAvailable() {
  if (!state.meta?.ai?.enabled) return false;
  // Cloud mode reaches Anthropic through the relay with a server-held key, so
  // it needs an authenticated session — a guest would get a 401. Static/FSAPI
  // mode has no server and no auth to fail: what it needs is a key in this
  // browser, and a guest with one is in exactly the same position as anyone
  // else on that origin.
  // A signed-in user whose server key status says none is set gets no AI
  // entry points (js/ai/key-status.js): every relay call would answer 412.
  if (isCloudMode()) return !isGuestSession() && !serverKeyMissing();
  return hasLocalKey();
}

/**
 * The card-level AI features (briefing, anomalies, health, …) call
 * /api/ai/insights, which only exists in cloud mode. The agent surfaces go
 * through js/ai/transport.js and work in both. Keep the two questions
 * separate so static mode shows the dialog without also showing cards that
 * cannot possibly load.
 */
export function isRelayFeatureAvailable() {
  return isAiAvailable() && isCloudMode();
}

// Card features call /api/ai/insights, which only exists in cloud mode.
// Anything driven by js/ai/transport.js works in both, so it must not be
// gated on the relay.
const RELAY_ONLY_FEATURES = new Set([
  'monthlyBriefing', 'anomaly', 'envelopeHealth', 'subscription',
  'whatif', 'reconcile', 'onboarding', 'portfolioInsight',
]);

export function isAiFeatureEnabled(name) {
  const available = RELAY_ONLY_FEATURES.has(name)
    ? isRelayFeatureAvailable()
    : isAiAvailable();
  if (!available) return false;
  const flags = state.meta?.ai?.perFeature || {};
  return flags[name] !== false;
}

async function aiFetch(path, body, signal) {
  // The card features post budget context here rather than through
  // transport.js, so they need the same consent gate.
  await assertFreshConsent();
  const res = await fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* keep null */ }
  if (!res.ok) {
    const err = new Error(
      (json && (json.message || json.error)) || `${res.status} ${res.statusText}`,
    );
    err.code = (json && json.error) || `http_${res.status}`;
    err.status = res.status;
    err.body = json;
    noteAiError(err);
    throw err;
  }
  return json || {};
}

export async function aiInsights(feature, opts = {}) {
  const { contextOverride, input, signal, noCache } = opts;
  // Every context gets the currency, including a caller-supplied override —
  // this is the one place they all pass through.
  const context = withCurrency(contextOverride ?? buildContextFor(feature), state);
  const locale = getLang();
  const body = { feature, context, locale };
  if (input) body.input = input;
  if (noCache) body.noCache = true;
  const model = state.meta?.ai?.model;
  if (model) body.model = model;
  return aiFetch('/api/ai/insights', body, signal);
}

const APPLY_FILTER_TOOL = {
  name: 'apply_filter',
  description: 'Apply a filter to the transactions list.',
  input_schema: {
    type: 'object',
    properties: {
      filter: {
        type: 'object',
        properties: {
          search: { type: 'string', description: 'Free-text payee or note substring.' },
          envelope: { type: 'string', description: 'Envelope id from the context.' },
          account: { type: 'string', description: 'Account id from the context.' },
          type: { type: 'string', enum: ['all', 'expense', 'income', 'transfer', 'fill', 'adjustment'] },
          status: { type: 'string', enum: ['all', 'posted', 'scheduled'] },
          dateFrom: { type: 'string', description: 'ISO yyyy-mm-dd.' },
          dateTo: { type: 'string', description: 'ISO yyyy-mm-dd.' },
        },
        additionalProperties: false,
      },
      explanation: {
        type: 'string',
        description: 'One sentence echoing the filter back, in the user\'s language.',
      },
    },
    required: ['filter', 'explanation'],
    additionalProperties: false,
  },
};

/**
 * Natural language → transactions filter.
 *
 * Routed through js/ai/transport.js rather than the old cloud-only
 * /api/ai/search relay, so the Transactions "Ask AI" control works in static
 * mode too — it was the last AI surface that did not.
 */
export async function aiSearch(input, opts = {}) {
  const { signal } = opts;
  const context = withCurrency(buildContextFor('search'), state);
  const message = await sendMessages({
    intent: 'search',
    tools: [APPLY_FILTER_TOOL],
    signal,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: `Budget:\n${JSON.stringify(context)}` },
        { type: 'text', text: `Locale: ${getLang()}` },
        { type: 'text', text: `Request: ${input}` },
      ],
    }],
  });

  if (message?.stop_reason === 'refusal') {
    const err = new Error('The model declined this request');
    err.code = 'ai_refused';
    throw err;
  }
  const block = (message?.content || [])
    .find((b) => b.type === 'tool_use' && b.name === 'apply_filter');
  if (!block || !block.input || typeof block.input !== 'object') {
    const err = new Error('AI returned no filter');
    err.code = 'ai_bad_response';
    throw err;
  }
  return block.input;
}

export async function clearAiCache() {
  const res = await fetch('/api/ai/cache', {
    method: 'DELETE',
    credentials: 'same-origin',
    headers: { accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`failed to clear cache: ${res.status}`);
  return res.json();
}

// ── BYOK: Anthropic API key management ────────────────────────────────
// Status / save / delete / test wrappers for /api/ai/key. The plaintext
// key is only ever sent up — never echoed back. Errors are normalized to
// the same `err.code` / `err.status` shape as aiFetch.

async function keyFetch(method, path, body) {
  const init = {
    method,
    credentials: 'same-origin',
    headers: { accept: 'application/json' },
  };
  if (body !== undefined) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await fetch(path, init);
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* keep null */ }
  if (!res.ok) {
    const err = new Error(
      (json && (json.message || json.error)) || `${res.status} ${res.statusText}`,
    );
    err.code = (json && json.error) || `http_${res.status}`;
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json || {};
}

export async function aiGetKeyStatus() {
  return keyFetch('GET', '/api/ai/key');
}

export async function aiSaveKey(apiKey) {
  const out = await keyFetch('PUT', '/api/ai/key', { apiKey });
  setServerHasKey(true);
  return out;
}

export async function aiDeleteKey() {
  const out = await keyFetch('DELETE', '/api/ai/key');
  setServerHasKey(false);
  return out;
}

export async function aiTestKey(apiKey) {
  return keyFetch('POST', '/api/ai/key/test', { apiKey });
}
