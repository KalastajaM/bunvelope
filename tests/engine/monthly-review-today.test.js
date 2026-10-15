// QA 2026-09-23 #5 — a posted expense dated TODAY was counted twice.
//
// The review's own bucketing counts a row as planned only when it is
// scheduled, a forecast, or dated after today, so today's posted row is
// `actual`. But `_bookedFutureExtrasByEnvelope` kept every row not dated
// BEFORE today, so the same row was also folded into `planned` as a booked
// future extra. At midnight it dropped out of the extras with no new data,
// and `projected` / `required` moved overnight on their own.
//
// One rule now: a posted row dated today is actual only.
import { describe, it, expect } from 'vitest';
import { runMonthlyReview } from '../../js/engine/monthly-review.js';

const ENVELOPES = [{ id: 'food', name: 'Food', category: 'Needs' }];
const ITEMS = [{
  envelope_id: 'food', kind: 'expense', default_amount: 100,
  monthly_schedule: { Jan: true, Feb: true, Mar: true, Apr: true, May: true, Jun: true,
    Jul: true, Aug: true, Sep: true, Oct: true, Nov: true, Dec: true },
  extra_buffer: 0, include: true,
}];
const TXS = [{ id: 't1', type: 'expense', envelope_id: 'food', date: '2026-04-15', status: 'posted', amount: 30 }];

// The balance map is as-of refDate; the expense is on or before both clocks,
// so the balance is identical on both days — nothing about the data changes.
const review = refDate => runMonthlyReview(
  ENVELOPES, ITEMS, new Map([['food', 970]]), TXS, '2026-04', refDate,
).find(r => r.envelope_id === 'food');

describe('runMonthlyReview — an expense dated today', () => {
  const today = review(new Date(2026, 3, 15, 9, 0));
  const tomorrow = review(new Date(2026, 3, 16, 9, 0));

  it('counts as actual', () => {
    expect(today.actual).toBe(30);
    expect(today.scheduled).toBe(0);
  });

  it('is not also folded into planned as a booked future extra', () => {
    expect(today.planned).toBe(100);
  });

  it('gives the same projection today as tomorrow, with no new data', () => {
    expect(today.projected).toBe(tomorrow.projected);
    expect(today.required).toBe(tomorrow.required);
    expect(today.D).toBe(tomorrow.D);
    expect(today.projected).toBe(900);
  });

  it('still counts a scheduled row dated today as upcoming', () => {
    const txs = [{ ...TXS[0], status: 'scheduled' }];
    const row = runMonthlyReview(
      ENVELOPES, ITEMS, new Map([['food', 1000]]), txs, '2026-04', new Date(2026, 3, 15, 9, 0),
    ).find(r => r.envelope_id === 'food');
    expect(row.scheduled).toBe(30);
    expect(row.actual).toBe(0);
    expect(row.planned).toBe(130);
  });

  it('still counts a posted row dated tomorrow as a booked future extra', () => {
    const txs = [{ ...TXS[0], date: '2026-04-16' }];
    const row = runMonthlyReview(
      ENVELOPES, ITEMS, new Map([['food', 1000]]), txs, '2026-04', new Date(2026, 3, 15, 9, 0),
    ).find(r => r.envelope_id === 'food');
    expect(row.scheduled).toBe(30);
    expect(row.planned).toBe(130);
  });
});
