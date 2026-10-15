// @vitest-environment jsdom
// Dashboard: the figures a small known ledger must produce (unallocated, what
// is assigned, spent this month against the plan, the balance / net worth /
// Age of Money tiles, the annual plan card, the upcoming and recent lists),
// and where its cards send the user. The page is read-only: every number is
// asserted on the rendered text for a ledger worked out by hand below, never
// as a snapshot. The only write path it owns is the hero's "assign" button,
// which opens the fill sheet (that sheet's writes are page-fill-envelopes).
//
// The stubbed app.js fixes "now" at 15 Sep 2026 and the lens at Budget.
//
// Ledger (chk opens at 1000, sav at 500; envelopes food / fun / rent):
//   1 Aug  income  2000 to chk, no envelope
//   2 Aug  fill    food +300, fun +100, rent +700
//   20 Aug expense  20 Cafe (food)          <- last month
//   5 Sep  expense  80 Supermarket (food)   <- this month
//   12 Sep expense  30 Cinema (fun)         <- this month
//   2 Oct  expense  40 Dentist (fun), scheduled, future-dated
// Plan: Salary 3000/mo income, Groceries 100/mo on food, and an
// "Internet" 25/mo item scheduled on chk from the 20th.
//
// Worked out:
//   chk = 1000 + 2000 - 20 - 80 - 30 - 40 = 2830; sav = 500; total 3330
//   envelopes: food 300-20-80 = 200, fun 100-30-40 = 30, rent 700 -> 930
//   unallocated = 3330 - 930 = 2400 (= 1500 opening + 2000 - 1100 filled)
//   assigned share = round(930 / 3330) = 28%
//   spent this month = 80 + 30 = 110; planned per month = 100 + 25 = 125
//   Age of Money: one 2000 lot from 1 Aug funds 20 (19 days old), 80 (35)
//     and 30 (42): (20*19 + 80*35 + 30*42) / 130 = 34.2 -> 34 days
//   annual plan: income 36000, budget 1200 + 300 = 1500, surplus 34500
import { describe, it, expect, beforeEach, vi } from 'vitest';

// The Dashboard's cards read their figures from queries (the session stub in
// _fakes/pageApp.js), not from viewTxs / todayTxs. Those two are still read
// by the Fill sheet the hero's assign button opens, and the shared stub's
// ignore the lens (always Booked, and a date-only Today), so this file gives
// them the real lens at the fixed now: the sheet sees what the app would.
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

import { openOverviewEnvelope } from '../js/pages/dashboard-workspace.js';
import { beginBudgetSession } from '../js/state/budget-session.js';
import { render, renderDetailedInsights } from '../js/pages/dashboard.js';
import { t, langLocale, fmtDateLang } from '../js/ui/i18n.js';
import { fmt, fmtPct } from '../js/utils.js';
import { state, prefs, session, writeBatch, navigate, resetState, mountHosts, flush, sheetIsOpen } from './_fakes/pageApp.js';
import { stubResizeObserver, resizeCharts } from './_fakes/resizeObserver.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const every = () => Object.fromEntries(MONTHS.map(m => [m, true]));

const ledger = () => [
  { id: 'i1', type: 'income', date: '2026-08-01', payee: 'Job', amount: 2000, account: 'chk', status: 'posted' },
  { id: 'f1', type: 'fill', date: '2026-08-02', status: 'posted', source: 'allocation',
    lines: [{ envelope_id: 'food', mode: 'add', amount: 300 }, { envelope_id: 'fun', mode: 'add', amount: 100 }, { envelope_id: 'rent', mode: 'add', amount: 700 }] },
  { id: 'e0', type: 'expense', date: '2026-08-20', payee: 'Cafe', amount: 20, account: 'chk', envelope_id: 'food', status: 'posted' },
  { id: 'e1', type: 'expense', date: '2026-09-05', payee: 'Supermarket', amount: 80, account: 'chk', envelope_id: 'food', status: 'posted' },
  { id: 'e2', type: 'expense', date: '2026-09-12', payee: 'Cinema', amount: 30, account: 'chk', envelope_id: 'fun', status: 'posted' },
  { id: 'e3', type: 'expense', date: '2026-10-02', payee: 'Dentist', amount: 40, account: 'chk', envelope_id: 'fun', status: 'scheduled' },
];

const plan = () => [
  { id: 'sal', kind: 'income', envelope_id: null, description: 'Salary', default_amount: 3000, extra_buffer: 0, include: true, monthly_schedule: every(), as_schedule: false },
  { id: 'groc', kind: 'expense', envelope_id: 'food', description: 'Groceries', default_amount: -100, extra_buffer: 0, include: true, monthly_schedule: every(), as_schedule: false },
  { id: 'net', kind: 'expense', envelope_id: 'fun', description: 'Internet', default_amount: -25, extra_buffer: 0, include: true, monthly_schedule: every(),
    as_schedule: true, account_id: 'chk', payment_day: 20, schedule_day_type: 'exact', as_schedule_since: '2026-01-01' },
];

// moneyEl and fmt print the same figure with different spacing after the currency sign.
const has = (text, figure) => text.replace(/\s/g, '').includes(figure.replace(/\s/g, ''));
const kpiByLabel = (label) => [...document.querySelectorAll('.kpi')].find(k => k.querySelector('.lbl').textContent === label);
const kpiVal = (label) => kpiByLabel(label).querySelector('.val').textContent;
const kpiSub = (label) => kpiByLabel(label).querySelector('.sub').textContent;
const metaVals = (card) => [...card.querySelectorAll('.hero-meta-val')].map(e => e.textContent);
const cardWithTitle = (title) => [...document.querySelectorAll('.card')].find(c => c.querySelector(':scope > .card-title h3')?.textContent === title);
const rowNames = (card) => [...card.querySelectorAll('.dash-scroll-list > div')].map(r => r.children[1].children[0].textContent);

async function openPage() {
  mountHosts();
  // Mount both destinations to retain the shared ledger assertions below.
  await render(document.getElementById('app-root'));
  await renderDetailedInsights(document.getElementById('app-root'));
  await flush();
}

