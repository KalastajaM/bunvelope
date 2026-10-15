// @vitest-environment jsdom
// Money flow page: the flow it draws (captured at renderSankey, with the
// page's labels, colours and click targets), the table view, focus,
// exclusions and the empty states. The figures are the flow queries'
// (js/core/queries/flow-plan.js, flow-actual.js) through the session stub
// (_fakes/pageApp.js), at the fixed now (15 Sep 2026).
//
// Plan: Salary 3000 a month; living envelopes l1..l8 at 10..80 a month;
// rent 1000 a month with a 600 buffer; gym (l1's category) 30 a month until
// June 2026. Saving 200 a month to savings.
//   September: in 3000; living 360 (eight envelopes, six drawn + Other (2)),
//   housing 1000, saving 200, unspent 1440.
//   Year: in 36000; rent 12600 (buffer included).
// Actual: Job 3000 on 1 Aug; l8 80, rent 1000 in August, saving 500.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../js/app.js', async () => (await import('./_fakes/pageApp.js')).appStub);
// Every flow the page draws, with the labels, colours and click targets it gave.
const drawn = [];
vi.mock('../js/ui/sankey/render.js', async (orig) => {
  const m = await orig();
  return { ...m, renderSankey: (o) => { drawn.push(o); return m.renderSankey(o); } };
});

// The CSV the page hands the browser.
vi.mock('../js/ui/download.js', async (orig) => ({ ...(await orig()), downloadBlob: vi.fn() }));

import { render } from '../js/pages/flow.js';
import { downloadBlob } from '../js/ui/download.js';
import { t, trCat, trEnv, fmtMonthLang } from '../js/ui/i18n.js';
import { fmt } from '../js/utils.js';
import { saveChartPrefs } from '../js/ui/charts/persist.js';
import { savePageFilter } from '../js/ui/page-filter.js';
import { state, session, navigate, resetState, mountHosts } from './_fakes/pageApp.js';
import { stubResizeObserver } from './_fakes/resizeObserver.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const every = () => Object.fromEntries(MONTHS.map(m => [m, true]));
const LIVING = Array.from({ length: 8 }, (_, i) => ({ id: `l${i + 1}`, name: `Living ${i + 1}`, category: 'living' }));

const expense = (id, envelope_id, amount, extra = {}) => ({
  id, kind: 'expense', envelope_id, description: id, default_amount: -amount, extra_buffer: 0, include: true,
  monthly_schedule: every(), as_schedule: false, account_id: 'chk', ...extra,
});
const plan = () => [
  { id: 'sal', kind: 'income', envelope_id: null, account_id: 'chk', description: 'Salary', default_amount: 3000, extra_buffer: 0, include: true, monthly_schedule: every(), as_schedule: false },
  ...LIVING.map((e, i) => expense(`p-${e.id}`, e.id, 10 * (i + 1))),
  expense('p-rent', 'rent', 1000, { extra_buffer: 600 }),
  expense('p-gym', 'gym', 30, { end_month: '2026-06' }),
  { id: 'save', kind: 'account_transfer', envelope_id: null, account_id: 'chk', to_account_id: 'sav', description: 'Save', default_amount: -200, extra_buffer: 0, include: true, monthly_schedule: every(), as_schedule: false },
];
const ledger = () => [
  { id: 'i1', type: 'income', date: '2026-08-01', payee: 'Job', amount: 3000, account: 'chk', status: 'posted' },
  { id: 'x1', type: 'expense', date: '2026-08-05', payee: 'Shop', amount: 80, account: 'chk', envelope_id: 'l8', status: 'posted' },
  { id: 'x2', type: 'expense', date: '2026-08-02', payee: 'Landlord', amount: 1000, account: 'chk', envelope_id: 'rent', status: 'posted' },
  { id: 't1', type: 'account_transfer', date: '2026-08-03', amount: 500, from_account: 'chk', to_account: 'sav', status: 'posted' },
  { id: 'x3', type: 'expense', date: '2026-09-20', payee: 'Landlord', amount: 1000, account: 'chk', envelope_id: 'rent', status: 'scheduled' },
];

