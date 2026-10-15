// What-if scenarios as a transform of the simulation's forecast rows
// (spec: docs/superpowers/specs/2026-09-28-what-if-scenarios-design.md).
// Every test passes an explicit clock; the engine reads none.
import { describe, it, expect, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
import {
  simulate, normalizeScenarios, applyScenario, diffAlerts,
} from '../../js/engine.js';
import { _resetSimulationCache } from '../../js/engine/simulation.js';
import { _resetLensCache } from '../../js/engine/lens.js';

// ─── applyScenario ─────────────────────────────────────────────────────────

const accounts = [
  { id: 'chk', type: 'bank' },
  { id: 'sav', type: 'savings' },
  { id: 'old', type: 'bank', archived: true },
];
const budgetItems = [
  { id: 'sal', kind: 'income', account_id: 'chk' },
  { id: 'side', kind: 'income', account_id: 'chk', stress_category: 'E' },
  { id: 'div', kind: 'investment_transfer', direction: 'dividend' },
  { id: 'buy', kind: 'investment_transfer', direction: 'buy' },
  { id: 'rent', envelope_id: 'e1', account_id: 'chk', stress_category: 'D' },
  { id: 'gym', envelope_id: 'e2', account_id: 'chk', stress_category: 'A' },
];

const fc = (item, date, type, amount, extra = {}) => ({
  id: `forecast:${item}:${date.slice(0, 7)}`, is_forecast: true,
  forecast_budget_item_id: item, forecast_month_key: date.slice(0, 7),
  date, status: 'scheduled', type, amount, account: 'chk', envelope_id: null, ...extra,
});

function rows() {
  return [
    fc('sal', '2026-10-05', 'income', 2000),
    fc('sal', '2026-11-05', 'income', 2000),
    fc('side', '2026-11-20', 'income', 300),
    fc('div', '2026-11-15', 'investment_transfer', 50, { direction: 'dividend', from_account: 'sav', to_account: 'chk' }),
    fc('buy', '2026-11-16', 'investment_transfer', 100, { direction: 'buy', from_account: 'chk', to_account: 'sav' }),
    fc('rent', '2026-10-05', 'expense', 800, { envelope_id: 'e1' }),
    fc('rent', '2026-11-05', 'expense', 800, { envelope_id: 'e1' }),
    fc('gym', '2026-11-10', 'expense', 40, { envelope_id: 'e2' }),
    // Booked (a real, future-dated transaction): never changed.
    { id: 'booked-inc', type: 'income', date: '2026-11-25', amount: 999, account: 'chk' },
    // A forecast row without a plan item: not a plan row, never changed.
    { id: 'fc-noitem', is_forecast: true, type: 'income', date: '2026-11-26', amount: 10, account: 'chk' },
  ];
}

const ctx = { budgetItems, accounts, startIso: '2026-09-28', endIso: '2027-09-30' };
const scen = (...changes) => ({ id: 's1', name: 'Test', changes });
const byId = (list) => new Map(list.map(r => [r.id, r]));
const amountOf = (list, id) => byId(list).get(id)?.amount;

describe('applyScenario — income', () => {
  it('scales every income-like plan row dated in or after the month', () => {
    const out = applyScenario(rows(), scen({ type: 'income', pct: -20, from: '2026-11' }), ctx);
    expect(out).toHaveLength(rows().length);
    expect(amountOf(out, 'forecast:sal:2026-10')).toBe(2000);
    expect(amountOf(out, 'forecast:sal:2026-11')).toBe(1600);
    expect(amountOf(out, 'forecast:side:2026-11')).toBe(240);
    expect(amountOf(out, 'forecast:div:2026-11')).toBe(40);
    // Not income-like: a buy, expenses.
    expect(amountOf(out, 'forecast:buy:2026-11')).toBe(100);
    expect(amountOf(out, 'forecast:rent:2026-11')).toBe(800);
    // Booked and item-less forecast rows untouched.
    expect(amountOf(out, 'booked-inc')).toBe(999);
    expect(amountOf(out, 'fc-noitem')).toBe(10);
  });

  it('limits the change to one income item with itemId', () => {
    const out = applyScenario(rows(), scen({ type: 'income', pct: 50, from: '2026-10', itemId: 'side' }), ctx);
    expect(amountOf(out, 'forecast:side:2026-11')).toBe(450);
    expect(amountOf(out, 'forecast:sal:2026-10')).toBe(2000);
    expect(amountOf(out, 'forecast:sal:2026-11')).toBe(2000);
    expect(amountOf(out, 'forecast:div:2026-11')).toBe(50);
  });

  it('−100 % drops the income rows instead of keeping zero-amount rows', () => {
    const out = applyScenario(rows(), scen({ type: 'income', pct: -100, from: '2026-10', itemId: 'sal' }), ctx);
    expect(byId(out).has('forecast:sal:2026-10')).toBe(false);
    expect(byId(out).has('forecast:sal:2026-11')).toBe(false);
    expect(out).toHaveLength(rows().length - 2);
  });
});

describe('applyScenario — monthly amount', () => {
  it('adds money in on the day of every month from..until', () => {
    const out = applyScenario(rows(), scen({ type: 'monthly', amount: 200, account: 'sav', from: '2026-10', until: '2026-12', day: 15 }), ctx);
    const added = out.filter(r => r.whatif);
    expect(added.map(r => r.date)).toEqual(['2026-10-15', '2026-11-15', '2026-12-15']);
    expect(added[0]).toMatchObject({
      id: 'whatif:s1:0:2026-10-15', is_forecast: true, whatif: true,
      type: 'income', amount: 200, account: 'sav', envelope_id: null,
    });
    expect(added.some(r => r.whatif_once)).toBe(false);
    // The input's rows are all still there, unchanged.
    expect(out.slice(0, rows().length)).toEqual(rows());
  });

  it('a negative amount is money out', () => {
    const out = applyScenario(rows(), scen({ type: 'monthly', amount: -150, account: 'chk', from: '2026-10', until: '2026-10' }), ctx);
    const added = out.filter(r => r.whatif);
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ type: 'expense', amount: 150, account: 'chk', date: '2026-10-01', envelope_id: null });
  });

  it('with toAccount it is a transfer of the magnitude, whatever the sign', () => {
    for (const amount of [200, -200]) {
      const out = applyScenario(rows(), scen({ type: 'monthly', amount, account: 'chk', toAccount: 'sav', from: '2026-10', until: '2026-10', day: 3 }), ctx);
      const added = out.filter(r => r.whatif);
      expect(added).toHaveLength(1);
      expect(added[0]).toMatchObject({
        id: 'whatif:s1:0:2026-10-03', type: 'account_transfer', amount: 200,
        from_account: 'chk', to_account: 'sav', envelope_id: null,
      });
      expect(added[0].account).toBeUndefined();
    }
  });

  it('defaults to day 1, runs open-ended, and stays inside [startIso, endIso]', () => {
    const c = { ...ctx, endIso: '2027-01-31' };
    const out = applyScenario(rows(), scen({ type: 'monthly', amount: 10, account: 'chk', from: '2026-09' }), c);
    // 2026-09-01 is before startIso (2026-09-28).
    expect(out.filter(r => r.whatif).map(r => r.date))
      .toEqual(['2026-10-01', '2026-11-01', '2026-12-01', '2027-01-01']);
    const onStart = applyScenario(rows(), scen({ type: 'monthly', amount: 10, account: 'chk', from: '2026-09', day: 28 }), c);
    expect(onStart.filter(r => r.whatif)[0].date).toBe('2026-09-28');
  });

  it('numbers ids by the change index', () => {
    const out = applyScenario(rows(), scen(
      { type: 'income', pct: 10, from: '2026-10' },
      { type: 'monthly', amount: 10, account: 'chk', from: '2026-10', until: '2026-10' },
    ), ctx);
    expect(out.filter(r => r.whatif).map(r => r.id)).toEqual(['whatif:s1:1:2026-10-01']);
  });
});