beforeEach(async () => {
  vi.stubGlobal('requestAnimationFrame', (cb) => setTimeout(cb, 0));
  stubResizeObserver();
  resetState({ transactions: ledger() });
  state.budgetItems = plan();
  navigate.mockClear();
});

describe('hero: what is left to assign', () => {
  beforeEach(openPage);

  it('reports the unallocated amount, assigned total, account total and share', () => {
    const hero = document.querySelector('.hero-card:not(.bp-annual-card)');
    expect(hero.classList.contains('is-assign')).toBe(true);
    expect(hero.querySelector('.hero-label').textContent).toBe(t('overview.poolBasis')(t('lens.booked')));
    expect(metaVals(hero)).toEqual([fmt(930), fmt(3330)]);
    expect(hero.querySelector('.hero-meta-pct').textContent).toBe(t('dashboard.heroPctOfBalance')(28));
    expect(hero.querySelector('.hero-action').textContent).toBe(t('overview.assignAction'));
  });

  it('the assign button opens the fill sheet', async () => {
    document.querySelector('.hero-card:not(.bp-annual-card) .hero-action').click();
    await flush();
    expect(sheetIsOpen()).toBe(true);
  });
});

describe('hero states', () => {
  it('a budget with every euro assigned reads balanced and offers no assign button', async () => {
    state.transactions = [
      ...ledger(),
      { id: 'f2', type: 'fill', date: '2026-08-03', status: 'posted', source: 'allocation', lines: [{ envelope_id: 'food', mode: 'add', amount: 2400 }] },
    ];
    await openPage();
    const hero = document.querySelector('.hero-card:not(.bp-annual-card)');
    expect(hero.classList.contains('is-balanced')).toBe(true);
    expect(hero.querySelector('.hero-label').textContent).toBe(t('overview.poolBasis')(t('lens.booked')));
    expect(hero.querySelector('.hero-action')).toBeNull();
  });

  it('envelopes holding more than the accounts do read over-assigned, with an unassign button', async () => {
    state.transactions = [
      ...ledger(),
      { id: 'f2', type: 'fill', date: '2026-08-03', status: 'posted', source: 'allocation', lines: [{ envelope_id: 'food', mode: 'add', amount: 2500 }] },
    ];
    await openPage();
    const hero = document.querySelector('.hero-card:not(.bp-annual-card)');
    expect(hero.classList.contains('is-over')).toBe(true);
    expect(hero.querySelector('.hero-label').textContent).toBe(t('overview.poolBasis')(t('lens.booked')));
    expect(has(hero.querySelector('.hero-val').textContent, fmt(-100))).toBe(true);
    expect(hero.querySelector('.hero-action').textContent).toBe(t('overview.returnAction'));
  });
});

describe('annual plan card', () => {
  beforeEach(openPage);

  it('shows the yearly surplus, income and budget, and coverage of income', () => {
    const card = document.querySelector('.bp-annual-card');
    expect(card.classList.contains('is-assign')).toBe(true);
    expect(card.querySelector('.hero-label').textContent).toBe(t('dashboard.annualSurplus'));
    expect(metaVals(card)).toEqual([fmt(36000), fmt(1500)]);
    expect(card.querySelector('.hero-meta-pct').textContent).toBe(t('dashboard.coverageOfIncome')(4));
    expect(has(card.textContent, fmt(34500))).toBe(true);
  });

  it('clicking the card or its button goes to the budget plan', () => {
    document.querySelector('.bp-annual-card .hero-action').click();
    expect(navigate).toHaveBeenCalledWith('budget-plan');
    navigate.mockClear();
    document.querySelector('.bp-annual-card').click();
    expect(navigate).toHaveBeenCalledWith('budget-plan');
  });

  it('is absent when the plan has nothing included', async () => {
    state.budgetItems = [];
    await openPage();
    expect(document.querySelector('.bp-annual-card')).toBeNull();
  });

  it('a plan that spends more than it earns reads as a deficit', async () => {
    state.budgetItems = [plan()[1]];
    await openPage();
    const card = document.querySelector('.bp-annual-card');
    expect(card.classList.contains('is-over')).toBe(true);
    expect(card.querySelector('.hero-label').textContent).toBe(t('dashboard.annualDeficit'));
    expect(has(card.textContent, fmt(1200))).toBe(true);
  });
});

