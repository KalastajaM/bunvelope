// js/core/queries/spending-history.js — what each of the last months
// consumed, as the Dashboard's trend card shows it. Same rule as
// `spending.month.spent`: rows dated in the month, any status, minus
// investment buys and loan principal; the stored rows, not a lens.

import { ok } from '../result.js';
import { isoDate } from '../context.js';
import { refDate } from '../lens-input.js';
import { loanAccountIds, txConsumptionTotal } from '../../engine/balances.js';
import { round2 } from '../../utils.js';

export default {
  name: 'spending.history',
  summary: 'What each of the last months consumed (spent, as in spending.month), oldest first, the last one being date\'s own month.',
  input: {
    type: 'object',
    properties: {
      months: { type: 'integer', minimum: 1, maximum: 36, default: 6, description: 'How many months, ending with date\'s month (1-36, default 6)' },
      date: { type: 'date', description: 'The day whose month ends the series (YYYY-MM-DD, default today)' },
    },
  },
  /**
   * @param {any} data
   * @param {{ months: number, date?: string }} input
   * @param {import('../context.js').Ctx} ctx
   */
  run(data, input, ctx) {
    const ref = refDate(input, ctx);
    /** @type {string[]} */
    const keys = [];
    for (let i = input.months - 1; i >= 0; i--) keys.push(isoDate(new Date(ref.getFullYear(), ref.getMonth() - i, 1)).slice(0, 7));

    const loans = loanAccountIds(data.accounts);
    const totals = new Map(keys.map(k => [k, 0]));
    for (const tx of data.transactions || []) {
      const key = String(tx.date || '').slice(0, 7);
      if (totals.has(key)) totals.set(key, /** @type {number} */ (totals.get(key)) + txConsumptionTotal(tx, loans));
    }
    return ok({ months: keys.map(month => ({ month, spent: round2(/** @type {number} */ (totals.get(month))) })) });
  },
};