function memoryStorage() {
  const m = new Map();
  return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k), clear: () => m.clear(), key: i => [...m.keys()][i] ?? null, get length() { return m.size; } };
}

const app = () => document.getElementById('app-root');
const last = () => drawn.at(-1);
const node = (id) => last().flow.nodes.find(n => n.id === id);
const ids = () => last().flow.nodes.map(n => n.id);
const allCategories = () => [...app().querySelectorAll('button')].find(b => b.textContent === t('flow.allCategories'));

function open(prefs = {}) {
  saveChartPrefs('flow', prefs);
  mountHosts();
  render(app());
}

let width = 900;
beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage());
  stubResizeObserver();
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get() { return width; } });
  width = 900;
  resetState({ transactions: ledger() });
  state.envelopes = [...LIVING, { id: 'rent', name: 'Rent', category: 'housing' }, { id: 'gym', name: 'Gym', category: 'living' }];
  state.budgetItems = plan();
  savePageFilter('flow', 'test-budget', { envelopes: [] });
  // The focus is the page's module state. Whatever an earlier test left, it
  // lapses here: drawn over a budget with no categories, the page drops a
  // focus whose category is gone (whatever order the tests run in).
  const fixture = { envelopes: state.envelopes, budgetItems: state.budgetItems, transactions: state.transactions };
  Object.assign(state, { envelopes: [], budgetItems: [], transactions: [] });
  mountHosts();
  render(app());
  Object.assign(state, fixture);
  drawn.length = 0;
  downloadBlob.mockClear();
});

describe('the plan, one month', () => {
  it('draws this month of the plan: sources, the budget, categories, envelopes, saving and unspent', () => {
    open();
    const f = last().flow;
    expect(f.totals).toEqual({ in: 3000, out: 3000 });
    expect(ids()).toEqual(expect.arrayContaining(['src:Salary', 'budget', 'cat:living', 'cat:housing', 'env:rent', 'env-other:living', 'saving', 'unspent']));
    expect(node('cat:living').value).toBe(360);
    expect(node('unspent').value).toBe(1440);
    expect(node('env-other:living')).toMatchObject({ other: 2, value: 30 });
    expect(app().querySelector('.page-head .sub').textContent).toBe(t('flow.planMonthSub')(fmtMonthLang('2026-09')));
    expect(last().ariaLabel).toBe(t('flow.aria')(fmt(3000)));
  });

  it('names and colours the nodes on the page', () => {
    open();
    const o = last();
    const by = (id) => o.flow.nodes.find(n => n.id === id);
    expect(o.labelOf(by('src:Salary'))).toBe('Salary');
    expect(o.labelOf(by('cat:living'))).toBe(trCat('living'));
    expect(o.labelOf(by('env:rent'))).toBe(trEnv(state.envelopes.find(e => e.id === 'rent')));
    expect(o.labelOf(by('env-other:living'))).toBe(t('flow.otherEnvelopes')(2));
    expect(o.labelOf(by('saving'))).toBe(t('flow.saving'));
    expect(o.colorOf(by('src:Salary'))).toBe('#10b981');
    expect(o.colorOf(by('saving'))).toBe('#3b82f6');
    expect(o.colorOf(by('budget'))).toBe('#94a3b8');
    expect(o.colorOf(by('unspent'))).toBe('#a3a3a3');
    // Categories (and their envelopes) take the palette past its first three.
    expect(o.colorOf(by('env:rent'))).toBe(o.colorOf(by('cat:housing')));
    expect(o.colorOf(by('cat:living'))).not.toBe(o.colorOf(by('cat:housing')));
    // In the plan only a category opens (its envelopes); nothing navigates.
    expect(o.canActivate(by('cat:living'))).toBe(true);
    expect(o.canActivate(by('env:rent'))).toBe(false);
  });

  it('a past month reads the plan as that month saw it', () => {
    open();
    const picker = app().querySelector('.flow-month');
    picker.value = '2026-05';
    picker.dispatchEvent(new Event('change'));
    expect(node('env:gym')?.value).toBe(30);
    expect(node('cat:living').value).toBe(390);
    // The picker is re-rendered with the page.
    const again = app().querySelector('.flow-month');
    again.value = '2026-09';
    again.dispatchEvent(new Event('change'));
    expect(node('env:gym')).toBeUndefined();
  });

  it('the table lists every link', () => {
    open({ view: 'table' });
    const rows = [...app().querySelectorAll('.bv-chart-table tbody tr')].map(tr => [...tr.children].map(td => td.textContent));
    expect(rows).toContainEqual([t('flow.budget'), trCat('housing'), fmt(1000)]);
    expect(rows).toContainEqual(['Salary', t('flow.budget'), fmt(3000)]);
  });
});

