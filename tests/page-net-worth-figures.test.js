// @vitest-environment jsdom
// Net worth: the figures the page shows for a known budget (the history
// chart, the next-24-months card with its dates to act on and a what-if's
// diff, the long projection and its table), with the page filter and an
// unsaved account edit. Drives the real js/pages/net-worth.js; the charts are
// the real ones, wrapped so a test reads the series and markers they were
// given.
//
// The stubbed app.js fixes "now" at 15 Sep 2026.
//
// Today's net worth by hand (non-archived accounts, every row dated on or
// before today; the archived "Old checking" is left out):
//   Checking 800 + 3 x 3000 - 2500.333 - 600 - 500 - 250 = 5949.667
//   Visa -60, Savings 5000 + 600 = 5600, BSU 0, Broker 10000 + 500 = 10500,
//   Pension 2000, House 200000 + 5000 = 205000, Mortgage -100000,
//   Car loan -8000 + 250 = -7750, Lent 1000, Empty 0
//   total 122239.667; without House -82760.333
// The last 12 months' average added (posted rows, adjustments left out):
//   Checking 5149.667 / 12 = 429.14, Visa -5, Savings 50, Broker 41.67,
//   Car loan 20.83 -> 536.64, shown as +537.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../js/app.js', async () => (await import('./_fakes/pageApp.js')).appStub);
vi.mock('../js/state/meta-writes.js', () => ({ updateMeta: vi.fn() }));
import { updateMeta } from '../js/state/meta-writes.js';
const persist = async (_state, patch) => { state.meta = await patch(state.meta); return true; };
const specs = [];
vi.mock('../js/ui/charts/index.js', async (importOriginal) => {
  const mod = await importOriginal();
  return { ...mod, mountChart: (spec) => { specs.push(spec); return mod.mountChart(spec); } };
});
// `simulate` wrapped in a spy that calls the real one, so a test can count
// the walks a render makes (a cache hit returns the cached object itself).
vi.mock('../js/engine/simulation.js', async (importOriginal) => {
  const mod = await importOriginal();
  return { ...mod, simulate: vi.fn(mod.simulate) };
});
// The projection's 12-month average and loan schedules, spied the same way:
// a horizon or source toggle must not recompute them.
vi.mock('../js/engine/balances.js', async (importOriginal) => {
  const mod = await importOriginal();
  return { ...mod, averageMonthlyContribution: vi.fn(mod.averageMonthlyContribution) };
});
vi.mock('../js/engine/loan-schedule.js', async (importOriginal) => {
  const mod = await importOriginal();
  return { ...mod, loanRepayment: vi.fn(mod.loanRepayment) };
});

import { render } from '../js/pages/net-worth.js';
import { t, fmtMonthLang, fmtDateLang } from '../js/ui/i18n.js';
import { fmt, fmtNum } from '../js/utils.js';
import { saveChartPrefs } from '../js/ui/charts/persist.js';
import { savePageFilter } from '../js/ui/page-filter.js';
import { state, session, resetState, mountHosts, flush, setValue } from './_fakes/pageApp.js';
import { stubResizeObserver } from './_fakes/resizeObserver.js';
import { simulate } from '../js/engine/simulation.js';
import { averageMonthlyContribution } from '../js/engine/balances.js';
import { loanRepayment } from '../js/engine/loan-schedule.js';

const ALL = Object.fromEntries(['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'].map(m => [m, true]));

// jsdom's localStorage is not usable under every Node; the page's chart prefs
// only need a map.
function memoryStorage() {
  const m = new Map();
  return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k), clear: () => m.clear() };
}

