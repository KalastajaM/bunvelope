// js/core/queries/envelopes-history.js — the envelopes' balance at each
// month-end, through the lens: the Reports page's balance history chart, its
// total line and a line per picked envelope.
//
// `months` month-ends, oldest first, the last being `date`'s month (its end,
// so a forecast lens shows the month's generated rows too). `date` moves only
// the month-ends: the lens is resolved at the query's clock (today). Rows without a
// date count in every month. `excludeEnvelopes` leaves envelopes out of the
// total; `envelopes` (at most six) are the picked lines, each whatever the
// exclusions, an envelope with no rows reading 0.

import { ok, fail } from '../result.js';
import { LENS_INPUT, lensRows, refDate } from '../lens-input.js';
import { EXCLUDE_ENVELOPES, monthPoints } from '../report-input.js';
import { computeEnvelopeBalanceHistory, computeEnvelopeBalanceHistoryByEnvelope } from '../../engine/history.js';

const MAX_ENVELOPES = 6;

export default {
  name: 'envelopes.history',
  summary: 'Envelope balances at each month-end through the lens, oldest first, the last being date\'s month (date moves the month-ends; the lens still reads today): totals (every envelope less excludeEnvelopes) and byEnvelope, a line per envelope named in envelopes (at most 6).',
  input: {
    type: 'object',
    properties: {
      ...LENS_INPUT,
      months: { type: 'integer', minimum: 1, maximum: 36, default: 12, description: 'How many month-ends, ending with date\'s month (1-36, default 12)' },
      date: { type: 'date', description: 'The day whose month ends the series; the lens still reads today (YYYY-MM-DD, default today)' },
      envelopes: { type: 'array', items: { type: 'ref', kind: 'envelope' }, description: `Envelopes to give a line of their own (at most ${MAX_ENVELOPES})` },
      excludeEnvelopes: EXCLUDE_ENVELOPES,
    },
  },
  /**
   * @param {any} data
   * @param {{ lens?: 'today' | 'booked' | 'forecast', horizon?: string, months: number, date?: string,
   *           envelopes?: string[], excludeEnvelopes?: string[] }} input
   * @param {import('../context.js').Ctx} ctx
   */
  run(data, input, ctx) {
    const picks = [...new Set(input.envelopes || [])];
    if (picks.length > MAX_ENVELOPES) {
      return fail('bad_input', { errors: [{ path: 'envelopes', message: `at most ${MAX_ENVELOPES} envelopes` }] });
    }
    const view = lensRows(data, input, ctx);
    if (!view.ok) return view;
    const { txs } = view.value;
    const ref = refDate(input, ctx);

    const history = computeEnvelopeBalanceHistory(txs, input.months, ref, { excludeIds: new Set(input.excludeEnvelopes || []) });
    const picked = picks.length ? computeEnvelopeBalanceHistoryByEnvelope(txs, input.months, ref, picks).byId : null;
    return ok({
      months: history.months,
      totals: monthPoints(history.totals),
      byEnvelope: picks.map(id => ({ id, points: monthPoints(/** @type {Map<string, any[]>} */ (picked).get(id) || []) })),
    });
  },
};