describe('applyScenario — zero amounts', () => {
  it('emits no synthetic row for an amount that rounds to zero', () => {
    const out = applyScenario(rows(), scen(
      { type: 'monthly', amount: 0.001, account: 'chk', from: '2026-10', until: '2026-11' },
      { type: 'oneoff', date: '2026-12-01', amount: 0, account: 'chk', label: 'x' },
    ), ctx);
    expect(out.filter(r => r.whatif)).toEqual([]);
  });
});

describe('applyScenario — one-off', () => {
  it('adds one row inside the window, flagged as not recurring', () => {
    const out = applyScenario(rows(), scen({ type: 'oneoff', date: '2027-01-15', amount: -3000, account: 'chk', label: 'Car' }), ctx);
    const added = out.filter(r => r.whatif);
    expect(added).toEqual([expect.objectContaining({
      id: 'whatif:s1:0:2027-01-15', is_forecast: true, whatif: true, whatif_once: true,
      type: 'expense', amount: 3000, account: 'chk', envelope_id: null, date: '2027-01-15', payee: 'Car',
    })]);
    const inc = applyScenario(rows(), scen({ type: 'oneoff', date: '2027-01-15', amount: 500, account: 'sav', label: 'Gift' }), ctx);
    expect(inc.filter(r => r.whatif)[0]).toMatchObject({ type: 'income', amount: 500, account: 'sav' });
  });

  it('adds nothing outside the window', () => {
    for (const date of ['2026-09-27', '2027-10-01']) {
      const out = applyScenario(rows(), scen({ type: 'oneoff', date, amount: -10, account: 'chk', label: 'x' }), ctx);
      expect(out.filter(r => r.whatif)).toEqual([]);
    }
  });
});

