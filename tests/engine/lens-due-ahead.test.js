// The Forecast lens and an occurrence whose SCHEDULE date has passed but
// whose working-day-shifted PAYMENT date is still ahead.
//
// payment_day 31 with next_work_day: Saturday 31 October 2026 pays Monday
// 2 November. `materializeDueBudgetItems` owns that occurrence from Nov 1 (its
// payment date is this month) but will not write it until Nov 2. The lens
// used to generate rows only from today's schedule date, so on Nov 1 the
// bill was in no forecast at all — balances read one bill high for a day.
// The envelope projection already counted it (`dueAhead`); the lens now
// does too, exactly once, and not when posted or deleted.

import { describe, it, expect, beforeEach } from 'vitest';
import {
  lensTransactions, computeAccountBalances, computeEnvelopeBalances,
  projectEnvelopeBalance, forecastDueAheadTransactions, forecastDueAheadTemplateFills,
} from '../../js/engine.js';
import { _resetLensCache } from '../../js/engine/lens.js';

const ALL = {
  Jan: true, Feb: true, Mar: true, Apr: true, May: true, Jun: true,
  Jul: true, Aug: true, Sep: true, Oct: true, Nov: true, Dec: true,
};
const accounts = [{ id: 'a1', name: 'Checking', type: 'bank', initialBalance: 1000 }];
const envelopes = [{ id: 'bills', name: 'Bills' }, { id: 'fun', name: 'Fun' }];
const BILL = {
  id: 'bill', envelope_id: 'bills', description: 'Month-end bill', default_amount: 100,
  include: true, payment_day: 31, schedule_day_type: 'next_work_day',
  monthly_schedule: { ...ALL }, as_schedule: true, account_id: 'a1',
};
const TPL = {
  id: 'tpl', name: 'Month-end fill',
  lines: [{ envelope_id: 'fun', mode: 'add', amount: 50 }],
  schedule: { enabled: true, payment_day: 31, day_type: 'next_work_day', months: { ...ALL } },
};

const NOV1 = new Date(2026, 10, 1);
const OCT31 = new Date(2026, 9, 31);

const state = (over = {}) => ({
  transactions: [], budgetItems: [BILL], envelopeTemplates: [TPL], accounts, envelopes,
  meta: { country: 'FI' }, ...over,
});
const forecast = (s, today) => lensTransactions(s, { lens: 'forecast', horizon: 'eom', today });
const octBill = txs => txs.filter(t => t.forecast_budget_item_id === 'bill' && t.forecast_month_key === '2026-10');
const octFill = txs => txs.filter(t => t.forecast_template_id === 'tpl' && t.forecast_month_key === '2026-10');

beforeEach(() => _resetLensCache());

describe('forecast lens — owned occurrences whose payment is still ahead', () => {
  it('includes the October bill on Nov 1, dated where it pays, exactly once', () => {
    const txs = forecast(state(), NOV1);
    const rows = octBill(txs);
    expect(rows).toHaveLength(1);
    expect(rows[0].date).toBe('2026-11-02');
    expect(computeAccountBalances(accounts, txs).get('a1')).toBe(1000 - 100 - 100); // Oct + Nov bills
  });

  it('includes the October template fill on Nov 1 exactly once', () => {
    const txs = forecast(state(), NOV1);
    expect(octFill(txs)).toHaveLength(1);
    expect(octFill(txs)[0].date).toBe('2026-11-02');
    expect(computeEnvelopeBalances(txs).get('fun')).toBe(100); // Oct + Nov fills
  });

  it('still counts it once on Oct 31, when today\'s schedule date already covers it', () => {
    const txs = forecast(state(), OCT31);
    expect(octBill(txs)).toHaveLength(1);
    expect(octFill(txs)).toHaveLength(1);
  });

  it('drops it once the occurrence has posted', () => {
    const posted = [
      { id: 'p1', type: 'expense', date: '2026-11-02', status: 'posted', amount: 100,
        envelope_id: 'bills', account: 'a1', from_budget: 'bill:2026-10' },
      { id: 'p2', type: 'fill', date: '2026-11-02', status: 'posted', source: 'allocation',
        lines: [{ envelope_id: 'fun', mode: 'add', amount: 50 }], from_budget: 'tpl:tpl:2026-10' },
    ];
    const txs = forecast(state({ transactions: posted }), NOV1);
    expect(octBill(txs)).toHaveLength(0);
    expect(octFill(txs)).toHaveLength(0);
    expect(computeAccountBalances(accounts, txs).get('a1')).toBe(800);
  });

  it('drops it when the user deleted the occurrence (tombstone)', () => {
    const s = state({ meta: { country: 'FI', scheduledTombstones: ['bill:2026-10', 'tpl:tpl:2026-10'] } });
    const txs = forecast(s, NOV1);
    expect(octBill(txs)).toHaveLength(0);
    expect(octFill(txs)).toHaveLength(0);
  });

  it('does not reach back to an occurrence the materialiser does not own', () => {
    // September's bill (Wed Sep 30) paid on its date; it is last month's, and
    // the window only claims a previous-month occurrence that pays THIS month.
    const rows = forecastDueAheadTransactions([BILL], accounts, envelopes, NOV1, { country: 'FI' });
    expect(rows.map(r => r.forecast_month_key)).toEqual(['2026-10']);
    expect(forecastDueAheadTransactions([BILL], accounts, envelopes, new Date(2026, 10, 3), { country: 'FI' })).toEqual([]);
  });

  it('agrees with the envelope projection, which already counted it', () => {
    const p = projectEnvelopeBalance({
      envelopeId: 'fun', transactions: [], budgetItems: [BILL], envelopeTemplates: [TPL],
      accounts, envelopes, today: NOV1, months: 1, country: 'FI',
    });
    // The due-ahead October fill lands on Nov 2, alongside no other.
    expect(p.daily.find(d => d.date === '2026-11-02').balance).toBe(50);
    expect(forecastDueAheadTemplateFills([TPL], [], envelopes, NOV1, { country: 'FI' })).toHaveLength(1);
  });
});
