import { ok, fail } from '../result.js';
import { ITEM_FIELD_PROPERTIES, applyItemFields, checkItem } from '../entity-fields.js';
import { isTargetTransfer, resolveTargetTransfers } from '../../engine/target-transfers.js';
import { computeAccountBalances } from '../../engine/balances.js';
import { lensTransactions } from '../../engine/lens.js';
import { isoDate } from '../context.js';
import { round2 } from '../../utils.js';

/** Actual top-up at the given date; no forecast rows or future booked entries.
 * @param {any} data @param {any} item @param {string} date
 */
export function currentTransferPreview(data, item, date) {
  const balances = computeAccountBalances(data.accounts, data.transactions, { onlyPosted: true, asOf: date });
  const balance = balances.get(item.to_account_id) ?? 0;
  const amount = Math.max(0, round2(item.target_balance - balance));
  const available = Math.max(0, balances.get(item.account_id) ?? 0);
  return { date, balance, amount, fundingShortfall: Math.max(0, round2(amount - available)) };
}

export default {
  name: 'transfer.preview',
  summary: 'Preview a target-balance plan transfer, optionally with unsaved fields. Returns today (posted balance and amount needed) and next (the next scheduled estimate including forecast spending), with fundingShortfall. Writes nothing.',
  input: { type: 'object', properties: {
    id: { type: 'ref', kind: 'budgetItem' },
    fields: { type: 'object', properties: ITEM_FIELD_PROPERTIES },
  } },
  run(data, input, ctx) {
    const stored = input.id ? data.budgetItems.find(it => it.id === input.id) : null;
    const item = applyItemFields(stored || { id: '__transfer_preview__' }, input.fields || {}, { todayIso: ctx.todayIso, prev: stored });
    const bad = checkItem(item, data);
    if (bad) return fail(bad.code, bad.params);
    if (!isTargetTransfer(item)) return fail('bad_input', { errors: [{ path: 'transfer_mode', message: 'must be target_balance' }] });
    const horizon = isoDate(new Date(ctx.now.getFullYear(), ctx.now.getMonth() + 14, 0));
    const source = { ...data, budgetItems: stored
      ? data.budgetItems.map(it => it.id === stored.id ? item : it)
      : [...data.budgetItems, item] };
    // lens resolves after planned spend and deduplication. Keep zero occurrences
    // too so the preview can truthfully say nothing is needed next month.
    const rows = resolveTargetTransfers(data.accounts, lensTransactions(source, { lens: 'forecast', today: ctx.now, horizon }));
    const next = rows.filter(row => row.is_forecast && row.forecast_budget_item_id === item.id)
      .sort((a, b) => a.date.localeCompare(b.date))[0];
    return ok({ today: currentTransferPreview(data, item, ctx.todayIso), next: next
      ? { date: next.date, amount: next.amount, fundingShortfall: next.funding_shortfall || 0 } : null });
  },
};
