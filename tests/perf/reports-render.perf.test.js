// @vitest-environment jsdom
// Reports render timing on a generated 5,000-row ledger, all-time range, six
// picked envelopes on the balance history (the most work the page does: every
// aggregate, the 12-month averages, the total history and a line per pick).
// Skipped unless PERF=1, so the suite never depends on machine speed:
//
//   PERF=1 npx vitest run tests/perf/reports-render.perf.test.js --reporter=verbose
//
// Each cold run gets fresh copies of the collections, so the engine's
// identity caches start cold as they do after a write; the median of five
// runs is printed. A top-N click (a re-render over the same data) is timed
// too, median of nine clicks.
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../js/app.js', async () => (await import('../_fakes/pageApp.js')).appStub);

import { render } from '../../js/pages/reports.js';
import { saveChartPrefs } from '../../js/ui/charts/persist.js';
import { t } from '../../js/ui/i18n.js';
import { state, resetState, mountHosts } from '../_fakes/pageApp.js';
import { stubResizeObserver } from '../_fakes/resizeObserver.js';

const ROWS = 5000;
const RUNS = 5;
const CLICKS = 9;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const every = () => Object.fromEntries(MONTHS.map(m => [m, true]));
const ENVELOPES = ['food', 'fun', 'rent', 'car', 'power', 'gym', 'gifts', 'travel', 'kids', 'misc', 'pets', 'books', 'phone', 'tax'];

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
    txs.push({ id: `f${++id}`, type: 'fill', date: `${ym}-02`, status, source: 'allocation',
      lines: ENVELOPES.map(e => ({ envelope_id: e, mode: 'add', amount: 250 })) });
  }
  while (txs.length < ROWS) {
    const k = Math.floor(rand() * 24);
    const y = 2024 + Math.floor((k + 10) / 12);
    const m = (k + 10) % 12 + 1;
    const d = 1 + Math.floor(rand() * 28);
    const date = `${y}-${pad(m)}-${pad(d)}`;
    txs.push({
      id: `e${++id}`, type: 'expense', date, payee: `Payee ${Math.floor(rand() * 200)}`,
      amount: Math.round(rand() * 8000) / 100, account: 'chk', envelope_id: ENVELOPES[Math.floor(rand() * ENVELOPES.length)],
      status: date > '2026-09-15' ? 'scheduled' : 'posted',
    });
  }
  return txs;
}

const plan = () => ENVELOPES.map((e, i) => ({
  id: `p-${e}`, kind: 'expense', envelope_id: e, description: `Plan ${e}`, default_amount: -(100 + 25 * i), extra_buffer: 0, include: true,
  monthly_schedule: every(), as_schedule: false, account_id: 'chk',
}));

// jsdom's localStorage is not usable under every Node; a plain map is all the
// page's chart prefs need.
function memoryStorage() {
  const m = new Map();
  return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k), clear: () => m.clear() };
}

const settle = () => new Promise(r => setTimeout(r, 20));
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

describe.skipIf(!process.env.PERF)('Reports render timing', () => {
  it(`renders a ${ROWS}-row ledger, all time, six picked envelopes; median of ${RUNS}`, async () => {
    vi.stubGlobal('requestAnimationFrame', (cb) => setTimeout(cb, 0));
    stubResizeObserver();
    vi.stubGlobal('localStorage', memoryStorage());
    saveChartPrefs('reports-envelope-balance-history', { envelopes: ENVELOPES.slice(0, 6) });
    const rows = generate();
    const fresh = () => {
      resetState({ transactions: rows.map(r => ({ ...r })) });
      state.envelopes = ENVELOPES.map(id => ({ id, name: id, category: 'living' }));
      state.budgetItems = plan();
      mountHosts();
    };
    // The page's range is module state: pick All time once, on a throwaway render.
    fresh();
    await render(document.getElementById('app-root'));
    document.querySelector('.reports-preset[data-preset="all"]').click();
    await settle();

    const times = [];
    for (let i = 0; i < RUNS; i++) {
      fresh();
      const t0 = performance.now();
      await render(document.getElementById('app-root'));
      times.push(performance.now() - t0);
      await settle();
    }
    expect(document.querySelectorAll('.chart-slot').length).toBe(8);

    // A top-N click: re-renders the page over the same data.
    const clicks = [];
    for (let i = 0; i < CLICKS; i++) {
      const label = ['5', '12', t('reports.topAll')][i % 3];
      const btn = [...document.querySelectorAll('[data-chart="spend-by-envelope"] .reports-chart-controls button')]
        .find(b => b.textContent === label);
      const t0 = performance.now();
      btn.click();
      await new Promise(r => setTimeout(r, 0));
      await new Promise(r => setTimeout(r, 0));
      clicks.push(performance.now() - t0);
      await settle();
    }
    console.log(`[perf] reports render, ${ROWS} rows, all time, 6 picks: median ${median(times).toFixed(1)} ms (runs: ${times.map(x => x.toFixed(1)).join(', ')}); top-N re-render median ${median(clicks).toFixed(1)} ms`);
  }, 120000);
});
