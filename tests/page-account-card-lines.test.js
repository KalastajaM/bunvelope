// @vitest-environment jsdom
// The account card's rate, estimated interest, loan terms and payoff lines,
// on the Accounts page and on the Detailed insights' favourite accounts. The card
// computes none of them: both pages read `accounts.detail` and pass its
// answer in. The lines must read exactly as when the card and the Accounts
// page called the engine themselves (the expected text below is built from
// the engine at the same fixed clock, as the old code did), and Detailed insights
// keeps its own difference: it passes no loan terms and no repayment, so a
// loan given there shows the yearly estimate and a loan no payoff line.
import { describe, it, expect, beforeEach, vi } from 'vitest';

// The real lens at the fixed now, as page-dashboard.test.js does: the shared
// stub's viewTxs/todayTxs ignore it.
vi.mock('../js/app.js', async () => {
  const { appStub, state, prefs, FIXED_NOW } = await import('./_fakes/pageApp.js');
  const { lensTransactions } = await import('../js/engine/lens.js');
  const source = (o) => (o ? { ...state, transactions: o } : state);
  return {
    ...appStub,
    viewTxs: (o) => lensTransactions(source(o), { lens: prefs.lens ?? 'booked', horizon: prefs.lensHorizon, today: new Date(FIXED_NOW) }),
    todayTxs: (o) => lensTransactions(source(o), { lens: 'today', today: new Date(FIXED_NOW) }),
  };
});

import { render as renderAccounts } from '../js/pages/accounts.js';
import { renderDetailedInsights } from '../js/pages/dashboard.js';
import { accountCard } from '../js/ui/account-card.js';
import { loanPayoffLine } from '../js/ui/loan-schedule-sheet.js';
import { computeAccountBalances, computeAnnualInterest, loanRateOn, loanGivenTerms, loanRepayment, lensTransactions } from '../js/engine.js';
import { t, fmtDateLang } from '../js/ui/i18n.js';
import { fmt } from '../js/utils.js';
import { state, prefs, session, resetState, mountHosts, flush, FIXED_NOW } from './_fakes/pageApp.js';
import { stubResizeObserver } from './_fakes/resizeObserver.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const everyMonth = Object.fromEntries(MONTHS.map(m => [m, true]));
const loanItem = (over) => ({
  id: 'mortgage', kind: 'loan_payment', description: 'Home loan', envelope_id: 'rent', account_id: 'chk', to_account_id: 'mtg',
  default_amount: -474.21, monthly_schedule: everyMonth, payment_day: 5, as_schedule: true, as_schedule_since: '2026-10-01',
  include: true, schedule_day_type: 'exact', loan_method: 'annuity', loan_end: '2051-09', ...over,
});

function fixture() {
  state.accounts = [
    { id: 'chk', name: 'Checking', type: 'bank', initialBalance: 1000, favorite: true },
    { id: 'sav', name: 'Savings', type: 'savings', initialBalance: 5000, favorite: true, interestTiers: [{ upTo: 1000, rate: 1 }, { upTo: null, rate: 2.5 }] },
    { id: 'mtg', name: 'Mortgage', type: 'loan', initialBalance: -100000, favorite: true, interestRates: [{ from: '2020-01-01', rate: 3 }, { from: '2026-11-01', rate: 3.5 }] },
    { id: 'car', name: 'Car loan', type: 'loan', initialBalance: -8000, interestTiers: [{ rate: 4.9 }] },
    { id: 'lg', name: 'Loan to Sam', type: 'loan_given', initialBalance: 0, favorite: true, loanStart: '2026-03-01', loanEnd: '2028-02-29', interestPayout: 'yearly', interestRates: [{ from: '2026-03-01', rate: 4 }] },
    { id: 'lg2', name: 'Loan to Kim', type: 'loan_given', initialBalance: 0, favorite: true, loanStart: '2026-06-01', interestPayout: 'quarterly', interestTiers: [{ rate: 3 }] },
  ];
  state.transactions = [
    { id: 'i1', type: 'income', date: '2026-08-01', payee: 'Job', amount: 5000, account: 'chk', status: 'posted' },
    { id: 't1', type: 'account_transfer', date: '2026-03-01', amount: 2000, from_account: 'chk', to_account: 'lg', status: 'posted' },
    { id: 't2', type: 'account_transfer', date: '2026-06-01', amount: 1500, from_account: 'chk', to_account: 'lg2', status: 'posted' },
    { id: 't3', type: 'account_transfer', date: '2026-09-20', amount: 300, from_account: 'chk', to_account: 'sav', status: 'scheduled' },
  ];
  state.budgetItems = [
    loanItem(),
    loanItem({ id: 'car1', description: 'Car A', to_account_id: 'car', default_amount: -200, loan_method: 'fixed_payment', loan_end: undefined }),
    loanItem({ id: 'car2', description: 'Car B', to_account_id: 'car', default_amount: -100, loan_method: 'fixed_payment', loan_end: undefined }),
  ];
}

