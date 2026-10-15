// tests/core-query-plan-items.test.js — `plan.items`, the Plan page's
// figures as a query: every plan item's annual amount and a loan payment's
// rate, and the plan's income, budget and difference.
//
// The page's formulas are copied from js/pages/budget-plan.js verbatim below
// (L40 `annualOf`, L497 the loan row's rate, L686-688 the dated view of the
// stored items with the live queue's pending fields over them, L741/L776 the
// section and envelope sums, L793 the totals), with `state` → the fixture,
// `viewOf` → the queue's overlay of the pending fields, `now()`/`todayYmd()`
// → NOW. The query gets the same pending fields as `itemOverrides` and must
// equal the page: money after round2, and a sum of displayed rows over the
// answer's rounded amounts formats as the page's unrounded sum.
import { describe, it, expect } from 'vitest';
import { registry } from '../js/core/index.js';
import { runQuery } from '../js/core/pipeline.js';
import { makeCtx } from '../js/core/context.js';
import { computeAnnual, computeAnnualTotals } from '../js/engine/monthly-review.js';
import { loanRateOn } from '../js/engine/loan-terms.js';
import { planItemsAsOf } from '../js/engine/item-dates.js';
import { round2, fmt } from '../js/utils.js';

function deepFreeze(o) { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); Object.values(o).forEach(deepFreeze); } return o; }
// Clocks are built from explicit components, so every test reads the same
// local calendar day under each zone test:tz runs.
const at = (y, m, d) => new Date(y, m - 1, d, 10, 0, 0);
const NOW = at(2026, 9, 15);
const ctxAt = (now) => makeCtx({ now, newId: (() => { let n = 0; return () => `q${++n}`; })() });
const ask = (input, d, now = NOW) => runQuery(registry, d, 'plan.items', input, ctxAt(now));
const pad = n => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const every = () => Object.fromEntries(MONTHS.map(m => [m, true]));

// Every case the figures treat differently:
//   pay      income
//   div      a dividend (income-like) with custom month amounts
//   food     expense with a third of a cent per month (sub-cent annual) and a buffer
//   fun      expense with custom months, one of them negative
//   off      include: false
//   move     a transfer: its own annual, out of the totals
//   old      ended in August (the dated view counts nothing; its buffer goes)
//   later    starts next March (only the months from then on count)
//   mort     a loan payment on a loan with dated rates
//   lent     a loan payment on a loan with legacy tiers only
//   norate   a loan payment on a loan without any rate: the item's legacy rate
//   gone     a loan payment whose loan account does not exist: the item's legacy rate
//   bare     a loan payment with neither: 0
const items = () => [
  { id: 'pay', kind: 'income', description: 'Pay', default_amount: 3000, include: true, monthly_schedule: every() },
  { id: 'div', kind: 'investment_transfer', direction: 'dividend', default_amount: 50, include: true, monthly_schedule: { Mar: 60.5, Sep: 40.25 } },
  { id: 'food', kind: 'expense', envelope_id: 'groc', default_amount: -100.333, extra_buffer: 25.5, include: true, monthly_schedule: every() },
  { id: 'fun', kind: 'expense', envelope_id: 'fun', default_amount: -20, extra_buffer: 10, include: true, monthly_schedule: { Jan: true, Feb: -45, Mar: 12.34, Apr: false } },
  { id: 'off', kind: 'expense', envelope_id: 'fun', default_amount: -999, include: false, monthly_schedule: every() },
  { id: 'move', kind: 'account_transfer', default_amount: -300, include: true, monthly_schedule: every() },
  { id: 'old', kind: 'expense', envelope_id: 'fun', default_amount: -700, extra_buffer: 77, include: true, monthly_schedule: every(), end_month: '2026-08' },
  { id: 'later', kind: 'expense', envelope_id: 'fun', default_amount: -80, extra_buffer: 30, include: true, monthly_schedule: every(), start_month: '2027-03' },
  { id: 'mort', kind: 'loan_payment', envelope_id: 'rent', default_amount: -1000, include: true, monthly_schedule: every(), to_account_id: 'mtg', loan_rate: 9 },
  { id: 'lent', kind: 'loan_payment', envelope_id: 'rent', default_amount: -200, include: true, monthly_schedule: every(), to_account_id: 'car' },
  { id: 'norate', kind: 'loan_payment', envelope_id: 'rent', default_amount: -50, include: true, monthly_schedule: every(), to_account_id: 'flat', loan_rate: '2.5' },
  { id: 'gone', kind: 'loan_payment', envelope_id: 'rent', default_amount: -60, include: true, monthly_schedule: every(), to_account_id: 'nope', loan_rate: 4 },
  { id: 'bare', kind: 'loan_payment', envelope_id: 'rent', default_amount: -70, include: true, monthly_schedule: every(), to_account_id: 'flat' },
];

