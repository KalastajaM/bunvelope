// balance.set — bring an envelope or account to a stated balance by posting
// the difference as a documented adjustment (never a "set line"). The current
// balance is the budget view, every row included, like the app's headline
// number. Matches Budget's `set-envelope` / `set-account`.

import { ok } from '../result.js';
import { BALANCE_TARGET_PROPERTIES, resolveBalanceTarget, adjustmentRow } from '../balance-fields.js';
import { computeEnvelopeBalances, computeAccountBalances } from '../../engine/balances.js';
import { round2 } from '../../utils.js';

export default {
  name: 'balance.set',
  summary: 'Set an envelope or account to a balance (budget view, scheduled rows included) by posting the difference as an adjustment with a required note. Does nothing when already there. Returns { delta, row }.',
  input: {
    type: 'object',
    required: ['balance', 'note'],
    properties: {
      balance: { type: 'money', description: 'The balance to end up with' },
      ...BALANCE_TARGET_PROPERTIES,
    },
  },
  execute(data, input, ctx) {
    const t = resolveBalanceTarget(data, input);
    if (!t.ok) return t;
    const cur = (t.kind === 'envelope'
      ? computeEnvelopeBalances(data.transactions)
      : computeAccountBalances(data.accounts, data.transactions)).get(t.entity.id) ?? 0;
    // Round the target first, as Budget does, so the stored delta and the note agree.
    const target = round2(input.balance);
    const delta = round2(target - cur);
    if (Math.abs(delta) < 0.005) return ok({ changes: {}, value: { delta: 0, balance: cur } });
    const row = adjustmentRow(ctx, {
      date: input.date, payee: input.payee || `Set ${t.kind} balance`, amount: delta,
      target: t.kind, targetId: t.entity.id,
      note: `Set ${t.entity.name} to ${target.toFixed(2)} (budget view was ${round2(cur).toFixed(2)}, delta ${delta.toFixed(2)}) — ${t.note}`,
    });
    return ok({ changes: { transactions: [...data.transactions, row] }, value: { delta, row } });
  },
};
