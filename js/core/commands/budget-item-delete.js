// budgetItem.delete — remove a plan item. Nothing references one, so there is
// no in-use check; rows it already posted keep their from_budget key.

import { ok } from '../result.js';

export default {
  name: 'budgetItem.delete',
  summary: 'Delete a plan item. Transactions it already posted are kept.',
  input: {
    type: 'object',
    required: ['id'],
    properties: {
      id: { type: 'ref', kind: 'budgetItem' },
    },
  },
  execute(data, input) {
    return ok({
      changes: { budgetItems: data.budgetItems.filter(it => it.id !== input.id) },
      value: { id: input.id },
    });
  },
};
