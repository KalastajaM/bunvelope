// Ported from the v2 rebuild's D44. Its reconciliation oracle found that the
// dashboard headline and `unallocated` were computed over two different sets
// of accounts, so a reader doing `total − assigned` on one card did not get
// the third number printed beside it.
import { describe, it, expect } from 'vitest';
import {
  computeAccountBalances, computeEnvelopeBalances, computeUnallocated,
  countsTowardIdentity, identityAccountTotal,
} from '../../js/engine.js';

const accounts = [
  { id: 'chk', type: 'bank', initialBalance: 1000 },
  { id: 'sav', type: 'savings', initialBalance: 500 },
  { id: 'brk', type: 'investment', initialBalance: 9000 },
  { id: 'old', type: 'bank', initialBalance: 250, archived: true },
];
const txs = [
  { id: 't1', type: 'income', date: '2026-03-01', amount: 400, account: 'chk', envelope_id: 'e1' },
  { id: 't2', type: 'expense', date: '2026-03-02', amount: 120, account: 'chk', envelope_id: 'e1' },
];

describe('countsTowardIdentity', () => {
  it('admits every account except investment', () => {
    expect(countsTowardIdentity({ type: 'bank' })).toBe(true);
    expect(countsTowardIdentity({ type: 'savings' })).toBe(true);
    expect(countsTowardIdentity({ type: 'credit_card' })).toBe(true);
    expect(countsTowardIdentity({ type: 'investment' })).toBe(false);
  });

  it('keeps archived accounts in — their money is still money', () => {
    expect(countsTowardIdentity({ type: 'bank', archived: true })).toBe(true);
  });
});

describe('the identity closes on the figures the dashboard prints', () => {
  it('total − assigned === unallocated', () => {
    const acct = computeAccountBalances(accounts, txs);
    const env = computeEnvelopeBalances(txs);
    const total = identityAccountTotal(acct, accounts);
    const assigned = [...env.values()].reduce((a, b) => a + b, 0);
    const unallocated = computeUnallocated(acct, env, accounts);
    expect(total - assigned).toBeCloseTo(unallocated, 10);
  });

  it('leaves the portfolio out of the account side', () => {
    const acct = computeAccountBalances(accounts, txs);
    // 1000 + 400 − 120 + 500 + 250 = 2030. The 9000 brokerage is not cash
    // waiting to be assigned, and the Savings KPI reports it instead.
    expect(identityAccountTotal(acct, accounts)).toBe(2030);
    expect([...acct.values()].reduce((a, b) => a + b, 0)).toBe(11030);
  });

  it('still holds when envelopes exceed the accounts (the over-assigned card)', () => {
    const over = [...txs, {
      id: 't3', type: 'fill', date: '2026-03-03',
      lines: [{ envelope_id: 'e2', mode: 'add', amount: 5000 }],
    }];
    const acct = computeAccountBalances(accounts, over);
    const env = computeEnvelopeBalances(over);
    const total = identityAccountTotal(acct, accounts);
    const assigned = [...env.values()].reduce((a, b) => a + b, 0);
    expect(total).toBeLessThan(assigned);
    expect(total - assigned).toBeCloseTo(computeUnallocated(acct, env, accounts), 10);
  });

  it('sums every balance when no account list is given', () => {
    const acct = computeAccountBalances(accounts, txs);
    expect(identityAccountTotal(acct)).toBe(11030);
  });
});
