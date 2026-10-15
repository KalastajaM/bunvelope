// envelope.reorder — the complete new display order (array order is display
// order). The ids must be a permutation of the current ones; each envelope
// object is kept as it is.

import { ok, fail } from '../result.js';

export default {
  name: 'envelope.reorder',
  summary: 'Set the display order of the envelopes: ids lists every envelope id exactly once, in the new order.',
  input: {
    type: 'object',
    required: ['ids'],
    properties: {
      ids: { type: 'array', items: { type: 'string' }, description: 'Every envelope id, in the new order' },
    },
  },
  execute(data, input) {
    const { ids } = input;
    const byId = new Map(data.envelopes.map(e => [e.id, e]));
    const permutation = ids.length === data.envelopes.length
      && new Set(ids).size === ids.length
      && ids.every(id => byId.has(id));
    if (!permutation) return fail('not_permutation', { kind: 'envelope' });
    return ok({ changes: { envelopes: ids.map(id => byId.get(id)) }, value: { ids } });
  },
};
