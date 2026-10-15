// Guards the extraction of `walkMonthlySchedule` out of
// `computeScheduledOccurrences`. The corpus below was captured against the
// pre-extraction implementation: if the refactor changes any occurrence date,
// month key, or amount, one of these fails.
//
// Every case exercises a distinct branch of the month walk — per-month amount
// overrides, `false` months, the `default_amount` fallback, day clamping in
// short months, all three working-day modes, `since` bounding, and
// `skipped_occurrences`.

import { describe, it, expect } from 'vitest';
import { computeScheduledOccurrences } from '../js/engine.js';
import { walkMonthlySchedule } from '../js/engine/scheduling.js';

const base = {
  as_schedule: true,
  monthly_schedule: {
    Jan: true, Feb: true, Mar: true, Apr: true, May: true, Jun: true,
    Jul: true, Aug: true, Sep: true, Oct: true, Nov: true, Dec: true,
  },
  payment_day: 15,
  default_amount: 100,
};

const item = over => ({ ...base, ...over });

describe('computeScheduledOccurrences — pre-extraction equivalence corpus', () => {
  it('every-month schedule on default_amount', () => {
    expect(computeScheduledOccurrences(item({}), '2026-01-01', '2026-03-31')).toEqual([
      { date: '2026-01-15', amount: 100, monthKey: '2026-01' },
      { date: '2026-02-15', amount: 100, monthKey: '2026-02' },
      { date: '2026-03-15', amount: 100, monthKey: '2026-03' },
    ]);
  });

  it('per-month numeric overrides beat default_amount', () => {
    const it0 = item({ monthly_schedule: { Jan: 250, Feb: true, Mar: 0 } });
    expect(computeScheduledOccurrences(it0, '2026-01-01', '2026-03-31')).toEqual([
      { date: '2026-01-15', amount: 250, monthKey: '2026-01' },
      { date: '2026-02-15', amount: 100, monthKey: '2026-02' },
    ]);
  });

  it('false months and zero amounts both emit nothing', () => {
    const it0 = item({ monthly_schedule: { Jan: false, Feb: 0, Mar: true } });
    expect(computeScheduledOccurrences(it0, '2026-01-01', '2026-03-31')).toEqual([
      { date: '2026-03-15', amount: 100, monthKey: '2026-03' },
    ]);
  });

  it('undefined month keys are inactive', () => {
    const it0 = item({ monthly_schedule: { Mar: true } });
    expect(computeScheduledOccurrences(it0, '2026-01-01', '2026-04-30')).toEqual([
      { date: '2026-03-15', amount: 100, monthKey: '2026-03' },
    ]);
  });

  it('payment_day 31 clamps to the length of each month', () => {
    const it0 = item({ payment_day: 31 });
    expect(computeScheduledOccurrences(it0, '2026-01-01', '2026-04-30')).toEqual([
      { date: '2026-01-31', amount: 100, monthKey: '2026-01' },
      { date: '2026-02-28', amount: 100, monthKey: '2026-02' },
      { date: '2026-03-31', amount: 100, monthKey: '2026-03' },
      { date: '2026-04-30', amount: 100, monthKey: '2026-04' },
    ]);
  });

  it('leap February clamps to the 29th', () => {
    const it0 = item({ payment_day: 30 });
    expect(computeScheduledOccurrences(it0, '2024-02-01', '2024-02-29')).toEqual([
      { date: '2024-02-29', amount: 100, monthKey: '2024-02' },
    ]);
  });

  it('day_type next_work_day pushes a Sunday forward', () => {
    // 2026-03-01 is a Sunday.
    const it0 = item({ payment_day: 1 });
    expect(computeScheduledOccurrences(it0, '2026-03-01', '2026-03-31', { dayType: 'next_work_day', country: 'FI' }))
      .toEqual([{ date: '2026-03-02', amount: 100, monthKey: '2026-03' }]);
  });

  it('day_type prev_work_day pulls a Sunday back', () => {
    const it0 = item({ payment_day: 1 });
    expect(computeScheduledOccurrences(it0, '2026-02-01', '2026-03-31', { dayType: 'prev_work_day', country: 'FI' }))
      .toEqual([
        { date: '2026-01-30', amount: 100, monthKey: '2026-02' },
        { date: '2026-02-27', amount: 100, monthKey: '2026-03' },
      ]);
  });

  it('day_type honours FI bank holidays, not just weekends', () => {
    // 2026-01-06 is Epiphany in FI; next working day is the 7th.
    const it0 = item({ payment_day: 6, monthly_schedule: { Jan: true } });
    expect(computeScheduledOccurrences(it0, '2026-01-01', '2026-01-31', { dayType: 'next_work_day', country: 'FI' }))
      .toEqual([{ date: '2026-01-07', amount: 100, monthKey: '2026-01' }]);
  });

  it('day_type exact leaves weekend dates alone', () => {
    const it0 = item({ payment_day: 1 });
    expect(computeScheduledOccurrences(it0, '2026-03-01', '2026-03-31', { dayType: 'exact', country: 'FI' }))
      .toEqual([{ date: '2026-03-01', amount: 100, monthKey: '2026-03' }]);
  });

  it('as_schedule_since bounds the backfill', () => {
    const it0 = item({ as_schedule_since: '2026-02-01' });
    expect(computeScheduledOccurrences(it0, '2026-01-01', '2026-03-31')).toEqual([
      { date: '2026-02-15', amount: 100, monthKey: '2026-02' },
      { date: '2026-03-15', amount: 100, monthKey: '2026-03' },
    ]);
  });

  it('a since later than the window end yields nothing', () => {
    const it0 = item({ as_schedule_since: '2027-01-01' });
    expect(computeScheduledOccurrences(it0, '2026-01-01', '2026-12-31')).toEqual([]);
  });

  it('skipped_occurrences drops matching month keys', () => {
    const it0 = item({ skipped_occurrences: ['2026-02'] });
    expect(computeScheduledOccurrences(it0, '2026-01-01', '2026-03-31')).toEqual([
      { date: '2026-01-15', amount: 100, monthKey: '2026-01' },
      { date: '2026-03-15', amount: 100, monthKey: '2026-03' },
    ]);
  });

  it('walks across a year boundary', () => {
    expect(computeScheduledOccurrences(item({}), '2026-11-01', '2027-02-28')).toEqual([
      { date: '2026-11-15', amount: 100, monthKey: '2026-11' },
      { date: '2026-12-15', amount: 100, monthKey: '2026-12' },
      { date: '2027-01-15', amount: 100, monthKey: '2027-01' },
      { date: '2027-02-15', amount: 100, monthKey: '2027-02' },
    ]);
  });

  it('negative amounts survive with their sign', () => {
    const it0 = item({ monthly_schedule: { Jan: -50 } });
    expect(computeScheduledOccurrences(it0, '2026-01-01', '2026-01-31')).toEqual([
      { date: '2026-01-15', amount: -50, monthKey: '2026-01' },
    ]);
  });

  it('guards: no item, not scheduled, no monthly_schedule, bad payment_day', () => {
    expect(computeScheduledOccurrences(null, '2026-01-01', '2026-12-31')).toEqual([]);
    expect(computeScheduledOccurrences(item({ as_schedule: false }), '2026-01-01', '2026-12-31')).toEqual([]);
    expect(computeScheduledOccurrences(item({ monthly_schedule: null }), '2026-01-01', '2026-12-31')).toEqual([]);
    expect(computeScheduledOccurrences(item({ payment_day: 0 }), '2026-01-01', '2026-12-31')).toEqual([]);
    expect(computeScheduledOccurrences(item({ payment_day: 'x' }), '2026-01-01', '2026-12-31')).toEqual([]);
  });
});