describe('applyScenario — Stress scenario', () => {
  // A stand-in for the page's stressCutFor cut: a category at or above the
  // scenario's level is hit, at 50 %.
  const stressCut = (item, s) => (item.stress_category && s <= item.stress_category ? 0.5 : 0);

  it('cuts every hit plan row from the month by the item\'s cut, income included', () => {
    const out = applyScenario(rows(), scen({ type: 'stress', scenario: 'B', from: '2026-11' }), { ...ctx, stressCut });
    expect(amountOf(out, 'forecast:rent:2026-10')).toBe(800);  // before `from`
    expect(amountOf(out, 'forecast:rent:2026-11')).toBe(400);
    expect(amountOf(out, 'forecast:gym:2026-11')).toBe(40);    // category A: not hit by B
    expect(amountOf(out, 'forecast:side:2026-11')).toBe(150);  // income with a category
    expect(amountOf(out, 'forecast:sal:2026-11')).toBe(2000);  // no category
    expect(amountOf(out, 'booked-inc')).toBe(999);
  });

  it('drops a row cut by 100 %', () => {
    const out = applyScenario(rows(), scen({ type: 'stress', scenario: 'A', from: '2026-11' }),
      { ...ctx, stressCut: (item) => (item.id === 'rent' ? 1 : 0) });
    expect(byId(out).has('forecast:rent:2026-11')).toBe(false);
    expect(amountOf(out, 'forecast:rent:2026-10')).toBe(800);
  });

  it('does nothing without a stressCut', () => {
    const out = applyScenario(rows(), scen({ type: 'stress', scenario: 'A', from: '2026-10' }), ctx);
    expect(out).toEqual(rows());
  });

  it('composes with an income change, in order', () => {
    const out = applyScenario(rows(), scen(
      { type: 'income', pct: -50, from: '2026-10', itemId: 'side' },
      { type: 'stress', scenario: 'E', from: '2026-10' },
    ), { ...ctx, stressCut });
    expect(amountOf(out, 'forecast:side:2026-11')).toBe(75);
  });
});

describe('applyScenario — purity', () => {
  it('never mutates the input array or its rows', () => {
    const input = rows();
    const before = structuredClone(input);
    const out = applyScenario(input, scen(
      { type: 'income', pct: -20, from: '2026-10' },
      { type: 'monthly', amount: 50, account: 'sav', from: '2026-10' },
      { type: 'oneoff', date: '2026-12-01', amount: -5, account: 'chk', label: 'x' },
      { type: 'stress', scenario: 'A', from: '2026-10' },
    ), { ...ctx, stressCut: () => 0.25 });
    expect(out).not.toBe(input);
    expect(input).toEqual(before);
  });

  it('returns a copy of the rows for a missing or empty scenario', () => {
    const input = rows();
    expect(applyScenario(input, null, ctx)).toEqual(input);
    expect(applyScenario(input, scen(), ctx)).toEqual(input);
    expect(applyScenario(input, scen(), ctx)).not.toBe(input);
  });
});