// ── The lines as the old code wrote them (engine at the fixed clock) ────────
const appNow = () => new Date(FIXED_NOW);
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const todayBal = (id) => computeAccountBalances(state.accounts, lensTransactions(state, { lens: 'today', today: appNow() })).get(id);
const acct = (id) => state.accounts.find(a => a.id === id);
const rateLine = (id) => t('accountCard.loanRate')(loanRateOn(acct(id), ymd(appNow())));
const estLine = (id) => t('accountCard.estInterest')(fmt(computeAnnualInterest(todayBal(id), acct(id).interestTiers)));
const termsLines = (id) => {
  const terms = loanGivenTerms(acct(id), state.transactions, appNow());
  const out = [];
  if (terms.dueDate && terms.atDue > 0) out.push(t('accountCard.interestDue')(fmtDateLang(terms.dueDate), fmt(terms.atDue), fmt(terms.accrued)));
  if (terms.end && terms.owed > 0) out.push(t('accountCard.dueBack')(fmtDateLang(terms.end)));
  return out;
};
const payoffLine = (id) => loanPayoffLine(loanRepayment(acct(id), { budgetItems: state.budgetItems, transactions: state.transactions, today: appNow(), country: 'FI' }));

// The card's secondary lines (everything under the headline except the upcoming hint).
const lines = (card) => [...card.querySelectorAll('.account-details > .sub:not(.env-upcoming)')].map(e => e.textContent);
const accountsCard = (id) => document.querySelector(`#app-root [data-acc-id="${id}"]`);

async function openAccounts() {
  mountHosts();
  await renderAccounts(document.getElementById('app-root'));
  await flush();
}
async function openInsights() {
  mountHosts();
  await renderDetailedInsights(document.getElementById('app-root'));
  await flush();
}
const insightsTile = (name) => {
  const card = [...document.querySelectorAll('.card')].find(c => c.querySelector(':scope > .card-title h3')?.textContent === t('dashboard.accountsTitle'));
  return [...card.querySelectorAll('.env-grid > *')].find(el => el.querySelector('.env-name').textContent === name);
};

beforeEach(() => {
  vi.restoreAllMocks();
  vi.stubGlobal('requestAnimationFrame', (cb) => setTimeout(cb, 0));
  stubResizeObserver();
  resetState();
  fixture();
});