describe('KPI tiles', () => {
  beforeEach(openPage);

  it('spent this month counts this month only, against the monthly plan', () => {
    expect(has(kpiVal(t('dashboard.kpi.spent')), fmt(110))).toBe(true);
    // 110 of a 125 plan is 88%; 15 days remain in September.
    expect(kpiSub(t('dashboard.kpi.spent'))).toBe(t('dashboard.kpiSpentSub')(88, 15));
  });

  it('spending balance is the checking total, and says how much has not cleared yet', () => {
    expect(has(kpiVal(t('dashboard.kpi.balance')), fmt(2830))).toBe(true);
    // The 40 scheduled dentist visit is in the Budget view but not yet in the bank.
    expect(kpiSub(t('dashboard.kpi.balance'))).toContain(t('dashboard.inclNotYetCleared')(fmt(-40, { signed: true, decimals: 0 })));
  });

  it('net worth is every account, broken down by kind', () => {
    expect(has(kpiVal(t('dashboard.kpi.netWorth')), fmt(3330))).toBe(true);
    const parts = t('dashboard.netWorthParts');
    const sub = kpiSub(t('dashboard.kpi.netWorth'));
    expect(sub).toContain(`${parts.spending} ${fmt(2830, { decimals: 0 })}`);
    expect(sub).toContain(`${parts.savings} ${fmt(500, { decimals: 0 })}`);
  });

  it('Age of Money is the FIFO-weighted age of what was spent in the last 30 days', () => {
    const tile = kpiByLabel(t('dashboard.aomLabel'));
    expect(tile.querySelector('.val span').textContent).toBe('34');
    expect(tile.querySelector('.chip')).toBeTruthy();
  });

  it('the Age of Money sheet charts the trend, a month without data as a gap, not 0 days', async () => {
    kpiByLabel(t('dashboard.aomLabel')).click();
    await flush();
    const chart = document.querySelector('.bv-chart--bar');
    expect(chart).toBeTruthy();
    [...chart.querySelectorAll('.bv-chart-toolbar button')].find(b => b.textContent === t('chart.table')).click();
    const values = [...chart.querySelectorAll('tbody tr td')].map(td => td.textContent);
    // The history samples month-ends, so its last bar need not equal the tile.
    expect(values.at(-1)).toMatch(new RegExp(`^[1-9]\\d*${t('dashboard.daysSuffix')}$`));
    expect(values).toContain('—');
    expect(values).not.toContain(`0${t('dashboard.daysSuffix')}`);
  });

  // July's income pays August's expense 40 days later; September's pays
  // September's 10 days later: the September month-end sample falls by 30
  // days, all of it one expense.
  const dropLedger = (payee) => [
    { id: 'j1', type: 'income', date: '2026-07-01', payee: 'Job', amount: 100, account: 'chk', status: 'posted' },
    { id: 'x1', type: 'expense', date: '2026-08-10', payee: 'Shop', amount: 100, account: 'chk', envelope_id: 'food', status: 'posted' },
    { id: 'j2', type: 'income', date: '2026-09-01', payee: 'Job', amount: 100, account: 'chk', status: 'posted' },
    { id: 'x2', type: 'expense', date: '2026-09-11', ...(payee ? { payee } : {}), amount: 100, account: 'chk', envelope_id: 'food', status: 'posted' },
  ];
  const dropText = (payee) => t('dashboard.aomAnomalyBigExpense')({
    monthLabel: new Date(2026, 8, 1).toLocaleDateString(langLocale(), { month: 'short', year: 'numeric' }),
    drop: 30, amount: fmt(100, { decimals: 0 }), ageDays: 10, payee,
  });

  it('the Age of Money sheet explains a drop by the one big expense behind it, with its payee', async () => {
    state.transactions = dropLedger('Garage');
    await openPage();
    kpiByLabel(t('dashboard.aomLabel')).click();
    await flush();
    const items = [...document.querySelectorAll('.aom-anomaly-list .aom-anomaly-item')];
    expect(items).toHaveLength(1);
    expect(items[0].classList.contains('aom-anomaly-item--big_expense')).toBe(true);
    expect(items[0].textContent).toBe(dropText('Garage'));
  });

  it('a big expense without a payee is named with a dash', async () => {
    state.transactions = dropLedger(null);
    await openPage();
    kpiByLabel(t('dashboard.aomLabel')).click();
    await flush();
    const items = [...document.querySelectorAll('.aom-anomaly-list .aom-anomaly-item')];
    expect(items.map(i => i.textContent)).toEqual([dropText('—')]);
  });

  it('a history without a drop says so', async () => {
    kpiByLabel(t('dashboard.aomLabel')).click();
    await flush();
    expect(document.querySelector('.aom-anomaly-item')).toBeNull();
    expect(document.querySelector('.aom-anomaly-list').textContent).toBe(t('dashboard.aomAnomalyEmpty'));
  });

  it('the tiles send the user to their pages', () => {
    kpiByLabel(t('dashboard.kpi.spent')).click();
    expect(navigate).toHaveBeenLastCalledWith('transactions', 'month:2026-09');
    kpiByLabel(t('dashboard.kpi.balance')).click();
    expect(navigate).toHaveBeenLastCalledWith('accounts');
    kpiByLabel(t('dashboard.kpi.netWorth')).click();
    expect(navigate).toHaveBeenLastCalledWith('accounts');
  });

  // Owner decision 2026-10-05: green only when the runway agrees.
  it('old money next to a short runway is not rated healthy, and the sheet says why', async () => {
    // 2800 moved to savings leaves the spending accounts a runway of 16 days.
    state.transactions = [...ledger(),
      { id: 'mv', type: 'account_transfer', date: '2026-09-13', amount: 2800, from_account: 'chk', to_account: 'sav', status: 'posted' }];
    await openPage();
    const tile = kpiByLabel(t('dashboard.aomLabel'));
    expect(tile.querySelector('.val span').textContent).toBe('34');
    expect(tile.querySelector('.chip').className).toContain('chip--health-yellow');
    tile.click();
    await flush();
    expect(document.querySelector('.sheet').textContent).toContain(t('dashboard.aomRunway')(16));
    expect(document.querySelector('.sheet').textContent).toContain(t('dashboard.aomRunwayLimited')(16));
  });

  it('a healthy rating with a long runway carries no runway note', async () => {
    const tile = kpiByLabel(t('dashboard.aomLabel'));
    expect(tile.querySelector('.chip').className).toContain('chip--health-green');
    tile.click();
    await flush();
    expect(document.querySelector('.sheet').textContent).not.toContain(t('dashboard.aomRunwayLimited')(0).slice(0, 12));
    expect(document.querySelector('.sheet').textContent).not.toContain(t('dashboard.aomOneOffsTitle'));
  });

  it('the sheet lists the one-off income left out of the figure', async () => {
    const pay = (id, date) => ({ id, type: 'income', date, payee: 'Job', amount: 2000, account: 'chk', status: 'posted' });
    state.transactions = [...ledger(), pay('m5', '2026-05-01'), pay('m6', '2026-06-01'), pay('m7', '2026-07-01'),
      { id: 'sale', type: 'income', date: '2026-08-15', payee: 'Shares', amount: 50000, account: 'chk', status: 'posted' }];
    await openPage();
    kpiByLabel(t('dashboard.aomLabel')).click();
    await flush();
    const text = document.querySelector('.sheet').textContent;
    expect(text).toContain(t('dashboard.aomOneOffsTitle'));
    expect(text).toContain(`Shares · ${fmt(50000, { decimals: 0 })} · ${fmtDateLang('2026-08-15')}`);
  });

  it('with no income before the spending there is no Age of Money tile', async () => {
    state.transactions = ledger().filter(tx => tx.type !== 'income');
    await openPage();
    expect(kpiByLabel(t('dashboard.aomLabel'))).toBeUndefined();
  });
});

