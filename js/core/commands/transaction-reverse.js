// transaction.reverse — Budget's append-only correction: instead of editing or
// deleting a posted row, add the mirror row(s) that cancel it and mark the
// original `reversed_by`. The mirror's text fields (payee, note) match the
// Budget project's reverse-tx exactly, so history written by either reads the
// same.

import { ok, fail } from '../result.js';
import { TX_INPUT_PROPERTIES } from '../tx-fields.js';
import { txAbsAmount } from '../../engine/tx-amounts.js';
import { round2 } from '../../utils.js';

const unsupported = (id, reason) => fail('reverse_unsupported', { id, reason });

/**
 * The mirror rows for `orig`, without the fields every mirror shares.
 * Returns null for a type with no mirror.
 * @param {Record<string, any>} orig
 * @param {number} abs
 * @returns {Record<string, any>[] | null}
 */
function mirrorsOf(orig, abs) {
  const envelope = orig.envelope_id ? { envelope_id: orig.envelope_id } : {};
  switch (orig.type) {
    case 'expense':
      return [{ type: 'income', amount: abs, account: orig.account, ...envelope, cleared: true }];
    case 'income':
      return [{ type: 'expense', amount: abs, account: orig.account, ...envelope, cleared: true }];
    case 'account_transfer':
    case 'debt_payment': {
      /** @type {Record<string, any>[]} */
      const rows = [{ type: 'account_transfer', amount: abs, from_account: orig.to_account, to_account: orig.from_account, cleared: true }];
      // A loan payment also debited an envelope; credit it back.
      if (orig.type === 'debt_payment' && orig.envelope_id) {
        rows.push({ type: 'adjustment', amount: abs, target: 'envelope', target_id: orig.envelope_id, cleared: true });
      }
      return rows;
    }
    case 'investment_transfer': {
      // A buy is undone by a sell of the same cash and units (and the other
      // way round). The fee is not copied: the broker kept it.
      /** @type {Record<string, any>} */
      const row = {
        type: 'investment_transfer', amount: abs, symbol: orig.symbol,
        direction: orig.direction === 'sell' ? 'buy' : 'sell',
        from_account: orig.to_account, to_account: orig.from_account, ...envelope, cleared: true,
      };
      const units = Math.abs(Number(orig.units) || 0);
      if (units > 0) row.units = units;
      if (orig.pricePerUnit) row.pricePerUnit = Math.abs(Number(orig.pricePerUnit));
      return [row];
    }
    case 'envelope_transfer':
      return [{ type: 'envelope_transfer', amount: abs, from_envelope_id: orig.to_envelope_id, to_envelope_id: orig.from_envelope_id }];
    case 'adjustment':
      return [{ type: 'adjustment', amount: round2(-(Number(orig.amount) || 0)), target: orig.target, target_id: orig.target_id, cleared: true }];
    case 'fill': {
      /** @type {Record<string, any>} */
      const row = {
        type: 'fill', source: orig.source || 'allocation',
        lines: (orig.lines || []).map(l => ({ envelope_id: l.envelope_id, mode: 'add', amount: round2(-(Number(l.amount) || 0)) })),
      };
      if (orig.source === 'new_income' && orig.source_account) row.source_account = orig.source_account;
      return [row];
    }
    default:
      return null;
  }
}

export default {
  name: 'transaction.reverse',
  summary: 'Reverse a posted transaction by appending its mirror row(s) and marking the original reversed_by. The mirror is dated like the original unless a date is given. Not supported for split expenses, set-mode fills, investment dividends/adjustments or scheduled rows.',
  input: {
    type: 'object',
    required: ['id'],
    properties: {
      id: { type: 'string' },
      date: { type: 'date', description: 'Date of the mirror row (default: the original row\'s date)' },
      note: { type: 'string', description: 'Why; appended to the generated note' },
      force: TX_INPUT_PROPERTIES.force,
    },
  },
  execute(data, input, ctx) {
    const index = data.transactions.findIndex(t => t.id === input.id);
    if (index < 0) return fail('tx_not_found', { id: input.id });
    const orig = data.transactions[index];
    if (orig.reversed_by) return fail('already_reversed', { id: orig.id, by: orig.reversed_by });
    if (Array.isArray(orig.envelope_splits) && orig.envelope_splits.length) return unsupported(orig.id, 'split');
    if (orig.type === 'fill' && (orig.lines || []).some(l => l.mode === 'set')) return unsupported(orig.id, 'set_fill');
    if (orig.type === 'investment_transfer' && (orig.direction === 'dividend' || orig.direction === 'adjust')) return unsupported(orig.id, 'no_mirror');
    // A scheduled row never posted, so there is nothing to counter-post; delete the plan row instead.
    if (orig.status === 'scheduled') return unsupported(orig.id, 'scheduled');
    const abs = txAbsAmount(orig);
    const parts = mirrorsOf(orig, abs);
    if (!parts) return unsupported(orig.id, 'type');

    const at = ctx.now.toISOString();
    const payee = orig.payee ?? '';
    const ref = `Reversal of ${orig.id} (${orig.date} "${payee}" ${abs.toFixed(2)})`;
    const note = input.note ? `${ref} — ${input.note}` : ref;
    // A correction is dated with the row it corrects, so it lands on the same
    // side of any later set-mode fill.
    const date = input.date ?? orig.date;
    const reversal = parts.map(part => ({
      id: ctx.newId(), date, payee: `Reversal: ${payee}`, note, status: 'posted',
      reverses: orig.id, created_at: at, modified_at: at, ...part,
    }));
    const transactions = data.transactions.slice();
    transactions[index] = { ...orig, reversed_by: reversal[0].id, modified_at: at };
    transactions.push(...reversal);
    return ok({ changes: { transactions }, value: { reversal } });
  },
};
