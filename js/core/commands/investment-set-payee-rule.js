// investment.setPayeeRule — remember which symbol a payee's investment rows
// are, so new rows from that payee are tagged. With applyTo, the given rows
// get the symbol (and modified_at) in the same commit, as the unmapped-payees
// page and the add/edit backfill tag them. `symbol` is a money field, so the
// change log records those edits, and strict-ledger refuses a past posted row.

import { ok, fail } from '../result.js';
import { symbolKey, normalisePayeeKey, isMappablePayee, investmentsPatch, tagRowsWithSymbol, unknownTxIds } from '../investment-fields.js';

export default {
  name: 'investment.setPayeeRule',
  summary: 'Map a payee to a symbol, so its new investment rows are tagged with it. Not for the generic payees "Investment" and "Investment sale". applyTo also sets the symbol on those transactions, in the same commit.',
  input: {
    type: 'object',
    required: ['payee', 'symbol'],
    properties: {
      payee: { type: 'string', description: 'The payee name (matched ignoring case)' },
      symbol: { type: 'string', description: 'Ticker or ISIN (stored uppercase)' },
      applyTo: { type: 'array', items: { type: 'string' }, description: 'Transaction ids to tag with the symbol now' },
    },
  },
  execute(data, input, ctx) {
    const key = normalisePayeeKey(input.payee);
    const sym = symbolKey(input.symbol);
    /** @type {{ path: string, message: string }[]} */
    const errors = [];
    if (!isMappablePayee(input.payee)) errors.push({ path: 'payee', message: 'needs a payee name other than "Investment" or "Investment sale"' });
    if (!sym) errors.push({ path: 'symbol', message: 'needs a symbol' });
    const applyTo = input.applyTo ?? [];
    errors.push(...unknownTxIds(data.transactions, applyTo, 'applyTo'));
    if (errors.length) return fail('bad_input', { errors });

    /** @type {Record<string, any>} */
    const changes = {};
    const meta = investmentsPatch(data.meta, (inv) => {
      inv.payeeRules[key] = sym;
      return inv;
    });
    if (meta) changes.meta = meta;
    // The same symbol-only tag as investment.tagSymbol.
    const { transactions, tagged } = tagRowsWithSymbol(data.transactions, applyTo, sym, ctx.now.toISOString());
    if (tagged) changes.transactions = transactions;
    return ok({ changes, value: { payee: key, symbol: sym, tagged } });
  },
};