describe('KPI tiles: scopes, P/L and the lens', () => {
  const netWorthSubs = () => [...kpiByLabel(t('dashboard.kpi.netWorth')).querySelectorAll('.sub')].map(e => e.textContent);

  it('without a priced holding there is no P/L line', async () => {
    await openPage();
    expect(netWorthSubs()).toHaveLength(1);
  });

  it('the P/L line is the unrealized gain of the tracked holdings at their last price', async () => {
    // 7 units bought for 300, priced at 45.123: worth 315.861, a gain of
    // 15.861 (+5.29% of the cost).
    state.accounts = [...state.accounts, { id: 'inv', name: 'Broker', type: 'investment', initialBalance: 0 }];
    state.transactions = [
      ...ledger(),
      { id: 'b1', type: 'investment_transfer', direction: 'buy', date: '2026-08-15', payee: 'Broker', amount: 300, units: 7, symbol: 'ABC', from_account: 'chk', to_account: 'inv', status: 'posted' },
    ];
    state.meta = { investments: { prices: { ABC: { price: 45.123, asOf: '2026-09-14' } } } };
    await openPage();
    const subs = netWorthSubs();
    expect(subs).toHaveLength(2);
    expect(subs[1]).toBe(t('dashboard.kpiSavingsPl')(`+${fmt(15.86)}`, fmtPct(5.29, { signed: true })));
  });

  it('an archived spending account is out of the balance headline and month-end bars, but in the hero\'s account total', async () => {
    state.accounts = [...state.accounts, { id: 'old', name: 'Old checking', type: 'bank', initialBalance: 100, archived: true }];
    await openPage();
    // Headline: the non-archived spending accounts, as before (2830).
    expect(has(kpiVal(t('dashboard.kpi.balance')), fmt(2830))).toBe(true);
    // The bars: active spending accounts only. September has 2870 posted.
    const bars = [...kpiByLabel(t('dashboard.kpi.balance')).querySelectorAll('.spark-bar')];
    expect(bars).toHaveLength(6);
    expect(bars.at(-1).title.endsWith(fmt(2870, { decimals: 0 }))).toBe(true);
    expect(bars.at(-2).title.endsWith(fmt(2980, { decimals: 0 }))).toBe(true);
    // Net worth skips archived accounts; the hero's identity counts them.
    expect(has(kpiVal(t('dashboard.kpi.netWorth')), fmt(3330))).toBe(true);
    const hero = document.querySelector('.hero-card:not(.bp-annual-card)');
    expect(metaVals(hero)).toEqual([fmt(930), fmt(3430)]);
  });

  it('under the Forecast view the figures follow it through the horizon', async () => {
    // Through 30 Sep: the 2 Oct dentist is past the horizon, and the plan
    // adds Internet 25 on the 20th and the rest of Groceries (100 - 80 = 20)
    // at the month end. chk 2870 - 45 = 2825; envelopes food 180, fun 45,
    // rent 700 = 925; unallocated stays 2400.
    prefs.lens = 'forecast';
    prefs.lensHorizon = 'eom';
    await openPage();
    const hero = document.querySelector('.hero-card:not(.bp-annual-card)');
    expect(hero.querySelector('.hero-label').textContent).toBe(t('overview.poolBasis')(t('lens.forecast')));
    expect(metaVals(hero)).toEqual([fmt(925), fmt(3325)]);
    expect(has(kpiVal(t('dashboard.kpi.balance')), fmt(2825))).toBe(true);
    expect(kpiSub(t('dashboard.kpi.balance'))).toContain(t('dashboard.inclNotYetCleared')(fmt(-45, { signed: true, decimals: 0 })));
    expect(has(kpiVal(t('dashboard.kpi.netWorth')), fmt(3325))).toBe(true);
    // Spending is what the month consumed, not the lens: still 110.
    expect(has(kpiVal(t('dashboard.kpi.spent')), fmt(110))).toBe(true);
  });
});

describe('the queries behind the figures', () => {
  it('every query gets the one date of the render, and the lens ones the active lens', async () => {
    prefs.lens = 'forecast';
    prefs.lensHorizon = 'eom';
    state.accounts = state.accounts.map(a => (a.id === 'sav' ? { ...a, favorite: true } : a));
    const spy = vi.spyOn(session, 'query');
    try {
      await openPage();
      const calls = spy.mock.calls.map(([name, input]) => ({ name, ...input }));
      const names = calls.map(c => c.name);
      for (const n of ['balances', 'spending.month', 'cash.position', 'netWorth.current', 'ageOfMoney', 'plan.annual', 'cards.due', 'spending.history', 'upcoming', 'envelopes.month']) {
        expect(names).toContain(n);
      }
      for (const n of ['balances', 'cash.position', 'netWorth.current', 'cards.due']) {
        expect(calls.find(c => c.name === n)).toMatchObject({ lens: 'forecast', horizon: 'eom' });
      }
      for (const n of ['spending.month', 'cash.position', 'ageOfMoney', 'plan.annual', 'spending.history', 'upcoming', 'envelopes.month']) {
        expect(calls.find(c => c.name === n).date).toBe('2026-09-15');
      }
      // The envelope snapshot asks for the envelopes it shows, through the lens.
      expect(calls.find(c => c.name === 'envelopes.month')).toMatchObject({ lens: 'forecast', horizon: 'eom', envelopes: ['food', 'fun', 'rent'] });
      // The favourite accounts: one accounts.detail through the lens (its
      // current balances are Today's whatever the lens).
      expect(calls.filter(c => c.name === 'accounts.detail')).toEqual([
        { name: 'accounts.detail', lens: 'forecast', horizon: 'eom', date: '2026-09-15', repayment: false, accounts: ['sav'] },
      ]);
    } finally {
      spy.mockRestore();
    }
  });

  const failing = [
    ['fails', () => ({ ok: false, error: { code: 'bad_input', params: {} } })],
    ['throws', () => { throw new Error('boom'); }],
  ];
  it.each(failing)('a query that %s leaves its card out and warns; the rest of the page renders', async (_how, impl) => {
    state.accounts = [...state.accounts, { id: 'cc', name: 'Visa', type: 'credit_card', initialBalance: 0 }];
    state.transactions = [
      ...ledger(),
      { id: 'c1', type: 'expense', date: '2026-09-10', payee: 'Shop', amount: 60, account: 'cc', envelope_id: 'fun', status: 'posted' },
    ];
    state.accounts = state.accounts.map(a => (a.id === 'sav' ? { ...a, favorite: true } : a));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const spy = vi.spyOn(session, 'query').mockImplementation(impl);
    try {
      await openPage();
      expect(document.querySelector('.hero-card')).toBeNull();
      expect(document.querySelector('.bp-annual-card')).toBeNull();
      expect(document.querySelectorAll('.kpi')).toHaveLength(0);
      expect(document.querySelector('.kpi-row')).toBeNull();
      expect(document.querySelector('.bv-chart--pie')).toBeNull();
      expect(cardWithTitle(t('dashboard.trend'))).toBeUndefined();
      expect(cardWithTitle(t('dashboard.cardsTitle'))).toBeUndefined();
      expect(cardWithTitle(t('dashboard.envelopes'))).toBeUndefined();
      expect(cardWithTitle(t('dashboard.accountsTitle'))).toBeUndefined();
      expect(cardWithTitle(t('dashboard.upcoming'))).toBeUndefined();
      // Cards that read no query still render.
      expect(rowNames(cardWithTitle(t('dashboard.recent')))).toContain('Cinema');
      expect(warn).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
      warn.mockRestore();
    }
  });
});

