// js/state/payee-index.js — Cached payee lookup for Add/Edit autocomplete.
// Built lazily: the first read after `state.transactions` changes rebuilds it.

import { isPostedTx } from '../engine/tx-amounts.js';
import { isEnvelopeInternal } from '../core/payee-fields.js';

// The transactions array each state's index was built from. A read whose
// state.transactions is a different array (or that was marked stale) rebuilds
// first, so the index can never answer from an older ledger, and a burst of
// writes costs one scan at the next autocomplete instead of one per write.
const builtFrom = new WeakMap();

// How far back a payee's uses count toward its rank.
const RANK_WINDOW_DAYS = 365;

/** `iso` (YYYY-MM-DD) moved by `days`, in UTC so no timezone can shift it. */
function shiftIsoDays(iso, days) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// isEnvelopeInternal lives in core, where payee.merge uses it.
export { isEnvelopeInternal };

/**
 * Rebuild state.payeeIndex (sorted array) and state.payeeIndexMap
 * (lowercase-keyed Map of the same entry references) from state.transactions.
 * Full scan; at 16k rows this costs ~5ms, which is why the write path only
 * marks the index stale and the readers below rebuild on demand.
 *
 * Order (the datalist shows matches in this order): payees used most in the
 * last year first, then most recent, then alphabetical. Only posted rows
 * count. It used to be most-recent-date first over every row, so a scheduled
 * instalment dated 2031 topped the list and a payee used weekly sat below
 * one-off rows (ux-review U16). The year is measured back from the newest
 * posted row, so the order needs no clock.
 *
 * Each entry keeps `lastTx` (the newest posted row, or the newest row at all
 * for a payee with only scheduled ones) and `lastEnvelopeId`, the envelope
 * of the newest posted single-envelope expense or income, for autofill when
 * the newest row was a split, with `lastBudgetItemId`, that same row's
 * budget-item link (fill %), or null.
 *
 * Casing note: when the same payee appears with different casing across
 * transactions, the displayed form is whichever casing appears on the
 * chronologically latest transaction — so late typos persist until overwritten.
 */
export function rebuildPayeeIndex(state) {
  const txs = state.transactions || [];
  let newestPosted = '';
  for (const tx of txs) {
    const d = (tx.date || '').slice(0, 10);
    if (d > newestPosted && isPostedTx(tx)) newestPosted = d;
  }
  const windowStart = newestPosted ? shiftIsoDays(newestPosted, -RANK_WINDOW_DAYS) : '';

  const byKey = new Map();
  for (const tx of txs) {
    if (isEnvelopeInternal(tx)) continue;
    const raw = (tx.payee || '').trim();
    if (!raw) continue;
    const key = raw.toLowerCase();
    let e = byKey.get(key);
    if (!e) {
      e = { payee: raw, lastDate: '', lastTx: null, uses: 0, lastEnvelopeId: null, lastBudgetItemId: null, anyTx: tx, anyDate: '', envDate: '' };
      byKey.set(key, e);
    }
    const date = tx.date || '';
    if (date > e.anyDate) { e.anyDate = date; e.anyTx = tx; }
    if (!isPostedTx(tx)) continue;
    if (!e.lastTx || date > e.lastDate) {
      e.lastTx = tx;
      e.lastDate = date;
      e.payee = raw;
    }
    if (date.slice(0, 10) >= windowStart) e.uses += 1;
    const env = tx.envelope_id;
    if ((tx.type === 'expense' || tx.type === 'income') && env && env !== '__none__' && date >= e.envDate) {
      e.lastEnvelopeId = env;
      e.lastBudgetItemId = typeof tx.budget_item_id === 'string' && tx.budget_item_id ? tx.budget_item_id : null;
      e.envDate = date;
    }
  }
  for (const e of byKey.values()) {
    if (!e.lastTx) { e.lastTx = e.anyTx; e.payee = (e.anyTx.payee || '').trim(); }
    delete e.anyTx; delete e.anyDate; delete e.envDate;
  }
  state.payeeIndex = [...byKey.values()].sort((a, b) =>
    b.uses - a.uses || b.lastDate.localeCompare(a.lastDate) || a.payee.localeCompare(b.payee)
  );
  state.payeeIndexMap = byKey;
  builtFrom.set(state, state.transactions);
}

/** Force the next read to rebuild, even if the array identity is unchanged. */
export function markPayeeIndexStale(state) {
  if (state && typeof state === 'object') builtFrom.delete(state);
}

function ensureFresh(state) {
  if (!state || !Array.isArray(state.transactions)) return;
  if (builtFrom.has(state) && builtFrom.get(state) === state.transactions) return;
  try {
    rebuildPayeeIndex(state);
  } catch (err) {
    console.error('rebuildPayeeIndex failed:', err);
  }
}

// Lowercased hidden payees (`meta.payeeHidden`), read at call time so a
// change to the hidden set shows without a ledger change (the index itself is
// cached by transactions identity). Same as getHiddenPayees in
// payee-aliases.js, kept local because that module imports
// isEnvelopeInternal from here and the two must not import each other.
function hiddenPayees(state) {
  const raw = state?.meta?.payeeHidden;
  return new Set(Array.isArray(raw) ? raw.filter(x => typeof x === 'string' && x) : []);
}

/** Index entries minus hidden payees. Lookups (findPayeeEntry) still see them. */
function visibleEntries(state) {
  const entries = state.payeeIndex || [];
  const hidden = hiddenPayees(state);
  return hidden.size ? entries.filter(e => !hidden.has(e.payee.toLowerCase())) : entries;
}

/** Top-N payee strings for datalist options (hidden payees left out). */
export function topPayees(state, n = 10) {
  ensureFresh(state);
  return visibleEntries(state).slice(0, n).map(e => e.payee);
}

/** All unique payee strings, most-used first (datalist typeahead), hidden left out. */
export function allPayees(state) {
  ensureFresh(state);
  return visibleEntries(state).map(e => e.payee);
}

/** Lookup an index entry by (trimmed, lower-cased) payee text. O(1) via Map. */
export function findPayeeEntry(state, payeeText) {
  const key = (payeeText || '').trim().toLowerCase();
  if (!key) return null;
  ensureFresh(state);
  return state.payeeIndexMap?.get(key) || null;
}
