// tests/engine/dashboard-summary.test.js — computeDashboardSummary drives
// the primary dashboard numbers; pin the aggregation rules with a fixture
// small enough to hand-derive.

import { describe, it, expect } from 'vitest';
import { computeDashboardSummary } from '../../js/engine/insights.js';

const accounts = [
  { id: 'a1', name: 'Checking', type: 'bank', initialBalance: 100 },
];

const txs = [
  { id: 't1', type: 'expense', status: 'posted', account: 'a1', envelope_id: 'food', amount: 50, date: '2026-03-10' },
  { id: 't2', type: 'expense', status: 'posted', account: 'a1', envelope_id: 'food', amount: 20, date: '2026-02-05' },
  // Scheduled rows are not "spent".
  { id: 't3', type: 'expense', status: 'scheduled', account: 'a1', envelope_id: 'food', amount: 99, date: '2026-03-20' },
  // Income is not spend.
  { id: 't4', type: 'income', status: 'posted', account: 'a1', amount: 500, date: '2026-03-01' },
];

describe('computeDashboardSummary', () => {
  it('aggregates balances, unallocated and the month spend', () => {
    const s = computeDashboardSummary(accounts, txs, [], '2026-03');
    // Envelopes: food spent 50+20+99 (all expense rows hit the envelope) → −169.
    expect(s.totalEnvelopeBalance).toBe(-169);
    // Accounts in the all-inclusive view: 100 − 50 − 20 − 99 + 500 = 431.
    expect(s.totalAccountBalance).toBe(431);
    // Zero-sum: unallocated = accounts − envelopes.
    expect(s.unallocated).toBe(600);
    // Spend counts only POSTED expenses inside the month.
    expect(s.spentThisMonth).toBe(50);
    expect(s.plannedThisMonth).toBe(0);
  });

  it('buckets spend per month', () => {
    expect(computeDashboardSummary(accounts, txs, [], '2026-02').spentThisMonth).toBe(20);
    expect(computeDashboardSummary(accounts, txs, [], '2026-01').spentThisMonth).toBe(0);
  });

  it('counts status-less expenses as posted (manual entry never sets status)', () => {
    const mixed = [
      { id: 'p1', type: 'expense', status: 'posted', account: 'a1', envelope_id: 'food', amount: 50, date: '2026-03-10' },
      // Manual entry: no status field at all — must count.
      { id: 'm1', type: 'expense', account: 'a1', envelope_id: 'food', amount: 30, date: '2026-03-12' },
      // Forecast rows are never "spent", regardless of status.
      { id: 'f1', type: 'expense', status: 'posted', is_forecast: true, account: 'a1', envelope_id: 'food', amount: 77, date: '2026-03-13' },
    ];
    const s = computeDashboardSummary(accounts, mixed, [], '2026-03');
    expect(s.spentThisMonth).toBe(80);
  });

  it('counts a stray negative posted amount at its magnitude', () => {
    const rows = [
      { id: 'n1', type: 'expense', status: 'posted', account: 'a1', envelope_id: 'food', amount: -40, date: '2026-03-10' },
    ];
    const s = computeDashboardSummary(accounts, rows, [], '2026-03');
    expect(s.spentThisMonth).toBe(40);
  });

  it('skips expenses with invalid dates or amounts', () => {
    const bad = [
      { id: 'x1', type: 'expense', status: 'posted', account: 'a1', amount: 10, date: 'not-a-date' },
      { id: 'x2', type: 'expense', status: 'posted', account: 'a1', amount: 'abc', date: '2026-03-11' },
    ];
    const s = computeDashboardSummary(accounts, bad, [], '2026-03');
    expect(s.spentThisMonth).toBe(0);
  });
});