function fixture() {
  resetState({ transactions: [
    { id: 'o1', type: 'income', date: '2025-03-10', payee: 'Old', amount: 100, account: 'old', status: 'posted' },
    { id: 'o2', type: 'income', date: '2026-02-10', payee: 'Old', amount: 120, account: 'old', status: 'posted' },
    { id: 'i0', type: 'income', date: '2026-06-25', payee: 'Pay', amount: 3000, account: 'chk', status: 'posted' },
    { id: 'i1', type: 'income', date: '2026-07-25', payee: 'Pay', amount: 3000, account: 'chk', status: 'posted' },
    { id: 'i2', type: 'income', date: '2026-08-25', payee: 'Pay', amount: 3000, account: 'chk', status: 'posted' },
    { id: 'e1', type: 'expense', date: '2026-09-02', payee: 'Shop', amount: 2500.333, account: 'chk', envelope_id: 'groc', status: 'posted' },
    { id: 'c1', type: 'expense', date: '2026-09-03', payee: 'Shop', amount: 60, account: 'card', envelope_id: 'groc', status: 'posted' },
    { id: 't1', type: 'account_transfer', date: '2026-08-10', payee: 'Save', amount: 600, from_account: 'chk', to_account: 'sav', status: 'posted' },
    { id: 'b1', type: 'investment_transfer', direction: 'buy', date: '2026-08-15', payee: 'Broker', amount: 500, units: 5, symbol: 'ABC', from_account: 'chk', to_account: 'inv', status: 'posted' },
    { id: 'p1', type: 'account_transfer', date: '2026-09-05', payee: 'Car', amount: 250, from_account: 'chk', to_account: 'car', status: 'posted' },
    { id: 'a1', type: 'adjustment', target: 'account', target_id: 'house', date: '2026-06-30', payee: 'Valuation', amount: 5000, status: 'posted' },
    { id: 'f1', type: 'expense', date: '2026-11-03', payee: 'Later', amount: 50, account: 'card', envelope_id: 'groc', status: 'scheduled' },
    { id: 'big', type: 'expense', date: '2026-12-10', payee: 'Roof', amount: 9000, account: 'chk', envelope_id: 'rent', status: 'scheduled' },
  ] });
  state.accounts = [
    { id: 'chk', name: 'Checking', type: 'bank', initialBalance: 800 },
    { id: 'card', name: 'Visa', type: 'credit_card', initialBalance: 0 },
    { id: 'sav', name: 'Savings', type: 'savings', initialBalance: 5000, interestTiers: [{ upTo: 10000, rate: 2 }, { rate: 0.5 }] },
    { id: 'bsu', name: 'BSU', type: 'savings', initialBalance: 0, plannedMonthly: 150 },
    { id: 'inv', name: 'Broker', type: 'investment', initialBalance: 10000, expectedGrowth: 5 },
    { id: 'pens', name: 'Pension', type: 'investment', pensionInsurance: true, initialBalance: 2000, expectedGrowth: 4 },
    { id: 'house', name: 'House', type: 'asset', group: 'Homes', initialBalance: 200000, expectedGrowth: 1 },
    { id: 'mtg', name: 'Mortgage', type: 'loan', initialBalance: -100000, interestRates: [{ from: '2020-01-01', rate: 3 }] },
    { id: 'car', name: 'Car loan', type: 'loan', initialBalance: -8000 },
    { id: 'lent', name: 'Lent', type: 'loan_given', initialBalance: 1000 },
    { id: 'empty', name: 'Empty', type: 'bank', initialBalance: 0 },
    { id: 'old', name: 'Old checking', type: 'bank', initialBalance: 50, archived: true },
  ];
  state.envelopes = [
    { id: 'rent', name: 'Rent', category: 'Housing' },
    { id: 'groc', name: 'Groceries', category: 'Food' },
  ];
  state.budgetItems = [
    { id: 'salary', kind: 'income', description: 'Pay', account_id: 'chk', default_amount: 3000, payment_day: 25,
      schedule_day_type: 'exact', include: true, as_schedule: true, as_schedule_since: '2026-09-01', monthly_schedule: ALL },
    { id: 'food', kind: 'expense', description: 'Food', envelope_id: 'groc', account_id: 'chk', default_amount: -900, payment_day: 5,
      schedule_day_type: 'exact', include: true, as_schedule: true, as_schedule_since: '2026-10-01', monthly_schedule: ALL,
      extra_buffer: 200, stress_category: 'B', stress_cut_pcts: { A: 0.5, B: 0.4 } },
    { id: 'save', kind: 'transfer', description: 'Save', account_id: 'chk', to_account_id: 'sav', default_amount: -300, payment_day: 26,
      schedule_day_type: 'exact', include: true, as_schedule: true, as_schedule_since: '2026-10-01', monthly_schedule: ALL },
    { id: 'mortgage', kind: 'loan_payment', description: 'Home loan', envelope_id: 'rent', account_id: 'chk', to_account_id: 'mtg',
      default_amount: -1200, monthly_schedule: ALL, payment_day: 5, as_schedule: true, as_schedule_since: '2026-10-01',
      include: true, schedule_day_type: 'exact', loan_method: 'annuity', loan_end: '2051-09' },
  ];
  state.meta = {
    country: 'FI',
    whatIfScenarios: [
      { id: 'paycut', name: 'Pay cut', changes: [{ type: 'income', pct: -100, from: '2026-11' }] },
      { id: 'trip', name: 'Trip', changes: [{ type: 'oneoff', date: '2027-02-10', amount: -2500, account: 'chk', label: 'Trip' }] },
    ],
  };
}

