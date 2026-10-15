// @vitest-environment jsdom
// Budget Plan page, every figure: each row's annual amount, the section and
// envelope sub-head totals, the footer, the header stats and a loan row's
// rate, pinned against the page's old composition copied verbatim from
// js/pages/budget-plan.js (L40 `annualOf`, L497 the rate, L686-688 the dated
// view of the stored items with the live queue's pending fields over them,
// the grouping of L705-788 with its L741/L776 sums, L793 the totals), on the
// stored plan, under a search, and with pending live edits (a schedule edit,
// a paused item, a cut map holding a key no scenario reads) before they land.
// And the page asks `plan.items` once per repaint, with those edits.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../js/app.js', async () => (await import('./_fakes/pageApp.js')).appStub);

import { render } from '../js/pages/budget-plan.js';
import { pendingFields } from '../js/ui/plan-item-live.js';
import { t } from '../js/ui/i18n.js';
import { fmt } from '../js/utils.js';
import { computeAnnual, computeAnnualTotals } from '../js/engine/monthly-review.js';
import { loanRateOn } from '../js/engine/loan-terms.js';
import { planItemsAsOf } from '../js/engine/item-dates.js';
import { state, session, resetState, mountHosts, flush, setValue, FIXED_NOW } from './_fakes/pageApp.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const every = () => Object.fromEntries(MONTHS.map(m => [m, true]));
const deepFreeze = (o) => {
  for (const v of Object.values(o)) if (v && typeof v === 'object') deepFreeze(v);
  return Object.freeze(o);
};
const settle = async () => { await new Promise(r => setTimeout(r, 450)); await flush(); };
const querySpy = vi.spyOn(session, 'query');
const planAsks = () => querySpy.mock.calls.filter(([name]) => name === 'plan.items').map(([, input]) => input);

// ── The page's old composition, copied from js/pages/budget-plan.js ────────
// `viewOf` is the live queue's (plan-item-live.js), `now()`/`todayYmd()` the
// fake clock (15 Sep 2026).
const viewOf = (item) => { const p = pendingFields(item.id); return p ? { ...item, ...p } : item; };
const envelopeCategory = (id) => state.envelopes.find(e => e.id === id)?.category;
const envelopeName = (id) => state.envelopes.find(e => e.id === id)?.name;
function oldPage() {
  const viewItems = state.budgetItems.map(viewOf);
  const datedItems = planItemsAsOf(viewItems, FIXED_NOW);
  const datedById = new Map(datedItems.map(it => [it.id, it]));
  const annualOf = (item) => computeAnnual(datedById.get(item.id) ?? item);
  const rowText = (item) => { const annual = annualOf(item); return annual > 0 ? fmt(annual) : '—'; };
  const loanText = (item) => {
    const loan = (state.accounts || []).find(a => a.id === item.to_account_id);
    const rate = loan ? loanRateOn(loan, '2026-09-15') : null;
    return t('budgetPlan.loanRowMeta')(loan?.name || '?', rate ?? (Number(item.loan_rate) || 0));
  };
  // The grouping and its sums (L705-788), over the displayed rows.
  function heads(filtered) {
    const out = [];
    const byCat = new Map();
    for (const it of filtered) {
      const isIncomeLikeRow = it.kind === 'income'
        || (it.kind === 'investment_transfer' && it.direction === 'dividend');
      const cat = isIncomeLikeRow
        ? t('budgetPlan.incomeGroup')
        : it.kind === 'account_transfer'
          ? t('budgetPlan.transfersGroup')
          : (envelopeCategory(it.envelope_id) || t('budgetPlan.uncategorised'));
      if (!byCat.has(cat)) byCat.set(cat, []);
      byCat.get(cat).push(it);
    }
    const incomeLabel = t('budgetPlan.incomeGroup');
    const transfersLabel = t('budgetPlan.transfersGroup');
    const groupRank = (c) => (c === incomeLabel ? 0 : c === transfersLabel ? 1 : 2);
    const cats = [...byCat.keys()].sort((a, b) => {
      const ra = groupRank(a), rb = groupRank(b);
      if (ra !== rb) return ra - rb;
      return a.localeCompare(b);
    });
    for (const cat of cats) {
      const items = byCat.get(cat);
      const catTotal = items.reduce((s, it) => s + (it.include !== false ? annualOf(it) : 0), 0);
      out.push(['section', cat, `${t('budgetPlan.sectionCount')(items.length)} · ${fmt(catTotal)}`]);
      const uniqueEnvIds = new Set(items.filter(it => it.kind !== 'income').map(it => it.envelope_id));
      const needsSubGroup = cat !== incomeLabel && cat !== transfersLabel && uniqueEnvIds.size > 1;
      if (!needsSubGroup) continue;
      const byEnv = new Map();
      for (const it of items) {
        const eid = it.envelope_id || '';
        if (!byEnv.has(eid)) byEnv.set(eid, []);
        byEnv.get(eid).push(it);
      }
      for (const [eid, envItems] of byEnv) {
        // Single-item envelopes now have the same visible boundary.
        const envTotal = envItems.reduce((s, it) => s + (it.include !== false ? annualOf(it) : 0), 0);
        out.push(['sub', envelopeName(eid) || eid, `${t('budgetPlan.sectionCount')(envItems.length)} · ${fmt(envTotal)}`]);
      }
    }
    return out;
  }
  const { income, budget, diff } = computeAnnualTotals(datedItems);
  return { viewItems, rowText, loanText, heads, income, budget, diff };
}

