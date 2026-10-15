// transaction.clear — mark rows cleared (reconciled against the bank) or
// not. Only the flag changes: no modified_at, as in the UI and in Budget.

import { ok, fail } from '../result.js';

export default {
  name: 'transaction.clear',
  summary: 'Set the cleared flag on transactions by id (cleared by default). Rows that already have the value are left alone. Fails on the first unknown id.',
  input: {
    type: 'object',
    required: ['ids'],
    properties: {
      ids: { type: 'array', items: { type: 'string' }, description: 'Transaction ids (at least one)' },
      cleared: { type: 'boolean', default: true },
    },
  },
  execute(data, input) {
    const { ids, cleared } = input;
    if (ids.length === 0) return fail('bad_input', { errors: [{ path: 'ids', message: 'needs at least one id' }] });
    const known = new Set(data.transactions.map(t => t.id));
    for (const id of ids) if (!known.has(id)) return fail('tx_not_found', { id });
    const target = new Set(ids);
    let changed = 0;
    const transactions = data.transactions.map(t => {
      if (!target.has(t.id) || t.cleared === cleared) return t;
      changed++;
      return { ...t, cleared };
    });
    return ok({ changes: changed ? { transactions } : {}, value: { changed } });
  },
};
