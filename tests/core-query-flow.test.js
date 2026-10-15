// tests/core-query-flow.test.js — the Money flow page's Sankey data as
// queries: `flow.plan` (a month or the year of the plan) and `flow.actual`
// (the posted rows in a date range).
//
// `pageFlow` below copies the page's composition from js/pages/flow.js
// (render, L106-116) verbatim, with `state` → the fixture, `now()` → the fixed
// clock, `datedPlanItems()` → `planItemsAsOf(state.budgetItems, now())`, and
// the saved prefs, the session's month and focus and the page filter →
// parameters. Every query answer must equal the copy; the focus view's
// `topPerCategory: Infinity` is the query's `topPerCategory: 0`.
import { describe, it, expect } from 'vitest';
import { registry } from '../js/core/index.js';
import { runQuery } from '../js/core/pipeline.js';
import { makeCtx } from '../js/core/context.js';
import { buildPlanFlow, buildActualFlow, planItemsAsOf, monthStartDate } from '../js/engine.js';
import { resolveRangePreset } from '../js/ui/date-range.js';
import { flowOptions } from '../js/core/flow-input.js';

function deepFreeze(o) { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); Object.values(o).forEach(deepFreeze); } return o; }
const jsonSafe = (v) => expect(JSON.parse(JSON.stringify(v))).toEqual(v);
// Clocks from explicit components, so every zone test:tz runs reads the same day.
const at = (y, m, d) => new Date(y, m - 1, d, 10, 0, 0);
const NOW = at(2026, 9, 15);
const ctxAt = (now) => makeCtx({ now, newId: (() => { let n = 0; return () => `q${++n}`; })() });
const ask = (name, input, d, now = NOW) => runQuery(registry, d, name, input, ctxAt(now));
const answer = (name, input, d, now = NOW) => {
  const r = ask(name, input, d, now);
  expect(r.ok, JSON.stringify(r.error)).toBe(true);
  return r.value;
};

// ── The page's composition, copied from js/pages/flow.js ───────────────────

/**
 * @param {any} state
 * @param {{ mode: 'plan'|'actual', period: 'month'|'year', preset: string, from: string|null, to: string|null }} prefs
 * @param {string} month   session.month ?? currentMonth()
 * @param {Set<string>} exEnv  the page filter's excluded envelopes
 * @param {string|null} focused  session.focus
 * @param {Date} nowDate   now()
 */
function pageFlow(state, prefs, month, exEnv, focused, nowDate) {
  const now = () => nowDate;
  const datedPlanItems = () => planItemsAsOf(state.budgetItems, now());
  // ── copied: js/pages/flow.js L106-116 ──
  const range = resolveRangePreset(prefs, now());
  const opts = { excludeEnvelopes: exEnv, ...(focused ? { topPerCategory: Infinity } : {}) };
  const full = prefs.mode === 'plan'
    // The plan within each item's start/end month: the year is the coming 12
    // months, a month the plan as that month sees it.
    ? buildPlanFlow(
      prefs.period === 'year' ? datedPlanItems() : planItemsAsOf(state.budgetItems, monthStartDate(month)),
      state.envelopes, state.accounts,
      prefs.period === 'year' ? { period: 'year' } : { period: 'month', month }, opts)
    : buildActualFlow(state.transactions, state.accounts, state.envelopes, range, opts);
  // ── end copy ──
  return { full, range };
}

// ── Fixture ────────────────────────────────────────────────────────────────

const ALL_MONTHS = { Jan: true, Feb: true, Mar: true, Apr: true, May: true, Jun: true, Jul: true, Aug: true, Sep: true, Oct: true, Nov: true, Dec: true };
const FOOD = ['f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8'];
const PAYERS = ['Employer', 'Side gig', 'Rental', 'Refund', 'Gift', 'Lottery', 'Interest', 'Tutoring', 'Market stall', 'Bonus'];
const exp = (id, date, payee, amount, envelope_id, extra = {}) => ({ id, type: 'expense', date, payee, amount, account: 'chk', envelope_id, status: 'posted', ...extra });
const inc = (id, date, payee, amount, extra = {}) => ({ id, type: 'income', date, payee, amount, account: 'chk', status: 'posted', ...extra });

