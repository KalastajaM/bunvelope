// tests/core-query-spending.test.js — the Dashboard's spending and plan
// figures as queries: `spending.month` (the Spending KPI and the category
// donut), `spending.history` (the trend card) and `plan.annual` (the annual
// plan card).
//
// Each equivalence helper below copies the Dashboard's current formula from
// js/pages/dashboard.js verbatim, with `state` → the fixture, `appNow()` →
// the fixed clock and `datedPlanItems()` → `planItemsAsOf(items, clock)`, and
// the query must equal it (after round2 where the answer rounds).
import { describe, it, expect } from 'vitest';
import { registry } from '../js/core/index.js';
import { runQuery } from '../js/core/pipeline.js';
import { makeCtx } from '../js/core/context.js';
import { loanAccountIds, txConsumptionPairs, txConsumptionTotal } from '../js/engine/balances.js';
import { computeAnnualTotals, computeMonthlyPlanByEnvelope } from '../js/engine/monthly-review.js';
import { planItemsAsOf } from '../js/engine/item-dates.js';
import { round2 } from '../js/utils.js';

function deepFreeze(o) { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); Object.values(o).forEach(deepFreeze); } return o; }
// Clocks are built from explicit components, so every test reads the same
// local calendar day under each zone test:tz runs.
const at = (y, m, d) => new Date(y, m - 1, d, 10, 0, 0);
const NOW = at(2026, 10, 15);
const ctxAt = (now) => makeCtx({ now, newId: (() => { let n = 0; return () => `q${++n}`; })() });
const ask = (name, input, d, now = NOW) => runQuery(registry, d, name, input, ctxAt(now));
const jsonSafe = (v) => expect(JSON.parse(JSON.stringify(v))).toEqual(v);

const ALL_MONTHS = { Jan: true, Feb: true, Mar: true, Apr: true, May: true, Jun: true, Jul: true, Aug: true, Sep: true, Oct: true, Nov: true, Dec: true };
const item = (id, kind, envelope_id, amount, extra = {}) => ({
  id, kind, envelope_id, description: id, default_amount: kind === 'income' ? amount : -amount,
  include: true, monthly_schedule: ALL_MONTHS, ...extra,
});

