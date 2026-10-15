// tests/core-query-stress-runway.test.js — `stress.runway`, the Stress page's
// figures as a query: liquid cash, the buffer floor, usable cash and, per
// scenario, the plan's income, expense and net with the runway they give.
//
// The page's formulas are copied from js/pages/stress.js verbatim below, with
// `state` → the fixture, `viewTxs()` → the lens rows, and `viewItems()` → the
// dated plan with the page's unsaved edits over it (`viewOf`: the queued live
// fields, then this page's drag draft). The query gets the same edits as
// `itemOverrides` (the queued fields first, the draft after) and must equal the
// page: money after round2, the comparisons the page renders (deltaSign,
// netNegative, runway) from the unrounded figures, and months unrounded.
import { describe, it, expect } from 'vitest';
import { registry } from '../js/core/index.js';
import { runQuery } from '../js/core/pipeline.js';
import { makeCtx } from '../js/core/context.js';
import { lensTransactions, resolveHorizonDate } from '../js/engine/lens.js';
import { computeAccountBalances, isCrisisCashAccount } from '../js/engine/balances.js';
import { isIncomeLikeItem } from '../js/engine/_constants.js';
import { planItemsAsOf, itemDateStatus } from '../js/engine/item-dates.js';
import {
  SCENARIOS, isTransferItem, annualAmount, adjustedAnnual, itemsWithFlatLadder,
} from '../js/engine/stress.js';
import { round2, fmt } from '../js/utils.js';

function deepFreeze(o) { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); Object.values(o).forEach(deepFreeze); } return o; }
// Clocks are built from explicit components, so every test reads the same
// local calendar day under each zone test:tz runs.
const at = (y, m, d) => new Date(y, m - 1, d, 10, 0, 0);
const NOW = at(2026, 10, 15);
const ctxAt = (now) => makeCtx({ now, newId: (() => { let n = 0; return () => `q${++n}`; })() });
const ask = (input, d, now = NOW) => runQuery(registry, d, 'stress.runway', input, ctxAt(now));

const ALL_MONTHS = { Jan: true, Feb: true, Mar: true, Apr: true, May: true, Jun: true, Jul: true, Aug: true, Sep: true, Oct: true, Nov: true, Dec: true };
const COLUMNS = ['Baseline', ...SCENARIOS];