describe('spending trend', () => {
  it('charts the last six months of spending, oldest first, ending with this month', async () => {
    await openPage();
    resizeCharts();
    const chart = document.querySelector('.bv-chart--line');
    [...chart.querySelectorAll('.bv-chart-toolbar button')].find(b => b.textContent === t('chart.table')).click();
    const values = [...chart.querySelectorAll('tbody tr td')].map(td => td.textContent);
    // Apr-Jul nothing, Aug the 20 cafe, Sep 80 + 30; the October dentist is not in the window.
    expect(values).toEqual([0, 0, 0, 0, 20, 110].map(v => fmt(v, { decimals: 0 })));
  });

  it('a month opens its transactions', async () => {
    await openPage();
    resizeCharts();
    const chart = document.querySelector('.bv-chart--line');
    const key = (k) => chart.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
    key('End'); key('Enter');
    expect(navigate).toHaveBeenLastCalledWith('transactions', 'month:2026-09');
    key('Home'); key('Enter');
    expect(navigate).toHaveBeenLastCalledWith('transactions', 'month:2026-04');
  });
});

describe('envelopes and category spending', () => {
  beforeEach(openPage);

  it('lists the envelopes with their balances; a click opens that envelope\'s transactions', () => {
    const card = cardWithTitle(t('dashboard.envelopes'));
    const cards = [...card.querySelectorAll('.overview-envelope-row')];
    expect(cards).toHaveLength(3);
    const food = cards.find(c => c.textContent.includes('Food'));
    expect(has(food.textContent, fmt(200))).toBe(true);
    expect(has(cards.find(c => c.textContent.includes('Rent')).textContent, fmt(700))).toBe(true);
    food.querySelector('.overview-envelope-name').click();
    expect(navigate).toHaveBeenCalledWith('transactions', 'food');
  });

  it('each card has this month\'s spending against the plan, and the part of its balance not cleared yet', () => {
    const cards = [...cardWithTitle(t('dashboard.envelopes')).querySelectorAll('.overview-envelope-row')];
    const food = cards.find(c => c.textContent.includes('Food'));
    const fun = cards.find(c => c.textContent.includes('Fun'));
    expect(food.querySelector('.env-spent-line').textContent).toBe(t('envelopes.spentOfPlanned')({ spent: fmt(80), amt: fmt(100) }));
    expect(food.querySelector('.env-upcoming')).toBeNull();
    // Fun: 30 booked, 70 cleared; the scheduled Dentist (40, 2 Oct) is the difference.
    expect(fun.querySelector('.env-spent-line').textContent).toBe(t('envelopes.spentOfPlanned')({ spent: fmt(30), amt: fmt(25) }));
    expect(fun.querySelector('.env-upcoming').textContent).toBe(t('envelopes.upcomingHint')(fmt(-40, { signed: true })));
  });

  it('archived envelopes are left off; favourites, when any, are all that show', async () => {
    state.envelopes = state.envelopes.map(e => (e.id === 'rent' ? { ...e, archived: true } : e.id === 'fun' ? { ...e, favorite: true } : e));
    await openPage();
    const cards = [...cardWithTitle(t('dashboard.envelopes')).querySelectorAll('.overview-envelope-row')];
    expect(cards).toHaveLength(1);
    expect(cards[0].textContent).toContain('Fun');
  });

  it('the where-it-went card totals this month\'s spending by category', () => {
    resizeCharts();
    const card = [...document.querySelectorAll('.card')].find(c => c.querySelector('.bv-chart--pie'));
    expect(card).toBeTruthy();
    // living: food 80 + fun 30 = 110, the only category with spending this month.
    const rows = [...card.querySelectorAll('.bv-chart-item')];
    expect(rows.map(r => r.querySelector('.bv-chart-item-label').textContent)).toEqual(['living']);
    const value = rows[0].querySelector('.bv-chart-item-value').textContent;
    expect(has(value, fmt(110, { decimals: 0 }))).toBe(true);
    expect(value).toContain(fmtPct(100));
    expect(card.querySelector('.bv-chart-slice')).toBeTruthy();
  });
});

describe('category spending order', () => {
  it('lists the categories largest first', async () => {
    state.transactions = [
      ...ledger(),
      { id: 'r1', type: 'expense', date: '2026-09-03', payee: 'Landlord', amount: 200, account: 'chk', envelope_id: 'rent', status: 'posted' },
    ];
    await openPage();
    resizeCharts();
    const card = [...document.querySelectorAll('.card')].find(c => c.querySelector('.bv-chart--pie'));
    const rows = [...card.querySelectorAll('.bv-chart-item')];
    // housing 200, living 80 + 30 = 110.
    expect(rows.map(r => r.querySelector('.bv-chart-item-label').textContent)).toEqual([t('cat.housing'), 'living']);
    expect(has(rows[0].querySelector('.bv-chart-item-value').textContent, fmt(200, { decimals: 0 }))).toBe(true);
    expect(has(rows[1].querySelector('.bv-chart-item-value').textContent, fmt(110, { decimals: 0 }))).toBe(true);
  });
});