// A budget with every case the flow treats differently:
//   - ten income sources (the top 8 fold the rest) in the plan and the ledger
//   - eight envelopes in one category (the top 6 per category fold the rest)
//   - plan items that ended (gym, before today's month), start later (car),
//     run only in December (insurance), are not included, or move money into
//     savings, out of savings and onto a loan
//   - an envelope without a category, rows charged to an envelope no
//     envelope has, a scheduled row (not actual), a split expense
const data = (extra = {}) => deepFreeze({
  meta: { country: 'FI' },
  accounts: [
    { id: 'chk', name: 'Checking', type: 'bank', initialBalance: 3000 },
    { id: 'sav', name: 'Savings', type: 'savings', initialBalance: 1000 },
    { id: 'mtg', name: 'Mortgage', type: 'loan', initialBalance: -20000 },
  ],
  envelopes: [
    { id: 'rent', name: 'Rent', category: 'Housing' },
    { id: 'gym', name: 'Gym', category: 'Health' },
    { id: 'car', name: 'Car', category: 'Transport' },
    { id: 'ins', name: 'Insurance', category: 'Housing' },
    { id: 'bare', name: 'Bare' },
    ...FOOD.map((id, i) => ({ id, name: `Food ${i + 1}`, category: 'Food' })),
  ],
  budgetItems: [
    ...PAYERS.map((p, i) => ({ id: `in${i}`, kind: 'income', description: p, default_amount: 100 * (10 - i) + 5,
      include: true, monthly_schedule: ALL_MONTHS, account_id: 'chk' })),
    { id: 'rentItem', kind: 'expense', description: 'Rent', envelope_id: 'rent', default_amount: -900, include: true, monthly_schedule: ALL_MONTHS },
    { id: 'gymItem', kind: 'expense', description: 'Gym', envelope_id: 'gym', default_amount: -50, include: true,
      end_month: '2026-08', monthly_schedule: ALL_MONTHS },
    { id: 'carItem', kind: 'expense', description: 'Car', envelope_id: 'car', default_amount: -150, include: true,
      start_month: '2026-11', monthly_schedule: ALL_MONTHS },
    { id: 'insItem', kind: 'expense', description: 'Insurance', envelope_id: 'ins', default_amount: -600, include: true,
      monthly_schedule: { Dec: true } },
    { id: 'bareItem', kind: 'expense', description: 'Bare', envelope_id: 'bare', default_amount: -20, include: true,
      monthly_schedule: { ...ALL_MONTHS, Feb: 35 } },
    { id: 'offItem', kind: 'expense', description: 'Off', envelope_id: 'f1', default_amount: -70, include: false, monthly_schedule: ALL_MONTHS },
    ...FOOD.map((id, i) => ({ id: `${id}Item`, kind: 'expense', description: id, envelope_id: id,
      default_amount: -(40 - i * 3), extra_buffer: i === 0 ? 120 : 0, include: true, monthly_schedule: ALL_MONTHS })),
    { id: 'saveItem', kind: 'account_transfer', description: 'Save', default_amount: -250, include: true,
      monthly_schedule: ALL_MONTHS, account_id: 'chk', to_account_id: 'sav' },
    { id: 'unsaveItem', kind: 'account_transfer', description: 'Unsave', default_amount: -400, include: true,
      monthly_schedule: { Jul: true }, account_id: 'sav', to_account_id: 'chk' },
    { id: 'loanItem', kind: 'loan_payment', description: 'Mortgage', default_amount: -300, include: true,
      monthly_schedule: ALL_MONTHS, account_id: 'chk', to_account_id: 'mtg', envelope_id: 'rent' },
  ],
  envelopeTemplates: [],
  transactions: [
    ...PAYERS.map((p, i) => inc(`i${i}`, `2026-0${1 + (i % 9)}-05`, p, 50 * (10 - i) + 0.25)),
    inc('i10', '2025-11-03', 'Employer', 2500),
    inc('i11', '2026-08-30', '', 40),
    exp('h1', '2026-01-01', 'Landlord', 900, 'rent'),
    exp('h2', '2026-07-01', 'Landlord', 900, 'rent'),
    exp('h3', '2025-12-01', 'Landlord', 900, 'rent'),
    ...FOOD.map((id, i) => exp(`fe${i}`, `2026-0${1 + (i % 9)}-12`, `Shop ${i}`, 30 - i * 2.5, id)),
    exp('b1', '2026-08-04', 'Bare', 22, 'bare'),
    exp('u1', '2026-06-02', 'Ghost', 10, 'ghost'),
    { id: 's1', type: 'expense', date: '2026-07-07', payee: 'Market', amount: 100, account: 'chk', status: 'posted',
      envelope_splits: [{ envelope_id: 'f1', amount: 60 }, { envelope_id: 'rent', amount: 40 }] },
    { id: 'p1', type: 'debt_payment', date: '2026-05-25', payee: 'Bank', amount: 500, from_account: 'chk', to_account: 'mtg', envelope_id: 'rent', status: 'posted' },
    { id: 't1', type: 'account_transfer', date: '2026-01-15', payee: 'Save', amount: 300, from_account: 'chk', to_account: 'sav', status: 'posted' },
    { id: 't2', type: 'account_transfer', date: '2026-08-15', payee: 'Unsave', amount: 800, from_account: 'sav', to_account: 'chk', status: 'posted' },
    exp('z1', '2026-09-10', 'Shop A', 99, 'f2', { status: 'scheduled' }),
    exp('z2', '2026-09-11', 'Shop B', 12, 'f2'),
  ],
  ...extra,
});
const empty = () => deepFreeze({ meta: {}, accounts: [], envelopes: [], budgetItems: [], envelopeTemplates: [], transactions: [] });

