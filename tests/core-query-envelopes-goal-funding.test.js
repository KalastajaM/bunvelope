// tests/core-query-envelopes-goal-funding.test.js — what the Envelopes page
// still computes itself, as query answers: `envelopes.month`'s per-row `goal`
// (the card's goal line), `funding` (the card's fill %) and the `floor` and
// `lowDate` of its spare, and `emergency.requirement` (the emergency card's
// calculation dialog).
//
// The equivalence helpers copy the page code verbatim (envelopes.js L224-249
// and L370-385, envelope-card.js L242), with `state` → the fixture,
// `appNow()` / `now()` → the fixed clock, `viewTxs()` → `lensTransactions` for
// the lens, and the page's `filtered` → the envelopes asked for. The answers
// must equal the page's figures.
import { describe, it, expect } from 'vitest';
import { registry } from '../js/core/index.js';
import { runQuery } from '../js/core/pipeline.js';
import { makeCtx } from '../js/core/context.js';
import { lensTransactions, resolveHorizonDate } from '../js/engine/lens.js';
import { computeEnvelopeBalances } from '../js/engine/balances.js';
import { computeSpareByEnvelope } from '../js/engine/envelope-forecast.js';
import { computeItemFundingByEnvelope } from '../js/engine/item-funding.js';
import { computeEnvelopeGoalProgress } from '../js/engine/policies.js';
import { computeEmergencyFundRequirement } from '../js/engine/monthly-review.js';
import { round2 } from '../js/utils.js';

function deepFreeze(o) { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); Object.values(o).forEach(deepFreeze); } return o; }
const at = (y, m, d) => new Date(y, m - 1, d, 10, 0, 0);
const NOW = at(2026, 9, 15);
const ctxAt = (now) => makeCtx({ now, newId: (() => { let n = 0; return () => `q${++n}`; })() });
const ask = (name, input, d, now = NOW) => runQuery(registry, d, name, input, ctxAt(now));
const answer = (name, input, d, now = NOW) => {
  const r = ask(name, input, d, now);
  expect(r.ok, JSON.stringify(r.error)).toBe(true);
  return r.value;
};
const jsonSafe = (v) => expect(JSON.parse(JSON.stringify(v))).toEqual(v);

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const every = () => Object.fromEntries(MONTHS.map(m => [m, true]));

