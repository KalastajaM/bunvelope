// @vitest-environment jsdom
// Plan page repaint timing and the item editor's loan preview: 5,000 rows,
// 200 plan items (five of them loan payments on loans with dated rates).
// Skipped unless PERF=1, so the suite never depends on machine speed:
//
//   PERF=1 npx vitest run tests/perf/plan-repaint.perf.test.js --reporter=verbose
//
// Three timings, each the median of its events:
//   - a search keystroke: a five-character search typed one key at a time,
//     each key's debounced repaint (the 150 ms timer, faked) timed alone;
//   - a chip toggle: a row's stress chip, then a category picked in its
//     popover, which queues the live edit and repaints the table with it
//     pending (the timed click); each pick on another row, so the pending
//     edits pile up as they would within the quiet window;
//   - a loan preview keystroke: the editor open on a fixed-payment loan item,
//     an amount typed into its amount field (each `input` event timed).
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../js/app.js', async () => (await import('../_fakes/pageApp.js')).appStub);

import { render } from '../../js/pages/budget-plan.js';
import { openBudgetItemEditor } from '../../js/pages/budget-plan-editor.js';
import { flushItems, dropItem } from '../../js/ui/plan-item-live.js';
import { state, resetState, mountHosts, setValue } from '../_fakes/pageApp.js';

const ROWS = 5000;
const ITEMS = 200;
const LOANS = 5;
const QUERY = 'Item ';
const PICKS = 25;
const KEYS = ['1', '12', '120', '1200', '1250', '125', '12', '1', '15', '150', '1500', '1505'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const ENVELOPES = ['food', 'fun', 'rent', 'car', 'power', 'gym', 'gifts', 'travel', 'kids', 'misc'];
const CATS = ['A', 'B', 'C', 'D', 'E'];
const pad = n => String(n).padStart(2, '0');
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

// Deterministic: a small LCG, so every run times the same budget.
function rng(seed) {
  let s = seed;
  return () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; };
}

function budget() {
  const rand = rng(42);
  const txs = [];
  for (let i = 0; i < ROWS; i++) {
    const y = 2025 + Math.floor(rand() * 2);
    const m = 1 + Math.floor(rand() * (y === 2026 ? 9 : 12));
    const date = `${y}-${pad(m)}-${pad(1 + Math.floor(rand() * 28))}`;
    txs.push({ id: `e${i}`, type: 'expense', date, payee: `Payee ${i % 50}`, amount: Math.round(rand() * 8000) / 100,
      account: rand() < 0.5 ? 'chk' : 'sav', envelope_id: ENVELOPES[i % ENVELOPES.length], status: 'posted' });
  }
  resetState({ transactions: txs });
  state.accounts = [
    { id: 'chk', name: 'Checking', type: 'bank', initialBalance: 50000 },
    { id: 'sav', name: 'Savings', type: 'savings', initialBalance: 30000 },
    ...Array.from({ length: LOANS }, (_, k) => ({
      id: `loan${k}`, name: `Loan ${k}`, type: 'loan', initialBalance: -(40000 + k * 30000),
      interestRates: [{ from: '2020-01-01', rate: 3 + k * 0.25 }, { from: '2027-01-01', rate: 3.5 + k * 0.25 }],
    })),
  ];
  state.envelopes = ENVELOPES.map((id, i) => ({ id, name: id, category: `cat${i % 4}` }));
  const every = Object.fromEntries(MONTHS.map(m => [m, true]));
  const items = [{ id: 'sal', kind: 'income', envelope_id: null, description: 'Salary', default_amount: 6000, extra_buffer: 0,
    include: true, monthly_schedule: every, as_schedule: false }];
  for (let k = 0; k < LOANS; k++) {
    items.push({ id: `lp${k}`, kind: 'loan_payment', envelope_id: 'rent', description: `Loan payment ${k}`, default_amount: -(600 + k * 150),
      extra_buffer: 0, include: true, monthly_schedule: every, payment_day: 5, as_schedule: true, account_id: 'chk',
      to_account_id: `loan${k}`, as_schedule_since: '2026-01-01', schedule_day_type: 'exact', funding_style: 'bill' });
  }
  for (let i = items.length; i < ITEMS; i++) {
    const sched = Object.fromEntries(MONTHS.map(m => [m, rand() < 0.85 ? true : (rand() < 0.5 ? false : Math.round(rand() * 300))]));
    items.push({
      id: `p${i}`, kind: 'expense', envelope_id: ENVELOPES[i % ENVELOPES.length], description: `Item ${i}`,
      default_amount: -Math.round(rand() * 50000) / 100, extra_buffer: rand() < 0.1 ? 100 : 0, include: rand() > 0.05,
      monthly_schedule: sched, as_schedule: false, stress_category: CATS[i % CATS.length],
      ...(rand() < 0.05 ? { end_month: '2026-08' } : {}), ...(rand() < 0.05 ? { start_month: '2027-03' } : {}),
    });
  }
  state.budgetItems = items;
}

