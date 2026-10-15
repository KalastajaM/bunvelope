// transactions.transferPairs — the Clean-up check "expenses that are really
// transfers" (owner decision 7, 2026-10-05).
import { describe, it, expect } from 'vitest';
import { registry } from '../js/core/index.js';
import { runQuery, runCommand } from '../js/core/pipeline.js';
import { makeCtx } from '../js/core/context.js';
import { runGenerated } from '../bin/cli-dispatch.mjs';

let n = 0;
const ctx = makeCtx({ now: new Date(2026, 9, 5, 12), newId: () => `new-${++n}` });
const tx = (id, type, account, amount, date, payee, over = {}) => ({
  id, type, account, amount, date, payee, status: 'posted', envelope_id: type === 'expense' ? 'e' : null, ...over,
});
const data = (transactions, over = {}) => ({
  accounts: [
    { id: 'bank', name: 'Income & Expenses', type: 'bank' },
    { id: 'amex', name: 'American Express', type: 'credit_card', archived: true },
    { id: 'svea', name: 'SVEA', type: 'savings' },
    { id: 'card', name: 'Mastercard', type: 'credit_card' },
  ],
  envelopes: [{ id: 'e', name: 'Bills' }], budgetItems: [], envelopeTemplates: [], meta: {},
  transactions, ...over,
});
const pairs = (d, input = {}) => {
  const r = runQuery(registry, d, 'transactions.transferPairs', input, ctx);
  expect(r.ok).toBe(true);
  expect(JSON.parse(JSON.stringify(r.value))).toEqual(r.value);
  return r.value.pairs;
};

// The pattern the owner merged by hand on 2026-10-05.
const owner = [
  tx('i1', 'income', 'amex', 2720.61, '2026-01-13', 'AmEx Bill'),
  tx('x1', 'expense', 'bank', 2720.61, '2026-01-13', 'AmEx Bill', { note: 'January' }),
  tx('i2', 'income', 'bank', 10000, '2026-02-17', 'SVEA'),
  tx('x2', 'expense', 'svea', 10000, '2026-02-17', 'SVEA'),
];

