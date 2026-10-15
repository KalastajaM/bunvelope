// account.reorder — the complete new display order (array order is display
// order). The ids must be a permutation of the current ones; each account
// object is kept as it is.

import { ok, fail } from '../result.js';

export default {
  name: 'account.reorder',
  summary: 'Set the display order of the accounts: ids lists every account id exactly once, in the new order.',
  input: {
    type: 'object',
    required: ['ids'],
    properties: {
      ids: { type: 'array', items: { type: 'string' }, description: 'Every account id, in the new order' },
    },
  },
  execute(data, input) {
    const { ids } = input;
    const byId = new Map(data.accounts.map(a => [a.id, a]));
    const permutation = ids.length === data.accounts.length
      && new Set(ids).size === ids.length
      && ids.every(id => byId.has(id));
    if (!permutation) return fail('not_permutation', { kind: 'account' });
    return ok({ changes: { accounts: ids.map(id => byId.get(id)) }, value: { ids } });
  },
};
