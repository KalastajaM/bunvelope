// js/core/repair-envelope-transfer-ids.js — one-time repair for envelope
// transfers written with the pre-v3 field names.
//
// The AI proposal writer and the envelope-move tool emitted `from_envelope` /
// `to_envelope` until 2026-08-26. Those are the shape the v2→v3 migration
// renamed (see `migrateV2toV3` in js/storage/fsapi-adapter.js); the engine has
// read `from_envelope_id` / `to_envelope_id` ever since.
//
// So an accepted AI transfer moved NO money in either envelope, and said
// nothing about it: `validateTxReferences` returns early on a falsy
// `from_envelope_id`, so the row resolved no ids, reported no problem, and
// rendered as an ordinary transfer on every surface that lists transactions.
// Fixing the writer does not repair rows already in the ledger — this does.
//
// The mapping is a rename, not a guess: the ids were always correct, only the
// key they were stored under was wrong. That is what makes an automatic repair
// defensible here where the `from_budget` relink deliberately asks first — the
// data cannot be read two ways.
//
// Pure. Idempotent: after a pass no bare field survives, so a second pass is a
// no-op. Preserves array and row identity when nothing changes, because the
// balance caches key on the identity of `state.transactions`
// (js/engine/balance-cache.js) and returning a fresh array on every load would
// bust every memo for nothing.

const BARE_TO_CANONICAL = [
  ['from_envelope', 'from_envelope_id'],
  ['to_envelope', 'to_envelope_id'],
];

function nonEmptyString(v) {
  return typeof v === 'string' && v.trim() !== '';
}

/**
 * Rewrite pre-v3 envelope-transfer endpoints onto their canonical keys.
 *
 * @param {Array} transactions
 * @param {{ envelopes?: Array }} [opts]
 *        Pass the envelope list to have the result report how many repaired
 *        endpoints no longer resolve. Those are NOT dropped — a dangling id is
 *        visible to `runInvariantCheck`, which is strictly better than the
 *        silence it replaces.
 * @returns {{ transactions: Array, repaired: number, rows: number, unresolved: string[] }}
 */
export function repairEnvelopeTransferIds(transactions, opts = {}) {
  if (!Array.isArray(transactions)) {
    return { transactions, repaired: 0, rows: 0, unresolved: [] };
  }

  const known = Array.isArray(opts.envelopes)
    ? new Set(opts.envelopes.map((e) => e && e.id).filter(Boolean))
    : null;

  let repaired = 0;
  let rows = 0;
  const unresolved = new Set();

  const out = transactions.map((tx) => {
    if (!tx || tx.type !== 'envelope_transfer') return tx;

    let next = null;
    for (const [bare, canonical] of BARE_TO_CANONICAL) {
      if (!(bare in tx)) continue;
      const value = tx[bare];
      // The canonical field wins if both are somehow present; the bare one is
      // dropped either way so the row cannot be repaired twice.
      const takeValue = !nonEmptyString(tx[canonical]) && nonEmptyString(value);
      if (!next) next = { ...tx };
      delete next[bare];
      if (takeValue) {
        next[canonical] = value;
        repaired += 1;
        if (known && !known.has(value)) unresolved.add(value);
      }
    }

    if (!next) return tx;
    rows += 1;
    return next;
  });

  if (rows === 0) {
    // Nothing matched — hand back the very same array so the caller's caches
    // stay warm.
    return { transactions, repaired: 0, rows: 0, unresolved: [] };
  }
  return { transactions: out, repaired, rows, unresolved: [...unresolved] };
}