// A plan with every case the figures treat differently:
//   pay     income, scheduled on chk (forecast rows)
//   div     a dividend (income-like) with custom month amounts
//   rent    expense, category E, a per-scenario cut map, a buffer
//   food    expense, category B, a legacy scalar cut (a flat ladder), a buffer
//   fun     expense, category C, a flat cut map
//   gym     expense, category D, a flat map, smaller than fun
//   move    a transfer with a stale category, cut and buffer: never counted
//   off     include: false, with a buffer
//   old     ended in August (end_month before the date), flat cut, a buffer
//   later   starts next March: part of the coming year, keeps its buffer
//   zcat    category Z with a stale scalar cut: never cut
const items = () => [
  { id: 'pay', kind: 'income', description: 'Pay', default_amount: 1500, include: true, monthly_schedule: ALL_MONTHS,
    account_id: 'chk', as_schedule: true, as_schedule_since: '2026-10-01', payment_day: 25, schedule_day_type: 'exact', stress_category: null },
  { id: 'div', kind: 'investment_transfer', direction: 'dividend', description: 'Dividend', default_amount: 50, include: true,
    monthly_schedule: { Mar: 60.5, Sep: 40.25 }, stress_category: null },
  { id: 'rent', kind: 'expense', description: 'Rent', envelope_id: 'rent', default_amount: -1200, include: true, monthly_schedule: ALL_MONTHS,
    account_id: 'chk', as_schedule: true, as_schedule_since: '2026-10-01', payment_day: 1, schedule_day_type: 'exact',
    extra_buffer: 500, stress_category: 'E', stress_cut_pcts: { A: 0.5, B: 0.3, C: 0.2, D: 0.1, E: 0.05 } },
  { id: 'food', kind: 'expense', description: 'Food', envelope_id: 'groc', default_amount: -400, include: true, monthly_schedule: ALL_MONTHS,
    extra_buffer: 200, stress_category: 'B', stress_cut_pct: 0.25 },
  { id: 'fun', kind: 'expense', description: 'Fun', envelope_id: 'fun', default_amount: -100, include: true, monthly_schedule: ALL_MONTHS,
    stress_category: 'C', stress_cut_pcts: { A: 0.4, B: 0.4, C: 0.4 } },
  { id: 'gym', kind: 'expense', description: 'Gym', envelope_id: 'fun', default_amount: -50, include: true, monthly_schedule: ALL_MONTHS,
    stress_category: 'D', stress_cut_pcts: { A: 1, B: 1, C: 1, D: 1 } },
  { id: 'move', kind: 'account_transfer', description: 'To savings', default_amount: -300, include: true, monthly_schedule: ALL_MONTHS,
    extra_buffer: 999, stress_category: 'B', stress_cut_pct: 0.5 },
  { id: 'off', kind: 'expense', description: 'Off', envelope_id: 'fun', default_amount: -999, include: false, monthly_schedule: ALL_MONTHS,
    extra_buffer: 50, stress_category: 'A', stress_cut_pct: 0.5 },
  { id: 'old', kind: 'expense', description: 'Old', envelope_id: 'fun', default_amount: -700, include: true, monthly_schedule: ALL_MONTHS,
    end_month: '2026-08', extra_buffer: 77, stress_category: 'B', stress_cut_pcts: { A: 0.5, B: 0.5 } },
  { id: 'later', kind: 'expense', description: 'Later', envelope_id: 'fun', default_amount: -80, include: true, monthly_schedule: ALL_MONTHS,
    start_month: '2027-03', extra_buffer: 30, stress_category: null },
  { id: 'zcat', kind: 'expense', description: 'Never cut', envelope_id: 'fun', default_amount: -60, include: true, monthly_schedule: ALL_MONTHS,
    stress_category: 'Z', stress_cut_pct: 0.9 },
];

const data = (extra = {}) => deepFreeze({
  meta: {},
  accounts: [
    { id: 'chk', name: 'Checking', type: 'bank', initialBalance: 2000 },
    { id: 'sav', name: 'Savings', type: 'savings', initialBalance: 5000 },
    { id: 'emerg', name: 'Emergency fund', type: 'investment', initialBalance: 1000, crisisCash: true },
    { id: 'inv', name: 'Broker', type: 'investment', initialBalance: 9000 },
    { id: 'house', name: 'House', type: 'asset', initialBalance: 150000 },
    { id: 'oldsav', name: 'Old savings', type: 'savings', initialBalance: 777, archived: true },
  ],
  envelopes: [
    { id: 'rent', name: 'Rent', category: 'Housing' },
    { id: 'groc', name: 'Groceries', category: 'Food' },
    { id: 'fun', name: 'Fun', category: 'Life' },
  ],
  budgetItems: items(),
  envelopeTemplates: [],
  transactions: [
    { id: 'e1', type: 'expense', date: '2026-10-02', payee: 'A', amount: 100.255, account: 'chk', envelope_id: 'groc', status: 'posted' },
    { id: 'e2', type: 'expense', date: '2026-10-20', payee: 'B', amount: 250, account: 'chk', envelope_id: 'groc', status: 'scheduled' },
    { id: 'e3', type: 'expense', date: '2026-10-03', payee: 'C', amount: 40, account: 'oldsav', envelope_id: 'groc', status: 'posted' },
  ],
  ...extra,
});

// The page's viewTxs() for a fixture and a lens.
const viewTxsOf = (d, { lens = 'booked', horizon } = {}) => lensTransactions(d, { lens, horizon, today: NOW });

// The page's viewOf (js/pages/stress.js): the live queue's view (stored item
// with the queued fields over it), then this page's drag draft over that.
function pageViewOf(pending, drafts) {
  return (item) => {
    const queued = pending.get(item.id);
    const view = queued ? { ...item, ...queued } : item;
    const draft = drafts.get(item.id);
    return draft ? { ...view, stress_cut_pcts: draft } : view;
  };
}
// The same edits as the query's input: the queued fields, then the draft.
function overridesOf(pending, drafts) {
  const out = [];
  for (const [id, fields] of pending) out.push({ id, fields });
  for (const [id, cuts] of drafts) out.push({ id, fields: { stress_cut_pcts: cuts } });
  return out;
}

