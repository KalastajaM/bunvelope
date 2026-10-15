// js/ui/router.js — hash routing, pure helpers.
//
// The URL carries only the page id (`#/transactions`), never the transient
// filter a page was opened with: filters are objects and ad-hoc strings that
// only make sense for the click that produced them, and a deep link to a
// stale filter is worse than landing on the unfiltered page.
//
// These functions take everything they need as arguments so they can be
// tested without a DOM; app.js owns the `location` / `history` side effects.

export const DEFAULT_ROUTE = 'dashboard';

/**
 * The page id a location hash names, or null when it names none of `known`.
 * Accepts `#/page`, `#page` and a trailing slash or query, so a hand-typed
 * link still works.
 *
 * @param {string} hash       e.g. location.hash
 * @param {Iterable<string>} known  registered page ids
 * @returns {string|null}
 */
export function parseRoute(hash, known) {
  if (typeof hash !== 'string') return null;
  let s = hash.replace(/^#/, '').replace(/^\/+/, '');
  s = s.split(/[?/]/)[0];
  if (!s) return null;
  try { s = decodeURIComponent(s); } catch { return null; }
  const set = known instanceof Set ? known : new Set(known);
  return set.has(s) ? s : null;
}

/**
 * @param {string} page
 * @returns {string} the hash for `page`, e.g. `#/transactions`
 */
export function serializeRoute(page) {
  return `#/${encodeURIComponent(page)}`;
}

/**
 * How navigate() should touch history for a render of `page`.
 *
 * - 'replace' on the first render after a budget loads: the entry the
 *   browser already has (the welcome screen's, or the deep link itself)
 *   becomes this page, so Back from the first page leaves the app rather
 *   than bouncing to an empty welcome screen.
 * - 'none' when the hash already names this page: that is a re-render
 *   after a write (`navigate(state.currentPage)`), or a render driven by
 *   Back/Forward, and neither may grow the history.
 * - 'push' otherwise: a real move to a different page.
 *
 * @param {{ page: string, currentHash: string, first: boolean }} args
 * @returns {'push'|'replace'|'none'}
 */
export function historyActionFor({ page, currentHash, first }) {
  const target = serializeRoute(page);
  if (first) return currentHash === target ? 'none' : 'replace';
  return currentHash === target ? 'none' : 'push';
}

/**
 * Which page the first render after a budget load should show: the deep
 * link when the caller asked for the default landing page, otherwise what
 * the caller asked for (a caller naming a specific page, or passing a
 * filter, knows better than a stale URL).
 *
 * @param {{ requested: string, filter: unknown, hash: string, known: Iterable<string> }} args
 * @returns {string}
 */
export function startupPage({ requested, filter, hash, known }) {
  if (requested !== DEFAULT_ROUTE || filter !== undefined) return requested;
  return parseRoute(hash, known) || DEFAULT_ROUTE;
}