describe('the CSV export', () => {
  const csvButton = () => app().querySelector(`button[aria-label="${t('chart.downloadCsv')}"]`);
  const exported = async () => {
    expect(downloadBlob).toHaveBeenCalledTimes(1);
    const [name, blob] = downloadBlob.mock.calls[0];
    const text = await blob.text();
    return { name, lines: text.replace(/^\uFEFF/, '').split('\r\n').filter(Boolean) };
  };

  it('downloads every link of the month as From, To, Amount, named for the month', async () => {
    open();
    csvButton().click();
    const { name, lines } = await exported();
    expect(name).toBe(`${t('flow.title')}_2026-09.csv`.replace(/\s+/g, '_'));
    expect(lines[0]).toBe([t('flow.colFrom'), t('flow.colTo'), t('flow.colAmount')].join(','));
    expect(lines).toContain(`Salary,${t('flow.budget')},3000`);
    expect(lines).toContain(`${t('flow.budget')},${trCat('housing')},1000`);
    expect(lines).toContain(`${trCat('living')},${t('flow.otherEnvelopes')(2)},30`);
    expect(lines).toHaveLength(1 + last().flow.links.length);
  });

  it('a focused category exports its envelopes unfolded', async () => {
    open();
    last().onActivate(node('cat:living'));
    csvButton().click();
    const { lines } = await exported();
    const living = lines.filter(l => l.startsWith(`${trCat('living')},`));
    expect(living).toHaveLength(8);
    expect(living).toContain(`${trCat('living')},${trEnv(LIVING[7])},80`);
    expect(lines.some(l => l.includes(t('flow.otherEnvelopes')(2)))).toBe(false);
  });
});

describe('the plan, the year', () => {
  it('draws the coming twelve months, buffers included, ended items out', () => {
    open({ period: 'year' });
    expect(last().flow.totals.in).toBe(36000);
    expect(node('env:rent').value).toBe(12600);
    expect(node('env:gym')).toBeUndefined();
    expect(app().querySelector('.page-head .sub').textContent).toBe(t('flow.planYearSub'));
  });
});

describe('the actuals', () => {
  it('draws the posted rows of the range; an envelope clicks through to its transactions', () => {
    open({ mode: 'actual', preset: 'ytd' });
    const o = last();
    expect(o.flow.totals.in).toBe(3000);
    expect(node('env:rent').value).toBe(1000);
    expect(node('saving').value).toBe(500);
    expect(o.labelOf(node('src:Job'))).toBe('Job');
    expect(o.canActivate(node('env:rent'))).toBe(true);
    navigate.mockClear();
    o.onActivate(node('env:rent'));
    expect(navigate).toHaveBeenCalledWith('transactions', { envelope: 'rent', dateFrom: '2026-01-01', dateTo: '2026-09-15' });
  });

  it('a custom range: no income in it, so the spending and saving show as a shortfall', () => {
    open({ mode: 'actual', preset: 'custom', from: '2026-08-03', to: '2026-08-31' });
    expect(last().flow.totals.in).toBe(580);
    expect(node('src:Job')).toBeUndefined();
    expect(node('saving').value).toBe(500);
    expect(node('shortfall').value).toBe(580);
  });
});