const root = () => document.getElementById('app-root');
// The last spec each chart was mounted with.
const chart = (id) => specs.filter(s => s.id === id).at(-1);
const values = (id, series) => chart(id).series.find(s => s.id === series).values;
const horizonBtn = (y) => [...root().querySelectorAll('.net-worth-horizons > .btn')].find(b => b.textContent === t('netWorth.horizon')(y));
const sourceBtn = (key) => [...root().querySelectorAll('.net-worth-source .btn')].find(b => b.textContent === t(`netWorth.${key}`));
const rows = () => [...root().querySelectorAll('.net-worth-table tbody tr[data-account-id]')];
const rowOf = (name) => rows().find(tr => tr.firstElementChild.firstChild.textContent === name);
const noteText = () => root().querySelector('.net-worth-plan-note').textContent;
const alertButtons = () => [...root().querySelectorAll('.net-worth-alert')].map(b => b.textContent);
const diffLines = () => [...root().querySelectorAll('.net-worth-whatif-diff')].map(li => li.textContent);
const money = v => fmt(v, { signed: true, decimals: 0 });
// moneyEl and fmt print the same figure with different spacing after the currency sign.

async function open({ whatIf = null, exclude = [], source = 'plan', setup } = {}) {
  fixture();
  setup?.();
  vi.stubGlobal('localStorage', memoryStorage());
  saveChartPrefs('nw-projection', { whatIf, contributionSource: source });
  savePageFilter('netWorth', 'test-budget', { accounts: exclude });
  mountHosts();
  await render(root());
  // The horizon is a module variable: start every test at the default.
  horizonBtn(10).click();
  await flush();
}

beforeEach(() => {
  specs.length = 0;
  updateMeta.mockReset().mockImplementation(persist);
  vi.stubGlobal('requestAnimationFrame', (cb) => setTimeout(cb, 0));
  stubResizeObserver();
});

describe('history', () => {
  it('charts the 24 month-ends before this month and today, ending at today\'s net worth without duplicating it in the header', async () => {
    await open();
    const spec = chart('nw-history');
    expect(spec.x).toHaveLength(25);
    expect(spec.x[0].key).toBe('2024-09-30');
    expect(spec.x[23].key).toBe('2026-08-31');
    expect(spec.x[24]).toEqual({ key: '2026-09-15', label: t('netWorth.today') });
    expect(values('nw-history', 'total')).toHaveLength(25);
    expect(values('nw-history', 'total').at(-1)).toBeCloseTo(122239.667, 2);
    expect(root().querySelector('.page-head-sub')).toBeNull();
  });

  it('the page filter leaves an account out of the history and the table, but not out of the dates to act on', async () => {
    await open();
    const allAlerts = alertButtons();
    specs.length = 0;
    await open({ exclude: ['house'] });
    expect(values('nw-history', 'total').at(-1)).toBeCloseTo(-82760.333, 2);
    expect(root().querySelector('.page-head-sub').textContent).toContain(t('pageFilter.filtered'));
    expect(rowOf('House')).toBeUndefined();
    expect(alertButtons()).toEqual(allAlerts);
    expect(root().querySelector('.net-worth-sim-note').textContent).toBe(t('pageFilter.alertsAllAccounts'));
  });
});

