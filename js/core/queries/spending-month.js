// js/core/queries/spending-month.js — what a month consumed, as the
// Dashboard's Spending KPI and category donut show it.
//
//   spent       every row dated in the month, posted or not dated yet (a
//               posted row dated later in the month counts), by the engine's
//               consumption rule: investment buys and principal paid into a
//               loan account are balance-sheet moves, not spending. It reads
//               the stored rows, not a lens.
//   planned     the plan's annual total divided by 12 per envelope, summed
//               (computeMonthlyPlanByEnvelope), not the month's own calendar
//               entry. The plan items are the dated view as of `date` for
//               date's own month, as of the month's first day for any other.
//   daysLeft    only for date's own month.

import { ok } from '../result.js';
import { refDate, monthOf, MONTH_RE, badMonth } from '../lens-input.js';
import { loanAccountIds, txConsumptionPairs, txConsumptionTotal } from '../../engine/balances.js';
import { computeMonthlyPlanByEnvelope, buildExpenseCalendar } from '../../engine/monthly-review.js';
import { planItemsAsOf } from '../../engine/item-dates.js';
import { round2 } from '../../utils.js';

export default {
  name: 'spending.month',
  summary: 'What a month consumed against what the plan sets aside for it: spent (rows dated in the month, any status; investment buys and loan principal excluded), planned (legacy annual average), averageMonthlyFunding (same), calendarPlanned (selected month calendar total), calendarSpentPct (spent against that month), spentPct (spent of planned, capped at 100, 0 without a plan), daysLeft (days after date to the month\'s end; null for any month but date\'s own) and byCategory (spent per envelope category, "other" for an envelope with none, largest first).',
  input: {
    type: 'object',
    properties: {
      month: { type: 'string', description: 'The month, YYYY-MM (default the month of date)' },
      date: { type: 'date', description: 'Today for this query: picks the default month, daysLeft and the plan items still in force (YYYY-MM-DD, default today)' },
    },
  },
  /**
   * @param {any} data
   * @param {{ month?: string, date?: string }} input
   * @param {import('../context.js').Ctx} ctx
   */
  run(data, input, ctx) {
    if (input.month !== undefined && !MONTH_RE.test(input.month)) return badMonth();
    const ref = refDate(input, ctx);
    const month = input.month ?? monthOf(input.date ?? ctx.todayIso);
    const isOwnMonth = month === monthOf(input.date ?? ctx.todayIso);

    const loans = loanAccountIds(data.accounts);
    const envById = new Map((data.envelopes || []).map((/** @type {any} */ e) => [e.id, e]));
    let spent = 0;
    /** @type {Map<string, number>} */
    const byCat = new Map();
    for (const tx of data.transactions || []) {
      if (!String(tx.date || '').startsWith(month)) continue;
      spent += txConsumptionTotal(tx, loans);
      for (const [envId, amt] of txConsumptionPairs(tx, loans)) {
        const cat = envById.get(envId)?.category || 'other';
        byCat.set(cat, (byCat.get(cat) || 0) + amt);
      }
    }

    const [y, m] = month.split('-').map(Number);
    const asOf = isOwnMonth ? ref : new Date(y, m - 1, 1, 12, 0, 0);
    let planned = 0;
    for (const v of computeMonthlyPlanByEnvelope(planItemsAsOf(data.budgetItems || [], asOf)).values()) planned += v;

    let calendarPlanned = 0;
    for (const amounts of buildExpenseCalendar(planItemsAsOf(data.budgetItems || [], asOf)).values()) calendarPlanned += amounts[m] || 0;
    const calendarSpentPct = calendarPlanned > 0 ? Math.min(100, Math.round(spent / calendarPlanned * 100)) : 0;

    const spentPct = planned > 0 ? Math.min(100, Math.round((spent / planned) * 100)) : 0;
    const daysLeft = isOwnMonth
      ? Math.max(0, new Date(y, m, 0).getDate() - ref.getDate())
      : null;

    return ok({
      month,
      spent: round2(spent),
      planned: round2(planned), // Compatibility: annual average, as before.
      averageMonthlyFunding: round2(planned),
      calendarPlanned: round2(calendarPlanned),
      calendarSpentPct,
      spentPct,
      daysLeft,
      byCategory: [...byCat.entries()]
        // Ties keep first-seen order (Map insertion). The page's old
        // Object.entries order differed only for integer-like category names
        // (they sort first there); an envelope category is never one.
        .sort((a, b) => b[1] - a[1])
        .map(([category, amount]) => ({ category, amount: round2(amount) })),
    });
  },
};
