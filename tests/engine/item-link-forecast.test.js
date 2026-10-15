// The forecast honours a payment's budget-item link (`budget_item_id`, set
// with the Budget item picker on an expense). One rule, shared with fill %:
// a linked payment pays only its own item, settles that item's occurrence
// whatever the amount when it falls in the occurrence's month or within the
// link window, and is never used for another item. Unlinked payments keep the
// exact-amount rule.
//
// Shape: the owner's car-charging envelope, an Evenli invoice estimated at 50
// that came in at 62, beside misc charging.
import { describe, it, expect } from 'vitest';
import {
  settles,
  netForecastAgainstRealPayments,
  netAgainstSpentThisMonth,
  findUnlinkedScheduledPayments,
  projectEnvelopeBalance,
} from '../../js/engine/envelope-forecast.js';
import { forecastPlannedExpenses, forecastScheduledTransactions } from '../../js/engine/scheduling.js';

const ALL = { Jan: true, Feb: true, Mar: true, Apr: true, May: true, Jun: true, Jul: true, Aug: true, Sep: true, Oct: true, Nov: true, Dec: true };
const ACCOUNTS = [{ id: 'chk', name: 'Checking', type: 'bank' }];
const ENVELOPES = [{ id: 'car', name: 'Car charging' }];
const TODAY = new Date(2026, 9, 10); // 10 Oct 2026

const evenli = (extra = {}) => ({
  id: 'evenli', envelope_id: 'car', description: 'Evenli', kind: 'expense',
  default_amount: -50, monthly_schedule: ALL, payment_day: 20, include: true,
  account_id: 'chk', funding_style: 'bill', ...extra,
});
const misc = (extra = {}) => ({
  id: 'misc', envelope_id: 'car', description: 'Misc charging', kind: 'expense',
  default_amount: -75, monthly_schedule: ALL, payment_day: 1, include: true,
  funding_style: 'spending', ...extra,
});
const pay = (id, date, amount, extra = {}) => ({
  id, type: 'expense', date, amount, envelope_id: 'car', account: 'chk', status: 'posted', payee: 'x', ...extra,
});

describe('settles()', () => {
  it('a linked row pays its own item at any amount, in the month or the window', () => {
    expect(settles({ date: '2026-10-12', amount: 62, itemId: 'evenli' }, { date: '2026-10-20', amount: 50, itemId: 'evenli' })).toBe(true);
    // Same month, outside the 10-day window.
    expect(settles({ date: '2026-10-02', amount: 40, itemId: 'evenli' }, { date: '2026-10-20', amount: 50, itemId: 'evenli' })).toBe(true);
    // Across the month boundary, inside the window.
    expect(settles({ date: '2026-09-28', amount: 50, itemId: 'evenli' }, { date: '2026-10-03', amount: 50, itemId: 'evenli' })).toBe(true);
    // Neither.
    expect(settles({ date: '2026-09-05', amount: 50, itemId: 'evenli' }, { date: '2026-10-20', amount: 50, itemId: 'evenli' })).toBe(false);
  });

  it('a linked row never pays another item, however well the amount matches', () => {
    expect(settles({ date: '2026-10-20', amount: 50, itemId: 'misc' }, { date: '2026-10-20', amount: 50, itemId: 'evenli' })).toBe(false);
    expect(settles({ date: '2026-10-20', amount: 50, itemId: 'gone' }, { date: '2026-10-20', amount: 50 })).toBe(false);
  });

  it('an unlinked row keeps the exact-amount rule', () => {
    expect(settles({ date: '2026-10-18', amount: 50 }, { date: '2026-10-20', amount: 50, itemId: 'evenli' })).toBe(true);
    expect(settles({ date: '2026-10-18', amount: 62 }, { date: '2026-10-20', amount: 50, itemId: 'evenli' })).toBe(false);
    expect(settles({ date: '2026-10-18', amount: 50, itemId: null }, { date: '2026-10-20', amount: 50 })).toBe(true);
  });
});

describe('auto-posted bill: forward netting', () => {
  const rows = () => forecastScheduledTransactions(
    [evenli({ as_schedule: true })], ACCOUNTS, ENVELOPES, TODAY, '2026-11-30', null, 'FI',
  );
  const net = (txs) => netForecastAgainstRealPayments(rows(), {
    transactions: txs, windowFromStr: '2026-10-11', windowToStr: '2026-11-30',
  }).map(r => r.forecast_month_key);

  it('a linked payment of a different amount settles the occurrence; unlinked it does not', () => {
    expect(net([])).toEqual(['2026-10', '2026-11']);
    expect(net([pay('p', '2026-10-09', 62, { budget_item_id: 'evenli' })])).toEqual(['2026-11']);
    expect(net([pay('p', '2026-10-09', 62)])).toEqual(['2026-10', '2026-11']);
  });

  it('a 50 linked to misc does not settle Evenli', () => {
    expect(net([pay('p', '2026-10-19', 50, { budget_item_id: 'misc' })])).toEqual(['2026-10', '2026-11']);
  });
});

