// js/pages/fill-line.js — pure fill-line construction for the Fill envelopes
// sheet. Kept free of DOM/app imports so it can be unit-tested directly. The
// spare a pending fill leaves is the `fill.preview` query's (js/core).

function round2(n) { return Math.round(n * 100) / 100; }

/**
 * Build the fill line for a single row, or null for a no-op.
 *
 * Both modes emit an `add` line (a commutative delta on the envelope
 * balance). For `set` mode the stored amount is the delta needed to make the
 * envelope's projected balance equal the typed target — `target − curBal` —
 * NOT the absolute target. `curBal` is the projected balance shown in the
 * sheet, which already includes future-dated transactions, so adding the
 * delta lands the projected balance exactly on the target regardless of how
 * those future rows are ordered. Emitting an absolute `set` line instead would
 * overwrite the balance at today's date and let future rows re-apply on top,
 * silently changing nothing (the delta-vs-set-ordering bug).
 */
export function fillLineForRow({ envelopeId, mode, value, curBal }) {
  if (!Number.isFinite(value)) return null;
  const amount = mode === 'set' ? round2(value - curBal) : round2(value);
  if (amount === 0) return null;
  return { envelope_id: envelopeId, amount, mode: 'add' };
}