describe('upcoming and recent', () => {
  beforeEach(openPage);

  it('upcoming lists the real future row and the scheduled forecast, soonest first, without the past', () => {
    const card = cardWithTitle(t('dashboard.upcoming'));
    // 20 Sep (Internet, forecast from the plan) then 2 Oct (Dentist).
    expect(rowNames(card)).toEqual(['Internet', 'Dentist']);
    const amounts = [...card.querySelectorAll('.num-inline')].map(e => e.textContent);
    expect(amounts).toEqual([fmt(-25, { signed: true }), fmt(-40, { signed: true })]);
    expect(card.querySelector('.upcoming-row.is-forecast')).toBeTruthy();
  });

  it('an occurrence due earlier this month and not posted comes first, marked overdue', async () => {
    state.budgetItems = [...plan(), { id: 'gym', kind: 'expense', envelope_id: 'fun', description: 'Gym', default_amount: -15, extra_buffer: 0, include: true,
      monthly_schedule: every(), as_schedule: true, account_id: 'chk', payment_day: 3, schedule_day_type: 'exact', as_schedule_since: '2026-01-01' }];
    await openPage();
    const card = cardWithTitle(t('dashboard.upcoming'));
    // 3 Sep (overdue), then 20 Sep, 2 Oct and 3 Oct (next month's Gym).
    expect(rowNames(card)).toEqual(['Gym', 'Internet', 'Dentist', 'Gym']);
    const rows = [...card.querySelectorAll('.upcoming-row')];
    expect(rows.map(r => r.classList.contains('is-overdue'))).toEqual([true, false, false, false]);
    expect(rows[0].querySelector('.chip.overdue').textContent).toBe(t('transactions.chipOverdue'));
    expect(rows[0].textContent).toContain(`12 ${t('dashboard.daysShort')} ago`);
    expect(rows[0].querySelector('.num-inline').textContent).toBe(fmt(-15, { signed: true }));
    expect(rows[3].querySelector('.chip.scheduled')).toBeTruthy();
  });

  it('a scheduled fill shows its added total, muted and unsigned, with a note for the envelopes it sets', async () => {
    state.transactions = [...ledger(), {
      id: 'fs', type: 'fill', date: '2026-09-25', status: 'scheduled', source: 'allocation', payee: 'Top-up',
      lines: [{ envelope_id: 'food', mode: 'add', amount: 50 }, { envelope_id: 'fun', mode: 'set', amount: 200 }],
    }];
    await openPage();
    const card = cardWithTitle(t('dashboard.upcoming'));
    const row = [...card.querySelectorAll('.upcoming-row')].find(r => r.textContent.includes('Top-up'));
    expect(row).toBeTruthy();
    const amount = row.querySelector('.num-inline');
    // Not -0.00 (a fill has lines, not an amount), and the set line is not summed.
    expect(amount.textContent).toBe(`${fmt(50)} ${t('transactions.fillSetsNote')(1)}`);
    expect(amount.style.color).toBe('var(--muted)');
  });

  it('recent lists the last 30 days of money moving, newest first, with signed amounts', () => {
    const card = cardWithTitle(t('dashboard.recent'));
    expect(rowNames(card)).toEqual(['Cinema', 'Supermarket', 'Cafe']);
    const amounts = [...card.querySelectorAll('.num-inline')].map(e => e.textContent);
    expect(amounts).toEqual([fmt(-30, { signed: true }), fmt(-80, { signed: true }), fmt(-20, { signed: true })]);
  });

  it('recent leaves out fills and income older than 30 days', () => {
    const names = rowNames(cardWithTitle(t('dashboard.recent')));
    expect(names).not.toContain('Job');
    expect(names).toHaveLength(3);
  });

  it('an empty ledger says there is nothing upcoming or recent', async () => {
    state.transactions = [];
    state.budgetItems = [];
    await openPage();
    expect(cardWithTitle(t('dashboard.upcoming')).textContent).toContain(t('dashboard.upcomingEmpty'));
    expect(cardWithTitle(t('dashboard.recent')).textContent).toContain(t('dashboard.noRecentTx'));
  });
});

