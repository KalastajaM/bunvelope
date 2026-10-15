// server/ai/client.js — Anthropic SDK wrapper. Per-request client built
// from the caller-supplied API key (BYOK), prompt caching, JSON
// validation, error mapping.

import Anthropic from '@anthropic-ai/sdk';
import { FEATURES, clampModel, insightModelParams } from './prompts.js';
import { languageName } from '../../js/ai/intents.js';
import {
  cacheKey, getCached, setCached, indexUserKey, checkRate,
} from './cache.js';
import { getIntent, checkTools } from './agent-prompts.js';
import { FALLBACK_BETA, wantsFallback, markFallbackRejected } from '../../js/ai/fallback.js';

function getClient(apiKey) {
  if (!apiKey || typeof apiKey !== 'string') {
    throw new AiError('no_user_api_key', 'No Anthropic API key provided', 412);
  }
  return new Anthropic({ apiKey });
}

/**
 * Send a Messages request, with the server-side refusal fallback when the
 * model takes it (js/ai/fallback.js): a declined request is re-run on
 * Anthropic's recommended model for that refusal category, in the same call.
 * That needs the beta endpoint and header. If the API rejects the request
 * with a 400 and it then succeeds without the fallback, the fallback was the
 * problem: it is switched off for the rest of the process. A request that
 * fails both ways throws the second failure and leaves the fallback on.
 *
 * @param {Anthropic} client
 * @param {object} body  the Messages request (with `stream: true` to stream)
 * @param {object=} options  SDK request options (e.g. `signal`)
 */
