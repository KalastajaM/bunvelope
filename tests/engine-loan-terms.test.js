// A loan's interest: a dated list of rates (a fixed rate is one entry; a
// Euribor-linked one gets a new entry each reset), accruing day by day on
// what is still owed. For a loan given, the interest falls due every period
// (monthly, quarterly, yearly) counted from the start date and is paid in
// cash, so it never changes the loan's balance.
import { describe, it, expect } from 'vitest';
import { loanGivenTerms, loanRateOn } from '../js/engine/loan-terms.js';

const lent = {
  id: 'lg', type: 'loan_given', initialBalance: 0,
  interestRates: [{ from: '2026-03-01', rate: 2.5 }],
  loanStart: '2026-03-01', loanEnd: '2031-02-28',
};
const lend = { id: 'l', type: 'debt_payment', date: '2026-03-01', amount: 55000, from_account: 'sav', to_account: 'lg', envelope_id: 'e', status: 'posted' };
const day = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };

describe('loanRateOn', () => {
  const acct = { interestRates: [{ from: '2026-06-01', rate: 3.1 }, { from: '2026-01-01', rate: 2.5 }] };
  it('is the rate in effect that day', () => {
    expect(loanRateOn(acct, '2026-03-15')).toBe(2.5);
    expect(loanRateOn(acct, '2026-06-01')).toBe(3.1);
  });
  it('is null before the first rate, and without any', () => {
    expect(loanRateOn(acct, '2025-12-31')).toBeNull();
    expect(loanRateOn({}, '2026-03-15')).toBeNull();
  });
  it('reads the single rate of old interest tiers', () => {
    expect(loanRateOn({ interestTiers: [{ upTo: null, rate: 2 }] }, '2026-03-15')).toBe(2);
  });
});

describe('loanGivenTerms', () => {
  it('is null for any other account', () => {
    expect(loanGivenTerms({ id: 'x', type: 'savings' }, [], day('2026-06-01'))).toBeNull();
  });

  it('yearly by default: due a year after the start, accrued so far and at the due date', () => {
    const t = loanGivenTerms(lent, [lend], day('2026-09-01'));
    expect(t).toMatchObject({ start: '2026-03-01', end: '2031-02-28', cycleStart: '2026-03-01', dueDate: '2027-03-01', owed: 55000 });
    expect(t.accrued).toBeCloseTo(693.15, 2); // 184 days × 55,000 × 2.5 % ÷ 365
    expect(t.atDue).toBeCloseTo(1375, 2);
  });

  it('quarterly and monthly cycles count from the start date', () => {
    expect(loanGivenTerms({ ...lent, interestPayout: 'quarterly' }, [lend], day('2026-09-01')))
      .toMatchObject({ cycleStart: '2026-06-01', dueDate: '2026-09-01' });
    expect(loanGivenTerms({ ...lent, interestPayout: 'monthly' }, [lend], day('2026-09-15')))
      .toMatchObject({ cycleStart: '2026-09-01', dueDate: '2026-10-01' });
  });

  it('follows a rate change day by day', () => {
    const t = loanGivenTerms({ ...lent, interestRates: [{ from: '2026-03-01', rate: 2.5 }, { from: '2026-06-01', rate: 3.65 }] }, [lend], day('2026-09-01'));
    // 92 days at 2.5 %, then 92 days at 3.65 %
    expect(t.accrued).toBeCloseTo(55000 * 0.025 * 92 / 365 + 55000 * 0.0365 * 92 / 365, 1);
  });

  it('follows a repayment day by day', () => {
    const repay = { id: 'r', type: 'account_transfer', date: '2026-09-01', amount: 15000, from_account: 'lg', to_account: 'sav', status: 'posted' };
    const t = loanGivenTerms(lent, [lend, repay], day('2026-12-01'));
    expect(t.accrued).toBeCloseTo(693.15 + 249.32, 1);
    expect(t.owed).toBe(40000);
  });

  it('settles the last cycle on the end date', () => {
    expect(loanGivenTerms(lent, [lend], day('2030-06-01')).dueDate).toBe('2031-02-28');
  });

  it('without a rate or a start date there is no interest cycle, only the balance', () => {
    expect(loanGivenTerms({ ...lent, interestRates: [] }, [lend], day('2026-09-01')))
      .toMatchObject({ dueDate: null, accrued: 0, atDue: 0, owed: 55000 });
    expect(loanGivenTerms({ ...lent, loanStart: null }, [lend], day('2026-09-01')))
      .toMatchObject({ dueDate: null, owed: 55000 });
  });
});

describe('loanGivenTerms: interest received (owner decision 3, outstanding)', () => {
  const interest = (id, date, amount, over = {}) => ({
    id, type: 'income', date, amount, account: 'sav', envelope_id: null, interest_of: 'lg', status: 'posted', ...over,
  });

  it('linked interest received is netted off what is outstanding now and at the due date', () => {
    const t = loanGivenTerms(lent, [lend, interest('i1', '2026-08-01', 200)], day('2026-09-01'));
    expect(t.received).toBe(200);
    expect(t.accrued).toBeCloseTo(693.15 - 200, 2);
    expect(t.atDue).toBeCloseTo(1375 - 200, 2);
  });

  it('ignores unlinked income, other loans, forecasts, rows after today and before the start', () => {
    const rows = [
      lend,
      interest('u', '2026-08-01', 50, { interest_of: undefined }),
      interest('o', '2026-08-01', 50, { interest_of: 'other' }),
      interest('f', '2026-08-01', 50, { is_forecast: true }),
      interest('later', '2026-09-02', 50),
      interest('early', '2026-02-28', 50),
      { id: 'x', type: 'expense', date: '2026-08-01', amount: 50, account: 'sav', interest_of: 'lg' },
    ];
    const t = loanGivenTerms(lent, rows, day('2026-09-01'));
    expect(t.received).toBe(0);
    expect(t.accrued).toBeCloseTo(693.15, 2);
  });

  it('is floored at zero when more was received than has accrued', () => {
    const t = loanGivenTerms(lent, [lend, interest('i1', '2026-08-01', 5000)], day('2026-09-01'));
    expect(t).toMatchObject({ accrued: 0, atDue: 0, received: 5000 });
  });

  it('a cycle paid in full leaves only the current cycle outstanding; an unpaid one carries over', () => {
    // Year one (365 days at 2.5 % on 55,000) is 1,375, paid on 5 Mar 2027.
    const paid = loanGivenTerms(lent, [lend, interest('y1', '2027-03-05', 1375)], day('2027-09-01'));
    expect(paid.cycleStart).toBe('2027-03-01');
    expect(paid.accrued).toBeCloseTo(55000 * 0.025 * 184 / 365, 1);
    expect(paid.atDue).toBeCloseTo(55000 * 0.025 * 366 / 365, 1); // year two has 29 Feb 2028
    const unpaid = loanGivenTerms(lent, [lend], day('2027-09-01'));
    expect(unpaid.received).toBe(0);
    expect(unpaid.accrued).toBeCloseTo(1375 + 55000 * 0.025 * 184 / 365, 1);
  });

  it('without a cycle, still reports what was received', () => {
    expect(loanGivenTerms({ ...lent, interestRates: [] }, [lend, interest('i1', '2026-08-01', 30)], day('2026-09-01')))
      .toMatchObject({ dueDate: null, accrued: 0, atDue: 0, received: 30 });
  });
});