async function openPlan() {
  budget();
  mountHosts();
  await render(document.getElementById('app-root'));
}

async function searchTimes() {
  await openPlan();
  const input = document.querySelector('#bp-search');
  expect(input).toBeTruthy();
  const times = [];
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    for (let i = 1; i <= QUERY.length; i++) {
      setValue(input, QUERY.slice(0, i), ['input']);
      const t0 = performance.now();
      vi.advanceTimersByTime(150);
      times.push(performance.now() - t0);
    }
  } finally {
    vi.useRealTimers();
  }
  expect(document.querySelectorAll('.bp-list-row').length).toBeGreaterThan(100);
  return times;
}

async function chipTimes() {
  await openPlan();
  const times = [];
  for (let i = 0; i < PICKS; i++) {
    const id = `p${10 + i * 5}`;
    const row = [...document.querySelectorAll('.bp-list-row')].find(r => r.textContent.includes(`Item ${10 + i * 5}`));
    row.querySelector('.stress-cat-btn').click();
    const current = state.budgetItems.find(it => it.id === id).stress_category;
    const next = CATS[(CATS.indexOf(current) + 1) % CATS.length];
    const opt = [...row.querySelectorAll('.stress-cat-opt')].find(b => b.textContent.startsWith(`${next} `));
    const t0 = performance.now();
    opt.click();
    times.push(performance.now() - t0);
  }
  // Nothing of this run is written: drop what is queued.
  for (let i = 0; i < PICKS; i++) dropItem(`p${10 + i * 5}`);
  await flushItems();
  return times;
}

async function loanKeyTimes() {
  budget();
  mountHosts();
  const container = document.createElement('div');
  document.getElementById('app-root').append(container);
  openBudgetItemEditor(container, state.budgetItems.findIndex(it => it.id === 'lp2'), { rerenderTable: () => {} });
  const amount = document.querySelector('#sheet-host #bp-f-amount');
  expect(amount).toBeTruthy();
  expect(document.querySelector('#sheet-host #bp-f-loan-summary').textContent).not.toBe('');
  const times = [];
  for (const key of KEYS) {
    const t0 = performance.now();
    setValue(amount, key, ['input']);
    times.push(performance.now() - t0);
  }
  return times;
}

describe.skipIf(!process.env.PERF)('Plan repaint and loan preview timing', () => {
  it(`${ROWS} rows, ${ITEMS} plan items`, async () => {
    vi.stubGlobal('requestAnimationFrame', () => 0);
    // A warm-up run each, then the timed one.
    await searchTimes();
    const search = await searchTimes();
    await chipTimes();
    const chip = await chipTimes();
    await loanKeyTimes();
    const loan = await loanKeyTimes();
    console.log(`[perf] plan search keystroke, ${ROWS} rows, ${ITEMS} items: median ${median(search).toFixed(2)} ms; per key ${search.map(x => x.toFixed(1)).join(' / ')}`);
    console.log(`[perf] plan chip toggle (stress category pick + repaint): median ${median(chip).toFixed(2)} ms over ${PICKS} picks`);
    console.log(`[perf] editor loan preview keystroke: median ${median(loan).toFixed(2)} ms over ${KEYS.length} keys`);
  }, 300000);
});
