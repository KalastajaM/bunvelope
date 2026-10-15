// Loan accounts: a liability held outside the envelope identity, paid down
// by `debt_payment` rows (principal) with the interest booked as an ordinary
// expense. These pin the accounting: principal is a balance-sheet movement
// (saving, not spending), interest is the expense, and the budget's
// unallocated money is untouched by either.
import { describe, it, expect } from 'vitest';
import {
  computeAccountBalances, computeEnvelopeBalances, computeUnallocated, computeNetWorth,
  countsTowardIdentity, isSpendingAccount, isCrisisCashAccount, isLoanAccount, isLoanGivenAccount, loanAccountIds,
  netWorthPartOf, txConsumptionPairs, txConsumptionTotal, txSpendTotal, projectNetWorth,
  aggregateIncomeVsSpending, aggregateSavingByMonth, aggregateSpendingByMonth,
} from '../js/engine.js';

const checking = { id: 'chk', type: 'bank', initialBalance: 5000 };
const mortgage = { id: 'mtg', type: 'loan', initialBalance: -200000 };
const card = { id: 'cc', type: 'credit_card', initialBalance: -300 };
const accounts = [checking, mortgage, card];

const principal = {
  id: 'p1', type: 'debt_payment', date: '2026-09-05', amount: 800,
  from_account: 'chk', to_account: 'mtg', envelope_id: 'housing', status: 'posted',
};
const interest = {
  id: 'i1', type: 'expense', date: '2026-09-05', amount: 400,
  account: 'chk', envelope_id: 'housing', status: 'posted',
};
const fill = { id: 'f1', type: 'fill', date: '2026-09-01', lines: [{ envelope_id: 'housing', amount: 1200 }], status: 'posted' };

describe('loan account classification', () => {
  it('is a loan, outside the identity, never spending or crisis cash', () => {
    expect(isLoanAccount(mortgage)).toBe(true);
    expect(isLoanAccount(card)).toBe(false);
    expect(countsTowardIdentity(mortgage)).toBe(false);
    expect(isSpendingAccount(mortgage)).toBe(false);
    expect(isSpendingAccount({ ...mortgage, spending: true })).toBe(false);
    expect(isCrisisCashAccount({ ...mortgage, crisisCash: true })).toBe(false);
  });

  it('counts in net worth on a line of its own', () => {
    expect(netWorthPartOf(mortgage)).toBe('debts');
    const nw = computeNetWorth(accounts, []);
    expect(nw.debts).toBe(-200000);
    expect(nw.assets).toBe(0);
    expect(loanAccountIds(accounts)).toEqual(new Set(['mtg']));
  });
});

describe('a mortgage payment split into principal and interest', () => {
  const txs = [fill, principal, interest];

  it('moves the principal onto the loan and leaves unallocated alone', () => {
    const before = computeUnallocated(
      computeAccountBalances(accounts, [fill]), computeEnvelopeBalances([fill]), accounts);
    const acc = computeAccountBalances(accounts, txs);
    const env = computeEnvelopeBalances(txs);
    expect(acc.get('chk')).toBe(3800);
    expect(acc.get('mtg')).toBe(-199200);
    expect(env.get('housing')).toBe(0);
    expect(computeUnallocated(acc, env, accounts)).toBe(before);
  });

  it('lowers net worth by the interest only', () => {
    const nw0 = computeNetWorth(accounts, [fill]).total;
    expect(computeNetWorth(accounts, txs).total).toBe(nw0 - 400);
  });

  it('spends the whole payment from the envelope, but only the interest is consumption', () => {
    expect(txSpendTotal(principal)).toBe(800);
    const loans = loanAccountIds(accounts);
    expect(txConsumptionPairs(principal, loans)).toEqual([]);
    expect(txConsumptionTotal(interest, loans)).toBe(400);
    // Without the loan ids (or for a card), a debt payment still counts.
    expect(txConsumptionTotal(principal)).toBe(800);
    expect(txConsumptionTotal({ ...principal, to_account: 'cc' }, loans)).toBe(800);
  });

  it('reports: interest is Spending, principal is Saving', () => {
    const ivs = aggregateIncomeVsSpending(txs, accounts, {}, { accounts });
    const spending = ivs.series.find(s => s.name === 'Spending').points[0].value;
    const saving = ivs.series.find(s => s.name === 'Saving').points[0].value;
    expect(spending).toBe(400);
    expect(saving).toBe(800);
    expect(aggregateSavingByMonth(txs, accounts)).toEqual([{ key: '2026-09', label: '2026-09', value: 800 }]);
    expect(aggregateSpendingByMonth(txs, {}, { accounts })[0].value).toBe(400);
  });
});