describe('next 24 months', () => {
  it('marks each date to act on on the chart, the same ones the list names', async () => {
    await open();
    const spec = chart('nw-simulation');
    expect(spec.x).toHaveLength(25);
    expect(spec.x[0].key).toBe('2026-09-30');
    expect(spec.series.map(s => s.id).slice(0, 3)).toEqual(['base', 'low', 'high']);
    expect(spec.markers).toHaveLength(2);
    expect(spec.markers.map(m => m.label)).toEqual(alertButtons());
    expect(alertButtons()).toHaveLength(2);
  });

  it('a what-if lists how its dates to act on differ: a new one under a pay cut', async () => {
    await open({ whatIf: 'paycut' });
    const lines = diffLines();
    expect(lines).toHaveLength(1);
    expect(lines[0].startsWith(t('netWorth.whatIfNew')(''))).toBe(true);
    expect(lines[0]).toContain('Checking');
    expect(lines[0]).toContain(fmtDateLang('2026-12-10'));
    const titles = [...root().querySelectorAll('.net-worth-act-title')].map(h => h.textContent);
    expect(titles).toContain(t('netWorth.whatIfWithTitle')('Pay cut'));
  });

  it('a what-if that moves no date to act on says so', async () => {
    await open({ whatIf: 'trip' });
    expect(diffLines()).toEqual([]);
    const lists = root().querySelectorAll('.net-worth-alerts');
    expect(lists[lists.length - 1].textContent).toBe(t('netWorth.whatIfNoChange'));
  });
});

