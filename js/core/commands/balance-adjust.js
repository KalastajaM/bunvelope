// balance.adjust — a documented, signed correction to an envelope or account:
// one adjustment row (+ credits, - debits). Matches Budget's `adjust`.

import { ok, fail } from '../result.js';
import { BALANCE_TARGET_PROPERTIES, resolveBalanceTarget, adjustmentRow } from '../balance-fields.js';
import { round2 } from '../../utils.js';

export default {
  name: 'balance.adjust',
  summary: 'Correct an envelope or account balance by a signed amount (+ credits, - debits), with a required note saying why. Appends one adjustment row and returns it.',
  input: {
    type: 'object',
    required: ['amount', 'note'],
    properties: {
      amount: { type: 'money', description: 'Signed, non-zero: + credits, - debits' },
      ...BALANCE_TARGET_PROPERTIES,
    },
  },
  execute(data, input, ctx) {
    const t = resolveBalanceTarget(data, input);
    if (!t.ok) return t;
    const amount = round2(input.amount);
    if (amount === 0) return fail('bad_input', { errors: [{ path: 'amount', message: 'must be non-zero' }] });
    const row = adjustmentRow(ctx, {
      date: input.date, payee: input.payee || 'Adjustment', amount,
      target: t.kind, targetId: t.entity.id, note: t.note,
    });
    return ok({ changes: { transactions: [...data.transactions, row] }, value: row });
  },
};
