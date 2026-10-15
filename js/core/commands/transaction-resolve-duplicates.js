// transaction.resolveDuplicates — the duplicates cleanup. Each group names the
// row to keep and the copies to drop. A copy that came from a plan occurrence
// carries a from_budget key; the keeper takes it when it has none, so the
// occurrence stays settled and is not posted again. That is why no tombstone
// is written (unlike transaction.delete): the key lives on in the keeper, and
// the command never touches meta.

import { ok, fail } from '../result.js';
import { TX_INPUT_PROPERTIES } from '../tx-fields.js';

const keyOf = (tx) => (typeof tx.from_budget === 'string' && tx.from_budget ? tx.from_budget : null);
const bad = (path, message) => fail('bad_input', { errors: [{ path, message }] });

export default {
  name: 'transaction.resolveDuplicates',
  summary: 'Clean up duplicate transactions: for each group keep one row and remove the copies. A keeper without a budget-item link takes the group\'s link so the occurrence is not posted again. Fails on the first unknown id. Returns { removed }.',
  input: {
    type: 'object',
    required: ['groups'],
    properties: {
      groups: {
        type: 'array',
        description: 'The duplicate groups to resolve (at least one); a row may appear in only one',
        items: {
          type: 'object',
          required: ['keep', 'drop'],
          properties: {
            keep: { type: 'string', description: 'Id of the transaction to keep' },
            drop: { type: 'array', items: { type: 'string' }, description: 'Ids of the copies to remove (at least one)' },
          },
        },
      },
      force: TX_INPUT_PROPERTIES.force,
    },
  },
  execute(data, input, ctx) {
    const { groups } = input;
    if (groups.length === 0) return bad('groups', 'needs at least one group');
    // A null row (a corrupt ledger) is passed through untouched, as the old helper did.
    const byId = new Map(data.transactions.filter(Boolean).map(t => [t.id, t]));
    for (const g of groups) {
      for (const id of [g.keep, ...g.drop]) if (!byId.has(id)) return fail('tx_not_found', { id });
    }
    const seen = new Set();
    const drop = new Set();
    const giveKey = new Map();
    for (const [i, g] of groups.entries()) {
      if (g.drop.length === 0) return bad(`groups[${i}].drop`, 'needs at least one id to drop');
      if (g.drop.includes(g.keep)) return bad(`groups[${i}].drop`, `"${g.keep}" is the row to keep`);
      if (seen.has(g.keep)) return bad(`groups[${i}].keep`, `"${g.keep}" is already in another group`);
      seen.add(g.keep);
      for (const id of g.drop) {
        if (seen.has(id)) return bad(`groups[${i}].drop`, `"${id}" is already in another group`);
        seen.add(id);
        drop.add(id);
      }
      const keys = new Set([g.keep, ...g.drop].map(id => keyOf(byId.get(id))).filter(Boolean));
      if (keys.size > 1) return bad(`groups[${i}]`, 'its rows carry different budget-item links');
      const [key] = keys;
      if (key && !keyOf(byId.get(g.keep))) giveKey.set(g.keep, key);
    }
    const at = ctx.now.toISOString();
    const transactions = [];
    for (const t of data.transactions) {
      if (t && drop.has(t.id)) continue;
      transactions.push(t && giveKey.has(t.id) ? { ...t, from_budget: giveKey.get(t.id), modified_at: at } : t);
    }
    return ok({ changes: { transactions }, value: { removed: drop.size } });
  },
};
