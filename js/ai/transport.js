// js/ai/transport.js — the one place that knows *how* to reach Anthropic.
//
// Two paths, same signature:
//
//   relay   cloud mode (including `npm run dev:local`). POST /api/ai/messages;
//           the server attaches the caller's stored key. The browser never
//           holds a key.
//   direct  static / FSAPI mode. Raw fetch to the Messages API with the key
//           from js/ai/keystore.js.
//
// The direct path was verified against the live API on 2026-08-23: without
// `anthropic-dangerous-direct-browser-access: true` the browser blocks the
// request at CORS; with it, the preflight passes and the API answers
// normally. No SDK and no bundler are involved — this is a plain fetch.
//
// Nothing above this module knows which path ran.

import { getLocalKey, hasLocalKey } from './keystore.js';
import { getIntent } from './intents.js';
import { readMessageStream } from './stream.js';
import { recordUsage } from './usage.js';
import { FALLBACK_BETA, wantsFallback, markFallbackRejected } from './fallback.js';
import { noteAiError } from './key-status.js';

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const RELAY_URL = '/api/ai/messages';

export function isCloudMode() {
  return !!(typeof window !== 'undefined'
    && window.__BUNVELOPE_MODE
    && window.__BUNVELOPE_MODE.kind === 'cloud');
}

/**
 * Which transport would a call use right now?
 * @returns {'relay'|'direct'|null} null when neither is configured.
 */
export function transportKind() {
  if (isCloudMode()) return 'relay';
  if (hasLocalKey()) return 'direct';
  return null;
}

function transportError(message, code, status, body) {
  const err = new Error(message);
  err.code = code;
  if (status != null) err.status = status;
  if (body != null) err.body = body;
  return err;
}

async function readJson(res) {
  const text = await res.text();
  try { return text ? JSON.parse(text) : null; } catch { return null; }
}

function failFromResponse(res, json) {
  // Anthropic nests its message under `error`; our relay returns a flat
  // `{ error, message }`. Normalise both to the same shape callers see from
  // js/ai/client.js, so error handling does not fork by transport.
  const nested = json && json.error;
  const code = (nested && nested.type) || (json && json.error) || `http_${res.status}`;
  const message = (nested && nested.message)
    || (json && json.message)
    || `${res.status} ${res.statusText}`;
  return transportError(message, code, res.status, json);
}

/**
 * Send one Messages API request.
 *
 * @param {object} opts
 * @param {string}   opts.intent      Named prompt the server resolves. Never raw
 *                                    system text — that is what keeps the relay
 *                                    from being an open proxy for the user's key.
 * @param {Array}    opts.messages    Messages API `messages` array.
 * @param {Array=}   opts.tools       Tool definitions (name/description/input_schema).
 * @param {string=}  opts.model
 * @param {number=}  opts.maxTokens
 * @param {string|Array=} opts.system Direct path only; ignored by the relay,
 *                                    which resolves `intent` server-side.
 * @param {AbortSignal=} opts.signal
 * @returns {Promise<object>} the raw Message object.
 */
export async function sendMessages(opts) {
  const kind = transportKind();
  if (!kind) throw transportError('No AI transport configured', 'no_transport');
  await passConsentGate();
  if (kind === 'relay') return sendViaRelay(opts);
  return sendDirect(opts);
}

// ── Consent gate ─────────────────────────────────────────────────────────
// Every request leaves the browser through this module, so this is where the
// user's consent is enforced. It used to be checked only when AI was switched
// on: someone who agreed to v1 ("notes are stripped") kept sending notes via
// the agent's read tools after v2 changed that. js/ai/consent.js installs the
// gate (it holds the app state and the dialog, which this module must not
// import). With no gate installed nothing is sent: failing closed is the
// point.

let consentGate = null;

/** @param {(() => Promise<boolean>|boolean)|null} fn */
export function setConsentGate(fn) {
  consentGate = typeof fn === 'function' ? fn : null;
}

async function passConsentGate() {
  if (!consentGate || (await consentGate()) !== true) {
    throw transportError('AI consent is required before anything is sent', 'consent_required');
  }
}

/**
 * Same contract as `sendMessages`, but the answer arrives as it is written.
 *
 * `onText` fires per text delta; the resolved value is the same complete
 * Message either way, so callers that only want the end result can ignore it.
 * Both transports carry the same event stream — the relay forwards Anthropic's
 * verbatim — so js/ai/stream.js does the parsing once for both.
 *
 * @param {object} opts  as sendMessages, plus:
 * @param {(text: string) => void=} opts.onText
 */
