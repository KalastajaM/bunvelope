import { describe, it, expect } from 'vitest';
import { computeSavingsSplit } from '../js/engine.js';

// Regression guard for splitting locked pension insurance
// out of the "Investments" total on the dashboard Savings KPI. `type`
// stays 'investment' on a pension account for every mechanical purpose
// (forecasting, off-budget math, envelope exclusion) — only this display
// split reads the `pensionInsurance` flag.
function mkAccount(overrides = {}) {
  return {
    id: overrides.id ?? 'acc1',
    type: overrides.type ?? 'bank',
    archived: overrides.archived ?? false,
    initialBalance: overrides.initialBalance ?? 0,
    ...overrides,
  };
}

describe('computeSavingsSplit', () => {
  it('splits a pensionInsurance-flagged investment account into pension, not investment', () => {
    const accounts = [
      mkAccount({ id: 'brokerage', type: 'investment', initialBalance: 80000 }),
      mkAccount({ id: 'pension-a', type: 'investment', pensionInsurance: true, initialBalance: 30000 }),
      mkAccount({ id: 'pension-b', type: 'investment', pensionInsurance: true, initialBalance: 60000 }),
      mkAccount({ id: 'savings', type: 'savings', initialBalance: 20000 }),
    ];
    const result = computeSavingsSplit(accounts, []);
    expect(result.investment).toBeCloseTo(80000, 2);
    expect(result.pension).toBeCloseTo(90000, 2);
    expect(result.savings).toBeCloseTo(20000, 2);
    // Total is unchanged by the split — it's still the sum of all three.
    expect(result.total).toBeCloseTo(170000 + 20000, 2);
    expect(result.count).toBe(4);
  });

  it('accounts with no pensionInsurance flag behave exactly as before', () => {
    const accounts = [mkAccount({ id: 'brokerage', type: 'investment', initialBalance: 1000 })];
    const result = computeSavingsSplit(accounts, []);
    expect(result.investment).toBe(1000);
    expect(result.pension).toBe(0);
  });

  it('excludes archived accounts from both buckets', () => {
    const accounts = [
      mkAccount({ id: 'closed', type: 'investment', pensionInsurance: true, archived: true, initialBalance: 5000 }),
    ];
    const result = computeSavingsSplit(accounts, []);
    expect(result.pension).toBe(0);
    expect(result.investment).toBe(0);
    expect(result.count).toBe(0);
  });

  it('returns zeros when there are no savings/investment accounts', () => {
    const result = computeSavingsSplit([mkAccount({ id: 'checking', type: 'bank' })], []);
    expect(result).toEqual({ total: 0, savings: 0, investment: 0, pension: 0, count: 0 });
  });
});