// What the page shows, read back.
const shownRows = () => [...document.querySelectorAll('.bp-list-row')];
function shownHeads() {
  return [...document.querySelectorAll('.bp-list-section-head, .bp-list-sub-head')].map(h => [
    h.classList.contains('bp-list-sub-head') ? 'sub' : 'section', h.children[0].textContent, h.children[1].textContent,
  ]);
}

/** Every figure on the page equals the old composition's. */
function expectFiguresAsBefore() {
  const old = oldPage();
  const rows = shownRows();
  expect(rows.length).toBeGreaterThan(0);
  const shownItems = rows.map(r => old.viewItems[Number(r.dataset.idx)]);
  for (const [k, row] of rows.entries()) {
    const item = shownItems[k];
    expect(row.querySelector('.bp-row-annual').textContent, item.id).toBe(old.rowText(item));
    const loanLine = [...row.querySelectorAll('.bp-row-desc')].find(d => d.textContent.startsWith('→'));
    if (item.kind === 'loan_payment') expect(loanLine?.textContent, item.id).toBe(old.loanText(item));
    else expect(loanLine).toBeUndefined();
  }
  // The displayed rows in plan order are what the page grouped.
  const filtered = old.viewItems.filter(it => shownItems.includes(it));
  expect(shownHeads()).toEqual(old.heads(filtered));
  expect(document.querySelector('#bp-annual-total').textContent).toBe(fmt(old.budget));
  const stats = [...document.querySelectorAll('#bp-stats .bp-stat')].map(e => e.textContent);
  expect(stats[1]).toBe(t('budgetPlan.income')(fmt(old.income)));
  expect(stats[2]).toBe(t('budgetPlan.budget')(fmt(old.budget)));
  const pill = document.querySelector('#bp-stats .bp-diff-pill');
  const kind = Math.abs(old.diff) < 0.005 ? 'is-zero' : old.diff > 0 ? 'is-pos' : 'is-neg';
  expect(pill.classList.contains(kind)).toBe(true);
  expect(pill.textContent).toBe(kind === 'is-zero' ? t('budgetPlan.onBudget')
    : kind === 'is-pos' ? t('budgetPlan.underBudget')(fmt(old.diff)) : t('budgetPlan.overBudget')(fmt(Math.abs(old.diff))));
  return old;
}

async function openPage() {
  mountHosts();
  await render(document.getElementById('app-root'));
}