describe('credit cards and favourite accounts', () => {
  it('shows what is owed on a credit card, and the cleared part when it differs', async () => {
    state.accounts = [...state.accounts, { id: 'cc', name: 'Visa', type: 'credit_card', initialBalance: 0 }];
    state.transactions = [
      ...ledger(),
      { id: 'c1', type: 'expense', date: '2026-09-10', payee: 'Shop', amount: 60, account: 'cc', envelope_id: 'fun', status: 'posted' },
      { id: 'c2', type: 'expense', date: '2026-09-25', payee: 'Later', amount: 15, account: 'cc', envelope_id: 'fun', status: 'scheduled' },
    ];
    await openPage();
    const card = cardWithTitle(t('dashboard.cardsTitle'));
    expect(card).toBeTruthy();
    expect(card.textContent).toContain('Visa');
    expect(has(card.textContent, fmt(75))).toBe(true);
    // 60 posted, 15 more scheduled: the card says what has cleared.
    expect(has(card.textContent, t('dashboard.cardsClearedHint')(fmt(60)))).toBe(true);
    [...card.querySelectorAll('div')].find(d => d.textContent.startsWith('Visa') && d.style.cursor === 'pointer').click();
    expect(navigate).toHaveBeenCalledWith('transactions', 'account:cc');
  });

  it('has no cards card without a credit card', async () => {
    await openPage();
    expect(cardWithTitle(t('dashboard.cardsTitle'))).toBeUndefined();
  });

  it('favourite accounts appear with their balance and open their transactions', async () => {
    state.accounts = state.accounts.map(a => (a.id === 'sav' ? { ...a, favorite: true } : a));
    await openPage();
    const card = cardWithTitle(t('dashboard.accountsTitle'));
    const tiles = [...card.querySelectorAll('.env-grid > *')];
    expect(tiles).toHaveLength(1);
    expect(tiles[0].textContent).toContain('Savings');
    expect(has(tiles[0].textContent, fmt(500))).toBe(true);
    tiles[0].click();
    expect(navigate).toHaveBeenCalledWith('transactions', 'account:sav');
  });

  it('an archived favourite is left off; a balance says the part not cleared yet', async () => {
    state.accounts = [
      ...state.accounts.map(a => (a.id === 'chk' ? { ...a, favorite: true } : a)),
      { id: 'old', name: 'Old bank', type: 'bank', initialBalance: 50, archived: true, favorite: true },
    ];
    await openPage();
    const tiles = [...cardWithTitle(t('dashboard.accountsTitle')).querySelectorAll('.env-grid > *')];
    expect(tiles).toHaveLength(1);
    expect(tiles[0].textContent).toContain('Checking');
    expect(tiles[0].textContent).not.toContain('Old bank');
    // 2830 booked; 2870 cleared today (the scheduled Dentist, 40, is not).
    expect(has(tiles[0].querySelector('.env-amt').textContent, fmt(2830))).toBe(true);
    expect(tiles[0].querySelector('.env-upcoming').textContent).toBe(t('accountCard.upcomingHint')(fmt(-40, { signed: true })));
  });

  it('with only an archived favourite there is no accounts card', async () => {
    state.accounts = [...state.accounts, { id: 'old', name: 'Old bank', type: 'bank', initialBalance: 50, archived: true, favorite: true }];
    await openPage();
    expect(cardWithTitle(t('dashboard.accountsTitle'))).toBeUndefined();
  });
});

describe('fill %: budget items not on track', () => {
  it('one line names how many, and Show opens the Budget plan filtered to them', async () => {
    const { session, now } = await import('../js/app.js');
    const { isoDate } = await import('../js/core/context.js');
    // Fun holds 70 and is never filled again: the Internet bill (25 on the
    // 20th) runs it dry within months.
    const funding = session.query('plan.funding', { date: isoDate(now()) }).value;
    const expected = funding.items.filter(i => i.status === 'short').length;
    expect(expected).toBeGreaterThan(0);
    await openPage();
    await new Promise(r => setTimeout(r, 0));
    const card = document.querySelector('.dashboard-items-card');
    expect(card.textContent).toContain(t('dashboard.itemsAttention')(expected));
    card.querySelector('a').click();
    expect(navigate).toHaveBeenCalledWith('budget-plan', { funding: 'attention' });
  });

  it('no line when every item is on track', async () => {
    state.budgetItems = plan().filter(it => it.id !== 'net');
    await openPage();
    await new Promise(r => setTimeout(r, 0));
    expect(document.querySelector('.dashboard-items-card')).toBeNull();
  });
});

describe('Overview attention list', () => {
  const actCards = () => [...document.querySelectorAll('[data-attention-key]')];
  it('names the first gap date and opens the affected envelope after first paint', async () => {
    state.budgetItems = plan().filter(it => it.id !== 'groc');
    // Start the bill now; historical unpaid occurrences would already be due.
    state.budgetItems.find(it => it.id === 'net').as_schedule_since = '2026-09-01';
    const spy = vi.spyOn(session, 'query');
    try {
      await openPage();
      await new Promise(r => setTimeout(r, 0));
      const cards = actCards();
      expect(cards).toHaveLength(1);
      expect(cards[0].textContent).toContain('Fun');
      expect(cards[0].textContent).toContain(fmtDateLang('2026-10-20'));
      cards[0].querySelector('button').click();
      expect(document.querySelector('.overview-envelope-detail')).not.toBeNull();
      expect(spy).toHaveBeenCalledWith('overview.attention', { date: '2026-09-15' });
      expect(writeBatch).not.toHaveBeenCalled();
    } finally { spy.mockRestore(); }
  });

  it('shows the assessed clear state and retains the net-worth preview', async () => {
    state.budgetItems = plan().filter(it => it.id === 'sal');
    await openPage();
    await new Promise(r => setTimeout(r, 0));
    expect(actCards()).toEqual([]);
    expect(document.querySelector('.overview-covered').textContent).toContain(t('attention.clear'));
    expect(document.querySelector('.overview-forecast svg').getAttribute('aria-label')).toContain(t('overview.forecastTitle'));
    expect(document.querySelector('.overview-forecast a').getAttribute('href')).toBe('#/net-worth');
  });

  it.each([false, true])('keeps the attention list independent of net-worth alerts (extra alert: %s)', async (withOtherAlert) => {
    state.budgetItems = plan().filter(it => it.id === 'sal');
    const real = session.query.bind(session);
    const spy = vi.spyOn(session, 'query').mockImplementation((name, input) => {
      const result = real(name, input);
      if (name === 'forecast.simulation' && result.ok) result.value.alerts = [{
        kind: 'unallocated-negative', firstDate: '2026-09-15', low: -1263, lowDate: '2026-11-01',
      }, ...(withOtherAlert ? [{ kind: 'account-negative', id: 'cash', firstDate: '2026-12-01', low: -20, lowDate: '2026-12-01' }] : [])];
      return result;
    });
    try {
      await openPage();
      await new Promise(r => setTimeout(r, 0));
      expect(document.querySelector('.overview-covered')).not.toBeNull();
      expect(actCards()).toHaveLength(0);
      expect(document.querySelector('.overview-forecast svg')).not.toBeNull();
    } finally { spy.mockRestore(); }
  });

  it('no card, and a warning, when the query fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const real = session.query.bind(session);
    const spy = vi.spyOn(session, 'query').mockImplementation((name, input) => (
      name === 'forecast.simulation' ? { ok: false, error: { code: 'bad_input', params: {} } } : real(name, input)));
    try {
      await openPage();
      await new Promise(r => setTimeout(r, 0));
      expect(actCards().length).toBeGreaterThan(0);
      expect(document.querySelector('.overview-forecast').textContent).toContain(t('overview.unavailable'));
      expect(document.querySelector('.overview-forecast svg')).toBeNull();
      expect(warn).toHaveBeenCalledWith('[bunvelope] forecast.simulation query failed:', 'bad_input');
    } finally {
      spy.mockRestore();
      warn.mockRestore();
    }
  });

  it('no card, and a warning, when the query throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const real = session.query.bind(session);
    const spy = vi.spyOn(session, 'query').mockImplementation((name, input) => {
      if (name === 'forecast.simulation') throw new Error('boom');
      return real(name, input);
    });
    try {
      await openPage();
      await new Promise(r => setTimeout(r, 0));
      expect(actCards().length).toBeGreaterThan(0);
      expect(warn).toHaveBeenCalledWith('[bunvelope] forecast.simulation query threw:', expect.any(Error));
    } finally {
      spy.mockRestore();
      warn.mockRestore();
    }
  });
});


