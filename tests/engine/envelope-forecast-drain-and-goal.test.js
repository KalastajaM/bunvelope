// 2026-09-25 backlog fixes in envelope-forecast.js:
//  - `fillDelta` moves only fills INTO the envelope. A source envelope's
//    scheduled drains (its lines on a template that funds others) used to be
//    clamped at zero by any raise, so "raise the monthly fill by 1" was the
//    advice for a gap of thousands.
//  - A goal with no monthly rate to raise gets a one-time top-up by its date.
//  - projectEnvelopeBalance / recommendEnvelopeActions hardening.

import { describe, it, expect } from 'vitest';
import { projectEnvelopeBalance, recommendEnvelopeActions } from '../../js/engine.js';

const ALL = {
  Jan: true, Feb: true, Mar: true, Apr: true, May: true, Jun: true,
  Jul: true, Aug: true, Sep: true, Oct: true, Nov: true, Dec: true,
};
const TODAY = new Date(2026, 0, 1);
const byKind = (recs, kind) => recs.find(r => r.kind === kind);

// A buffer that funds another envelope 1700 a month and receives nothing on
// a schedule: the drain-only case.
function bufferInput({ opening = 3000, extraTemplates = [] } = {}) {
  return {
    envelopeId: 'buf',
    transactions: [{
      id: 'seed', type: 'fill', date: '2025-12-20', status: 'posted',
      lines: [{ envelope_id: 'buf', mode: 'add', amount: opening }],
    }],
    budgetItems: [],
    envelopeTemplates: [{
      id: 'draw', name: 'Draw',
      lines: [{ envelope_id: 'bills', mode: 'add', amount: 1700 }],
      schedule: { enabled: true, payment_day: 5, day_type: 'exact', months: { ...ALL }, source_envelope_id: 'buf' },
    }, ...extraTemplates],
    accounts: [],
    envelopes: [{ id: 'buf', name: 'Buffer' }, { id: 'bills', name: 'Bills' }],
    today: TODAY,
    months: 12,
  };
}

describe('source envelope drains are not a fill to raise', () => {
  it('a raise leaves the drains untouched', () => {
    const input = bufferInput();
    const base = projectEnvelopeBalance(input);
    const raised = projectEnvelopeBalance({ ...input, fillDelta: 100 });
    expect(base.monthlyFill).toBeLessThan(0);
    expect(raised.daily).toEqual(base.daily);
  });

  it('stands the monthly rules down and says why, keeping the one-time top-up', () => {
    const recs = recommendEnvelopeActions(bufferInput());
    expect(byKind(recs, 'shortfall-topup')).toBeTruthy();
    expect(byKind(recs, 'shortfall-topup').amount).toBeGreaterThan(1000);
    expect(byKind(recs, 'shortfall-monthly')).toBeUndefined();
    expect(byKind(recs, 'overfunded-trim')).toBeUndefined();
    expect(byKind(recs, 'warn-drain-only-fill')).toMatchObject({ severity: 'info' });
  });

  it('with a real inflow as well, the raise moves only the inflow, by the stated amount', () => {
    const input = bufferInput({
      extraTemplates: [{
        id: 'in', name: 'Top up buffer',
        lines: [{ envelope_id: 'buf', mode: 'add', amount: 500 }],
        schedule: { enabled: true, payment_day: 25, day_type: 'exact', months: { ...ALL } },
      }],
    });
    const base = projectEnvelopeBalance(input);
    const raised = projectEnvelopeBalance({ ...input, fillDelta: 100 });
    // Every whole month takes in exactly 100 more; the drain is unchanged.
    const whole = base.months.filter(m => !m.partial);
    const wholeRaised = raised.months.filter(m => !m.partial);
    expect(wholeRaised.map(m => m.in)).toEqual(whole.map(m => m.in + 100));
    expect(wholeRaised.map(m => m.out)).toEqual(whole.map(m => m.out));
    const recs = recommendEnvelopeActions(input);
    expect(byKind(recs, 'warn-drain-only-fill')).toBeUndefined();
  });
});

