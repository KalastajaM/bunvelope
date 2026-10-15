// tests/engine/scheduling-workingday.test.js — pins the banking-holiday
// calendar and working-day adjustment that decide which day scheduled
// transactions post on. Dates below are authoritative calendar facts
// (Easter 2026 = April 5), not derived from the implementation.

import { describe, it, expect } from 'vitest';
import {
  getBankingHolidays,
  workingDayAdjust,
  computeScheduledOccurrences,
  materializeDueBudgetItems,
} from '../../js/engine/scheduling.js';

describe('getBankingHolidays', () => {
  it('FI 2026 contains the full Finnish bank-holiday set', () => {
    const h = getBankingHolidays(2026, 'FI');
    const expected = [
      '2026-01-01', // New Year
      '2026-01-06', // Epiphany
      '2026-04-03', // Good Friday (Easter 2026-04-05 − 2)
      '2026-04-04', // Holy Saturday
      '2026-04-05', // Easter Sunday
      '2026-04-06', // Easter Monday
      '2026-05-01', // May Day
      '2026-05-14', // Ascension (Easter + 39)
      '2026-06-19', // Midsummer Eve (Friday 19–25 Jun)
      '2026-06-20', // Midsummer Day
      '2026-10-31', // All Saints (Saturday 31 Oct – 6 Nov; Oct 31 IS a Saturday in 2026)
      '2026-12-06', // Independence Day
      '2026-12-24',
      '2026-12-25',
      '2026-12-26',
    ];
    for (const d of expected) expect(h.has(d), `${d} missing`).toBe(true);
    // The off-by-one variant must NOT be flagged.
    expect(h.has('2026-11-07')).toBe(false);
  });

  it('FI All Saints in a year where it falls inside November (2025 → Nov 1)', () => {
    // 2025-11-01 is a Saturday — the simple "first Saturday from Nov 1"
    // and the correct "Saturday from Oct 31" rules agree here.
    const h = getBankingHolidays(2025, 'FI');
    expect(h.has('2025-11-01')).toBe(true);
    expect(h.has('2025-10-31')).toBe(false);
  });

  it('US 2026: federal holidays from weekday rules', () => {
    const h = getBankingHolidays(2026, 'US');
    expect(h.has('2026-01-19')).toBe(true);  // MLK — 3rd Monday Jan
    expect(h.has('2026-11-26')).toBe(true);  // Thanksgiving — 4th Thursday Nov
    expect(h.has('2026-07-04')).toBe(true);  // Independence Day
    expect(h.has('2026-09-07')).toBe(true);  // Labor Day — 1st Monday Sep
  });

  it('GB 2026: late-May and August bank holidays are last Mondays', () => {
    const h = getBankingHolidays(2026, 'GB');
    expect(h.has('2026-05-25')).toBe(true);
    expect(h.has('2026-08-31')).toBe(true);
  });
});

describe('workingDayAdjust', () => {
  it('returns input unchanged for exact mode and for plain weekdays', () => {
    expect(workingDayAdjust('2026-06-13', 'exact')).toBe('2026-06-13');
    expect(workingDayAdjust('2026-06-13', undefined)).toBe('2026-06-13');
    // Wednesday, no holiday nearby.
    expect(workingDayAdjust('2026-06-10', 'next_work_day')).toBe('2026-06-10');
    expect(workingDayAdjust('2026-06-10', 'prev_work_day')).toBe('2026-06-10');
  });

  it('shifts weekends to the adjacent working day', () => {
    // 2026-06-13 is a Saturday.
    expect(workingDayAdjust('2026-06-13', 'next_work_day')).toBe('2026-06-15');
    expect(workingDayAdjust('2026-06-13', 'prev_work_day')).toBe('2026-06-12');
  });

  it('walks across a holiday cluster (Easter 2026, FI)', () => {
    // Good Friday Apr 3 → Sat (Holy Saturday) → Easter Sun → Easter Mon → Tue Apr 7.
    expect(workingDayAdjust('2026-04-03', 'next_work_day', 'FI')).toBe('2026-04-07');
    expect(workingDayAdjust('2026-04-03', 'prev_work_day', 'FI')).toBe('2026-04-02');
    // Midsummer Eve (Fri) + Midsummer Day (Sat) + Sunday → Monday.
    expect(workingDayAdjust('2026-06-19', 'next_work_day', 'FI')).toBe('2026-06-22');
  });

  it('crosses a year boundary and refreshes the holiday table', () => {
    // New Year 2026 backwards: Dec 31 2025 is a working Wednesday in FI.
    expect(workingDayAdjust('2026-01-01', 'prev_work_day', 'FI')).toBe('2025-12-31');
    expect(workingDayAdjust('2026-01-01', 'next_work_day', 'FI')).toBe('2026-01-02');
  });

  it('honours the country argument', () => {
    // Thanksgiving 2026 (US): Thursday Nov 26 → Friday Nov 27.
    expect(workingDayAdjust('2026-11-26', 'next_work_day', 'US')).toBe('2026-11-27');
    // Nov 26 is a plain weekday in FI.
    expect(workingDayAdjust('2026-11-26', 'next_work_day', 'FI')).toBe('2026-11-26');
  });
});

