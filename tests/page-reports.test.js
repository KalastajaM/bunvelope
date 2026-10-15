// @vitest-environment jsdom
// Reports page: every figure it shows, as the chart specs it mounts (what the
// chart component draws and exports as CSV), the KPI strip and the subtitles.
// The figures are the report queries' (js/core/queries/reports-*.js,
// plan-allocation.js, envelopes-history.js) through the session stub
// (_fakes/pageApp.js), whose clock is the fixed now (15 Sep 2026); the lens
// is the session query's, so the page reads no lens-filtered rows itself.
//
// Ledger (YTD = 1 Jan .. 15 Sep 2026):
//   2025-11  income 1000 (Job); food 100 (Supermarket)
//   2026-07  income 3000 (Job); fill food 700, rent 2000, fun 100;
//            food 200 (Supermarket); rent 1000 (Landlord)
//   2026-08  income 3000 (Job); food 300 (Supermarket); rent 1000 (Landlord);
//            fun 50 (Cinema), fun 25 (no payee); to savings 400; loan principal 250
//   2026-09-20 rent 1000 (Landlord), scheduled
//   YTD: income 6000, spending 2575 (Jul 1200, Aug 1375), saving 650 (Aug), net 3425
//   12-month averages: window Sep 2025 .. Aug 2026 from the first month with
//   data (Nov 2025): 10 months; income 7000/10, spending 2675/10, saving 650/10
//   Envelope balances, Booked: food 100, rent -1000, fun 25; Today: rent 0
//   Month-end totals, Booked: Jul 1500, Aug 125, Sep -875
//   Plan: food 100 a month, rent 1000 a month (+ 500 buffer)
import { describe, it, expect, beforeEach, vi } from 'vitest';

// The app's clock as a mock, so a test can move it on mid-render.
vi.mock('../js/app.js', async () => {
  const { appStub, FIXED_NOW } = await import('./_fakes/pageApp.js');
  return { ...appStub, now: vi.fn(() => new Date(FIXED_NOW)) };
});
// Every chart the page mounts, as the spec it passed.
const specs = [];
vi.mock('../js/ui/charts/index.js', async (orig) => {
  const m = await orig();
  return { ...m, mountChart: (spec) => { specs.push(spec); return m.mountChart(spec); } };
});

import { render } from '../js/pages/reports.js';
import { t, trCat, trEnv, fmtDateLang } from '../js/ui/i18n.js';
import { fmt } from '../js/utils.js';
import { saveChartPrefs } from '../js/ui/charts/persist.js';
import { savePageFilter } from '../js/ui/page-filter.js';
import { now } from '../js/app.js';
import { state, prefs, session, navigate, resetState, mountHosts, flush, FIXED_NOW } from './_fakes/pageApp.js';
import { stubResizeObserver } from './_fakes/resizeObserver.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const every = () => Object.fromEntries(MONTHS.map(m => [m, true]));
const BUDGET = 'test-budget';

