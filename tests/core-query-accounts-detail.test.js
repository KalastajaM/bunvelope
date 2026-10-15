// tests/core-query-accounts-detail.test.js — what an account card shows, as a
// query: `accounts.detail`, per account its Today and lens balances, a loan's
// rate on the day, the yearly interest estimate, a loan given's terms and a
// loan's repayment.
//
// The equivalence helpers copy the code the pages ran before the query
// verbatim: js/ui/account-card.js L151-160 (the rate line) and L190-200 (the
// estimated interest), js/pages/accounts.js L49-55 / L75-76 (the balances
// through the Today and the active lens) and L315-317 (loanGivenTerms and
// loanRepayment), and js/pages/add-tx.js L716-717 (the lent hint's terms),
// with `state` → the fixture, `now()` / `appNow()` → the fixed clock and the
// lens rows → `lensTransactions`. The answer must equal the pages' figures.
import { describe, it, expect } from 'vitest';
import { registry } from '../js/core/index.js';
import { runQuery } from '../js/core/pipeline.js';
import { makeCtx } from '../js/core/context.js';
import { lensTransactions, resolveHorizonDate } from '../js/engine/lens.js';
import { computeAccountBalances } from '../js/engine/balances.js';
import { computeAnnualInterest } from '../js/engine/tx-amounts.js';
import { loanRateOn, loanGivenTerms } from '../js/engine/loan-terms.js';
import { loanRepayment } from '../js/engine/loan-schedule.js';
import { round2 } from '../js/utils.js';

function deepFreeze(o) { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); Object.values(o).forEach(deepFreeze); } return o; }
// Clocks are built from explicit components, so every test reads the same
// local calendar day under each zone test:tz runs.
const at = (y, m, d) => new Date(y, m - 1, d, 10, 0, 0);
const NOW = at(2026, 9, 15);
const ctxAt = (now) => makeCtx({ now, newId: (() => { let n = 0; return () => `q${++n}`; })() });
const ask = (input, d, now = NOW) => runQuery(registry, d, 'accounts.detail', input, ctxAt(now));
const jsonSafe = (v) => expect(JSON.parse(JSON.stringify(v))).toEqual(v);

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const everyMonth = Object.fromEntries(MONTHS.map(m => [m, true]));

// A bank account, a savings account with tiers (and a scheduled transfer in,
// so Today ≠ Booked), a loan with dated rates (one not yet in effect) and one
// plan item paying it, a loan with legacy tiers paid by two items (shared), a
// loan given with dated rates and an end, one with legacy tiers only, a loan
// with no plan item, and an archived savings account.
const loanItem = (over) => ({
  id: 'mortgage', kind: 'loan_payment', description: 'Home loan', envelope_id: 'rent', account_id: 'chk', to_account_id: 'mtg',
  default_amount: -474.21, monthly_schedule: everyMonth, payment_day: 5, as_schedule: true, as_schedule_since: '2026-10-01',
  include: true, schedule_day_type: 'exact', loan_method: 'annuity', loan_end: '2051-09', ...over,
});
const data = (extra = {}) => deepFreeze({
  meta: { country: 'FI' },
  accounts: [
    { id: 'chk', name: 'Checking', type: 'bank', initialBalance: 1000 },
    { id: 'sav', name: 'Savings', type: 'savings', initialBalance: 5000, interestTiers: [{ upTo: 1000, rate: 1 }, { upTo: null, rate: 2.5 }] },
    { id: 'mtg', name: 'Mortgage', type: 'loan', initialBalance: -100000, interestRates: [{ from: '2020-01-01', rate: 3 }, { from: '2026-11-01', rate: 3.5 }] },
    { id: 'car', name: 'Car loan', type: 'loan', initialBalance: -8000, interestTiers: [{ rate: 4.9 }] },
    { id: 'lg', name: 'Loan to Sam', type: 'loan_given', initialBalance: 0, loanStart: '2026-03-01', loanEnd: '2028-02-29', interestPayout: 'yearly', interestRates: [{ from: '2026-03-01', rate: 4 }] },
    { id: 'lg2', name: 'Loan to Kim', type: 'loan_given', initialBalance: 0, loanStart: '2026-06-01', interestPayout: 'quarterly', interestTiers: [{ rate: 3 }] },
    { id: 'bare', name: 'Old loan', type: 'loan', initialBalance: -500 },
    { id: 'old', name: 'Old savings', type: 'savings', initialBalance: 300, archived: true, interestTiers: [{ rate: 2 }] },
  ],
  envelopes: [{ id: 'rent', name: 'Rent' }],
  budgetItems: [
    loanItem(),
    loanItem({ id: 'car1', description: 'Car A', to_account_id: 'car', default_amount: -200, loan_method: 'fixed_payment', loan_end: undefined }),
    loanItem({ id: 'car2', description: 'Car B', to_account_id: 'car', default_amount: -100, loan_method: 'fixed_payment', loan_end: undefined }),
  ],
  envelopeTemplates: [],
  transactions: [
    { id: 'i1', type: 'income', date: '2026-08-01', payee: 'Job', amount: 5000, account: 'chk', status: 'posted' },
    { id: 't1', type: 'account_transfer', date: '2026-03-01', amount: 2000, from_account: 'chk', to_account: 'lg', status: 'posted' },
    { id: 't2', type: 'account_transfer', date: '2026-06-01', amount: 1500, from_account: 'chk', to_account: 'lg2', status: 'posted' },
    { id: 't4', type: 'account_transfer', date: '2026-07-01', amount: 500, from_account: 'lg', to_account: 'chk', status: 'posted' },
    { id: 't3', type: 'account_transfer', date: '2026-09-20', amount: 300, from_account: 'chk', to_account: 'sav', status: 'scheduled' },
  ],
  ...extra,
});