beforeEach(async () => {
  document.body.click();
  vi.stubGlobal('requestAnimationFrame', (cb) => setTimeout(cb, 0));
  sessionStorage.clear();
  resetState();
  state.accounts = [
    ...state.accounts,
    { id: 'mtg', name: 'Mortgage', type: 'loan', initialBalance: -100000,
      interestRates: [{ from: '2020-01-01', rate: 3 }, { from: '2026-09-01', rate: 3.75 }, { from: '2026-12-01', rate: 4.1 }] },
    { id: 'car', name: 'Car loan', type: 'loan', initialBalance: -9000, interestTiers: [{ upTo: null, rate: 6.2 }] },
    { id: 'fam', name: 'Family loan', type: 'loan', initialBalance: -5000 },
  ];
  state.envelopes = [
    { id: 'food', name: 'Food', category: 'living' },
    { id: 'fun', name: 'Fun', category: 'living' },
    { id: 'rent', name: 'Rent', category: 'housing' },
    { id: 'debt', name: 'Debt', category: 'housing' },
  ];
  state.budgetItems = [
    { id: 's', kind: 'income', envelope_id: null, description: 'Salary', default_amount: 3000, extra_buffer: 0, include: true, monthly_schedule: every(), as_schedule: false },
    { id: 'd', kind: 'investment_transfer', direction: 'dividend', symbol: 'ABC', envelope_id: null, default_amount: 50, extra_buffer: 0, include: true,
      monthly_schedule: { Mar: 60.5, Sep: 40.25 }, as_schedule: false },
    { id: 'g', kind: 'expense', envelope_id: 'food', description: 'Weekly shop', default_amount: -100.45, extra_buffer: 25.5, include: true, monthly_schedule: every(), as_schedule: false },
    { id: 'm', kind: 'expense', envelope_id: 'food', description: 'Market', default_amount: -12.34, extra_buffer: 0, include: true, monthly_schedule: { Jan: true, Feb: -45, Mar: 12.99, Apr: false }, as_schedule: false },
    { id: 'c', kind: 'expense', envelope_id: 'fun', description: 'Cinema', default_amount: -20, extra_buffer: 10, include: true, monthly_schedule: { Jan: true, Feb: true, Mar: 45 }, as_schedule: false,
      stress_category: 'B', stress_cut_pcts: { A: 0.2, B: 0.3, legacy: 0.1 } },
    { id: 'p', kind: 'expense', envelope_id: 'fun', description: 'Gym', default_amount: -30, extra_buffer: 0, include: false, monthly_schedule: every(), as_schedule: false },
    { id: 'o', kind: 'expense', envelope_id: 'fun', description: 'Old club', default_amount: -70, extra_buffer: 7, include: true, monthly_schedule: every(), as_schedule: false, end_month: '2026-08' },
    { id: 'l', kind: 'expense', envelope_id: 'fun', description: 'Later course', default_amount: -80, extra_buffer: 30, include: true, monthly_schedule: every(), as_schedule: false, start_month: '2027-03' },
    { id: 'r', kind: 'expense', envelope_id: 'rent', description: '', default_amount: -700, extra_buffer: 0, include: true, monthly_schedule: every(), as_schedule: false, include_in_emergency_budget: true },
    { id: 't', kind: 'account_transfer', envelope_id: null, description: 'Move to savings', default_amount: 200, extra_buffer: 0, include: true, monthly_schedule: every(), as_schedule: false,
      account_id: 'chk', to_account_id: 'sav' },
    { id: 'lm', kind: 'loan_payment', envelope_id: 'debt', description: 'Mortgage', default_amount: -1000, extra_buffer: 0, include: true, monthly_schedule: every(),
      as_schedule: true, payment_day: 5, account_id: 'chk', to_account_id: 'mtg', as_schedule_since: '2026-01-01', schedule_day_type: 'exact', loan_rate: 9 },
    { id: 'lc', kind: 'loan_payment', envelope_id: 'debt', description: 'Car', default_amount: -250, extra_buffer: 0, include: true, monthly_schedule: every(),
      as_schedule: true, payment_day: 10, account_id: 'chk', to_account_id: 'car', as_schedule_since: '2026-01-01', schedule_day_type: 'exact' },
    { id: 'lf', kind: 'loan_payment', envelope_id: 'debt', description: 'Family', default_amount: -100, extra_buffer: 0, include: true, monthly_schedule: every(),
      as_schedule: true, payment_day: 10, account_id: 'chk', to_account_id: 'fam', as_schedule_since: '2026-01-01', schedule_day_type: 'exact', loan_rate: '2.5' },
    { id: 'lx', kind: 'loan_payment', envelope_id: 'debt', description: 'Gone', default_amount: -60, extra_buffer: 0, include: true, monthly_schedule: every(),
      as_schedule: true, payment_day: 10, account_id: 'chk', to_account_id: 'nope', as_schedule_since: '2026-01-01', schedule_day_type: 'exact', loan_rate: 4 },
  ].map(deepFreeze);
  querySpy.mockClear();
  await openPage();
});