describe('Accounts page: the card lines read accounts.detail', () => {
  it.each(['cards', 'list'])('renders the query portfolio value in %s view without recomputing it', async (view) => {
    state.accounts.push({ id: 'broker', name: 'Broker', type: 'investment' });
    prefs.acctView = view;
    const real = session.query.bind(session);
    vi.spyOn(session, 'query').mockImplementation((name, input) => {
      const r = real(name, input);
      if (name === 'accounts.detail' && r.ok) {
        return { ...r, value: { ...r.value, accounts: r.value.accounts.map(a => a.id === 'broker' ? { ...a, portfolioValue: 123.45 } : a) } };
      }
      return r;
    });
    await openAccounts();
    expect(accountsCard('broker').textContent).toContain(t('accountCard.portfolioValue')(fmt(123.45)));
  });

  it('does not calculate a portfolio fallback after query failure', async () => {
    state.accounts.push({ id: 'broker', name: 'Broker', type: 'investment' });
    const real = session.query.bind(session);
    vi.spyOn(session, 'query').mockImplementation((name, input) => name === 'accounts.detail'
      ? { ok: false, error: { code: 'bad_input', params: {} } } : real(name, input));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await openAccounts();
    expect(accountsCard('broker').textContent).not.toContain(t('accountCard.portfolioValue')(fmt(0)));
  });

  it('asks accounts.detail once, for the accounts it can show, through the active lens and today', async () => {
    const spy = vi.spyOn(session, 'query');
    prefs.lens = 'forecast'; prefs.lensHorizon = '3m';
    await openAccounts();
    const calls = spy.mock.calls.filter(c => c[0] === 'accounts.detail');
    expect(calls).toEqual([['accounts.detail', { lens: 'forecast', horizon: '3m', date: '2026-09-15', accounts: ['chk', 'sav', 'mtg', 'car', 'lg', 'lg2'] }]]);
    // A search repaints from the same answer.
    const search = document.querySelector('.search input');
    search.value = 'loan';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    expect(spy.mock.calls.filter(c => c[0] === 'accounts.detail')).toHaveLength(1);
  });

  it('a loan: its rate today and its payoff', async () => {
    await openAccounts();
    expect(lines(accountsCard('mtg'))).toEqual([rateLine('mtg'), payoffLine('mtg')]);
    expect(rateLine('mtg')).toBe(t('accountCard.loanRate')(3));
    // The schedule button opens what the answer carries.
    expect(accountsCard('mtg').querySelector(`button[aria-label="${t('loanSchedule.title')}"]`)).not.toBeNull();
  });

  it('a loan with legacy tiers paid by two items: the tiers\' rate and "shared"', async () => {
    await openAccounts();
    expect(lines(accountsCard('car'))).toEqual([rateLine('car'), payoffLine('car')]);
    expect(payoffLine('car')).toBe(t('loanSchedule.shared'));
    expect(accountsCard('car').querySelector(`button[aria-label="${t('loanSchedule.title')}"]`)).toBeNull();
  });

  it('a loan given: its rate and its terms, in place of an estimate', async () => {
    await openAccounts();
    expect(lines(accountsCard('lg'))).toEqual([rateLine('lg'), ...termsLines('lg')]);
    expect(termsLines('lg')).toHaveLength(2);
    expect(lines(accountsCard('lg2'))).toEqual([rateLine('lg2'), ...termsLines('lg2')]);
  });

  it('a savings account with tiers: the estimate on the Today balance, no rate', async () => {
    await openAccounts();
    expect(lines(accountsCard('sav'))).toEqual([estLine('sav')]);
    expect(estLine('sav')).toBe(t('accountCard.estInterest')(fmt(110)));
    expect(lines(accountsCard('chk'))).toEqual([]);
  });

  it('the schedule panel opens from the answer\'s repayment', async () => {
    await openAccounts();
    accountsCard('mtg').querySelector(`button[aria-label="${t('loanSchedule.title')}"]`).click();
    await flush();
    const sheet = document.querySelector('#sheet-host .sheet');
    expect(sheet.textContent).toContain(t('loanSchedule.titleFor')('Mortgage'));
    expect(sheet.textContent).toContain(t('loanSchedule.note')('Home loan'));
    expect(sheet.querySelectorAll('tbody tr:not(.loan-schedule-year)').length).toBe(300);
  });
});