// ── The page's formulas, copied from js/pages/stress.js ────────────────────
function pageStress(state, viewTxs, viewItems) {
  // Total buffer floor across all included, non-income items. Cash on hand below
  // this level is "reserved" and unavailable to extend runway.
  function totalBufferFloor() {
    let total = 0;
    for (const it of viewItems()) {
      if (it.include === false) continue;
      if (isIncomeLikeItem(it)) continue;
      if (isTransferItem(it)) continue;
      total += Math.abs(it.extra_buffer ?? 0);
    }
    return total;
  }

  function usableCash() {
    return Math.max(0, liquidBalance() - totalBufferFloor());
  }

  function computeTotals(scenario) {
    let income = 0, expense = 0;
    for (const it of viewItems()) {
      if (it.include === false) continue;
      if (isTransferItem(it)) continue;
      const amt = adjustedAnnual(it, scenario);
      if (isIncomeLikeItem(it)) income += amt;
      else expense += amt;
    }
    return { income, expense, net: income - expense };
  }

  // Cash on hand in a crisis: see isCrisisCashAccount in js/engine/balances.js.
  function liquidBalance() {
    if (!state.accounts || !state.accounts.length) return 0;
    const balances = computeAccountBalances(state.accounts, viewTxs());
    let total = 0;
    for (const acc of state.accounts) {
      if (acc.archived || !isCrisisCashAccount(acc)) continue;
      total += balances.get(acc.id) ?? 0;
    }
    return total;
  }

  // Runway: cash on hand divided by monthly burn (annual burn / 12).
  function runwayMonths(scenario, cashOnHand) {
    const { income, expense } = computeTotals(scenario);
    const annualBurn = expense - income;
    if (annualBurn <= 0) return Infinity;
    if (cashOnHand <= 0) return 0;
    return cashOnHand / (annualBurn / 12);
  }

  function paintImpact(cell, impact) {
    cell.classList.remove('stress-negative', 'stress-positive');
    if (impact < -0.005) cell.classList.add('stress-negative');
    else if (impact > 0.005) cell.classList.add('stress-positive');
    cell.textContent = (impact >= 0 ? '+' : '') + fmt(impact);
  }

  return { totalBufferFloor, usableCash, computeTotals, liquidBalance, runwayMonths, paintImpact };
}

// A detail row's impact cell (js/pages/stress.js: `paintImpact(impCell,
// adjustedAnnual(it, scenario) - base)`, base = annualAmount(it)), read back
// as the sign its class shows.
function impactSignOf(page, impact) {
  const classes = new Set();
  const cell = { classList: { add: c => classes.add(c), remove: (...cs) => cs.forEach(c => classes.delete(c)) }, textContent: '' };
  page.paintImpact(cell, impact);
  return classes.has('stress-negative') ? -1 : classes.has('stress-positive') ? 1 : 0;
}

/**
 * What the page shows, in the query's answer shape. The page's row rules:
 * `delta = totals.net - baseline.net`, negative below -0.005 and positive
 * above 0.005; `totals.net < 0` is the negative net; a runway of Infinity is
 * the surplus, 0 with no usable cash is none.
 */
