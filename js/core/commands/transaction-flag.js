// transaction.flag — set or clear the "look at this later" flag on rows. A
// flag is bookkeeping, not an edit: the row is not stripped, defaulted or
// re-validated (legacy rows that fail checkTxRow can still be flagged), and no
// creation time is invented. modified_at is stamped, as the old toggle did.

import { ok, fail } from '../result.js';

export default {
  name: 'transaction.flag',
  summary: 'Set the flagged marker on transactions by id (flagged by default). Rows that already have the value are left alone. Fails on the first unknown id.',
  input: {
    type: 'object',
    required: ['ids'],
    properties: {
      ids: { type: 'array', items: { type: 'string' }, description: 'Transaction ids (at least one)' },
      flagged: { type: 'boolean', default: true },
    },
  },
  execute(data, input, ctx) {
    const { ids, flagged } = input;
    if (ids.length === 0) return fail('bad_input', { errors: [{ path: 'ids', message: 'needs at least one id' }] });
    const known = new Set(data.transactions.map(t => t.id));
    for (const id of ids) if (!known.has(id)) return fail('tx_not_found', { id });
    const target = new Set(ids);
    const at = ctx.now.toISOString();
    let changed = 0;
    const transactions = data.transactions.map(t => {
      if (!target.has(t.id) || Boolean(t.flagged) === flagged) return t;
      changed++;
      return { ...t, flagged, modified_at: at };
    });
    return ok({ changes: changed ? { transactions } : {}, value: { changed } });
  },
};