export async function sendMessagesStream(opts) {
  const kind = transportKind();
  if (!kind) throw transportError('No AI transport configured', 'no_transport');
  await passConsentGate();
  if (kind === 'relay') return sendViaRelay({ ...opts, stream: true });
  return sendDirect({ ...opts, stream: true });
}

async function sendViaRelay({ intent, messages, tools, model, maxTokens, signal, stream, onText }) {
  const body = { intent, messages };
  if (tools && tools.length) body.tools = tools;
  if (model) body.model = model;
  if (maxTokens) body.max_tokens = maxTokens;
  if (stream) body.stream = true;

  const res = await fetch(RELAY_URL, {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      'content-type': 'application/json',
      accept: stream ? 'text/event-stream' : 'application/json',
    },
    body: JSON.stringify(body),
    signal,
  });

  // An error still comes back as JSON even when a stream was requested — the
  // server has not started writing events at the point it can still fail.
  // A 412 no_user_api_key also records that the server holds no key.
  if (!res.ok) {
    const err = failFromResponse(res, await readJson(res));
    noteAiError(err);
    throw err;
  }
  // Counted here rather than at the call sites: one place, and no surface can
  // forget to report what it spent.
  if (stream) return recordUsage(await readMessageStream(res, onText));

  return recordUsage((await readJson(res)) || {});
}

async function sendDirect({ intent, messages, tools, model, maxTokens, signal, stream, onText }) {
  const apiKey = getLocalKey();
  if (!apiKey) throw transportError('No local API key', 'no_user_api_key', 412);

  // In cloud mode the server resolves the intent to a system prompt. There is
  // no server here, so this does it — from the same js/ai/intents.js table the
  // server imports, so the two modes cannot drift apart.
  const cfg = getIntent(intent);
  if (!cfg) throw transportError(`Unknown intent: ${intent}`, 'bad_intent', 400);

  const body = {
    model: model || cfg.model,
    max_tokens: Math.min(Number(maxTokens) || cfg.maxTokens, cfg.maxTokens),
    system: [{ type: 'text', text: cfg.system, cache_control: { type: 'ephemeral' } }],
    messages,
  };
  if (stream) body.stream = true;
  if (tools && tools.length) {
    const offending = tools.find((tool) => !cfg.allowedTools.includes(tool?.name));
    if (offending) {
      throw transportError(`Tool not allowed for this intent: ${offending.name}`, 'tool_not_allowed', 400);
    }
    body.tools = tools;
  }

  const post = (payload, beta) => fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
      'anthropic-dangerous-direct-browser-access': 'true',
      ...(beta ? { 'anthropic-beta': beta } : {}),
    },
    body: JSON.stringify(payload),
    signal,
  });

  // The server-side refusal fallback, as the relay sends it
  // (js/ai/fallback.js): a 400 that goes away without it switches it off.
  let res;
  if (wantsFallback(body.model)) {
    res = await post({ ...body, fallbacks: 'default' }, FALLBACK_BETA);
    if (res.status === 400) {
      const plain = await post(body, null);
      if (plain.ok) markFallbackRejected();
      res = plain;
    }
  } else {
    res = await post(body, null);
  }

  if (!res.ok) throw failFromResponse(res, await readJson(res));
  if (stream) return recordUsage(await readMessageStream(res, onText));

  return recordUsage((await readJson(res)) || {});
}

/**
 * Validate a candidate key by making the smallest possible real request.
 * Used by Settings before saving, so a typo is caught at entry rather than at
 * the first import.
 *
 * @param {string} candidate
 * @returns {Promise<{ok: boolean, code?: string, message?: string}>}
 */
export async function testDirectKey(candidate) {
  const key = String(candidate || '').trim();
  if (!key) return { ok: false, code: 'bad_api_key', message: 'No key given' };

  let res;
  try {
    res = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': ANTHROPIC_VERSION,
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
  } catch (err) {
    // A network-level failure here is almost always the browser blocking the
    // request, not a bad key — say so rather than blaming the key.
    return { ok: false, code: 'network', message: String(err?.message || err) };
  }

  if (res.ok) return { ok: true };
  const json = await readJson(res);
  const err = failFromResponse(res, json);
  return { ok: false, code: err.code, message: err.message };
}