describe('Overview working actions', () => {
  it('searches beyond favorites and excludes archived envelopes', async () => {
    state.envelopes[0].favorite = true;
    state.envelopes[2].archived = true;
    await openPage();
    const search = document.querySelector('.overview-search');
    expect(document.querySelectorAll('.overview-envelope-row')).toHaveLength(1);
    search.value = 'FUN';
    search.dispatchEvent(new Event('input'));
    expect([...document.querySelectorAll('.overview-envelope-row')].map(r => r.dataset.envelopeId)).toEqual(['fun']);
    search.value = 'Rent';
    search.dispatchEvent(new Event('input'));
    expect(document.querySelectorAll('.overview-envelope-row')).toHaveLength(0);
    expect(writeBatch).not.toHaveBeenCalled();
  });

  it('previews an allocation without writing, then prefills only the chosen envelope', async () => {
    await openPage();
    openOverviewEnvelope('fun');
    const before = structuredClone(state.transactions);
    const goal = document.querySelector('.overview-funding-goals button');
    expect(goal).not.toBeNull();
    goal.click();
    await flush();
    expect(document.querySelector('.overview-preview-values')).not.toBeNull();
    expect(state.transactions).toEqual(before);
    expect(writeBatch).not.toHaveBeenCalled();
    document.querySelector('.overview-preview .btn-accent').click();
    await flush();
    const inputs = [...document.querySelectorAll('.fill-env-input')];
    expect(inputs.filter(x => Number(x.value) > 0)).toHaveLength(1);
    expect(inputs.find(x => Number(x.value) > 0).closest('.fill-env-row').textContent).toContain('Fun');
    expect(writeBatch).not.toHaveBeenCalled();
  });

  it('does not carry a suggested assignment into another budget session', async () => {
    await openPage();
    openOverviewEnvelope('fun');
    document.querySelector('.overview-funding-goals button').click();
    await flush();
    const confirm = document.querySelector('.overview-preview .btn-accent');
    expect(confirm).not.toBeNull();
    beginBudgetSession();
    confirm.click();
    expect(document.querySelector('.fill-env')).toBeNull();
    expect(writeBatch).not.toHaveBeenCalled();
  });
});


describe('Overview and Detailed insights destinations', () => {
  it('keeps analysis on its own page without redundant header links', async () => {
    mountHosts();
    const root = document.getElementById('app-root');
    await render(root);
    expect(root.querySelector('.overview-top')).not.toBeNull();
    expect(root.querySelector('.kpi-row')).toBeNull();
    expect(root.querySelector('details.overview-insights')).toBeNull();
    expect(root.querySelector('.page-head a[href="#/detailed-insights"]')).toBeNull();
    expect(root.querySelector('.page-head').textContent).not.toContain(t('dashboard.loadBudget'));
    root.replaceChildren();
    await renderDetailedInsights(root);
    expect(root.querySelector('h1').textContent).toBe(t('nav.detailedInsights'));
    expect(root.querySelector('.page-head a[href="#/dashboard"]')).toBeNull();
    expect(root.querySelector('.kpi-row')).not.toBeNull();
    expect(root.querySelector('.overview-top')).toBeNull();
    expect(cardWithTitle(t('dashboard.recent'))).toBeDefined();
    expect(cardWithTitle(t('dashboard.trend'))).toBeDefined();
  });
});

it('explains projection values and opens envelope transactions from the header', async () => {
  await openPage();
  openOverviewEnvelope('fun');
  const explanation = document.querySelector('.overview-projection-explanation');
  expect(explanation.textContent).toContain(t('overview.projectionExplanation'));
  expect(explanation.textContent).toContain(t('overview.lowBalance'));
  expect(explanation.textContent).toContain(t('overview.reserveFloor'));
  expect(explanation.querySelectorAll('dd')).toHaveLength(3);
  const activity = [...document.querySelectorAll('.sheet-header-actions button')].find(b => b.textContent === t('overview.envelopeActivity'));
  expect(activity).toBeDefined();
  activity.click();
  expect(navigate).toHaveBeenLastCalledWith('transactions', 'fun');
});

describe('recurring-cost reminders in Overview', () => {
  it('opens the attention filter for due reminders and excludes hidden items', async () => {
    const scheduled = state.budgetItems.find(it => it.as_schedule);
    scheduled.recurring_review = { renews_on: '2026-10-01', reminder_days: 30 };
    await openPage();
    const notice = document.querySelector('.recurring-reminder-notice');
    expect(notice).not.toBeNull();
    expect(notice.textContent).toContain(scheduled.description);
    notice.querySelector('button').click();
    expect(navigate).toHaveBeenCalledWith('recurring-costs', { filter: 'attention' });
    scheduled.recurring_review.hidden = true;
    await openPage();
    expect(document.querySelector('.recurring-reminder-notice')).toBeNull();
  });
});


it('remembers balance breakdown expansion without opening the forecast details', async () => {
  await openPage();
  const breakdown = document.querySelector('.overview-pool-breakdown');
  expect(breakdown.open).toBe(false);
  breakdown.querySelector('summary').click();
  await openPage();
  expect(document.querySelector('.overview-pool-breakdown').open).toBe(true);
  expect(document.querySelector('.overview-forecast-details').open).toBe(false);
});
