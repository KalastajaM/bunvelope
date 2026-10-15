// A loan payment recorded by hand (Add transaction → Loan payment) is saved as
// a `debt_payment` into the loan plus an interest expense (and a fee expense),
// with no `budget_item_id` and no `from_budget`. None of those rows equals the
// scheduled item's whole instalment, so the amount rule never matched it: the
// item posted again, and the forecast charged the month a second time.
// The loan account now names the item, when exactly one scheduled item pays it.
import { describe, it, expect } from 'vitest';
import {
  findUnlinkedScheduledPayments, materializeDueBudgetItems, forecastScheduledTransactions,
  netForecastAgainstRealPayments, projectEnvelopeBalance, computeItemFunding,
} from '../../js/engine.js';
import { parseFromBudgetKey } from '../../js/engine/_constants.js';

const chk = { id: 'chk', type: 'bank', initialBalance: 5000 };
const mtg = { id: 'mtg', type: 'loan', initialBalance: -120000, interestDayCount: '30/360' };
const car = { id: 'car', type: 'loan', initialBalance: -10000 };
const accounts = [chk, mtg, car];
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

// What add-tx writes for a 1000 payment the bank split 690 / 310.
const handPayment = (date, over = {}) => [
  { id: `p-${date}`, type: 'debt_payment', date, amount: 690, from_account: 'chk', to_account: 'mtg',
    envelope_id: 'housing', payee: 'Bank', ...over },
  { id: `i-${date}`, type: 'expense', date, amount: 310, account: 'chk', envelope_id: 'housing',
    payee: 'Bank', note: 'Loan interest' },
];
const fill = { id: 'f', type: 'fill', date: '2026-09-01', status: 'posted', lines: [{ envelope_id: 'housing', mode: 'add', amount: 3000 }] };

let n = 0;
const idGen = () => `g${++n}`;

describe('the duplicate-post guard', () => {
  const today = new Date(2026, 8, 10);
  const find = (budgetItems, transactions) => findUnlinkedScheduledPayments({
    budgetItems, envelopes, transactions, today, accounts,
  });

  it('takes a hand-recorded loan payment as the month\'s instalment, whatever its split', () => {
    const txs = handPayment('2026-09-03');
    const out = find([item()], txs);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ key: 'mortgage:2026-09', itemId: 'mortgage', txId: 'p-2026-09-03' });

    const { newTxs } = materializeDueBudgetItems([item()], accounts, envelopes, txs, today, idGen, [], 'FI', out.map(p => p.key));
    expect(newTxs).toEqual([]);
  });

  it('counts a payment that differs from the plan\'s amount', () => {
    const txs = handPayment('2026-09-05', { amount: 1500 });
    expect(find([item()], txs).map(p => p.key)).toEqual(['mortgage:2026-09']);
  });

  it('leaves a loan two items pay to the user, and a payment into another loan alone', () => {
    const second = item({ id: 'mortgage-b', description: 'Second' });
    expect(find([item(), second], handPayment('2026-09-03'))).toEqual([]);
    const intoCar = handPayment('2026-09-03', { to_account: 'car' });
    expect(find([item()], intoCar)).toEqual([]);
  });

  it('ignores a disabled or unscheduled item when naming the loan\'s item', () => {
    const off = item({ id: 'old', include: false });
    expect(find([item(), off], handPayment('2026-09-03')).map(p => p.key)).toEqual(['mortgage:2026-09']);
  });
});

describe('the forecast', () => {
  const today = new Date(2026, 8, 25);
  const rows = () => forecastScheduledTransactions([item()], accounts, envelopes, today, '2026-11-30', null, 'FI', { transactions: [] });

  it('drops every row of the instalment a hand payment settles, and only that month', () => {
    const net = netForecastAgainstRealPayments(rows(), {
      transactions: handPayment('2026-09-30'), windowFromStr: '2026-09-26', windowToStr: '2026-11-30',
    });
    expect(net.map(r => [r.forecast_month_key, r.forecast_loan_leg])).toEqual([
      ['2026-11', 'principal'], ['2026-11', 'interest'],
    ]);
  });

  it('an amount look-alike stands in only for the row it matches', () => {
    const lookAlike = [{ id: 'x', type: 'expense', date: '2026-10-05', amount: 300, account: 'chk', envelope_id: 'housing' }];
    const net = netForecastAgainstRealPayments(rows(), {
      transactions: lookAlike, windowFromStr: '2026-09-26', windowToStr: '2026-11-30',
    });
    expect(net.map(r => [r.forecast_month_key, r.forecast_loan_leg])).toEqual([
      ['2026-10', 'principal'], ['2026-11', 'principal'], ['2026-11', 'interest'],
    ]);
  });

  it('a due, unposted instalment paid by hand is not charged again in the projection', () => {
    const p = projectEnvelopeBalance({
      envelopeId: 'housing', transactions: [fill, ...handPayment('2026-09-03')], budgetItems: [item()],
      accounts, envelopes, today: new Date(2026, 8, 10), months: 1,
    });
    // 3000 filled, 1000 paid by hand on the 3rd; October's 1000 is still to come.
    expect(p.daily[0].balance).toBe(2000);
    expect(p.daily.find(d => d.date === '2026-10-05').balance).toBe(1000);
  });
});

