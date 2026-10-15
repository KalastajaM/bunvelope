// @vitest-environment jsdom
// Dashboard render timing on a generated 5,000-row ledger. Skipped unless
// PERF=1, so the suite never depends on machine speed:
//
//   PERF=1 npx vitest run tests/perf/dashboard-render.perf.test.js --reporter=verbose
//
// Each run gets fresh copies of the collections, so the engine's identity
// caches start cold as they do after a write; the median of five runs is
// printed. The deferred idle work (act-on alert, fill %) is let finish
// between runs and is not timed.
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../js/app.js', async () => (await import('../_fakes/pageApp.js')).appStub);

import { render } from '../../js/pages/dashboard.js';
import { state, resetState, mountHosts } from '../_fakes/pageApp.js';
import { stubResizeObserver } from '../_fakes/resizeObserver.js';

const ROWS = 5000;
const RUNS = 5;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const every = () => Object.fromEntries(MONTHS.map(m => [m, true]));

// Deterministic: a small LCG, so every run times the same ledger.
function rng(seed) {
  let s = seed;
  return () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; };
}

const ENVELOPES = [
  ['food', 'living'], ['fun', 'living'], ['rent', 'housing'], ['car', 'transport'], ['power', 'utilities'],
  ['gym', 'leisure'], ['gifts', 'other'], ['travel', 'leisure'], ['kids', 'family'], ['misc', 'other'],
];

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
    const future = ym > '2026-09';
    const status = future ? 'scheduled' : 'posted';
    txs.push({ id: `i${++id}`, type: 'income', date: `${ym}-01`, payee: 'Job', amount: 4000, account: 'chk', status });
    txs.push({ id: `f${++id}`, type: 'fill', date: `${ym}-02`, status, source: 'allocation',
      lines: ENVELOPES.map(([e]) => ({ envelope_id: e, mode: 'add', amount: 300 })) });
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
    const [env] = ENVELOPES[Math.floor(rand() * ENVELOPES.length)];
    const onCard = rand() < 0.3;
    txs.push({
      id: `e${++id}`, type: 'expense', date, payee: `Payee ${Math.floor(rand() * 200)}`,
      amount: Math.round(rand() * 8000) / 100, account: onCard ? 'cc' : 'chk', envelope_id: env,
      status: date > '2026-09-15' ? 'scheduled' : 'posted',
    });
  }
  return txs;
}

const plan = () => [
  { id: 'sal', kind: 'income', envelope_id: null, description: 'Salary', default_amount: 4000, extra_buffer: 0, include: true, monthly_schedule: every(), as_schedule: false },
  ...ENVELOPES.map(([e], i) => ({
    id: `p-${e}`, kind: 'expense', envelope_id: e, description: `Plan ${e}`, default_amount: -250, extra_buffer: 0, include: true,
    monthly_schedule: every(), as_schedule: i % 3 === 0, account_id: 'chk', payment_day: 5 + i, schedule_day_type: 'exact', as_schedule_since: '2025-01-01',
  })),
];

const settle = () => new Promise(r => setTimeout(r, 20));

describe.skipIf(!process.env.PERF)('Dashboard render timing', () => {
  it(`renders a ${ROWS}-row ledger; median of ${RUNS}`, async () => {
    vi.stubGlobal('requestAnimationFrame', (cb) => setTimeout(cb, 0));
    stubResizeObserver();
    const rows = generate();
    const times = [];
    for (let i = 0; i < RUNS; i++) {
      resetState({ transactions: rows.map(r => ({ ...r })) });
      state.accounts = [
        { id: 'chk', name: 'Checking', type: 'bank', initialBalance: 1000 },
        { id: 'sav', name: 'Savings', type: 'savings', initialBalance: 500 },
        { id: 'cc', name: 'Visa', type: 'credit_card', initialBalance: 0 },
        { id: 'inv', name: 'Broker', type: 'investment', initialBalance: 0 },
      ];
      state.envelopes = ENVELOPES.map(([id, category]) => ({ id, name: id, category }));
      state.budgetItems = plan();
      state.meta = { investments: { prices: { ABC: { price: 55, asOf: '2026-09-14' } } } };
      mountHosts();
      const t0 = performance.now();
      await render(document.getElementById('app-root'));
      times.push(performance.now() - t0);
      await settle();
    }
    expect(document.querySelector('.page-dashboard .overview-top')).toBeTruthy();
    const sorted = [...times].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    console.log(`[perf] dashboard render, ${ROWS} rows: median ${median.toFixed(1)} ms (runs: ${times.map(t => t.toFixed(1)).join(', ')})`);
  }, 120000);
});
