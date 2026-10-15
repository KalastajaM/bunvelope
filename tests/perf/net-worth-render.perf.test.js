// @vitest-environment jsdom
// Net worth render timing on a generated 5,000-row ledger with a what-if
// scenario selected (four simulation runs, the history, the projection and
// its table). Skipped unless PERF=1, so the suite never depends on machine
// speed:
//
//   PERF=1 npx vitest run tests/perf/net-worth-render.perf.test.js --reporter=verbose
//
// Each cold run gets fresh copies of the collections, so the engine's
// identity caches start cold as they do after a write; the median of five
// runs is printed. The horizon toggle (a repaint of the projection over the
// cached runs) is timed too, median of fifteen clicks.
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../js/app.js', async () => (await import('../_fakes/pageApp.js')).appStub);

import { render } from '../../js/pages/net-worth.js';
import { t } from '../../js/ui/i18n.js';
import { saveChartPrefs } from '../../js/ui/charts/persist.js';
import { state, resetState, mountHosts } from '../_fakes/pageApp.js';
import { stubResizeObserver } from '../_fakes/resizeObserver.js';

const ROWS = 5000;
const RUNS = 5;
const CLICKS = 15;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const every = () => Object.fromEntries(MONTHS.map(m => [m, true]));
const ENVELOPES = ['food', 'fun', 'rent', 'car', 'power', 'gym', 'gifts', 'travel', 'kids', 'misc'];

// Deterministic: a small LCG, so every run times the same ledger.
function rng(seed) {
  let s = seed;
  return () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; };
}

function generate() {
  const rand = rng(42);
  const pad = n => String(n).padStart(2, '0');
  const txs = [];
  let id = 0;
  // 24 months ending Oct 2026 (one month past the fixed now, 15 Sep 2026).
  for (let k = 0; k < 24; k++) {
    const y = 2024 + Math.floor((k + 10) / 12);
    const m = (k + 10) % 12 + 1;
    const ym = `${y}-${pad(m)}`;
    const status = ym > '2026-09' ? 'scheduled' : 'posted';
    txs.push({ id: `i${++id}`, type: 'income', date: `${ym}-01`, payee: 'Job', amount: 4000, account: 'chk', status });
    txs.push({ id: `t${++id}`, type: 'account_transfer', date: `${ym}-03`, amount: 200, from_account: 'chk', to_account: 'sav', status });
    txs.push({ id: `b${++id}`, type: 'investment_transfer', direction: 'buy', date: `${ym}-04`, payee: 'Broker', amount: 100,
      units: 2, symbol: 'ABC', from_account: 'chk', to_account: 'inv', status });
  }
  while (txs.length < ROWS) {
    const k = Math.floor(rand() * 24);
    const y = 2024 + Math.floor((k + 10) / 12);
    const m = (k + 10) % 12 + 1;
    const d = 1 + Math.floor(rand() * 28);
    const date = `${y}-${pad(m)}-${pad(d)}`;
    txs.push({
      id: `e${++id}`, type: 'expense', date, payee: `Payee ${Math.floor(rand() * 200)}`,
      amount: Math.round(rand() * 8000) / 100, account: rand() < 0.3 ? 'cc' : 'chk', envelope_id: ENVELOPES[Math.floor(rand() * ENVELOPES.length)],
      status: date > '2026-09-15' ? 'scheduled' : 'posted',
    });
  }
  return txs;
}

