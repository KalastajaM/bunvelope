import { describe, it, expect } from 'vitest';
import { computeScheduledOccurrences, forecastPlannedExpenses } from '../../js/engine/scheduling.js';

const ALL = Object.fromEntries(['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'].map(m => [m, true]));
const salary = (extra) => ({
  id: 'starware', kind: 'income', as_schedule: true, include: true, payment_day: 31,
  default_amount: 4800, monthly_schedule: { ...ALL }, ...extra,
});
const months = (occs) => occs.map(o => o.monthKey);

describe('posting honours start_month / end_month', () => {
  it('a September ticked for next year is not due this September', () => {
    // The owner's case: the job starts in October 2026; September is ticked
    // for 2027. Without a start month the 2026-09 occurrence posted.
    const item = salary({ as_schedule_since: '2026-09-24', start_month: '2026-10' });
    const got = months(computeScheduledOccurrences(item, '2026-09-01', '2027-09-30'));
    expect(got).not.toContain('2026-09');
    expect(got[0]).toBe('2026-10');
    expect(got).toContain('2027-09');
  });

  it('stops after the end month', () => {
    const item = salary({ as_schedule_since: '2026-01-01', end_month: '2026-12' });
    const got = months(computeScheduledOccurrences(item, '2026-10-01', '2027-03-31'));
    expect(got).toEqual(['2026-10', '2026-11', '2026-12']);
  });

  it('still honours a legacy as_schedule_until on its exact date', () => {
    const item = salary({ as_schedule_since: '2026-01-01', as_schedule_until: '2026-10-31' });
    expect(months(computeScheduledOccurrences(item, '2026-09-01', '2027-03-31'))).toEqual(['2026-09', '2026-10']);
  });

  it('takes the later of as_schedule_since and the start month', () => {
    const item = salary({ as_schedule_since: '2026-11-05', start_month: '2026-10' });
    expect(months(computeScheduledOccurrences(item, '2026-10-01', '2026-12-31'))).toEqual(['2026-11', '2026-12']);
  });
});

describe('the unscheduled planned-expense forecast honours the dates', () => {
  const envelopes = [{ id: 'env', name: 'Allowance' }];
  const allowance = (extra) => ({
    id: 'allow', kind: 'expense', as_schedule: false, include: true, payment_day: 1,
    envelope_id: 'env', default_amount: -100, monthly_schedule: { ...ALL }, ...extra,
  });
  const today = new Date(2026, 9, 2);

  it('charges nothing before the start month', () => {
    const rows = forecastPlannedExpenses([allowance({ start_month: '2027-01' })], [], envelopes, today, '2027-03-31');
    expect(rows.map(r => r.forecast_month_key)).toEqual(['2027-01', '2027-02', '2027-03']);
  });

  it('charges nothing after the end month', () => {
    const rows = forecastPlannedExpenses([allowance({ end_month: '2026-12' })], [], envelopes, today, '2027-03-31');
    expect(rows.map(r => r.forecast_month_key)).toEqual(['2026-11', '2026-12']);
  });
});