// 15 Sep 2026. Food is a spending envelope with an extra buffer (its floor)
// and a scheduled future spend; Rent pays a scheduled bill on the 1st (paid
// for September); Emergency is the emergency envelope, over Food and Rent's
// essentials. Goals in every status: Trip is behind its pace, Car has
// reached its goal until a scheduled car wash (Today: reached; Booked: on
// track), House has no deadline, Late's deadline has passed, Bike's deadline
// is more than a year away with no start (early), TV is ahead of its pace. An
// archived envelope still has a goal.
const data = (extra = {}) => deepFreeze({
  meta: { country: 'FI', scheduledTombstones: [], emergency_envelope_id: 'emerg', emergency_duration_months: 3 },
  accounts: [{ id: 'chk', name: 'Checking', type: 'bank', initialBalance: 0 }],
  envelopes: [
    { id: 'food', name: 'Food' },
    { id: 'rent', name: 'Rent' },
    { id: 'emerg', name: 'Emergency' },
    { id: 'trip', name: 'Trip', goal_amount: 1000, goal_date: '2027-03-01', goal_start: '2026-01-01' },
    { id: 'car', name: 'Car', goal_amount: 500, goal_date: '2027-01-01' },
    { id: 'house', name: 'House', goal_amount: 10000 },
    { id: 'late', name: 'Late', goal_amount: 1000, goal_date: '2026-08-01' },
    { id: 'bike', name: 'Bike', goal_amount: 1200, goal_date: '2027-12-01' },
    { id: 'tv', name: 'TV', goal_amount: 800, goal_date: '2027-01-01', goal_start: '2026-09-01' },
    { id: 'gone', name: 'Old', archived: true, goal_amount: 100 },
  ],
  budgetItems: [
    { id: 'sal', kind: 'income', envelope_id: null, description: 'Salary', default_amount: 3000, extra_buffer: 0, include: true, monthly_schedule: every(), as_schedule: false },
    { id: 'groc', kind: 'expense', envelope_id: 'food', description: 'Groceries', default_amount: -300, extra_buffer: 25, include: true, monthly_schedule: every(),
      as_schedule: false, include_in_emergency_budget: true },
    { id: 'rentb', kind: 'expense', envelope_id: 'rent', description: 'Rent', default_amount: -700, extra_buffer: 0, include: true, monthly_schedule: every(),
      as_schedule: true, account_id: 'chk', payment_day: 1, schedule_day_type: 'exact', as_schedule_since: '2026-01-01', include_in_emergency_budget: true },
  ],
  envelopeTemplates: [],
  transactions: [
    { id: 'i1', type: 'income', date: '2026-08-01', payee: 'Job', amount: 6000, account: 'chk', status: 'posted' },
    { id: 'f1', type: 'fill', date: '2026-08-02', status: 'posted', source: 'allocation',
      lines: [{ envelope_id: 'food', mode: 'add', amount: 400 }, { envelope_id: 'rent', mode: 'add', amount: 1400 },
        { envelope_id: 'emerg', mode: 'add', amount: 1000 }, { envelope_id: 'trip', mode: 'add', amount: 300 },
        { envelope_id: 'car', mode: 'add', amount: 600 }, { envelope_id: 'house', mode: 'add', amount: 200 },
        { envelope_id: 'late', mode: 'add', amount: 100 }, { envelope_id: 'bike', mode: 'add', amount: 100 },
        { envelope_id: 'tv', mode: 'add', amount: 500 }, { envelope_id: 'gone', mode: 'add', amount: 50 }] },
    { id: 'r1', type: 'expense', date: '2026-09-01', payee: 'Landlord', amount: 700, account: 'chk', envelope_id: 'rent', status: 'posted' },
    { id: 'e1', type: 'expense', date: '2026-09-05', payee: 'Shop', amount: 120.5, account: 'chk', envelope_id: 'food', status: 'posted' },
    { id: 's1', type: 'expense', date: '2026-09-25', payee: 'Market', amount: 50, account: 'chk', envelope_id: 'food', status: 'scheduled' },
    { id: 's2', type: 'expense', date: '2026-09-20', payee: 'Car wash', amount: 150, account: 'chk', envelope_id: 'car', status: 'scheduled' },
  ],
  ...extra,
});

const ALL = ['food', 'rent', 'emerg', 'trip', 'car', 'house', 'late', 'bike', 'tv', 'gone'];
const LENSES = [
  ['booked', { lens: 'booked' }],
  ['today', { lens: 'today' }],
  ['forecast to the month end', { lens: 'forecast', horizon: 'eom' }],
];
const lensOf = (input) => ({ lens: input.lens, horizon: input.horizon ? resolveHorizonDate(input.horizon, NOW) : undefined });