// ─── normalizeScenarios ────────────────────────────────────────────────────

describe('normalizeScenarios', () => {
  const env = { accounts, budgetItems };
  const good = [
    { type: 'income', pct: -20, from: '2027-03' },
    { type: 'income', pct: 500, from: '2027-03', itemId: 'div' },
    { type: 'monthly', amount: 200, account: 'chk', toAccount: 'sav', from: '2026-10', until: '2027-06', day: 28 },
    { type: 'monthly', amount: -50, account: 'chk', from: '2026-10' },
    { type: 'oneoff', date: '2027-01-15', amount: -3000, account: 'chk', label: 'Car' },
    { type: 'stress', scenario: 'B', from: '2027-01' },
  ];

  it('keeps valid scenarios and changes as they are', () => {
    expect(normalizeScenarios([{ id: 's1', name: 'All', changes: good }], env))
      .toEqual([{ id: 's1', name: 'All', changes: good }]);
  });

  it('strips unknown keys from a change', () => {
    const out = normalizeScenarios([{ id: 's1', name: 'x', changes: [{ ...good[4], junk: 1 }] }], env);
    expect(out[0].changes[0]).toEqual(good[4]);
  });

  it('reads anything that is not an array as none', () => {
    for (const raw of [undefined, null, {}, 'x', 3]) expect(normalizeScenarios(raw, env)).toEqual([]);
  });

  it('drops each kind of malformed change', () => {
    const bad = [
      null, 'x', { type: 'nope', from: '2027-01' },
      // bad months and dates
      { type: 'income', pct: 10, from: '2027-13' },
      { type: 'income', pct: 10, from: '2027-3' },
      { type: 'income', pct: 10 },
      { type: 'stress', scenario: 'B', from: '2027-00' },
      { type: 'monthly', amount: 10, account: 'chk', from: '2027-01', until: 'soon' },
      { type: 'monthly', amount: 10, account: 'chk', from: '2027-05', until: '2027-04' },
      { type: 'oneoff', date: '2027-02-30', amount: 1, account: 'chk', label: 'x' },
      { type: 'oneoff', date: '2027-01', amount: 1, account: 'chk', label: 'x' },
      // non-finite and zero amounts
      { type: 'monthly', amount: 0, account: 'chk', from: '2027-01' },
      { type: 'oneoff', date: '2027-01-15', amount: 0, account: 'chk', label: 'x' },
      { type: 'oneoff', date: '2027-01-15', amount: -0, account: 'chk', label: 'x' },
      { type: 'monthly', amount: NaN, account: 'chk', from: '2027-01' },
      { type: 'monthly', amount: '200', account: 'chk', from: '2027-01' },
      { type: 'oneoff', date: '2027-01-15', amount: Infinity, account: 'chk', label: 'x' },
      { type: 'income', pct: NaN, from: '2027-01' },
      // pct out of range
      { type: 'income', pct: -101, from: '2027-01' },
      { type: 'income', pct: 501, from: '2027-01' },
      // accounts: unknown, archived, identical
      { type: 'monthly', amount: 10, account: 'ghost', from: '2027-01' },
      { type: 'monthly', amount: 10, account: 'old', from: '2027-01' },
      { type: 'monthly', amount: 10, account: 'chk', toAccount: 'chk', from: '2027-01' },
      { type: 'monthly', amount: 10, account: 'chk', toAccount: 'ghost', from: '2027-01' },
      { type: 'oneoff', date: '2027-01-15', amount: 1, account: 'old', label: 'x' },
      // day outside 1–28
      { type: 'monthly', amount: 10, account: 'chk', from: '2027-01', day: 29 },
      { type: 'monthly', amount: 10, account: 'chk', from: '2027-01', day: 0 },
      { type: 'monthly', amount: 10, account: 'chk', from: '2027-01', day: 1.5 },
      // unknown or non-income itemId
      { type: 'income', pct: 10, from: '2027-01', itemId: 'ghost' },
      { type: 'income', pct: 10, from: '2027-01', itemId: 'rent' },
      { type: 'income', pct: 10, from: '2027-01', itemId: 'buy' },
      // unknown Stress scenario
      { type: 'stress', scenario: 'F', from: '2027-01' },
      { type: 'stress', scenario: 'a', from: '2027-01' },
    ];
    for (const b of bad) {
      const out = normalizeScenarios([{ id: 's1', name: 'x', changes: [good[0], b] }], env);
      expect(out, JSON.stringify(b)).toEqual([{ id: 's1', name: 'x', changes: [good[0]] }]);
    }
  });

  it('stores id and name trimmed', () => {
    expect(normalizeScenarios([{ id: '  s1 ', name: ' Pay cut  ', changes: [good[0]] }], env))
      .toEqual([{ id: 's1', name: 'Pay cut', changes: [good[0]] }]);
  });

  it('keeps the first of two scenarios with the same id', () => {
    const raw = [
      { id: 's1', name: 'first', changes: [good[0]] },
      { id: ' s1', name: 'second', changes: [good[5]] },
      { id: 's2', name: 'third', changes: [good[5]] },
    ];
    expect(normalizeScenarios(raw, env).map(s => s.name)).toEqual(['first', 'third']);
  });

  it('a duplicate that is itself invalid does not shadow a later valid one', () => {
    const raw = [
      { id: 's1', name: 'bad', changes: [{ type: 'nope' }] },
      { id: 's1', name: 'good', changes: [good[0]] },
    ];
    expect(normalizeScenarios(raw, env).map(s => s.name)).toEqual(['good']);
  });

  it('drops a scenario without an id or name, or without a valid change', () => {
    const raw = [
      { name: 'no id', changes: [good[0]] },
      { id: '', name: 'empty id', changes: [good[0]] },
      { id: 's2', changes: [good[0]] },
      { id: 's3', name: '', changes: [good[0]] },
      { id: 's4', name: 'no changes', changes: [] },
      { id: 's5', name: 'only bad', changes: [{ type: 'nope' }] },
      { id: 's6', name: 'changes not an array', changes: 'x' },
      null,
      { id: 's7', name: 'kept', changes: [good[5]] },
    ];
    expect(normalizeScenarios(raw, env)).toEqual([{ id: 's7', name: 'kept', changes: [good[5]] }]);
  });

  it('copes with missing accounts and budget items', () => {
    expect(normalizeScenarios([{ id: 's1', name: 'x', changes: [good[3], good[5]] }], {}))
      .toEqual([{ id: 's1', name: 'x', changes: [good[5]] }]);
  });
});

