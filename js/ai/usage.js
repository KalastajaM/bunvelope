// js/ai/usage.js — what this session has cost.
//
// The user is spending their own Anthropic key, so "how much did that import
// cost me" should be answerable without going to a billing page. Every
// response carries a `usage` block; this accumulates it and prices it.
//
// Prices are per million tokens, from Anthropic's published rates. They will
// drift — the figure is an estimate for orientation, not an invoice, and the
// UI says so. Cached input is the part worth getting roughly right: a
// multi-turn conversation re-sends its whole prefix every turn, and at a tenth
// of the input rate that is the difference between a rounding error and a
// noticeable bill.
//
// Session-scoped and not persisted; a page reload starts the count over.

/**
 * USD per million tokens. `cacheRead` is given where it is not the usual tenth
 * of the input rate (Opus 5.5 reads its cache at $0.20, a twentieth).
 */
const PRICES = {
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2 },
  'claude-opus-5': { input: 5, output: 25 },
  'claude-opus-4-8': { input: 5, output: 25 },
  'claude-sonnet-5-5': { input: 2, output: 10 },
  'claude-sonnet-5': { input: 2, output: 10 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-haiku-4-5-20251001': { input: 1, output: 5 },
  'claude-haiku-4-5': { input: 1, output: 5 },
};

/** Unknown models fall back to the most expensive tier, so we never flatter. */
const FALLBACK = { input: 5, output: 25 };

const CACHE_WRITE_MULTIPLIER = 1.25;
const CACHE_READ_MULTIPLIER = 0.1;

function priceFor(model) {
  return PRICES[model] || FALLBACK;
}

const totals = {
  calls: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheWriteTokens: 0,
  cacheReadTokens: 0,
  costUsd: 0,
};

/**
 * Cost of one response, in USD.
 *
 * @param {object} usage  the `usage` block from a Message
 * @param {string} model
 * @returns {number}
 */
export function costOf(usage, model) {
  if (!usage) return 0;
  const p = priceFor(model);
  const input = Number(usage.input_tokens) || 0;
  const output = Number(usage.output_tokens) || 0;
  const cacheWrite = Number(usage.cache_creation_input_tokens) || 0;
  const cacheRead = Number(usage.cache_read_input_tokens) || 0;

  return (
    (input * p.input)
    + (output * p.output)
    + (cacheWrite * p.input * CACHE_WRITE_MULTIPLIER)
    + (cacheRead * (p.cacheRead ?? p.input * CACHE_READ_MULTIPLIER))
  ) / 1_000_000;
}

/**
 * Fold one response into the session total.
 *
 * Returns the message it was given, so it can wrap a transport's return value
 * without the caller restructuring anything.
 *
 * @param {object} message  a Message (or anything with `usage` and `model`)
 * @returns {object} the same message
 */
export function recordUsage(message) {
  const usage = message?.usage;
  if (!usage) return message;

  totals.calls += 1;
  totals.inputTokens += Number(usage.input_tokens) || 0;
  totals.outputTokens += Number(usage.output_tokens) || 0;
  totals.cacheWriteTokens += Number(usage.cache_creation_input_tokens) || 0;
  totals.cacheReadTokens += Number(usage.cache_read_input_tokens) || 0;
  totals.costUsd += costOf(usage, message.model);

  for (const fn of listeners) fn(getUsage());
  return message;
}

export function getUsage() {
  return { ...totals };
}

export function resetUsage() {
  totals.calls = 0;
  totals.inputTokens = 0;
  totals.outputTokens = 0;
  totals.cacheWriteTokens = 0;
  totals.cacheReadTokens = 0;
  totals.costUsd = 0;
  for (const fn of listeners) fn(getUsage());
}

const listeners = new Set();

/** Subscribe to changes. Returns an unsubscribe function. */
export function onUsageChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Human-readable cost. Below a cent, say so rather than printing "$0.00",
 * which reads as free when it is merely small.
 *
 * @param {number} usd
 * @returns {string}
 */
export function formatCost(usd) {
  if (!usd) return '$0.00';
  if (usd < 0.01) return '<$0.01';
  if (usd < 1) return `$${usd.toFixed(2)}`;
  return `$${usd.toFixed(2)}`;
}

/** Compact token count: 1234 → "1.2k". */
export function formatTokens(n) {
  const value = Number(n) || 0;
  if (value < 1000) return String(value);
  if (value < 1_000_000) return `${(value / 1000).toFixed(1)}k`;
  return `${(value / 1_000_000).toFixed(2)}M`;
}
