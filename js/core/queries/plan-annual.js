// js/core/queries/plan-annual.js — the plan's year against its income, as the
// Dashboard's annual plan card shows it.
//
// The totals are the dated view of the plan (the coming 12 months as of
// `date`); `hasIncluded` looks at the stored items, so a plan whose items have
// all ended still has something included. `status` is balanced within half a
// cent of the unrounded difference, else by its sign.

import { ok } from '../result.js';
import { refDate } from '../lens-input.js';
import { computeAnnualTotals } from '../../engine/monthly-review.js';
import { planItemsAsOf } from '../../engine/item-dates.js';
import { round2 } from '../../utils.js';

export default {
  name: 'plan.annual',
  summary: 'The plan\'s coming 12 months: income, budget and diff (income minus budget), status (balanced, deficit or surplus), coveragePct (the share of income the budget covers, capped at 100; the figure beside the card) and fillPct (the card\'s bar: budget as a share of income, capped at 100). hasIncluded is false when no plan item is included at all.',
  input: {
    type: 'object',
    properties: {
      date: { type: 'date', description: 'Today for this query: the 12 months start here and items that ended before are out (YYYY-MM-DD, default today)' },
    },
  },
  /**
   * @param {any} data
   * @param {{ date?: string }} input
   * @param {import('../context.js').Ctx} ctx
   */
  run(data, input, ctx) {
    const items = data.budgetItems || [];
    const hasIncluded = items.some((/** @type {any} */ it) => it.include !== false);
    const { income, budget, diff } = computeAnnualTotals(planItemsAsOf(items, refDate(input, ctx)));

    const isBalanced = Math.abs(diff) < 0.005;
    const status = isBalanced ? 'balanced' : diff > 0 ? 'surplus' : 'deficit';
    const coveragePct = income > 0.005
      ? Math.round(Math.min(budget, income) / income * 100)
      : (isBalanced ? 100 : 0);
    const fillPct = income > 0.005
      ? Math.min(100, Math.round(budget / income * 100))
      : (budget > 0 ? 100 : 0);

    return ok({ hasIncluded, income: round2(income), budget: round2(budget), diff: round2(diff), status, coveragePct, fillPct });
  },
};