describe('fill %', () => {
  // A second, spending item in the envelope: unlinked spend goes to it first,
  // so the loan only reads paid when its payment is tied to it.
  const groceries = {
    id: 'groceries', kind: 'expense', description: 'Groceries', envelope_id: 'housing',
    default_amount: -500, monthly_schedule: everyMonth, include: true,
  };
  const funding = (transactions) => computeItemFunding({
    envelopeId: 'housing', budgetItems: [item(), groceries], transactions,
    balance: 2000, today: new Date(2026, 8, 10),
  }).items.find(r => r.itemId === 'mortgage');

  it('reads a hand loan payment as paying its item', () => {
    expect(funding([fill, ...handPayment('2026-09-03')]).status).toBe('paid');
  });

  it('attributes every posted row of an instalment to its item, the interest row included', () => {
    const { newTxs } = materializeDueBudgetItems([item()], accounts, envelopes, [], new Date(2026, 8, 10), idGen);
    const row = funding([fill, ...newTxs]);
    expect(row.spent).toBe(1000);
    expect(row.status).toBe('paid');
  });
});

describe('parseFromBudgetKey', () => {
  it('reads the item and month from every loan row\'s key', () => {
    expect(parseFromBudgetKey('mortgage:2026-09')).toEqual({ itemId: 'mortgage', month: '2026-09' });
    expect(parseFromBudgetKey('mortgage:2026-09:interest')).toEqual({ itemId: 'mortgage', month: '2026-09' });
    expect(parseFromBudgetKey('mortgage:2026-09:fee')).toEqual({ itemId: 'mortgage', month: '2026-09' });
    expect(parseFromBudgetKey('a:b:2026-09')).toEqual({ itemId: 'a:b', month: '2026-09' });
    expect(parseFromBudgetKey('nope')).toBeNull();
    expect(parseFromBudgetKey(null)).toBeNull();
  });
});

// Add transaction now links a hand payment's interest and fee rows to the
// loan item too (the principal is linked by its loan account).
describe('a hand payment whose interest row is linked to the item', () => {
  const linked = (date) => handPayment(date).map(r => (r.type === 'expense' ? { ...r, budget_item_id: 'mortgage' } : r));

  it('is one payment to the duplicate-post guard, not two', () => {
    const out = findUnlinkedScheduledPayments({
      budgetItems: [item()], envelopes, transactions: linked('2026-09-03'), today: new Date(2026, 8, 10), accounts,
    });
    expect(out.map(p => [p.key, p.txId])).toEqual([['mortgage:2026-09', 'p-2026-09-03']]);
  });

  it('two payments on different days are still two', () => {
    const out = findUnlinkedScheduledPayments({
      budgetItems: [item()], envelopes, transactions: [...linked('2026-09-03'), ...linked('2026-09-04')],
      today: new Date(2026, 8, 10), accounts,
    });
    expect(out).toEqual([]);
  });

  it('its interest no longer stands in for the envelope\'s other planned spending', () => {
    const utilities = {
      id: 'utilities', kind: 'expense', description: 'Utilities', envelope_id: 'housing',
      default_amount: -200, monthly_schedule: everyMonth, payment_day: 20, include: true,
    };
    const project = (txs) => projectEnvelopeBalance({
      envelopeId: 'housing', transactions: [fill, ...txs], budgetItems: [item(), utilities],
      accounts, envelopes, today: new Date(2026, 8, 10), months: 1,
    }).daily.find(d => d.date === '2026-09-30').balance;
    // 3000 filled, 1000 paid on the loan, 200 of utilities still to come.
    expect(project(linked('2026-09-03'))).toBe(1800);
    // Whichever row of the payment is found first, the rest go with it: the
    // principal must not be left over to stand in for the utilities.
    expect(project([...linked('2026-09-03')].reverse())).toBe(1800);
  });

  it('counts in full against the loan item in fill %', () => {
    const groceries = {
      id: 'groceries', kind: 'expense', description: 'Groceries', envelope_id: 'housing',
      default_amount: -500, monthly_schedule: everyMonth, include: true,
    };
    const items = computeItemFunding({
      envelopeId: 'housing', budgetItems: [item(), groceries], transactions: [fill, ...linked('2026-09-03')],
      balance: 2000, today: new Date(2026, 8, 10),
    }).items;
    expect(items.find(r => r.itemId === 'mortgage').spent).toBe(1000);
    expect(items.find(r => r.itemId === 'groceries').spent).toBe(0);
  });
});