function expected(d, { lens = 'booked', horizon } = {}, { pending = new Map(), drafts = new Map(), date = NOW, detail = false } = {}) {
  const viewItems = () => planItemsAsOf(d.budgetItems.map(pageViewOf(pending, drafts)), date);
  const page = pageStress(d, () => viewTxsOf(d, { lens, horizon }), viewItems);
  const cash = page.usableCash();
  const baseline = page.computeTotals('Baseline');
  const out = {
    lens,
    horizon: lens === 'forecast' ? resolveHorizonDate(horizon ?? '3m', NOW) : null,
    extraExpenses: [],
    liquid: round2(page.liquidBalance()),
    bufferFloor: round2(page.totalBufferFloor()),
    usableCash: round2(cash),
    scenarios: COLUMNS.map((scenario) => {
      const totals = page.computeTotals(scenario);
      const delta = totals.net - baseline.net;
      const months = page.runwayMonths(scenario, cash);
      const runway = months === Infinity ? 'unlimited' : cash <= 0 ? 'none' : 'months';
      return {
        scenario,
        extraExpense: 0,
        income: round2(totals.income),
        expense: round2(totals.expense),
        net: round2(totals.net),
        netNegative: totals.net < 0,
        delta: round2(delta),
        deltaSign: delta < -0.005 ? -1 : delta > 0.005 ? 1 : 0,
        runway,
        months: runway === 'months' ? months : null,
      };
    }),
  };
  if (detail) {
    const view = viewItems();
    // hasEnded (js/pages/stress.js): itemDateStatus(item, now()).status === 'ended'
    const hasEnded = (item) => itemDateStatus(item, date).status === 'ended';
    out.items = view.map((it) => {
      const base = annualAmount(it);
      return {
        id: it.id,
        annual: round2(base),
        adjusted: Object.fromEntries(SCENARIOS.map(s => [s, round2(adjustedAnnual(it, s))])),
        impact: Object.fromEntries(SCENARIOS.map(s => [s, round2(adjustedAnnual(it, s) - base)])),
        impactSign: Object.fromEntries(SCENARIOS.map(s => [s, impactSignOf(page, adjustedAnnual(it, s) - base)])),
      };
    });
    out.flatLadder = itemsWithFlatLadder(view.filter(it => !hasEnded(it) && Math.abs(annualAmount(it)) >= 0.005)).map(it => it.id);
  }
  return out;
}

const scenario = (v, s) => v.scenarios.find(r => r.scenario === s);

