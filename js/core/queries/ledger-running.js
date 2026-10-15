// js/core/queries/ledger-running.js — the Transactions page's running balance
// for one account or one envelope: the balance after each row that touches it,
// and each day's movement and closing balance (the day headers).
//
// The rows are the page's own list (transactionsPageTxList): the stored rows,
// plus the scheduled preview when `showScheduled` is on (today to 30 days
// ahead, widened by dateFrom / dateTo). Deliberately lens-less: a ledger is
// the complete real history, and the Forecast lens's rows would double-count
// the preview. The walk always starts from the beginning of time, whatever the
// date range; the range only widens the preview.
//
//   rows  walk order (date ascending, list order within a day): per touching
//         row its balance after it and its step, the balance less the
//         previous row's (0 before the first, as the day headers count)
//   days  per day with a touching row, ascending: the day's total (its
//         closing balance less the previous such day's, 0 before the first)
//         and its closing balance

import { ok, fail } from '../result.js';
import { refDate } from '../lens-input.js';
import { monthCountry, monthTombstones } from '../month-fields.js';
import { transactionsPageTxList } from '../effective-txs.js';
import { computeEnvelopeRunningBalances, computeAccountRunningBalances } from '../../engine/balances.js';
import { round2 } from '../../utils.js';

/**
 * Each day's closing balance, as the page's day headers read it: the touching
 * rows sorted date ascending (list order within a day), the last balance of
 * each day kept.
 *
 * @param {any[]} effective  the page's list
 * @param {Map<any, number>} walk  balance after each touching row, by id
 * @returns {{ date: string, total: number, balance: number }[]}
 */
function dayRows(effective, walk) {
  const indexed = effective
    .map((tx, i) => ({ tx, i }))
    .filter(({ tx }) => walk.has(tx.id))
    .sort((a, b) => {
      const da = (a.tx.date || '').slice(0, 10);
      const db = (b.tx.date || '').slice(0, 10);
      if (da !== db) return da < db ? -1 : 1;
      return a.i - b.i;
    });
  /** @type {Map<string, number>} */
  const dayEnding = new Map();
  /** @type {string[]} */
  const orderedDays = [];
  for (const { tx } of indexed) {
    const d = (tx.date || '').slice(0, 10);
    if (!dayEnding.has(d)) orderedDays.push(d);
    dayEnding.set(d, /** @type {number} */ (walk.get(tx.id)));
  }
  return orderedDays.map((date, k) => {
    const ending = /** @type {number} */ (dayEnding.get(date));
    const prevDate = k > 0 ? orderedDays[k - 1] : null;
    const prevEnding = prevDate ? (dayEnding.get(prevDate) ?? 0) : 0;
    return { date, total: round2(ending - prevEnding), balance: round2(ending) };
  });
}

export default {
  name: 'ledger.running',
  summary: 'The running balance of one account or one envelope over the Transactions page\'s list (the stored rows, plus the scheduled preview with showScheduled): rows, in walk order (date ascending), each touching row\'s balance after it and its step from the previous row; days, each day\'s total movement and closing balance. Lens-less: the complete real history.',
  input: {
    type: 'object',
    properties: {
      account: { type: 'ref', kind: 'account', description: 'The account to walk (give this or envelope)' },
      envelope: { type: 'ref', kind: 'envelope', description: 'The envelope to walk (give this or account)' },
      showScheduled: { type: 'boolean', default: false, description: 'Add the scheduled preview: bills and template fills from today to 30 days ahead, earlier rows marked overdue' },
      dateFrom: { type: 'date', description: 'The list\'s date filter start: a start before today widens the preview back to it (YYYY-MM-DD)' },
      dateTo: { type: 'date', description: 'The list\'s date filter end: an end past the 30 days widens the preview to it (YYYY-MM-DD)' },
      date: { type: 'date', description: 'Today for the preview (YYYY-MM-DD, default today)' },
    },
  },
  /**
   * @param {any} data
   * @param {{ account?: string, envelope?: string, showScheduled: boolean, dateFrom?: string, dateTo?: string, date?: string }} input
   * @param {import('../context.js').Ctx} ctx
   */
  run(data, input, ctx) {
    if ((input.account === undefined) === (input.envelope === undefined)) {
      return fail('bad_input', { errors: [{ path: 'account', message: 'give exactly one of account or envelope' }] });
    }
    const effective = transactionsPageTxList({
      transactions:      data.transactions || [],
      budgetItems:       data.budgetItems || [],
      envelopeTemplates: data.envelopeTemplates || [],
      accounts:          data.accounts || [],
      envelopes:         data.envelopes || [],
      today:             input.date === undefined ? ctx.now : refDate(input, ctx),
      showScheduled:     input.showScheduled,
      dateFrom:          input.dateFrom ?? null,
      dateTo:            input.dateTo ?? null,
      country:           monthCountry(data),
      tombstones:        monthTombstones(data),
    });
    const walk = input.envelope !== undefined
      ? computeEnvelopeRunningBalances(effective, input.envelope)
      : computeAccountRunningBalances(data.accounts || [], effective, input.account);

    const rows = [];
    let prev = 0;
    for (const [id, balance] of walk) {
      rows.push({ id, balance: round2(balance), step: round2(balance - prev) });
      prev = balance;
    }
    return ok({ rows, days: dayRows(effective, walk) });
  },
};
