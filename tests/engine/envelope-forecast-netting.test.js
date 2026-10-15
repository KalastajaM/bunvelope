// Regression test for a cross-envelope netting bug found 2026-08-20 while
// investigating why the health check charged Clothes its full monthly plan
// for August despite 680.92 of the 750 already having been spent.
//
// `gatherEvents` in envelope-forecast.js nets an envelope's month-to-date
// spend against its own remaining plan line (`netAgainstSpentThisMonth`),
// scoped by `envelopeId`. But it built the candidate rows to net against by
// calling `forecastPlannedExpenses` with EVERY budget item, not just the
// current envelope's — so the pool (correctly scoped to this envelope's own
// spend) was consumed by whichever envelope's plan row happened to sort
// first among same-day rows (ties break on budget-item array order), not by
// this envelope's own row. In the real ledger, Groceries and Food & Drinks
// both post month-end with no fixed payment day, sort ahead of nearly every
// other envelope, and silently absorbed every other envelope's netting pool
// — Clothes, Public Transport, Car Charging and Car Parking all lost their
// netting entirely and were charged as if nothing had been spent yet.
//
// Fixed by scoping the budget items passed into `forecastPlannedExpenses`
// to the envelope being projected before netting.

import { describe, it, expect } from 'vitest';
import { projectEnvelopeBalance } from '../../js/engine.js';

const ENVELOPES = [
  { id: 'groceries', name: 'Groceries' },
  { id: 'clothes', name: 'Clothes' },
];

const ALL_MONTHS = {
  Jan: true, Feb: true, Mar: true, Apr: true, May: true, Jun: true,
  Jul: true, Aug: true, Sep: true, Oct: true, Nov: true, Dec: true,
};

// Both items are unscheduled (recorded by hand) with no fixed payment day, so
// both forecast to month end — the real-world shape (Clothes and Groceries
// both fall back to the 31st). Groceries is listed FIRST and has the larger
// plan, matching the real budget-item order that let it swallow another
// envelope's netting pool.
const GROCERIES_ITEM = {
  id: 'bi-groceries', envelope_id: 'groceries', kind: 'expense', include: true,
  as_schedule: false, payment_day: 0, default_amount: -800,
  monthly_schedule: { ...ALL_MONTHS },
};
const CLOTHES_ITEM = {
  id: 'bi-clothes', envelope_id: 'clothes', kind: 'expense', include: true,
  as_schedule: false, payment_day: 0, default_amount: -100,
  monthly_schedule: { ...ALL_MONTHS },
};

const TODAY = new Date(2026, 0, 15); // 2026-01-15 — partial month, some of it already spent

describe('projectEnvelopeBalance — same-month netting is scoped per envelope', () => {
  it("nets an envelope's own month-to-date spend against its own plan line", () => {
    const transactions = [
      { id: 'tx-clothes-1', type: 'expense', date: '2026-01-10', status: 'posted', envelope_id: 'clothes', amount: 60 },
    ];

    const clothes = projectEnvelopeBalance({
      envelopeId: 'clothes', transactions,
      budgetItems: [GROCERIES_ITEM, CLOTHES_ITEM], // Groceries sorts first
      envelopeTemplates: [], accounts: [], envelopes: ENVELOPES, today: TODAY, months: 1,
    });

    const jan = clothes.months.find(m => m.key === '2026-01');
    // Plan is 100; 60 already spent this month should net off, leaving 40 —
    // not 100, which is what Groceries' larger same-day row absorbing the
    // pool instead of Clothes' own row produced before this fix.
    expect(jan.out).toBeCloseTo(-40, 2);
  });

  it("does not let one envelope's spend net against a sibling envelope's plan line", () => {
    const transactions = [
      { id: 'tx-clothes-1', type: 'expense', date: '2026-01-10', status: 'posted', envelope_id: 'clothes', amount: 60 },
    ];

    const groceries = projectEnvelopeBalance({
      envelopeId: 'groceries', transactions,
      budgetItems: [GROCERIES_ITEM, CLOTHES_ITEM],
      envelopeTemplates: [], accounts: [], envelopes: ENVELOPES, today: TODAY, months: 1,
    });

    const jan = groceries.months.find(m => m.key === '2026-01');
    // Groceries itself has spent nothing, so its full 800 plan should still
    // show — Clothes' spend must never net against Groceries' row either.
    expect(jan.out).toBeCloseTo(-800, 2);
  });

  it('nets correctly regardless of which envelope sorts first among same-day rows', () => {
    const transactions = [
      { id: 'tx-groceries-1', type: 'expense', date: '2026-01-03', status: 'posted', envelope_id: 'groceries', amount: 500 },
    ];

    const groceries = projectEnvelopeBalance({
      envelopeId: 'groceries', transactions,
      budgetItems: [GROCERIES_ITEM, CLOTHES_ITEM],
      envelopeTemplates: [], accounts: [], envelopes: ENVELOPES, today: TODAY, months: 1,
    });
    const clothes = projectEnvelopeBalance({
      envelopeId: 'clothes', transactions,
      budgetItems: [GROCERIES_ITEM, CLOTHES_ITEM],
      envelopeTemplates: [], accounts: [], envelopes: ENVELOPES, today: TODAY, months: 1,
    });

    expect(groceries.months.find(m => m.key === '2026-01').out).toBeCloseTo(-300, 2); // 800 - 500
    expect(clothes.months.find(m => m.key === '2026-01').out).toBeCloseTo(-100, 2);   // untouched
  });
});