const PLAN = (period) => ({ mode: 'plan', period, preset: 'ytd', from: null, to: null });
const ACTUAL = (preset, from = null, to = null) => ({ mode: 'actual', period: 'month', preset, from, to });
const EXCLUSIONS = [[], ['f1', 'rent'], ['f2', 'gone']];

// ── flow.plan ────────────────────────────────────────────────────────────────

describe('flow.plan ≡ the Flow page\'s plan view', () => {
  for (const month of ['2026-09', '2026-07', '2026-12', '2027-02', '2020-01']) {
    for (const ex of EXCLUSIONS) {
      for (const focused of [null, 'cat:Food']) {
        it(`month ${month}, excluding [${ex}], ${focused ? 'focused' : 'unfocused'}`, () => {
          const { full } = pageFlow(data(), PLAN('month'), month, new Set(ex), focused, NOW);
          const input = { period: 'month', month, excludeEnvelopes: ex, ...(focused ? { topPerCategory: 0 } : {}) };
          const got = answer('flow.plan', input, data());
          expect(got).toEqual(full);
          jsonSafe(got);
        });
      }
    }
  }

  for (const ex of EXCLUSIONS) {
    for (const focused of [null, 'cat:Food']) {
      it(`the year, excluding [${ex}], ${focused ? 'focused' : 'unfocused'}`, () => {
        const { full } = pageFlow(data(), PLAN('year'), '2026-09', new Set(ex), focused, NOW);
        const got = answer('flow.plan', { period: 'year', excludeEnvelopes: ex, ...(focused ? { topPerCategory: 0 } : {}) }, data());
        expect(got).toEqual(full);
        jsonSafe(got);
      });
    }
  }

  it('the year is the coming 12 months as of date (an item that ended is out, one starting later counts its months)', () => {
    const later = at(2027, 3, 1);
    const { full } = pageFlow(data(), PLAN('year'), '2027-03', new Set(), null, later);
    expect(answer('flow.plan', { period: 'year', date: '2027-03-01' }, data())).toEqual(full);
    const sept = answer('flow.plan', { period: 'year' }, data());
    expect(full).not.toEqual(sept);
    expect(sept.nodes.some(n => n.key === 'gym')).toBe(false);
    expect(sept.nodes.find(n => n.key === 'car').value).toBe(150 * 10);
  });

  it('the month defaults to date\'s month, and to today\'s without a date', () => {
    expect(answer('flow.plan', { period: 'month' }, data())).toEqual(answer('flow.plan', { period: 'month', month: '2026-09' }, data()));
    expect(answer('flow.plan', { period: 'month', date: '2026-12-31' }, data())).toEqual(answer('flow.plan', { period: 'month', month: '2026-12' }, data()));
  });

  it('the month view reads the plan as that month sees it (an ended item counts before its end)', () => {
    const jul = answer('flow.plan', { period: 'month', month: '2026-07' }, data());
    expect(jul.nodes.find(n => n.key === 'gym').value).toBe(50);
    const sep = answer('flow.plan', { period: 'month', month: '2026-09' }, data());
    expect(sep.nodes.some(n => n.key === 'gym')).toBe(false);
  });

  it('folds the sources and the envelopes per category by default (8 and 6), not with 0', () => {
    const def = answer('flow.plan', { period: 'month' }, data());
    expect(def.nodes.filter(n => n.kind === 'source')).toHaveLength(9);
    expect(def.nodes.find(n => n.kind === 'source' && n.other)).toMatchObject({ other: 2, label: null });
    expect(def.nodes.filter(n => n.kind === 'envelope' && n.category === 'Food')).toHaveLength(7);
    const all = answer('flow.plan', { period: 'month', topSources: 0, topPerCategory: 0 }, data());
    expect(all.nodes.filter(n => n.kind === 'source')).toHaveLength(10);
    expect(all.nodes.filter(n => n.kind === 'envelope' && n.category === 'Food')).toHaveLength(8);
    const engine = buildPlanFlow(planItemsAsOf(data().budgetItems, monthStartDate('2026-09')), data().envelopes, data().accounts,
      { period: 'month', month: '2026-09' }, { topSources: 3, topPerCategory: 2 });
    expect(answer('flow.plan', { period: 'month', topSources: 3, topPerCategory: 2 }, data())).toEqual(engine);
  });

  it('an empty plan is the engine\'s empty flow', () => {
    expect(answer('flow.plan', { period: 'year' }, empty())).toEqual({ nodes: [], links: [], totals: { in: 0, out: 0 } });
    expect(answer('flow.plan', { period: 'month' }, empty())).toEqual({ nodes: [], links: [], totals: { in: 0, out: 0 } });
  });

  it('refuses a missing period, a bad month, and a month with the year', () => {
    expect(ask('flow.plan', {}, data()).error.code).toBe('bad_input');
    const bad = ask('flow.plan', { period: 'month', month: '2026-13' }, data());
    expect(bad.error).toMatchObject({ code: 'bad_input', params: { errors: [{ path: 'month' }] } });
    const year = ask('flow.plan', { period: 'year', month: '2026-09' }, data());
    expect(year.error).toMatchObject({ code: 'bad_input', params: { errors: [{ path: 'month' }] } });
    expect(ask('flow.plan', { period: 'month', topSources: -1 }, data()).error.code).toBe('bad_input');
  });

  it('does not mutate the data', () => {
    const d = data();
    expect(() => answer('flow.plan', { period: 'year', excludeEnvelopes: ['f1'] }, d)).not.toThrow();
  });
});

