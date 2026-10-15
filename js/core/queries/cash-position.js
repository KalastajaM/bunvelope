// js/core/queries/cash-position.js — the money in the spending accounts, as
// the Dashboard's Spending accounts KPI shows it.
//
// All figures use non-archived spending accounts. Historical reports retain
// archived accounts; this card tracks the current operating accounts.
// The series does not follow the lens: each point is what had cleared by that
// month's end (posted rows only), and the last point is the end of `date`'s
// month, so it includes posted rows dated later in that month.

import { ok } from '../result.js';
import { isoDate } from '../context.js';
import { LENS_INPUT, lensRows, refDate, todayRows } from '../lens-input.js';
import { operationalAccounts } from '../operational.js';
import { computeNetWorth, computeAccountBalancesAtDates } from '../../engine/balances.js';
import { round2 } from '../../utils.js';

export default {
  name: 'cash.position',
  summary: 'The spending accounts\' balance through a lens, with notYetCleared (the lens minus today), both over the non-archived spending accounts. Also accountCount and a month-end series of what had cleared (posted rows, not the lens) over non-archived spending accounts, ending with the end of date\'s month, and delta, its last step.',
  input: {
    type: 'object',
    properties: {
      ...LENS_INPUT,
      months: { type: 'integer', minimum: 1, maximum: 24, default: 6, description: 'How many month-ends the series has, the last one the end of date\'s month (1-24, default 6)' },
      date: { type: 'date', description: 'The day the series ends on: its month\'s end is the last point (YYYY-MM-DD, default today)' },
    },
  },
  /**
   * @param {any} data
   * @param {{ lens?: 'today' | 'booked' | 'forecast', horizon?: string, months: number, date?: string }} input
   * @param {import('../context.js').Ctx} ctx
   */
  run(data, input, ctx) {
    const rows = lensRows(data, input, ctx);
    if (!rows.ok) return rows;
    const { lens, horizon, txs } = rows.value;
    const balance = computeNetWorth(data.accounts, txs).spending;
    const cleared = computeNetWorth(data.accounts, todayRows(data, ctx)).spending;

    const ref = refDate(input, ctx);
    /** @type {string[]} */
    const dates = [];
    for (let i = input.months - 1; i >= 0; i--) dates.push(isoDate(new Date(ref.getFullYear(), ref.getMonth() - i + 1, 0)));
    const snaps = computeAccountBalancesAtDates(data.accounts, data.transactions, { onlyPosted: true, dates });
    const active = operationalAccounts(data.accounts).filter(a => !a.archived);
    const opIds = new Set(active.map(a => a.id));
    const totals = snaps.map(bal => {
      let total = 0;
      for (const [id, v] of bal) if (opIds.has(id)) total += v;
      return total;
    });

    return ok({
      lens,
      horizon,
      balance: round2(balance),
      notYetCleared: round2(balance - cleared),
      accountCount: active.length,
      series: dates.map((date, k) => ({ date, balance: round2(totals[k]) })),
      delta: totals.length >= 2 ? round2(totals[totals.length - 1] - totals[totals.length - 2]) : null,
    });
  },
};