async function createMessage(client, body, options) {
  if (!wantsFallback(body.model)) return client.messages.create(body, options);
  try {
    return await client.beta.messages.create({ ...body, betas: [FALLBACK_BETA], fallbacks: 'default' }, options);
  } catch (err) {
    if (!(err instanceof Anthropic.BadRequestError)) throw err;
    const plain = await client.messages.create(body, options);
    markFallbackRejected();
    return plain;
  }
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function buildMessages({ context, input }) {
  const userBlocks = [
    {
      type: 'text',
      text: '<budget_context>\n' + JSON.stringify(context) + '\n</budget_context>',
      cache_control: { type: 'ephemeral' },
    },
  ];
  if (input && typeof input === 'string' && input.trim()) {
    userBlocks.push({ type: 'text', text: 'User question: ' + input.trim() });
  }
  return [{ role: 'user', content: userBlocks }];
}

function buildSystem(featureSystem, locale) {
  return [
    {
      type: 'text',
      text: featureSystem,
      cache_control: { type: 'ephemeral' },
    },
    {
      type: 'text',
      text: `Language: ${languageName(locale)}. Write every human-readable string in this language.\nToday: ${todayIso()}`,
    },
  ];
}

function extractText(message) {
  for (const block of message.content || []) {
    if (block.type === 'text' && typeof block.text === 'string') return block.text;
  }
  return '';
}

function tryParseJson(text) {
  if (!text) return null;
  // Strip code fences if the model leaks them despite instructions.
  const trimmed = text.trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  try { return JSON.parse(trimmed); } catch { return null; }
}

function extractTokens(message) {
  const u = message?.usage || {};
  return {
    input: u.input_tokens || 0,
    output: u.output_tokens || 0,
    cache_creation: u.cache_creation_input_tokens || 0,
    cache_read: u.cache_read_input_tokens || 0,
  };
}

export class AiError extends Error {
  constructor(code, message, status = 500, extra = null) {
    super(message);
    this.code = code;
    this.status = status;
    this.extra = extra;
  }
}

function mapSdkError(err) {
  // Anthropic SDK errors expose `.status`. With BYOK, 401/403 means the
  // user's stored key is invalid or revoked — surface that distinctly so
  // the UI prompts to re-enter the key. Never propagate raw upstream text.
  const s = err?.status || 0;
  if (s === 401 || s === 403) return new AiError('invalid_user_api_key', 'AI provider rejected the API key', 401);
  if (s === 429) return new AiError('upstream_rate_limited', 'AI provider rate-limited the request', 429);
  if (s >= 500 && s < 600) return new AiError('upstream_unavailable', 'AI provider is unavailable', 502);
  if (s >= 400 && s < 500) return new AiError('upstream_bad_request', 'AI provider rejected the request', 502);
  return new AiError('ai_internal', 'AI request failed', 500);
}

/**
 * Run an analytical/conversational feature.
 * @param {object} args
 * @param {string} args.feature
 * @param {object} args.context
 * @param {'en'|'fi'|'nl'} args.locale
 * @param {string=} args.input
 * @param {string=} args.userId   (used for per-user rate-cap and cache scoping)
 * @param {boolean=} args.noCache (skip the response cache for this call)
 * @param {string=} args.modelOverride (server clamps to allowed models)
 * @param {string}  args.apiKey   user-supplied Anthropic API key (BYOK)
 * @param {object=} args.logger   (pino logger; optional)
 */
export async function runInsight(args) {
  const { feature, context, locale = 'en', input, userId, noCache, modelOverride, apiKey, logger } = args;
  const cfg = FEATURES[feature];
  if (!cfg) throw new AiError('bad_feature', `Unknown feature: ${feature}`, 400);

  // Sliding-window per-user cap.
  const rate = checkRate(userId, feature);
  if (!rate.ok) {
    throw new AiError('rate_limited', 'Too many requests', 429, { retry_after_ms: rate.retry_after_ms });
  }

  // Server-side response cache for deterministic features.
  let key = null;
  if (cfg.cacheable && !noCache) {
    key = cacheKey({ feature, context, locale, input, userId });
    const hit = getCached(key);
    if (hit) {
      logger?.info?.({ feature, userId, cache: 'hit' }, 'ai cache hit');
      return hit;
    }
  }

  const client = getClient(apiKey);
  const model = clampModel(modelOverride) || cfg.model;
  const t0 = Date.now();
  let message;
  try {
    message = await createMessage(client, {
      model,
      max_tokens: cfg.maxTokens,
      ...insightModelParams(model, cfg),
      system: buildSystem(cfg.system, locale),
      messages: buildMessages({ context, input }),
    });
  } catch (err) {
    logger?.warn?.({ feature, userId, err: err?.message }, 'ai upstream error');
    throw mapSdkError(err);
  }
  const ms = Date.now() - t0;
  const tokens = extractTokens(message);

  // A decline is an answer, not a malformed one: say so, and never cache it.
  if (message?.stop_reason === 'refusal') {
    logger?.warn?.({ feature, userId, ms, tokens, category: message?.stop_details?.category ?? null }, 'ai refused');
    throw new AiError('ai_refused', 'The model declined this request', 422);
  }

  const text = extractText(message);
  const parsed = tryParseJson(text);
  if (!parsed || typeof parsed !== 'object') {
    // The raw model text never leaves the process: it can echo budget context
    // back, the client has no use for it, and the logs are kept (request
    // bodies are redacted there for the same reason). Only its length is
    // logged, enough to tell an empty reply from a truncated or chatty one.
    logger?.warn?.({ feature, userId, ms, tokens, rawLength: typeof text === 'string' ? text.length : 0 }, 'ai bad response shape');
    throw new AiError('ai_bad_response', 'AI returned unparseable output', 502);
  }

  logger?.info?.({ feature, userId, ms, tokens, ok: true }, 'ai ok');

  if (key) {
    setCached(key, parsed);
    indexUserKey(userId, key);
  }
  return parsed;
}

/**
 * Raw Messages API relay for the agent surfaces.
 *
 * Unlike runInsight this returns the Message object untouched — the
 * browser owns the agent loop (it is the only place the budget is decrypted),
 * so the server cannot interpret tool calls on the user's behalf. What it does
 * still own is the system prompt and the tool allowlist: the client sends an
 * intent *name*, never prompt text, so this route cannot be turned into a
 * general-purpose proxy for the caller's key.
 *
 * No response cache — a conversation has no stable cache key. Prompt caching
 * on the stable prefix does that job instead.
 *
 * @param {object} args
 * @param {string} args.intent
 * @param {Array}  args.messages
 * @param {Array=} args.tools
 * @param {string=} args.modelOverride
 * @param {number=} args.maxTokens
 * @param {string} args.apiKey
 * @param {string=} args.userId
 * @param {object=} args.logger
 * @returns {Promise<object>} the raw Message
 */
/**
 * Validate a /messages request and build the upstream call.
 *
 * Shared by the streaming and non-streaming paths deliberately: they must
 * enforce the intent lookup, the system prompt, the tool allowlist and the
 * rate cap identically, and the way that stops being true is by writing the
 * checks out twice.
 */
function prepareMessagesRequest({ intent, messages, tools, modelOverride, maxTokens, userId }) {
  const cfg = getIntent(intent);
  if (!cfg) throw new AiError('bad_intent', `Unknown intent: ${intent}`, 400);

  if (!Array.isArray(messages) || messages.length === 0) {
    throw new AiError('bad_messages', 'messages must be a non-empty array', 400);
  }

  const toolCheck = checkTools(intent, tools);
  if (!toolCheck.ok) {
    throw new AiError('tool_not_allowed', `Tool not allowed for this intent: ${toolCheck.offending}`, 400);
  }

  const rate = checkRate(userId, `agent:${intent}`);
  if (!rate.ok) {
    throw new AiError('rate_limited', 'Too many requests', 429, { retry_after_ms: rate.retry_after_ms });
  }

  const model = clampModel(modelOverride) || cfg.model;
  const req = {
    model,
    max_tokens: Math.min(Number(maxTokens) || cfg.maxTokens, cfg.maxTokens),
    // The system prompt and tool list are the stable prefix; caching them is
    // what keeps a multi-turn conversation affordable.
    system: [{ type: 'text', text: cfg.system, cache_control: { type: 'ephemeral' } }],
    messages,
  };
  if (tools && tools.length) req.tools = tools;
  return { req, model };
}

export async function runMessages(args) {
  const { intent, apiKey, userId, logger } = args;
  const { req } = prepareMessagesRequest(args);
  const client = getClient(apiKey);

  const t0 = Date.now();
  let message;
  try {
    message = await createMessage(client, req);
  } catch (err) {
    logger?.warn?.({ intent, userId, err: err?.message }, 'ai upstream error');
    throw mapSdkError(err);
  }
  logger?.info?.(
    { intent, userId, ms: Date.now() - t0, tokens: extractTokens(message), stop: message?.stop_reason, ok: true },
    'ai messages ok',
  );
  return message;
}

/**
 * Streaming form of runMessages: forwards Anthropic's own event stream to the
 * caller verbatim.
 *
 * Verbatim is the point. The browser already parses this exact stream for the
 * direct path (js/ai/stream.js), so re-shaping it here would mean two formats
 * and two parsers for one feature. The relay stays a pipe.
 *
 * Everything the non-streaming form enforces — intent lookup, the system
 * prompt, the tool allowlist, the rate cap — happens before the first byte is
 * written, so a rejection is still a normal JSON error response.
 *
 * @param {object} args  as runMessages
 * @param {object} args.res  the Express response to write events to
 */
export async function runMessagesStream(args) {
  const { res, logger, intent, userId } = args;
  const { req } = prepareMessagesRequest(args);
  const client = getClient(args.apiKey);
  // The browser closing the tab (or the fetch being cancelled) must stop the
  // upstream generation too. Without this the relay kept reading the model's
  // stream to the end, billing tokens on the user's own key for a reader that
  // no longer exists. 'close' before the response finished is a disconnect;
  // after a normal res.end() it is just the socket winding down.
  const upstream = new AbortController();
  const onClose = () => {
    if (!res.writableFinished) upstream.abort();
  };
  res.on('close', onClose);
  let stream;
  try {
    stream = await createMessage(client, { ...req, stream: true }, { signal: upstream.signal });
  } catch (err) {
    res.off('close', onClose);
    if (upstream.signal.aborted) return;
    logger?.warn?.({ intent, userId, err: err?.message }, 'ai upstream error');
    throw mapSdkError(err);
  }

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    // Proxies that buffer a response defeat the entire point of streaming.
    'x-accel-buffering': 'no',
  });

  const t0 = Date.now();
  try {
    for await (const event of stream) {
      if (upstream.signal.aborted) break;
      res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      if (typeof res.flush === 'function') res.flush();
    }
  } catch (err) {
    if (upstream.signal.aborted) {
      res.off('close', onClose);
      logger?.info?.({ intent, userId, ms: Date.now() - t0 }, 'ai stream aborted by client');
      return;
    }
    // The headers are already out, so the only way to report a mid-stream
    // failure is as an event — which is exactly what the client's accumulator
    // turns back into a thrown error.
    logger?.warn?.({ intent, userId, err: err?.message }, 'ai stream broke');
    res.write(`event: error\ndata: ${JSON.stringify({
      type: 'error',
      error: { type: 'stream_error', message: 'The response was interrupted.' },
    })}\n\n`);
  }
  res.off('close', onClose);
  if (upstream.signal.aborted) {
    logger?.info?.({ intent, userId, ms: Date.now() - t0 }, 'ai stream aborted by client');
    return;
  }
  res.end();
  logger?.info?.({ intent, userId, ms: Date.now() - t0, ok: true }, 'ai messages stream done');
}
