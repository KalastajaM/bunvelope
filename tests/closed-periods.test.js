// Which dates a closed month (Review → Close month) covers. The soft-lock
// confirmation in js/ui/closed-period-guard.js asks only when this says so.
import { describe, it, expect } from 'vitest';
import { closedMonthSet, monthOfDate, closedMonthsIn, countClosedRows, monthHasEnded, monthToOfferClosing } from '../js/state/closed-periods.js';

describe('closed periods', () => {
  it('reads closed_months, dropping malformed entries', () => {
    expect([...closedMonthSet({ closed_months: ['2026-08', 'bad', 7, '2026-9'] })]).toEqual(['2026-08']);
    expect(closedMonthSet(null).size).toBe(0);
    expect(closedMonthSet({}).size).toBe(0);
  });

  it('months an ISO or dd/mm/yyyy date', () => {
    expect(monthOfDate('2026-09-30')).toBe('2026-09');
    expect(monthOfDate('30/09/2026')).toBe('2026-09');
    expect(monthOfDate('')).toBeNull();
    expect(monthOfDate(undefined)).toBeNull();
  });

  it('lists the closed months a set of dates touches, once each, sorted', () => {
    const meta = { closed_months: ['2026-07', '2026-08'] };
    expect(closedMonthsIn(meta, ['2026-08-31', '2026-09-01', '2026-07-02', '2026-08-01'])).toEqual(['2026-07', '2026-08']);
    expect(closedMonthsIn(meta, ['2026-09-01'])).toEqual([]);
    expect(closedMonthsIn({}, ['2026-08-01'])).toEqual([]);
  });

  it('counts rows dated in a closed month', () => {
    const meta = { closed_months: ['2026-08'] };
    expect(countClosedRows(meta, [{ date: '2026-08-01' }, { date: '2026-09-01' }, { date: '2026-08-31' }, null])).toBe(2);
  });
});

describe('closing months automatically', async () => {
  const {
    isMonthClosed, autoCloseCutoff, reopenMonthPatch, closeMonthPatch, dropReopenPatch,
  } = await import('../js/state/closed-periods.js');
  const oct1 = new Date(2026, 9, 1);

  it('N = 1: the month just ended stays open, the ones before close', () => {
    const meta = { auto_close_after_months: 1 };
    expect(autoCloseCutoff(meta, oct1)).toBe('2026-09');
    expect(isMonthClosed(meta, '2026-10', oct1)).toBe(false);
    expect(isMonthClosed(meta, '2026-09', oct1)).toBe(false);
    expect(isMonthClosed(meta, '2026-08', oct1)).toBe(true);
    expect(isMonthClosed(meta, '2025-01', oct1)).toBe(true);
  });

  it('N = 3, and across a year boundary', () => {
    expect(isMonthClosed({ auto_close_after_months: 3 }, '2026-07', oct1)).toBe(false);
    expect(isMonthClosed({ auto_close_after_months: 3 }, '2026-06', oct1)).toBe(true);
    const jan15 = new Date(2027, 0, 15);
    expect(isMonthClosed({ auto_close_after_months: 1 }, '2026-12', jan15)).toBe(false);
    expect(isMonthClosed({ auto_close_after_months: 1 }, '2026-11', jan15)).toBe(true);
  });

  it('off: only manual closes count', () => {
    for (const meta of [{}, { auto_close_after_months: 0 }, { auto_close_after_months: 'x' }]) {
      expect(isMonthClosed(meta, '2020-01', oct1)).toBe(false);
      expect(autoCloseCutoff(meta, oct1)).toBeNull();
    }
    expect(isMonthClosed({ closed_months: ['2026-10'] }, '2026-10', oct1)).toBe(true);
  });

  it('a reopened month is open; a manual close still wins', () => {
    const meta = { auto_close_after_months: 1, reopened_months: ['2026-08'] };
    expect(isMonthClosed(meta, '2026-08', oct1)).toBe(false);
    expect(isMonthClosed(meta, '2026-07', oct1)).toBe(true);
    expect(isMonthClosed({ ...meta, closed_months: ['2026-08'] }, '2026-08', oct1)).toBe(true);
  });

  it('dates and rows take the clock', async () => {
    const { closedMonthsIn, countClosedRows } = await import('../js/state/closed-periods.js');
    const meta = { auto_close_after_months: 1 };
    expect(closedMonthsIn(meta, ['2026-07-31', '2026-09-30', '2026-08-01'], oct1)).toEqual(['2026-07', '2026-08']);
    expect(countClosedRows(meta, [{ date: '2026-08-02' }, { date: '2026-09-02' }], oct1)).toBe(1);
  });

  it('reopening adds an exception only where the rule closes the month', () => {
    const auto = { auto_close_after_months: 1, closed_months: [] };
    expect(reopenMonthPatch(auto, '2026-08', oct1).reopened_months).toEqual(['2026-08']);
    const manual = { closed_months: ['2026-10'] };
    expect(reopenMonthPatch(manual, '2026-10', oct1)).toEqual({ closed_months: [] });
  });

  it('closing by hand drops an exception; closing again under the rule drops it too', () => {
    const meta = { auto_close_after_months: 1, reopened_months: ['2026-08'] };
    expect(closeMonthPatch(meta, '2026-08')).toEqual({ auto_close_after_months: 1, closed_months: ['2026-08'], reopened_months: [] });
    expect(dropReopenPatch(meta, '2026-08')).toEqual({ auto_close_after_months: 1 });
  });
});

// Owner decision 2026-10-05: only a month that has ended can be closed, and
// the first open of a new month offers the one that just ended.
describe('month end and the close offer', () => {
  it('a month has ended once today is in a later month', () => {
    const oct5 = new Date(2026, 9, 5, 9);
    expect(monthHasEnded('2026-09', oct5)).toBe(true);
    expect(monthHasEnded('2025-12', oct5)).toBe(true);
    expect(monthHasEnded('2026-10', oct5)).toBe(false);
    expect(monthHasEnded('2026-11', oct5)).toBe(false);
    expect(monthHasEnded('2026-10', new Date(2026, 9, 31, 23, 59))).toBe(false);
    expect(monthHasEnded('2026-10', new Date(2026, 10, 1, 0, 1))).toBe(true);
    expect(monthHasEnded('2026-09', undefined)).toBe(false);
  });

  it('offers the previous month while it is open and has rows', () => {
    const oct1 = new Date(2026, 9, 1, 8);
    const txs = [{ date: '2026-09-14' }, { date: '2026-10-01' }];
    expect(monthToOfferClosing({}, txs, oct1)).toBe('2026-09');
    // January offers December of the year before.
    expect(monthToOfferClosing({}, [{ date: '2025-12-31' }], new Date(2026, 0, 1, 8))).toBe('2025-12');
    // The rule with N = 1 leaves last month open, so it is still offered.
    expect(monthToOfferClosing({ auto_close_after_months: 1 }, txs, oct1)).toBe('2026-09');
  });

  it('offers nothing when the previous month is closed or has no rows', () => {
    const oct1 = new Date(2026, 9, 1, 8);
    expect(monthToOfferClosing({ closed_months: ['2026-09'] }, [{ date: '2026-09-14' }], oct1)).toBeNull();
    expect(monthToOfferClosing({}, [{ date: '2026-08-31' }, { date: '2026-10-01' }], oct1)).toBeNull();
    expect(monthToOfferClosing({}, [], oct1)).toBeNull();
  });
});
