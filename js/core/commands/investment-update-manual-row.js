// investment.updateManualRow — replace a manual row's fields, keeping its id
// and its place in the list (normalizeManualRow, as when it was added). An
// unknown id is refused; the old writer silently wrote nothing.

import { ok, fail } from '../result.js';
import { symbolKey, normalizeManualRow, investmentsPatch, MANUAL_ROW_SCHEMA } from '../investment-fields.js';
import { getInvestmentsMeta } from '../investments-meta.js';

export default {
  name: 'investment.updateManualRow',
  summary: 'Replace the fields of a manual correction row, by id, keeping its place. Refused when the holding has no row with that id.',
  input: {
    type: 'object',
    required: ['account', 'symbol', 'id', 'row'],
    properties: {
      account: { type: 'string', description: 'Account id (also one no longer in the budget, to clean up what was left under it)' },
      symbol: { type: 'string', description: 'Ticker or ISIN (matched ignoring case)' },
      id: { type: 'string', description: 'The manual row\'s id' },
      row: MANUAL_ROW_SCHEMA,
    },
  },
  execute(data, input) {
    const sym = symbolKey(input.symbol);
    /** @type {{ path: string, message: string }[]} */
    const errors = [];
    if (!input.account.trim()) errors.push({ path: 'account', message: 'needs an account id' });
    if (!sym) errors.push({ path: 'symbol', message: 'needs a symbol' });
    if (errors.length) return fail('bad_input', { errors });
    const rows = getInvestmentsMeta(data.meta).manualRows[input.account]?.[sym];
    if (!Array.isArray(rows) || !rows.some(r => r?.id === input.id)) {
      return fail('bad_input', { errors: [{ path: 'id', message: `no manual row "${input.id}" for ${sym} in this account` }] });
    }
    const meta = investmentsPatch(data.meta, (inv) => {
      inv.manualRows[input.account][sym] = rows.map(r => (r?.id === input.id ? normalizeManualRow(input.row, input.id) : r));
      return inv;
    });
    return ok({ changes: meta ? { meta } : {}, value: { id: input.id } });
  },
};
