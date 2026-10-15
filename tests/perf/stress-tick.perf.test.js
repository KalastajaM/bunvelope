// @vitest-environment jsdom
// Stress page slider-tick timing: 200 plan items, one cut slider dragged
// through 50 positions, each `input` event timed (the live repaint of the six
// scenario rows and the open detail rows). Skipped unless PERF=1, so the suite
// never depends on machine speed:
//
//   PERF=1 npx vitest run tests/perf/stress-tick.perf.test.js --reporter=verbose
//
// The median tick is printed for the Booked and the Forecast (3 months) view.
// The `change` event is never fired, so nothing is queued or dispatched.
import { describe, it, expect, vi } from 'vitest';

// The page reads the lens through stress.runway (the session's lensRows), so
// the Forecast run walks the rows the app would.
vi.mock('../../js/app.js', async () => (await import('../_fakes/pageApp.js')).appStub);

import { render } from '../../js/pages/stress.js';
import { state, prefs, resetState, mountHosts, flush, setValue } from '../_fakes/pageApp.js';

const ITEMS = 200;
const ROWS = 2000;
const TICKS = 50;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const ENVELOPES = ['food', 'fun', 'rent', 'car', 'power', 'gym', 'gifts', 'travel', 'kids', 'misc'];
const CATS = ['A', 'B', 'C', 'D', 'E', 'Z', null];

// Deterministic: a small LCG, so every run times the same budget.
function rng(seed) {
  let s = seed;
  return () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; };
}

function plan() {
  const rand = rng(7);
  const items = [{ id: 'sal', kind: 'income', envelope_id: null, description: 'Salary', default_amount: 4000, extra_buffer: 0, include: true,
    monthly_schedule: Object.fromEntries(MONTHS.map(m => [m, true])), as_schedule: false, stress_category: 'C', stress_cut_pcts: { A: 0.5, B: 0.3, C: 0.1 } }];
  // The first expense is category E (hit by every scenario) with a map, so
  // its slider exists in scenario A.
  for (let i = 1; i < ITEMS; i++) {
    const cat = i === 1 ? 'E' : CATS[Math.floor(rand() * CATS.length)];
    const sched = Object.fromEntries(MONTHS.map(m => [m, rand() < 0.85 ? true : (rand() < 0.5 ? false : -Math.round(rand() * 300))]));
    const legacy = rand() < 0.3;
    const cuts = cat && cat !== 'Z'
      ? Object.fromEntries(['A', 'B', 'C', 'D', 'E'].filter(s => s <= cat).map(s => [s, Math.round(rand() * 100) / 100]))
      : undefined;
    items.push({
      id: `p${i}`, kind: 'expense', envelope_id: ENVELOPES[i % ENVELOPES.length], description: `Item ${i}`,
      default_amount: -Math.round(rand() * 50000) / 100, extra_buffer: rand() < 0.1 ? 100 : 0, include: rand() > 0.05,
      monthly_schedule: sched, as_schedule: false, stress_category: cat,
      stress_cut_pct: legacy && cuts ? 0.25 : 0, stress_cut_pcts: legacy ? undefined : cuts,
      ...(rand() < 0.05 ? { end_month: '2026-08' } : {}),
    });
  }
  return items;
}

function ledger() {
  const rand = rng(42);
  const pad = n => String(n).padStart(2, '0');
  const txs = [];
  for (let i = 0; i < ROWS; i++) {
    const m = 1 + Math.floor(rand() * 12);
    const d = 1 + Math.floor(rand() * 28);
    const date = `2026-${pad(m)}-${pad(d)}`;
    txs.push({ id: `e${i}`, type: 'expense', date, payee: `Payee ${i % 50}`, amount: Math.round(rand() * 8000) / 100,
      account: rand() < 0.5 ? 'chk' : 'sav', envelope_id: ENVELOPES[i % ENVELOPES.length], status: date > '2026-09-15' ? 'scheduled' : 'posted' });
  }
  return txs;
}

async function tickMedian(lens) {
  resetState({ transactions: ledger() });
  state.accounts = [
    { id: 'chk', name: 'Checking', type: 'bank', initialBalance: 50000 },
    { id: 'sav', name: 'Savings', type: 'savings', initialBalance: 30000 },
  ];
  state.envelopes = ENVELOPES.map(id => ({ id, name: id, category: 'living' }));
  state.budgetItems = plan();
  if (lens === 'forecast') Object.assign(prefs, { lens: 'forecast', lensHorizon: '3m' });
  mountHosts();
  await render(document.getElementById('app-root'));
  document.querySelector('.stress-row[data-scenario="A"]').click();
  await flush();
  const slider = document.querySelector('.stress-detail-trow[data-item-id="p1"] .stress-slider');
  expect(slider).toBeTruthy();
  const times = [];
  for (let i = 0; i < TICKS; i++) {
    const t0 = performance.now();
    setValue(slider, String((i * 7) % 101), ['input']);
    times.push(performance.now() - t0);
  }
  const sorted = [...times].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

describe.skipIf(!process.env.PERF)('Stress slider-tick timing', () => {
  it(`${ITEMS} plan items, ${TICKS} ticks; median per tick`, async () => {
    const booked = await tickMedian('booked');
    const forecast = await tickMedian('forecast');
    console.log(`[perf] stress tick, ${ITEMS} items, ${ROWS} rows: booked median ${booked.toFixed(2)} ms, forecast median ${forecast.toFixed(2)} ms`);
  }, 120000);
});