// A budget with every case the figures treat in their own way:
//   - a loan account (loan1): a debt payment into it is not consumption, one
//     into a card is
//   - an investment buy, which is never consumption
//   - a split expense, a status-less expense, a posted row dated later in the
//     month, a scheduled row (not spent yet), an envelope with no category and
//     an envelope id that is not in `envelopes` (both → 'other')
//   - a row with no date, a month with no rows (June), and a plan item that
//     only starts in December
const PLAN = [
  item('rent', 'expense', 'rent', 100),
  item('food', 'expense', 'groc', 50),
  item('late', 'expense', 'misc', 120, { start_month: '2026-12' }),
  item('off', 'expense', 'rent', 999, { include: false }),
];
const data = (extra = {}) => deepFreeze({
  meta: {},
  accounts: [
    { id: 'chk', name: 'Checking', type: 'bank', initialBalance: 1000 },
    { id: 'visa', name: 'Visa', type: 'credit_card', initialBalance: 0 },
    { id: 'loan1', name: 'Mortgage', type: 'loan', initialBalance: -1000 },
    { id: 'inv', name: 'Broker', type: 'investment', initialBalance: 0 },
  ],
  envelopes: [
    { id: 'groc', name: 'Groceries', category: 'Food' },
    { id: 'rent', name: 'Rent', category: 'Housing' },
    { id: 'fun', name: 'Fun', category: 'Leisure' },
    { id: 'misc', name: 'Misc' },
  ],
  budgetItems: PLAN,
  envelopeTemplates: [],
  transactions: [
    { id: 'o1', type: 'expense', date: '2026-10-02', amount: 40, account: 'chk', envelope_id: 'groc', status: 'posted' },
    { id: 'o2', type: 'expense', date: '2026-10-03', amount: 300, account: 'chk', envelope_id: 'rent', status: 'posted' },
    { id: 'o3', type: 'expense', date: '2026-10-05', amount: 50.255, account: 'chk', envelope_id: null,
      envelope_splits: [{ envelope_id: 'groc', amount: 30.255 }, { envelope_id: 'fun', amount: 20 }], status: 'posted' },
    { id: 'o4', type: 'expense', date: '2026-10-06', amount: 12.5, account: 'visa', envelope_id: 'misc' },                        // status-less
    { id: 'o5', type: 'expense', date: '2026-10-28', amount: 15, account: 'chk', envelope_id: 'groc', status: 'posted' },        // posted, dated later this month
    { id: 'o6', type: 'expense', date: '2026-10-20', amount: 99, account: 'chk', envelope_id: 'groc', status: 'scheduled' },     // not spent yet
    { id: 'o7', type: 'investment_transfer', direction: 'buy', date: '2026-10-07', amount: 200, units: 4, symbol: 'ABC', from_account: 'chk', to_account: 'inv', envelope_id: 'groc', status: 'posted' },
    { id: 'o8', type: 'debt_payment', date: '2026-10-08', amount: 70, from_account: 'chk', to_account: 'loan1', envelope_id: 'rent', status: 'posted' },
    { id: 'o9', type: 'debt_payment', date: '2026-10-09', amount: 25, from_account: 'chk', to_account: 'visa', envelope_id: 'groc', status: 'posted' },
    { id: 'o10', type: 'expense', date: '2026-10-10', amount: 8, account: 'chk', envelope_id: 'ghost', status: 'posted' },          // envelope not in envelopes
    { id: 'o11', type: 'income', date: '2026-10-01', amount: 2000, account: 'chk', envelope_id: 'groc', status: 'posted' },
    { id: 'o12', type: 'expense', amount: 5, account: 'chk', envelope_id: 'groc', status: 'posted' },                            // no date
    { id: 's1', type: 'expense', date: '2026-09-02', amount: 100, account: 'chk', envelope_id: 'groc', status: 'posted' },
    { id: 's2', type: 'expense', date: '2026-09-30', amount: 60.1, account: 'chk', envelope_id: 'rent', status: 'posted' },
    { id: 'a1', type: 'expense', date: '2026-08-15', amount: 33.33, account: 'chk', envelope_id: 'groc', status: 'posted' },
    { id: 'a2', type: 'debt_payment', date: '2026-08-16', amount: 500, from_account: 'chk', to_account: 'loan1', envelope_id: 'rent', status: 'posted' },
    { id: 'y1', type: 'expense', date: '2025-12-10', amount: 7, account: 'chk', envelope_id: 'groc', status: 'posted' },
  ],
  ...extra,
});
const empty = () => deepFreeze({ meta: {}, accounts: [], envelopes: [], budgetItems: [], envelopeTemplates: [], transactions: [] });

// ── The page's formulas, copied from js/pages/dashboard.js ─────────────────

const ymOf = (now) => `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

// spentThisMonth (§2.2)
function pageSpentThisMonth(state, appNow) {
  const now = appNow;
  const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const loans = loanAccountIds(state.accounts);
  return state.transactions.filter(tx => String(tx.date || '').startsWith(ym)).reduce((s, tx) => s + txConsumptionTotal(tx, loans), 0);
}
// plannedThisMonth (§2.2), with datedPlanItems() as the dated view as of the clock
function pagePlannedThisMonth(state, appNow) {
  const planMap = computeMonthlyPlanByEnvelope(planItemsAsOf(state.budgetItems || [], appNow));
  let s = 0; for (const v of planMap.values()) s += v; return s;
}
// buildKpiRow (§2.2)
function pageSpentPct(spent, planned) {
  return planned > 0 ? Math.min(100, Math.round((spent / planned) * 100)) : 0;
}
function pageDaysLeftInMonth(appNow) {
  const now = appNow; const eom = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate(); return Math.max(0, eom - now.getDate());
}
// computeCategorySpendSegments' byCat loop (§2.3), before the colours and labels
function pageByCat(state, appNow) {
  const now = appNow;
  const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const byCat = {};
  const envById = Object.fromEntries(state.envelopes.map(e => [e.id, e]));
  const loans = loanAccountIds(state.accounts);
  for (const tx of state.transactions) {
    if (!String(tx.date || '').startsWith(ym)) continue;
    for (const [envId, amt] of txConsumptionPairs(tx, loans)) {
      const cat = envById[envId]?.category || 'other';
      byCat[cat] = (byCat[cat] || 0) + amt;
    }
  }
  const entries = Object.entries(byCat).sort((a, b) => b[1] - a[1]);
  return entries.map(([cat, value]) => ({ key: cat, value }));
}
// monthlyTotalsSeries (§2.4), without the labels
function pageMonthlyTotalsSeries(state, appNow) {
  const now = appNow;
  const months = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push({ y: d.getFullYear(), m: d.getMonth(), ym: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}` });
  }
  const loans = loanAccountIds(state.accounts);
  return months.map(({ ym }) => ({ value: state.transactions.filter(tx => String(tx.date || '').startsWith(ym)).reduce((s, tx) => s + txConsumptionTotal(tx, loans), 0), ym }));
}
// buildAnnualPlanCard (§2.5)
function pageAnnualCard(state, appNow) {
  const hasIncluded = (state.budgetItems || []).some(it => it.include !== false);
  const { income, budget, diff } = computeAnnualTotals(planItemsAsOf(state.budgetItems || [], appNow));
  const isBalanced = Math.abs(diff) < 0.005;
  const isDeficit = diff < 0;
  const isSurplus = diff > 0;
  const coveragePct = income > 0.005
    ? Math.round(Math.min(budget, income) / income * 100)
    : (isBalanced ? 100 : 0);
  const pct = income > 0.005
    ? Math.min(100, Math.round(budget / income * 100))
    : (budget > 0 ? 100 : 0);
  return { hasIncluded, income, budget, diff, isBalanced, isDeficit, isSurplus, coveragePct, pct };
}

