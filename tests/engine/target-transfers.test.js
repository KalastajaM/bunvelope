import { it, expect } from 'vitest';
import { materializeDueBudgetItems, forecastScheduledTransactions } from '../../js/engine/scheduling.js';
import { computeAccountBalances } from '../../js/engine/balances.js';
import { lensTransactions } from '../../js/engine/lens.js';
import { simulate } from '../../js/engine/simulation.js';
import { resolveTargetTransfers } from '../../js/engine/target-transfers.js';

const today = new Date(2026, 9, 1, 12);
const accounts = [
  { id: 'income', type: 'bank', initialBalance: 1000 },
  { id: 'card', type: 'bank', initialBalance: 180 },
];
const months = { Oct: true, Nov: true, Dec: true };
const transfer = { id: 'topup', kind: 'account_transfer', account_id: 'income', to_account_id: 'card',
  transfer_mode: 'target_balance', target_balance: 500, default_amount: 0, include: true,
  as_schedule: true, as_schedule_since: '2026-10-01', monthly_schedule: months, payment_day: 25 };
const expense = { id: 'spend', kind: 'expense', account_id: 'card', envelope_id: 'food',
  default_amount: -100, include: true, as_schedule: true, monthly_schedule: months, payment_day: 20,
  as_schedule_since: '2026-10-01' };
const source = (extra = {}) => ({ accounts, envelopes: [{ id: 'food' }], budgetItems: [transfer, expense],
  transactions: [], envelopeTemplates: [], meta: {}, ...extra });
const forecast = data => lensTransactions(data, { lens: 'forecast', today, horizon: '2026-12-31' });

