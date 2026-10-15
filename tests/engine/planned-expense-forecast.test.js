// A budget item without `as_schedule` is still planned spending — it just
// posts by hand instead of automatically. `forecastScheduledTransactions`
// gates on `as_schedule` because it feeds the Transactions view, where a
// forecast row is something you click to post. The health check inherited that
// gate and so ignored almost every real budget item: in the sample budget, 14
// of 15 items are non-scheduled. An envelope funded for quarterly spending
// looked permanently over-funded, and the trim rule would advise cutting it.

import { describe, it, expect } from 'vitest';
import { forecastPlannedExpenses } from '../../js/engine.js';

const ACCOUNTS = [{ id: 'a1', name: 'Checking', type: 'bank' }];
const ENVELOPES = [
  { id: 'hair', name: 'Hairdresser' },
  { id: 'rent', name: 'Rent' },
  { id: 'old', name: 'Archived', archived: true },
];

const NO_MONTHS = {
  Jan: false, Feb: false, Mar: false, Apr: false, May: false, Jun: false,
  Jul: false, Aug: false, Sep: false, Oct: false, Nov: false, Dec: false,
};
const ALL_MONTHS = {
  Jan: true, Feb: true, Mar: true, Apr: true, May: true, Jun: true,
  Jul: true, Aug: true, Sep: true, Oct: true, Nov: true, Dec: true,
};

// The user's actual case: 70 every three months, not a scheduled transaction.
const HAIRDRESSER = {
  id: 'bi-hair',
  envelope_id: 'hair',
  description: 'Hairdresser',
  default_amount: 70,
  include: true,
  payment_day: 20,
  monthly_schedule: { ...NO_MONTHS, Jan: true, Apr: true, Jul: true, Oct: true },
};

const TODAY = new Date(2026, 0, 1); // 2026-01-01

describe('forecastPlannedExpenses', () => {
  it('forecasts a non-scheduled item on its payment day, honouring the month map', () => {
    const rows = forecastPlannedExpenses(
      [HAIRDRESSER], ACCOUNTS, ENVELOPES, TODAY, '2026-12-31',
    );

    expect(rows.map(r => r.date)).toEqual(
      ['2026-01-20', '2026-04-20', '2026-07-20', '2026-10-20'],
    );
    expect(rows[0].type).toBe('expense');
    expect(rows[0].amount).toBe(70);
    expect(rows[0].envelope_id).toBe('hair');
    expect(rows[0].is_forecast).toBe(true);
    expect(rows[0].is_planned).toBe(true);
  });

  it('leaves as_schedule items alone — forecastScheduledTransactions owns those', () => {
    const scheduled = { ...HAIRDRESSER, as_schedule: true, account_id: 'a1' };
    const rows = forecastPlannedExpenses(
      [scheduled], ACCOUNTS, ENVELOPES, TODAY, '2026-12-31',
    );

    // Otherwise every scheduled item would be forecast twice over.
    expect(rows).toEqual([]);
  });

  it('uses the dedup key the materialiser would write, so the two can never double up', () => {
    const rows = forecastPlannedExpenses(
      [HAIRDRESSER], ACCOUNTS, ENVELOPES, TODAY, '2026-01-31',
    );
    expect(rows[0].forecast_dedup_key).toBe('bi-hair:2026-01');
  });

  it('honours a per-month amount override rather than default_amount', () => {
    const item = {
      ...HAIRDRESSER,
      monthly_schedule: { ...NO_MONTHS, Jan: true, Apr: 95 },
    };
    const rows = forecastPlannedExpenses(
      [item], ACCOUNTS, ENVELOPES, TODAY, '2026-12-31',
    );

    expect(rows.map(r => r.amount)).toEqual([70, 95]);
  });

  it('skips excluded items, income, and missing or archived named envelopes, but includes Unallocated', () => {
    const excluded = { ...HAIRDRESSER, id: 'x1', include: false };
    const income = { ...HAIRDRESSER, id: 'x2', kind: 'income' };
    const archived = { ...HAIRDRESSER, id: 'x3', envelope_id: 'old' };
    const ghost = { ...HAIRDRESSER, id: 'x4', envelope_id: 'nope' };
    const noEnvelope = { ...HAIRDRESSER, id: 'x5', envelope_id: null };

    const rows = forecastPlannedExpenses(
      [excluded, income, archived, ghost, noEnvelope], ACCOUNTS, ENVELOPES, TODAY, '2026-12-31',
    );

    expect(rows.map(r => [r.forecast_budget_item_id, r.envelope_id, r.amount])).toEqual([
      ['x5', null, 70], ['x5', null, 70], ['x5', null, 70], ['x5', null, 70],
    ]);
  });

  it('falls back to month end when no payment day is set', () => {
    // This originally asserted the item was SKIPPED, which was the bug: real
    // budgets leave payment_day at 0 for most planned spending, so skipping
    // meant forecasting almost nothing.
    const rows = forecastPlannedExpenses(
      [{ ...HAIRDRESSER, payment_day: null }], ACCOUNTS, ENVELOPES, TODAY, '2026-12-31',
    );

    expect(rows.map(r => r.date)).toEqual(
      ['2026-01-31', '2026-04-30', '2026-07-31', '2026-10-31'],
    );
  });

  it('does not require an account — a plan line need not name one', () => {
    const rows = forecastPlannedExpenses(
      [{ ...HAIRDRESSER, account_id: null }], ACCOUNTS, ENVELOPES, TODAY, '2026-01-31',
    );
    expect(rows).toHaveLength(1);
  });

  it('starts from tomorrow, so a payment day already past this month is not re-forecast', () => {
    const monthly = { ...HAIRDRESSER, id: 'bi-m', monthly_schedule: { ...ALL_MONTHS } };
    const rows = forecastPlannedExpenses(
      [monthly], ACCOUNTS, ENVELOPES, new Date(2026, 0, 25), '2026-02-28',
    );

    // Payment day is the 20th; on the 25th January is behind us.
    expect(rows.map(r => r.date)).toEqual(['2026-02-20']);
  });
});

