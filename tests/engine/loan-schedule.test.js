// Loan repayment methods (`loan_method` on a `loan_payment` plan item) and
// the repayment schedule built from them. Posting, the forecast and the
// schedule share one split (`loanOccurrenceSplit`), so the schedule is what
// the app will book.
import { describe, it, expect } from 'vitest';
import {
  loanInstalment, loanMethod, loanSchedule, materializeDueBudgetItems, forecastScheduledTransactions,
  loanBalancePath, projectNetWorth, projectFromSimulation, loanRepayment,
} from '../../js/engine.js';
import { loanDayCount, loanPeriodInterest } from '../../js/engine/loan-terms.js';
import { previousLoanPaymentDate } from '../../js/engine/scheduling.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const everyMonth = Object.fromEntries(MONTHS.map(m => [m, true]));
const chk = { id: 'chk', type: 'bank', initialBalance: 0 };
// Flat months (owed × rate ÷ 12) so the figures below are the textbook ones;
// the actual-day count has its own block at the end.
const loan = (over = {}) => ({ id: 'mtg', type: 'loan', initialBalance: -100000, interestRates: [{ from: '2020-01-01', rate: 3 }], interestDayCount: '30/360', ...over });
const envelopes = [{ id: 'housing', name: 'Housing' }];
const item = (over = {}) => ({
  id: 'mortgage', kind: 'loan_payment', description: 'Mortgage',
  envelope_id: 'housing', account_id: 'chk', to_account_id: 'mtg',
  default_amount: -474.21, monthly_schedule: everyMonth, payment_day: 5,
  as_schedule: true, as_schedule_since: '2026-10-01', include: true, schedule_day_type: 'exact',
  ...over,
});
const annuity = (over = {}) => item({ loan_method: 'annuity', loan_end: '2051-09', ...over });
const equal = (over = {}) => item({ loan_method: 'equal_principal', loan_end: '2051-09', ...over });
const TODAY = new Date(2026, 8, 20); // 20 Sep 2026: the first payment is 5 Oct

describe('loanInstalment', () => {
  const occ = { amount: -474.21, owed: 100000, rate: 3, monthKey: '2026-10' };

  it('an annuity pays the constant payment that ends the loan on time', () => {
    // 100,000 at 3 % over 300 months (Oct 2026 to Sep 2051): 474.21 a month.
    const s = loanInstalment(annuity(), occ);
    expect(s).toEqual({ interest: 250, fee: 0, principal: 224.21 });
  });

  it('equal principal pays what is owed over the months left, plus the interest', () => {
    expect(loanInstalment(equal(), occ)).toEqual({ interest: 250, fee: 0, principal: 333.33 });
  });

  it('pays everything owed in the last month, and after the end date', () => {
    expect(loanInstalment(annuity(), { ...occ, owed: 500, monthKey: '2051-09' }).principal).toBe(500);
    expect(loanInstalment(equal(), { ...occ, owed: 500, monthKey: '2052-01' }).principal).toBe(500);
  });

  it('with no rate an annuity is owed ÷ months left', () => {
    expect(loanInstalment(annuity(), { ...occ, rate: 0 })).toEqual({ interest: 0, fee: 0, principal: 333.33 });
  });

  it('other costs come out of a fixed payment and on top of a calculated one', () => {
    expect(loanInstalment(item({ loan_fee: 5 }), { ...occ, amount: -1000 })).toEqual({ interest: 250, fee: 5, principal: 745 });
    expect(loanInstalment(annuity({ loan_fee: 5 }), occ)).toEqual({ interest: 250, fee: 5, principal: 224.21 });
  });

  it('a calculated method without a valid end month is read as a fixed payment', () => {
    expect(loanMethod(annuity({ loan_end: undefined }))).toBe('fixed_payment');
    expect(loanMethod(equal({ loan_end: '2051-13' }))).toBe('fixed_payment');
    expect(loanMethod(annuity())).toBe('annuity');
    expect(loanMethod(item())).toBe('fixed_payment');
  });

  it('a repaid loan pays nothing', () => {
    expect(loanInstalment(annuity(), { ...occ, owed: 0 })).toEqual({ interest: 0, fee: 0, principal: 0 });
  });
});