// ─── diffAlerts ────────────────────────────────────────────────────────────

describe('diffAlerts', () => {
  const al = (kind, id, firstDate) => ({ kind, id, firstDate, lowDate: firstDate, low: -1, threshold: 0 });

  it('reports added, removed and moved alerts keyed on kind and id', () => {
    const base = [
      al('account-negative', 'chk', '2027-01-10'),
      al('envelope-short', 'e1', '2027-02-01'),
      al('unallocated-negative', null, '2027-03-01'),
      al('envelope-short', 'e2', '2027-04-01'),
    ];
    const what = [
      al('account-negative', 'chk', '2027-01-10'),        // same
      al('envelope-short', 'e1', '2026-12-01'),           // earlier
      al('unallocated-negative', null, '2027-05-01'),     // later
      al('account-negative', 'sav', '2027-06-01'),        // new
      al('crisis-cash-below', null, '2027-07-01'),        // new
    ];
    const d = diffAlerts(base, what);
    expect(d.added).toEqual([what[3], what[4]]);
    expect(d.removed).toEqual([base[3]]);
    expect(d.moved).toEqual([
      { alert: what[1], from: '2027-02-01', to: '2026-12-01' },
      { alert: what[2], from: '2027-03-01', to: '2027-05-01' },
    ]);
  });

  it('is empty for identical lists and tolerates missing ones', () => {
    const a = [al('account-negative', 'chk', '2027-01-10')];
    expect(diffAlerts(a, a)).toEqual({ added: [], removed: [], moved: [] });
    expect(diffAlerts(undefined, a)).toEqual({ added: a, removed: [], moved: [] });
    expect(diffAlerts(a, null)).toEqual({ added: [], removed: a, moved: [] });
  });
});