describe('auto-posted bill: due and unposted', () => {
  // Due 3 Oct, today 10 Oct, never posted: a backlog unless a payment settles it.
  const item = evenli({ as_schedule: true, payment_day: 3 });
  const project = (txs) => projectEnvelopeBalance({
    envelopeId: 'car', transactions: [
      { id: 'f0', type: 'fill', date: '2026-10-01', status: 'posted', lines: [{ envelope_id: 'car', mode: 'add', amount: 200 }] },
      ...txs,
    ],
    budgetItems: [item], envelopeTemplates: [], accounts: ACCOUNTS, envelopes: ENVELOPES,
    today: TODAY, months: 2, country: 'FI', tombstones: [],
  });

  it('a linked invoice of 62 is the payment: nothing is still owed', () => {
    const p = project([pay('p', '2026-10-04', 62, { budget_item_id: 'evenli' })]);
    expect(p.dueUnposted).toBe(0);
    expect(p.opening).toBe(138);
  });

  it('unlinked, 62 does not look like the 50 bill: it is still owed', () => {
    expect(project([pay('p', '2026-10-04', 62)]).dueUnposted).toBe(50);
  });
});

describe('the duplicate-post guard (findUnlinkedScheduledPayments)', () => {
  const item = evenli({ as_schedule: true, payment_day: 3 });
  const find = (txs) => findUnlinkedScheduledPayments({
    budgetItems: [item], envelopes: ENVELOPES, transactions: txs, today: TODAY, accounts: ACCOUNTS,
  }).map(p => [p.key, p.txId]);

  it('proposes the linked payment, so the occurrence is not posted again', () => {
    expect(find([pay('p', '2026-10-04', 62, { budget_item_id: 'evenli' })])).toEqual([['evenli:2026-10', 'p']]);
  });

  it('an identical unlinked payment beside a linked one does not make it ambiguous', () => {
    expect(find([
      pay('p', '2026-10-04', 50, { budget_item_id: 'evenli' }),
      pay('q', '2026-10-03', 50),
    ])).toEqual([['evenli:2026-10', 'p']]);
  });

  it('two identical unlinked payments stay ambiguous, as before', () => {
    expect(find([pay('p', '2026-10-04', 50), pay('q', '2026-10-03', 50)])).toEqual([]);
  });
});

describe('planned items: this month\'s netting', () => {
  const planned = (items) => forecastPlannedExpenses(items, ACCOUNTS, ENVELOPES, TODAY, '2026-11-30', { country: 'FI' });
  const net = (items, txs, opts = {}) => netAgainstSpentThisMonth(planned(items), {
    envelopeId: 'car', transactions: txs, startStr: '2026-10-10', ...opts,
  }).filter(r => r.forecast_month_key === '2026-10').map(r => [r.forecast_budget_item_id, r.amount]);

  // misc is due on the 1st, already past, so only Evenli (due the 20th) has
  // an October row ahead; misc gets one with a later payment day.
  const items = [evenli(), misc({ payment_day: 25 })];

  it('rows carry the fill % style', () => {
    const style = Object.fromEntries(planned(items).map(r => [r.forecast_budget_item_id, r.forecast_bill]));
    expect(style).toEqual({ evenli: true, misc: false });
  });

  it('a linked payment settles a bill\'s row outright, even below the estimate', () => {
    expect(net(items, [pay('p', '2026-10-05', 40, { budget_item_id: 'evenli' })])).toEqual([['misc', 75]]);
  });

  it('linked spend reduces only its own spending row', () => {
    expect(net(items, [pay('p', '2026-10-05', 20, { budget_item_id: 'misc' })])).toEqual([['evenli', 50], ['misc', 55]]);
  });

  it('spend linked to misc never nets Evenli, even when misc is used up', () => {
    expect(net(items, [pay('p', '2026-10-05', 200, { budget_item_id: 'misc' })])).toEqual([['evenli', 50]]);
  });

  it('unlinked spend still nets in date order, as before', () => {
    expect(net(items, [pay('p', '2026-10-05', 60)])).toEqual([['misc', 65]]);
  });

  it('spend linked to a deleted item nets nothing', () => {
    expect(net(items, [pay('p', '2026-10-05', 60, { budget_item_id: 'gone' })])).toEqual([['evenli', 50], ['misc', 75]]);
  });

  it('a claimed linked payment is not taken off the unlinked pool', () => {
    const claimed = [{ envelopeId: 'car', id: 'x', date: '2026-10-04', amount: 30, itemId: 'other' }];
    expect(net(items, [pay('p', '2026-10-05', 60)], { claimed })).toEqual([['misc', 65]]);
  });
});
