// Dates shown to the user go through the i18n helpers, never as raw ISO.
// A bare 'YYYY-MM-DD' is a calendar date: it must print as that day in every
// timezone (npm run test:tz runs this suite west of UTC too).
import { describe, it, expect, afterEach } from 'vitest';
import { setLang, fmtDateLang, fmtDateShortLang, fmtMonthLang } from '../js/ui/i18n.js';

afterEach(() => setLang('en'));

describe('fmtDateLang', () => {
  it('prints a date-only string as that calendar day', () => {
    setLang('en');
    expect(fmtDateLang('2026-09-21')).toBe('Sep 21, 2026');
    setLang('fi');
    expect(fmtDateLang('2026-01-01')).toBe('1.1.2026');
    setLang('nl');
    expect(fmtDateLang('2026-12-31')).toBe('31-12-2026');
  });

  it('passes an unparseable value through instead of printing "Invalid Date"', () => {
    setLang('en');
    expect(fmtDateLang('not a date')).toBe('not a date');
    expect(fmtDateLang('')).toBe('');
  });
});

describe('fmtDateShortLang', () => {
  it('keeps the day for a date-only string', () => {
    setLang('fi');
    expect(fmtDateShortLang('2026-01-05')).toBe('5. tammi');
  });
});

describe('fmtMonthLang', () => {
  it('names the month in the UI language', () => {
    setLang('en');
    expect(fmtMonthLang('2026-01')).toBe('Jan 2026');
    setLang('fi');
    expect(fmtMonthLang('2026-09')).toBe('syys 2026');
    setLang('nl');
    expect(fmtMonthLang('2026-03')).toBe('mrt 2026');
  });

  it('passes anything that is not YYYY-MM through', () => {
    setLang('en');
    expect(fmtMonthLang('Other (3)')).toBe('Other (3)');
    expect(fmtMonthLang(null)).toBe('');
  });
});