// envelopes.js L224-249 verbatim, `filtered` = the envelopes asked for, and
// envelope-card.js L242 per card with the page's lens balance.
function pageCards(state, appNow, { lens, horizon }, filtered) {
  const viewTxs = () => lensTransactions(state, { lens, horizon, today: appNow });
  const now = () => appNow;
  const balances = computeEnvelopeBalances(viewTxs());
  const spareByEnv = computeSpareByEnvelope({
    transactions: state.transactions,
    budgetItems: state.budgetItems,
    envelopeTemplates: state.envelopeTemplates,
    accounts: state.accounts,
    envelopes: filtered,
    today: appNow,
    months: 12,
    country: state.meta?.country ?? 'FI',
    tombstones: state.meta?.scheduledTombstones || [],
  });

  // Fill %: "2 of 3 items on track" per card. The balance is as of today in
  // every lens, as in the health sheet: a future-dated bill has not left yet.
  const itemFundingByEnv = computeItemFundingByEnvelope({
    envelopes: filtered,
    budgetItems: state.budgetItems || [],
    transactions: state.transactions,
    balances: computeEnvelopeBalances(state.transactions, { asOf: appNow }),
    today: appNow,
    country: state.meta?.country ?? 'FI',
    tombstones: state.meta?.scheduledTombstones || [],
    dailyByEnvelope: new Map([...spareByEnv].map(([id, sp]) => [id, sp.daily])),
  });
  return filtered.map(envelope => {
    const balance = balances.get(envelope.id) || 0;
    const goalProgress = computeEnvelopeGoalProgress(envelope, balance, now());
    const spare = spareByEnv.get(envelope.id) || null;
    return { id: envelope.id, goal: goalProgress, funding: itemFundingByEnv.get(envelope.id) || null, spare };
  });
}
const byIds = (d, ids) => d.envelopes.filter(e => ids.includes(e.id));
const pick = (rows) => rows.map(({ id, goal, funding, spare }) => ({ id, goal, funding, spare }));
// The page's figures in the answer's shape: goal and funding as the engine
// returns them (already in cents), spare with its floor and low date.
const expectedRows = (d, now, lensInput, ids) => pageCards(d, now, lensOf(lensInput), byIds(d, ids)).map(c => ({
  id: c.id,
  goal: c.goal,
  funding: c.funding,
  spare: c.spare ? { spare: round2(c.spare.spare), coveredDate: c.spare.coveredDate, balanceCoveredDate: c.spare.balanceCoveredDate,
    floor: c.spare.floor, lowDate: c.spare.lowDate, lowBalance: round2(c.spare.spare + c.spare.floor) } : null,
}));

