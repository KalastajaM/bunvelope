import { describe, it, expect } from 'vitest';
import { registry } from '../js/core/index.js';
import { runCommand } from '../js/core/pipeline.js';
import { makeCtx } from '../js/core/context.js';
import strictLedger from '../js/core/policies/strict-ledger.js';

function deepFreeze(o) { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); Object.values(o).forEach(deepFreeze); } return o; }
const NOW = new Date(2026, 9, 2, 10, 0, 0);
const STAMP = NOW.toISOString();
const ctx = () => makeCtx({ now: NOW, newId: () => 'merged' });
const exp = { id: 'e', type: 'expense', date: '2026-10-01', payee: 'Out', amount: 50, account: 'chk', envelope_id: 'groc' };
const inc = { id: 'i', type: 'income', date: '2026-09-28', payee: 'In', amount: 50, account: 'sav', envelope_id: null };
const other = { id: 'o', type: 'expense', date: '2026-10-01', payee: 'O', amount: 9, account: 'chk', envelope_id: 'groc' };
const data = (transactions = [exp, other, inc], meta = {}) => deepFreeze({
  meta, budgetItems: [], envelopeTemplates: [],
  accounts: [{ id: 'chk', name: 'Checking' }, { id: 'sav', name: 'Savings' }],
  envelopes: [{ id: 'groc', name: 'Groceries' }],
  transactions,
});
const run = (input, d = data(), opts) => runCommand(registry, d, 'transaction.mergeTransfer', input, ctx(), opts);
const pair = { incomeId: 'i', expenseId: 'e' };
const paths = (r) => r.error.params.errors.map(e => e.path);