describe('Dashboard favourites: the same card, without loan terms or repayment', () => {
  it('renders the query portfolio value, including an empty tracked portfolio', async () => {
    state.accounts.push({ id: 'broker', name: 'Broker', type: 'investment', favorite: true });
    const real = session.query.bind(session);
    let value = 123.45;
    vi.spyOn(session, 'query').mockImplementation((name, input) => {
      const r = real(name, input);
      if (name === 'accounts.detail' && r.ok) {
        return { ...r, value: { ...r.value, accounts: r.value.accounts.map(a => a.id === 'broker' ? { ...a, portfolioValue: value } : a) } };
      }
      return r;
    });
    await openInsights();
    expect(lines(insightsTile('Broker'))).toContain(t('accountCard.portfolioValue')(fmt(123.45)));
    value = 0;
    await openInsights();
    expect(lines(insightsTile('Broker'))).toContain(t('accountCard.portfolioValue')(fmt(0)));
  });

  it('asks accounts.detail for the favourites through the lens', async () => {
    const spy = vi.spyOn(session, 'query');
    await openInsights();
    const calls = spy.mock.calls.filter(c => c[0] === 'accounts.detail');
    expect(calls).toEqual([['accounts.detail', { lens: 'booked', date: '2026-09-15', repayment: false, accounts: ['chk', 'sav', 'mtg', 'lg', 'lg2'] }]]);
  });

  it('rates and estimates; a loan given keeps the estimate branch, a loan has no payoff line', async () => {
    await openInsights();
    expect(lines(insightsTile('Checking'))).toEqual([]);
    expect(lines(insightsTile('Savings'))).toEqual([estLine('sav')]);
    expect(lines(insightsTile('Mortgage'))).toEqual([rateLine('mtg')]);
    expect(lines(insightsTile('Loan to Sam'))).toEqual([rateLine('lg')]);
    // Kim's loan has legacy tiers: with no terms passed, the yearly estimate shows.
    expect(lines(insightsTile('Loan to Kim'))).toEqual([rateLine('lg2'), estLine('lg2')]);
    expect(estLine('lg2')).toBe(t('accountCard.estInterest')(fmt(45)));
  });
});

describe('accountCard computes nothing', () => {
  it('shows the rate, estimate, terms and repayment it is given', () => {
    const account = { id: 'x', name: 'Plain', type: 'loan_given' };
    const card = accountCard({
      account, currentBalance: 10, budgetBalance: 10, rate: 7.25,
      loanTerms: { start: '2026-01-01', end: '2027-01-01', cycleStart: '2026-01-01', dueDate: '2027-01-01', owed: 10, accrued: 1.5, atDue: 2.25 },
    });
    expect(lines(card)).toEqual([
      t('accountCard.loanRate')(7.25),
      t('accountCard.interestDue')(fmtDateLang('2027-01-01'), fmt(2.25), fmt(1.5)),
      t('accountCard.dueBack')(fmtDateLang('2027-01-01')),
    ]);
    const plain = accountCard({ account: { id: 'y', name: 'Box', type: 'savings' }, currentBalance: 10, budgetBalance: 10, estInterest: 12.34 });
    expect(lines(plain)).toEqual([t('accountCard.estInterest')(fmt(12.34))]);
    const loan = accountCard({ account: { id: 'z', name: 'Loan', type: 'loan' }, currentBalance: -5, budgetBalance: -5, repayment: { status: 'shared', count: 2 } });
    expect(lines(loan)).toEqual([t('loanSchedule.shared')]);
  });

  it('no rate, no estimate, nothing given: no lines', () => {
    const card = accountCard({ account: { id: 'x', name: 'Loan', type: 'loan', interestRates: [{ from: '2020-01-01', rate: 3 }], interestTiers: [{ rate: 2 }] }, currentBalance: 100, budgetBalance: 100 });
    expect(lines(card)).toEqual([]);
  });

  it('a failed accounts.detail drops the favourites card, the rest of the Dashboard stays', async () => {
    const real = session.query.bind(session);
    vi.spyOn(session, 'query').mockImplementation((name, input) => (
      name === 'accounts.detail' ? { ok: false, error: { code: 'bad_input', params: {} } } : real(name, input)));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await openInsights();
    const titles = [...document.querySelectorAll('.card > .card-title h3')].map(h => h.textContent);
    expect(titles).not.toContain(t('dashboard.accountsTitle'));
    expect(titles.length).toBeGreaterThan(0);
  });
});