const ledger = () => [
  { id: 'i0', type: 'income', date: '2025-11-10', payee: 'Job', amount: 1000, account: 'chk', status: 'posted' },
  { id: 'x0', type: 'expense', date: '2025-11-11', payee: 'Supermarket', amount: 100, account: 'chk', envelope_id: 'food', status: 'posted' },
  { id: 'i1', type: 'income', date: '2026-07-01', payee: 'Job', amount: 3000, account: 'chk', status: 'posted' },
  { id: 'f1', type: 'fill', date: '2026-07-02', status: 'posted', source: 'allocation',
    lines: [{ envelope_id: 'food', mode: 'add', amount: 700 }, { envelope_id: 'rent', mode: 'add', amount: 2000 }, { envelope_id: 'fun', mode: 'add', amount: 100 }] },
  { id: 'x1', type: 'expense', date: '2026-07-05', payee: 'Supermarket', amount: 200, account: 'chk', envelope_id: 'food', status: 'posted' },
  { id: 'x2', type: 'expense', date: '2026-07-01', payee: 'Landlord', amount: 1000, account: 'chk', envelope_id: 'rent', status: 'posted' },
  { id: 'i2', type: 'income', date: '2026-08-01', payee: 'Job', amount: 3000, account: 'chk', status: 'posted' },
  { id: 'x3', type: 'expense', date: '2026-08-05', payee: 'Supermarket', amount: 300, account: 'chk', envelope_id: 'food', status: 'posted' },
  { id: 'x4', type: 'expense', date: '2026-08-01', payee: 'Landlord', amount: 1000, account: 'chk', envelope_id: 'rent', status: 'posted' },
  { id: 'x5', type: 'expense', date: '2026-08-10', payee: 'Cinema', amount: 50, account: 'chk', envelope_id: 'fun', status: 'posted' },
  { id: 'x6', type: 'expense', date: '2026-08-12', payee: '', amount: 25, account: 'chk', envelope_id: 'fun', status: 'posted' },
  { id: 't1', type: 'account_transfer', date: '2026-08-03', amount: 400, from_account: 'chk', to_account: 'sav', status: 'posted' },
  { id: 't2', type: 'account_transfer', date: '2026-08-04', amount: 250, from_account: 'chk', to_account: 'loan', status: 'posted' },
  { id: 'x7', type: 'expense', date: '2026-09-20', payee: 'Landlord', amount: 1000, account: 'chk', envelope_id: 'rent', status: 'scheduled' },
];

const plan = () => [
  { id: 'sal', kind: 'income', envelope_id: null, account_id: 'chk', description: 'Salary', default_amount: 3000, extra_buffer: 0, include: true, monthly_schedule: every(), as_schedule: false },
  { id: 'p-food', kind: 'expense', envelope_id: 'food', description: 'Groceries', default_amount: -100, extra_buffer: 0, include: true, monthly_schedule: every(), as_schedule: false, account_id: 'chk' },
  { id: 'p-rent', kind: 'expense', envelope_id: 'rent', description: 'Rent', default_amount: -1000, extra_buffer: 500, include: true, monthly_schedule: every(), as_schedule: false, account_id: 'chk' },
];

function memoryStorage() {
  const m = new Map();
  return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k), clear: () => m.clear(), key: i => [...m.keys()][i] ?? null, get length() { return m.size; } };
}

const app = () => document.getElementById('app-root');
const spec = (id) => specs.findLast(s => s.id === `reports-${id}`);
const kpi = (i) => app().querySelectorAll('.kpi-row .kpi .val')[i];
const subtitle = (chart) => app().querySelector(`[data-chart="${chart}"] .card-title .sub`)?.textContent;

// The date range is the page's module state: each test starts on Year to date.
async function open(preset = 'ytd') {
  mountHosts();
  await render(app());
  app().querySelector(`.reports-preset[data-preset="${preset}"]`).click();
  await flush();
  await flush();
}

beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', (cb) => setTimeout(cb, 0));
  vi.stubGlobal('localStorage', memoryStorage());
  stubResizeObserver();
  resetState({ transactions: ledger() });
  state.accounts.push({ id: 'loan', name: 'Car loan', type: 'loan', initialBalance: -9000 });
  state.budgetItems = plan();
  // The page filter keeps this session's last save in memory too.
  savePageFilter('reports', BUDGET, { envelopes: [], payees: [] });
  specs.length = 0;
});

