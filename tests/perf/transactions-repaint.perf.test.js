// @vitest-environment jsdom
// Transactions page repaint timing: 5,000 rows, one envelope selected, a
// five-character search typed one key at a time. Each keystroke's repaint is
// timed alone (the 150 ms search debounce runs under fake timers, so the
// figure is the repaint, not the wait). Skipped unless PERF=1, so the suite
// never depends on machine speed:
//
//   PERF=1 npx vitest run tests/perf/transactions-repaint.perf.test.js --reporter=verbose
//
// Printed for the scheduled preview off and on: the median and the total of
// the five keystrokes, and the first paint.
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../js/app.js', async () => (await import('../_fakes/pageApp.js')).appStub);

import { render } from '../../js/pages/transactions.js';
import { state, resetState, mountHosts, setValue } from '../_fakes/pageApp.js';

const ROWS = 5000;
const ENVELOPES = ['food', 'fun', 'rent'];
const QUERY = 'Payee';

// Deterministic: a small LCG, so every run times the same budget.
function rng(seed) {
  let s = seed;
  return () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; };
}

function ledger() {
  const rand = rng(42);
  const pad = n => String(n).padStart(2, '0');
  const txs = [];
  for (let i = 0; i < ROWS; i++) {
    const y = 2023 + Math.floor(rand() * 4);
    const m = 1 + Math.floor(rand() * 12);
    const d = 1 + Math.floor(rand() * 28);
    const date = `${y}-${pad(m)}-${pad(d)}`;
    if (i % 25 === 0) {
      txs.push({ id: `f${i}`, type: 'fill', date, payee: 'Fill', status: 'posted',
        lines: ENVELOPES.map(e => ({ envelope_id: e, amount: Math.round(rand() * 50000) / 100 })) });
      continue;
    }
    txs.push({ id: `e${i}`, type: 'expense', date, payee: `${i % 7 ? 'Payee' : 'Shop'} ${i % 50}`,
      amount: Math.round(rand() * 8000) / 100, account: rand() < 0.5 ? 'chk' : 'sav',
      envelope_id: ENVELOPES[i % ENVELOPES.length], status: 'posted' });
  }
  return txs;
}

async function typeSearch(showScheduled) {
  resetState({ transactions: ledger() });
  state.pendingFilter = 'food';
  // The page reads the preview toggle from localStorage (jsdom's may be absent).
  const stored = new Map([['bunvelope.tx.showScheduled.test-budget', showScheduled ? '1' : '0']]);
  vi.stubGlobal('localStorage', {
    getItem: (k) => (stored.has(k) ? stored.get(k) : null),
    setItem: (k, v) => { stored.set(k, String(v)); },
    removeItem: (k) => { stored.delete(k); },
  });
  mountHosts();
  const t0 = performance.now();
  await render(document.getElementById('app-root'));
  const firstPaint = performance.now() - t0;
  const input = document.querySelector('.search input');
  expect(input).toBeTruthy();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }); // not performance.now
  const times = [];
  try {
    for (let i = 1; i <= QUERY.length; i++) {
      setValue(input, QUERY.slice(0, i), ['input']);
      const k0 = performance.now();
      vi.advanceTimersByTime(150);
      times.push(performance.now() - k0);
    }
  } finally {
    vi.useRealTimers();
  }
  const sorted = [...times].sort((a, b) => a - b);
  return { firstPaint, times, median: sorted[Math.floor(sorted.length / 2)], total: times.reduce((a, b) => a + b, 0) };
}

describe.skipIf(!process.env.PERF)('Transactions repaint timing', () => {
  it(`${ROWS} rows, one envelope, a ${QUERY.length}-key search`, async () => {
    vi.stubGlobal('requestAnimationFrame', (cb) => setTimeout(cb, 0));
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} unobserve() {} });
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get() { return 4000; } });
    try {
      for (const showScheduled of [false, true]) {
        // A warm-up run, then the timed one.
        await typeSearch(showScheduled);
        const r = await typeSearch(showScheduled);
        console.log(`[perf] transactions search, ${ROWS} rows, envelope food, preview ${showScheduled ? 'on' : 'off'}: `
          + `keystroke median ${r.median.toFixed(2)} ms, ${QUERY.length} keys ${r.total.toFixed(2)} ms, first paint ${r.firstPaint.toFixed(2)} ms; per key ${r.times.map(x => x.toFixed(1)).join(' / ')}`);
      }
    } finally {
      delete HTMLElement.prototype.clientHeight;
    }
  }, 120000);
});