describe('stress.runway equals the Stress page', () => {
  it('is registered as a query', () => {
    expect(registry.get('stress.runway')?.kind).toBe('query');
  });

  it('the default: booked lens, no edits', () => {
    const d = data();
    const r = ask({}, d);
    expect(r.ok, JSON.stringify(r.error)).toBe(true);
    expect(r.value).toEqual(expected(d));
    // The rows, Baseline first, then A..E.
    expect(r.value.scenarios.map(s => s.scenario)).toEqual(COLUMNS);
    // A mixed fixture: a burn at Baseline, a surplus once rent is halved.
    expect(scenario(r.value, 'Baseline').runway).toBe('months');
    expect(scenario(r.value, 'A').runway).toBe('unlimited');
    expect(scenario(r.value, 'A').months).toBeNull();
    expect(scenario(r.value, 'Baseline').deltaSign).toBe(0);
    expect(scenario(r.value, 'Baseline').delta).toBe(0);
    expect(scenario(r.value, 'A').deltaSign).toBe(1);
    expect(scenario(r.value, 'Baseline').netNegative).toBe(true);
    expect(r.value.items).toBeUndefined();
    expect(r.value.flatLadder).toBeUndefined();
  });

  it('the answer is plain JSON', () => {
    const r = ask({ detail: true }, data());
    expect(JSON.parse(JSON.stringify(r.value))).toEqual(r.value);
  });

  it.each([
    ['booked', { lens: 'booked' }],
    ['today', { lens: 'today' }],
    ['forecast (default horizon)', { lens: 'forecast' }],
    ['forecast eom', { lens: 'forecast', horizon: 'eom' }],
    ['forecast 12m', { lens: 'forecast', horizon: '12m' }],
  ])('the %s lens', (_label, lensInput) => {
    const d = data();
    const r = ask(lensInput, d);
    expect(r.ok, JSON.stringify(r.error)).toBe(true);
    expect(r.value).toEqual(expected(d, lensInput));
  });

  it('the lens moves the cash: today, booked and forecast differ', () => {
    const d = data();
    const liquid = (input) => ask(input, d).value.liquid;
    // booked has the scheduled e2; the forecast adds the pay and rent rows.
    expect(liquid({ lens: 'today' })).not.toBe(liquid({ lens: 'booked' }));
    expect(liquid({ lens: 'forecast', horizon: '6m' })).not.toBe(liquid({ lens: 'booked' }));
  });

  it('liquid: crisis-cash accounts only, archived ones left out', () => {
    const v = ask({}, data()).value;
    // chk 2000 - 100.255 - 250, sav 5000, emerg 1000 (crisisCash); not inv, house or oldsav.
    expect(v.liquid).toBe(round2(2000 - 100.255 - 250 + 5000 + 1000));
  });

  it('the buffer floor: included expense items of the dated plan; not income, transfers, excluded or ended items', () => {
    const v = ask({}, data()).value;
    // rent 500 + food 200 + later 30; not move (999), off (50) or old (77, ended).
    expect(v.bufferFloor).toBe(730);
    expect(v.usableCash).toBe(round2(v.liquid - 730));
  });

  it('transfer items count in neither income nor expense', () => {
    const d = data();
    const without = data({ budgetItems: items().filter(it => it.id !== 'move') });
    const a = ask({}, d).value; const b = ask({}, without).value;
    expect(a).toEqual(b);
    expect(a).toEqual(expected(d));
  });

  it('income-like items count as income: the dividend', () => {
    const v = ask({}, data()).value;
    expect(scenario(v, 'Baseline').income).toBe(round2(1500 * 12 + 60.5 + 40.25));
  });

  it('an item with include: false counts nothing', () => {
    const d = data();
    const without = data({ budgetItems: items().filter(it => it.id !== 'off') });
    expect(ask({}, d).value).toEqual(ask({}, without).value);
  });

  it('an ended item counts nothing; one starting later counts its months in the coming year', () => {
    const v = ask({ detail: true }, data()).value;
    const byId = Object.fromEntries(v.items.map(it => [it.id, it]));
    expect(byId.old.annual).toBe(0);
    expect(byId.later.annual).toBe(80 * 7); // Mar..Sep 2027
  });

  it('legacy scalar cuts apply to every scenario the category hits', () => {
    const v = ask({ detail: true }, data()).value;
    const food = v.items.find(it => it.id === 'food');
    expect(food.adjusted).toEqual({ A: 3600, B: 3600, C: 4800, D: 4800, E: 4800 });
  });

  it('a Z category is never cut', () => {
    const v = ask({ detail: true }, data()).value;
    const z = v.items.find(it => it.id === 'zcat');
    expect(z.adjusted).toEqual({ A: 720, B: 720, C: 720, D: 720, E: 720 });
  });

  it('no liquid accounts: no cash, and a burn has no runway', () => {
    const d = data({ accounts: [
      { id: 'inv', name: 'Broker', type: 'investment', initialBalance: 9000 },
      { id: 'house', name: 'House', type: 'asset', initialBalance: 150000 },
    ], transactions: [] });
    const v = ask({}, d).value;
    expect(v).toEqual(expected(d));
    expect(v).toMatchObject({ liquid: 0, usableCash: 0 });
    expect(scenario(v, 'Baseline')).toMatchObject({ runway: 'none', months: null });
    // burn ≤ 0 is checked first: a surplus is unlimited even with no cash.
    expect(scenario(v, 'A')).toMatchObject({ runway: 'unlimited', months: null });

    const none = data({ accounts: [], transactions: [] });
    expect(ask({}, none).value).toEqual(expected(none));
    expect(ask({}, none).value.liquid).toBe(0);
  });

  it('cash ≤ 0: an overdrawn account', () => {
    const d = data({ accounts: [{ id: 'chk', name: 'Checking', type: 'bank', initialBalance: -500 }], transactions: [] });
    const v = ask({}, d).value;
    expect(v).toEqual(expected(d));
    expect(v).toMatchObject({ liquid: -500, usableCash: 0 });
    expect(scenario(v, 'Baseline').runway).toBe('none');
  });

  it('a buffer floor larger than the cash: no usable cash', () => {
    const d = data({ accounts: [{ id: 'sav', name: 'Savings', type: 'savings', initialBalance: 500 }], transactions: [] });
    const v = ask({}, d).value;
    expect(v).toEqual(expected(d));
    expect(v).toMatchObject({ liquid: 500, bufferFloor: 730, usableCash: 0 });
    expect(scenario(v, 'Baseline').runway).toBe('none');
  });

  it('burn ≤ 0: exactly balanced is unlimited', () => {
    const d = data({ budgetItems: [
      { id: 'in', kind: 'income', default_amount: 100, include: true, monthly_schedule: ALL_MONTHS },
      { id: 'out', kind: 'expense', default_amount: -100, include: true, monthly_schedule: ALL_MONTHS, stress_category: 'A', stress_cut_pct: 0.5 },
    ] });
    const v = ask({}, d).value;
    expect(v).toEqual(expected(d));
    expect(scenario(v, 'Baseline')).toMatchObject({ net: 0, netNegative: false, runway: 'unlimited', months: null });
    expect(scenario(v, 'A')).toMatchObject({ delta: 600, deltaSign: 1, runway: 'unlimited' });
  });

  it('months are unrounded; the delta sign follows the unrounded delta', () => {
    // A cut that moves the net by 0.0045, less than half a cent: no sign,
    // though the two rounded nets (-2800.01 and -2800.00) are a cent apart.
    const d = data({ budgetItems: [
      { id: 'in', kind: 'income', default_amount: 100, include: true, monthly_schedule: ALL_MONTHS },
      { id: 'out', kind: 'expense', default_amount: -1, include: true, monthly_schedule: { Jan: 4000.0052 }, stress_category: 'A', stress_cut_pcts: { A: 0.0045 / 4000.0052 } },
    ] });
    const v = ask({ detail: true }, d).value;
    expect(v).toEqual(expected(d, {}, { detail: true }));
    expect(scenario(v, 'Baseline').net).toBe(-2800.01);
    expect(scenario(v, 'A').net).toBe(-2800);
    expect(scenario(v, 'A').deltaSign).toBe(0);
    // The item's impact at A is the same 0.0045 (a saving, so negative): no sign either.
    expect(v.items.find(it => it.id === 'out').impactSign.A).toBe(0);
    expect(Number.isInteger(scenario(v, 'Baseline').months * 100)).toBe(false);
  });

  it('the date dates the plan: an item ended by then counts nothing', () => {
    const d = data();
    const later = at(2027, 6, 10);
    const r = ask({ date: '2027-06-10', detail: true }, d);
    expect(r.ok, JSON.stringify(r.error)).toBe(true);
    expect(r.value).toEqual(expected(d, {}, { date: later, detail: true }));
  });
});