describe('loanSchedule', () => {
  const schedule = (it, over = {}) => loanSchedule({
    item: it, loan: loan(over.loan), transactions: over.transactions || [], today: over.today || TODAY,
  });

  it('an annuity is repaid in its last month, at a constant payment', () => {
    const s = schedule(annuity());
    expect(s.method).toBe('annuity');
    expect(s.ends).toBe('repaid');
    expect(s.rows).toHaveLength(300);
    expect(s.rows[0]).toMatchObject({ date: '2026-10-05', payment: 474.21, interest: 250, principal: 224.21, owedAfter: 99775.79 });
    expect(s.payoffDate).toBe('2051-09-05');
    expect(s.owedAtEnd).toBe(0);
    // Recalculated every month, the payment stays within a cent of the bank's.
    for (const r of s.rows.slice(0, -1)) expect(Math.abs(Math.round(r.payment * 100) - 47421)).toBeLessThanOrEqual(1);
    expect(s.totalInterest).toBeCloseTo(300 * 474.21 - 100000, -1);
  });

  it('equal principal pays the same principal each month, so the payment falls', () => {
    const s = schedule(equal());
    expect(s.payoffDate).toBe('2051-09-05');
    expect(s.rows[0].payment).toBe(583.33);
    expect(s.rows[1].payment).toBeLessThan(s.rows[0].payment);
    expect(s.rows.at(-1).payment).toBeLessThan(340);
  });

  it('a fixed payment moves the end date with the rate', () => {
    const fixed = schedule(item({ default_amount: -1000 }));
    const dearer = schedule(item({ default_amount: -1000 }), { loan: { interestRates: [{ from: '2020-01-01', rate: 5 }] } });
    expect(fixed.ends).toBe('repaid');
    expect(dearer.payoffDate > fixed.payoffDate).toBe(true);
    expect(fixed.rows[0]).toMatchObject({ payment: 1000, interest: 250, principal: 750 });
  });

  it('a fixed payment that does not cover the interest is never repaid', () => {
    const s = schedule(item({ default_amount: -200 }));
    expect(s.ends).toBe('not_repaid');
    expect(s.payoffDate).toBeNull();
  });

  it('an annuity keeps its end date through a rate change, with a new payment', () => {
    const s = schedule(annuity(), { loan: { interestRates: [{ from: '2020-01-01', rate: 3 }, { from: '2027-01-01', rate: 4 }] } });
    expect(s.payoffDate).toBe('2051-09-05');
    const dec = s.rows.find(r => r.monthKey === '2026-12');
    const jan = s.rows.find(r => r.monthKey === '2027-01');
    expect(jan.payment).toBeGreaterThan(dec.payment + 40);
  });

  it('starts from the real balance: an extra repayment lowers an annuity, not its end', () => {
    const extra = [{ id: 'x', type: 'debt_payment', date: '2026-09-10', amount: 10000, from_account: 'chk', to_account: 'mtg', envelope_id: 'housing' }];
    const s = schedule(annuity(), { transactions: extra });
    expect(s.owedNow).toBe(90000);
    expect(s.payoffDate).toBe('2051-09-05');
    expect(s.rows[0].payment).toBeCloseTo(426.79, 2);
  });

  it('skips a payment already posted, and keeps one due this month that is not', () => {
    const today = new Date(2026, 9, 20);
    const posted = materializeDueBudgetItems([annuity()], [chk, loan()], envelopes, [], today, () => 'p1').newTxs;
    expect(schedule(annuity(), { transactions: posted, today }).rows[0].monthKey).toBe('2026-11');
    expect(schedule(annuity(), { today }).rows[0].monthKey).toBe('2026-10');
  });

  it('stops where the plan item stops, with what is still owed', () => {
    const s = schedule(annuity({ as_schedule_until: '2030-12-31' }));
    expect(s.ends).toBe('plan_ends');
    expect(s.payoffDate).toBeNull();
    expect(s.owedAtEnd).toBeGreaterThan(0);
  });

  it('owes nothing, so has nothing to schedule, on a repaid loan', () => {
    const s = schedule(annuity(), { loan: { initialBalance: 0 } });
    expect(s).toMatchObject({ ends: 'no_payments', rows: [], owedNow: 0 });
  });
});

