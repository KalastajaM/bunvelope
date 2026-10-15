// js/engine/tx-tags.js — Hashtag extraction from transaction notes.
//
// Users embed `#tagname` tokens in `tx.note` to group transactions across
// envelopes/accounts (e.g. trips, projects, gifts). Tags are lowercased on
// extraction so search/filter behave case-insensitively; the original casing
// is preserved verbatim in the note itself.
//
// A tag is `#` followed by 1+ characters from `[A-Za-z0-9_-]`, plus Unicode
// letters/digits for non-ASCII alphabets (Finnish ä/ö, etc.). The match
// stops at any other character, so `#trip-2026` and `#kahvi` both work.
// `#` characters that aren't preceded by whitespace / start-of-string are
// ignored, so URL fragments like `https://example.com/page#frag` don't get
// pulled in.
//
// Pure functions. No DOM, no I/O.

const TAG_RE = /(?:^|\s)#([\p{L}\p{N}_-]+)/gu;

/**
 * Extract unique hashtag names from a note string. Returns lowercased tag
 * names (no `#`) in first-seen order. Returns `[]` for empty / missing input.
 *
 * @param {string|null|undefined} note
 * @returns {string[]}
 */
export function extractTxTags(note) {
  if (!note || typeof note !== 'string') return [];
  const seen = new Set();
  const out = [];
  TAG_RE.lastIndex = 0;
  let m;
  while ((m = TAG_RE.exec(note)) !== null) {
    const tag = m[1].toLowerCase();
    if (!seen.has(tag)) { seen.add(tag); out.push(tag); }
  }
  return out;
}

/**
 * Returns true when `tx`'s note contains the given tag (case-insensitive,
 * exact match — not substring). Empty/missing tag returns false.
 */
export function txHasTag(tx, tag) {
  if (!tag) return false;
  const needle = String(tag).toLowerCase();
  const tags = extractTxTags(tx?.note);
  return tags.includes(needle);
}

/**
 * Collect all distinct tags across a transaction list, with usage counts.
 * Returns `[{ tag, count }]` sorted by count desc, then tag asc — the form
 * the suggestion UI consumes directly.
 *
 * @param {Array} transactions
 * @returns {Array<{tag: string, count: number}>}
 */
// Memoized per array identity: the write path always swaps in a new
// transactions array (balance-cache relies on the same invariant), so an
// entry stays valid for the array's lifetime. Called per keystroke by the
// tag-suggest popover.
const _tagsCache = new WeakMap();

export function collectAllTags(transactions) {
  if (!Array.isArray(transactions)) return [];
  const cached = _tagsCache.get(transactions);
  if (cached) return cached;
  const counts = new Map();
  for (const tx of transactions) {
    for (const tag of extractTxTags(tx?.note)) {
      counts.set(tag, (counts.get(tag) || 0) + 1);
    }
  }
  const out = Array.from(counts, ([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
  _tagsCache.set(transactions, out);
  return out;
}
