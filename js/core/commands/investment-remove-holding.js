// investment.removeHolding — drop a holding override, so the holding is again
// what the account's rows add up to. An account left with no override loses
// its key. Removing an override that is not there changes nothing.

import { ok, fail } from '../result.js';
import { symbolKey, investmentsPatch } from '../investment-fields.js';

export default {
  name: 'investment.removeHolding',
  summary: 'Remove standalone holding values and display metadata. Transaction-derived units and cost basis are unchanged.',
  input: {
    type: 'object',
    required: ['account', 'symbol'],
    properties: {
      account: { type: 'string', description: 'Account id (also one no longer in the budget, to clean up what was left under it)' },
      symbol: { type: 'string', description: 'Ticker or ISIN (matched ignoring case)' },
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
      const bySym = inv.holdingOverrides[input.account];
      if (bySym) {
        delete bySym[sym];
        if (Object.keys(bySym).length === 0) delete inv.holdingOverrides[input.account];
      }
      return inv;
    });
    return ok({ changes: meta ? { meta } : {}, value: { account: input.account, symbol: sym } });
  },
};
