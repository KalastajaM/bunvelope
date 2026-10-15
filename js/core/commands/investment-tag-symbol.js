// investment.tagSymbol — give existing investment rows a symbol, and nothing
// else: only `symbol` and `modified_at` change, as the unmapped-payees card
// always tagged them. Unlike transaction.amend no row is re-validated or
// normalised, so a legacy row the engine accepts (a sell without units, a row
// without a direction, a dividend still carrying a fee) is tagged as it is.
// For rows with no payee rule to remember (a blank or placeholder payee);
// investment.setPayeeRule with applyTo tags the same way and keeps the rule.
// `symbol` is a money field: the change log records the edits, and
// strict-ledger refuses a past posted row.

import { ok, fail } from '../result.js';
import { symbolKey, tagRowsWithSymbol, unknownTxIds } from '../investment-fields.js';

export default {
  name: 'investment.tagSymbol',
  summary: 'Set the symbol on existing transactions by id, changing nothing else on them. Rows already carrying the symbol are left alone.',
  input: {
    type: 'object',
    required: ['ids', 'symbol'],
    properties: {
      ids: { type: 'array', items: { type: 'string' }, description: 'Transaction ids to tag' },
      symbol: { type: 'string', description: 'Ticker or ISIN (stored uppercase)' },
    },
  },
  execute(data, input, ctx) {
    const sym = symbolKey(input.symbol);
    /** @type {{ path: string, message: string }[]} */
    const errors = [];
    if (!sym) errors.push({ path: 'symbol', message: 'needs a symbol' });
    errors.push(...unknownTxIds(data.transactions, input.ids, 'ids'));
    if (errors.length) return fail('bad_input', { errors });
    const { transactions, tagged } = tagRowsWithSymbol(data.transactions, input.ids, sym, ctx.now.toISOString());
    return ok({ changes: tagged ? { transactions } : {}, value: { symbol: sym, tagged } });
  },
};
