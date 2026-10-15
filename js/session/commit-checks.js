// js/session/commit-checks.js — the checks every write passes, whichever
// session commits it. They used to live at the end of a transaction write
// helper that only some writers went through, and that helper is gone; in a
// session they apply to all.

import { ok, fail } from '../core/result.js';
import { normalizeTransactionsForWrite, isKnownTxType } from '../engine/tx-amounts.js';
import { applyPayeeAliases, getPayeeAliases } from '../state/payee-aliases.js';
import { validateCollection } from '../storage/validators.js';

/**
 * The first row in `next` that is new, or retyped, and carries a type the
 * engine does not know. Legacy rows keeping the type they already had pass:
 * the invariant badge reports them, and refusing them would lock the budget.
 * @param {any[]} prev
 * @param {any[]} next
 */
export function firstUnknownTypeRow(prev, next) {
  if (!Array.isArray(next)) return null;
  const prevById = new Map();
  for (const tx of prev || []) {
    if (tx && typeof tx.id === 'string') prevById.set(tx.id, tx);
  }
  for (const tx of next) {
    if (!tx || typeof tx !== 'object') continue;
    if (isKnownTxType(tx.type)) continue;
    const old = prevById.get(tx.id);
    if (old && old.type === tx.type) continue;
    return tx;
  }
  return null;
}

/**
 * @param {Record<string, any>} before
 * @param {Record<string, any>} changes
 * @param {{ allowUnknownTypes?: boolean, applyAliases?: boolean }} [opts]
 */
export function applyCommitChecks(before, changes, { allowUnknownTypes = false, applyAliases = true } = {}) {
  const out = { ...changes };
  if (out.transactions) {
    const prev = before.transactions || [];
    if (!allowUnknownTypes) {
      const bad = firstUnknownTypeRow(prev, out.transactions);
      if (bad) {
        const type = bad.type === undefined || bad.type === null || bad.type === '' ? '(missing)' : String(bad.type);
        return fail('unknown_tx_type', { id: bad.id ?? null, type });
      }
    }
    const aliased = applyAliases
      ? applyPayeeAliases(prev, out.transactions, getPayeeAliases(out.meta ?? before.meta)).transactions
      : out.transactions;
    out.transactions = normalizeTransactionsForWrite(aliased);
  }
  for (const [kind, value] of Object.entries(out)) {
    const r = validateCollection(kind, value);
    if (!r.ok) return fail('invalid_collection', { kind, errors: r.errors.slice(0, 5) });
  }
  return ok(out);
}