// ── flow.actual ──────────────────────────────────────────────────────────────

describe('flow.actual ≡ the Flow page\'s actual view', () => {
  const PREFS = [ACTUAL('ytd'), ACTUAL('3m'), ACTUAL('12m'), ACTUAL('all'), ACTUAL('custom', '2026-07-01', '2026-08-31'),
    ACTUAL('custom', null, '2026-01-31'), ACTUAL('custom', '2030-01-01', null)];
  for (const prefs of PREFS) {
    for (const ex of EXCLUSIONS) {
      for (const focused of [null, 'cat:Food']) {
        it(`${prefs.preset} ${prefs.from ?? ''}..${prefs.to ?? ''}, excluding [${ex}], ${focused ? 'focused' : 'unfocused'}`, () => {
          const { full, range } = pageFlow(data(), prefs, '2026-09', new Set(ex), focused, NOW);
          const input = { ...(range.from ? { from: range.from } : {}), ...(range.to ? { to: range.to } : {}),
            excludeEnvelopes: ex, ...(focused ? { topPerCategory: 0 } : {}) };
          const got = answer('flow.actual', input, data());
          expect(got).toEqual(full);
          jsonSafe(got);
        });
      }
    }
  }

  it('posted rows only: the scheduled row is not in the flow', () => {
    const got = answer('flow.actual', { from: '2026-09-01', to: '2026-09-30', topPerCategory: 0 }, data());
    expect(got.nodes.find(n => n.key === 'f2').value).toBe(12);
  });

  it('every source, unfolded, with topSources 0', () => {
    const got = answer('flow.actual', { topSources: 0 }, data());
    expect(got.nodes.filter(n => n.kind === 'source').some(n => n.other)).toBe(false);
    expect(got.nodes.filter(n => n.kind === 'source')).toHaveLength(PAYERS.length + 1); // + (no payee)
  });

  it('an empty ledger is the engine\'s empty flow', () => {
    expect(answer('flow.actual', {}, empty())).toEqual({ nodes: [], links: [], totals: { in: 0, out: 0 } });
  });

  it('refuses a bad date', () => {
    expect(ask('flow.actual', { from: '2026-02-30' }, data()).error.code).toBe('bad_input');
  });
});