const plan = () => [
  { id: 'sal', kind: 'income', envelope_id: null, account_id: 'chk', description: 'Salary', default_amount: 4000, extra_buffer: 0, include: true,
    monthly_schedule: every(), as_schedule: true, payment_day: 25, schedule_day_type: 'exact', as_schedule_since: '2025-01-01' },
  ...ENVELOPES.map((e, i) => ({
    id: `p-${e}`, kind: 'expense', envelope_id: e, description: `Plan ${e}`, default_amount: -250, extra_buffer: 0, include: true,
    monthly_schedule: every(), as_schedule: i % 3 === 0, account_id: 'chk', payment_day: 5 + i, schedule_day_type: 'exact', as_schedule_since: '2025-01-01',
    stress_category: 'B', stress_cut_pcts: { A: 0.5, B: 0.3 },
  })),
  { id: 'mortgage', kind: 'loan_payment', description: 'Home loan', envelope_id: 'rent', account_id: 'chk', to_account_id: 'mtg',
    default_amount: -1200, monthly_schedule: every(), payment_day: 5, as_schedule: true, as_schedule_since: '2026-10-01',
    include: true, schedule_day_type: 'exact', loan_method: 'annuity', loan_end: '2051-09' },
];

const accounts = () => [
  { id: 'chk', name: 'Checking', type: 'bank', initialBalance: 1000 },
  { id: 'sav', name: 'Savings', type: 'savings', initialBalance: 5000, interestTiers: [{ upTo: 10000, rate: 2 }, { rate: 0.5 }] },
  { id: 'cc', name: 'Visa', type: 'credit_card', initialBalance: 0 },
  { id: 'inv', name: 'Broker', type: 'investment', initialBalance: 10000, expectedGrowth: 5 },
  { id: 'house', name: 'House', type: 'asset', initialBalance: 200000, expectedGrowth: 1 },
  { id: 'mtg', name: 'Mortgage', type: 'loan', initialBalance: -100000, interestRates: [{ from: '2020-01-01', rate: 3 }] },
];

const scenarios = () => [
  { id: 'trip', name: 'Trip', changes: [
    { type: 'oneoff', date: '2027-02-10', amount: -2500, account: 'chk', label: 'Trip' },
    { type: 'stress', scenario: 'B', from: '2026-11' },
  ] },
];

// jsdom's localStorage is not usable under every Node; a plain map is all the
// page's chart prefs need.
function memoryStorage() {
  const m = new Map();
  return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k), clear: () => m.clear() };
}

const settle = () => new Promise(r => setTimeout(r, 20));
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

describe.skipIf(!process.env.PERF)('Net worth render timing', () => {
  it(`renders a ${ROWS}-row ledger with a what-if selected; median of ${RUNS}`, async () => {
    vi.stubGlobal('requestAnimationFrame', (cb) => setTimeout(cb, 0));
    stubResizeObserver();
    vi.stubGlobal('localStorage', memoryStorage());
    saveChartPrefs('nw-projection', { whatIf: 'trip' });
    const rows = generate();
    const times = [];
    for (let i = 0; i < RUNS; i++) {
      resetState({ transactions: rows.map(r => ({ ...r })) });
      state.accounts = accounts();
      state.envelopes = ENVELOPES.map(id => ({ id, name: id, category: 'living' }));
      state.budgetItems = plan();
      state.meta = { country: 'FI', whatIfScenarios: scenarios() };
      mountHosts();
      const t0 = performance.now();
      await render(document.getElementById('app-root'));
      times.push(performance.now() - t0);
      await settle();
    }
    expect(document.querySelector('.net-worth-table tbody tr')).toBeTruthy();
    expect(document.querySelector('.net-worth-whatif-row select').value).toBe('trip');

    // The horizon toggle: a repaint of the projection over the cached runs.
    const clicks = [];
    const btn = (y) => [...document.querySelectorAll('.net-worth-horizons > .btn')].find(b => b.textContent === t('netWorth.horizon')(y));
    for (let i = 0; i < CLICKS; i++) {
      const y = [5, 20, 10][i % 3];
      const t0 = performance.now();
      btn(y).click();
      clicks.push(performance.now() - t0);
    }
    console.log(`[perf] net worth render, ${ROWS} rows, what-if: median ${median(times).toFixed(1)} ms (runs: ${times.map(x => x.toFixed(1)).join(', ')}); horizon toggle median ${median(clicks).toFixed(2)} ms`);
  }, 120000);
});