describe('focus on a category', () => {
  it('shows every envelope of that category, unfolded, and "All categories" goes back', () => {
    open();
    last().onActivate(node('cat:living'));
    const f = last().flow;
    expect(f.nodes.filter(n => n.kind === 'envelope').map(n => n.id)).toEqual(['env:l8', 'env:l7', 'env:l6', 'env:l5', 'env:l4', 'env:l3', 'env:l2', 'env:l1']);
    expect(f.totals).toEqual({ in: 360, out: 360 });
    expect(last().canActivate(f.nodes.find(n => n.id === 'cat:living'))).toBe(false);
    allCategories().click();
    expect(ids()).toContain('env-other:living');
  });

  it('a focus whose category is gone lapses', () => {
    open();
    last().onActivate(node('cat:housing'));
    expect(allCategories()).toBeTruthy();
    savePageFilter('flow', 'test-budget', { envelopes: ['rent'] });
    drawn.length = 0;
    render(app());
    expect(allCategories()).toBeUndefined();
    expect(ids()).not.toContain('cat:housing');
  });
});

describe('exclusions', () => {
  it('an excluded envelope leaves the flow; the head says filtered', () => {
    savePageFilter('flow', 'test-budget', { envelopes: ['rent'] });
    open();
    expect(ids()).not.toContain('env:rent');
    expect(node('unspent').value).toBe(2440);
    expect(app().querySelector('.page-head .sub').textContent).toContain(t('pageFilter.filtered'));
  });
});

describe('a phone-width card', () => {
  it('draws only Budget and where it goes', () => {
    width = 400;
    open();
    expect(new Set(last().flow.nodes.map(n => n.column))).toEqual(new Set([1, 2]));
  });
});

describe('empty states', () => {
  it('no plan', () => {
    state.budgetItems = [];
    open();
    expect(drawn).toHaveLength(0);
    expect(app().querySelector('.card').textContent).toContain(t('flow.emptyPlanTitle'));
    app().querySelector('.card button').click();
    expect(navigate).toHaveBeenCalledWith('budget-plan');
  });

  it('no posted rows in the range', () => {
    open({ mode: 'actual', preset: 'custom', from: '2020-01-01', to: '2020-12-31' });
    expect(drawn).toHaveLength(0);
    expect(app().querySelector('.card').textContent).toContain(t('flow.emptyActualTitle'));
  });

  it('a failed query shows the empty state', () => {
    const real = session.query.bind(session);
    const spy = vi.spyOn(session, 'query').mockImplementation((name, input) => (name === 'flow.plan' ? { ok: false, error: { code: 'bad_input' } } : real(name, input)));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      open();
      expect(drawn).toHaveLength(0);
      expect(app().querySelector('.card').textContent).toContain(t('flow.emptyPlanTitle'));
      expect(warn).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
      warn.mockRestore();
    }
  });
});

describe('what the page asks', () => {
  it('flow.plan with the month only for the month view, the date for the year; focus unfolds', () => {
    const spy = vi.spyOn(session, 'query');
    try {
      open();
      expect(spy).toHaveBeenLastCalledWith('flow.plan', { period: 'month', month: '2026-09', excludeEnvelopes: [] });
      last().onActivate(node('cat:living'));
      expect(spy).toHaveBeenLastCalledWith('flow.plan', { period: 'month', month: '2026-09', excludeEnvelopes: [], topPerCategory: 0 });
      allCategories().click();
      open({ period: 'year' });
      expect(spy).toHaveBeenLastCalledWith('flow.plan', { period: 'year', date: '2026-09-15', excludeEnvelopes: [] });
      open({ mode: 'actual', preset: 'all' });
      expect(spy).toHaveBeenLastCalledWith('flow.actual', { excludeEnvelopes: [] });
      open({ mode: 'actual', preset: 'ytd' });
      expect(spy).toHaveBeenLastCalledWith('flow.actual', { from: '2026-01-01', to: '2026-09-15', excludeEnvelopes: [] });
    } finally {
      spy.mockRestore();
    }
  });
});