// ── The pages' code, verbatim (see the header) ───────────────────────────

/** account-card.js L151-160: the rate the card shows, or null for no line. */
function cardRate(account, now) {
  // A loan's rate today, from its dated rates (engine loanRateOn).
  if (account.type === 'loan' || account.type === 'loan_given') {
    const d = now;
    const rate = loanRateOn(account, `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
    if (rate !== null) {
      return rate;
    }
  }
  return null;
}

/** account-card.js L190-200 (the branch without loan terms): the estimate the card shows, 0 for no line. */
function cardEstInterest(account, currentBalance) {
  if (Array.isArray(account.interestTiers) && account.interestTiers.length
      && currentBalance > 0) {
    const annual = computeAnnualInterest(currentBalance, account.interestTiers);
    if (annual > 0) {
      return annual;
    }
  }
  return 0;
}

/** accounts.js L49-55 / L75-76: balances through a lens (the query's composition, as 4c pinned it). */
function lensBalances(d, lens, horizon, now) {
  const txs = lensTransactions(d, { lens, horizon: lens === 'forecast' ? resolveHorizonDate(horizon ?? '3m', now) : undefined, today: now });
  return computeAccountBalances(d.accounts, txs);
}

/** accounts.js L315-317: what the Accounts page hands the card. */
function pageLoanLines(acc, state, appNow) {
  return {
    loanTerms: acc.type === 'loan_given' ? loanGivenTerms(acc, state.transactions, appNow()) : null,
    loanRepayment: acc.type === 'loan'
      ? loanRepayment(acc, { budgetItems: state.budgetItems, transactions: state.transactions, today: appNow(), country: state.meta?.country ?? 'FI' })
      : null,
  };
}

/** add-tx.js L716-717: the lent hint's terms for the picked loan given. */
function lentHintTerms(state, lentLoanSelValue, appNow) {
  const acct = state.accounts.find(a => a.id === lentLoanSelValue);
  const terms = acct ? loanGivenTerms(acct, state.transactions, appNow()) : null;
  return terms;
}

/** The engine's LoanRepayment as the answer carries it: the plan item cut to its id and description. */
function repaymentShape(r) {
  if (!r || r.status !== 'ok') return r;
  return { status: 'ok', item: { id: r.item.id, description: r.item.description ?? null }, schedule: r.schedule };
}

function expected(d, { lens = 'booked', horizon } = {}, now = NOW) {
  const cur = lensBalances(d, 'today', undefined, now);
  const bud = lensBalances(d, lens, horizon, now);
  return d.accounts.map((acc) => {
    const currentBalance = round2(cur.get(acc.id) ?? 0);
    const lines = pageLoanLines(acc, d, () => new Date(now));
    return {
      id: acc.id,
      currentBalance,
      portfolioValue: null,
      budgetBalance: round2(bud.get(acc.id) ?? 0),
      rate: cardRate(acc, now),
      estInterest: cardEstInterest(acc, currentBalance),
      loanTerms: lines.loanTerms,
      repayment: repaymentShape(lines.loanRepayment),
    };
  });
}

describe('accounts.detail', () => {
  it('values stored portfolios independently of the lens, preserving tracking, archives and holdings sources', () => {
    const d = data({
      accounts: [
        { id: 'cash', type: 'bank' },
        { id: 'broker', type: 'investment' },
        { id: 'empty', type: 'investment' },
        { id: 'old', type: 'investment', archived: true },
        { id: 'off', type: 'investment', trackInvestments: false },
      ],
      budgetItems: [],
      transactions: [
        { id: 'buy', type: 'investment_transfer', direction: 'buy', date: '2026-09-20', status: 'scheduled', from_account: 'cash', to_account: 'broker', symbol: 'FUND', units: 2, amount: 100 },
      ],
      meta: { investments: {
        prices: { FUND: { price: 75.126 }, MAN: { price: 12 }, OLD: { price: 10 } },
        holdingOverrides: {
          broker: { FUND: { units: 999, costBasis: 999 }, UNPRICED: { units: 3, costBasis: 40 } },
          old: { OLD: { units: 4, costBasis: 20 } },
          off: { OLD: { units: 100, costBasis: 20 } },
          cash: { OLD: { units: 100, costBasis: 20 } },
        },
        manualRows: { broker: { MAN: [{ id: 'manual', date: '2026-01-01', direction: 'buy', units: 5, amount: 50 }] } },
      } },
    });
    for (const input of [{ lens: 'today' }, { lens: 'booked' }, { lens: 'forecast', horizon: '3m' }]) {
      const r = ask(input, d);
      expect(r.ok).toBe(true);
      // Actual rows win over the FUND override. Unpriced holdings retain cost;
      // manual rows contribute holdings only. Round the final account total.
      expect(r.value.accounts.map(a => [a.id, a.portfolioValue])).toEqual([
        ['cash', null], ['broker', 250.25], ['empty', 0], ['old', 40], ['off', null],
      ]);
      jsonSafe(r.value);
    }
    const subset = ask({ accounts: ['old', 'broker'], date: '2020-01-01', repayment: false }, d);
    expect(subset.value.accounts.map(a => [a.id, a.portfolioValue])).toEqual([['broker', 250.25], ['old', 40]]);
    expect(ask({ accounts: [] }, d).value.accounts).toEqual([]);
    expect(ask({ lens: 'today' }, d).value.accounts[1].budgetBalance)
      .not.toBe(ask({ lens: 'booked' }, d).value.accounts[1].budgetBalance);
  });

  it('equals the pages\' figures for every account (booked lens), archived ones included', () => {
    const d = data();
    const r = ask({ lens: 'booked' }, d);
    expect(r.ok).toBe(true);
    expect(r.value.lens).toBe('booked');
    expect(r.value.horizon).toBeNull();
    expect(r.value.accounts).toEqual(expected(d));
    jsonSafe(r.value);
  });

  it('is not vacuous: the fixture has every line the card can show', () => {
    const rows = Object.fromEntries(ask({ lens: 'booked' }, data()).value.accounts.map(a => [a.id, a]));
    // Today ≠ Booked on the savings account (the transfer on the 20th is scheduled).
    expect(rows.sav.currentBalance).toBe(5000);
    expect(rows.sav.budgetBalance).toBe(5300);
    // The estimate reads the Today balance: 1000 × 1% + 4000 × 2.5%.
    expect(rows.sav.estInterest).toBe(110);
    // Dated rates: the November rate is not in effect on 15 Sep.
    expect(rows.mtg.rate).toBe(3);
    // Legacy tiers read as the loan's rate.
    expect(rows.car.rate).toBe(4.9);
    expect(rows.bare.rate).toBeNull();
    // Not a loan: no rate line, whatever its tiers say.
    expect(rows.sav.rate).toBeNull();
    expect(rows.lg.loanTerms).toMatchObject({ dueDate: '2027-03-01', owed: 1500 });
    expect(rows.lg.loanTerms.accrued).toBeGreaterThan(0);
    expect(rows.lg2.loanTerms.dueDate).toBe('2026-12-01');
    // A loan given with legacy tiers still has an estimate (the Dashboard's card shows it).
    expect(rows.lg2.estInterest).toBe(45);
    expect(rows.chk.loanTerms).toBeNull();
    expect(rows.mtg.repayment.status).toBe('ok');
    expect(rows.mtg.repayment.item).toEqual({ id: 'mortgage', description: 'Home loan' });
    expect(rows.mtg.repayment.schedule.payoffDate).toBe('2051-09-05');
    expect(rows.mtg.repayment.schedule.rows.length).toBeGreaterThan(0);
    expect(rows.car.repayment).toEqual({ status: 'shared', count: 2 });
    expect(rows.bare.repayment).toEqual({ status: 'none' });
    expect(rows.lg.repayment).toBeNull();
    expect(rows.old.estInterest).toBe(6);
  });

  it('a loan given\'s terms net the interest received through interest_of, and return it', () => {
    const base = Object.fromEntries(ask({ lens: 'booked' }, data()).value.accounts.map(a => [a.id, a]));
    const d = data({
      transactions: [
        ...data().transactions,
        { id: 'int', type: 'income', date: '2026-08-01', payee: 'Sam', amount: 10, account: 'chk', envelope_id: null, interest_of: 'lg', status: 'posted' },
      ],
    });
    const rows = Object.fromEntries(ask({ lens: 'booked' }, d).value.accounts.map(a => [a.id, a]));
    expect(base.lg.loanTerms.received).toBe(0);
    expect(rows.lg.loanTerms.received).toBe(10);
    expect(rows.lg.loanTerms.accrued).toBeCloseTo(base.lg.loanTerms.accrued - 10, 2);
    expect(rows.lg.loanTerms.atDue).toBeCloseTo(base.lg.loanTerms.atDue - 10, 2);
    expect(rows.lg2.loanTerms.received).toBe(0);
  });

  for (const [name, lensInput] of [
    ['today', { lens: 'today' }],
    ['forecast (3m)', { lens: 'forecast', horizon: '3m' }],
    ['forecast (12m)', { lens: 'forecast', horizon: '12m' }],
  ]) {
    it(`${name} lens: the budget balance follows the lens, the current balance stays Today`, () => {
      const d = data();
      const r = ask(lensInput, d);
      expect(r.ok).toBe(true);
      expect(r.value.accounts).toEqual(expected(d, lensInput));
    });
  }

  it('the forecast lens moves the loans (their payments are generated), so the lens case is not vacuous', () => {
    const rows = Object.fromEntries(ask({ lens: 'forecast', horizon: '3m' }, data()).value.accounts.map(a => [a.id, a]));
    expect(rows.mtg.budgetBalance).not.toBe(rows.mtg.currentBalance);
    expect(rows.mtg.estInterest).toBe(0);
  });

  it('`accounts` narrows the answer to those ids, in account order', () => {
    const d = data();
    const r = ask({ accounts: ['lg2', 'chk', 'old'] }, d);
    expect(r.value.accounts.map(a => a.id)).toEqual(['chk', 'lg2', 'old']);
    expect(r.value.accounts).toEqual(expected(d).filter(a => ['chk', 'lg2', 'old'].includes(a.id)));
    expect(ask({ accounts: [] }, d).value.accounts).toEqual([]);
  });

  it('the lent hint: the terms add-tx shows for the picked loan given', () => {
    const d = data();
    for (const id of ['lg', 'lg2']) {
      const r = ask({ accounts: [id] }, d);
      expect(r.value.accounts[0].loanTerms).toEqual(lentHintTerms(d, id, () => new Date(NOW)));
    }
  });

  it('`date` is the day of the rate, the terms and the schedule', () => {
    const d = data();
    const later = at(2026, 12, 2);
    const r = ask({ date: '2026-12-02' }, d);
    const rows = Object.fromEntries(r.value.accounts.map(a => [a.id, a]));
    expect(rows.mtg.rate).toBe(cardRate(d.accounts[2], later));
    expect(rows.mtg.rate).toBe(3.5);
    expect(rows.lg2.loanTerms).toEqual(loanGivenTerms(d.accounts[5], d.transactions, later));
    expect(rows.mtg.repayment).toEqual(repaymentShape(loanRepayment(d.accounts[2], { budgetItems: d.budgetItems, transactions: d.transactions, today: later, country: 'FI' })));
  });

  it('the country of the budget dates the loan payments', () => {
    const d = data({ meta: { country: 'SE' } });
    const r = ask({ accounts: ['mtg'] }, d);
    expect(r.value.accounts[0].repayment).toEqual(repaymentShape(pageLoanLines(d.accounts[2], d, () => new Date(NOW)).loanRepayment));
  });

  it('refuses a horizon without the forecast lens, and an unknown account', () => {
    expect(ask({ lens: 'booked', horizon: '3m' }, data()).error.code).toBe('bad_input');
    expect(ask({ accounts: ['nope'] }, data()).error.code).toBe('bad_input');
  });

  it('an empty budget answers an empty list', () => {
    const r = ask({}, deepFreeze({ meta: {}, accounts: [], envelopes: [], budgetItems: [], envelopeTemplates: [], transactions: [] }));
    expect(r.ok).toBe(true);
    expect(r.value.accounts).toEqual([]);
  });
});

it('estimates interest using the full-balance rate at the exact boundary', () => {
  const d = data({ accounts: [{ id: 'sav', name: 'Danske', type: 'savings', initialBalance: 10000,
    interestTierMode: 'full-balance', interestTiers: [{ upTo: 10000, rate: 1 }, { rate: 2 }] }], transactions: [] });
  expect(ask({}, d).value.accounts[0].estInterest).toBe(200);
});
