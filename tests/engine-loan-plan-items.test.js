// A `loan_payment` budget item: a scheduled monthly payment that posts as
// two rows, the interest (owed × rate ÷ 12) as an expense and the rest as a
// `debt_payment` into the loan account, both from the item's envelope.
import { describe, it, expect } from 'vitest';
import {
  materializeDueBudgetItems, forecastScheduledTransactions, forecastDueAheadTransactions,
  computeAccountBalances, computeEnvelopeBalances, computeUnallocated,
} from '../js/engine.js';

const chk = { id: 'chk', type: 'bank', initialBalance: 5000 };
// These pin the flat-month figures (owed × rate ÷ 12); the actual-day count
// is covered in tests/engine/loan-schedule.test.js.
const mtg = { id: 'mtg', type: 'loan', initialBalance: -120000, interestDayCount: '30/360' };
const accounts = [chk, mtg];
const envelopes = [{ id: 'housing', name: 'Housing' }];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const everyMonth = Object.fromEntries(MONTHS.map(m => [m, true]));

const item = (over = {}) => ({
  id: 'mortgage', kind: 'loan_payment', description: 'Mortgage',
  envelope_id: 'housing', account_id: 'chk', to_account_id: 'mtg', loan_rate: 3,
  default_amount: -1000, monthly_schedule: everyMonth, payment_day: 5,
  as_schedule: true, as_schedule_since: '2026-09-01', include: true, schedule_day_type: 'exact',
  ...over,
});
let n = 0;
const idGen = () => `g${++n}`;

describe('materializeDueBudgetItems for a loan payment', () => {
  it('posts the interest as an expense and the rest as principal into the loan', () => {
    const { newTxs } = materializeDueBudgetItems([item()], accounts, envelopes, [], new Date(2026, 8, 10), idGen);
    expect(newTxs).toHaveLength(2);
    const [principal, interest] = newTxs;
    // 120,000 × 3 % ÷ 12 = 300 interest; 700 principal.
    expect(principal).toMatchObject({
      type: 'debt_payment', amount: 700, from_account: 'chk', to_account: 'mtg', envelope_id: 'housing',
      date: '2026-09-05', from_budget: 'mortgage:2026-09', payee: 'Mortgage',
    });
    expect(interest).toMatchObject({
      type: 'expense', amount: 300, account: 'chk', envelope_id: 'housing', from_budget: 'mortgage:2026-09:interest',
    });
  });

  it('computes each month on what is still owed, and posts once', () => {
    const today = new Date(2026, 9, 10);
    const { newTxs } = materializeDueBudgetItems([item()], accounts, envelopes, [], today, idGen);
    // Sep: 300 / 700; Oct: 119,300 × 0.25 % = 298.25 / 701.75.
    expect(newTxs.map(t => [t.from_budget, t.amount])).toEqual([
      ['mortgage:2026-09', 700], ['mortgage:2026-09:interest', 300],
      ['mortgage:2026-10', 701.75], ['mortgage:2026-10:interest', 298.25],
    ]);
    const again = materializeDueBudgetItems([item()], accounts, envelopes, newTxs, today, idGen);
    expect(again.newTxs).toEqual([]);
  });

  it('pays only what is left on the last payment, and nothing once the loan is repaid', () => {
    const small = { ...mtg, initialBalance: -500 };
    const { newTxs } = materializeDueBudgetItems([item({ loan_rate: 0 })], [chk, small], envelopes, [], new Date(2026, 9, 10), idGen);
    expect(newTxs.map(t => [t.type, t.amount])).toEqual([['debt_payment', 500]]);
  });

  it('with no rate the whole payment is principal', () => {
    const { newTxs } = materializeDueBudgetItems([item({ loan_rate: undefined })], accounts, envelopes, [], new Date(2026, 8, 10), idGen);
    expect(newTxs.map(t => [t.type, t.amount, t.from_budget])).toEqual([['debt_payment', 1000, 'mortgage:2026-09']]);
  });

  it('needs a loan account to pay into', () => {
    const bank = materializeDueBudgetItems([item({ to_account_id: 'chk' })], accounts, envelopes, [], new Date(2026, 8, 10), idGen);
    expect(bank.newTxs).toEqual([]);
    const notLoan = materializeDueBudgetItems([item()], [chk, { ...mtg, type: 'asset' }], envelopes, [], new Date(2026, 8, 10), idGen);
    expect(notLoan.newTxs).toEqual([]);
  });

  it('leaves Unallocated alone and takes the whole payment from the envelope', () => {
    const fill = { id: 'f', type: 'fill', date: '2026-09-01', lines: [{ envelope_id: 'housing', amount: 1000 }], status: 'posted' };
    const { newTxs } = materializeDueBudgetItems([item()], accounts, envelopes, [fill], new Date(2026, 8, 10), idGen);
    const u = (txs) => computeUnallocated(computeAccountBalances(accounts, txs), computeEnvelopeBalances(txs), accounts);
    expect(u([fill, ...newTxs])).toBe(u([fill]));
    expect(computeEnvelopeBalances([fill, ...newTxs]).get('housing')).toBe(0);
    expect(computeAccountBalances(accounts, [fill, ...newTxs]).get('mtg')).toBe(-119300);
  });
});

