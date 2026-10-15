// js/core/queries/reports-spending.js — what a date range spent, by envelope,
// by payee or by month: the Reports page's three spending charts.
//
// The stored rows, not a lens (a range of history). "Spent" is the Spending
// totals' rule (posted rows; investment buys and loan principal left out).
// By envelope and by payee, the top `topN` rows and the rest folded into
// `other: { count, value }`; by month, every month with spending.

import { ok } from '../result.js';
import { RANGE_INPUT, EXCLUDE_ENVELOPES, EXCLUDE_PAYEES, reportFlow, foldTop } from '../report-input.js';
import { aggregateSpendingByEnvelope, aggregatePayeeSpending, aggregateSpendingByMonth } from '../../engine/reports.js';

export default {
  name: 'reports.spending',
  summary: 'What the range spent (posted rows; investment buys and loan principal are not spending), grouped by envelope (label "Category · Name", "(Unknown)" for a missing envelope), by payee (the trimmed payee, "(no payee)" without one) or by month (only months with spending). Rows run largest first (by month: oldest first); by envelope and payee, rows past topN fold into other: { count, value }, null when nothing folds. excludeEnvelopes drops an envelope\'s split lines, excludePayees whole rows.',
  input: {
    type: 'object',
    required: ['groupBy'],
    properties: {
      groupBy: { enum: ['envelope', 'payee', 'month'], description: 'What a row is: an envelope, a payee or a month' },
      ...RANGE_INPUT,
      topN: { type: 'integer', minimum: 0, maximum: 100, default: 12, description: 'Rows before the rest folds into other (0 = every row; by envelope and payee only; default 12)' },
      excludeEnvelopes: EXCLUDE_ENVELOPES,
      excludePayees: EXCLUDE_PAYEES,
    },
  },
  /**
   * @param {any} data
   * @param {{ groupBy: 'envelope' | 'payee' | 'month', from?: string, to?: string, topN: number,
   *           excludeEnvelopes?: string[], excludePayees?: string[] }} input
   */
  run(data, input) {
    const { txs, range, opts } = reportFlow(data, input);
    const { groupBy } = input;
    if (groupBy === 'month') {
      return ok({ groupBy, rows: aggregateSpendingByMonth(txs, range, opts), other: null });
    }
    const all = groupBy === 'payee'
      ? aggregatePayeeSpending(txs, range, 0, opts)
      : aggregateSpendingByEnvelope(txs, data.envelopes || [], range, 0, opts);
    return ok({ groupBy, ...foldTop(all, input.topN) });
  },
};