// ── spending.month ─────────────────────────────────────────────────────────

describe('spending.month', () => {
  it('equals the Spending KPI, the spent %, the days left and the donut', () => {
    const d = data();
    const r = ask('spending.month', {}, d);
    expect(r.ok, JSON.stringify(r.error)).toBe(true);
    const spent = pageSpentThisMonth(d, NOW);
    const planned = pagePlannedThisMonth(d, NOW);
    expect(r.value.month).toBe(ymOf(NOW));
    expect(r.value.spent).toBe(round2(spent));
    expect(r.value.planned).toBe(round2(planned));
    expect(r.value.spentPct).toBe(pageSpentPct(spent, planned));
    expect(r.value.daysLeft).toBe(pageDaysLeftInMonth(NOW));
    expect(r.value.byCategory).toEqual(pageByCat(d, NOW).map(({ key, value }) => ({ category: key, amount: round2(value) })));
  });

  it('reads the fixture as expected', () => {
    const a = ask('spending.month', {}, data()).value;
    // Counted: o1 40, o2 300, the split 50.255, the status-less 12.5, the
    // card payment 25, o10 8 and the posted 28 Oct row 15. Not counted: the
    // scheduled row, the buy, the payment into the loan, income, no date.
    expect(a.spent).toBe(round2(40 + 300 + 50.255 + 12.5 + 15 + 25 + 8));
    // Rent 100 + food 50 + the late item (Dec on: 10 of the next 12 months).
    expect(a.planned).toBe(250);
    expect(a.spentPct).toBe(100);
    expect(a.daysLeft).toBe(16);
    expect(a.byCategory).toEqual([
      { category: 'Housing', amount: 300 },
      { category: 'Food', amount: round2(40 + 30.255 + 15 + 25) },
      { category: 'other', amount: round2(12.5 + 8) },   // no category, and an envelope id that is not there
      { category: 'Leisure', amount: 20 },
    ]);
    jsonSafe(a);
  });

  it('a month with no rows spends nothing; the plan is still its figure', () => {
    const a = ask('spending.month', { month: '2026-06' }, data()).value;
    expect(a).toMatchObject({ month: '2026-06', spent: 0, spentPct: 0, daysLeft: null, byCategory: [] });
    // The plan still counts in a month with no rows: seen from 1 Jun, the
    // December item is in force for six of the twelve months.
    const planned = pagePlannedThisMonth(data(), at(2026, 6, 1));
    expect(planned).toBeGreaterThan(0);
    expect(a.planned).toBe(round2(planned));
  });

  it('a past month: spent from its rows, planned as of its first day, no daysLeft', () => {
    const d = data();
    const a = ask('spending.month', { month: '2026-09' }, d).value;
    expect(a.month).toBe('2026-09');
    expect(a.daysLeft).toBeNull();
    expect(a.spent).toBe(round2(100 + 60.1));
    expect(a.byCategory).toEqual([{ category: 'Food', amount: 100 }, { category: 'Housing', amount: 60.1 }]);
    // As of 1 Sep 2026 the window is Sep 2026 to Aug 2027, December is in it:
    // the same as the page would read on that day.
    const planned = pagePlannedThisMonth(d, at(2026, 9, 1));
    expect(a.planned).toBe(round2(planned));
    expect(a.spentPct).toBe(pageSpentPct(100 + 60.1, planned));
    // The Aug loan payment is not consumption.
    expect(ask('spending.month', { month: '2026-08' }, d).value.spent).toBe(33.33);
  });

  it('a plan item that starts after date is out of planned until it is in force', () => {
    const d = data({ budgetItems: [item('late', 'expense', 'misc', 120, { start_month: '2026-12' })] });
    // Seen from 15 Oct: Dec..Sep, so 10 months of 120 over 12.
    expect(ask('spending.month', {}, d).value.planned).toBe(100);
    // Seen from 1 Jan 2026 (month 2026-01 is not date's own month: first day).
    expect(ask('spending.month', { month: '2026-01' }, d).value.planned).toBe(10);
    // Date in December: all twelve months.
    expect(ask('spending.month', { date: '2026-12-05' }, d, NOW).value).toMatchObject({ month: '2026-12', planned: 120 });
  });

  it('date picks the month, the days left and the plan in force', () => {
    const d = data();
    expect(ask('spending.month', { date: '2026-10-31' }, d).value.daysLeft).toBe(0);
    expect(ask('spending.month', { date: '2026-10-01' }, d).value.daysLeft).toBe(30);
    expect(ask('spending.month', { date: '2026-02-10' }, d).value).toMatchObject({ month: '2026-02', daysLeft: 18 });
    expect(ask('spending.month', { date: '2024-02-10' }, d).value.daysLeft).toBe(19);
    // A month named explicitly that is date's own month gets daysLeft; any other does not.
    expect(ask('spending.month', { month: '2026-10', date: '2026-10-20' }, d).value.daysLeft).toBe(11);
    expect(ask('spending.month', { month: '2026-09', date: '2026-10-20' }, d).value.daysLeft).toBeNull();
    // Default date is the clock's today.
    expect(ask('spending.month', {}, d, at(2026, 9, 10)).value).toMatchObject({ month: '2026-09', daysLeft: 20 });
  });

  it('spent % is capped at 100 and is 0 without a plan', () => {
    const d = data();
    expect(ask('spending.month', {}, d).value.spentPct).toBe(100);
    const none = data({ budgetItems: [] });
    expect(ask('spending.month', {}, none).value).toMatchObject({ planned: 0, spentPct: 0 });
    // Under the plan: Sep 160.1 of 250.
    const under = data({ budgetItems: [item('big', 'expense', 'groc', 1000)] });
    const planned = pagePlannedThisMonth(under, NOW);
    expect(ask('spending.month', {}, under).value.spentPct).toBe(pageSpentPct(pageSpentThisMonth(under, NOW), planned));
    expect(ask('spending.month', {}, under).value.spentPct).toBeLessThan(100);
  });

  it('an empty budget is zero', () => {
    expect(ask('spending.month', {}, empty()).value).toEqual({ month: '2026-10', spent: 0, planned: 0, averageMonthlyFunding: 0, calendarPlanned: 0, calendarSpentPct: 0, spentPct: 0, daysLeft: 16, byCategory: [] });
  });

  it('refuses a month that is not YYYY-MM and a date that is not real', () => {
    for (const month of ['2026-13', '2026-00', '26-10', '2026-1', 'october', '']) {
      const r = ask('spending.month', { month }, data());
      expect(r.ok, month).toBe(false);
      expect(r.error).toEqual({ code: 'bad_input', params: { errors: [{ path: 'month', message: 'must be a month, YYYY-MM' }] } });
    }
    expect(ask('spending.month', { date: '2026-02-30' }, data()).error.code).toBe('bad_input');
    expect(ask('spending.month', { nope: 1 }, data()).error.code).toBe('bad_input');
  });

  it('is JSON-safe and does not touch the frozen data', () => {
    const d = data();
    const before = JSON.stringify(d);
    jsonSafe(ask('spending.month', {}, d).value);
    jsonSafe(ask('spending.month', { month: '2026-09' }, d).value);
    expect(JSON.stringify(d)).toBe(before);
  });
});

