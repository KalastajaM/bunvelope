// §2.1 — "how much did I spend?" was answered by four different pieces of
// code in v1, and they did not agree. Worse, this module's own aggregates did
// not sum to each other: aggregateSpendingByEnvelope required an envelope
// (it has to — the envelope is the grouping key) while the by-month and payee
// aggregates did not. Two charts on one page, over one range, produced
// different totals.
//
// txEnvelopeSpend is the definition now — the same rule the envelopes meter
// and the monthly review have always used.
import { describe, it, expect } from 'vitest';
import {
  aggregateSpendingByEnvelope, aggregateSpendingByMonth,
  aggregatePayeeSpending, aggregateIncomeVsSpending,
} from '../../js/engine/reports.js';
import { txSpendPairs, txSpendTotal } from '../../js/engine/balances.js';
import { computeDashboardSummary } from '../../js/engine/insights.js';

const ENVELOPES = [
  { id: 'food', name: 'Food', category: 'Living' },
  { id: 'rent', name: 'Rent', category: 'Living' },
  { id: 'investing', name: 'Investing', category: 'Savings' },
];
const ACCOUNTS = [
  { id: 'bank', name: 'Bank', type: 'bank' },
  { id: 'broker', name: 'Broker', type: 'investment' },
];

const sum = rows => Math.round(rows.reduce((s, r) => s + r.value, 0) * 100) / 100;

/** topN 0 disables the "Other (n)" rollup, which is display, not total. */
const totals = txs => ({
  byEnvelope: sum(aggregateSpendingByEnvelope(txs, ENVELOPES, {}, 0)),
  byMonth:    sum(aggregateSpendingByMonth(txs, {})),
  byPayee:    sum(aggregatePayeeSpending(txs, {}, 0)),
  incomeVsSpending: sum(
    aggregateIncomeVsSpending(txs, ACCOUNTS, {}).series.find(s => s.name === 'Spending').points,
  ),
});

const LEDGER = [
  { id: 'e1', type: 'expense', date: '2026-04-01', payee: 'Prisma',
    account: 'bank', envelope_id: 'food', amount: 80 },
  { id: 'e2', type: 'expense', date: '2026-05-02', payee: 'Landlord',
    account: 'bank', envelope_id: 'rent', amount: 900 },
  // A split expense: no top-level envelope_id, which is the shape every one
  // of the owner's 83 split rows has.
  { id: 'e3', type: 'expense', date: '2026-05-03', payee: 'Supermarket',
    account: 'bank', amount: 60,
    envelope_splits: [
      { envelope_id: 'food', amount: 40 },
      { envelope_id: 'rent', amount: 20 },
    ] },
  // The buy leg of an investment transfer, charged to an envelope. Spend to
  // the envelopes meter and the monthly review (txSpendPairs); NOT spending in
  // the totals since the owner's 2026-09-23 decision that savings and
  // investments are not spending (txConsumptionPairs, ux-review U5).
  { id: 'i1', type: 'investment_transfer', direction: 'buy', date: '2026-06-01',
    payee: 'Broker', from_account: 'bank', to_account: 'broker',
    envelope_id: 'investing', amount: 250 },
  { id: 'inc', type: 'income', date: '2026-04-25', payee: 'Salary',
    account: 'bank', envelope_id: 'food', amount: 3000 },
];

