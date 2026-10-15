// tests/engine/crisis-cash.test.js
// Crisis cash (ux-review U2 follow-up): what the Stress page counts as money
// to live on. Spending accounts always count; savings count by default; any
// other account can be opted in, and a savings account opted out
// ("Loans to Others" is savings-type but not emergency money).
import { describe, it, expect } from 'vitest';
import { isCrisisCashAccount } from '../../js/engine.js';

describe('isCrisisCashAccount', () => {
  it('counts spending accounts and savings by default', () => {
    expect(isCrisisCashAccount({ type: 'bank' })).toBe(true);
    expect(isCrisisCashAccount({ type: 'cash' })).toBe(true);
    expect(isCrisisCashAccount({ type: 'credit_card' })).toBe(true);
    expect(isCrisisCashAccount({ type: 'savings' })).toBe(true);
    expect(isCrisisCashAccount({ type: 'investment' })).toBe(false);
  });

  it('lets a savings account opt out', () => {
    expect(isCrisisCashAccount({ type: 'savings', crisisCash: false })).toBe(false);
  });

  it('lets a non-spending account opt in', () => {
    expect(isCrisisCashAccount({ type: 'investment', crisisCash: true })).toBe(true);
    expect(isCrisisCashAccount({ type: 'bank', spending: false, crisisCash: true })).toBe(true);
  });

  it('follows the spending flag when crisisCash is unset', () => {
    expect(isCrisisCashAccount({ type: 'bank', spending: false })).toBe(false);
    expect(isCrisisCashAccount({ type: 'savings', spending: true })).toBe(true);
  });

  it('always counts a spending account, whatever crisisCash says', () => {
    expect(isCrisisCashAccount({ type: 'bank', crisisCash: false })).toBe(true);
  });

  it('is false for no account', () => {
    expect(isCrisisCashAccount(null)).toBe(false);
    expect(isCrisisCashAccount(undefined)).toBe(false);
  });
});