// ── spending.history ───────────────────────────────────────────────────────

describe('spending.history', () => {
  it('equals the trend card\'s series (six months, oldest first)', () => {
    const d = data();
    const r = ask('spending.history', {}, d);
    expect(r.ok, JSON.stringify(r.error)).toBe(true);
    const page = pageMonthlyTotalsSeries(d, NOW);
    expect(r.value.months).toEqual(page.map(({ ym, value }) => ({ month: ym, spent: round2(value) })));
    expect(r.value.months.map(m => m.month)).toEqual(['2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10']);
    expect(r.value.months.map(m => m.spent)).toEqual([0, 0, 0, 33.33, 160.1, round2(40 + 300 + 50.255 + 12.5 + 15 + 25 + 8)]);
    jsonSafe(r.value);
  });

  it('months and date choose the span; the last month is date\'s own', () => {
    const d = data();
    expect(ask('spending.history', { months: 1 }, d).value.months).toEqual([{ month: '2026-10', spent: 450.76 }]);
    expect(ask('spending.history', { months: 3, date: '2026-09-30' }, d).value.months.map(m => m.month)).toEqual(['2026-07', '2026-08', '2026-09']);
    // Across a year end.
    const long = ask('spending.history', { months: 11, date: '2026-10-15' }, d).value.months;
    expect(long[0]).toEqual({ month: '2025-12', spent: 7 });
    expect(long).toHaveLength(11);
    expect(ask('spending.history', { months: 36 }, d).value.months).toHaveLength(36);
    expect(ask('spending.history', { months: 36 }, d).value.months[0].month).toBe('2023-11');
  });

  it('refuses months out of range', () => {
    for (const months of [0, 37, 1.5, -1]) {
      const r = ask('spending.history', { months }, data());
      expect(r.ok, String(months)).toBe(false);
      expect(r.error.code).toBe('bad_input');
    }
  });

  it('an empty budget is zero for every month', () => {
    const m = ask('spending.history', {}, empty()).value.months;
    expect(m).toHaveLength(6);
    expect(m.every(x => x.spent === 0)).toBe(true);
  });

  it('its last month is spending.month\'s spent', () => {
    const d = data();
    const last = ask('spending.history', {}, d).value.months.at(-1);
    expect(last.spent).toBe(ask('spending.month', {}, d).value.spent);
  });
});