describe('Plan figures as before', () => {
  it('the stored plan: rows, section and envelope sums, footer, stats and the loan rates', () => {
    const old = expectFiguresAsBefore();
    // Not vacuous: an ended item, a later one, a sub-grouped category and every rate case are on screen.
    expect(old.rowText(old.viewItems.find(i => i.id === 'o'))).toBe('—');
    expect(shownHeads().some(h => h[0] === 'sub')).toBe(true);
    const texts = shownRows().map(r => r.textContent).join('\n');
    for (const s of ['Mortgage · 3.75 %', 'Car loan · 6.2 %', 'Family loan · 2.5 %', '? · 4 %']) expect(texts).toContain(s);
  });

  it('a search: the sums are of the rows it leaves', async () => {
    setValue(document.querySelector('#bp-search'), 'c', ['input']);
    await new Promise(r => setTimeout(r, 200));
    expect(shownRows().length).toBeLessThan(state.budgetItems.length);
    expectFiguresAsBefore();
  });

  it('a pending schedule edit moves the row, its sums and the totals at once', async () => {
    const row = shownRows().find(r => r.textContent.includes('Weekly shop'));
    row.querySelector('.bp-freq-btn').click();
    await flush();
    const cell = row.querySelector('.bp-sched-popover .bp-mcell[data-mon="Dec"]');
    cell.click();
    expect(pendingFields('g')).toBeTruthy();
    document.body.click();
    await flush();
    expectFiguresAsBefore();
    await settle();
    expectFiguresAsBefore();
  });

  it('a paused item counts nothing at the next repaint, before the update lands', async () => {
    const row = shownRows().find(r => r.textContent.includes('Weekly shop'));
    row.querySelector('.bp-toggle-chip--on').click();
    setValue(document.querySelector('#bp-filter-cat'), 'living', ['change']);
    expect(pendingFields('g')).toMatchObject({ include: false });
    expectFiguresAsBefore();
    await settle();
  });

  it('a cut map holding a key no scenario reads, pending: the figures stay on', async () => {
    const row = shownRows().find(r => r.textContent.includes('Cinema'));
    row.querySelector('.stress-cat-btn').click();
    await flush();
    const slider = row.querySelector('.stress-slider');
    setValue(slider, '40', ['input', 'change']);
    expect(Object.keys(pendingFields('c').stress_cut_pcts)).toContain('legacy');
    querySpy.mockClear();
    document.body.click();
    await flush();
    expect(planAsks()).toHaveLength(1);
    expectFiguresAsBefore();
    await settle();
  });
});

describe('the page asks plan.items', () => {
  it('once per repaint, for today, with the pending live edits', async () => {
    expect(planAsks()).toEqual([{ date: '2026-09-15', itemOverrides: [] }]);
    const row = shownRows().find(r => r.textContent.includes('Weekly shop'));
    row.querySelector('.bp-toggle-chip--on').click();
    querySpy.mockClear();
    setValue(document.querySelector('#bp-filter-enabled'), 'all', ['change']);
    expect(planAsks()).toEqual([{ date: '2026-09-15', itemOverrides: [{ id: 'g', fields: { include: false } }] }]);
    await settle();
  });

  it('a pending cut map goes with its scenario keys only', async () => {
    const row = shownRows().find(r => r.textContent.includes('Cinema'));
    row.querySelector('.stress-cat-btn').click();
    await flush();
    setValue(row.querySelector('.stress-slider'), '40', ['input', 'change']);
    querySpy.mockClear();
    document.body.click();
    await flush();
    const [input] = planAsks();
    expect(input.itemOverrides).toHaveLength(1);
    expect(input.itemOverrides[0].id).toBe('c');
    expect(Object.keys(input.itemOverrides[0].fields.stress_cut_pcts).sort()).toEqual(['A', 'B']);
    await settle();
  });
});