const data = (extra = {}) => deepFreeze({
  meta: {},
  accounts: [
    { id: 'chk', name: 'Checking', type: 'bank', initialBalance: 2000 },
    { id: 'mtg', name: 'Mortgage', type: 'loan', initialBalance: -100000,
      interestRates: [{ from: '2020-01-01', rate: 3 }, { from: '2026-09-15', rate: 3.75 }, { from: '2026-12-01', rate: 4.1 }] },
    { id: 'car', name: 'Car loan', type: 'loan', initialBalance: -9000, interestTiers: [{ upTo: null, rate: 6.2 }] },
    { id: 'flat', name: 'Family loan', type: 'loan', initialBalance: -5000 },
  ],
  envelopes: [
    { id: 'rent', name: 'Rent', category: 'Housing' },
    { id: 'groc', name: 'Groceries', category: 'Food' },
    { id: 'fun', name: 'Fun', category: 'Life' },
  ],
  budgetItems: items(),
  envelopeTemplates: [],
  transactions: [],
  ...extra,
});

// ── The page's formulas, copied from js/pages/budget-plan.js ───────────────
// `pending` is the live queue's pending fields by id (plan-item-live.js
// viewOf: `pending ? { ...item, ...pending } : item`).
function pagePlan(state, pending, now) {
  const viewOf = (item) => { const p = pending.get(item.id); return p ? { ...item, ...p } : item; };
  const todayYmd = () => ymd(now);
  // L686-688
  const viewItems = state.budgetItems.map(viewOf);
  const datedItems = planItemsAsOf(viewItems, now);
  const datedById = new Map(datedItems.map(it => [it.id, it]));
  // L40
  const annualOf = (item) => computeAnnual(datedById.get(item.id) ?? item);
  // L495-498
  const rateOf = (item) => {
    const loan = (state.accounts || []).find(a => a.id === item.to_account_id);
    const rate = loan ? loanRateOn(loan, todayYmd()) : null;
    return rate ?? (Number(item.loan_rate) || 0);
  };
  // L741 / L776: a section's (an envelope's) total over its displayed rows
  const sumOf = (rows) => rows.reduce((s, it) => s + (it.include !== false ? annualOf(it) : 0), 0);
  // L793
  const totals = computeAnnualTotals(datedItems);
  return { viewItems, annualOf, rateOf, sumOf, totals };
}

/** What the page shows, in the query's answer shape. */
function expected(d, { pending = new Map(), now = NOW } = {}) {
  const page = pagePlan(d, pending, now);
  return {
    items: page.viewItems.map(it => ({
      id: it.id,
      annual: round2(page.annualOf(it)),
      loanRate: it.kind === 'loan_payment' ? page.rateOf(it) : null,
    })),
    totals: { income: round2(page.totals.income), budget: round2(page.totals.budget), diff: round2(page.totals.diff) },
  };
}

const overridesOf = (pending) => [...pending].map(([id, fields]) => ({ id, fields }));

function jsonSafe(v) {
  expect(JSON.parse(JSON.stringify(v))).toEqual(v);
}

