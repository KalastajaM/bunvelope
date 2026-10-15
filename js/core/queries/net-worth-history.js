// js/core/queries/net-worth-history.js — net worth and its parts at the
// month-ends of the months before `date`, and at `date` itself: the Net worth
// page's history chart (24 month-ends and today).
//
// The ledger as it stands (every row, any status, dated on or before each
// point), over the non-archived accounts: an account archived today is left
// out of every point, as it is of today's figure. `excludeAccounts` (the
// page filter) leaves accounts out of the totals; with none excluded the
// stored accounts array itself is passed, the identity the balance cache
// keys on.

import { ok } from '../result.js';
import { refDate } from '../lens-input.js';
import { isoDate } from '../context.js';
import { computeNetWorthHistory } from '../../engine/balances.js';
import { NONE, countedAccounts, roundedPoint } from '../projection.js';

export default {
  name: 'netWorth.history',
  summary: 'Net worth at the month-ends of the months before date (months of them, default 24), then at date itself: total and its parts (spending, savings, investment, pension, assets, loansGiven, debts, other) over the non-archived accounts, from every row dated on or before each point. excludeAccounts leaves accounts out of the figures.',
  input: {
    type: 'object',
    properties: {
      months: { type: 'integer', minimum: 1, maximum: 60, default: 24, description: 'How many month-ends before date (1-60, default 24)' },
      date: { type: 'date', description: 'The last point (YYYY-MM-DD, default today)' },
      excludeAccounts: { type: 'array', items: { type: 'ref', kind: 'account' }, description: 'Accounts left out of the figures' },
    },
  },
  /**
   * @param {any} data
   * @param {{ months: number, date?: string, excludeAccounts?: string[] }} input
   * @param {import('../context.js').Ctx} ctx
   */
  run(data, input, ctx) {
    const today = refDate(input, ctx);
    const accounts = data.accounts || NONE;
    const counted = countedAccounts(accounts, input.excludeAccounts);
    /** @type {string[]} */
    const dates = [];
    for (let k = input.months; k >= 1; k--) dates.push(isoDate(new Date(today.getFullYear(), today.getMonth() - k + 1, 0)));
    dates.push(isoDate(today));
    const history = computeNetWorthHistory(counted, data.transactions || NONE, dates);
    return ok({
      points: history.map(p => roundedPoint(p.date, p)),
    });
  },
};
