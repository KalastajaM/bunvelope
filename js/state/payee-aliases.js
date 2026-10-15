// js/state/payee-aliases.js — remembered spellings and hidden payees.
//
// A merge in the tidy-up sheet records each spelling it folds away as an
// alias of the kept name (`meta.payeeAliases`), so the next import, AI
// proposal or manual entry with an old spelling arrives already renamed.
// Aliases apply to NEW rows only (owner decision 2026-09-28): existing rows
// change only through a merge. Hidden payees (`meta.payeeHidden`) are left
// out of pickers and suggestions; every total still counts them. Pure.

import { isEnvelopeInternal } from './payee-index.js';
import {
  payeeKey, resolvePayeeAlias, getPayeeAliases, addPayeeAliases, removePayeeAlias, getHiddenPayees, setPayeeHidden,
} from '../core/payee-fields.js';

const keyOf = payeeKey;

// The pure alias helpers live in core, where the payee commands use them;
// this file re-exports them for the pages, the guard and the tests.
export { getPayeeAliases, addPayeeAliases, removePayeeAlias, getHiddenPayees, setPayeeHidden };

/**
 * Rename rows that are new in this write (id not in `prevTxs`) whose payee is
 * an alias. Returns the same `nextTxs` array when nothing changes.
 * @param {any[]} prevTxs
 * @param {any[]} nextTxs
 * @param {Record<string, string>} aliases
 */
export function applyPayeeAliases(prevTxs, nextTxs, aliases) {
  if (!aliases || !Object.keys(aliases).length) return { transactions: nextTxs, renamed: 0 };
  const known = new Set((prevTxs || []).map(tx => tx && tx.id).filter(Boolean));
  let renamed = 0;
  const out = nextTxs.map(tx => {
    if (!tx || !tx.id) return tx;
    if (known.has(tx.id) || isEnvelopeInternal(tx)) return tx;
    const to = resolvePayeeAlias(tx.payee, aliases);
    if (!to || to === tx.payee) return tx;
    renamed += 1;
    return { ...tx, payee: to };
  });
  return { transactions: renamed ? out : nextTxs, renamed };
}

/**
 * `payees` lowercased, plus the kept name of any that are remembered
 * spellings: a choice recorded against an old spelling (e.g. an AI
 * subscription dismissal) then still applies after a merge renamed its rows.
 * @param {Iterable<unknown>} payees
 * @param {Record<string, string>} aliases
 * @returns {Set<string>}
 */
export function withAliasTargets(payees, aliases) {
  const out = new Set();
  for (const p of payees) {
    if (typeof p !== 'string') continue;
    const k = keyOf(p);
    if (!k) continue;
    out.add(k);
    const target = aliases[k];
    if (target) out.add(keyOf(target));
  }
  return out;
}