describe('projection', () => {
  it('has a point per year through the horizon, with the band and the what-if line', async () => {
    await open({ whatIf: 'trip' });
    const spec = chart('nw-projection');
    expect(spec.x.map(p => p.label)).toEqual(Array.from({ length: 11 }, (_, i) => String(2026 + i)));
    expect(spec.series.map(s => s.id)).toEqual(['base', 'low', 'high', 'whatif']);
    expect(spec.series[3].name).toBe(t('netWorth.whatIfSeries')('Trip'));
    expect(values('nw-projection', 'base')[10]).toBeCloseTo(387386.27, 2);
    // The trip's 2500, not compounded: Checking has no rate.
    expect(values('nw-projection', 'whatif')[10]).toBeCloseTo(387386.27 - 2500, 2);
    horizonBtn(5).click();
    expect(values('nw-projection', 'base')).toHaveLength(6);
    horizonBtn(20).click();
    expect(values('nw-projection', 'base')).toHaveLength(21);
  });

  it('the table lists every account with a balance, a rate or a contribution, a scheduled loan by its payoff', async () => {
    await open();
    expect(rows().map(tr => tr.firstElementChild.firstChild.textContent))
      .toEqual(['Checking', 'Visa', 'Savings', 'BSU', 'Broker', 'Pension', 'House', 'Mortgage', 'Car loan', 'Lent']);
    const mtg = rowOf('Mortgage').children;
    expect(mtg).toHaveLength(4);
    expect(mtg[2].colSpan).toBe(2);
    expect(mtg[2].textContent).toBe(t('netWorth.followsScheduleTo')(fmtMonthLang('2051-09')));
    // A loan nothing repays keeps its fields.
    expect(rowOf('Car loan').querySelectorAll('input')).toHaveLength(2);
    expect(rowOf('Checking').children[1].textContent).toBe(fmt(5949.667, { decimals: 0 }));
    expect(rowOf('Checking').children[4].textContent).toBe(fmt(195045, { decimals: 0 }));
    // Its own rate, and a rate from the interest tiers as the placeholder.
    expect(rowOf('Broker').querySelector('input').value).toBe(fmtNum(5, { maxDecimals: 2 }));
    expect(rowOf('Savings').querySelector('input').placeholder).toBe(fmtNum(2, { maxDecimals: 2 }));
    expect(rowOf('BSU').querySelectorAll('input')[1].value).toBe(fmtNum(150, { maxDecimals: 2 }));
  });

  it('the note gives what the projection adds and the last 12 months, by the source', async () => {
    await open();
    expect(noteText()).toBe(t('netWorth.planNote')(money(2009), money(537)));
    sourceBtn('sourceHistory').click();
    expect(noteText()).toBe(t('netWorth.historyNote')(money(687), money(2009)));
  });

  it('a plan adding far less than recent months gets the link to the plan', async () => {
    await open();
    expect(root().querySelector('.net-worth-plan-note a')).toBeNull();
    await open({ setup: () => { state.budgetItems = state.budgetItems.filter(i => i.id !== 'salary'); } });
    expect(root().querySelector('.forecast-readiness [data-readiness-action="plan"]')).not.toBeNull();
    expect(root().querySelector('.forecast-readiness').textContent).toContain(t('forecastReadiness.historyGap'));
    expect(noteText()).not.toContain(t('netWorth.planNoteGap'));
  });

  it('an edit shows at once, rounded to cents, before the save lands', async () => {
    await open({ setup: () => { state.accounts = state.accounts.map(a => (a.id === 'inv' ? { ...a, expectedGrowth: 7.26 } : a)); } });
    const stored = values('nw-projection', 'base')[10];
    await open();
    let release;
    updateMeta.mockImplementationOnce((_state, patch) => new Promise(res => { release = async () => { await persist(state, patch); res(true); }; }));
    setValue(rowOf('Broker').querySelector('input'), '7.255', ['change']);
    await flush();
    expect(values('nw-projection', 'base')[10]).toBeCloseTo(stored, 2);
    expect(rowOf('Broker').querySelector('input').value).toBe('7.255');
    rowOf('Broker').querySelector('[data-action="save"]').click();
    await flush();
    await release();
    await flush();
    expect(state.accounts.find(a => a.id === 'inv').expectedGrowth).toBe(5);
    expect(state.meta.netWorthSimulations[0].accounts.find(a => a.id === 'inv').expectedGrowth).toBe(7.26);
  });
});