// Real budgets do not fill in a payment day for spending that has no fixed
// date — 22 of 23 non-scheduled items in the reporting user's budget carry
// `payment_day: 0`, and amounts stored negative. The sample budget gave every
// item a day, so the first cut of this forecaster silently produced nothing
// for almost every real item.
describe('forecastPlannedExpenses — items with no payment day', () => {
  const QUARTERLY_NO_DAY = {
    id: 'living-hairdresser-item',
    envelope_id: 'hair',
    description: 'Anna',
    kind: 'expense',
    as_schedule: false,
    payment_day: 0,
    default_amount: -200,        // real budgets store expenses signed
    include: true,
    monthly_schedule: { Feb: true, May: true, Aug: true, Nov: true },
  };

  it('still forecasts, placing the spend at month end', () => {
    const rows = forecastPlannedExpenses(
      [QUARTERLY_NO_DAY], ACCOUNTS, ENVELOPES, new Date(2026, 0, 1), '2026-12-31',
    );

    expect(rows.map(r => r.date)).toEqual(['2026-02-28', '2026-05-31', '2026-08-31', '2026-11-30']);
  });

  it('reads a negative default_amount as a positive magnitude', () => {
    const rows = forecastPlannedExpenses(
      [QUARTERLY_NO_DAY], ACCOUNTS, ENVELOPES, new Date(2026, 0, 1), '2026-03-31',
    );
    expect(rows[0].amount).toBe(200);
  });

  it('keeps THIS month\'s spend in view when the month is already half gone', () => {
    // The whole point of month-end placement: on the 16th, a day-1 default
    // would put August in the past and drop the charge entirely, telling the
    // user they have no hairdresser spend coming when they do.
    const rows = forecastPlannedExpenses(
      [QUARTERLY_NO_DAY], ACCOUNTS, ENVELOPES, new Date(2026, 7, 16), '2027-08-15',
    );

    expect(rows[0].date).toBe('2026-08-31');
  });

  it('handles February in a leap year', () => {
    const rows = forecastPlannedExpenses(
      [QUARTERLY_NO_DAY], ACCOUNTS, ENVELOPES, new Date(2024, 0, 1), '2024-03-31',
    );
    expect(rows[0].date).toBe('2024-02-29');
  });

  it('still honours an explicit payment day when one is set', () => {
    const rows = forecastPlannedExpenses(
      [{ ...QUARTERLY_NO_DAY, payment_day: 12 }], ACCOUNTS, ENVELOPES, new Date(2026, 0, 1), '2026-03-31',
    );
    expect(rows[0].date).toBe('2026-02-12');
  });
});