describe('stress.runway itemOverrides: the page\'s unsaved edits', () => {
  const run = (d, pending, drafts, opts = {}) => {
    const r = ask({ itemOverrides: overridesOf(pending, drafts), ...opts.input }, d);
    expect(r.ok, JSON.stringify(r.error)).toBe(true);
    return r.value;
  };

  it('a cut drag (the draft) replaces the item\'s cut map', () => {
    const d = data();
    const drafts = new Map([['rent', { A: 0.9, B: 0.9, C: 0.1, D: 0, E: 0 }]]);
    const v = run(d, new Map(), drafts);
    expect(v).toEqual(expected(d, {}, { drafts }));
    expect(v).not.toEqual(ask({}, d).value);
  });

  it('a pending monthly_schedule edit (the Plan page\'s queue)', () => {
    const d = data();
    const pending = new Map([['food', { monthly_schedule: { Jan: true, Feb: 55.5 } }]]);
    const v = run(d, pending, new Map(), { input: { detail: true } });
    expect(v).toEqual(expected(d, {}, { pending, detail: true }));
    expect(v.items.find(it => it.id === 'food').annual).toBe(455.5);
  });

  it('a stored-shaped schedule: a negative and a zero month value', () => {
    const d = data();
    const pending = new Map([['food', { monthly_schedule: { Jan: -120, Feb: 0, Mar: true, Apr: false } }]]);
    const v = run(d, pending, new Map(), { input: { detail: true } });
    expect(v).toEqual(expected(d, {}, { pending, detail: true }));
    // |-120| + 0 + the default 400; April off.
    expect(v.items.find(it => it.id === 'food').annual).toBe(520);
  });

  it('include and include_in_emergency_budget', () => {
    const d = data();
    const pending = new Map([['pay', { include: false }], ['rent', { include_in_emergency_budget: true }]]);
    const v = run(d, pending, new Map());
    expect(v).toEqual(expected(d, {}, { pending }));
    expect(scenario(v, 'Baseline').income).toBe(round2(60.5 + 40.25));
  });

  it('an unknown id is ignored', () => {
    const d = data();
    const r = ask({ itemOverrides: [{ id: 'deleted-meanwhile', fields: { include: false } }] }, d);
    expect(r.ok, JSON.stringify(r.error)).toBe(true);
    expect(r.value).toEqual(ask({}, d).value);
  });

  it('an unknown id among known ones: the known overrides still apply', () => {
    const d = data();
    const known = [{ id: 'pay', fields: { include: false } }];
    const mixed = [{ id: 'deleted-meanwhile', fields: { include: false } }, ...known, { id: 'gone-too', fields: { stress_category: 'A' } }];
    const r = ask({ itemOverrides: mixed, detail: true }, d);
    expect(r.ok, JSON.stringify(r.error)).toBe(true);
    expect(r.value).toEqual(ask({ itemOverrides: known, detail: true }, d).value);
    expect(r.value).not.toEqual(ask({ detail: true }, d).value);
  });

  it('two entries for one id: both lie over the item, the later winning a field both set', () => {
    const d = data();
    // A category change queued (with its cleared cuts), then a drag on the new category.
    const pending = new Map([['fun', { stress_category: 'E', stress_cut_pcts: null, stress_cut_pct: 0 }]]);
    const drafts = new Map([['fun', { A: 0.8, B: 0.6, C: 0.4, D: 0.2, E: 0.1 }]]);
    const v = run(d, pending, drafts, { input: { detail: true } });
    expect(v).toEqual(expected(d, {}, { pending, drafts, detail: true }));
    expect(v.items.find(it => it.id === 'fun').adjusted).toEqual({ A: 240, B: 480, C: 720, D: 960, E: 1080 });
  });

  it('a cleared category: stress_cut_pcts null falls back to the scalar', () => {
    const d = data();
    const pending = new Map([['rent', { stress_category: null, stress_cut_pcts: null, stress_cut_pct: 0 }]]);
    const v = run(d, pending, new Map(), { input: { detail: true } });
    expect(v).toEqual(expected(d, {}, { pending, detail: true }));
    expect(v.items.find(it => it.id === 'rent').adjusted).toEqual({ A: 14400, B: 14400, C: 14400, D: 14400, E: 14400 });
  });

  it('the forecast lens with edits', () => {
    const d = data();
    const drafts = new Map([['rent', { A: 0.2 }]]);
    const v = run(d, new Map(), drafts, { input: { lens: 'forecast', horizon: '6m' } });
    expect(v).toEqual(expected(d, { lens: 'forecast', horizon: '6m' }, { drafts }));
  });

  it('leaves the stored items alone', () => {
    const d = data();
    const before = JSON.stringify(d.budgetItems);
    run(d, new Map([['rent', { include: false }]]), new Map([['food', { A: 1 }]]));
    expect(JSON.stringify(d.budgetItems)).toBe(before);
  });
});