describe('the KPI strip', () => {
  it('shows the range\'s income, spending, saving (loan principal included) and net', async () => {
    await open();
    expect(kpi(0).textContent).toBe(fmt(6000));
    expect(kpi(1).textContent).toBe(fmt(2575));
    expect(kpi(2).textContent).toBe(fmt(650));
    expect(kpi(3).textContent).toBe(fmt(3425));
    expect(kpi(3).getAttribute('style')).toBe('');
  });

  it('paints a negative net in the danger colour', async () => {
    state.transactions = [...ledger(), { id: 'big', type: 'expense', date: '2026-09-01', payee: 'Car', amount: 9000, account: 'chk', envelope_id: 'fun', status: 'posted' }];
    await open();
    expect(kpi(3).textContent).toBe(fmt(-5575));
    expect(kpi(3).getAttribute('style')).toBe('color:var(--danger-text)');
  });

  it('clicks through to the range\'s transactions', async () => {
    await open();
    navigate.mockClear();
    for (const el of app().querySelectorAll('.reports-kpi')) el.click();
    expect(navigate.mock.calls).toEqual([
      ['transactions', { dateFrom: '2026-01-01', dateTo: '2026-09-15', type: 'income' }],
      ['transactions', { dateFrom: '2026-01-01', dateTo: '2026-09-15', type: 'expense' }],
      ['transactions', { dateFrom: '2026-01-01', dateTo: '2026-09-15' }],
    ]);
  });
});

describe('income vs spending', () => {
  it('draws the three series per month in the engine\'s colours, named in the UI language', async () => {
    await open();
    const s = spec('income-vs-spending');
    expect(s.x).toEqual([{ key: '2026-07', label: expect.any(String) }, { key: '2026-08', label: expect.any(String) }]);
    expect(s.series).toEqual([
      { id: 'Income', name: t('reports.kpiIncome'), color: '#10b981', values: [3000, 3000] },
      { id: 'Spending', name: t('reports.kpiSpending'), color: '#ef4444', values: [1200, 1375] },
      { id: 'Saving', name: t('reports.kpiSaving'), color: '#3b82f6', values: [0, 650] },
    ]);
    expect(subtitle('income-vs-spending')).toBe(t('reports.monthsCount')(2));
  });

  it('adds a hidden 12-month average per series, from the first month with data', async () => {
    await open();
    expect(spec('income-vs-spending').refLines).toEqual([
      { id: 'avg-Income', name: t('reports.avg12Of')(t('reports.kpiIncome')), value: 700, color: '#10b981', hidden: true },
      { id: 'avg-Spending', name: t('reports.avg12Of')(t('reports.kpiSpending')), value: 267.5, color: '#ef4444', hidden: true },
      { id: 'avg-Saving', name: t('reports.avg12Of')(t('reports.kpiSaving')), value: 65, color: '#3b82f6', hidden: true },
    ]);
  });

  it('leaves out the average of a series that is zero all through the window', async () => {
    state.transactions = ledger().filter(tx => tx.type !== 'account_transfer');
    await open();
    expect(spec('income-vs-spending').refLines.map(r => r.id)).toEqual(['avg-Income', 'avg-Spending']);
  });

  it('clicks a month through to that month', async () => {
    await open();
    navigate.mockClear();
    spec('income-vs-spending').onSelect({ key: '2026-08' });
    expect(navigate).toHaveBeenCalledWith('transactions', 'month:2026-08');
  });
});

describe('spending and saving by month', () => {
  it('draws spending per month with its 12-month average, in the spending colour', async () => {
    await open();
    const s = spec('spend-by-month');
    expect(s.x.map(p => p.key)).toEqual(['2026-07', '2026-08']);
    expect(s.series).toEqual([{ id: 'spending', name: t('reports.kpiSpending'), color: '#ef4444', values: [1200, 1375] }]);
    expect(s.refLines).toEqual([{ id: 'avg12', name: t('reports.avg12'), value: 267.5, color: '#ef4444' }]);
  });

  it('draws saving per month in the saving colour, a month with nothing saved at 0', async () => {
    await open();
    const s = spec('saving-by-month');
    // July has rows but none crossing the saving boundary: drawn, at 0, not left out.
    expect(s.x.map(p => p.key)).toEqual(['2026-07', '2026-08']);
    expect(s.series).toEqual([{ id: 'saving', name: t('reports.kpiSaving'), color: '#3b82f6', values: [0, 650] }]);
  });

  it('has no spending average line when the window spent nothing', async () => {
    state.transactions = ledger().filter(tx => tx.type !== 'expense' || tx.date >= '2026-09-01');
    await open();
    expect(spec('spend-by-month').refLines).toEqual([]);
  });
});