describe('walkMonthlySchedule', () => {
  const spec = over => ({
    months: {
      Jan: true, Feb: true, Mar: true, Apr: true, May: true, Jun: true,
      Jul: true, Aug: true, Sep: true, Oct: true, Nov: true, Dec: true,
    },
    payment_day: 1,
    ...over,
  });

  it('emits date and monthKey with no amount involved', () => {
    expect(walkMonthlySchedule(spec(), '2026-01-01', '2026-02-28')).toEqual([
      { date: '2026-01-01', monthKey: '2026-01', rawDate: '2026-01-01' },
      { date: '2026-02-01', monthKey: '2026-02', rawDate: '2026-02-01' },
    ]);
  });

  it('fires for a month with no amount anywhere in the spec', () => {
    // The whole point of the extraction: a template has no amount, and the
    // `>= 0.005` gate must not reach it.
    expect(walkMonthlySchedule(spec({ months: { Oct: true, Nov: true, Dec: true } }), '2026-10-01', '2026-12-31'))
      .toEqual([
        { date: '2026-10-01', monthKey: '2026-10', rawDate: '2026-10-01' },
        { date: '2026-11-01', monthKey: '2026-11', rawDate: '2026-11-01' },
        { date: '2026-12-01', monthKey: '2026-12', rawDate: '2026-12-01' },
      ]);
  });

  it('treats a numeric month value as active, whatever the number', () => {
    expect(walkMonthlySchedule(spec({ months: { Jan: 0, Feb: false, Mar: 250 } }), '2026-01-01', '2026-03-31'))
      .toEqual([
        { date: '2026-01-01', monthKey: '2026-01', rawDate: '2026-01-01' },
        { date: '2026-03-01', monthKey: '2026-03', rawDate: '2026-03-01' },
      ]);
  });

  it('clamps, adjusts, bounds by since, and skips', () => {
    expect(walkMonthlySchedule(
      spec({ payment_day: 31, since: '2026-02-01', skipped: ['2026-03'] }),
      '2026-01-01', '2026-04-30',
      { dayType: 'next_work_day', country: 'FI' },
    )).toEqual([
      { date: '2026-03-02', monthKey: '2026-02', rawDate: '2026-02-28' }, // Feb 28 2026 is a Saturday
      { date: '2026-04-30', monthKey: '2026-04', rawDate: '2026-04-30' },
    ]);
  });

  it('guards: no spec, no months, bad payment_day, inverted window', () => {
    expect(walkMonthlySchedule(null, '2026-01-01', '2026-12-31')).toEqual([]);
    expect(walkMonthlySchedule(spec({ months: null }), '2026-01-01', '2026-12-31')).toEqual([]);
    expect(walkMonthlySchedule(spec({ payment_day: 0 }), '2026-01-01', '2026-12-31')).toEqual([]);
    expect(walkMonthlySchedule(spec(), '2026-12-31', '2026-01-01')).toEqual([]);
  });
});
