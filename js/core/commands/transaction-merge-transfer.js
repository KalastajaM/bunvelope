// transaction.mergeTransfer — replace an income row and an expense row of the
// same amount (the two legs of a transfer imported from two statements) with
// one account_transfer. The legs are removed as transaction.delete removes
// rows, so a plan occurrence merged away is not re-created on the next load.

import { ok, fail } from '../result.js';
import { txAbsAmount } from '../../engine/tx-amounts.js';
import { applyTxInput, checkTxRow, TX_INPUT_PROPERTIES } from '../tx-fields.js';
import { tombstoneRemoval } from '../tombstones.js';

const bad = (...errors) => fail('bad_input', { errors: errors.map(([path, message]) => ({ path, message })) });

export default {
  name: 'transaction.mergeTransfer',
  summary: 'Merge one income and one expense of equal amount on two different accounts into a single account transfer (dated the earlier of the two, paying out of the expense\'s account into the income\'s). Both rows are removed; the transfer keeps both legs\' notes (each once, trimmed, joined with " · "). Returns the new transfer.',
  input: {
    type: 'object',
    required: ['incomeId', 'expenseId'],
    properties: {
      incomeId: { type: 'string', description: 'The income row (the receiving leg)' },
      expenseId: { type: 'string', description: 'The expense row (the paying leg)' },
      payee: { type: 'string', description: 'Payee of the transfer (default: the income\'s, else the expense\'s)' },
      force: TX_INPUT_PROPERTIES.force,
    },
  },
  execute(data, input, ctx) {
    const byId = new Map(data.transactions.map(t => [t.id, t]));
    const income = byId.get(input.incomeId);
    if (!income) return fail('tx_not_found', { id: input.incomeId });
    const expense = byId.get(input.expenseId);
    if (!expense) return fail('tx_not_found', { id: input.expenseId });
    /** @type {Array<[string, string]>} */
    const problems = [];
    if (income.type !== 'income') problems.push(['incomeId', 'must be an income transaction']);
    if (expense.type !== 'expense') problems.push(['expenseId', 'must be an expense transaction']);
    if (problems.length) return bad(...problems);
    if (Math.abs(txAbsAmount(income) - txAbsAmount(expense)) > 0.005) return bad(['expenseId', 'amount must equal the income\'s']);
    if (!income.account) return bad(['incomeId', 'has no account']);
    if (!expense.account) return bad(['expenseId', 'has no account']);
    if (income.account === expense.account) return bad(['expenseId', 'must be on a different account than the income']);

    const at = ctx.now.toISOString();
    const payee = (typeof input.payee === 'string' ? input.payee.trim() : '') || income.payee || expense.payee || '';
    // Neither leg's note is lost: each distinct one once, paying leg first.
    const notes = [...new Set([expense.note, income.note]
      .map(n => (typeof n === 'string' ? n.trim() : ''))
      .filter(Boolean))];
    /** @type {Record<string, any>} */
    let row = {
      id: ctx.newId(), type: 'account_transfer', date: income.date < expense.date ? income.date : expense.date,
      payee: '', amount: 0, note: notes.length ? notes.join(' · ') : null,
    };
    row = applyTxInput(row, { amount: txAbsAmount(income), fromAccount: expense.account, toAccount: income.account, payee });
    // Both legs on the statement: the transfer replacing them is too.
    if (income.cleared && expense.cleared) row.cleared = true;
    row.created_at = at;
    row.modified_at = at;
    const invalid = checkTxRow(row);
    if (invalid) return fail(invalid.code, invalid.params);

    const drop = new Set([income.id, expense.id]);
    const tomb = tombstoneRemoval(data, [expense, income]);
    /** @type {Record<string, any>} */
    const changes = { transactions: [...data.transactions.filter(t => !drop.has(t.id)), row] };
    if (tomb) changes.meta = tomb.meta;
    return ok({ changes, value: { transfer: row } });
  },
};
