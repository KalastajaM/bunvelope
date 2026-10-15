// `txNetAccountDelta` is the day-header total for an unfiltered ledger: money
// that actually entered or left your accounts, not the sum of what each row
// happens to display.
//
// The old header summed display amounts as `expense ? -raw : raw`, so every
// non-expense counted as a credit and a day holding one €400 transfer between
// two of your own accounts read +€400.

import { describe, it, expect } from 'vitest';
import { txNetAccountDelta } from '../../js/engine.js';

const IDS = new Set(['cash', 'savings', 'broker']);

describe('txNetAccountDelta', () => {
  it('counts an expense as money leaving', () => {
    expect(txNetAccountDelta(
      { type: 'expense', account: 'cash', amount: 50 }, IDS,
    )).toBe(-50);
  });

  it('counts income as money arriving', () => {
    expect(txNetAccountDelta(
      { type: 'income', account: 'cash', amount: 2000 }, IDS,
    )).toBe(2000);
  });

  it('nets an own-account transfer to zero', () => {
    // The regression: this read +400.
    expect(txNetAccountDelta(
      { type: 'account_transfer', from_account: 'cash', to_account: 'savings', amount: 400 },
      IDS,
    )).toBe(0);
  });

  it('nets a debt payment between tracked accounts to zero', () => {
    expect(txNetAccountDelta(
      { type: 'debt_payment', from_account: 'cash', to_account: 'savings', amount: 300 },
      IDS,
    )).toBe(0);
  });

  it('nets an investment buy to zero — cash moved, it did not leave', () => {
    expect(txNetAccountDelta(
      { type: 'investment_transfer', direction: 'buy',
        from_account: 'cash', to_account: 'broker', amount: 500 },
      IDS,
    )).toBe(0);
  });

  it('counts a dividend as money arriving from outside the budget', () => {
    expect(txNetAccountDelta(
      { type: 'investment_transfer', direction: 'dividend',
        from_account: 'broker', to_account: 'cash', amount: 40 },
      IDS,
    )).toBe(40);
  });

  it('ignores an envelope-only fill — no account is touched', () => {
    expect(txNetAccountDelta(
      { type: 'fill', lines: [{ envelope_id: 'a', mode: 'add', amount: 100 }] },
      IDS,
    )).toBe(0);
  });

  it('counts a signed account adjustment as stated', () => {
    expect(txNetAccountDelta(
      { type: 'adjustment', target: 'account', target_id: 'cash', amount: -12.5 }, IDS,
    )).toBe(-12.5);
  });

  it('counts only the tracked leg when the other account is outside the set', () => {
    // Transfer out to an account not in the set is real money leaving.
    expect(txNetAccountDelta(
      { type: 'account_transfer', from_account: 'cash', to_account: 'elsewhere', amount: 400 },
      IDS,
    )).toBe(-400);
  });

  it('sums a mixed day to its true net', () => {
    const day = [
      { type: 'expense', account: 'cash', amount: 50 },
      { type: 'account_transfer', from_account: 'cash', to_account: 'savings', amount: 400 },
      { type: 'income', account: 'cash', amount: 120 },
    ];
    const total = day.reduce((s, tx) => s + txNetAccountDelta(tx, IDS), 0);
    expect(total).toBe(70); // was 470 when transfers counted as credits
  });

  it('is safe with no accounts or no transaction', () => {
    expect(txNetAccountDelta(null, IDS)).toBe(0);
    expect(txNetAccountDelta({ type: 'expense', account: 'cash', amount: 5 }, null)).toBe(0);
    expect(txNetAccountDelta({ type: 'expense', account: 'cash', amount: 5 }, new Set())).toBe(0);
  });
});
