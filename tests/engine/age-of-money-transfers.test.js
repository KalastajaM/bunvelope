// Age of Money and transfers (owner decision 2026-10-06, the usual YNAB-style
// definition): `aomPoolTransactions` marks the transfers that cross the
// spending pool's edge, and the FIFO walk reads an outflow as consuming the
// oldest money without averaging it, and an inflow as income. Unmarked rows,
// which is what a caller passing raw transactions gives it, walk as before.
import { describe, it, expect } from 'vitest';
import {
  aomPoolTransactions, computeAgeOfMoney, computeAgeOfMoneyDetailed, computeAgeOfMoneyHistory, aomOneOffIncomes,
} from '../../js/engine.js';

const POOL = new Set(['chk', 'card']);
const REF = new Date(2026, 2, 31, 12);
const inc = (id, date, amount, account = 'chk') => ({ id, type: 'income', date, amount, account, status: 'posted' });
const exp = (id, date, amount, account = 'chk') => ({ id, type: 'expense', date, amount, account, envelope_id: 'food', status: 'posted' });
const xfer = (id, date, amount, from, to, extra = {}) => ({ id, type: 'account_transfer', date, amount, from_account: from, to_account: to, status: 'posted', ...extra });

describe('aomPoolTransactions', () => {
  it('marks only the transfers that cross the pool\'s edge, with the magnitude that crossed', () => {
    const rows = [
      inc('i', '2026-01-01', 100),
      xfer('out', '2026-01-02', 40, 'chk', 'sav'),
      xfer('in', '2026-01-03', 25, 'sav', 'chk'),
      xfer('inside', '2026-01-04', 10, 'chk', 'card'),
      xfer('outside', '2026-01-05', 10, 'sav', 'inv'),
      { id: 'loan', type: 'debt_payment', date: '2026-01-06', amount: 700, from_account: 'chk', to_account: 'mtg', envelope_id: 'housing', status: 'posted' },
      { id: 'buy', type: 'investment_transfer', direction: 'buy', date: '2026-01-07', amount: 300, from_account: 'chk', to_account: 'inv', status: 'posted' },
      { id: 'div', type: 'investment_transfer', direction: 'dividend', date: '2026-01-08', amount: 12, from_account: 'inv', to_account: 'chk', status: 'posted' },
    ];
    const out = aomPoolTransactions(rows, POOL);
    expect(out.map(r => [r.id, r.aom_flow ?? null, r.aom_amount ?? null])).toEqual([
      ['i', null, null], ['out', 'out', 40], ['in', 'in', 25], ['inside', null, null], ['outside', null, null],
      ['loan', 'out', 700], ['buy', 'out', 300], ['div', 'in', 12],
    ]);
    // Unmarked rows are the same objects; a marked one is a copy, the input untouched.
    expect(out[0]).toBe(rows[0]);
    expect(out[3]).toBe(rows[3]);
    expect(rows[1]).not.toHaveProperty('aom_flow');
  });

  it('is memoised on the identity of both arguments', () => {
    const rows = [xfer('out', '2026-01-02', 40, 'chk', 'sav')];
    expect(aomPoolTransactions(rows, POOL)).toBe(aomPoolTransactions(rows, POOL));
    expect(aomPoolTransactions(rows, new Set(['chk', 'sav']))[0]).toBe(rows[0]);
  });
});

describe('the FIFO walk with marked transfers', () => {
  // 2000 paid on the 1st, 1100 moved to savings on the 2nd, 900 spent on the 20th.
  const months = ['2026-01', '2026-02', '2026-03'];
  const rows = months.flatMap(m => [inc(`p${m}`, `${m}-01`, 2000), xfer(`t${m}`, `${m}-02`, 1100, 'chk', 'sav'), exp(`e${m}`, `${m}-20`, 900)]);

  it('an outflow consumes the oldest money first', () => {
    expect(computeAgeOfMoney(aomPoolTransactions(rows, POOL), REF)).toBe(19);
    // Unmarked (a caller passing raw rows): the transfer is ignored, as before.
    expect(computeAgeOfMoney(rows, REF)).toBe(computeAgeOfMoney(rows.filter(r => r.type !== 'account_transfer'), REF));
    expect(computeAgeOfMoney(rows, REF)).toBeGreaterThan(19);
  });

  it('an outflow is not averaged as spending and never starves the window', () => {
    const r = computeAgeOfMoneyDetailed(aomPoolTransactions(rows, POOL), REF, 30);
    expect(r.perExpense.map(e => e.txId)).toEqual(['e2026-03']);
    expect(r.recentSpend).toBe(900);
    // Moving out more than the queue holds is not running short of money.
    const drained = [inc('a', '2026-03-01', 500), xfer('b', '2026-03-02', 800, 'chk', 'sav'), inc('c', '2026-03-10', 300), exp('d', '2026-03-20', 300)];
    const d = computeAgeOfMoneyDetailed(aomPoolTransactions(drained, POOL), REF, 30);
    expect(d.starvedInWindow).toBe(false);
    expect(d.aom).toBe(10);
  });

  it('an inflow is income: queued, in the window\'s incomes, and tested as a one-off', () => {
    const pay = ['2025-09', '2025-10', '2025-11', '2025-12', '2026-01', '2026-02'].map(m => inc(`p${m}`, `${m}-01`, 1000));
    const big = [...pay, xfer('back', '2026-03-05', 20000, 'sav', 'chk'), xfer('small', '2026-03-10', 500, 'sav', 'chk')];
    const marked = aomPoolTransactions(big, POOL);
    expect(aomOneOffIncomes(marked)).toEqual([{ txId: 'back', date: '2026-03-05', amount: 20000 }]);
    const r = computeAgeOfMoneyDetailed(marked, REF, 30);
    expect(r.incomes.map(x => x.amount)).toEqual([500]);
  });

  it('the history equals the headline at each month-end with outflows in the walk', () => {
    const marked = aomPoolTransactions(rows, POOL);
    for (const s of computeAgeOfMoneyHistory(marked, { refDate: REF, months: 3 })) {
      expect(s.aom).toBe(computeAgeOfMoney(marked, s.refDate));
    }
  });
});
