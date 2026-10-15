import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { shiftIsoDate, monthsToShift, shiftBudgetFiles } from '../js/storage/guest-adapter.js';

describe('shiftIsoDate', () => {
  it('moves by whole months', () => {
    expect(shiftIsoDate('2026-05-03', 4)).toBe('2026-09-03');
    expect(shiftIsoDate('2026-11-15', 3)).toBe('2027-02-15');
    expect(shiftIsoDate('2026-02-10', -3)).toBe('2025-11-10');
  });

  it('clamps the day to the target month length', () => {
    expect(shiftIsoDate('2026-01-31', 1)).toBe('2026-02-28');
    expect(shiftIsoDate('2027-12-31', 2)).toBe('2028-02-29');
    expect(shiftIsoDate('2026-03-31', 1)).toBe('2026-04-30');
  });

  it('shifts month keys and keeps a time suffix', () => {
    expect(shiftIsoDate('2026-05', 4)).toBe('2026-09');
    expect(shiftIsoDate('2026-05-02T10:00:00Z', 1)).toBe('2026-06-02T10:00:00Z');
  });

  it('leaves non-dates alone', () => {
    expect(shiftIsoDate('income-salary', 4)).toBe('income-salary');
    expect(shiftIsoDate('2026-13', 1)).toBe('2026-13');
    expect(shiftIsoDate('', 1)).toBe('');
  });
});

describe('monthsToShift', () => {
  const txs = [
    { date: '2026-01-31', status: 'posted' },
    { date: '2026-05-03', status: 'posted' },
    { date: '2026-12-01', status: 'scheduled' },
  ];
  it('lands the latest non-scheduled transaction in the current month', () => {
    expect(monthsToShift(txs, new Date(2026, 8, 23))).toBe(4);
    expect(monthsToShift(txs, new Date(2026, 4, 1))).toBe(0);
    expect(monthsToShift(txs, new Date(2027, 0, 5))).toBe(8);
  });
  it('returns 0 with no dated transactions', () => {
    expect(monthsToShift([], new Date(2026, 8, 23))).toBe(0);
  });
});

describe('shiftBudgetFiles', () => {
  it('shifts every date field consistently, including from_budget month keys', () => {
    const files = [
      { filename: 'transactions.json', data: [
        { id: 'a', date: '2026-02-01', from_budget: 'income-salary:2026-02' },
        { id: 'b', date: '2026-03-31', from_budget: 'rollover:env-x:2026-02' },
        { id: 'c', date: '2026-04-15', from_budget: 'tpl:t1:2026-04-15:fill' },
        { id: 'tx-2026-04', date: '2026-04-20', payee: 'Shop' },
      ] },
      { filename: 'budget-items.json', data: [{ id: 'income-salary', as_schedule_since: '2026-05-15' }] },
      { filename: 'envelope-templates.json', data: [{ id: 't1', schedule: { since: '2026-05-15', freq: 'monthly' } }] },
      { filename: 'budget-meta.json', data: { currency: 'USD', investments: { prices: { X: { price: 1, asOf: '2026-05-02' } } } } },
    ];
    const out = shiftBudgetFiles(files, 4);
    const tx = out[0].data;
    expect(tx[0]).toEqual({ id: 'a', date: '2026-06-01', from_budget: 'income-salary:2026-06' });
    expect(tx[1].date).toBe('2026-07-31');
    expect(tx[1].from_budget).toBe('rollover:env-x:2026-06');
    expect(tx[2].from_budget).toBe('tpl:t1:2026-08-15:fill');
    // ids and free text are opaque, even when they look date-ish
    expect(tx[3].id).toBe('tx-2026-04');
    expect(out[1].data[0].as_schedule_since).toBe('2026-09-15');
    expect(out[2].data[0].schedule).toEqual({ since: '2026-09-15', freq: 'monthly' });
    expect(out[3].data.investments.prices.X.asOf).toBe('2026-09-02');
    expect(out[3].data.currency).toBe('USD');
    // input untouched
    expect(files[0].data[0].date).toBe('2026-02-01');
  });

  it('is the identity for a zero shift', () => {
    const files = [{ filename: 'transactions.json', data: [{ date: '2026-02-01' }] }];
    expect(shiftBudgetFiles(files, 0)).toEqual(files);
  });

  it('brings the shipped example budget up to the current month', () => {
    const dir = new URL('../budgets/example-project/', import.meta.url);
    const read = (f) => ({ filename: f, data: JSON.parse(readFileSync(new URL(f, dir), 'utf8')) });
    const files = ['transactions.json', 'budget-items.json', 'envelope-templates.json', 'budget-meta.json'].map(read);
    const today = new Date(2026, 8, 23);
    const out = shiftBudgetFiles(files, monthsToShift(files[0].data, today));
    const latest = out[0].data.map(t => t.date).sort().at(-1);
    expect(latest.slice(0, 7)).toBe('2026-09');
    // every from_budget month still agrees with its row's date month
    for (const t of out[0].data) {
      if (typeof t.from_budget === 'string' && /:\d{4}-\d{2}$/.test(t.from_budget)) {
        expect(t.from_budget.slice(-7)).toBe(t.date.slice(0, 7));
      }
    }
  });
});

describe('seasonal example calendars', () => {
  it('moves annual bill months, seasonal amounts and template months with their rows', () => {
    const files = [
      { filename: 'budget-items.json', data: [{ monthly_schedule: { Jan: 165, Mar: true, Sep: true, Dec: false } }] },
      { filename: 'envelope-templates.json', data: [{ schedule: { months: { Jan: true, Jul: false } } }] },
    ];
    const out = shiftBudgetFiles(files, -1);
    expect(out[0].data[0].monthly_schedule).toEqual({ Dec: 165, Feb: true, Aug: true, Nov: false });
    expect(out[1].data[0].schedule.months).toEqual({ Dec: true, Jun: false });
    expect(shiftBudgetFiles(out, 1)).toEqual(files);
    expect(shiftBudgetFiles(files, 13)).toEqual(shiftBudgetFiles(files, 1));
  });
});