// ─── simulate({ scenario, stressCut }) ─────────────────────────────────────

const TODAY = new Date(2026, 8, 25); // 2026-09-25, local time
const allMonths = {
  Jan: true, Feb: true, Mar: true, Apr: true, May: true, Jun: true,
  Jul: true, Aug: true, Sep: true, Oct: true, Nov: true, Dec: true,
};

function source() {
  return {
    accounts: [
      { id: 'a1', name: 'Checking', type: 'bank', initialBalance: 1000 },
      { id: 'sav', name: 'Savings', type: 'savings', initialBalance: 5000, interestTiers: [{ rate: 2 }] },
    ],
    envelopes: [{ id: 'e1', name: 'Rent' }],
    budgetItems: [
      { id: 'inc1', kind: 'income', as_schedule: true, account_id: 'a1', monthly_schedule: allMonths,
        payment_day: 5, default_amount: 2000, as_schedule_since: '2026-01-01', description: 'Salary' },
      { id: 'exp1', envelope_id: 'e1', as_schedule: true, account_id: 'a1', monthly_schedule: allMonths,
        payment_day: 5, default_amount: 800, as_schedule_since: '2026-01-01', description: 'Rent' },
      { id: 'tr1', kind: 'account_transfer', as_schedule: true, account_id: 'a1', to_account_id: 'sav',
        monthly_schedule: allMonths, payment_day: 10, default_amount: 300, as_schedule_since: '2026-01-01',
        description: 'Save' },
    ],
    envelopeTemplates: [],
    transactions: [
      { id: 't1', type: 'fill', date: '2026-09-01', lines: [{ envelope_id: 'e1', amount: 800 }] },
      { id: 't2', type: 'income', date: '2027-03-10', amount: 300, account: 'a1' },
      { id: 't3', type: 'income', date: '2030-03-10', amount: 700, account: 'sav' },
    ],
    meta: { country: 'FI' },
  };
}

const entries = (m) => [...m.entries()];
const snapOf = (s) => ({ date: s.date, accounts: entries(s.accounts), envelopes: entries(s.envelopes),
  netWorth: s.netWorth, unallocated: s.unallocated });
function fingerprint(sim) {
  return createHash('sha256').update(JSON.stringify({
    startDate: sim.startDate, endDate: sim.endDate, rows: sim.rows, opening: snapOf(sim.opening),
    monthly: sim.monthly.map(snapOf), alerts: sim.alerts, lastYearContribution: entries(sim.lastYearContribution),
    laterBooked: sim.laterBooked, accruedAtEnd: entries(sim.accruedAtEnd),
  })).digest('hex');
}

beforeEach(() => { _resetSimulationCache(); _resetLensCache(); });

