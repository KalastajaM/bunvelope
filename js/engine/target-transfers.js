// Target transfers are resolved only after the complete, deduplicated forecast
// is assembled. A stored transaction is always a fixed amount: editing a plan
// or importing later spending must never rewrite a payment already recorded.
import { applyAccountEffects } from './balances.js';
import { round2 } from '../utils.js';

/** @param {any} item @returns {boolean} */
export function isTargetTransfer(item) {
  return item?.kind === 'account_transfer' && item.transfer_mode === 'target_balance';
}

/** @param {any} row @returns {boolean} */
export function isPendingTargetTransfer(row) {
  return row?.type === 'account_transfer' && Number.isFinite(row.transfer_target_balance)
    && (row.is_forecast === true || row.target_transfer_pending === true);
}

/** Same-day income and spending precede top-ups; target rules keep plan order.
 * @param {any} a @param {any} b @returns {number}
 */
export function targetTransferOrder(a, b) {
  const ad = String(a?.date || '').slice(0, 10);
  const bd = String(b?.date || '').slice(0, 10);
  return ad < bd ? -1 : ad > bd ? 1 : Number(isPendingTargetTransfer(a)) - Number(isPendingTargetTransfer(b));
}

/** Resolve one row against the balance it meets. No reverse transfers and no
 * silent funding cap: the shortfall remains visible to projections and previews.
 * @param {any} row @param {Map<string, number>} balances @returns {any}
 */
export function resolveTargetTransfer(row, balances) {
  if (!isPendingTargetTransfer(row)) return row;
  const amount = Math.max(0, round2(row.transfer_target_balance - (balances.get(row.to_account) ?? 0)));
  const available = Math.max(0, balances.get(row.from_account) ?? 0);
  return { ...row, amount, funding_shortfall: Math.max(0, round2(amount - available)) };
}

/** Walk whole cents, retaining input order and identity for unaffected rows.
 * Zero forecasts remain as occurrences (and can become nonzero in a scenario).
 * Callers posting real rows discard zero amounts and the pending marker.
 * @param {any[]} accounts @param {any[]} rows @returns {any[]}
 */
export function resolveTargetTransfers(accounts, rows) {
  if (!rows.some(isPendingTargetTransfer)) return rows;
  const balances = new Map(accounts.filter(Boolean).map(a => [a.id, round2(Number(a.initialBalance) || 0)]));
  const resolved = new Map();
  for (const row of [...rows].sort(targetTransferOrder)) {
    const next = resolveTargetTransfer(row, balances);
    if (next !== row) resolved.set(row, next);
    applyAccountEffects(next, (id, delta) => balances.set(id, round2((balances.get(id) ?? 0) + round2(delta))));
  }
  return rows.map(row => resolved.get(row) || row);
}
