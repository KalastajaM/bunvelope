// §2.10 — a stated trim removed less than it said.
//
// fillShareByMonth split a per-month fillDelta EVENLY across that month's
// fills, and applyFillDelta clamps each fill at zero INDIVIDUALLY. With
// unequal fills the small one clamps out having given up less than its share,
// and the remainder is discarded rather than redistributed: the label names
// an amount and the projection moves a different one.
//
// The worked case from BACKLOG.md (2026-08-16): fills of 1000 and 200, a
// stated trim of 1200. Evenly split that is −600 each; the 200 fill clamps at
// 0 having surrendered only 200, so 800 is removed while the label says 1200.
//
// Driven through the real path — two scheduled templates funding one envelope
// on different days of the same month, which is the shape the docstring names
// (bi-weekly or twice-monthly pay).
import { describe, it, expect } from 'vitest';
import { projectEnvelopeBalance } from '../../js/engine.js';

const ENVELOPES = [{ id: 'env', name: 'Env' }];
const ALL_MONTHS = {
  Jan: true, Feb: true, Mar: true, Apr: true, May: true, Jun: true,
  Jul: true, Aug: true, Sep: true, Oct: true, Nov: true, Dec: true,
};

const template = (id, day, amount) => ({
  id, name: id, kind: 'manual',
  lines: [{ envelope_id: 'env', mode: 'add', amount }],
  schedule: {
    enabled: true, payment_day: day, day_type: 'exact',
    since: '2026-01-01', months: { ...ALL_MONTHS },
  },
});

/** Sum of everything that arrived in the projected month. */
const monthIn = (templates, fillDelta) => projectEnvelopeBalance({
  envelopeId: 'env', transactions: [], budgetItems: [],
  envelopeTemplates: templates, accounts: [], envelopes: ENVELOPES,
  today: new Date(2026, 1, 1), months: 1, fillDelta,
}).months.find(m => m.key === '2026-02').in;

const UNEQUAL = [template('big', 5, 1000), template('small', 20, 200)];
const EQUAL   = [template('a', 5, 500),    template('b', 20, 500)];

describe('fillDelta is split in proportion to each fill, not evenly', () => {
  it('the fixture really does produce two unequal fills in the month', () => {
    expect(monthIn(UNEQUAL, 0)).toBeCloseTo(1200, 2);
  });

  it('a stated trim of the whole month removes the whole month', () => {
    // The defect: an even split left 400 of the 1200 in place, because the
    // 200 fill clamped at zero and its unused 400 was discarded.
    expect(monthIn(UNEQUAL, -1200)).toBeCloseTo(0, 2);
  });

  it('a partial trim comes off both fills in proportion', () => {
    // −600 of 1200 is half: 1000 → 500, 200 → 100.
    expect(monthIn(UNEQUAL, -600)).toBeCloseTo(600, 2);
  });

  it('a raise is split proportionally too, and still totals the delta', () => {
    expect(monthIn(UNEQUAL, 600)).toBeCloseTo(1800, 2);
  });

  it('the per-fill zero clamp is still in force', () => {
    // Trimming more than the month contains cannot turn a fill into a
    // withdrawal — the floor applyFillDelta's comment is about.
    expect(monthIn(UNEQUAL, -5000)).toBeCloseTo(0, 2);
  });

  it('equal fills are unaffected — proportional and even agree', () => {
    expect(monthIn(EQUAL, 0)).toBeCloseTo(1000, 2);
    expect(monthIn(EQUAL, -400)).toBeCloseTo(600, 2);
  });
});