describe('simulate — with a scenario', () => {
  it('without a scenario, the output is what it was before scenarios existed', () => {
    // Captured from `simulate` on this fixture before the scenario parameter
    // was added (2026-09-28), in UTC, America/Los_Angeles and Pacific/Auckland.
    const sim = simulate({ source: source(), today: TODAY });
    // 2026-10-01: re-pinned when the net-worth split gained `loansGiven` and
    // `debts` (both 0 here); with those two keys left out the old hash held.
    expect(fingerprint(sim)).toBe('b4aa50afdeb257ef90e6e3658dc07623daca9ea49b3f69f3f8daba75fa803cc9');
  });

  it('a monthly transfer moves both account balances and counts as a contribution', () => {
    const src = source();
    const base = simulate({ source: src, today: TODAY });
    const what = simulate({ source: src, today: TODAY, scenario: {
      id: 'w', name: 'Save more',
      changes: [{ type: 'monthly', amount: 200, account: 'a1', toAccount: 'sav', from: '2026-10', day: 12 }],
    } });
    // Month 1 (2026-10-31): one extra transfer.
    expect(what.monthly[1].accounts.get('a1')).toBeCloseTo(base.monthly[1].accounts.get('a1') - 200, 2);
    expect(what.monthly[1].accounts.get('sav')).toBeGreaterThan(base.monthly[1].accounts.get('sav') + 199);
    expect(what.lastYearContribution.get('a1')).toBeCloseTo(base.lastYearContribution.get('a1') - 200, 2);
    expect(what.lastYearContribution.get('sav')).toBeCloseTo(base.lastYearContribution.get('sav') + 200, 2);
    expect(what.rows.filter(r => r.whatif)).toHaveLength(24);
  });

  it('an income cut lowers the balance from its month on', () => {
    const src = source();
    const base = simulate({ source: src, today: TODAY });
    const what = simulate({ source: src, today: TODAY, scenario: {
      id: 'w', name: 'Pay cut', changes: [{ type: 'income', pct: -50, from: '2026-11' }],
    } });
    expect(what.monthly[1].accounts.get('a1')).toBeCloseTo(base.monthly[1].accounts.get('a1'), 2); // October
    expect(what.monthly[2].accounts.get('a1')).toBeCloseTo(base.monthly[2].accounts.get('a1') - 1000, 2);
    expect(what.monthly[3].accounts.get('a1')).toBeCloseTo(base.monthly[3].accounts.get('a1') - 2000, 2);
  });

  it('a one-off moves the balance and raises a date to act on, but is no contribution', () => {
    const src = source();
    const base = simulate({ source: src, today: TODAY });
    const what = simulate({ source: src, today: TODAY, scenario: {
      id: 'w', name: 'Car', changes: [
        { type: 'oneoff', date: '2027-01-15', amount: -8000, account: 'a1', label: 'Car' },
        { type: 'oneoff', date: '2028-01-15', amount: 500, account: 'a1', label: 'Bonus' }, // inside the window
      ],
    } });
    expect(what.monthly[4].accounts.get('a1')).toBeCloseTo(base.monthly[4].accounts.get('a1') - 8000, 2);
    expect(base.alerts.find(a => a.kind === 'account-negative' && a.id === 'a1')).toBeUndefined();
    expect(what.alerts.find(a => a.kind === 'account-negative' && a.id === 'a1'))
      .toMatchObject({ firstDate: '2027-01-15' });
    expect(entries(what.lastYearContribution)).toEqual(entries(base.lastYearContribution));
    const d = diffAlerts(base.alerts, what.alerts);
    expect(d.added.map(a => `${a.kind}:${a.id}`)).toContain('account-negative:a1');
  });

  it('a Stress change applies the stressCut it is given', () => {
    const src = source();
    src.budgetItems[1] = { ...src.budgetItems[1], stress_category: 'C' };
    const base = simulate({ source: src, today: TODAY });
    const scenario = { id: 'w', name: 'B', changes: [{ type: 'stress', scenario: 'B', from: '2026-10' }] };
    const stressCut = (item, s) => (item.stress_category && s <= item.stress_category ? 0.25 : 0);
    const what = simulate({ source: src, today: TODAY, scenario, stressCut });
    // Rent 800 → 600 in October.
    expect(what.monthly[1].accounts.get('a1')).toBeCloseTo(base.monthly[1].accounts.get('a1') + 200, 2);
    // Without the cut function, the Stress change does nothing.
    const none = simulate({ source: src, today: TODAY, scenario });
    expect(none.monthly[1].accounts.get('a1')).toBeCloseTo(base.monthly[1].accounts.get('a1'), 2);
  });

  // A template that tops Groceries up to 500 on the 10th, drawing from
  // Buffer: its source leg is the delta that lands the target, so it
  // depends on what the plan rows ahead of it spent or credited.
  function sourced(extraItems = []) {
    return {
      accounts: [
        { id: 'a1', name: 'Checking', type: 'bank', initialBalance: 10000 },
        { id: 'inv', name: 'Broker', type: 'investment', initialBalance: 0 },
      ],
      envelopes: [{ id: 'groc', name: 'Groceries' }, { id: 'buf', name: 'Buffer' }],
      budgetItems: [
        { id: 'food', envelope_id: 'groc', as_schedule: true, account_id: 'a1', monthly_schedule: allMonths,
          payment_day: 20, default_amount: 200, as_schedule_since: '2026-01-01', description: 'Food' },
        ...extraItems,
      ],
      envelopeTemplates: [{
        id: 'tpl', name: 'Top up', lines: [{ envelope_id: 'groc', mode: 'set', amount: 500 }],
        schedule: { enabled: true, payment_day: 10, months: { ...allMonths }, source_envelope_id: 'buf' },
      }],
      transactions: [
        { id: 'f0', type: 'fill', date: '2026-09-01', lines: [{ envelope_id: 'buf', amount: 5000 }] },
      ],
      meta: { country: 'FI' },
    };
  }

  // Every envelope change the scenario makes is matched by the account
  // change: the set fills stay net-zero, so Unallocated does not move.
  function expectNetZero(base, what) {
    for (let i = 0; i < base.monthly.length; i++) {
      const b = base.monthly[i];
      const w = what.monthly[i];
      const dAcc = (w.accounts.get('a1') ?? 0) - (b.accounts.get('a1') ?? 0);
      const dEnv = ['groc', 'buf'].reduce((s, id) => s + (w.envelopes.get(id) ?? 0) - (b.envelopes.get(id) ?? 0), 0);
      expect(dEnv, b.date).toBeCloseTo(dAcc, 2);
      expect(w.unallocated, b.date).toBeCloseTo(b.unallocated, 2);
    }
  }

  it('a Stress cut re-resolves sourced set-mode fills after the cut', () => {
    const src = sourced();
    const base = simulate({ source: src, today: TODAY });
    const what = simulate({ source: src, today: TODAY,
      scenario: { id: 'w', name: 'B', changes: [{ type: 'stress', scenario: 'B', from: '2026-10' }] },
      stressCut: () => 0.5 });
    // Food 200 → 100 a month from October. By 30 November two spends were
    // 100 smaller (a1 +200); Groceries holds 100 more, and November's top-up
    // drew 100 less from Buffer (October's met an empty envelope either way).
    expect(what.monthly[2].accounts.get('a1')).toBeCloseTo(base.monthly[2].accounts.get('a1') + 200, 2);
    expect(what.monthly[2].envelopes.get('groc')).toBeCloseTo(base.monthly[2].envelopes.get('groc') + 100, 2);
    expect(what.monthly[2].envelopes.get('buf')).toBeCloseTo(base.monthly[2].envelopes.get('buf') + 100, 2);
    expectNetZero(base, what);
  });

  it('an income change on a dividend that credits an envelope re-resolves the fills too', () => {
    const src = sourced([{
      id: 'div', kind: 'investment_transfer', direction: 'dividend', as_schedule: true,
      account_id: 'a1', investment_account_id: 'inv', envelope_id: 'groc', monthly_schedule: allMonths,
      payment_day: 5, default_amount: 100, as_schedule_since: '2026-01-01', description: 'Dividend',
    }]);
    const base = simulate({ source: src, today: TODAY });
    const what = simulate({ source: src, today: TODAY,
      scenario: { id: 'w', name: 'Half', changes: [{ type: 'income', pct: -50, from: '2026-10', itemId: 'div' }] } });
    expect(what.monthly[2].accounts.get('a1')).toBeCloseTo(base.monthly[2].accounts.get('a1') - 100, 2);
    expectNetZero(base, what);
  });

  it('caches on the scenario and stressCut too', () => {
    const src = source();
    const scenario = { id: 'w', name: 'x', changes: [{ type: 'income', pct: -10, from: '2026-10' }] };
    const base = simulate({ source: src, today: TODAY });
    const what = simulate({ source: src, today: TODAY, scenario });
    expect(what).not.toBe(base);
    expect(simulate({ source: src, today: TODAY, scenario })).toBe(what);
    expect(simulate({ source: src, today: TODAY, scenario, stressCut: () => 0 })).not.toBe(what);
    expect(simulate({ source: src, today: TODAY })).toBe(base);
  });
});
