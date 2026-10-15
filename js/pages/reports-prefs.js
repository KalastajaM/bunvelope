// js/pages/reports-prefs.js — the Reports page's saved chart choices (picked
// envelopes; top-N and sort for Spending by envelope). They come back from
// localStorage (js/ui/charts/persist.js), so they are untrusted: every value
// is checked against what is allowed and what exists before it is used.
// Pure; no DOM.

export const MAX_PICKED_ENVELOPES = 6;
export const TOP_N_CHOICES = [5, 12, 0]; // 0 = all, no "Other" row
const SORTS = ['amount', 'name'];

/**
 * @param {Record<string, any>} prefs
 * @param {{ id: string, archived?: boolean }[]} envelopes
 * @returns {string[]}
 */
export function readEnvelopePicks(prefs, envelopes) {
  const active = new Set((envelopes || []).filter(e => e && !e.archived).map(e => e.id));
  const raw = Array.isArray(prefs?.envelopes) ? prefs.envelopes : [];
  const out = [];
  for (const id of raw) {
    if (typeof id !== 'string' || !active.has(id) || out.includes(id)) continue;
    out.push(id);
    if (out.length === MAX_PICKED_ENVELOPES) break;
  }
  return out;
}

/**
 * Picks to save when the envelope picker is applied. The picker only offers
 * envelopes the page does not exclude, so a saved pick that is currently
 * excluded (`excludedIds`) is kept after `appliedIds` rather than dropped;
 * it shows again once the envelope is included. Read back through
 * `readEnvelopePicks`, which caps the list.
 * @param {unknown} savedIds  the saved `prefs.envelopes`
 * @param {string[]} appliedIds
 * @param {Set<string>} excludedIds
 * @returns {string[]}
 */
export function picksToSave(savedIds, appliedIds, excludedIds) {
  const out = [...appliedIds];
  for (const id of Array.isArray(savedIds) ? savedIds : []) {
    if (typeof id === 'string' && excludedIds.has(id) && !out.includes(id)) out.push(id);
  }
  return out;
}

/** @returns {{ topN: number, sort: 'amount' | 'name' }} */
export function readTopNPrefs(prefs) {
  const topN = TOP_N_CHOICES.includes(prefs?.topN) ? prefs.topN : 12;
  const sort = SORTS.includes(prefs?.sort) ? prefs.sort : 'amount';
  return { topN, sort: /** @type {'amount' | 'name'} */ (sort) };
}

/**
 * The Spending by envelope rows (the `reports.spending` rows, its folded rest
 * last as the "Other (n)" row): 'amount' keeps the query's order (largest
 * first); 'name' sorts by label. The "Other (n)" row (key null) always stays
 * last. Returns a new array.
 */
export function sortEnvelopeRows(rows, sort) {
  if (sort !== 'name') return rows.slice();
  const other = rows.filter(r => r.key == null);
  const named = rows.filter(r => r.key != null).sort((a, b) => a.label.localeCompare(b.label));
  return [...named, ...other];
}

/**
 * Counts the real envelopes behind a `reports.spending` by-envelope answer:
 * each keyed row is one envelope, and the folded rest (`other`) is
 * `other.count` more.
 * @param {{ rows: { key: string|null }[], other: { count: number } | null }} answer
 * @returns {number}
 */
export function envelopeCount(answer) {
  return answer.rows.filter(r => r.key != null).length + (answer.other?.count ?? 0);
}