describe('envelopes.month goal, funding and the spare floor', () => {
  for (const [label, lensInput] of LENSES) {
    it(`equals the page's goal line, fill % and spare, every envelope (${label})`, () => {
      const d = data();
      const a = answer('envelopes.month', { ...lensInput, envelopes: ALL }, d);
      expect(pick(a.envelopes)).toEqual(expectedRows(d, NOW, lensInput, ALL));
      jsonSafe(a);
    });
  }

  it('the default set (the non-archived envelopes) and a subset equal the page over the same envelopes', () => {
    const d = data();
    const active = d.envelopes.filter(e => !e.archived).map(e => e.id);
    expect(pick(answer('envelopes.month', {}, d).envelopes)).toEqual(expectedRows(d, NOW, { lens: 'booked' }, active));
    expect(pick(answer('envelopes.month', { envelopes: ['rent', 'food'] }, d).envelopes)).toEqual(expectedRows(d, NOW, { lens: 'booked' }, ['food', 'rent']));
  });

  it('date is the clock of the goal pace, the funding month and the spare walk', () => {
    const d = data();
    const later = at(2026, 11, 3);
    const a = answer('envelopes.month', { date: '2026-11-03', envelopes: ALL }, d);
    expect(pick(a.envelopes)).toEqual(expectedRows(d, later, { lens: 'booked' }, ALL));
  });

  it('a goal per status, on the lens balance', () => {
    const d = data();
    const rows = Object.fromEntries(answer('envelopes.month', { envelopes: ALL }, d).envelopes.map(e => [e.id, e]));
    expect(Object.fromEntries(Object.entries(rows).map(([id, r]) => [id, r.goal && r.goal.status]))).toEqual({
      food: null, rent: null, emerg: null,
      trip: 'behind', car: 'on-track', house: 'no-deadline', late: 'behind', bike: 'early', tv: 'on-track', gone: 'no-deadline',
    });
    // Trip: 300 of 1000; 700 over the 5.5 months (167 days / 30.4375) to 1 March.
    expect(rows.trip.goal).toEqual({ goalAmount: 1000, goalDate: '2027-03-01', balance: 300, fraction: 0.3, monthlyRequired: 127.58, daysRemaining: 167, status: 'behind' });
    // Car's scheduled car wash of the 20th counts under Booked (450 of 500)
    // and not under Today (600, reached).
    expect(rows.car.goal).toMatchObject({ balance: 450, status: 'on-track' });
    const today = Object.fromEntries(answer('envelopes.month', { lens: 'today', envelopes: ['car'] }, d).envelopes.map(e => [e.id, e]));
    expect(today.car.goal).toMatchObject({ balance: 600, status: 'reached' });
  });

  it('funding: the funded envelopes only; the others, and every row with spare false, are null', () => {
    const d = data();
    const a = answer('envelopes.month', { envelopes: ALL }, d);
    const funding = Object.fromEntries(a.envelopes.map(e => [e.id, e.funding]));
    expect(Object.keys(funding).filter(id => funding[id] !== null)).toEqual(['food', 'rent']);
    // Food: this month's 300 for groceries, 120.50 spent; the 25 extra buffer is its reserve.
    expect(funding.food).toMatchObject({ reserve: 25 });
    expect(funding.food.items).toMatchObject([{ itemId: 'groc', name: 'Groceries', style: 'spending', planThisMonth: 300, spent: 120.5, remaining: 179.5 }]);
    // Rent: September's bill is paid; the next is October's 700 on the 1st.
    expect(funding.rent.items).toMatchObject([{ itemId: 'rentb', style: 'bill', nextDue: { date: '2026-10-01', amount: 700 } }]);
    const noSpare = answer('envelopes.month', { envelopes: ALL, spare: false }, d);
    expect(noSpare.envelopes.every(e => e.funding === null && e.spare === null)).toBe(true);
  });

  it('spare carries its floor (the extra buffer) and the date of its low point', () => {
    const d = data();
    const rows = Object.fromEntries(answer('envelopes.month', { envelopes: ['food', 'rent', 'gone'] }, d).envelopes.map(e => [e.id, e]));
    expect(rows.food.spare.floor).toBe(25);
    expect(rows.rent.spare.floor).toBe(0);
    expect(rows.food.spare.lowDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // The archived envelope has a goal, but no spare walk and no funding.
    expect(rows.gone).toMatchObject({ goal: { goalAmount: 100, balance: 50, status: 'no-deadline' }, funding: null, spare: null });
  });

  it('an archived envelope that still has funded plan items has no funding either', () => {
    const base = data();
    const d = deepFreeze({
      ...base,
      budgetItems: [...base.budgetItems,
        { id: 'goneb', kind: 'expense', envelope_id: 'gone', description: 'Old bill', default_amount: -40, extra_buffer: 0, include: true, monthly_schedule: every(), as_schedule: false }],
    });
    const rows = Object.fromEntries(answer('envelopes.month', { envelopes: ['food', 'gone'] }, d).envelopes.map(e => [e.id, e]));
    expect(rows.gone).toMatchObject({ planned: 40, funding: null, spare: null });
    // Not vacuous: the same plan on an active envelope does fund.
    expect(rows.food.funding).not.toBeNull();
  });
});

// ── emergency.requirement ──────────────────────────────────────────────────

// envelopes.js L372-382 verbatim (the click handler), `viewTxs()` → the lens rows.
function pageEmergency(state, appNow, { lens, horizon }) {
  const viewTxs = () => lensTransactions(state, { lens, horizon, today: appNow });
  const now = appNow;
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const calc = computeEmergencyFundRequirement({
    envelopes: state.envelopes,
    budgetItems: state.budgetItems,
    transactions: viewTxs(),
    month,
    meta: state.meta,
  });
  return calc;
}
// The page's breakdown with every money figure in cents.
const centsOf = (calc) => calc && ({
  ...calc,
  required: round2(calc.required),
  monthlyEssentials: round2(calc.monthlyEssentials),
  subtotal: round2(calc.subtotal),
  sumOtherBalance: round2(calc.sumOtherBalance),
  buffer: round2(calc.buffer),
  items: calc.items.map(i => ({ ...i, monthlyAmount: round2(i.monthlyAmount) })),
  contributors: calc.contributors.map(c => ({ ...c, balance: round2(c.balance), contribution: round2(c.contribution) })),
});

describe('emergency.requirement — the emergency card\'s calculation, on the lens rows', () => {
  for (const [label, lensInput] of [...LENSES, ['forecast, 3 months', { lens: 'forecast', horizon: '3m' }]]) {
    it(`equals the page (${label})`, () => {
      const d = data();
      const a = answer('emergency.requirement', lensInput, d);
      expect(a).toEqual(centsOf(pageEmergency(d, NOW, lensOf(lensInput))));
      jsonSafe(a);
    });
  }

  it('the breakdown, worked out (booked)', () => {
    const a = answer('emergency.requirement', {}, data());
    // Essentials 300 + 700 a month for 3 months; Food (400 − 120.50 − 50) and
    // Rent (1400 − 700) count towards it.
    expect(a).toEqual({
      emergencyId: 'emerg', required: 2070.5, monthlyEssentials: 1000, duration: 3, subtotal: 3000,
      sumOtherBalance: 929.5, buffer: 0, creditMode: 'flagged',
      items: [
        { envelope_id: 'food', envName: 'Food', description: 'Groceries', monthlyAmount: 300 },
        { envelope_id: 'rent', envName: 'Rent', description: 'Rent', monthlyAmount: 700 },
      ],
      contributors: [
        { envelope_id: 'food', envName: 'Food', balance: 229.5, contribution: 229.5, clamped: false },
        { envelope_id: 'rent', envName: 'Rent', balance: 700, contribution: 700, clamped: false },
      ],
    });
  });

  it('the lens moves the credited balances: the forecast through 3 months has paid three more rents', () => {
    const d = data();
    const fc = answer('emergency.requirement', { lens: 'forecast', horizon: '3m' }, d);
    // Rent: 700 held less the bills of 1 Oct, 1 Nov and 1 Dec; a negative balance credits nothing.
    expect(fc.contributors.find(c => c.envelope_id === 'rent')).toEqual({ envelope_id: 'rent', envName: 'Rent', balance: -1400, contribution: 0, clamped: true });
  });

  it('month picks the plan in force; it defaults to the clock\'s month', () => {
    const d = data({ budgetItems: [...data().budgetItems,
      { id: 'ins', kind: 'expense', envelope_id: 'food', description: 'Insurance', default_amount: -120, extra_buffer: 0, include: true,
        monthly_schedule: every(), as_schedule: false, include_in_emergency_budget: true, start_month: '2027-01' }] });
    const now = answer('emergency.requirement', {}, d);
    expect(answer('emergency.requirement', { month: '2026-09' }, d)).toEqual(now);
    const jan = answer('emergency.requirement', { month: '2027-01' }, d);
    expect(jan.monthlyEssentials).toBe(1120);
    expect(jan).toEqual(centsOf(computeEmergencyFundRequirement({
      envelopes: d.envelopes, budgetItems: d.budgetItems, transactions: d.transactions, month: '2027-01', meta: d.meta,
    })));
  });

  it('null when no emergency envelope is set; a month that is not YYYY-MM is refused', () => {
    expect(answer('emergency.requirement', {}, data({ meta: { country: 'FI' } }))).toBeNull();
    expect(ask('emergency.requirement', { month: '2026-13' }, data()).error).toEqual({
      code: 'bad_input', params: { errors: [{ path: 'month', message: 'must be a month, YYYY-MM' }] },
    });
    expect(ask('emergency.requirement', { horizon: 'eom' }, data()).error.code).toBe('bad_input');
  });

  it('runs against deep-frozen data without mutating it', () => {
    const d = data();
    const before = JSON.stringify(d);
    answer('emergency.requirement', { lens: 'forecast' }, d);
    answer('envelopes.month', { lens: 'forecast', envelopes: ALL }, d);
    expect(JSON.stringify(d)).toBe(before);
  });
});
