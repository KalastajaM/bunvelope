// js/ai/money-text.js — the app formats money in AI prose, not the model.
//
// The model writes every amount as ⟦amt:123.45⟧ (bare number, period decimal).
// formatAiText swaps each token for fmt(number), so currency, symbol, grouping
// and the minus sign follow the budget instead of whatever the model guessed.
//
// Pure and DOM-free, so it is unit-tested in node. Callers render the result
// with textContent; nothing here produces markup.

import { fmt } from '../utils.js';

const OPEN = '⟦';
const CLOSE = '⟧';
// The tag is matched case-insensitively and "amount" is accepted for "amt".
// (Spelled out rather than an /i flag so the uppercase ISO code below stays
// uppercase.)
const TAG = String.raw`(?:[aA][mM][tT]|[aA][mM][oO][uU][nN][tT]):`;
const PREFIXES = [`${OPEN}amt:`, `${OPEN}amount:`];
// A real token is short. Longer than this and it is not one, so a runaway
// opening bracket cannot hold back the rest of a streaming answer.
const MAX_TOKEN = 48;
// Set by drop(): a removed token leaves this marker so the whitespace around
// it can be collapsed in one pass. LONE marks a stray bracket the same way.
const GONE = '';
const LONE = '';
// The largest magnitude the app treats as money (validateAmount's cap).
const MAX_AMOUNT = 1e12;

const CURRENCY = String.raw`(?:[A-Z]{3}|[€$£¥₹])`;
const SEP_SPACES = String.raw`[ \u00a0\u202f]`;
const NOT_BRACKET = `[^\\s${OPEN}${CLOSE}]`;
// An unclosed token: mirror the closed grammar (currency and minus, each with
// optional spaces, before the digits; space-grouped thousands after) so what
// is read is what a closed token would read, or else the whole chunk is
// handed to the strict parser and dropped. Never a bare number left behind.
const UNCLOSED_NUMBER = `(?:${CURRENCY}\\s*)?(?:[-−]\\s*)?(?:${CURRENCY}\\s*)?\\d${NOT_BRACKET}*`
  + `(?:${SEP_SPACES}\\d{3}(?!\\d)${NOT_BRACKET}*)*`;
// One pass over the text, so a token's output is never re-read: group 1 is a
// closed body (any length: an invalid one drops the whole token), group 2 an
// unclosed chunk. Alternation order matters, closed is tried first.
const TOKEN_RE = new RegExp(
  `${OPEN}${TAG}(?:([^${OPEN}${CLOSE}]*)${CLOSE}|(?:\\s*(${UNCLOSED_NUMBER}|${NOT_BRACKET}+))?)`,
  'g',
);

// The three number shapes a token may hold. Anything else is not guessed at.
const PLAIN = /^\d+(?:\.\d{1,2})?$/;                    // 1234.56
const COMMA_THOUSANDS = /^\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?$/; // 1,234.56  1,234
const EUROPEAN = new RegExp(                            // 1.234,56  1 234,56  1234,56  12,5
  `^(?:\\d{1,3}(?:[. \\u00a0\\u202f]\\d{3})*|\\d+),\\d{1,2}$`,
);

/**
 * Read the number inside a token, strictly. A wrong amount is worse than none,
 * so anything that is not exactly one of the accepted shapes returns null:
 * exponents ("1e3"), suffixes ("1.5k"), two numbers, trailing junk, a comma
 * group that is not a thousands group ("1,2345"), more than two decimals.
 *
 * Allowed around the number: whitespace, at most one currency symbol or
 * uppercase ISO code, and one minus, all before the first digit.
 * @param {string} body
 * @returns {number|null}
 */
function parseAmount(body) {
  const m = String(body).trim().match(/^([^\d]*)(\d[\s\S]*)$/);
  if (!m) return null;
  const rest = m[2].trim();
  const before = m[1].replace(new RegExp(CURRENCY), '');   // at most one currency
  if (!/^\s*[-−]?\s*$/.test(before)) return null;
  let digits;
  if (PLAIN.test(rest)) digits = rest;
  else if (COMMA_THOUSANDS.test(rest)) digits = rest.replace(/,/g, '');
  else if (EUROPEAN.test(rest)) digits = rest.replace(/[. \u00a0\u202f]/g, '').replace(',', '.');
  else return null;
  const n = Number(digits);
  // Past the money cap a double has also lost precision, so both are dropped.
  if (!Number.isFinite(n) || n >= MAX_AMOUNT) return null;
  return /[-−]/.test(before) && n !== 0 ? -n : n;
}

function money(body, render) {
  const n = parseAmount(body);
  return n === null ? GONE : render(n);
}

/**
 * Replace ⟦amt:…⟧ tokens with app-formatted money. Text without tokens is
 * returned unchanged. A malformed or unclosed token never shows its brackets:
 * a number that parses (strictly) is formatted, anything else is dropped, and
 * the space it leaves is collapsed.
 *
 * With `partial: true` (text still streaming in) a trailing, not-yet-closed
 * token is held back rather than resolved, so a token split across deltas
 * never flashes half-formatted.
 *
 * @param {unknown} input
 * @param {{ partial?: boolean, render?: (n: number) => string }} [opts]
 *   render: how a parsed amount is written (default: the budget's `fmt`)
 * @returns {string}
 */
export function formatAiText(input, { partial = false, render = fmt } = {}) {
  let s = input == null ? '' : String(input);
  if (!s) return '';
  if (partial) {
    const at = s.lastIndexOf(OPEN);
    if (at >= 0 && s.indexOf(CLOSE, at) === -1) {
      const tail = s.slice(at);
      const lower = tail.toLowerCase();
      const couldBeToken = PREFIXES.some((p) => p.startsWith(lower)
        || (lower.startsWith(p) && tail.length <= MAX_TOKEN));
      if (couldBeToken) s = s.slice(0, at);
    }
  }
  if (!s.includes(OPEN) && !s.includes(CLOSE)) return s;
  return s
    .replace(TOKEN_RE, (_, closed, unclosed) => money(closed ?? unclosed ?? '', render))
    .replace(/[⟦⟧]/g, LONE)
    // A dropped token: remove it and one neighbouring space, never leave two.
    .replace(/([ \t])?([ \t])?/g, (_, l, r) => (l && r ? l : ''))
    // A stray bracket: remove it, keeping the space that was around it.
    .replace(/([ \t])?([ \t])?/g, (_, l, r) => l || r || '')
    .replace(/[]/g, '');
}

/**
 * Like formatAiText, but each token becomes the bare magnitude ("12.50"), for
 * text that is matched rather than read, such as a transactions search box:
 * a formatted "€ 12,50" would match nothing, while "12.50" is the exact-amount
 * search token. Sign is dropped because search compares magnitudes.
 * @param {unknown} input
 * @returns {string}
 */
export function bareAiNumbers(input) {
  return formatAiText(input, { render: (n) => Math.abs(n).toFixed(2) });
}

/**
 * Accumulate streamed text deltas. `raw` is what the model wrote (token and
 * all), which is what belongs in the stored conversation; `push` and `finish`
 * return the formatted text to show. The display is re-derived from the whole
 * raw text every time, so a token split across deltas comes out right.
 */
export function createAiStreamText() {
  let raw = '';
  return {
    /** @param {string} delta  @returns {string} text to show so far */
    push(delta) {
      raw += String(delta ?? '');
      return formatAiText(raw, { partial: true });
    },
    /** @returns {string} the final text, with any unclosed token resolved */
    finish() {
      return formatAiText(raw);
    },
    get raw() { return raw; },
  };
}