describe('spending by envelope and by payee', () => {
  it('ranks envelopes largest first, labelled Category · Name, and counts them in the subtitle', async () => {
    await open();
    expect(spec('spend-by-envelope').items).toEqual([
      { key: 'rent', label: 'housing · Rent', value: 2000 },
      { key: 'food', label: 'living · Food', value: 500 },
      { key: 'fun', label: 'living · Fun', value: 75 },
    ]);
    expect(subtitle('spend-by-envelope')).toBe(t('reports.envelopesCount')(3));
  });

  it('ranks payees, the no-payee row unclickable', async () => {
    await open();
    expect(spec('spend-by-payee').items).toEqual([
      { key: 'Landlord', label: 'Landlord', value: 2000 },
      { key: 'Supermarket', label: 'Supermarket', value: 500 },
      { key: 'Cinema', label: 'Cinema', value: 50 },
      { key: null, label: '(no payee)', value: 25 },
    ]);
    expect(subtitle('spend-by-payee')).toBe(t('reports.payeesCount')(4));
  });

  it('clicks an envelope or a payee through to its transactions in the range', async () => {
    await open();
    navigate.mockClear();
    spec('spend-by-envelope').onSelect({ key: 'rent' });
    spec('spend-by-payee').onSelect({ key: 'Landlord' });
    expect(navigate.mock.calls).toEqual([
      ['transactions', { envelope: 'rent', dateFrom: '2026-01-01', dateTo: '2026-09-15' }],
      ['transactions', { search: '"Landlord"', dateFrom: '2026-01-01', dateTo: '2026-09-15' }],
    ]);
  });
});

describe('top-N and sort on spending by envelope', () => {
  // Eight more envelopes, spending 80, 70, ... 10 in August.
  const extra = Array.from({ length: 8 }, (_, i) => ({ id: `m${i}`, name: `M${8 - i}`, category: 'misc' }));
  beforeEach(() => {
    state.envelopes = [...state.envelopes, ...extra];
    state.transactions = extra.map((e, i) => ({ id: `mx${i}`, type: 'expense', date: '2026-08-20', payee: `P${i}`, amount: 80 - 10 * i, account: 'chk', envelope_id: e.id, status: 'posted' }));
  });
  const labels = () => spec('spend-by-envelope').items.map(r => r.label);

  it('top 5 folds the rest into an unclickable Other (n) row; the subtitle counts every envelope', async () => {
    saveChartPrefs('reports-spend-by-envelope', { topN: 5, sort: 'amount' });
    await open();
    expect(spec('spend-by-envelope').items).toEqual([
      { key: 'm0', label: 'misc · M8', value: 80 },
      { key: 'm1', label: 'misc · M7', value: 70 },
      { key: 'm2', label: 'misc · M6', value: 60 },
      { key: 'm3', label: 'misc · M5', value: 50 },
      { key: 'm4', label: 'misc · M4', value: 40 },
      { key: null, label: 'Other (3)', value: 60 },
    ]);
    expect(subtitle('spend-by-envelope')).toBe(t('reports.envelopesCount')(8));
  });

  it('sort by name orders by the label and keeps Other last', async () => {
    saveChartPrefs('reports-spend-by-envelope', { topN: 5, sort: 'name' });
    await open();
    expect(labels()).toEqual(['misc · M4', 'misc · M5', 'misc · M6', 'misc · M7', 'misc · M8', 'Other (3)']);
    const pressed = [...app().querySelectorAll('[data-chart="spend-by-envelope"] .reports-chart-controls button')]
      .filter(b => b.getAttribute('aria-pressed') === 'true').map(b => b.textContent);
    expect(pressed).toEqual(['5', t('reports.sortName')]);
  });

  it('All shows every envelope with no Other row; 12 (the default) folds nothing here', async () => {
    saveChartPrefs('reports-spend-by-envelope', { topN: 0 });
    await open();
    expect(labels()).toHaveLength(8);
    expect(labels()).not.toContain('Other (3)');
    saveChartPrefs('reports-spend-by-envelope', {});
    await open();
    expect(labels()).toHaveLength(8);
    expect(subtitle('spend-by-envelope')).toBe(t('reports.envelopesCount')(8));
  });

  it('a top-N click saves the choice and re-renders', async () => {
    await open();
    const five = [...app().querySelectorAll('[data-chart="spend-by-envelope"] .reports-chart-controls button')].find(b => b.textContent === '5');
    five.click();
    await flush();
    await flush();
    expect(labels().at(-1)).toBe('Other (3)');
  });
});