describe('one spend rule, four surfaces', () => {
  it('every aggregate reports the same total', () => {
    const t = totals(LEDGER);
    expect(t.byMonth).toBe(t.byEnvelope);
    expect(t.byPayee).toBe(t.byEnvelope);
    expect(t.incomeVsSpending).toBe(t.byEnvelope);
    expect(t.byEnvelope).toBe(80 + 900 + 60); // the 250 buy is saving
  });

  it('they still agree when a split row is present', () => {
    // The by-envelope report has always split these correctly; the by-month
    // and payee reports counted the whole amount against the row. Both are
    // right about the total only because they now share one function.
    const t = totals([LEDGER[2]]);
    expect(new Set(Object.values(t)).size).toBe(1);
    const byEnv = aggregateSpendingByEnvelope([LEDGER[2]], ENVELOPES, {}, 0);
    expect(byEnv.find(r => r.key === 'food').value).toBe(40);
    expect(byEnv.find(r => r.key === 'rent').value).toBe(20);
  });

  it('counts no leg of an investment transfer in the totals', () => {
    expect(totals([LEDGER[3]]).byMonth).toBe(0);
    const sell = { ...LEDGER[3], id: 's1', direction: 'sell',
      from_account: 'broker', to_account: 'bank' };
    const dividend = { ...LEDGER[3], id: 'd1', direction: 'dividend',
      from_account: 'broker', to_account: 'bank' };
    expect(totals([sell, dividend]).byMonth).toBe(0);
  });

  it('does not count income, fills, transfers or adjustments', () => {
    const noise = [
      { id: 'f1', type: 'fill', date: '2026-04-10',
        lines: [{ envelope_id: 'food', mode: 'add', amount: 500 }] },
      { id: 'a1', type: 'account_transfer', date: '2026-04-11',
        from_account: 'bank', to_account: 'broker', amount: 100 },
      { id: 'x1', type: 'envelope_transfer', date: '2026-04-12',
        from_envelope_id: 'food', to_envelope_id: 'rent', amount: 50 },
      { id: 'j1', type: 'adjustment', date: '2026-04-13',
        target: 'envelope', target_id: 'food', amount: -30 },
      LEDGER[4],
    ];
    expect(totals(noise).byMonth).toBe(0);
  });

  it('an expense charged to no envelope contributes nothing, on every surface', () => {
    // The deliberate consequence of making the envelope the unit. The
    // by-envelope report could never count these — the envelope is its
    // grouping key — so the alternative was leaving three totals disagreeing.
    // 3 such rows exist on the owner's budget.
    const unenveloped = [{
      id: 'u1', type: 'expense', date: '2026-04-01', payee: 'Kiosk',
      account: 'bank', amount: 35.73,
    }];
    const t = totals(unenveloped);
    expect(new Set(Object.values(t))).toEqual(new Set([0]));
  });

  it('a non-posted row contributes nothing, on every surface', () => {
    // The posted/scheduled question, decided once. The dashboard KPI already
    // filtered this way; the reports did not, so a future-dated bill inflated
    // every historical chart. One such row on the owner's budget — and it is
    // dated 2027.
    const scheduled = [{
      id: 'sch', type: 'expense', date: '2027-07-17', payee: 'Tax',
      account: 'bank', envelope_id: 'rent', amount: 10041, status: 'scheduled',
    }];
    const t = totals(scheduled);
    expect(new Set(Object.values(t))).toEqual(new Set([0]));

    // ...and it still counts once posted.
    expect(totals([{ ...scheduled[0], status: 'posted' }]).byMonth).toBe(10041);
  });

  it('a negative split line credits back rather than adding', () => {
    const credited = [{
      id: 'c1', type: 'expense', date: '2026-04-01', payee: 'Shop',
      account: 'bank', amount: 30,
      envelope_splits: [
        { envelope_id: 'food', amount: 50 },
        { envelope_id: 'rent', amount: -20 },
      ],
    }];
    expect(totals(credited).byMonth).toBe(30);
  });

  // §2.5 / §2.1 step 3 — the dashboard's donut and trend computed spend
  // independently of the KPI beside them. The donut also bucketed by
  // `envById[tx.envelope_id]` with a literal 'other' fallback, so every split
  // expense landed in `other` at its FULL amount — all 83 of the owner's
  // split rows, worth 8588.89.
  describe('the dashboard shares the same rule', () => {
    it('the per-envelope pairs sum to the row total', () => {
      // This is what makes the donut's slices add up to the KPI: they are the
      // same numbers, grouped differently.
      for (const tx of LEDGER) {
        const paired = txSpendPairs(tx).reduce((s, [, a]) => s + a, 0);
        expect(paired).toBeCloseTo(txSpendTotal(tx), 10);
      }
    });

    it('a split row distributes across its envelopes and lands in none of "other"', () => {
      const pairs = txSpendPairs(LEDGER[2]);
      expect(pairs).toEqual([['food', 40], ['rent', 20]]);
      // The old rule put the whole 60 under a single missing-envelope bucket.
      expect(pairs.reduce((s, [, a]) => s + a, 0)).toBe(60);
    });

    it('computeDashboardSummary reports the same month total as the reports', () => {
      const summary = computeDashboardSummary(ACCOUNTS, LEDGER, [], '2026-05');
      const may = aggregateSpendingByMonth(LEDGER, {}).find(r => r.key === '2026-05');
      expect(summary.spentThisMonth).toBeCloseTo(may.value, 2);
      expect(summary.spentThisMonth).toBe(960); // 900 rent + the 60 split row
    });
  });
});
