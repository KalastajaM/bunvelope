// investment.renameSymbol — rename a symbol everywhere, in one commit: every
// transaction whose symbol matches (ignoring case) gets the new one, with no
// modified_at stamp, as the holding dialog's rename did; then prices, price
// history, holding overrides and manual rows (in every account) move to the
// new key, and payee rules pointing at the old symbol point at the new one.
// Where the new key already has a value the old one is dropped, not merged.
// `symbol` is a money field: the change log records the row edits, and
// strict-ledger refuses a rename touching a past posted row.

import { ok, fail } from '../result.js';
import { symbolKey, investmentsPatch } from '../investment-fields.js';

/** Move `obj[from]` to `obj[to]` unless `to` is taken; `from` goes either way. */
function moveKey(obj, from, to) {
  if (!obj || !obj[from]) return;
  if (!obj[to]) obj[to] = obj[from];
  delete obj[from];
}

export default {
  name: 'investment.renameSymbol',
  summary: 'Rename a symbol on every transaction and in prices, price history, holding overrides, manual rows and payee rules. Where the new symbol already has a price, override or rows, those are kept and the old ones dropped.',
  input: {
    type: 'object',
    required: ['from', 'to'],
    properties: {
      from: { type: 'string', description: 'The symbol to rename (matched ignoring case)' },
      to: { type: 'string', description: 'The new symbol (stored uppercase)' },
    },
  },
  execute(data, input) {
    const from = symbolKey(input.from);
    const to = symbolKey(input.to);
    /** @type {{ path: string, message: string }[]} */
    const errors = [];
    if (!from) errors.push({ path: 'from', message: 'needs a symbol' });
    if (!to) errors.push({ path: 'to', message: 'needs a symbol' });
    if (errors.length) return fail('bad_input', { errors });
    if (from === to) return ok({ changes: {}, value: { from, to, transactions: 0 } });

    /** @type {Record<string, any>} */
    const changes = {};
    let renamed = 0;
    const transactions = data.transactions.map(tx => {
      if (!tx?.symbol || symbolKey(tx.symbol) !== from) return tx;
      renamed++;
      return { ...tx, symbol: to };
    });
    if (renamed) changes.transactions = transactions;
    const meta = investmentsPatch(data.meta, (inv) => {
      moveKey(inv.prices, from, to);
      moveKey(inv.priceHistory, from, to);
      for (const bySym of Object.values(inv.holdingOverrides)) moveKey(bySym, from, to);
      for (const bySym of Object.values(inv.manualRows)) moveKey(bySym, from, to);
      for (const [payee, sym] of Object.entries(inv.payeeRules)) {
        if (symbolKey(sym) === from) inv.payeeRules[payee] = to;
      }
      return inv;
    });
    if (meta) changes.meta = meta;
    return ok({ changes, value: { from, to, transactions: renamed } });
  },
};
