// investment.addManualRow — add a correction row to a holding (a fee that was
// never ledgered, a share split, a bonus issue). Manual rows live only in
// meta.investments.manualRows: they change the holding, never an account
// balance. Stored as the Investments page stores them (normalizeManualRow),
// with an `m-` id from ctx.newId().

import { ok, fail } from '../result.js';
import { symbolKey, normalizeManualRow, investmentsPatch, MANUAL_ROW_SCHEMA } from '../investment-fields.js';

export default {
  name: 'investment.addManualRow',
  summary: 'Add a manual correction row to a holding (account and symbol). It changes the holding\'s units and cost basis, never an account balance. Returns { id }.',
  input: {
    type: 'object',
    required: ['account', 'symbol', 'row'],
    properties: {
      account: { type: 'ref', kind: 'account' },
      symbol: { type: 'string', description: 'Ticker or ISIN (stored uppercase)' },
      row: MANUAL_ROW_SCHEMA,
    },
  },
  execute(data, input, ctx) {
    const sym = symbolKey(input.symbol);
    if (!sym) return fail('bad_input', { errors: [{ path: 'symbol', message: 'needs a symbol' }] });
    const id = `m-${ctx.newId()}`;
    const meta = investmentsPatch(data.meta, (inv) => {
      const bySym = (inv.manualRows[input.account] ??= {});
      bySym[sym] = [...(bySym[sym] ?? []), normalizeManualRow(input.row, id)];
      return inv;
    });
    return ok({ changes: { meta }, value: { id } });
  },
};