describe('plan.items: the Plan page\'s figures', () => {
  it('equals the page on the stored plan: every item in order, the loan rates and the totals', () => {
    const d = data();
    const r = ask({ date: '2026-09-15' }, d);
    expect(r.ok).toBe(true);
    expect(r.value).toEqual(expected(d));
    jsonSafe(r.value);
    // Not vacuous: the cases differ as described.
    const by = Object.fromEntries(r.value.items.map(m => [m.id, m]));
    expect(by.old.annual).toBe(0);
    // From March 2027 to the window's end (August 2027): six months.
    expect(by.later.annual).toBe(round2(6 * 80 + 30));
    expect(by.mort.loanRate).toBe(3.75);
    expect(by.lent.loanRate).toBe(6.2);
    expect(by.norate.loanRate).toBe(2.5);
    expect(by.gone.loanRate).toBe(4);
    expect(by.bare.loanRate).toBe(0);
    expect(by.food.loanRate).toBeNull();
    expect(by.move.annual).toBe(3600);
  });

  it('the rate follows the date: a rate entered from December applies from then', () => {
    const d = data();
    const dec = ask({ date: '2026-12-01' }, d, at(2026, 12, 1));
    expect(dec.value).toEqual(expected(d, { now: at(2026, 12, 1) }));
    expect(dec.value.items.find(m => m.id === 'mort').loanRate).toBe(4.1);
  });

  it('the date dates the plan: an item ended before it counts nothing', () => {
    const d = data();
    const aug = ask({ date: '2026-08-01' }, d, at(2026, 8, 1));
    expect(aug.value).toEqual(expected(d, { now: at(2026, 8, 1) }));
    expect(aug.value.items.find(m => m.id === 'old').annual).toBeGreaterThan(0);
  });

  it('equals the page with pending live edits: a paused item, a schedule edit, a re-enabled item, two edits of one item', () => {
    const d = data();
    // The page's live controls queue exactly these (budget-plan.js :267, :296, :378, :608, :623).
    const pending = new Map([
      ['food', { include: false }],
      ['fun', { monthly_schedule: { Jan: 15, Feb: true, Dec: true }, include_in_emergency_budget: true }],
      ['off', { include: true }],
      ['pay', { stress_category: 'C', stress_cut_pcts: { A: 0.5 }, stress_cut_pct: 0 }],
    ]);
    const r = ask({ date: '2026-09-15', itemOverrides: overridesOf(pending) }, d);
    expect(r.value).toEqual(expected(d, { pending }));
    // The edits move the figures (not vacuous).
    expect(r.value.totals).not.toEqual(ask({ date: '2026-09-15' }, d).value.totals);

    // Later entries for one id win a field both set, as the queue's last value does.
    const split = [{ id: 'fun', fields: { monthly_schedule: { Jan: true } } }, { id: 'fun', fields: { monthly_schedule: { Jan: 15, Feb: true, Dec: true } } },
      { id: 'fun', fields: { include_in_emergency_budget: true } }];
    expect(ask({ date: '2026-09-15', itemOverrides: [...split, ...overridesOf(pending).filter(o => o.id !== 'fun')] }, d).value)
      .toEqual(r.value);
  });

  it('an override for an unknown id is ignored (the item may have been deleted while it was queued)', () => {
    const d = data();
    const r = ask({ date: '2026-09-15', itemOverrides: [{ id: 'deleted', fields: { include: false } }] }, d);
    expect(r.value).toEqual(expected(d));
  });

  it('a schedule month takes what a stored item holds: true, false, 0 or a negative amount', () => {
    const d = data();
    const pending = new Map([['fun', { monthly_schedule: { Jan: true, Feb: false, Mar: 0, Apr: -12.5 } }]]);
    const r = ask({ date: '2026-09-15', itemOverrides: overridesOf(pending) }, d);
    expect(r.ok).toBe(true);
    expect(r.value).toEqual(expected(d, { pending }));
  });

  // At cent precision (what the editor stores unless a sub-cent amount is
  // typed in full), a sum of the rounded rows is the page's unrounded sum.
  it('a sum of displayed rows over the answer formats as the page\'s unrounded sum', () => {
    const d = data({ budgetItems: items().map(it => (it.id === 'food' ? { ...it, default_amount: -100.33 } : it)) });
    const pending = new Map([['fun', { monthly_schedule: { Jan: 15.55, Feb: true } }]]);
    const page = pagePlan(d, pending, NOW);
    const answer = ask({ date: '2026-09-15', itemOverrides: overridesOf(pending) }, d).value;
    const annual = new Map(answer.items.map(m => [m.id, m.annual]));
    const groups = [['food', 'fun', 'off', 'old', 'later'], ['mort', 'lent', 'norate', 'gone', 'bare'], ['pay', 'div'], ['move'], ['fun', 'later']];
    for (const ids of groups) {
      const rows = page.viewItems.filter(it => ids.includes(it.id));
      const fromAnswer = rows.reduce((s, it) => s + (it.include !== false ? annual.get(it.id) : 0), 0);
      expect(fmt(fromAnswer)).toBe(fmt(page.sumOf(rows)));
    }
  });

  it('an empty plan totals zero', () => {
    const d = data({ budgetItems: [] });
    expect(ask({}, d).value).toEqual({ items: [], totals: { income: 0, budget: 0, diff: 0 } });
  });

  it('refuses an override field the live controls never send, and a cut for no scenario', () => {
    const d = data();
    const bad = ask({ itemOverrides: [{ id: 'food', fields: { default_amount: -5 } }] }, d);
    expect(bad.ok).toBe(false);
    expect(bad.error.code).toBe('bad_input');
    const cut = ask({ itemOverrides: [{ id: 'food', fields: { stress_cut_pcts: { X: 0.5 } } }] }, d);
    expect(cut.ok).toBe(false);
    expect(cut.error.code).toBe('bad_input');
  });
});