describe('stress.runway detail', () => {
  it('every dated, overlaid item with its annual and stressed amounts; the flat ladder without ended items', () => {
    const d = data();
    const drafts = new Map([['rent', { A: 0.3, B: 0.3, C: 0.3, D: 0.3, E: 0.3 }]]);
    const r = ask({ detail: true, itemOverrides: overridesOf(new Map(), drafts) }, d);
    expect(r.ok, JSON.stringify(r.error)).toBe(true);
    expect(r.value).toEqual(expected(d, {}, { drafts, detail: true }));
    expect(r.value.items.map(it => it.id)).toEqual(d.budgetItems.map(it => it.id));
    // Annual desc: rent (now flat) 14400, food 4800, fun 1200, gym 600; not old (ended), move, off.
    expect(r.value.flatLadder).toEqual(['rent', 'food', 'fun', 'gym']);
  });

  it('the flat ladder leaves out an item worth nothing a year', () => {
    const gym = items().find(it => it.id === 'gym');
    const d = data({ budgetItems: [...items(), { ...gym, id: 'zero', description: 'Zero', default_amount: 0 }] });
    const r = ask({ detail: true }, d);
    expect(itemsWithFlatLadder(d.budgetItems).map(it => it.id)).toContain('zero');
    expect(r.value.flatLadder).toContain('gym');
    expect(r.value.flatLadder).not.toContain('zero');
  });

  it('the flat ladder is the engine\'s, ended items left out', () => {
    const d = data();
    const view = planItemsAsOf(d.budgetItems, NOW);
    const r = ask({ detail: true }, d);
    expect(r.value.flatLadder).toEqual(itemsWithFlatLadder(view.filter(it => itemDateStatus(it, NOW).status !== 'ended'
      && Math.abs(annualAmount(it)) >= 0.005)).map(it => it.id));
    expect(r.value.flatLadder).not.toContain('old');
    for (const it of r.value.items) {
      const src = view.find(x => x.id === it.id);
      expect(it.annual).toBe(round2(annualAmount(src)));
      for (const s of SCENARIOS) {
        expect(it.adjusted[s]).toBe(round2(adjustedAnnual(src, s)));
        expect(it.impact[s]).toBe(round2(adjustedAnnual(src, s) - annualAmount(src)));
      }
    }
  });

  it('impact and its sign per scenario: a cut is a negative impact, no cut none', () => {
    const v = ask({ detail: true }, data()).value;
    const rent = v.items.find(it => it.id === 'rent');
    expect(rent.impact).toEqual({ A: -7200, B: -4320, C: -2880, D: -1440, E: -720 });
    expect(rent.impactSign).toEqual({ A: -1, B: -1, C: -1, D: -1, E: -1 });
    const food = v.items.find(it => it.id === 'food');
    expect(food.impact).toEqual({ A: -1200, B: -1200, C: 0, D: 0, E: 0 });
    expect(food.impactSign).toEqual({ A: -1, B: -1, C: 0, D: 0, E: 0 });
  });
});