describe('forecasting a loan payment', () => {
  it('splits each future month on the balance the earlier ones leave', () => {
    const rows = forecastScheduledTransactions([item()], accounts, envelopes, new Date(2026, 8, 10), '2026-11-30', null, 'FI', { transactions: [] });
    // Oct from 120,000 (nothing posted yet in this ledger): 300 / 700;
    // Nov from the 119,300 October leaves: 298.25 / 701.75.
    expect(rows.map(r => [r.type, r.amount, r.forecast_loan_leg])).toEqual([
      ['debt_payment', 700, 'principal'], ['expense', 300, 'interest'],
      ['debt_payment', 701.75, 'principal'], ['expense', 298.25, 'interest'],
    ]);
  });

  it('keys the two legs apart, the interest one through forecast_dedup_key', () => {
    const [p, i] = forecastScheduledTransactions([item()], accounts, envelopes, new Date(2026, 8, 10), '2026-10-31', null, 'FI', { transactions: [] });
    expect(p).toMatchObject({ id: 'forecast:mortgage:2026-10', forecast_budget_item_id: 'mortgage', forecast_month_key: '2026-10', to_account: 'mtg' });
    expect(p.forecast_dedup_key).toBeUndefined();
    expect(i).toMatchObject({ id: 'forecast:mortgage:2026-10:interest', forecast_dedup_key: 'mortgage:2026-10:interest' });
  });

  it('starts from the real balance', () => {
    const paid = { id: 'x', type: 'debt_payment', date: '2026-09-05', amount: 20000, from_account: 'chk', to_account: 'mtg', envelope_id: 'housing', status: 'posted' };
    const [, i] = forecastScheduledTransactions([item()], accounts, envelopes, new Date(2026, 8, 10), '2026-10-31', null, 'FI', { transactions: [paid] });
    expect(i.amount).toBe(250); // 100,000 × 0.25 %
  });

  it('due-ahead rows carry the legs too', () => {
    // payment day 31, next working day: Sat 31 Oct 2026 pays Mon 2 Nov.
    const it31 = item({ payment_day: 31, schedule_day_type: 'next_work_day', as_schedule_since: '2026-10-01' });
    const rows = forecastDueAheadTransactions([it31], accounts, envelopes, new Date(2026, 10, 1), { transactions: [] });
    expect(rows.map(r => r.forecast_loan_leg)).toEqual(['principal', 'interest']);
  });
});

describe('loan payment: the loan\'s own rates and other costs', () => {
  const rated = { ...mtg, interestRates: [{ from: '2026-01-01', rate: 3 }, { from: '2026-10-01', rate: 2.4 }] };

  it('takes the rate in effect on the payment day from the loan account', () => {
    const { newTxs } = materializeDueBudgetItems([item({ loan_rate: undefined })], [chk, rated], envelopes, [], new Date(2026, 9, 10), idGen);
    // Sep at 3 %: 300 / 700; Oct at 2.4 % on 119,300: 238.60 / 761.40.
    expect(newTxs.map(t => [t.from_budget, t.amount])).toEqual([
      ['mortgage:2026-09', 700], ['mortgage:2026-09:interest', 300],
      ['mortgage:2026-10', 761.4], ['mortgage:2026-10:interest', 238.6],
    ]);
  });

  it('books other costs as an expense of their own; the principal is what remains', () => {
    const { newTxs } = materializeDueBudgetItems([item({ loan_fee: 5 })], accounts, envelopes, [], new Date(2026, 8, 10), idGen);
    expect(newTxs.map(t => [t.type, t.amount, t.from_budget])).toEqual([
      ['debt_payment', 695, 'mortgage:2026-09'],
      ['expense', 300, 'mortgage:2026-09:interest'],
      ['expense', 5, 'mortgage:2026-09:fee'],
    ]);
  });

  it('forecasts the fee leg too', () => {
    const rows = forecastScheduledTransactions([item({ loan_fee: 5 })], accounts, envelopes, new Date(2026, 8, 10), '2026-10-31', null, 'FI', { transactions: [] });
    expect(rows.map(r => [r.forecast_loan_leg, r.amount, r.forecast_dedup_key ?? null])).toEqual([
      ['principal', 695, null], ['interest', 300, 'mortgage:2026-10:interest'], ['fee', 5, 'mortgage:2026-10:fee'],
    ]);
  });
});