// ── plan.annual ────────────────────────────────────────────────────────────

describe('plan.annual', () => {
  const SALARY = item('salary', 'income', null, 3000);
  const CASES = [
    ['no income', [item('rent', 'expense', 'rent', 100)]],
    ['no income and no budget (all included items are 0)', [item('zero', 'expense', 'rent', 0)]],
    ['a deficit', [SALARY, item('rent', 'expense', 'rent', 2000), item('food', 'expense', 'groc', 1500)]],
    ['balanced', [SALARY, item('rent', 'expense', 'rent', 2000), item('food', 'expense', 'groc', 1000)]],
    ['balanced within half a cent', [item('s', 'income', null, 1000.0001), item('r', 'expense', 'rent', 1000)]],
    ['a surplus', [SALARY, item('rent', 'expense', 'rent', 1000)]],
    ['a surplus, budget under a third of income', [SALARY, item('rent', 'expense', 'rent', 900)]],
    ['a plan item that starts after date', [SALARY, item('rent', 'expense', 'rent', 2000), item('late', 'expense', 'misc', 500, { start_month: '2026-12' })]],
    ['a plan item that ended before date', [SALARY, item('old', 'expense', 'misc', 2500, { end_month: '2026-09' })]],
    ['an item excluded, an account transfer and a dividend', [
      SALARY, item('x', 'expense', 'rent', 5000, { include: false }), item('t', 'account_transfer', null, 800),
      { id: 'div', kind: 'investment_transfer', direction: 'dividend', default_amount: 40, include: true, monthly_schedule: ALL_MONTHS },
    ]],
  ];
  for (const [label, items] of CASES) {
    it(`${label} equals the card's figures`, () => {
      const d = data({ budgetItems: items });
      const r = ask('plan.annual', {}, d);
      expect(r.ok, JSON.stringify(r.error)).toBe(true);
      const page = pageAnnualCard(d, NOW);
      expect(r.value).toEqual({
        hasIncluded: page.hasIncluded,
        income: round2(page.income),
        budget: round2(page.budget),
        diff: round2(page.diff),
        status: page.isBalanced ? 'balanced' : page.isSurplus ? 'surplus' : 'deficit',
        coveragePct: page.coveragePct,
        fillPct: page.pct,
      });
      jsonSafe(r.value);
    });
  }

  it('reads the cases as expected', () => {
    const v = (items) => ask('plan.annual', {}, data({ budgetItems: items })).value;
    // Under half a cent a year apart is balanced, though not exactly equal.
    const near = [item('s', 'income', null, 1000.0001), item('r', 'expense', 'rent', 1000)];
    const nearDiff = pageAnnualCard(data({ budgetItems: near }), NOW).diff;
    expect(Math.abs(nearDiff)).toBeGreaterThan(0);
    expect(Math.abs(nearDiff)).toBeLessThan(0.005);
    expect(v(near).status).toBe('balanced');
    expect(v([SALARY, item('r', 'expense', 'rent', 2000), item('f', 'expense', 'groc', 1500)]))
      .toEqual({ hasIncluded: true, income: 36000, budget: 42000, diff: -6000, status: 'deficit', coveragePct: 100, fillPct: 100 });
    expect(v([SALARY, item('r', 'expense', 'rent', 3000)]))
      .toEqual({ hasIncluded: true, income: 36000, budget: 36000, diff: 0, status: 'balanced', coveragePct: 100, fillPct: 100 });
    expect(v([SALARY, item('r', 'expense', 'rent', 900)]))
      .toEqual({ hasIncluded: true, income: 36000, budget: 10800, diff: 25200, status: 'surplus', coveragePct: 30, fillPct: 30 });
    // No income: coverage 0 (not balanced) and a full bar for any budget.
    expect(v([item('r', 'expense', 'rent', 100)]))
      .toEqual({ hasIncluded: true, income: 0, budget: 1200, diff: -1200, status: 'deficit', coveragePct: 0, fillPct: 100 });
    // The ended item is out of the year: all income, no budget.
    expect(v([SALARY, item('old', 'expense', 'misc', 2500, { end_month: '2026-09' })]))
      .toMatchObject({ income: 36000, budget: 0, status: 'surplus', coveragePct: 0, fillPct: 0 });
  });

  it('a plan with nothing included: hasIncluded false, balanced and empty', () => {
    expect(ask('plan.annual', {}, empty()).value)
      .toEqual({ hasIncluded: false, income: 0, budget: 0, diff: 0, status: 'balanced', coveragePct: 100, fillPct: 0 });
    const off = data({ budgetItems: [item('x', 'expense', 'rent', 100, { include: false })] });
    expect(ask('plan.annual', {}, off).value.hasIncluded).toBe(false);
  });

  it('hasIncluded looks at the stored items, the totals at the dated ones', () => {
    // The only item ended: nothing of it is in the coming year, but it is included.
    const d = data({ budgetItems: [item('old', 'expense', 'rent', 100, { end_month: '2026-01' })] });
    expect(ask('plan.annual', {}, d).value).toMatchObject({ hasIncluded: true, income: 0, budget: 0 });
  });

  it('date moves the window the year is read from', () => {
    const d = data({ budgetItems: [SALARY, item('late', 'expense', 'misc', 500, { start_month: '2026-12' })] });
    // From 15 Oct: Dec..Sep is 10 months of 500.
    expect(ask('plan.annual', {}, d).value.budget).toBe(5000);
    // From 1 Dec 2026 the whole year is in.
    expect(ask('plan.annual', { date: '2026-12-01' }, d).value.budget).toBe(6000);
    // From 1 Jan 2026 only December is.
    expect(ask('plan.annual', { date: '2026-01-01' }, d).value.budget).toBe(500);
    expect(ask('plan.annual', { date: '2026-02-30' }, d).error.code).toBe('bad_input');
  });

  it('does not touch the frozen data', () => {
    const d = data({ budgetItems: [SALARY, item('rent', 'expense', 'rent', 2000)] });
    const before = JSON.stringify(d);
    ask('plan.annual', {}, d);
    expect(JSON.stringify(d)).toBe(before);
  });
});
