// js/core/queries/reports-balances.js — every envelope's balance through the
// lens, largest (either sign) first: the Reports page's current balances
// chart. Archived envelopes and ids no envelope has (rows charged to a
// deleted envelope) keep their balance, as the envelopes' sum does.

import { ok } from '../result.js';
import { LENS_INPUT, lensRows } from '../lens-input.js';
import { EXCLUDE_ENVELOPES } from '../report-input.js';
import { aggregateEnvelopeBalances } from '../../engine/reports.js';

export default {
  name: 'reports.balances',
  summary: 'Envelope balances through the lens, the largest topN by size (either sign) first, labelled "Category · Name" ("(Unknown)" for an id no envelope has); archived envelopes included. excludeEnvelopes leaves envelopes out.',
  input: {
    type: 'object',
    properties: {
      ...LENS_INPUT,
      topN: { type: 'integer', minimum: 0, maximum: 100, default: 15, description: 'How many envelopes (0 = every one; default 15)' },
      excludeEnvelopes: EXCLUDE_ENVELOPES,
    },
  },
  /**
   * @param {any} data
   * @param {{ lens?: 'today' | 'booked' | 'forecast', horizon?: string, topN: number, excludeEnvelopes?: string[] }} input
   * @param {import('../context.js').Ctx} ctx
   */
  run(data, input, ctx) {
    const view = lensRows(data, input, ctx);
    if (!view.ok) return view;
    const { lens, horizon, txs } = view.value;
    const rows = aggregateEnvelopeBalances(data.envelopes || [], txs, input.topN, { excludeEnvelopes: new Set(input.excludeEnvelopes || []) });
    return ok({ lens, horizon, rows });
  },
};
