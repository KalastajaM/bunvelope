// transaction.delete — remove rows by id. A deleted materialised row leaves
// its from_budget key behind as a tombstone in meta, so the next open does not
// re-create it (see js/state/scheduled-tombstones.js).

import { ok, fail } from '../result.js';
import { TX_INPUT_PROPERTIES } from '../tx-fields.js';
import { tombstoneRemoval } from '../tombstones.js';

export default {
  name: 'transaction.delete',
  summary: 'Delete transactions by id. Rows created from a budget item or a rollover are remembered as tombstones so they are not re-created. Fails on the first unknown id.',
  input: {
    type: 'object',
    required: ['ids'],
    properties: {
      ids: { type: 'array', items: { type: 'string' }, description: 'Transaction ids (at least one)' },
      force: TX_INPUT_PROPERTIES.force,
    },
  },
  execute(data, input) {
    const { ids } = input;
    if (ids.length === 0) return fail('bad_input', { errors: [{ path: 'ids', message: 'needs at least one id' }] });
    const byId = new Map(data.transactions.map(t => [t.id, t]));
    for (const id of ids) if (!byId.has(id)) return fail('tx_not_found', { id });
    const drop = new Set(ids);
    const tomb = tombstoneRemoval(data, [...drop].map(id => byId.get(id)));
    /** @type {Record<string, any>} */
    const changes = { transactions: data.transactions.filter(t => !drop.has(t.id)) };
    if (tomb) changes.meta = tomb.meta;
    return ok({ changes, value: { deleted: drop.size, tombstones: tomb ? tomb.added : [] } });
  },
};