describe('flowOptions', () => {
  it('0 is no folding (the engine spells it Infinity); a count passes through', () => {
    expect(flowOptions({ topSources: 0, topPerCategory: 0 })).toMatchObject({ topSources: Infinity, topPerCategory: Infinity });
    expect(flowOptions({ topSources: 3, topPerCategory: 2 })).toMatchObject({ topSources: 3, topPerCategory: 2 });
  });

  it('a missing count is left to the engine\'s default, not turned into no folding', () => {
    const opts = flowOptions(/** @type {any} */ ({}));
    expect(opts.topSources).toBeUndefined();
    expect(opts.topPerCategory).toBeUndefined();
    expect([...opts.excludeEnvelopes]).toEqual([]);
  });
});

it('splits a scheduled loan payment into principal, interest and handling fees', () => {
  const d = {
    ...empty(),
    accounts: [{ id: 'chk', type: 'checking', initialBalance: 0 },
      { id: 'loan', type: 'loan', initialBalance: -12000, interestRates: [{ from: '2020-01-01', rate: 12 }], interestDayCount: '30/360' }],
    envelopes: [{ id: 'mortgage', name: 'Mortgage', category: 'Housing' }],
    budgetItems: [{ id: 'pay', kind: 'loan_payment', include: true, account_id: 'chk', to_account_id: 'loan',
      envelope_id: 'mortgage', default_amount: -1000, loan_fee: 5, payment_day: 1,
      monthly_schedule: ALL_MONTHS, as_schedule: true }],
  };
  const f = answer('flow.plan', { period: 'month', month: '2026-10' }, d);
  const value = id => f.nodes.find(n => n.id === id)?.value;
  expect(value('debt')).toBe(875);
  expect(value('env:mortgage')).toBe(125);
  expect(f.totals).toEqual({ in: 1000, out: 1000 });
  const excluded = answer('flow.plan', { period: 'month', month: '2026-10', excludeEnvelopes: ['mortgage'] }, d);
  expect(excluded.nodes.find(n => n.id === 'debt').value).toBe(875);
  expect(excluded.nodes.some(n => n.id === 'env:mortgage')).toBe(false);
  const annual = answer('flow.plan', { period: 'year', date: '2026-10-01' }, d);
  expect(annual.nodes.find(n => n.id === 'debt').value).toBeGreaterThan(875 * 12);
  expect(annual.totals).toEqual({ in: 12000, out: 12000 });
});
