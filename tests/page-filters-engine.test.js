// Page filters: excluding envelopes (per split pair) from the report
// aggregates, and the payee key the payee filter matches on.
import { describe, it, expect } from 'vitest';
import {
  aggregateSpendingByEnvelope, aggregatePayeeSpending, aggregateIncomeVsSpending, aggregateSpendingByMonth,
  aggregateEnvelopeBalances, aggregateBudgetAllocation, computeEnvelopeBalanceHistory,
  computeEnvelopeBalanceHistoryByEnvelope, txPayeeLabel,
} from '../js/engine.js';

const envs = [
  { id: 'food', name: 'Food', category: 'Essentials' },
  { id: 'house', name: 'House', category: 'Essentials' },
  { id: 'fun', name: 'Fun', category: 'Lifestyle' },
];
const txs = [
  { type: 'income', date: '2026-03-01', amount: 500, envelope_id: 'food', payee: 'Employer', status: 'posted' },
  {
    type: 'expense', date: '2026-03-10', amount: 100, payee: ' Store ', status: 'posted',
    envelope_splits: [{ envelope_id: 'food', amount: 60 }, { envelope_id: 'house', amount: 40 }],
  },
  { type: 'expense', date: '2026-03-12', amount: 30, envelope_id: 'fun', payee: 'Cinema', status: 'posted' },
  { type: 'expense', date: '2026-04-02', amount: 20, envelope_id: 'house', payee: '', status: 'posted' },
];
const ex = { excludeEnvelopes: new Set(['house']) };
const byKey = rows => Object.fromEntries(rows.map(r => [r.key, r.value]));

describe('txPayeeLabel', () => {
  it('trims the payee and names a missing one', () => {
    expect(txPayeeLabel({ payee: ' Store ' })).toBe('Store');
    expect(txPayeeLabel({ payee: '' })).toBe('(no payee)');
    expect(txPayeeLabel({})).toBe('(no payee)');
  });
});

describe('excludeEnvelopes', () => {
  it('spending by envelope drops the excluded envelope, including its split share', () => {
    expect(byKey(aggregateSpendingByEnvelope(txs, envs, {}, 12))).toEqual({ food: 60, house: 60, fun: 30 });
    expect(byKey(aggregateSpendingByEnvelope(txs, envs, {}, 12, ex))).toEqual({ food: 60, fun: 30 });
  });

  it('spending by month keeps the other split lines and drops an emptied month', () => {
    expect(aggregateSpendingByMonth(txs, {}).map(p => p.value)).toEqual([130, 20]);
    expect(aggregateSpendingByMonth(txs, {}, ex)).toEqual([{ key: '2026-03', label: '2026-03', value: 90 }]);
  });

  it('payee spending counts only the included split lines', () => {
    expect(byKey(aggregatePayeeSpending(txs, {}, 12))).toEqual({ Store: 100, Cinema: 30, '(no payee)': 20 });
    expect(byKey(aggregatePayeeSpending(txs, {}, 12, ex))).toEqual({ Store: 60, Cinema: 30 });
  });

  it('income vs spending: only the spending series changes', () => {
    const base = aggregateIncomeVsSpending(txs, [], {});
    const out = aggregateIncomeVsSpending(txs, [], {}, ex);
    const series = (r, name) => r.series.find(s => s.name === name).points.map(p => p.value);
    expect(series(base, 'Spending')).toEqual([130, 20]);
    expect(series(out, 'Spending')).toEqual([90, 0]);
    expect(series(out, 'Income')).toEqual(series(base, 'Income'));
    expect(series(out, 'Saving')).toEqual(series(base, 'Saving'));
  });

  it('envelope balances and allocation drop the excluded rows only', () => {
    const base = aggregateEnvelopeBalances(envs, txs, 15);
    expect(aggregateEnvelopeBalances(envs, txs, 15, ex)).toEqual(base.filter(r => r.key !== 'house'));
    const items = [
      { envelope_id: 'house', default_amount: 100, monthly_schedule: { Jan: true } },
      { envelope_id: 'food', default_amount: 50, monthly_schedule: { Jan: true, Feb: true } },
    ];
    const alloc = aggregateBudgetAllocation(envs, items, 10);
    expect(aggregateBudgetAllocation(envs, items, 10, ex)).toEqual(alloc.filter(r => r.key !== 'house'));
  });

  it('no option and an empty set give the same output as before', () => {
    const none = { excludeEnvelopes: new Set() };
    expect(aggregateSpendingByEnvelope(txs, envs, {}, 12, none)).toEqual(aggregateSpendingByEnvelope(txs, envs, {}, 12));
    expect(aggregatePayeeSpending(txs, {}, 12, none)).toEqual(aggregatePayeeSpending(txs, {}, 12));
    expect(aggregateSpendingByMonth(txs, {}, none)).toEqual(aggregateSpendingByMonth(txs, {}));
  });
});

describe('computeEnvelopeBalanceHistory excludeIds', () => {
  it('leaves the excluded envelopes out of each month-end total', () => {
    const ref = new Date(2026, 3, 25);
    const base = computeEnvelopeBalanceHistory(txs, 2, ref);
    const house = computeEnvelopeBalanceHistoryByEnvelope(txs, 2, ref, ['house']).byId.get('house');
    const out = computeEnvelopeBalanceHistory(txs, 2, ref, { excludeIds: new Set(['house']) });
    expect(out.months).toEqual(base.months);
    out.totals.forEach((p, i) => expect(p.value).toBeCloseTo(base.totals[i].value - house[i].value, 2));
  });
});
