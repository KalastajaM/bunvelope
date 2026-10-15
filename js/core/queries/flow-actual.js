// js/core/queries/flow-actual.js — where a date range's money came from and
// where it went: the Money flow page's actual view.
//
// The stored rows, not a lens (a range of history), and posted rows only:
// income rows grouped by payee are the sources, spending is per envelope
// (investment buys and loan principal are not spending), and transfers across
// the saving boundary are saving or debt.

import { ok } from '../result.js';
import { RANGE_INPUT } from '../report-input.js';
import { FLOW_INPUT, flowOptions } from '../flow-input.js';
import { buildActualFlow } from '../../engine/flows.js';

export default {
  name: 'flow.actual',
  summary: 'The posted rows of a date range as a flow: nodes (income sources by payee, "(no payee)" without one, money from savings or borrowed, the budget, categories, envelopes, saving, debt repayment, unspent or shortfall; label is raw data or null, other counts the rows folded into an "Other" node), links between them and totals { in, out }. excludeEnvelopes leaves envelopes out.',
  input: {
    type: 'object',
    properties: {
      ...RANGE_INPUT,
      ...FLOW_INPUT,
    },
  },
  /**
   * @param {any} data
   * @param {{ from?: string, to?: string, excludeEnvelopes?: string[], topSources: number, topPerCategory: number }} input
   */
  run(data, input) {
    const range = { from: input.from ?? null, to: input.to ?? null };
    return ok(buildActualFlow(data.transactions || [], data.accounts || [], data.envelopes || [], range, flowOptions(input)));
  },
};