describe('goal shortfall without a monthly rate', () => {
  const QUARTERLY = { Jan: true, Apr: true, Jul: true, Oct: true };
  const goalInput = (goal) => ({
    envelopeId: 'car',
    transactions: [],
    budgetItems: [],
    envelopeTemplates: [{
      id: 'q', name: 'Car savings',
      lines: [{ envelope_id: 'car', mode: 'add', amount: 300 }],
      schedule: { enabled: true, payment_day: 10, day_type: 'exact', months: { ...QUARTERLY } },
    }],
    accounts: [],
    envelopes: [{ id: 'car', name: 'Car', ...goal }],
    today: TODAY,
    months: 12,
  });

  it('advises a one-time top-up that actually reaches the goal by its date', () => {
    const input = goalInput({ goal_amount: 3000, goal_date: '2026-09-30' });
    expect(projectEnvelopeBalance(input).fillSource).toBe('scheduled-irregular');
    const rec = byKind(recommendEnvelopeActions(input), 'goal-shortfall');
    expect(rec.meta.fillMode).toBe('one-time');
    expect(rec.date).toBe('2026-09-30');
    // Verified by re-projection, not derived: three quarterly fills of 300
    // by 30 Sep leave 2100 to find.
    expect(rec.amount).toBeCloseTo(2100, 0);
    const withTopup = projectEnvelopeBalance({
      ...input,
      injections: [{
        id: 'x', type: 'fill', date: '2026-09-30', status: 'scheduled',
        lines: [{ envelope_id: 'car', mode: 'add', amount: rec.amount }],
      }],
    });
    const atGoal = withTopup.daily.find(d => d.date === '2026-09-30');
    expect(atGoal.balance).toBeGreaterThanOrEqual(3000 - 0.01);
  });

  it('names the window end as the date when the goal has none', () => {
    const rec = byKind(recommendEnvelopeActions(goalInput({ goal_amount: 9000 })), 'goal-shortfall');
    expect(rec.date).toBeNull();
    expect(rec.meta.cutoff).toBe('2026-12-31');
  });
});

describe('projectEnvelopeBalance hardening', () => {
  it('a window of zero or fewer months is one month, not a single day', () => {
    const p = projectEnvelopeBalance({ ...bufferInput(), months: 0 });
    expect(p.daily.length).toBe(31);
    expect(projectEnvelopeBalance({ ...bufferInput(), months: -3 }).daily.length).toBe(31);
  });

  it('opening ignores forecast rows in the transaction list', () => {
    const input = bufferInput();
    const withForecast = {
      ...input,
      transactions: [...input.transactions, {
        id: 'f', type: 'fill', date: '2025-12-28', status: 'scheduled', is_forecast: true,
        lines: [{ envelope_id: 'buf', mode: 'add', amount: 999 }],
      }],
    };
    expect(projectEnvelopeBalance(withForecast).opening).toBe(projectEnvelopeBalance(input).opening);
  });

  it('recommendations ignore a projection built for another envelope or window', () => {
    const input = bufferInput();
    const fresh = recommendEnvelopeActions(input);
    const otherEnvelope = projectEnvelopeBalance({ ...input, envelopeId: 'bills' });
    const otherWindow = projectEnvelopeBalance({ ...input, months: 3 });
    const otherDay = projectEnvelopeBalance({ ...input, today: new Date(2026, 0, 2) });
    expect(recommendEnvelopeActions(input, otherEnvelope)).toEqual(fresh);
    expect(recommendEnvelopeActions(input, otherWindow)).toEqual(fresh);
    expect(recommendEnvelopeActions(input, otherDay)).toEqual(fresh);
    expect(recommendEnvelopeActions(input, projectEnvelopeBalance(input))).toEqual(fresh);
  });
});