describe('page filters', () => {
  it('an excluded envelope leaves spending, the envelope charts, the balances and the allocation', async () => {
    savePageFilter('reports', BUDGET, { envelopes: ['rent'], payees: [] });
    await open();
    expect(kpi(1).textContent).toBe(fmt(575));
    expect(spec('spend-by-envelope').items.map(r => r.key)).toEqual(['food', 'fun']);
    expect(spec('envelope-balances').items.map(r => r.key)).toEqual(['food', 'fun']);
    expect(spec('budget-allocation').items.map(r => r.key)).toEqual(['food']);
    expect(spec('envelope-balance-history').series[0].values.at(-1)).toBe(125);
    expect(app().querySelector('.page-head .sub').textContent).toContain(t('pageFilter.filtered'));
    expect(app().querySelector('#reports-exclusion-chip').children).toHaveLength(1);
  });

  it('an excluded payee drops its whole rows, and notes that balances are unaffected', async () => {
    savePageFilter('reports', BUDGET, { envelopes: [], payees: ['Supermarket'] });
    await open();
    expect(kpi(1).textContent).toBe(fmt(2075));
    expect(spec('spend-by-payee').items.map(r => r.label)).toEqual(['Landlord', 'Cinema', '(no payee)']);
    expect(spec('income-vs-spending').refLines.find(r => r.id === 'avg-Spending').value).toBe(207.5);
    expect([...app().querySelectorAll('.reports-card-note')].map(n => n.closest('[data-chart]').dataset.chart))
      .toEqual(['envelope-balance-history', 'envelope-balances']);
    expect(spec('envelope-balances').items.map(r => r.value)).toEqual([-1000, 100, 25]);
  });

  it('the exclude picker ranks the period\'s payees by spending, ignoring the exclusions', async () => {
    savePageFilter('reports', BUDGET, { envelopes: ['rent'], payees: [] });
    await open();
    app().querySelector('#reports-exclude').click();
    document.querySelector('#exclude-picker-tab-payees').click();
    const names = [...document.querySelectorAll('.exclude-picker-row span')].map(s => s.textContent);
    expect(names).toEqual(['Landlord', 'Supermarket', 'Cinema', 'Job']);
  });
});

