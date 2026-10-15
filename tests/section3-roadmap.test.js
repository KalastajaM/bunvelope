import { describe, it, expect } from 'vitest';
import {
  classifyFrequency,
  computeAgeOfMoney,
  computeEnvelopeBalanceHistory,
  aggregatePayeeSpending,
  computeEnvelopeGoalProgress,
  applyEnvelopeRollovers,
} from '../js/engine.js';

describe('§3.11 classifyFrequency — divisor + spacing aware', () => {
  const env = { id: 'e1', name: 'X', category: 'C' };
  function items(months) {
    const sched = {};
    for (const m of months) sched[m] = true;
    return [{ envelope_id: 'e1', kind: 'expense', monthly_schedule: sched, default_amount: 10, include: true }];
  }

  it('Monthly when all 12 months active', () => {
    expect(classifyFrequency(env, items(['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']))).toBe('Monthly');
  });
  it('Every 2 Months when 6 evenly-spaced', () => {
    expect(classifyFrequency(env, items(['Jan','Mar','May','Jul','Sep','Nov']))).toBe('Every 2 Months');
  });
  it('Every 3 Months when 4 evenly-spaced', () => {
    expect(classifyFrequency(env, items(['Jan','Apr','Jul','Oct']))).toBe('Every 3 Months');
  });
  it('Every 4 Months when 3 evenly-spaced', () => {
    expect(classifyFrequency(env, items(['Jan','May','Sep']))).toBe('Every 4 Months');
  });
  it('Every 6 Months when 2 evenly-spaced', () => {
    expect(classifyFrequency(env, items(['Mar','Sep']))).toBe('Every 6 Months');
  });
  it('Annual when 1 month', () => {
    expect(classifyFrequency(env, items(['Apr']))).toBe('Annual');
  });
  it('Irregular when 6 months but unevenly spaced', () => {
    // Jan-Mar + Jul-Sep is 6 months but clumped, not "every 2"
    expect(classifyFrequency(env, items(['Jan','Feb','Mar','Jul','Aug','Sep']))).toBe('Irregular');
  });
  it('Irregular when count does not divide 12', () => {
    expect(classifyFrequency(env, items(['Jan','Feb','Mar','Apr','May']))).toBe('Irregular'); // 5 months
  });
});

describe('§3.3 computeAgeOfMoney — FIFO replay', () => {
  it('returns null when no spending in window', () => {
    const txs = [{ type: 'income', date: '2026-01-01', amount: 100, status: 'posted' }];
    expect(computeAgeOfMoney(txs, new Date('2026-04-25'))).toBe(null);
  });

  it('returns null when spending exceeds available income', () => {
    const txs = [
      { type: 'expense', date: '2026-04-10', amount: 100, status: 'posted' },
    ];
    expect(computeAgeOfMoney(txs, new Date('2026-04-25'))).toBe(null);
  });

  it('computes weighted age across multiple deposits', () => {
    // Deposit €100 on Mar 1, €100 on Apr 1. Spend €100 on Apr 20.
    // FIFO consumes the Mar 1 deposit first → age = 50 days.
    const txs = [
      { type: 'income',  date: '2026-03-01', amount: 100, status: 'posted' },
      { type: 'income',  date: '2026-04-01', amount: 100, status: 'posted' },
      { type: 'expense', date: '2026-04-20', amount: 100, status: 'posted' },
    ];
    const aom = computeAgeOfMoney(txs, new Date('2026-04-25'));
    expect(aom).toBe(50);
  });
});

describe('§3.5 computeEnvelopeBalanceHistory', () => {
  it('returns one entry per month, oldest first', () => {
    const txs = [
      { type: 'income',  date: '2026-01-15', amount: 200, envelope_id: 'savings', status: 'posted' },
      { type: 'expense', date: '2026-02-10', amount: 50,  envelope_id: 'savings', status: 'posted' },
    ];
    const out = computeEnvelopeBalanceHistory(txs, 3, new Date('2026-04-25'));
    expect(out.months.length).toBe(3);
    expect(out.totals.length).toBe(3);
    // End of Feb: 200 - 50 = 150. End of Mar: 150. End of Apr: 150.
    expect(out.totals[0].value).toBe(150);
    expect(out.totals[2].value).toBe(150);
  });
});

