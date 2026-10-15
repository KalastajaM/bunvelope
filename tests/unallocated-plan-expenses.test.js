import { describe, it, expect } from 'vitest';
import { materializeDueBudgetItems, forecastScheduledTransactions, forecastPlannedExpenses } from '../js/engine/scheduling.js';
import { lensTransactions } from '../js/engine/lens.js';
import { computeAccountBalances, computeEnvelopeBalances } from '../js/engine/balances.js';

const today = new Date(2026, 8, 15);
const accounts = [{ id: 'bank', type: 'bank', initialBalance: 1000 }];
const envelopes = [{ id: 'food', name: 'Food' }];
const item = (fields = {}) => ({ id: 'misc', kind: 'expense', envelope_id: null, description: 'Miscellaneous',
  default_amount: -100, monthly_schedule: { Sep: true }, payment_day: 20, include: true,
  account_id: 'bank', as_schedule: false, funding_style: 'spending', ...fields });
const source = (items, transactions = []) => ({ accounts, envelopes, budgetItems: items, transactions, envelopeTemplates: [], meta: {} });
const forecast = (items, transactions = []) => lensTransactions(source(items, transactions), { lens: 'forecast', today, horizon: '2026-09-30' });

describe('Unallocated expense plan items', () => {
  it('posts scheduled expenses without an envelope and stays idempotent', () => {
    const items = [item({ as_schedule: true, as_schedule_since: '2026-09-01', payment_day: 10 })];
    const { newTxs } = materializeDueBudgetItems(items, accounts, envelopes, [], today, () => 'posted');
    expect(newTxs).toHaveLength(1);
    expect(newTxs[0]).toMatchObject({ type: 'expense', amount: 100, account: 'bank', envelope_id: null });
    expect(computeAccountBalances(accounts, newTxs).get('bank')).toBe(900);
    expect(computeEnvelopeBalances(newTxs).size).toBe(0);
    expect(materializeDueBudgetItems(items, accounts, envelopes, newTxs, today).newTxs).toEqual([]);
  });

  it.each([false, true])('forecasts an expense (scheduled=%s) against cash only', (scheduled) => {
    const items = [item({ as_schedule: scheduled })];
    const rows = scheduled
      ? forecastScheduledTransactions(items, accounts, envelopes, today, '2026-09-30')
      : forecastPlannedExpenses(items, accounts, envelopes, today, '2026-09-30');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ envelope_id: null, amount: 100, account: 'bank' });
    const txs = forecast(items);
    expect(computeAccountBalances(accounts, txs).get('bank')).toBe(900);
    expect(computeEnvelopeBalances(txs).size).toBe(0);
  });

  it('uses a fallback account for an undated plan without an account', () => {
    const rows = forecast([item({ account_id: null, payment_day: 0 })]);
    const planned = rows.filter(r => r.is_planned);
    expect(planned.every(r => r.account === 'bank' && r.envelope_id == null)).toBe(true);
    expect(planned.reduce((sum, r) => sum + r.amount, 0)).toBeCloseTo(100, 2);
  });

  it('nets manual Unallocated spending without consuming another envelope’s spending', () => {
    const rows = forecast([item()], [
      { id: 'cash', type: 'expense', date: '2026-09-14', account: 'bank', envelope_id: null, amount: 30 },
      { id: 'food', type: 'expense', date: '2026-09-14', account: 'bank', envelope_id: 'food', amount: 40 },
    ]);
    expect(rows.find(r => r.is_planned).amount).toBe(70);
    expect(computeAccountBalances(accounts, rows).get('bank')).toBe(860);
    expect(computeEnvelopeBalances(rows).get('food')).toBe(-40);
  });

  it('matches a linked manual bill once, without reducing a separate spending plan', () => {
    const rows = forecast([item({ as_schedule: true, funding_style: 'bill' }), item({ id: 'other' })], [
      { id: 'paid', type: 'expense', date: '2026-09-18', account: 'bank', envelope_id: null, amount: 100, budget_item_id: 'misc' },
    ]);
    expect(rows.filter(r => r.is_forecast).map(r => [r.forecast_budget_item_id, r.amount])).toEqual([['other', 100]]);
  });

  it('still rejects missing or archived named envelopes and unenveloped investment buys', () => {
    for (const fields of [{ envelope_id: 'gone' }, { envelope_id: 'old' }, { kind: 'investment_transfer' }, { kind: 'transfer' }]) {
      expect(forecastPlannedExpenses([item(fields)], accounts, [...envelopes, { id: 'old', archived: true }], today, '2026-09-30')).toEqual([]);
    }
  });
});
