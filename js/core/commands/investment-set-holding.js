// Set a standalone holding, or edit metadata for a transaction-derived one.
// Numerical corrections to transaction-derived positions use dated rows.

import { listHoldings } from '../../engine/holdings.js';
import { getInvestmentsMeta } from '../investments-meta.js';
import { ok, fail } from '../result.js';
import { symbolKey, holdingOverrideEntry, investmentsPatch } from '../investment-fields.js';

export default {
  name: 'investment.setHolding',
  summary: 'Set a standalone holding. With transaction history, units and cost basis must match the computed position; use dated adjustments for corrections. Replaces any earlier override, so a name or price URL not given is cleared and omitted valuationOnly restores cost tracking.',
  input: {
    type: 'object',
    required: ['account', 'symbol', 'units', 'costBasis'],
    properties: {
      account: { type: 'ref', kind: 'account' },
      symbol: { type: 'string', description: 'Ticker or ISIN (stored uppercase)' },
      units: { type: 'number', description: 'Units held' },
      costBasis: { type: 'number', description: 'Total cost basis in the budget\'s currency' },
      valuationOnly: { type: 'boolean', description: 'Track current value only; exclude cost/gain calculations and investment tax reports (an explicit reporting choice, not a tax exemption)' },
      name: { type: 'string', description: 'Display name' },
      priceUrl: { type: 'string', description: 'Page the price is fetched from' },
    },
  },
  execute(data, input) {
    const sym = symbolKey(input.symbol);
    if (!sym) return fail('bad_input', { errors: [{ path: 'symbol', message: 'needs a symbol' }] });
    const entry = holdingOverrideEntry(input);
    const holding = listHoldings(data.transactions, {}, getInvestmentsMeta(data.meta).manualRows)
      .find(h => h.accountId === input.account && h.symbol === sym);
    if (holding && (Math.abs(holding.units - entry.units) >= 0.0000005 || Math.abs(holding.costBasis - entry.costBasis) >= 0.005)) {
      return fail('holding_has_history', { account: input.account, symbol: sym });
    }
    const meta = investmentsPatch(data.meta, (inv) => {
      inv.holdingOverrides[input.account] = { ...inv.holdingOverrides[input.account], [sym]: entry };
      return inv;
    });
    return ok({ changes: meta ? { meta } : {}, value: { account: input.account, symbol: sym } });
  },
};