describe('stress.runway input', () => {
  const refused = (input) => {
    const r = ask(input, data());
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe('bad_input');
    return r.error.params.errors;
  };

  it('refuses a field outside the six', () => {
    const errors = refused({ itemOverrides: [{ id: 'rent', fields: { default_amount: -5 } }] });
    expect(errors).toEqual([{ path: 'itemOverrides[0].fields.default_amount', message: 'is not a known field' }]);
  });

  it('refuses a cut outside 0..1', () => {
    expect(refused({ itemOverrides: [{ id: 'rent', fields: { stress_cut_pcts: { A: 1.5 } } }] })[0].path).toBe('itemOverrides[0].fields.stress_cut_pcts.A');
    expect(refused({ itemOverrides: [{ id: 'rent', fields: { stress_cut_pct: -0.1 } }] })[0].path).toBe('itemOverrides[0].fields.stress_cut_pct');
  });

  it('refuses an unknown category, a scenario key outside A..E, a bad month and a missing id', () => {
    expect(refused({ itemOverrides: [{ id: 'rent', fields: { stress_category: 'F' } }] })[0].path).toBe('itemOverrides[0].fields.stress_category');
    expect(refused({ itemOverrides: [{ id: 'rent', fields: { stress_cut_pcts: { Baseline: 0.5 } } }] })[0].path).toBe('itemOverrides[0].fields.stress_cut_pcts.Baseline');
    expect(refused({ itemOverrides: [{ id: 'rent', fields: { monthly_schedule: { Foo: true } } }] })[0].path).toBe('itemOverrides[0].fields.monthly_schedule.Foo');
    expect(refused({ itemOverrides: [{ id: 'rent', fields: { monthly_schedule: { Jan: 'lots' } } }] })[0].path).toBe('itemOverrides[0].fields.monthly_schedule.Jan');
    expect(refused({ itemOverrides: [{ fields: { include: false } }] })[0].path).toBe('itemOverrides[0].id');
  });

  it('refuses a horizon without the forecast lens', () => {
    expect(refused({ horizon: '3m' })[0].path).toBe('horizon');
  });
});
