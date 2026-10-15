// js/core/queries/upcoming.js — what is coming up, as the Dashboard's
// Upcoming card lists it.
//
//   coming   every stored row dated after `date` through `date` + days (any
//            type, any status), and the plan's and templates' forecast rows
//            in the same window, mixed and ordered by date
//   overdue  the forecast rows dated from the first of `date`'s month up to
//            the day before `date`: occurrences still expected that have not
//            been posted, ordered by date
//
// A forecast occurrence already posted (its `from_budget` key) or deleted
// (`meta.scheduledTombstones`) is left out. The plan items are passed
// undated, as the page does: the walker honours their start and end months
// itself. Each row is the stored or forecast row's own fields, untouched,
// plus `origin` ('ledger' | 'forecast') and `overdue`. The marker is not
// called `source`: a fill row has a `source` of its own ('allocation',
// 'new_income', 'pool_distribute') that the engine reads to decide whether
// the fill debits an account (txAccountDelta), so it must survive.

import { ok } from '../result.js';
import { isoDate } from '../context.js';
import { refDate } from '../lens-input.js';
import { monthCountry, monthTombstones } from '../month-fields.js';
import { takenOccurrenceKeys, targetEstimatesFor } from '../effective-txs.js';
import { forecastScheduledTransactions, forecastAllFills, forecastKey } from '../../engine/scheduling.js';

/** @param {any} row */
const dayOf = (row) => String(row.date).slice(0, 10);
/** Stable: rows on one day keep their order. @param {any} a @param {any} b */
const byDay = (a, b) => (dayOf(a) < dayOf(b) ? -1 : dayOf(a) > dayOf(b) ? 1 : 0);

export default {
  name: 'upcoming',
  summary: 'What is coming up: coming (stored rows dated after date through date + days, any status, and the forecast rows of the plan and the scheduled templates in that window, by date) and overdue (forecast rows from the first of date\'s month to the day before date that have not been posted, by date). Posted and deleted occurrences are left out. Each row is the row itself, unchanged, plus origin (ledger or forecast) and overdue.',
  input: {
    type: 'object',
    properties: {
      days: { type: 'integer', minimum: 1, maximum: 366, default: 30, description: 'How many days after date the window reaches (1-366, default 30)' },
      date: { type: 'date', description: 'Today for this query (YYYY-MM-DD, default today)' },
    },
  },
  /**
   * @param {any} data
   * @param {{ days: number, date?: string }} input
   * @param {import('../context.js').Ctx} ctx
   */
  run(data, input, ctx) {
    const ref = refDate(input, ctx);
    const todayStr = isoDate(ref);
    const monthStart = isoDate(new Date(ref.getFullYear(), ref.getMonth(), 1));
    const windowEndStr = isoDate(new Date(ref.getFullYear(), ref.getMonth(), ref.getDate() + input.days));
    const country = monthCountry(data);
    const transactions = data.transactions || [];

    const ledger = transactions
      .filter((/** @type {any} */ tx) => {
        const d = tx.date && dayOf(tx);
        return d && d > todayStr && d <= windowEndStr;
      })
      .map((/** @type {any} */ tx) => ({ ...tx, origin: 'ledger', overdue: false }));

    const rawForecasts = forecastScheduledTransactions(
      data.budgetItems || [], data.accounts || [], data.envelopes || [], ref, windowEndStr, monthStart, country,
      { transactions, pendingTargetTransfers: true },
    ).concat(forecastAllFills(
      data.budgetItems || [], data.envelopeTemplates || [], data.accounts || [], data.envelopes || [], ref, windowEndStr,
      { fromDateStr: monthStart, country },
    ));
    const taken = takenOccurrenceKeys(transactions, monthTombstones(data));
    const forecasts = targetEstimatesFor(data, rawForecasts
      .filter(f => !taken.has(forecastKey(f))), ref, windowEndStr)
      .map(f => ({ ...f, origin: 'forecast', overdue: f.date < todayStr }));

    return ok({
      overdue: forecasts.filter(f => f.overdue).sort(byDay),
      coming: ledger.concat(forecasts.filter(f => !f.overdue)).sort(byDay),
    });
  },
};
