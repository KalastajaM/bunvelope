// investment.removeManualRow — delete a manual correction row; a symbol left
// with no rows, and then an account left with no symbols, lose their keys.
// An id that is not there changes nothing.

import { ok, fail } from '../result.js';
import { symbolKey, investmentsPatch } from '../investment-fields.js';

export default {
  name: 'investment.removeManualRow',
  summary: 'Remove a manual correction row from a holding, by id.',
  input: {
    type: 'object',
    required: ['account', 'symbol', 'id'],
    properties: {
      account: { type: 'string', description: 'Account id (also one no longer in the budget, to clean up what was left under it)' },
      symbol: { type: 'string', description: 'Ticker or ISIN (matched ignoring case)' },
      id: { type: 'string', description: 'The manual row\'s id' },
    },
  },
  execute(data, input) {
    const sym = symbolKey(input.symbol);
    /** @type {{ path: string, message: string }[]} */
    const errors = [];
    if (!input.account.trim()) errors.push({ path: 'account', message: 'needs an account id' });
    if (!sym) errors.push({ path: 'symbol', message: 'needs a symbol' });
    if (errors.length) return fail('bad_input', { errors });
    const meta = investmentsPatch(data.meta, (inv) => {
      const bySym = inv.manualRows[input.account];
      const rows = bySym?.[sym];
      if (!Array.isArray(rows)) return inv;
      const next = rows.filter(r => r?.id !== input.id);
      if (next.length) bySym[sym] = next;
      else {
        delete bySym[sym];
        if (Object.keys(bySym).length === 0) delete inv.manualRows[input.account];
      }
      return inv;
    });
    return ok({ changes: meta ? { meta } : {}, value: { id: input.id } });
  },
};
