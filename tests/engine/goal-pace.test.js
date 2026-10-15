// The goal "on-track" verdict is a linear ramp over one year: with a year to
// go any progress passes, with six months you need half, on the deadline all
// of it.
//
// Past a year the ramp used to invert itself silently — `1 - daysRemaining/365`
// goes negative, `fraction` never does, so every goal more than a year out
// reported 'on-track' no matter how unfunded. A goal 18 months away at 0%
// showed green, which is the one direction nobody investigates.

import { describe, it, expect } from 'vitest';
import { computeEnvelopeGoalProgress } from '../../js/engine.js';

const goal = (over = {}) => ({ goal_amount: 1200, goal_date: '2027-06-01', ...over });
const at = iso => new Date(`${iso}T12:00:00`);

describe('computeEnvelopeGoalProgress pace verdict', () => {
  it('does not call a completely unfunded long goal on-track', () => {
    // 2027-06-01 is well over a year from 2026-01-01. Regression: 'on-track'.
    const out = computeEnvelopeGoalProgress(goal(), 0, at('2026-01-01'));
    expect(out.daysRemaining).toBeGreaterThan(365);
    expect(out.status).toBe('early');
  });

  it('abstains rather than judging, whatever the balance, beyond the horizon', () => {
    const broke = computeEnvelopeGoalProgress(goal(), 0, at('2026-01-01'));
    const flush = computeEnvelopeGoalProgress(goal(), 1100, at('2026-01-01'));
    expect(broke.status).toBe('early');
    expect(flush.status).toBe('early');
  });

  it('still reports reached beyond the horizon when the goal is met', () => {
    const out = computeEnvelopeGoalProgress(goal(), 1200, at('2026-01-01'));
    expect(out.status).toBe('reached');
  });

  it('starts judging once inside the horizon', () => {
    // ~6 months out: half the goal is the bar.
    const behind = computeEnvelopeGoalProgress(goal(), 300, at('2026-12-01'));
    const ahead = computeEnvelopeGoalProgress(goal(), 900, at('2026-12-01'));
    expect(behind.status).toBe('behind');
    expect(ahead.status).toBe('on-track');
  });

  it('an unfunded goal flips from early to behind as the year closes', () => {
    const outside = computeEnvelopeGoalProgress(goal(), 0, at('2026-05-01'));
    const inside = computeEnvelopeGoalProgress(goal(), 0, at('2026-08-01'));
    expect(outside.status).toBe('early');
    expect(inside.status).toBe('behind');
  });

  it('reports behind once the deadline has passed', () => {
    const out = computeEnvelopeGoalProgress(goal(), 100, at('2027-07-01'));
    expect(out.daysRemaining).toBeLessThan(0);
    expect(out.status).toBe('behind');
  });

  it('keeps no-deadline for a goal with no date', () => {
    const out = computeEnvelopeGoalProgress({ goal_amount: 500 }, 100, at('2026-01-01'));
    expect(out.status).toBe('no-deadline');
    expect(out.daysRemaining).toBeNull();
  });

  // QA 2026-09-23 #4 — an unparseable date made `daysRemaining` NaN, which
  // `round2` turned into a monthlyRequired of 0, which read as 'on-track':
  // a confident green verdict on a deadline nobody could state.
  it('treats an invalid goal_date as no deadline, not as on-track', () => {
    for (const bad of ['soon', '2026-13-01', '2026-02-31', '31/12/2026']) {
      const out = computeEnvelopeGoalProgress(goal({ goal_date: bad }), 0, at('2026-01-01'));
      expect(out.status, bad).toBe('no-deadline');
      expect(out.goalDate, bad).toBeNull();
      expect(out.daysRemaining, bad).toBeNull();
      expect(out.monthlyRequired, bad).toBeNull();
    }
  });

  it('still reports reached for a met goal with an invalid goal_date', () => {
    const out = computeEnvelopeGoalProgress(goal({ goal_date: 'soon' }), 1200, at('2026-01-01'));
    expect(out.status).toBe('reached');
  });
});

// `goal_start` is what turns the ramp from "assume a one-year plan" into a
// measurement over the goal's own span, so a long goal gets a real verdict
// instead of an abstention.
describe('computeEnvelopeGoalProgress with goal_start', () => {
  // 2026-01-01 → 2028-01-01: a two-year goal of 1200.
  const long = (over = {}) => ({
    goal_amount: 1200, goal_start: '2026-01-01', goal_date: '2028-01-01', ...over,
  });

  it('judges a long goal instead of abstaining', () => {
    // Halfway through the span, so half the goal is the bar.
    const behind = computeEnvelopeGoalProgress(long(), 400, at('2027-01-01'));
    const ahead = computeEnvelopeGoalProgress(long(), 700, at('2027-01-01'));
    expect(behind.status).toBe('behind');
    expect(ahead.status).toBe('on-track');
  });

  it('asks for nothing at the very start of a long goal', () => {
    const out = computeEnvelopeGoalProgress(long(), 0, at('2026-01-01'));
    expect(out.status).toBe('on-track');
  });

  it('asks for nearly everything as the deadline closes', () => {
    const out = computeEnvelopeGoalProgress(long(), 1000, at('2027-12-01'));
    expect(out.status).toBe('behind'); // ~96% of the span elapsed, 83% saved
  });

  it('scales to a short goal too, where a year-long ramp would be far too soft', () => {
    // Three months, 900. One month in, 100 saved is behind a third of the way.
    const short = { goal_amount: 900, goal_start: '2026-01-01', goal_date: '2026-04-01' };
    expect(computeEnvelopeGoalProgress(short, 100, at('2026-02-01')).status).toBe('behind');
    expect(computeEnvelopeGoalProgress(short, 400, at('2026-02-01')).status).toBe('on-track');
  });

  it('ignores a start on or after the deadline rather than trusting it', () => {
    // A backwards or zero-length span cannot produce a ramp; fall back.
    const backwards = long({ goal_start: '2028-06-01' });
    expect(computeEnvelopeGoalProgress(backwards, 0, at('2026-01-01')).status).toBe('early');
    const zero = long({ goal_start: '2028-01-01' });
    expect(computeEnvelopeGoalProgress(zero, 0, at('2026-01-01')).status).toBe('early');
  });

  it('ignores a malformed start', () => {
    const bad = long({ goal_start: 'january' });
    expect(computeEnvelopeGoalProgress(bad, 0, at('2026-01-01')).status).toBe('early');
  });

  it('still reports reached and behind regardless of the start', () => {
    expect(computeEnvelopeGoalProgress(long(), 1200, at('2026-06-01')).status).toBe('reached');
    expect(computeEnvelopeGoalProgress(long(), 10, at('2028-06-01')).status).toBe('behind');
  });
});
