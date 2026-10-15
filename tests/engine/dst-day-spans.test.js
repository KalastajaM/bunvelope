// Whole-day spans must not bend around a DST switch — added 2026-08-20.
//
// Every date the engine measures a span between is a LOCAL midnight: date-only
// strings parsed as `YYYY-MM-DDT00:00:00`, or a refDate pushed to
// `setHours(0,0,0,0)`. Subtracting two of those and dividing by 86 400 000
// gives a whole number ONLY when no clock change falls between them. Across a
// spring-forward the span is N days minus an hour, so `Math.floor` reports
// N−1; across a fall-back it is N days plus an hour, so `Math.ceil` reports
// N+1. Both round the wrong way at the one moment the arithmetic stops being
// exact.
//
// This bit deterministically: `tests/section3-roadmap.test.js` has failed on
// any DST-observing machine since it was written, and stayed green in CI
// because CI runs UTC. These tests pin a real DST zone so the regression
// cannot hide behind the machine's timezone again.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { computeAgeOfMoney, computeEnvelopeGoalProgress } from '../../js/engine.js';
import { wholeDaysBetween } from '../../js/utils.js';

const origTZ = process.env.TZ;
// Europe/Helsinki switches on the last Sunday of March and October, which is
// the user's own zone — the one the failing test was reported from.
beforeAll(() => { process.env.TZ = 'Europe/Helsinki'; });
afterAll(() => { process.env.TZ = origTZ; });

const income = (id, date, amount) => ({
  id, type: 'income', status: 'posted', date, amount,
  account_id: 'a1', envelope_id: null,
});
const expense = (id, date, amount) => ({
  id, type: 'expense', status: 'posted', date, amount,
  account_id: 'a1', envelope_id: 'e1',
});

describe('wholeDaysBetween', () => {
  it('counts calendar days across the spring-forward, where a ms-diff is short an hour', () => {
    const a = new Date('2026-03-01T00:00:00');
    const b = new Date('2026-04-20T00:00:00');
    expect((b - a) / 86400000).toBeLessThan(50); // the raw span really is 49.958
    expect(wholeDaysBetween(a, b)).toBe(50);
  });

  it('counts calendar days across the fall-back, where a ms-diff runs an hour long', () => {
    const a = new Date('2026-10-01T00:00:00');
    const b = new Date('2026-11-20T00:00:00');
    expect((b - a) / 86400000).toBeGreaterThan(50);
    expect(wholeDaysBetween(a, b)).toBe(50);
  });

  it('is signed, and zero for the same day', () => {
    const a = new Date('2026-06-01T00:00:00');
    const b = new Date('2026-06-11T00:00:00');
    expect(wholeDaysBetween(a, b)).toBe(10);
    expect(wholeDaysBetween(b, a)).toBe(-10);
    expect(wholeDaysBetween(a, new Date('2026-06-01T23:30:00'))).toBe(0);
  });

  it('ignores a time-of-day component rather than letting it round the day', () => {
    // A same-day pair 23h apart is still zero days; a next-day pair 1h apart
    // is still one. Rounding the raw millisecond span would get both wrong.
    expect(wholeDaysBetween(new Date('2026-06-01T00:30:00'), new Date('2026-06-01T23:30:00'))).toBe(0);
    expect(wholeDaysBetween(new Date('2026-06-01T23:30:00'), new Date('2026-06-02T00:30:00'))).toBe(1);
  });
});

describe('computeAgeOfMoney across a DST switch', () => {
  it('ages money 50 days over a spring-forward, not 49', () => {
    const txs = [income('i1', '2026-03-01', 1000), expense('x1', '2026-04-20', 400)];
    expect(computeAgeOfMoney(txs, new Date('2026-04-25'), 30)).toBe(50);
  });

  it('ages money 50 days over a fall-back too', () => {
    const txs = [income('i1', '2026-10-01', 1000), expense('x1', '2026-11-20', 400)];
    expect(computeAgeOfMoney(txs, new Date('2026-11-25'), 30)).toBe(50);
  });

  it('is unaffected when no switch falls inside the span', () => {
    const txs = [income('i1', '2026-06-01', 1000), expense('x1', '2026-07-21', 400)];
    expect(computeAgeOfMoney(txs, new Date('2026-07-25'), 30)).toBe(50);
  });
});

describe('computeEnvelopeGoalProgress across a DST switch', () => {
  const env = { id: 'e1', name: 'Trip', goal_amount: 1000, goal_date: '2026-11-20' };

  it('counts the days to a goal across a fall-back exactly, not one too many', () => {
    // Math.ceil over a 50-days-plus-an-hour span reported 51.
    const p = computeEnvelopeGoalProgress(env, 500, new Date('2026-10-01T09:15:00'));
    expect(p.daysRemaining).toBe(50);
  });

  it('counts the days to a goal across a spring-forward exactly', () => {
    const spring = { ...env, goal_date: '2026-04-20' };
    const p = computeEnvelopeGoalProgress(spring, 500, new Date('2026-03-01T09:15:00'));
    expect(p.daysRemaining).toBe(50);
  });

  it('still reports a past goal date as negative', () => {
    const p = computeEnvelopeGoalProgress(env, 500, new Date('2026-12-01T09:15:00'));
    expect(p.daysRemaining).toBe(-11);
    expect(p.status).toBe('behind');
  });
});
