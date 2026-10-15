// The Review counts a bill once when it was typed in ahead, or paid a few
// days early in the month before.
//
// Two places in runMonthlyReview counted it twice: a future-dated row was
// added to the month's plan as a "booked extra" on top of the budget item it
// was the payment of (rent typed in for 3 Oct made October's plan 2,400 and D
// 1,300), and `planned − actual` ignored a bill paid on 28 Sep for 3 Oct
// because that payment is September's actual. On the example budget the Rent
// row read Remaining 2,400, Projected −1,200 (2026-10-01).
import { describe, it, expect } from 'vitest';
import { runMonthlyReview } from '../../js/engine/monthly-review.js';
import { computeEnvelopeBalances } from '../../js/engine/balances.js';

const ALL = { Jan: true, Feb: true, Mar: true, Apr: true, May: true, Jun: true, Jul: true, Aug: true, Sep: true, Oct: true, Nov: true, Dec: true };
const ENVELOPES = [{ id: 'home', name: 'Rent', category: 'Needs' }];
const TODAY = new Date(2026, 3, 1); // 1 Apr 2026

const rent = (extra = {}) => ({
  id: 'rent', envelope_id: 'home', kind: 'expense', default_amount: -800,
  monthly_schedule: ALL, payment_day: 3, include: true, extra_buffer: 0, ...extra,
});
const fill = (date, amount) => ({ id: `f-${date}`, type: 'fill', date, status: 'posted', lines: [{ envelope_id: 'home', mode: 'add', amount }] });
const pay = (id, date, amount, extra = {}) => ({ id, type: 'expense', date, amount, envelope_id: 'home', account: 'a1', status: 'posted', ...extra });

const review = (txs, items = [rent()]) => {
  const balances = computeEnvelopeBalances(txs, { asOf: TODAY });
  return runMonthlyReview(ENVELOPES, items, balances, txs, '2026-04', TODAY).find(r => r.envelope_id === 'home');
};

describe('rent typed in ahead', () => {
  it('is not added to the plan again: planned, D and the projection count one rent', () => {
    const row = review([fill('2026-03-31', 800), pay('r', '2026-04-03', 800)]);
    expect(row.planned).toBe(800);
    expect(row.D).toBe(800);
    expect(row.scheduled).toBe(800);
    expect(row.projected).toBe(0);
  });

  it('linked to the item, an invoice above its estimate is the invoice', () => {
    const row = review([fill('2026-03-31', 900), pay('r', '2026-04-03', 850, { budget_item_id: 'rent' })]);
    expect(row.planned).toBe(800);
  });

  it('a one-off on top of the plan still counts in full', () => {
    const row = review([fill('2026-03-31', 950), pay('r', '2026-04-03', 800), pay('sofa', '2026-04-12', 150)]);
    expect(row.planned).toBe(950);
    expect(row.D).toBeGreaterThan(800);
  });

  it('unlinked at a different amount is not taken for the rent', () => {
    expect(review([fill('2026-03-31', 900), pay('r', '2026-04-03', 850)]).planned).toBe(1650);
  });

  it('a linked spending purchase is covered by its item\'s plan, the excess is extra', () => {
    const groceries = { id: 'groc', envelope_id: 'home', kind: 'expense', default_amount: -100, monthly_schedule: ALL, include: true, funding_style: 'spending' };
    const row = review([fill('2026-03-31', 300), pay('g', '2026-04-10', 130, { budget_item_id: 'groc' })], [groceries]);
    expect(row.planned).toBe(130);
  });
});

describe('a bill paid a few days early, in the month before', () => {
  it('rent paid 29 Mar for 3 Apr is not still to come in April', () => {
    const row = review([fill('2026-03-20', 800), pay('r', '2026-03-29', 800)]);
    expect(row.balance).toBe(0);
    expect(row.actual).toBe(0);
    expect(row.projected).toBe(0);
  });

  it('linked at any amount, by its from_budget key, or not at all when too early', () => {
    expect(review([fill('2026-03-20', 850), pay('r', '2026-03-29', 850, { budget_item_id: 'rent' })]).projected).toBe(0);
    expect(review([fill('2026-03-20', 800), pay('r', '2026-03-29', 800, { from_budget: 'rent:2026-04' })]).projected).toBe(0);
    expect(review([fill('2026-03-01', 800), pay('r', '2026-03-10', 800)]).projected).toBe(-800);
  });

  it('a groceries purchase on 29 Mar is March\'s, not April\'s', () => {
    const groceries = { id: 'groc', envelope_id: 'home', kind: 'expense', default_amount: -100, monthly_schedule: ALL, include: true, funding_style: 'spending' };
    const row = review([fill('2026-03-20', 200), pay('g', '2026-03-29', 100)], [groceries]);
    expect(row.projected).toBe(0); // 100 left, 100 still to spend in April
  });
});

describe('next month\'s bill typed in ahead AND paid early (the future months)', async () => {
  const { rollForwardEnvelopeBalances } = await import('../../js/engine/monthly-review.js');
  // Today 1 Apr. April's rent (3 Apr) is planned; May's rent is typed in now,
  // dated 28 Apr, a few days before it is due on 3 May.
  const base = [fill('2026-03-31', 1600)];
  const items = [rent()];
  const review = (txs, month, balances) => runMonthlyReview(ENVELOPES, items, balances, txs, month, TODAY)
    .find(r => r.envelope_id === 'home');
  const today = (txs) => computeEnvelopeBalances(txs, { asOf: TODAY });
  const rolled = (txs, month) => rollForwardEnvelopeBalances(ENVELOPES, items, today(txs), txs, month, TODAY);

  it('April: both rents leave in April, but the year still holds twelve, not thirteen', () => {
    const txs = [...base, pay('may', '2026-04-28', 800)];
    const row = review(txs, '2026-04', today(txs));
    expect(row.planned).toBe(1600);
    expect(row.projected).toBe(0);
    expect(row.D).toBe(800);
    expect(row.required).toBe(0);
  });

  it('May: the rent is already paid, so nothing is still to come', () => {
    const txs = [...base, pay('may', '2026-04-28', 800)];
    const balances = rolled(txs, '2026-05');
    const row = review(txs, '2026-05', balances);
    expect(row.projected).toBe(balances.get('home'));
  });

  it('rolling forward to July carries one rent a month', () => {
    const txs = [...base, pay('may', '2026-04-28', 800)];
    // April ends at 0 + 800 fill; May keeps it (already paid) + 800; June −800 +800.
    expect(rolled(txs, '2026-07').get('home')).toBe(1600);
  });

  it('linked, an invoice above its estimate settles next month\'s bill', () => {
    const txs = [...base, pay('may', '2026-04-27', 850, { budget_item_id: 'rent' })];
    const balances = rolled(txs, '2026-05');
    expect(review(txs, '2026-05', balances).projected).toBe(balances.get('home'));
  });

  it('unlinked at a different amount it is a plain extra, and May\'s rent is still to come', () => {
    const txs = [...base, pay('may', '2026-04-28', 850)];
    const balances = rolled(txs, '2026-05');
    expect(review(txs, '2026-05', balances).projected).toBeCloseTo(round2(balances.get('home') - 800), 2);
  });
});

const round2 = (n) => Math.round(n * 100) / 100;
