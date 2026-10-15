// js/core/queries/plan-items.js — the Plan page's figures: every plan item's
// annual amount and a loan payment's rate, with the plan's totals.
//
// The plan is the dated view (`planItemsAsOf`, as of `date`; see
// tests/dated-plan-readers.test.js): an ended item counts nothing, one that
// starts later only its months from then. Unsaved live edits come as
// `itemOverrides`, laid over the stored items as the page's `viewOf` does
// (js/core/item-overrides.js), so a row, its section and the totals move with
// the user's hand before the update lands.
//
//   items   per item, in item order: `annual` (computeAnnual of the dated,
//           overlaid item: its months' magnitudes plus its buffer, a transfer
//           and a paused item included) and `loanRate` (a loan payment's
//           yearly % on `date`: its loan account's rate, else the item's
//           legacy `loan_rate`, else 0; null for every other kind)
//   totals  income, budget and diff (income minus budget) of the included
//           items, transfers left out (computeAnnualTotals)
//
// A section's or an envelope's sum is the caller's: a sum of the rows it
// shows. Money is round2'd on output.

import { ok } from '../result.js';
import { refDate } from '../lens-input.js';
import { isoDate } from '../context.js';
import { ITEM_OVERRIDES_INPUT, overlaid } from '../item-overrides.js';
import { computeAnnual, computeAnnualTotals } from '../../engine/monthly-review.js';
import { planItemsAsOf } from '../../engine/item-dates.js';
import { loanRateOn } from '../../engine/loan-terms.js';
import { round2 } from '../../utils.js';

/**
 * A loan payment's yearly rate on `day`, as the Plan row shows it.
 * @param {any} item
 * @param {any[]} accounts
 * @param {string} day  YYYY-MM-DD
 * @returns {number}
 */
function loanRateOf(item, accounts, day) {
  const loan = accounts.find((/** @type {any} */ a) => a && a.id === item.to_account_id);
  const rate = loan ? loanRateOn(loan, day) : null;
  return rate ?? (Number(item.loan_rate) || 0);
}

export default {
  name: 'plan.items',
  summary: 'The Plan page\'s figures over the plan\'s coming 12 months: per plan item (in plan order) its annual amount (its months plus its buffer, of the item as dated on date; a paused item and a transfer have one too) and, for a loan payment, loanRate (the loan account\'s yearly % on date, else the item\'s own legacy rate, else 0; null for other kinds); and totals: income, budget and diff (income minus budget) of the included items, transfers left out. itemOverrides lays unsaved plan-item edits over the stored items.',
  input: {
    type: 'object',
    properties: {
      date: { type: 'date', description: 'Today for the plan: its 12 months start here, items that ended before are out, and the loan rates are read on it (YYYY-MM-DD, default today)' },
      itemOverrides: ITEM_OVERRIDES_INPUT,
    },
  },
  /**
   * @param {any} data
   * @param {{ date?: string, itemOverrides?: { id: string, fields: Record<string, any> }[] }} input
   * @param {import('../context.js').Ctx} ctx
   */
  run(data, input, ctx) {
    const ref = refDate(input, ctx);
    const day = isoDate(ref);
    const accounts = data.accounts || [];
    const items = planItemsAsOf(overlaid(data.budgetItems || [], input.itemOverrides), ref);
    const { income, budget, diff } = computeAnnualTotals(items);
    return ok({
      items: items.filter(Boolean).map((/** @type {any} */ it) => ({
        id: it.id,
        annual: round2(computeAnnual(it)),
        loanRate: it.kind === 'loan_payment' ? loanRateOf(it, accounts, day) : null,
      })),
      totals: { income: round2(income), budget: round2(budget), diff: round2(diff) },
    });
  },
};
