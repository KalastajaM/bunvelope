// A hand payment typed in ahead of its date is not charged twice.
//
// A planned (not auto-posted) budget item has no `from_budget` key to dedup
// on, so the forecast nets its rows against what the envelope spends. That
// netting used to count only spend up to today, in the start month, so a
// payment entered ahead (rent typed in on 1 Oct for 3 Oct) was walked as a
// real row AND the item's own 3 Oct row was charged again. On the example
// budget fill % then read Rent "short 1,200". Every month is netted now,
// future-dated entries included.
import { describe, it, expect } from 'vitest';
import { netAgainstSpentThisMonth, projectEnvelopeBalance } from '../../js/engine/envelope-forecast.js';
import { forecastPlannedExpenses } from '../../js/engine/scheduling.js';
import { computeItemFunding } from '../../js/engine/item-funding.js';
import { lensTransactions, LENS_FORECAST } from '../../js/engine/lens.js';
import { computeEnvelopeBalances } from '../../js/engine/balances.js';

const ALL = { Jan: true, Feb: true, Mar: true, Apr: true, May: true, Jun: true, Jul: true, Aug: true, Sep: true, Oct: true, Nov: true, Dec: true };
const ACCOUNTS = [{ id: 'chk', name: 'Checking', type: 'bank' }];
const TODAY = new Date(2026, 9, 1); // 1 Oct 2026

const item = (id, envelope_id, amount, extra = {}) => ({
  id, envelope_id, description: id, kind: 'expense', default_amount: -amount,
  monthly_schedule: ALL, include: true, ...extra,
});
const pay = (id, envelope_id, date, amount, extra = {}) => ({
  id, type: 'expense', date, amount, envelope_id, account: 'chk', status: 'posted', payee: id, ...extra,
});
const fill = (envelope_id, amount) => ({
  id: `fill-${envelope_id}`, type: 'fill', date: '2026-09-30', status: 'posted',
  lines: [{ envelope_id, mode: 'add', amount }],
});

const rent = item('rent', 'home', 1200, { payment_day: 3 });
const ENVELOPES = [{ id: 'home', name: 'Rent' }, { id: 'car', name: 'Car' }];

const net = (items, envelopeId, txs, opts = {}) => netAgainstSpentThisMonth(
  forecastPlannedExpenses(items, ACCOUNTS, ENVELOPES, TODAY, '2026-12-31', { country: 'FI' }),
  { envelopeId, transactions: txs, startStr: '2026-10-01', ...opts },
).map(r => [r.forecast_budget_item_id, r.forecast_month_key, r.amount]);

describe('netting planned rows against entries dated ahead', () => {
  it('rent typed in for the 3rd settles the 3rd\'s planned row; later months still charge', () => {
    expect(net([rent], 'home', [pay('r', 'home', '2026-10-03', 1200)])).toEqual([
      ['rent', '2026-11', 1200], ['rent', '2026-12', 1200],
    ]);
  });

  it('November\'s rent entered now nets November\'s row', () => {
    expect(net([rent], 'home', [pay('r', 'home', '2026-11-03', 1200)])).toEqual([
      ['rent', '2026-10', 1200], ['rent', '2026-12', 1200],
    ]);
  });

  it('a spending item\'s plan is reduced, not doubled', () => {
    const misc = item('misc', 'car', 75, { payment_day: 25, funding_style: 'spending' });
    expect(net([misc], 'car', [pay('p', 'car', '2026-10-20', 30)])[0]).toEqual(['misc', '2026-10', 45]);
  });

  it('a linked future-dated invoice above its estimate settles the bill; misc is untouched', () => {
    const evenli = item('evenli', 'car', 50, { payment_day: 20, funding_style: 'bill' });
    const misc = item('misc', 'car', 75, { payment_day: 25, funding_style: 'spending' });
    const rows = net([evenli, misc], 'car', [pay('p', 'car', '2026-10-15', 62, { budget_item_id: 'evenli' })]);
    expect(rows.filter(r => r[1] === '2026-10')).toEqual([['misc', '2026-10', 75]]);
  });

  it('a payment the auto-post netting already claimed does not also net a planned row', () => {
    const claimed = [{ envelopeId: 'home', id: 'r', date: '2026-10-03', amount: 1200, itemId: null }];
    expect(net([rent], 'home', [pay('r', 'home', '2026-10-03', 1200)], { claimed })[0]).toEqual(['rent', '2026-10', 1200]);
  });

  it('nothing entered ahead: unchanged', () => {
    expect(net([rent], 'home', [])).toEqual([
      ['rent', '2026-10', 1200], ['rent', '2026-11', 1200], ['rent', '2026-12', 1200],
    ]);
  });
});