describe('computeScheduledOccurrences', () => {
  const base = {
    as_schedule: true,
    payment_day: 15,
    default_amount: 100,
    monthly_schedule: { Jan: true, Feb: 250, Mar: false },
  };

  it('emits active months with default or per-month amounts', () => {
    const out = computeScheduledOccurrences(base, '2026-01-01', '2026-03-31');
    expect(out).toEqual([
      { date: '2026-01-15', amount: 100, monthKey: '2026-01' },
      { date: '2026-02-15', amount: 250, monthKey: '2026-02' },
    ]);
  });

  it('clamps payment_day to the month length', () => {
    const item = { ...base, payment_day: 31, monthly_schedule: { Feb: true } };
    const out = computeScheduledOccurrences(item, '2026-02-01', '2026-02-28');
    expect(out).toEqual([{ date: '2026-02-28', amount: 100, monthKey: '2026-02' }]);
  });

  it('skips occurrences listed in skipped_occurrences', () => {
    const item = { ...base, skipped_occurrences: ['2026-01'] };
    const out = computeScheduledOccurrences(item, '2026-01-01', '2026-03-31');
    expect(out.map(o => o.monthKey)).toEqual(['2026-02']);
  });

  it('does not backfill before as_schedule_since', () => {
    const item = { ...base, as_schedule_since: '2026-02-01' };
    const out = computeScheduledOccurrences(item, '2026-01-01', '2026-03-31');
    expect(out.map(o => o.monthKey)).toEqual(['2026-02']);
  });

  it('applies working-day adjustment via opts and keeps the raw monthKey', () => {
    const item = { ...base, payment_day: 3, monthly_schedule: { Apr: true } };
    const out = computeScheduledOccurrences(item, '2026-04-01', '2026-04-30', {
      dayType: 'next_work_day', country: 'FI',
    });
    // Raw Apr 3 is Good Friday → posts Tue Apr 7, still keyed 2026-04.
    expect(out).toEqual([{ date: '2026-04-07', amount: 100, monthKey: '2026-04' }]);
  });

  it('keeps an occurrence whose adjusted date lands past the range end', () => {
    // The range selects occurrences by their SCHEDULE date; `date` says when
    // the money moves and may fall outside it. This used to return [], which
    // is why a bill on the 31st of a month ending at a weekend could fall out
    // of every window — see the tiling test below.
    const item = { ...base, payment_day: 3, monthly_schedule: { Apr: true } };
    const out = computeScheduledOccurrences(item, '2026-04-01', '2026-04-05', {
      dayType: 'next_work_day', country: 'FI',
    });
    expect(out).toEqual([{ date: '2026-04-07', amount: 100, monthKey: '2026-04' }]);
  });

  it('gives tiling windows exactly one claim on each occurrence', () => {
    // 2026-01-31 is a Saturday, so the January bill is paid Monday 2026-02-02.
    // With the old asymmetric bounds it was too late for the January window by
    // its payment date and too early for February by its schedule date, so it
    // appeared in neither and silently vanished from every later forecast.
    const item = { ...base, payment_day: 31, monthly_schedule: { Jan: true, Feb: true } };
    const opts = { dayType: 'next_work_day', country: 'FI' };
    const jan = computeScheduledOccurrences(item, '2026-01-01', '2026-01-31', opts);
    const feb = computeScheduledOccurrences(item, '2026-02-01', '2026-02-28', opts);

    expect(jan.map(o => o.monthKey)).toEqual(['2026-01']);
    expect(jan[0].date).toBe('2026-02-02');
    expect(feb.map(o => o.monthKey)).toEqual(['2026-02']);

    // Neither window duplicates the other's occurrence.
    const both = computeScheduledOccurrences(item, '2026-01-01', '2026-02-28', opts);
    expect(both.map(o => o.monthKey)).toEqual(['2026-01', '2026-02']);
  });

  it('does not materialise a bill before its adjusted payment date', () => {
    // Scheduled 2026-04-03 (Good Friday), payable 2026-04-07. Asking on the
    // 3rd must post nothing — the window owns it, but the money has not moved.
    const item = {
      ...base, id: 'bi-gf', payment_day: 3, monthly_schedule: { Apr: true },
      schedule_day_type: 'next_work_day', account_id: 'a1', envelope_id: 'e1',
    };
    const accounts = [{ id: 'a1', name: 'Checking' }];
    const envelopes = [{ id: 'e1', name: 'Bills' }];

    const early = materializeDueBudgetItems(
      [item], accounts, envelopes, [], new Date(2026, 3, 3), () => 'x', [], 'FI', [],
    ).newTxs;
    expect(early).toEqual([]);

    const onDay = materializeDueBudgetItems(
      [item], accounts, envelopes, [], new Date(2026, 3, 7), () => 'x', [], 'FI', [],
    ).newTxs;
    expect(onDay.map(tx => tx.date)).toEqual(['2026-04-07']);
  });

  it('returns nothing for inactive/invalid items', () => {
    expect(computeScheduledOccurrences(null, '2026-01-01', '2026-12-31')).toEqual([]);
    expect(computeScheduledOccurrences({ ...base, as_schedule: false }, '2026-01-01', '2026-12-31')).toEqual([]);
    expect(computeScheduledOccurrences({ ...base, payment_day: 0 }, '2026-01-01', '2026-12-31')).toEqual([]);
    expect(computeScheduledOccurrences({ ...base, as_schedule_since: '2027-01-01' }, '2026-01-01', '2026-12-31')).toEqual([]);
  });
});