describe('§3.7 aggregatePayeeSpending', () => {
  it('groups expenses by payee, descending by value', () => {
    // §2.1 — spend is measured per envelope, so these rows carry one. An
    // expense charged to no envelope contributes nothing, by design; that is
    // pinned in tests/engine/spend-rule.test.js.
    const txs = [
      { type: 'expense', date: '2026-04-01', envelope_id: 'food', payee: 'Prisma',  amount: 80 },
      { type: 'expense', date: '2026-04-02', envelope_id: 'food', payee: 'Prisma',  amount: 40 },
      { type: 'expense', date: '2026-04-03', envelope_id: 'food', payee: 'K-Citymarket', amount: 60 },
      { type: 'income',  date: '2026-04-04', envelope_id: 'food', payee: 'Salary',  amount: 1000 },
    ];
    const out = aggregatePayeeSpending(txs);
    expect(out[0].label).toBe('Prisma');
    expect(out[0].value).toBe(120);
    expect(out[1].label).toBe('K-Citymarket');
    expect(out.find(r => r.label === 'Salary')).toBeUndefined();
  });

  it('buckets blank payees as "(no payee)"', () => {
    const txs = [
      { type: 'expense', date: '2026-04-01', envelope_id: 'food', payee: '', amount: 10 },
      { type: 'expense', date: '2026-04-02', envelope_id: 'food',            amount: 20 },
    ];
    const out = aggregatePayeeSpending(txs);
    expect(out.length).toBe(1);
    expect(out[0].label).toBe('(no payee)');
    expect(out[0].value).toBe(30);
  });
});

describe('§3.2 computeEnvelopeGoalProgress', () => {
  it('returns null when goal_amount is unset', () => {
    expect(computeEnvelopeGoalProgress({ id: 'e' }, 100, new Date('2026-04-25'))).toBeNull();
  });

  it('reports reached when balance ≥ goal', () => {
    const out = computeEnvelopeGoalProgress({ goal_amount: 500 }, 510, new Date('2026-04-25'));
    expect(out.status).toBe('reached');
  });

  it('computes monthly required when goal_date set', () => {
    const out = computeEnvelopeGoalProgress(
      { goal_amount: 1200, goal_date: '2026-10-25' },
      0,
      new Date('2026-04-25'),
    );
    // 6 months × ~30.4 days. Required ≈ 1200 / 6 = 200/mo.
    expect(out.monthlyRequired).toBeGreaterThan(190);
    expect(out.monthlyRequired).toBeLessThan(210);
    expect(out.daysRemaining).toBeGreaterThan(170);
  });
});

describe('§3.4 applyEnvelopeRollovers', () => {
  function envWith(rollover) {
    return [{ id: 'e1', name: 'X', category: 'C', rollover }];
  }
  function txAt(env, date, amount, status = 'posted') {
    return { id: 't' + Math.random(), type: 'expense', envelope_id: env, date, amount, status };
  }

  it('cover-from-unallocated raises a negative envelope to zero', () => {
    // March ended at -30 for envelope e1.
    const txs = [
      { id: 'i1', type: 'income', date: '2026-03-01', amount: 50, envelope_id: 'e1', status: 'posted' },
      txAt('e1', '2026-03-15', 80),
    ];
    const { newTxs } = applyEnvelopeRollovers(envWith('cover-from-unallocated'), txs, new Date('2026-04-05'));
    expect(newTxs.length).toBe(1);
    expect(newTxs[0].amount).toBeCloseTo(30, 2);
    expect(newTxs[0].target).toBe('envelope');
    expect(newTxs[0].target_id).toBe('e1');
    expect(newTxs[0].from_budget).toBe('rollover:e1:2026-03');
  });

  it('zero-monthly sweeps positive remainder back to unallocated', () => {
    const txs = [
      { id: 'i1', type: 'income', date: '2026-03-01', amount: 100, envelope_id: 'e1', status: 'posted' },
      txAt('e1', '2026-03-15', 25),
    ];
    const { newTxs } = applyEnvelopeRollovers(envWith('zero-monthly'), txs, new Date('2026-04-05'));
    expect(newTxs.length).toBe(1);
    expect(newTxs[0].amount).toBeCloseTo(-75, 2);
  });

  it('carry policy never emits adjustments', () => {
    const txs = [
      { id: 'i1', type: 'income', date: '2026-03-01', amount: 100, envelope_id: 'e1', status: 'posted' },
      txAt('e1', '2026-03-15', 25),
    ];
    const { newTxs } = applyEnvelopeRollovers(envWith('carry'), txs, new Date('2026-04-05'));
    expect(newTxs.length).toBe(0);
  });

  it('is idempotent — re-running produces no further txs', () => {
    const txs = [
      { id: 'i1', type: 'income', date: '2026-03-01', amount: 50, envelope_id: 'e1', status: 'posted' },
      txAt('e1', '2026-03-15', 80),
    ];
    const first = applyEnvelopeRollovers(envWith('cover-from-unallocated'), txs, new Date('2026-04-05')).newTxs;
    const merged = [...txs, ...first];
    const second = applyEnvelopeRollovers(envWith('cover-from-unallocated'), merged, new Date('2026-04-05')).newTxs;
    expect(second.length).toBe(0);
  });
});
