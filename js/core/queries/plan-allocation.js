// js/core/queries/plan-allocation.js — what the plan sets aside per envelope
// over a year, largest first: the Reports page's budget allocation chart.
//
// The dated view of the plan (planItemsAsOf: the coming 12 months as of
// `date`, so an item that ended is out and one starting later counts only its
// months in the window). Expense items only: income and dividends, account
// transfers and items not included are skipped; each item's buffer counts.

import { ok } from '../result.js';
import { refDate } from '../lens-input.js';
import { EXCLUDE_ENVELOPES, foldTop } from '../report-input.js';
import { aggregateBudgetAllocation } from '../../engine/reports.js';
import { planItemsAsOf } from '../../engine/item-dates.js';

export default {
  name: 'plan.allocation',
  summary: 'The plan\'s coming 12 months per envelope (expense items included in the plan, their months plus their buffer), largest first, labelled "Category · Name"; rows past top fold into other: { count, value }, null when nothing folds. excludeEnvelopes leaves envelopes out.',
  input: {
    type: 'object',
    properties: {
      top: { type: 'integer', minimum: 0, maximum: 100, default: 10, description: 'Rows before the rest folds into other (0 = every row; default 10)' },
      date: { type: 'date', description: 'Today for this query: the 12 months start here and items that ended before are out (YYYY-MM-DD, default today)' },
      excludeEnvelopes: EXCLUDE_ENVELOPES,
    },
  },
  /**
   * @param {any} data
   * @param {{ top: number, date?: string, excludeEnvelopes?: string[] }} input
   * @param {import('../context.js').Ctx} ctx
   */
  run(data, input, ctx) {
    const items = planItemsAsOf(data.budgetItems || [], refDate(input, ctx));
    const all = aggregateBudgetAllocation(data.envelopes || [], items, 0, { excludeEnvelopes: new Set(input.excludeEnvelopes || []) });
    return ok(foldTop(all, input.top));
  },
};
