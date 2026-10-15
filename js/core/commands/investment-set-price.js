// investment.setPrice — store a symbol's price in the budget's currency, as
// the Investments page does by hand or on a refresh: rounded to 5 decimals,
// dated (today by default), with the conversion it came from when given, and
// recorded in the price history (one point per day). Only meta changes; the
// same price on the same day changes nothing.

import { ok, fail } from '../result.js';
import { symbolKey, priceEntry, appendPricePoint, investmentsPatch } from '../investment-fields.js';

export default {
  name: 'investment.setPrice',
  summary: 'Set a symbol\'s price (in the budget\'s currency) as of a date, default today, and record it in the price history. fx records the quote it was converted from; without fx an earlier conversion is dropped.',
  input: {
    type: 'object',
    required: ['symbol', 'price'],
    properties: {
      symbol: { type: 'string', description: 'Ticker or ISIN (stored uppercase)' },
      price: { type: 'number', minimum: 0, description: 'Price per unit in the budget\'s currency' },
      asOf: { type: 'date', description: 'Price date, YYYY-MM-DD (default today)' },
      preserveNewer: { type: 'boolean', default: false, description: 'Record historical prices without replacing a newer current quote' },
      fx: {
        type: 'object', nullable: true, required: ['currency', 'price', 'rate'],
        description: 'The quote the price was converted from',
        properties: {
          currency: { type: 'string', description: 'The quote\'s currency' },
          price: { type: 'number', description: 'The price in that currency' },
          rate: { type: 'number', description: 'The rate applied' },
        },
      },
    },
  },
  execute(data, input, ctx) {
    const sym = symbolKey(input.symbol);
    if (!sym) return fail('bad_input', { errors: [{ path: 'symbol', message: 'needs a symbol' }] });
    const entry = priceEntry(input.price, input.asOf ?? ctx.todayIso, input.fx);
    const meta = investmentsPatch(data.meta, (inv) => {
      if (!input.preserveNewer || !inv.prices[sym]?.asOf || entry.asOf >= inv.prices[sym].asOf) inv.prices[sym] = entry;
      inv.priceHistory[sym] = appendPricePoint(inv.priceHistory[sym], entry.asOf, entry.price);
      return inv;
    });
    return ok({ changes: meta ? { meta } : {}, value: { symbol: sym, price: entry.price, asOf: entry.asOf } });
  },
};