describe('balances (through the lens)', () => {
  it('Booked: every envelope\'s balance, largest first, red when overspent', async () => {
    await open();
    expect(spec('envelope-balances').items).toEqual([
      { key: 'rent', label: 'housing · Rent', value: -1000, color: 'var(--danger)' },
      { key: 'food', label: 'living · Food', value: 100, color: 'var(--success)' },
      { key: 'fun', label: 'living · Fun', value: 25, color: 'var(--success)' },
    ]);
  });

  it('Today: the scheduled rent is not taken yet', async () => {
    prefs.lens = 'today';
    await open();
    expect(spec('envelope-balances').items.map(r => [r.key, r.value])).toEqual([['food', 100], ['fun', 25], ['rent', 0]]);
    expect(spec('envelope-balance-history').series[0].values.at(-1)).toBe(125);
  });

  it('the history ends with this month, Booked', async () => {
    await open();
    const s = spec('envelope-balance-history');
    expect(s.x).toHaveLength(12);
    expect(s.x.at(-1).key).toBe('2026-09');
    expect(s.series).toHaveLength(1);
    expect(s.series[0]).toMatchObject({ id: 'total', name: t('reports.totalEnvBalance') });
    expect(s.series[0].values.slice(-3)).toEqual([1500, 125, -875]);
    expect(subtitle('envelope-balance-history')).toBe(t('reports.monthsAllEnv')(12));
  });

  it('a picked envelope gets its own line, named Category · Name', async () => {
    saveChartPrefs('reports-envelope-balance-history', { envelopes: ['food', 'gone'] });
    await open();
    const s = spec('envelope-balance-history');
    const food = state.envelopes.find(e => e.id === 'food');
    expect(s.series.map(x => x.id)).toEqual(['total', 'env:food']);
    expect(s.series[1].name).toBe(`${trCat('living')} · ${trEnv(food)}`);
    expect(s.series[1].values.slice(-3)).toEqual([400, 100, 100]);
    expect(app().querySelector('[data-chart="envelope-balance-history"] .reports-chart-controls button').textContent)
      .toBe(t('reports.envelopesButton')(1));
  });
});

describe('budget allocation', () => {
  it('the plan\'s year per envelope, buffers included', async () => {
    await open();
    expect(spec('budget-allocation').items).toEqual([
      { key: 'rent', label: 'housing · Rent', value: 12500 },
      { key: 'food', label: 'living · Food', value: 1200 },
    ]);
    expect(subtitle('budget-allocation')).toBe(t('reports.envelopesCount')(2));
  });

  it('past ten envelopes, the rest fold into Other, counted as one in the subtitle', async () => {
    const extra = Array.from({ length: 11 }, (_, i) => ({ id: `a${i}`, name: `A${i}`, category: 'misc' }));
    state.envelopes = [...state.envelopes, ...extra];
    state.budgetItems = extra.map((e, i) => ({ id: `pa${i}`, kind: 'expense', envelope_id: e.id, description: e.name, default_amount: -(10 + i), extra_buffer: 0, include: true, monthly_schedule: every(), as_schedule: false, account_id: 'chk' }));
    await open();
    const items = spec('budget-allocation').items;
    expect(items).toHaveLength(11);
    expect(items.at(-1)).toEqual({ key: null, label: 'Other (1)', value: 120 });
    expect(subtitle('budget-allocation')).toBe(t('reports.envelopesCount')(11));
  });
});

describe('ranges', () => {
  it('All time spans every month with rows, the scheduled one\'s too; the averages end with last month', async () => {
    await open('all');
    expect(spec('income-vs-spending').x.map(p => p.key)).toEqual(['2025-11', '2026-07', '2026-08', '2026-09']);
    expect(spec('income-vs-spending').series.map(x => x.values)).toEqual([[1000, 3000, 3000, 0], [100, 1200, 1375, 0], [0, 0, 650, 0]]);
    expect(kpi(0).textContent).toBe(fmt(7000));
    expect(spec('spend-by-month').refLines[0].value).toBe(267.5);
  });

  it('a range that ends in the past averages up to its own end', async () => {
    mountHosts();
    await render(app());
    const to = app().querySelector('#reports-to');
    to.value = '2026-07-31';
    to.dispatchEvent(new Event('change'));
    await flush();
    await flush();
    expect(kpi(0).textContent).toBe(fmt(4000));
    // Aug 2025 .. Jul 2026 from Nov 2025: 9 months, spending 100 + 1200.
    expect(spec('spend-by-month').refLines[0].value).toBe(Math.round((1300 / 9) * 100) / 100);
    expect(app().querySelector('.page-head .sub').textContent).toBe(t('reports.rangeTo')('—', fmtDateLang('2026-07-31')));
  });
});

