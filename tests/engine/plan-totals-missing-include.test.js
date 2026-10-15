// A plan item with no `include` field (very old, or hand-edited) is enabled:
// posting, forecasting, the plan page's chip and the editor all read only an
// explicit `false` as Disabled (see disabled-plan-item.test.js). The plan
// totals must agree, or such an item posts every month yet is left out of the
// annual totals, the plan page's category sums and Stress.

import { describe, it, expect } from 'vitest';
import { computeAnnualTotals } from '../../js/engine.js';
import { annualAmount } from '../../js/engine/stress.js';

const ALL = {
  Jan: true, Feb: true, Mar: true, Apr: true, May: true, Jun: true,
  Jul: true, Aug: true, Sep: true, Oct: true, Nov: true, Dec: true,
};
const income = (over = {}) => ({
  id: 'inc', kind: 'income', default_amount: 1000, monthly_schedule: { ...ALL }, ...over,
});
const expense = (over = {}) => ({
  id: 'exp', kind: 'expense', envelope_id: 'bills', default_amount: -100,
  monthly_schedule: { ...ALL }, extra_buffer: 0, ...over,
});

describe('computeAnnualTotals and a missing include', () => {
  it('counts items without an include field on both sides', () => {
    expect(computeAnnualTotals([income(), expense()])).toEqual({
      income: 12000, budget: 1200, diff: 10800,
    });
  });

  it('leaves out an explicit include: false', () => {
    expect(computeAnnualTotals([
      income({ include: false }), expense({ include: false }),
    ])).toEqual({ income: 0, budget: 0, diff: 0 });
  });

  it('counts an explicit include: true exactly as before', () => {
    expect(computeAnnualTotals([income({ include: true }), expense({ include: true })]))
      .toEqual({ income: 12000, budget: 1200, diff: 10800 });
  });
});

describe('Stress annualAmount and a missing include', () => {
  it('counts an item without an include field', () => {
    expect(annualAmount(expense())).toBe(1200);
  });

  it('returns 0 for an explicit include: false', () => {
    expect(annualAmount(expense({ include: false }))).toBe(0);
  });
});
