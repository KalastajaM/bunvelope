// js/core/queries/flow-plan.js — where the plan's money comes from and where
// it goes, for one month or the year: the Money flow page's plan view.
//
// The month reads the plan as that month sees it (planItemsAsOf the month's
// first day) and each item's schedule entry for the month, without buffers.
// The year reads the dated plan as of `date` (the coming 12 months) and each
// item's year, buffers included.

import { computeScheduledOccurrences, loanOccurrenceSplit, loanOwedAt } from '../../engine/scheduling.js';
import { round2 } from '../../utils.js';
import { isoDate } from '../context.js';
import { ok, fail } from '../result.js';
import { refDate, monthOf, MONTH_RE, badMonth } from '../lens-input.js';
import { FLOW_INPUT, flowOptions } from '../flow-input.js';
import { buildPlanFlow } from '../../engine/flows.js';
import { planItemsAsOf, monthStartDate } from '../../engine/item-dates.js';

export default {
  name: 'flow.plan',
  summary: 'The plan as a flow, for a month or the year: nodes (income sources, money from savings or borrowed, the budget, categories, envelopes, saving, debt repayment, unspent or shortfall; label is raw data or null, other counts the rows folded into an "Other" node), links between them and totals { in, out }. Income items are the sources, expense items land in their envelopes, transfers across the saving boundary are saving or debt. excludeEnvelopes leaves envelopes out.',
  input: {
    type: 'object',
    required: ['period'],
    properties: {
      period: { enum: ['month', 'year'], description: 'One month of the plan, or the coming 12 months' },
      month: { type: 'string', description: 'The month, YYYY-MM (period month only; default the month of date)' },
      date: { type: 'date', description: 'Today for this query: the year\'s 12 months start here, and it picks the default month (YYYY-MM-DD, default today)' },
      ...FLOW_INPUT,
    },
  },
  /**
   * @param {any} data
   * @param {{ period: 'month' | 'year', month?: string, date?: string, excludeEnvelopes?: string[],
   *           topSources: number, topPerCategory: number }} input
   * @param {import('../context.js').Ctx} ctx
   */
  run(data, input, ctx) {
    const opts = flowOptions(input);
    const items = data.budgetItems || [];
    if (input.period === 'year') {
      if (input.month !== undefined) {
        return fail('bad_input', { errors: [{ path: 'month', message: 'only allowed with period month' }] });
      }
      const ref = refDate(input, ctx);
      return ok(buildPlanFlow(planItemsAsOf(items, ref), data.envelopes || [], data.accounts || [], { period: 'year' }, { ...opts, loanSplits: loanSplits(data, ref, 12, ctx.country) }));
    }
    if (input.month !== undefined && !MONTH_RE.test(input.month)) return badMonth();
    const month = input.month ?? monthOf(input.date ?? ctx.todayIso);
    return ok(buildPlanFlow(planItemsAsOf(items, monthStartDate(month)), data.envelopes || [], data.accounts || [], { period: 'month', month }, { ...opts, loanSplits: loanSplits(data, monthStartDate(month), 1, ctx.country) }));
  },
};

// Read each loan's schedule from the opening of the plan period, so payments
// already booked inside that period still belong to its full planned amount.
function loanSplits(data, ref, months, country) {
  const first = new Date(ref.getFullYear(), ref.getMonth(), 1);
  const from = isoDate(first);
  const until = isoDate(new Date(first.getFullYear(), first.getMonth() + months, 1)).slice(0, 7);
  const through = isoDate(new Date(first.getFullYear(), first.getMonth() + months, 0));
  const splits = new Map();
  for (const item of data.budgetItems || []) {
    if (item.kind !== 'loan_payment' || item.include === false || !(item.payment_day >= 1 && item.payment_day <= 31)) continue;
    const loan = (data.accounts || []).find(a => a.id === item.to_account_id && a.type === 'loan');
    if (!loan) continue;
    const occurrences = computeScheduledOccurrences({ ...item, as_schedule: true }, from, through, {
      dayType: item.schedule_day_type, country,
    }).filter(r => r.monthKey >= from.slice(0, 7) && r.monthKey < until);
    const opening = occurrences.reduce((day, r) => r.date < day ? r.date : day, from);
    const transactions = (data.transactions || []).filter(tx => tx.date < opening);
    let owed = loanOwedAt(loan, transactions, opening);
    let principal = 0, expense = months === 12 ? Math.abs(item.extra_buffer || 0) : 0;
    let prevDate = null;
    for (const occ of occurrences) {
      if (owed < 0.005) break;
      const split = loanOccurrenceSplit(item, loan, occ, owed, { prevDate, country });
      principal = round2(principal + split.principal);
      expense = round2(expense + split.interest + split.fee);
      owed = round2(owed - split.principal);
      prevDate = occ.date;
    }
    splits.set(item.id, { principal, expense });
  }
  return splits;
}
