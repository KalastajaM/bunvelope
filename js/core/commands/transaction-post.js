// transaction.post — turn a scheduled one-off into a posted row, optionally
// moving it to the date it really happened.

import { ok, fail } from '../result.js';
import { TX_INPUT_PROPERTIES } from '../tx-fields.js';

export default {
  name: 'transaction.post',
  summary: 'Post a scheduled transaction: it becomes posted and cleared (unless cleared is false), optionally with the date it actually happened. Fails when the row is not scheduled.',
  input: {
    type: 'object',
    required: ['id'],
    properties: {
      id: { type: 'string' },
      date: { type: 'date', description: 'The date it happened (default: keep the scheduled date)' },
      cleared: { type: 'boolean', default: true },
      force: TX_INPUT_PROPERTIES.force,
    },
  },
  execute(data, input, ctx) {
    const index = data.transactions.findIndex(t => t.id === input.id);
    if (index < 0) return fail('tx_not_found', { id: input.id });
    const current = data.transactions[index];
    if (current.status !== 'scheduled') return fail('not_scheduled', { id: input.id, status: current.status });
    const row = { ...current, status: 'posted', cleared: input.cleared, modified_at: ctx.now.toISOString() };
    if (input.date !== undefined) row.date = input.date;
    const transactions = data.transactions.slice();
    transactions[index] = row;
    return ok({ changes: { transactions }, value: row });
  },
};
