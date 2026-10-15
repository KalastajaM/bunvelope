// js/ai/fallback.js — server-side refusal fallback, shared by the relay
// (server/ai/client.js) and the direct browser transport (js/ai/transport.js).
//
// A safety classifier on the newer models can decline a benign request (a
// receipt, a bank statement); without a fallback the user only sees "the
// model declined". With `fallbacks: "default"` (beta header
// `server-side-fallback-2026-07-01`, Claude API only) the API re-runs a
// declined request on Anthropic's recommended model for that refusal
// category, inside the same call. Claude Sonnet 5.5 falls back only for
// `cyber` and `frontier_llm` declines; other categories still come back as a
// refusal, which the callers already handle.
//
// Nobody has run this against the live API from this app (BACKLOG
// 2026-09-29: a wrong header 400s every request). So it switches itself off:
// when a request carrying the fallback is rejected with a 400 and the same
// request then succeeds without it, the fallback is turned off for the rest
// of the process (server) or page (browser). A request that fails both ways
// leaves it on; the failure was not ours.
//
// Plain ES module, no browser globals: the server imports it too.

export const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

// The models that accept `fallbacks: "default"`. Haiku 4.5 (the cheap
// intents) and the older tiers do not run these classifiers' fallbacks, so
// they are sent exactly as before.
const FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5', 'claude-fable-5-1']);

let rejected = false;

/** Whether a request to `model` should carry the fallback. @param {unknown} model */
export function wantsFallback(model) {
  return !rejected && typeof model === 'string' && FALLBACK_MODELS.has(model);
}

/** The API refused the fallback itself: stop sending it. */
export function markFallbackRejected() {
  rejected = true;
}

/** For tests: forget a rejection. */
export function _resetFallbackForTests() {
  rejected = false;
}

/**
 * The content of a response, as it may be echoed back or acted on.
 *
 * After a model declines mid-answer and another continues, the content keeps
 * the declined model's partial output, then a `fallback` block marking the
 * switch. Its text is fine to keep (the continuation builds on it), but its
 * `thinking`, `redacted_thinking` and `tool_use` blocks, any
 * `server_tool_use` without its result, and any other model-internal block
 * belong to a model that refused:
 * echoing them back is invalid, and running a declined model's tool call
 * would act on a request that was refused. Everything after the last
 * `fallback` block is the serving model's own and is kept as is.
 *
 * Content without a `fallback` block is returned unchanged (same array).
 *
 * @param {Array<any>} content
 * @returns {Array<any>}
 */
export function contentAfterFallback(content) {
  if (!Array.isArray(content)) return content;
  let last = -1;
  for (let i = 0; i < content.length; i++) if (content[i]?.type === 'fallback') last = i;
  if (last < 0) return content;
  const before = content.slice(0, last);
  const answered = new Set(before
    .filter(b => b && typeof b.type === 'string' && b.type.endsWith('_tool_result') && b.tool_use_id)
    .map(b => b.tool_use_id));
  // Kept from before the switch: text, and server-tool calls with their
  // results. Anything else there (thinking, tool_use, a model-internal block
  // type this code does not know) is dropped.
  const kept = before.filter((b) => {
    if (!b || typeof b.type !== 'string') return false;
    if (b.type === 'text') return true;
    if (b.type === 'server_tool_use') return answered.has(b.id);
    return b.type.endsWith('_tool_result') && !!b.tool_use_id;
  });
  return [...kept, ...content.slice(last)];
}
