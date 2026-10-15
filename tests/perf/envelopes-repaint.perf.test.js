// @vitest-environment jsdom
// Envelopes page repaint timing: 5,000 rows, 30 envelopes (each with a plan
// item and a monthly template fill), a five-character search typed one key at
// a time. The page repaints on every input event, so each keystroke's repaint
// is timed alone. The search matches every envelope at every key, the most
// rows a keystroke can paint. Skipped unless PERF=1, so the suite never
// depends on machine speed:
//
//   PERF=1 npx vitest run tests/perf/envelopes-repaint.perf.test.js --reporter=verbose
//
// Printed for the card and the list view: the median and the total of the
// five keystrokes, and the first paint.
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../js/app.js', async () => (await import('../_fakes/pageApp.js')).appStub);

import { render } from '../../js/pages/envelopes.js';
import { state, prefs, resetState, mountHosts, setValue } from '../_fakes/pageApp.js';

const ROWS = 5000;
const ENVELOPES = 30;
const QUERY = 'Envel';
const pad = n => String(n).padStart(2, '0');
const every = Object.fromEntries(['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'].map(m => [m, true]));

// Deterministic: a small LCG, so every run times the same budget.
function rng(seed) {
  let s = seed;
  return () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; };
}

function budget() {
  const rand = rng(42);
  const ids = Array.from({ length: ENVELOPES }, (_, i) => `env${pad(i + 1)}`);
  const cats = ['living', 'housing', 'transport', 'leisure', 'saving'];
  const txs = [];
  for (let i = 0; i < ROWS; i++) {
    const y = 2025 + Math.floor(rand() * 2);
    const m = 1 + Math.floor(rand() * (y === 2026 ? 9 : 12));
    const d = 1 + Math.floor(rand() * 28);
    const date = `${y}-${pad(m)}-${pad(d)}`;
    if (i % 25 === 0) {
      txs.push({ id: `f${i}`, type: 'fill', date, payee: 'Fill', status: 'posted',
        lines: ids.map(e => ({ envelope_id: e, mode: 'add', amount: Math.round(rand() * 20000) / 100 })) });
      continue;
    }
    txs.push({ id: `e${i}`, type: 'expense', date, payee: `Payee ${i % 50}`,
      amount: Math.round(rand() * 8000) / 100, account: rand() < 0.5 ? 'chk' : 'sav',
      envelope_id: ids[i % ids.length], status: 'posted' });
  }
  resetState({ transactions: txs });
  state.envelopes = ids.map((id, i) => ({ id, name: `Envelope ${pad(i + 1)}`, category: cats[i % cats.length] }));
  state.budgetItems = ids.map((id, i) => ({
    id: `item${i}`, kind: 'expense', envelope_id: id, description: `Item ${i}`, default_amount: -(50 + i * 10),
    extra_buffer: 0, include: true, monthly_schedule: every, as_schedule: i % 3 === 0,
    ...(i % 3 === 0 ? { account_id: 'chk', payment_day: 5 + (i % 20), schedule_day_type: 'exact', as_schedule_since: '2026-01-01' } : {}),
  }));
  state.envelopeTemplates = [{
    id: 'tpl', name: 'Monthly fill', kind: 'manual',
    lines: ids.map((id, i) => ({ envelope_id: id, mode: 'add', amount: 50 + i * 10 })),
    schedule: { enabled: true, payment_day: 1, day_type: 'exact', months: every },
  }];
}

async function typeSearch(view) {
  budget();
  prefs.envView = view;
  mountHosts();
  const t0 = performance.now();
  await render(document.getElementById('app-root'));
  const firstPaint = performance.now() - t0;
  const input = document.querySelector('.search input');
  expect(input).toBeTruthy();
  const times = [];
  for (let i = 1; i <= QUERY.length; i++) {
    const k0 = performance.now();
    setValue(input, QUERY.slice(0, i), ['input']);
    times.push(performance.now() - k0);
  }
  expect(document.querySelectorAll('[data-env-id]').length).toBe(ENVELOPES);
  const sorted = [...times].sort((a, b) => a - b);
  return { firstPaint, times, median: sorted[Math.floor(sorted.length / 2)], total: times.reduce((a, b) => a + b, 0) };
}

describe.skipIf(!process.env.PERF)('Envelopes repaint timing', () => {
  it(`${ROWS} rows, ${ENVELOPES} envelopes, a ${QUERY.length}-key search`, async () => {
    vi.stubGlobal('requestAnimationFrame', () => 0);
    for (const view of ['card', 'list']) {
      // A warm-up run, then the timed one.
      await typeSearch(view);
      const r = await typeSearch(view);
      console.log(`[perf] envelopes search, ${ROWS} rows, ${ENVELOPES} envelopes, ${view} view: `
        + `keystroke median ${r.median.toFixed(2)} ms, ${QUERY.length} keys ${r.total.toFixed(2)} ms, first paint ${r.firstPaint.toFixed(2)} ms; per key ${r.times.map(x => x.toFixed(1)).join(' / ')}`);
    }
  }, 300000);
});