describe('the example budget\'s rent, end to end', () => {
  // 1,200 filled on 30 Sep; the October rent typed in for 3 Oct.
  const txs = [fill('home', 1200), pay('r', 'home', '2026-10-03', 1200)];
  const projection = projectEnvelopeBalance({
    envelopeId: 'home', transactions: txs, budgetItems: [rent], envelopeTemplates: [],
    accounts: ACCOUNTS, envelopes: ENVELOPES, today: TODAY, months: 2, country: 'FI', tombstones: [],
  });

  it('the projection takes the rent once in October', () => {
    expect(projection.months[0].out).toBe(-1200);
    expect(projection.daily.find(p => p.date === '2026-10-03').balance).toBe(0);
  });

  it('fill % no longer reads it short', () => {
    const res = computeItemFunding({
      envelopeId: 'home', budgetItems: [rent], transactions: txs,
      balance: computeEnvelopeBalances(txs, { asOf: TODAY }).get('home'),
      today: TODAY, daily: projection.daily,
    });
    expect(res.items[0].status).not.toBe('short');
  });

  it('the Forecast lens charges it once too', () => {
    const rows = lensTransactions(
      { transactions: txs, budgetItems: [rent], envelopeTemplates: [], accounts: ACCOUNTS, envelopes: ENVELOPES, meta: {} },
      { lens: LENS_FORECAST, horizon: '3m', today: TODAY },
    );
    const october = rows.filter(r => r.envelope_id === 'home' && r.type === 'expense' && String(r.date).startsWith('2026-10'));
    expect(october.map(r => r.id)).toEqual(['r']);
  });
});

describe('a bill paid a few days early, in the month before', () => {
  // Paying early is common, and a few days early from the 3rd is last month.
  it('rent due 3 Oct, paid 28 Sep: October\'s row is settled', () => {
    expect(net([rent], 'home', [pay('r', 'home', '2026-09-28', 1200)])).toEqual([
      ['rent', '2026-11', 1200], ['rent', '2026-12', 1200],
    ]);
  });

  it('entered ahead for 3 Nov on 28 Oct: November is settled, October still charges, and October\'s other rows are not netted by it', () => {
    const insurance = item('ins', 'home', 300, { payment_day: 29, funding_style: 'bill' });
    const rows = net([rent, insurance], 'home', [pay('r', 'home', '2026-10-28', 1200)]);
    expect(rows.filter(r => r[1] <= '2026-11')).toEqual([
      ['rent', '2026-10', 1200], ['ins', '2026-10', 300], ['ins', '2026-11', 300],
    ]);
  });

  it('a linked invoice above its estimate, paid in the month before, settles it', () => {
    const evenli = item('evenli', 'car', 50, { payment_day: 5, funding_style: 'bill' });
    const rows = net([evenli], 'car', [pay('p', 'car', '2026-09-27', 62, { budget_item_id: 'evenli' })]);
    expect(rows.map(r => r[1])).toEqual(['2026-11', '2026-12']);
  });

  it('unlinked, only the exact amount counts, as for auto-post bills', () => {
    expect(net([rent], 'home', [pay('r', 'home', '2026-09-28', 1150)])[0]).toEqual(['rent', '2026-10', 1200]);
  });

  it('too early (outside the link window) does not count', () => {
    expect(net([rent], 'home', [pay('r', 'home', '2026-09-20', 1200)])[0]).toEqual(['rent', '2026-10', 1200]);
  });

  it('a spending item is not netted across the boundary', () => {
    const groc = item('groc', 'car', 400, { payment_day: 2, funding_style: 'spending' });
    expect(net([groc], 'car', [pay('g', 'car', '2026-09-29', 400)])[0]).toEqual(['groc', '2026-10', 400]);
  });

  it('a payment already claimed elsewhere is not reused', () => {
    const txs = [pay('r', 'home', '2026-09-28', 1200)];
    expect(net([rent], 'home', txs, { excludeTxIds: new Set(['r']) })[0]).toEqual(['rent', '2026-10', 1200]);
    const claimed = [{ envelopeId: 'home', id: 'r', date: '2026-09-28', amount: 1200, itemId: null }];
    expect(net([rent], 'home', txs, { claimed })[0]).toEqual(['rent', '2026-10', 1200]);
  });

  it('end to end: the projection does not charge October\'s rent again', () => {
    const txs = [fill('home', 2400), pay('r', 'home', '2026-09-28', 1200)];
    const p = projectEnvelopeBalance({
      envelopeId: 'home', transactions: txs, budgetItems: [rent], envelopeTemplates: [],
      accounts: ACCOUNTS, envelopes: ENVELOPES, today: TODAY, months: 2, country: 'FI', tombstones: [],
    });
    expect(p.opening).toBe(1200);
    expect(p.months[0].out).toBe(0);
  });
});
