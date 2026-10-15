// Net worth (accounts): the Overview card is the Accounts page total, broken
// down so each account lands in exactly one part (owner decision 2026-09-24).
import { describe, it, expect } from 'vitest';
import { computeNetWorth } from '../../js/engine.js';

const accounts = [
  { id: 'bank',    type: 'bank',        initialBalance: 1000 },
  { id: 'card',    type: 'credit_card', initialBalance: -300 },
  { id: 'sav',     type: 'savings',     initialBalance: 5000 },
  { id: 'fund',    type: 'investment',  initialBalance: 7000 },
  { id: 'pension', type: 'investment',  initialBalance: 9000, pensionInsurance: true },
  { id: 'broker',  type: 'bank',        initialBalance: 250, spending: false },
  { id: 'old',     type: 'bank',        initialBalance: 999, archived: true },
];

describe('computeNetWorth', () => {
  it('puts every non-archived account in exactly one part', () => {
    expect(computeNetWorth(accounts, [])).toEqual({
      total: 1000 - 300 + 5000 + 7000 + 9000 + 250,
      spending: 700, savings: 5000, investment: 7000, pension: 9000, assets: 0, loansGiven: 0, debts: 0, other: 250,
    });
  });

  it('keeps the parts summing to the total after transactions', () => {
    const txs = [
      { id: 'e', type: 'expense', account: 'bank', amount: 40, date: '2026-09-01' },
      { id: 't', type: 'account_transfer', from_account: 'bank', to_account: 'sav', amount: 100, date: '2026-09-02' },
    ];
    const w = computeNetWorth(accounts, txs);
    expect(w.spending + w.savings + w.investment + w.pension + w.other).toBeCloseTo(w.total, 10);
    // A transfer between two of the accounts moves money between parts, not
    // out of the total; only the expense leaves it.
    expect(w.total).toBe(1000 - 300 + 5000 + 7000 + 9000 + 250 - 40);
    expect(w.savings).toBe(5100);
  });

  it('lets an opted-in savings account count as spending', () => {
    const w = computeNetWorth([{ id: 'wallet', type: 'savings', initialBalance: 40, spending: true }], []);
    expect(w.spending).toBe(40);
    expect(w.savings).toBe(0);
  });

  it('is all zeros with no accounts', () => {
    expect(computeNetWorth([], []).total).toBe(0);
    expect(computeNetWorth(null, []).total).toBe(0);
  });
});
