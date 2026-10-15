// overdrawnAccount: compares two balances answers for the paying account.
import { describe, it, expect } from 'vitest';
import { overdrawnAccount } from '../js/ui/overdraw.js';

const answer = (balance, type = 'bank') => ({ accounts: [{ id: 'a', name: 'Checking', type, balance }] });

describe('overdrawnAccount', () => {
  it('reports a cash account crossing from zero or more to below zero', () => {
    expect(overdrawnAccount(answer(246), answer(-1048.63), 'a')).toEqual({ id: 'a', name: 'Checking', balance: -1048.63 });
    expect(overdrawnAccount(answer(0), answer(-0.01), 'a')).not.toBeNull();
  });

  it('stays quiet when the account stays above zero or was already negative', () => {
    expect(overdrawnAccount(answer(500), answer(0), 'a')).toBeNull();
    expect(overdrawnAccount(answer(-10), answer(-50), 'a')).toBeNull();
  });

  it('ignores cards, loans and investment accounts, and a missing account or answer', () => {
    for (const type of ['credit_card', 'loan', 'investment', 'asset', 'loan_given']) {
      expect(overdrawnAccount(answer(10, type), answer(-10, type), 'a')).toBeNull();
    }
    expect(overdrawnAccount(answer(10), answer(-10), 'b')).toBeNull();
    expect(overdrawnAccount(null, answer(-10), 'a')).toBeNull();
    expect(overdrawnAccount(answer(10), answer(-10), null)).toBeNull();
  });
});