describe('posting and the forecast follow the method', () => {
  const accounts = [chk, loan()];

  it('posts what the schedule says', () => {
    const s = loanSchedule({ item: equal(), loan: loan(), transactions: [], today: TODAY });
    const { newTxs } = materializeDueBudgetItems([equal()], accounts, envelopes, [], new Date(2026, 9, 6), () => 'p');
    expect(newTxs.map(r => [r.type, r.amount])).toEqual([
      ['debt_payment', s.rows[0].principal], ['expense', s.rows[0].interest],
    ]);
  });

  it('forecasts what the schedule says, month after month', () => {
    const s = loanSchedule({ item: annuity(), loan: loan(), transactions: [], today: TODAY });
    const rows = forecastScheduledTransactions([annuity()], accounts, envelopes, TODAY, '2026-12-31', null, 'FI', { transactions: [] });
    const principals = rows.filter(r => r.forecast_loan_leg === 'principal').map(r => r.amount);
    expect(principals).toEqual(s.rows.slice(0, 3).map(r => r.principal));
  });
});

describe('the Net worth projection past the simulated years', () => {
  const sched = () => loanSchedule({ item: annuity(), loan: loan(), transactions: [], today: TODAY });

  it('loanBalancePath gives the balance at each month end, zero once repaid', () => {
    const path = loanBalancePath(sched(), TODAY, 310);
    expect(path).toHaveLength(311);
    expect(path[0]).toBe(-100000);          // end of Sep 2026: the first payment is 5 Oct
    expect(path[1]).toBe(-99775.79);        // end of Oct
    expect(path[299]).toBeLessThan(0);      // end of Aug 2051: one payment left
    expect(path[300]).toBe(0);              // end of Sep 2051: repaid
    expect(path[310]).toBe(0);
  });

  it('projectNetWorth takes a path as is, ignoring growth and contribution, with lumps on top', () => {
    const acc = [{ id: 'mtg', type: 'loan' }];
    const path = [-1000, -900, -800, -700, -600, -500, -400, -300, -200, -100, 0, 0, 0];
    const run = (lumps = []) => projectNetWorth({
      accounts: acc, balances: new Map([['mtg', -1000]]), growthPct: new Map([['mtg', 5]]),
      contribution: new Map([['mtg', -50]]), years: 1, paths: new Map([['mtg', path]]), lumps,
    });
    expect(run()).toEqual([{ year: 0, total: -1000 }, { year: 1, total: 0 }]);
    expect(run([{ month: 3, accountId: 'mtg', amount: -20 }])[1].total).toBe(-20);
  });

  it('projectFromSimulation hands the loan to its schedule after month 24', () => {
    const path = loanBalancePath(sched(), TODAY, 30 * 12 + 1);
    const snap = (v) => ({ accounts: new Map([['mtg', v]]) });
    // A stand-in run whose 24 months follow the same schedule.
    const sim = { opening: snap(-100000), monthly: path.slice(0, 25).map(snap), laterBooked: [], accruedAtEnd: new Map() };
    const args = { accounts: [{ id: 'mtg', type: 'loan' }], sim, growthPct: new Map(), years: 30 };
    const linear = projectFromSimulation({ ...args, contribution: new Map([['mtg', 100]]) });
    const scheduled = projectFromSimulation({ ...args, contribution: new Map([['mtg', 100]]), scheduled: new Map([['mtg', path]]) });
    expect(scheduled[2].total).toBe(path[24]);
    expect(scheduled[10].total).toBe(path[120]);
    expect(scheduled[25].total).toBe(0);
    // Without the schedule the line falls by the contribution, a different path.
    expect(linear[10].total).not.toBe(path[120]);
  });
});