describe('a failed query', () => {
  it('leaves that card empty and the rest of the page drawn', async () => {
    const real = session.query.bind(session);
    const spy = vi.spyOn(session, 'query').mockImplementation((name, input) => (name === 'reports.balances' ? { ok: false, error: { code: 'bad_input' } } : real(name, input)));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await open();
      expect(app().querySelector('[data-chart="envelope-balances"] .bv-chart-empty')).not.toBeNull();
      expect(spec('envelope-balances').items).toEqual([]);
      expect(kpi(0).textContent).toBe(fmt(6000));
    } finally {
      spy.mockRestore();
      warn.mockRestore();
    }
  });

  it('a failed cashflow leaves the KPI figures off', async () => {
    const real = session.query.bind(session);
    const spy = vi.spyOn(session, 'query').mockImplementation((name, input) => (name === 'reports.cashflow' ? { ok: false, error: { code: 'bad_input' } } : real(name, input)));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await open();
      expect([0, 1, 2, 3].map(i => kpi(i).textContent)).toEqual(['—', '—', '—', '—']);
      for (const chart of ['income-vs-spending', 'spend-by-month', 'saving-by-month']) {
        expect(app().querySelector(`[data-chart="${chart}"] .bv-chart-empty`), chart).not.toBeNull();
      }
      expect(spec('spend-by-envelope').items).toHaveLength(3);
    } finally {
      spy.mockRestore();
      warn.mockRestore();
    }
  });
});

describe('what the page asks', () => {
  it('one date per render; the balance figures with the active lens, the rest on the stored rows', async () => {
    prefs.lens = 'forecast';
    prefs.lensHorizon = '3m';
    saveChartPrefs('reports-envelope-balance-history', { envelopes: ['food'] });
    savePageFilter('reports', BUDGET, { envelopes: ['fun'], payees: ['Cinema'] });
    await open();
    const spy = vi.spyOn(session, 'query');
    try {
      app().querySelector('.reports-preset[data-preset="ytd"]').click();
      await flush();
      await flush();
      const range = { from: '2026-01-01', to: '2026-09-15' };
      const ex = { excludeEnvelopes: ['fun'], excludePayees: ['Cinema'] };
      const lens = { lens: 'forecast', horizon: '3m' };
      expect(spy.mock.calls).toEqual([
        ['reports.spending', { groupBy: 'envelope', ...range, topN: 12, ...ex }],
        ['reports.cashflow', { ...range, date: '2026-09-15', ...ex }],
        ['reports.balances', { ...lens, topN: 15, excludeEnvelopes: ['fun'] }],
        ['plan.allocation', { top: 10, date: '2026-09-15', excludeEnvelopes: ['fun'] }],
        ['envelopes.history', { ...lens, months: 12, date: '2026-09-15', envelopes: ['food'], excludeEnvelopes: ['fun'] }],
        ['reports.spending', { groupBy: 'payee', ...range, topN: 12, ...ex }],
      ]);
      // All time: no range bounds at all.
      spy.mockClear();
      app().querySelector('.reports-preset[data-preset="all"]').click();
      await flush();
      await flush();
      expect(spy.mock.calls[0]).toEqual(['reports.spending', { groupBy: 'envelope', topN: 12, ...ex }]);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('one clock per render', () => {
  it('dates the head and every CSV name by the render\'s range, even when the clock moves on', async () => {
    await open('12m');
    // The render reads the clock first; anything after it would see the next day.
    now.mockImplementationOnce(() => new Date(FIXED_NOW)).mockImplementation(() => new Date(2026, 8, 16, 0, 0, 1));
    try {
      specs.length = 0;
      app().querySelector('.reports-preset[data-preset="12m"]').click();
      await flush();
      await flush();
      const names = specs.map(s => s.csvName).filter(Boolean);
      expect(names).toHaveLength(8);
      for (const name of names) expect(name).toContain(' 2025-09-01 2026-09-15');
      expect(app().querySelector('.page-head .sub').textContent)
        .toBe(t('reports.rangeTo')(fmtDateLang('2025-09-01'), fmtDateLang('2026-09-15')));
    } finally {
      now.mockImplementation(() => new Date(FIXED_NOW));
    }
  });
});