describe('transaction.mergeTransfer', () => {
  it('replaces the two legs with an account transfer appended last', () => {
    const r = run(pair);
    expect(r.ok).toBe(true);
    const txs = r.value.changes.transactions;
    expect(txs.map(t => t.id)).toEqual(['o', 'merged']);
    const transfer = txs.at(-1);
    expect(transfer).toEqual({
      id: 'merged', type: 'account_transfer', date: '2026-09-28', payee: 'In', amount: 50, note: null,
      from_account: 'chk', to_account: 'sav', created_at: STAMP, modified_at: STAMP,
    });
    expect(r.value.value).toEqual({ transfer });
    expect(r.value.changes).not.toHaveProperty('meta');
  });

  it("keeps both legs' notes: each distinct one once, trimmed, the expense's first", () => {
    const note = (e, i) => run(pair, data([{ ...exp, note: e }, { ...inc, note: i }])).value.value.transfer.note;
    expect(note(' Rent share ', 'From Pat')).toBe('Rent share · From Pat');
    expect(note('Same', ' Same ')).toBe('Same');
    expect(note(null, 'Only income')).toBe('Only income');
    expect(note('Only expense', '  ')).toBe('Only expense');
    expect(note(null, undefined)).toBe(null);
  });

  it('takes the earlier date whichever leg has it', () => {
    const r = run(pair, data([{ ...exp, date: '2026-09-01' }, inc]));
    expect(r.value.value.transfer.date).toBe('2026-09-01');
  });

  it('reads the amount through txAbsAmount: a legacy signed amount on one leg', () => {
    const r = run(pair, data([{ ...exp, amount: -50 }, inc]));
    expect(r.ok).toBe(true);
    expect(r.value.value.transfer.amount).toBe(50);
    const r2 = run(pair, data([exp, { ...inc, amount: -50 }]));
    expect(r2.value.value.transfer.amount).toBe(50);
  });

  it('accepts amounts within half a cent', () => {
    const r = run(pair, data([exp, { ...inc, amount: 50.004 }]));
    expect(r.ok).toBe(true);
    expect(r.value.value.transfer.amount).toBe(50);
  });

  it('chooses the payee: input, then income, then expense, then empty', () => {
    expect(run({ ...pair, payee: ' Given ' }).value.value.transfer.payee).toBe('Given');
    expect(run(pair).value.value.transfer.payee).toBe('In');
    expect(run(pair, data([exp, { ...inc, payee: '' }])).value.value.transfer.payee).toBe('Out');
    expect(run(pair, data([{ ...exp, payee: '' }, { ...inc, payee: '' }])).value.value.transfer.payee).toBe('');
    expect(run({ ...pair, payee: '   ' }).value.value.transfer.payee).toBe('In');
  });

  it('is cleared only when both legs were', () => {
    expect(run(pair).value.value.transfer).not.toHaveProperty('cleared');
    expect(run(pair, data([{ ...exp, cleared: true }, inc])).value.value.transfer).not.toHaveProperty('cleared');
    expect(run(pair, data([{ ...exp, cleared: true }, { ...inc, cleared: true }])).value.value.transfer.cleared).toBe(true);
  });

  it('tombstones the from_budget keys of the legs, and writes none otherwise', () => {
    const r = run(pair, data([{ ...exp, from_budget: 'rent:2026-10' }, { ...inc, from_budget: 'pay:2026-09' }], { scheduledTombstones: ['old'], other: 1 }));
    expect(r.value.changes.meta).toEqual({ other: 1, scheduledTombstones: ['old', 'rent:2026-10', 'pay:2026-09'] });
    expect(run(pair, data([{ ...exp, from_budget: 'rent:2026-10' }, inc])).value.changes.meta.scheduledTombstones).toEqual(['rent:2026-10']);
    expect(run(pair).value.changes).not.toHaveProperty('meta');
  });

  it('refuses unknown ids', () => {
    expect(run({ ...pair, incomeId: 'zz' }).error).toEqual({ code: 'tx_not_found', params: { id: 'zz' } });
    expect(run({ ...pair, expenseId: 'yy' }).error).toEqual({ code: 'tx_not_found', params: { id: 'yy' } });
  });

  it('refuses legs of the wrong type, and swapped ids', () => {
    const swapped = run({ incomeId: 'e', expenseId: 'i' });
    expect(swapped.error.code).toBe('bad_input');
    expect(paths(swapped)).toEqual(['incomeId', 'expenseId']);
    expect(paths(run({ incomeId: 'e', expenseId: 'o' }))).toEqual(['incomeId']);
    expect(paths(run({ incomeId: 'i', expenseId: 'i' }))).toEqual(['expenseId']);
    const t = { id: 't', type: 'account_transfer', date: '2026-10-01', amount: 50, from_account: 'chk', to_account: 'sav' };
    expect(paths(run({ incomeId: 'i', expenseId: 't' }, data([inc, t])))).toEqual(['expenseId']);
  });

  // txAbsAmount rounds to cents, so a one-cent gap is the smallest real difference.
  it('refuses a one-cent difference, either way', () => {
    expect(run(pair, data([exp, { ...inc, amount: 50.006 }])).error.code).toBe('bad_input');
    expect(run(pair, data([exp, { ...inc, amount: 49.994 }])).error.code).toBe('bad_input');
  });

  it('refuses amounts that differ', () => {
    const r = run(pair, data([exp, { ...inc, amount: 50.01 }]));
    expect(r.error.code).toBe('bad_input');
    expect(paths(r)).toEqual(['expenseId']);
  });

  it('refuses the same account', () => {
    const r = run(pair, data([exp, { ...inc, account: 'chk' }]));
    expect(r.error.code).toBe('bad_input');
    expect(paths(r)).toEqual(['expenseId']);
  });

  it('refuses a leg without an account', () => {
    const { account: _a, ...noAcc } = inc;
    const r = run(pair, data([exp, noAcc]));
    expect(r.error.code).toBe('bad_input');
    expect(paths(r)).toEqual(['incomeId']);
    const { account: _b, ...noAccExp } = exp;
    expect(paths(run(pair, data([noAccExp, inc])))).toEqual(['expenseId']);
  });

  it('strict-ledger refuses removing posted history, and force passes it', () => {
    const d = data([{ ...exp, date: '2026-09-01', status: 'posted' }, inc]);
    expect(run(pair, d, { policies: [strictLedger] }).error.code).toBe('ledger_history_locked');
    const forced = run({ ...pair, force: true }, d, { policies: [strictLedger] });
    expect(forced.ok).toBe(true);
    expect(forced.value.forced).toEqual(['history-locked']);
  });
});