describe('interest by actual days (the default day count)', () => {
  const actual = (over = {}) => loan({ interestDayCount: undefined, ...over });
  const at3 = () => 3;

  it('defaults to actual/365, and reads the other counts', () => {
    expect(loanDayCount(actual())).toBe('act/365');
    expect(loanDayCount(actual({ interestDayCount: 'act/360' }))).toBe('act/360');
    expect(loanDayCount(actual({ interestDayCount: '30/360' }))).toBe('30/360');
    expect(loanDayCount(actual({ interestDayCount: 'nonsense' }))).toBe('act/365');
  });

  it('charges the days since the previous payment', () => {
    const p = { owed: 100000, fromStr: '2026-10-05', toStr: '2026-11-05', rateOn: at3 };
    // 31 days at 3 %.
    expect(loanPeriodInterest({ ...p, dayCount: 'act/365' })).toBe(254.79);
    expect(loanPeriodInterest({ ...p, dayCount: 'act/360' })).toBe(258.33);
    expect(loanPeriodInterest({ ...p, dayCount: '30/360' })).toBe(250);
    // A 30-day period costs less than a 31-day one.
    expect(loanPeriodInterest({ ...p, fromStr: '2026-09-05', toStr: '2026-10-05', dayCount: 'act/365' })).toBe(246.58);
  });

  it('a rate reset mid-period counts from its date', () => {
    const l = actual({ interestRates: [{ from: '2020-01-01', rate: 3 }, { from: '2026-10-15', rate: 4 }] });
    // 5–14 Oct at 3 %, 15 Oct – 4 Nov at 4 %: (10 × 3 + 21 × 4) / 100 / 365.
    const s = loanSchedule({ item: annuity(), loan: l, transactions: [], today: TODAY });
    expect(s.rows[1]).toMatchObject({ monthKey: '2026-11' });
    const owedBefore = s.rows[0].owedAfter;
    expect(s.rows[1].interest).toBe(Math.round(owedBefore * 114 / 100 / 365 * 100) / 100);
  });

  it("finds the previous payment day on the item's calendar", () => {
    expect(previousLoanPaymentDate(annuity(), { date: '2026-11-05' })).toBe('2026-10-05');
    // The first payment has none before it: the same day a month earlier.
    expect(previousLoanPaymentDate(annuity(), { date: '2026-10-05' })).toBe('2026-09-05');
    // Moved to the next working day: 5 Dec 2026 is a Saturday, paid Mon 7 Dec.
    const shifted = annuity({ schedule_day_type: 'next_work_day' });
    expect(previousLoanPaymentDate(shifted, { date: '2027-01-05' })).toBe('2026-12-07');
  });

  it('posts and schedules the same actual-day interest, and an annuity still ends on time', () => {
    const l = actual();
    const s = loanSchedule({ item: annuity(), loan: l, transactions: [], today: TODAY });
    expect(s.payoffDate).toBe('2051-09-05');
    // Oct 5: 30 days from Sep 5 at 3 % on 100,000.
    expect(s.rows[0].interest).toBe(246.58);
    const { newTxs } = materializeDueBudgetItems([annuity()], [chk, l], envelopes, [], new Date(2026, 9, 6), () => 'p');
    expect(newTxs.find(r => r.type === 'expense').amount).toBe(246.58);
    expect(newTxs.find(r => r.type === 'debt_payment').amount).toBe(s.rows[0].principal);
  });
});

describe('loanRepayment', () => {
  const ctx = (budgetItems) => ({ budgetItems, transactions: [], today: new Date(2026, 8, 15, 12, 0, 0) });

  it('finds the one enabled scheduled item that pays the loan, with its schedule', () => {
    const l = loan();
    const r = loanRepayment(l, ctx([annuity(), annuity({ id: 'off', include: false })]));
    expect(r.status).toBe('ok');
    expect(r.item.id).toBe('mortgage');
    expect(r.schedule.payoffDate).toBe('2051-09-05');
    expect(r.schedule).toEqual(loanSchedule({ item: annuity(), loan: l, transactions: [], today: new Date(2026, 8, 15, 12, 0, 0) }));
  });

  it('says so when no item pays it, or more than one does', () => {
    const l = loan();
    expect(loanRepayment(l, ctx([]))).toEqual({ status: 'none' });
    expect(loanRepayment(l, ctx(undefined))).toEqual({ status: 'none' });
    expect(loanRepayment(l, ctx([annuity(), annuity({ id: 'second' })]))).toEqual({ status: 'shared', count: 2 });
  });

  it('ignores items that are not scheduled loan payments to this loan', () => {
    const l = loan();
    expect(loanRepayment(l, ctx([annuity({ as_schedule: false })])).status).toBe('none');
    expect(loanRepayment(l, ctx([annuity({ to_account_id: 'other' })])).status).toBe('none');
    expect(loanRepayment(l, ctx([annuity({ kind: 'expense' })])).status).toBe('none');
  });
});
