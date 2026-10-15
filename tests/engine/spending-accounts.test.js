// Spending accounts (ux-review U2, owner decision 2026-09-23): cash, current
// accounts and credit cards by default; an explicit `spending` flag wins.
import { describe, it, expect } from 'vitest';
import { isSpendingAccount, spendingByDefault } from '../../js/engine.js';

describe('isSpendingAccount', () => {
  it('defaults by type: bank, cash and credit card are spending accounts', () => {
    expect(isSpendingAccount({ type: 'bank' })).toBe(true);
    expect(isSpendingAccount({ type: 'cash' })).toBe(true);
    expect(isSpendingAccount({ type: 'credit_card' })).toBe(true);
    expect(isSpendingAccount({ type: 'savings' })).toBe(false);
    expect(isSpendingAccount({ type: 'investment' })).toBe(false);
    expect(isSpendingAccount({ type: 'investment', pensionInsurance: true })).toBe(false);
  });

  it('treats a missing type as bank, like the rest of the app', () => {
    expect(isSpendingAccount({})).toBe(true);
    expect(spendingByDefault(undefined)).toBe(true);
  });

  it('lets an explicit flag override the type', () => {
    expect(isSpendingAccount({ type: 'bank', spending: false })).toBe(false);
    expect(isSpendingAccount({ type: 'savings', spending: true })).toBe(true);
  });

  it('is false for no account at all', () => {
    expect(isSpendingAccount(null)).toBe(false);
    expect(isSpendingAccount(undefined)).toBe(false);
  });
});