describe('projectNetWorth with a loan', () => {
  it('stops paying a loan down at zero', () => {
    const out = projectNetWorth({
      accounts: [mortgage],
      balances: new Map([['mtg', -1000]]),
      growthPct: new Map(),
      contribution: new Map([['mtg', 300]]),
      years: 1,
    });
    expect(out[1].total).toBe(0);
  });
});

// A loan GIVEN: money someone owes the household. The mirror of the above:
// a positive balance outside the identity, lent from an envelope, repaid into
// an account (Unallocated), interest received as income.
describe('a loan given', () => {
  const savings = { id: 'sav', type: 'savings', initialBalance: 60000 };
  const lent = { id: 'lg', type: 'loan_given', initialBalance: 0 };
  const accts = [savings, lent];
  const fund = { id: 'f', type: 'fill', date: '2026-01-01', lines: [{ envelope_id: 'reserve', amount: 60000 }], status: 'posted' };
  const lend = {
    id: 'l1', type: 'debt_payment', date: '2026-02-01', amount: 55000,
    from_account: 'sav', to_account: 'lg', envelope_id: 'reserve', status: 'posted',
  };
  const repay = { id: 'r1', type: 'account_transfer', date: '2026-06-01', amount: 10000, from_account: 'lg', to_account: 'sav', status: 'posted' };
  const interestIn = { id: 'i', type: 'income', date: '2026-06-01', amount: 500, account: 'sav', status: 'posted' };

  const unalloc = (txs) => computeUnallocated(computeAccountBalances(accts, txs), computeEnvelopeBalances(txs), accts);

  it('is outside the identity, never spending or crisis cash, a line of its own in net worth', () => {
    expect(countsTowardIdentity(lent)).toBe(false);
    expect(isSpendingAccount({ ...lent, spending: true })).toBe(false);
    expect(isCrisisCashAccount({ ...lent, crisisCash: true })).toBe(false);
    expect(netWorthPartOf(lent)).toBe('loansGiven');
    expect(isLoanGivenAccount(lent)).toBe(true);
    expect(isLoanAccount(lent)).toBe(false);
    expect(loanAccountIds(accts)).toEqual(new Set(['lg']));
  });

  it('lending from an envelope leaves Unallocated and net worth alone', () => {
    expect(unalloc([fund, lend])).toBe(unalloc([fund]));
    expect(computeNetWorth(accts, [fund, lend]).total).toBe(computeNetWorth(accts, [fund]).total);
    expect(computeAccountBalances(accts, [fund, lend]).get('lg')).toBe(55000);
  });

  it('lending is saving, not spending; a repayment is a withdrawal and lands in Unallocated', () => {
    const txs = [fund, lend, repay, interestIn];
    expect(txConsumptionTotal(lend, loanAccountIds(accts))).toBe(0);
    // From savings it was already saved: moving it on is not new saving.
    expect(aggregateSavingByMonth(txs, accts)).toEqual([]);
    // From a current account it is saving going out, and coming back.
    const chk = { id: 'chk', type: 'bank', initialBalance: 0 };
    const fromChk = [{ ...lend, from_account: 'chk' }, { ...repay, to_account: 'chk' }];
    expect(aggregateSavingByMonth(fromChk, [chk, lent])).toEqual([
      { key: '2026-02', label: '2026-02', value: 55000 },
      { key: '2026-06', label: '2026-06', value: -10000 },
    ]);
    expect(unalloc(txs)).toBe(unalloc([fund, lend]) + 10500);
  });

  it('the projection stops a loan given at zero once repaid', () => {
    const out = projectNetWorth({
      accounts: [lent],
      balances: new Map([['lg', 1000]]),
      growthPct: new Map(),
      contribution: new Map([['lg', -300]]),
      years: 1,
    });
    expect(out[1].total).toBe(0);
  });
});