it('recalculates each month after spending, independently of plan order, and preserves net worth', () => {
  const data = source();
  const rows = forecast(data);
  expect(rows.filter(r => r.forecast_budget_item_id === 'topup').map(r => r.amount)).toEqual([420, 100, 100]);
  const balances = computeAccountBalances(accounts, rows);
  expect(balances.get('card')).toBe(500);
  expect([...balances.values()].reduce((a, b) => a + b, 0)).toBe(880);
  expect(computeAccountBalances(accounts, forecast(source({ budgetItems: [expense] }))).get('income')).toBe(1000);
  expect(computeAccountBalances(accounts, forecast(source({ budgetItems: [expense, transfer] })))).toEqual(balances);
});
it('includes non-auto-posted planned spending before top-ups', () => {
  const rows = forecast(source({ budgetItems: [transfer, { ...expense, as_schedule: false, funding_style: 'bill' }] }));
  expect(rows.filter(r => r.forecast_budget_item_id === 'topup').map(r => r.amount)).toEqual([420, 100, 100]);
});
it.each([500, 650])('does not transfer backwards or accumulate a monthly €500 at balance %s', initialBalance => {
  const accts = [accounts[0], { ...accounts[1], initialBalance }];
  const rows = forecast(source({ accounts: accts, budgetItems: [transfer] }));
  expect(rows.filter(r => r.forecast_budget_item_id === 'topup').map(r => r.amount)).toEqual([0, 0, 0]);
  expect(materializeDueBudgetItems([transfer], accts, [], [], new Date(2026, 9, 25)).newTxs).toEqual([]);
});
it('pays full card debt to zero and replaces the default settlement in that month', () => {
  const accts = [accounts[0], { ...accounts[1], type: 'credit_card', initialBalance: -750, settledFrom: 'income' }];
  const rows = forecast(source({ accounts: accts, budgetItems: [{ ...transfer, target_balance: 0 }] }));
  expect(rows.filter(r => r.forecast_budget_item_id === 'topup').map(r => r.amount)).toEqual([750, 0, 0]);
  expect(rows.filter(r => r.forecast_kind === 'card-settlement')).toEqual([]);
  expect(computeAccountBalances(accts, rows).get('card')).toBe(0);
});
it('applies same-day salary and expenses before target rules and reports funding shortfalls', () => {
  const pay = { ...expense, id: 'salary', kind: 'income', account_id: 'income', default_amount: 1000, payment_day: 25 };
  const accts = [{ ...accounts[0], initialBalance: 0 }, accounts[1]];
  const rows = forecast(source({ accounts: accts, budgetItems: [transfer, { ...expense, payment_day: 25 }, pay] }));
  expect(rows.find(r => r.id === 'forecast:topup:2026-10')).toMatchObject({ amount: 420, funding_shortfall: 0 });
  const short = forecast(source({ accounts: accts, budgetItems: [transfer] }));
  expect(short.find(r => r.id === 'forecast:topup:2026-10')).toMatchObject({ amount: 320, funding_shortfall: 320 });
});
it('materializes chronologically against posted history and this batch, then stays fixed', () => {
  const transactions = [
    { id: 'future', type: 'expense', account: 'card', amount: 200, date: '2027-01-01', status: 'posted' },
    { id: 'pending', type: 'expense', account: 'card', amount: 200, date: '2026-10-01', status: 'scheduled' },
  ];
  let seq = 0;
  const { newTxs } = materializeDueBudgetItems([transfer, expense], accounts, [{ id: 'food' }], transactions,
    new Date(2026, 11, 26), () => `new-${++seq}`);
  expect(newTxs.filter(r => r.type === 'account_transfer').map(r => r.amount)).toEqual([420, 100, 100]);
  expect(newTxs.some(r => r.target_transfer_pending)).toBe(false);
  expect(materializeDueBudgetItems([transfer, expense], accounts, [{ id: 'food' }], transactions.concat(newTxs),
    new Date(2026, 11, 26)).newTxs).toEqual([]);
  expect(resolveTargetTransfers(accounts, newTxs)).toBe(newTxs);
});
it('deduplicates posted, deleted and skipped occurrences before resolving later months', () => {
  const posted = { id: 'paid', type: 'account_transfer', from_account: 'income', to_account: 'card', amount: 320,
    date: '2026-10-24', from_budget: 'topup:2026-10', status: 'posted' };
  const rows = forecast(source({ transactions: [posted], meta: { scheduledTombstones: ['topup:2026-11'] } }));
  expect(rows.filter(r => r.forecast_budget_item_id === 'topup').map(r => [r.date, r.amount])).toEqual([['2026-12-25', 300]]);
  const direct = forecastScheduledTransactions([{ ...transfer, skipped_occurrences: ['2026-11'] }, expense], accounts,
    [{ id: 'food' }], today, '2026-12-31', null, 'FI', { transactions: [posted] });
  expect(direct.filter(r => r.forecast_budget_item_id === 'topup').map(r => r.amount)).toEqual([300]);
});
it('walks multiple target rules in order with whole-cent rounding', () => {
  const second = { ...transfer, id: 'second', target_balance: 600 };
  const rows = forecast(source({ budgetItems: [transfer, second] }));
  expect(rows.filter(r => r.forecast_month_key === '2026-10').map(r => r.amount)).toEqual([320, 100]);
});
it('simulation meets targets even after intervening growth', () => {
  const data = source({ accounts: [accounts[0], { ...accounts[1], expectedGrowth: 12 }] });
  const sim = simulate({ source: data, today, months: 2 });
  const topups = sim.rows.filter(r => r.forecast_budget_item_id === 'topup');
  expect(topups[0].amount).toBe(420);
  expect(topups[1].amount).toBeLessThan(100);
  // Compare the resolved simulation rows to the money actually moved.
  expect(computeAccountBalances(data.accounts, sim.rows)).toEqual(sim.monthly.at(-1).accounts);
});
it('keeps a zero-target occurrence across a banking-day month boundary', () => {
  const accts = [accounts[0], { ...accounts[1], initialBalance: -200 }];
  const rule = { ...transfer, target_balance: 0, payment_day: 31, schedule_day_type: 'next_work_day',
    monthly_schedule: { Oct: true } };
  const nov1 = new Date(2026, 10, 1, 12);
  const rows = lensTransactions(source({ accounts: accts, budgetItems: [rule] }),
    { lens: 'forecast', today: nov1, horizon: '2026-11-03' });
  expect(rows.filter(r => r.forecast_budget_item_id === rule.id)).toMatchObject([{ date: '2026-11-02', amount: 200 }]);
  expect(materializeDueBudgetItems([rule], accts, [], [], nov1).newTxs).toEqual([]);
  expect(materializeDueBudgetItems([rule], accts, [], [], new Date(2026, 10, 2, 12)).newTxs)
    .toMatchObject([{ date: '2026-11-02', amount: 200, from_budget: 'topup:2026-10' }]);
});
it('recalculates target amounts after a what-if expense is added', () => {
  const scenario = { id: 'extra', changes: [{ type: 'oneoff', date: '2026-10-20', amount: -50, account: 'card', label: 'Extra expense' }] };
  const sim = simulate({ source: source(), today, months: 2, scenario });
  expect(sim.rows.find(r => r.id === 'forecast:topup:2026-10').amount).toBe(470);
});
it('does not bring back automatic card settlement when the horizon ends before the custom payment', () => {
  const accts = [accounts[0], { ...accounts[1], type: 'credit_card', initialBalance: -750, settledFrom: 'income' }];
  const data = source({ accounts: accts, budgetItems: [{ ...transfer, target_balance: 0 }] });
  const short = lensTransactions(data, { lens: 'forecast', today, horizon: '2026-10-20' });
  const long = lensTransactions(data, { lens: 'forecast', today, horizon: '2026-10-31' });
  expect(short.some(r => r.forecast_kind === 'card-settlement')).toBe(false);
  expect(computeAccountBalances(accts, short)).toEqual(computeAccountBalances(accts, long, { asOf: '2026-10-20' }));
  expect(computeAccountBalances(accts, short).get('card')).toBe(-750);
});