describe('the queries behind the figures', () => {
  const asked = (spy) => spy.mock.calls.map(([name, input]) => [name, input]);

  it('one date for the render; the band, the what-if and the projection inputs from the page\'s choices', async () => {
    const spy = vi.spyOn(session, 'query');
    try {
      await open({ whatIf: 'trip', exclude: ['house'], source: 'history' });
      const date = '2026-09-15';
      const ex = { excludeAccounts: ['house'] };
      const calls = asked(spy);
      expect(calls).toContainEqual(['netWorth.history', { date, ...ex }]);
      expect(calls).toContainEqual(['forecast.simulation', { date, ...ex }]);
      expect(calls).toContainEqual(['forecast.simulation', { date, ...ex, shiftPct: -2, alerts: false }]);
      expect(calls).toContainEqual(['forecast.simulation', { date, ...ex, shiftPct: 2, alerts: false }]);
      expect(calls).toContainEqual(['forecast.simulation', { date, ...ex, whatIf: 'trip' }]);
      expect(calls).toContainEqual(['netWorth.projection', { date, ...ex, years: 10, contribution: 'history', whatIf: 'trip' }]);
      expect(new Set(calls.map(([, input]) => input.date))).toEqual(new Set([date]));
      spy.mockClear();
      horizonBtn(20).click();
      expect(asked(spy)).toEqual([['netWorth.projection', { date, ...ex, years: 20, contribution: 'history', whatIf: 'trip' }], ['forecast.readiness', {date,...ex,months:24,contribution:'history',whatIf:'trip'}]]);
    } finally {
      spy.mockRestore();
    }
  });

  it('an unsaved edit goes to every simulation and the projection as an account override, in cents', async () => {
    await open();
    const spy = vi.spyOn(session, 'query');
    try {
      setValue(rowOf('Broker').querySelector('input'), '7.255', ['change']);
      await flush();
      const overrides = [{ id: 'inv', expectedGrowth: 7.26 }];
      const calls = asked(spy).filter(([name]) => name !== 'netWorth.history');
      expect(calls.map(([name]) => name)).toEqual(['forecast.simulation', 'forecast.simulation', 'forecast.simulation', 'netWorth.projection', 'forecast.readiness']);
      for (const [, input] of calls) expect(input.accountOverrides).toEqual(overrides);
    } finally {
      spy.mockRestore();
    }
  });

  it('saved simulations continue to supply overrides without changing the live accounts', async () => {
    await open();
    let release;
    updateMeta.mockImplementationOnce((_state, patch) => new Promise(res => { release = async () => { await persist(state, patch); res(true); }; }));
    setValue(rowOf('Broker').querySelector('input'), '6', ['change']);
    await flush();
    const spy = vi.spyOn(session, 'query');
    try {
      horizonBtn(20).click();
      expect(spy.mock.calls.at(-1)[1].accountOverrides).toEqual([{ id: 'inv', expectedGrowth: 6 }]);
      rowOf('Broker').querySelector('[data-action="save"]').click();
      await flush();
      await release();
      await flush();
      expect(state.accounts.find(a => a.id === 'inv').expectedGrowth).toBe(5);
      spy.mockClear();
      horizonBtn(10).click();
      expect(spy.mock.calls.map(([name]) => name)).toEqual(['netWorth.projection','forecast.readiness']);
      expect(spy.mock.calls[0][1].accountOverrides).toEqual([{ id: 'inv', expectedGrowth: 6 }]);
    } finally {
      spy.mockRestore();
    }
  });

  it('a render walks four runs (base, the band, the what-if), each once; a repaint walks none', async () => {
    simulate.mockClear();
    await open({ whatIf: 'trip' });
    const runs = () => new Set(simulate.mock.results.map(r => r.value));
    // The card's four queries, the what-if's own base run and the
    // projection's four runs (twice: open() resets the horizon) all hit the
    // same four cache entries.
    expect(simulate.mock.calls.length).toBe(17);
    expect(runs().size).toBe(4);
    horizonBtn(20).click();
    sourceBtn('sourceHistory').click();
    expect(runs().size).toBe(4);
  });

  it('a horizon or source toggle reuses the 12-month average and the loan schedules', async () => {
    await open({ whatIf: 'trip' });
    averageMonthlyContribution.mockClear();
    loanRepayment.mockClear();
    horizonBtn(20).click();
    sourceBtn('sourceHistory').click();
    horizonBtn(5).click();
    expect(averageMonthlyContribution).not.toHaveBeenCalled();
    expect(loanRepayment).not.toHaveBeenCalled();
    // The projection still follows the toggles.
    expect(chart('nw-projection').x).toHaveLength(6);
  });

  // A what-if deleted elsewhere (another tab, the AI) while the page is open:
  // the queries no longer find it. The page drops the selection, as it drops
  // an unknown id at load, and draws the rest without it.
  const deleteTripElsewhere = () => {
    state.meta = { ...state.meta, whatIfScenarios: state.meta.whatIfScenarios.filter(s => s.id !== 'trip') };
  };
  const whatIfTitles = () => [...root().querySelectorAll('.net-worth-act-title')].map(h => h.textContent)
    .filter(text => text === t('netWorth.whatIfWithTitle')('Trip'));

  it('a what-if deleted elsewhere is dropped on a projection repaint, and the projection drawn without it', async () => {
    await open({ whatIf: 'trip' });
    expect(chart('nw-projection').series.map(s => s.id)).toContain('whatif');
    expect(whatIfTitles()).toHaveLength(1);
    const base = values('nw-projection', 'base');
    deleteTripElsewhere();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const spy = vi.spyOn(session, 'query');
    try {
      horizonBtn(10).click();
      expect(chart('nw-projection').series.map(s => s.id)).toEqual(['base', 'low', 'high']);
      expect(values('nw-projection', 'base')).toEqual(base);
      expect(rows().length).toBeGreaterThan(0);
      expect(noteText()).not.toBe('');
      expect(root().querySelector('.net-worth-whatif-row select').value).toBe('');
      // The card is repainted without the what-if's list too.
      expect(whatIfTitles()).toEqual([]);
      expect(alertButtons()).toHaveLength(2);
      // Asked once with the id, then once without; nothing warned.
      const projections = spy.mock.calls.filter(([name]) => name === 'netWorth.projection').map(([, input]) => input.whatIf);
      expect(projections).toEqual(['trip', undefined]);
      expect(warn).not.toHaveBeenCalled();
      spy.mockClear();
      horizonBtn(20).click();
      expect(spy.mock.calls.map(([, input]) => input.whatIf)).toEqual([undefined,undefined]);
    } finally {
      spy.mockRestore();
      warn.mockRestore();
    }
  });

  it('a what-if deleted elsewhere is dropped on a full repaint, before the card asks for it', async () => {
    await open({ whatIf: 'trip' });
    deleteTripElsewhere();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      setValue(rowOf('Broker').querySelector('input'), '6', ['change']);
      await flush();
      expect(whatIfTitles()).toEqual([]);
      expect(alertButtons()).toHaveLength(2);
      expect(chart('nw-projection').series.map(s => s.id)).toEqual(['base', 'low', 'high']);
      expect(rows().length).toBeGreaterThan(0);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('a failed query on a repaint clears its figures rather than leaving the old ones', async () => {
    await open();
    expect(rows().length).toBeGreaterThan(0);
    expect(alertButtons()).toHaveLength(2);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const real = session.query.bind(session);
    const spy = vi.spyOn(session, 'query').mockImplementation((name, input) => (
      ['netWorth.projection', 'forecast.simulation'].includes(name) ? { ok: false, error: { code: 'bad_input', params: {} } } : real(name, input)));
    try {
      horizonBtn(20).click();
      expect(rows()).toEqual([]);
      expect(noteText()).toBe('');
      expect(root().querySelector('.net-worth-projection-chart .bv-chart')).toBeNull();
      // An edit repaints the card too.
      spy.mockImplementation((name, input) => (name === 'forecast.simulation' ? { ok: false, error: { code: 'bad_input', params: {} } } : real(name, input)));
      horizonBtn(10).click();
      expect(alertButtons()).toHaveLength(2);
      setValue(rowOf('Broker').querySelector('input'), '6', ['change']);
      await flush();
      expect(alertButtons()).toEqual([]);
      expect(root().querySelector('.net-worth-alerts')).toBeNull();
      expect(rows().length).toBeGreaterThan(0);
    } finally {
      spy.mockRestore();
      warn.mockRestore();
    }
  });

  it('a failed query leaves its figures off and warns; the rest of the page renders', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const real = session.query.bind(session);
    const spy = vi.spyOn(session, 'query').mockImplementation((name, input) => (
      name === 'netWorth.projection' ? { ok: false, error: { code: 'bad_input', params: {} } } : real(name, input)));
    try {
      await open();
      expect(warn).toHaveBeenCalledWith('[bunvelope] netWorth.projection query failed:', 'bad_input');
      expect(chart('nw-projection')).toBeUndefined();
      expect(rows()).toEqual([]);
      expect(chart('nw-history')).toBeDefined();
      expect(alertButtons()).toHaveLength(2);
    } finally {
      spy.mockRestore();
      warn.mockRestore();
    }
  });
});