describe('transactions.transferPairs', () => {
  it('finds an expense and an income of one amount on two own accounts with the same payee', () => {
    const found = pairs(data(owner));
    expect(found.map(p => [p.date, p.amount, p.fromAccount, p.toAccount, p.incomeId, p.expenseId])).toEqual([
      ['2026-02-17', 10000, 'svea', 'bank', 'i2', 'x2'],
      ['2026-01-13', 2720.61, 'bank', 'amex', 'i1', 'x1'],
    ]);
    expect(found[1]).toMatchObject({ id: 'i1|x1', days: 0, payeeMatch: true, payee: 'AmEx Bill' });
    expect(found[1].expense).toMatchObject({ id: 'x1', note: 'January', account: 'bank' });
  });

  it('allows a few days between the legs, and no more than `days`', () => {
    const d = data([tx('i', 'income', 'svea', 50, '2026-09-04', 'Move'), tx('x', 'expense', 'bank', 50, '2026-09-01', 'Move')]);
    expect(pairs(d).map(p => p.days)).toEqual([3]);
    expect(pairs(d, { days: 2 })).toEqual([]);
  });

  it('leaves out what is not a transfer to propose', () => {
    const base = [tx('i', 'income', 'svea', 50, '2026-09-01', 'Move'), tx('x', 'expense', 'bank', 50, '2026-09-01', 'Move')];
    for (const [why, rows] of [
      ['same account', [base[0], { ...base[1], account: 'svea' }]],
      ['other amount', [base[0], { ...base[1], amount: 50.01 }]],
      ['another payee', [base[0], { ...base[1], payee: 'Prisma' }]],
      ['a refund of a purchase', [{ ...base[0], payee: 'Prisma return' }, { ...base[1], payee: 'Prisma' }]],
      ['scheduled', [base[0], { ...base[1], status: 'scheduled' }]],
      ['after the query date', [{ ...base[0], date: '2026-10-06' }, { ...base[1], date: '2026-10-06' }]],
      ['older than the lookback', [{ ...base[0], date: '2025-10-04' }, { ...base[1], date: '2025-10-04' }]],
      ['a reversal', [base[0], { ...base[1], reversed_by: 'r' }]],
      ['not an own account', [base[0], { ...base[1], account: 'gone' }]],
      ['already a transfer', [base[0], { id: 't', type: 'account_transfer', from_account: 'bank', to_account: 'svea', amount: 50, date: '2026-09-01', payee: 'Move' }]],
    ]) {
      expect(pairs(data(rows)), why).toEqual([]);
    }
  });

  it('widens with since and anyPayee', () => {
    const old = [tx('i', 'income', 'svea', 50, '2024-01-01', 'Move'), tx('x', 'expense', 'bank', 50, '2024-01-01', 'Move')];
    expect(pairs(data(old), { since: '2023-01-01' })).toHaveLength(1);
    const other = [tx('i', 'income', 'svea', 50, '2026-09-01', 'Transfer in'), tx('x', 'expense', 'bank', 50, '2026-09-01', 'Savings')];
    expect(pairs(data(other))).toEqual([]);
    expect(pairs(data(other), { anyPayee: true })).toMatchObject([{ payeeMatch: false }]);
  });

  it('puts each row in one pair at most: the same payee first, then the closest day', () => {
    const rows = [
      tx('x', 'expense', 'bank', 100, '2026-09-10', 'ATM'),
      tx('far', 'income', 'svea', 100, '2026-09-12', 'ATM'),
      tx('near', 'income', 'card', 100, '2026-09-10', 'ATM'),
      tx('other', 'income', 'svea', 100, '2026-09-10', 'Gift'),
    ];
    expect(pairs(data(rows), { anyPayee: true }).map(p => p.id)).toEqual(['near|x']);
  });

  it('leaves out a pair dismissed in meta.transferPairDismissed and lists it under dismissed', () => {
    const d = data(owner, { meta: { transferPairDismissed: ['i1|x1', 'gone|row', 7] } });
    const r = runQuery(registry, d, 'transactions.transferPairs', {}, ctx);
    expect(r.value.pairs.map(p => p.id)).toEqual(['i2|x2']);
    // Only a dismissal that would otherwise be found is listed.
    expect(r.value.dismissed.map(p => p.id)).toEqual(['i1|x1']);
    expect(r.value.dismissed[0]).toMatchObject({ incomeId: 'i1', expenseId: 'x1', amount: 2720.61 });
    expect(runQuery(registry, data(owner), 'transactions.transferPairs', {}, ctx).value.dismissed).toEqual([]);
  });

  it('a dismissed pair frees its rows to pair with another partner', () => {
    const rows = [
      tx('x', 'expense', 'bank', 100, '2026-09-10', 'ATM'),
      tx('near', 'income', 'card', 100, '2026-09-10', 'ATM'),
      tx('far', 'income', 'svea', 100, '2026-09-12', 'ATM'),
    ];
    const d = data(rows, { meta: { transferPairDismissed: ['near|x'] } });
    expect(pairs(d).map(p => p.id)).toEqual(['far|x']);
  });

  it('each pair merges with transaction.mergeTransfer as proposed', () => {
    const d = data(owner);
    const [first] = pairs(d);
    const r = runCommand(registry, d, 'transaction.mergeTransfer', { incomeId: first.incomeId, expenseId: first.expenseId }, ctx);
    expect(r.ok).toBe(true);
    expect(r.value.value.transfer).toMatchObject({ type: 'account_transfer', from_account: 'svea', to_account: 'bank', amount: 10000, date: '2026-02-17' });
  });

  it('is a CLI verb', async () => {
    const d = data(owner);
    const session = { query: (name, input) => runQuery(registry, d, name, input, ctx) };
    const result = await runGenerated({ registry, args: ['transactions', 'transfer-pairs', '--file', 'scratch.json', '--days', '1', '--any-payee'], openSession: () => session });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).value).toEqual(runQuery(registry, d, 'transactions.transferPairs', { days: 1, anyPayee: true }, ctx).value);
    expect(JSON.parse(result.stdout).value.days).toBe(1);
  });
});
