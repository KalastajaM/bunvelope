// tests/core-query-envelopes-month.test.js — the Dashboard's envelope
// snapshot as a query: `envelopes.month`, every figure an envelope card shows
// (lens and Today balances, the month's plan and spend, Spare and the
// templates the envelope funds).
//
// The equivalence helper copies buildEnvelopesSnapshot and planByEnvelope
// from js/pages/dashboard.js verbatim, with `state` → the fixture, `appNow()`
// → the fixed clock, `viewTxs()` / `todayTxs()` → `lensTransactions` for the
// lens and for Today, and `datedPlanItems()` → `planItemsAsOf(items, clock)`.
// The selection of the shown envelopes stays on the page; the query is given
// the ids. Its answer must equal the page's figures, round2'd.
import { describe, it, expect } from 'vitest';
import { registry } from '../js/core/index.js';
import { runQuery } from '../js/core/pipeline.js';
import { makeCtx } from '../js/core/context.js';
import { lensTransactions, resolveHorizonDate } from '../js/engine/lens.js';
import { computeEnvelopeBalances, computeSpentThisMonthByEnvelope } from '../js/engine/balances.js';
import { computeMonthlyPlanByEnvelope, computeBufferByEnvelope, buildExpenseCalendar } from '../js/engine/monthly-review.js';
import { computeSpareByEnvelope } from '../js/engine/envelope-forecast.js';
import { computeTemplateSourceDraws } from '../js/engine/scheduling.js';
import { planItemsAsOf, planItemsForDynamicFill } from '../js/engine/item-dates.js';
import { round2 } from '../js/utils.js';

function deepFreeze(o) { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); Object.values(o).forEach(deepFreeze); } return o; }
// Clocks are built from explicit components, so every test reads the same
// local calendar day under each zone test:tz runs.
const at = (y, m, d) => new Date(y, m - 1, d, 10, 0, 0);
const NOW = at(2026, 9, 15);
const ctxAt = (now) => makeCtx({ now, newId: (() => { let n = 0; return () => `q${++n}`; })() });
const ask = (input, d, now = NOW) => runQuery(registry, d, 'envelopes.month', input, ctxAt(now));
const jsonSafe = (v) => expect(JSON.parse(JSON.stringify(v))).toEqual(v);

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const every = () => Object.fromEntries(MONTHS.map(m => [m, true]));

// The Dashboard page test's budget (now = 15 Sep 2026), plus: an archived
// envelope with money in it, a favourite, an envelope with no plan, a split
// expense, a scheduled bill dated in the past (Today ≠ Booked), a self-
// scheduled template drawing from `rent` (funds templates, a fill in the
// forecast lens) and one whose schedule ended (left off at `date`), a plan
// item that only starts next year, and a tombstoned Internet occurrence.
const data = (extra = {}) => deepFreeze({
  meta: { country: 'FI', scheduledTombstones: ['net:2026-10'] },
  accounts: [
    { id: 'chk', name: 'Checking', type: 'bank', initialBalance: 1000 },
    { id: 'sav', name: 'Savings', type: 'savings', initialBalance: 500 },
  ],
  envelopes: [
    { id: 'food', name: 'Food', category: 'Food' },
    { id: 'fun', name: 'Fun', favorite: true },
    { id: 'rent', name: 'Rent' },
    { id: 'gone', name: 'Old car', archived: true },
    { id: 'misc', name: 'Misc' },
  ],
  budgetItems: [
    { id: 'sal', kind: 'income', envelope_id: null, description: 'Salary', default_amount: 3000, extra_buffer: 0, include: true, monthly_schedule: every(), as_schedule: false },
    { id: 'groc', kind: 'expense', envelope_id: 'food', description: 'Groceries', default_amount: -100, extra_buffer: 0, include: true, monthly_schedule: every(), as_schedule: false },
    { id: 'net', kind: 'expense', envelope_id: 'fun', description: 'Internet', default_amount: -25, extra_buffer: 0, include: true, monthly_schedule: every(),
      as_schedule: true, account_id: 'chk', payment_day: 20, schedule_day_type: 'exact', as_schedule_since: '2026-01-01' },
    { id: 'car', kind: 'expense', envelope_id: 'gone', description: 'Car', default_amount: -50, extra_buffer: 0, include: true, monthly_schedule: every(), as_schedule: false },
    { id: 'later', kind: 'expense', envelope_id: 'misc', description: 'Later', default_amount: -240, extra_buffer: 0, include: true, monthly_schedule: every(),
      as_schedule: false, start_month: '2027-01' },
  ],
  envelopeTemplates: [
    { id: 'tpl', name: 'Monthly', kind: 'manual', lines: [{ envelope_id: 'food', mode: 'add', amount: 100 }],
      schedule: { enabled: true, payment_day: 1, day_type: 'exact', months: every(), source_envelope_id: 'rent', source_since: '2026-01-01' } },
    { id: 'tpl-old', name: 'Ended', kind: 'manual', lines: [{ envelope_id: 'fun', mode: 'add', amount: 10 }],
      schedule: { enabled: true, payment_day: 1, day_type: 'exact', months: every(), source_envelope_id: 'rent', until: '2026-06-30' } },
  ],
  transactions: [
    { id: 'i1', type: 'income', date: '2026-08-01', payee: 'Job', amount: 2000, account: 'chk', status: 'posted' },
    { id: 'f1', type: 'fill', date: '2026-08-02', status: 'posted', source: 'allocation',
      lines: [{ envelope_id: 'food', mode: 'add', amount: 300 }, { envelope_id: 'fun', mode: 'add', amount: 100 },
        { envelope_id: 'rent', mode: 'add', amount: 700 }, { envelope_id: 'gone', mode: 'add', amount: 45 }] },
    { id: 'e0', type: 'expense', date: '2026-08-20', payee: 'Cafe', amount: 20, account: 'chk', envelope_id: 'food', status: 'posted' },
    { id: 'e1', type: 'expense', date: '2026-09-05', payee: 'Supermarket', amount: 80.333, account: 'chk', envelope_id: 'food', status: 'posted' },
    { id: 'e2', type: 'expense', date: '2026-09-12', payee: 'Cinema', amount: 30, account: 'chk', envelope_id: 'fun', status: 'posted' },
    { id: 'e5', type: 'expense', date: '2026-09-13', payee: 'Market', amount: 25, account: 'chk', envelope_id: null, status: 'posted',
      envelope_splits: [{ envelope_id: 'food', amount: 15 }, { envelope_id: 'fun', amount: 10 }] },
    { id: 'e6', type: 'expense', date: '2026-09-14', payee: 'Late bill', amount: 7, account: 'chk', envelope_id: 'fun', status: 'scheduled' },
    { id: 'e3', type: 'expense', date: '2026-10-02', payee: 'Dentist', amount: 40, account: 'chk', envelope_id: 'fun', status: 'scheduled' },
  ],
  ...extra,
});

// buildEnvelopesSnapshot and planByEnvelope, verbatim, for the given `shown`
// envelopes and lens; returns the figures it hands each card.
function pageEnvelopes(state, appNow, { lens, horizon }, shown) {
  const viewTxs = () => lensTransactions(state, { lens, horizon, today: appNow });
  const todayTxs = () => lensTransactions(state, { lens: 'today', today: appNow });
  const planByEnvelope = () => {
    const map = {};
    const planMap = computeMonthlyPlanByEnvelope(planItemsAsOf(state.budgetItems || [], appNow));
    for (const [id, v] of planMap) map[id] = v;
    return map;
  };
  const balances = computeEnvelopeBalances(viewTxs());
  const todayBalances = computeEnvelopeBalances(todayTxs());
  const planned = planByEnvelope();
  const now = appNow;
  const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const templateDraws = computeTemplateSourceDraws(state.envelopeTemplates, { asOf: todayStr });
  const spareByEnv = computeSpareByEnvelope({
    transactions: state.transactions,
    budgetItems: state.budgetItems,
    envelopeTemplates: state.envelopeTemplates,
    accounts: state.accounts,
    envelopes: shown,
    today: now,
    months: 12,
    country: state.meta?.country ?? 'FI',
    tombstones: state.meta?.scheduledTombstones || [],
  });
  const spentByEnv = computeSpentThisMonthByEnvelope(state.transactions, now);
  return shown.map(env => ({
    envelope: env,
    balance: balances.get(env.id) || 0,
    todayBalance: todayBalances.get(env.id) || 0,
    planned: planned[env.id] || 0,
    spent: spentByEnv.get(env.id) || 0,
    spare: spareByEnv.get(env.id) || null,
    fundsTemplates: templateDraws.get(env.id) || null,
  }));
}
// The page's figures in the answer's shape, plus the plan's buffer over the
// same dated items (the AI's envelope health figure; the Dashboard shows none).
function expected(state, appNow, lensInput, shown) {
  const buffers = computeBufferByEnvelope(planItemsAsOf(state.budgetItems || [], appNow));
  const fillPlan = computeMonthlyPlanByEnvelope(planItemsForDynamicFill(state.budgetItems || [], appNow));
  const monthCal = buildExpenseCalendar(planItemsAsOf(state.budgetItems || [], appNow));
  return pageEnvelopes(state, appNow, lensInput, shown).map(c => ({
    id: c.envelope.id,
    name: c.envelope.name,
    balance: round2(c.balance),
    todayBalance: round2(c.todayBalance),
    planned: round2(c.planned),
    monthPlanned: round2(monthCal.get(c.envelope.id)?.[appNow.getMonth() + 1] || 0),
    fillPlanned: round2(fillPlan.get(c.envelope.id) || 0),
    buffer: round2(buffers.get(c.envelope.id) || 0),
    spent: round2(c.spent),
    spare: c.spare ? { spare: round2(c.spare.spare), coveredDate: c.spare.coveredDate, balanceCoveredDate: c.spare.balanceCoveredDate } : null,
    fundsTemplates: c.fundsTemplates ? c.fundsTemplates.map(f => ({ id: f.id, name: f.name, sourceSince: f.sourceSince })) : null,
  }));
}
const active = (d) => d.envelopes.filter(e => !e.archived);
// The rows as the Dashboard reads them: the goal, the funding and the spare's
// floor and low date (4d, for the Envelopes page) are checked in
// core-query-envelopes-goal-funding.test.js.
const dashboardFields = (rows) => rows.map(({ goal: _goal, funding: _funding, ...r }) => ({
  ...r, spare: r.spare && { spare: r.spare.spare, coveredDate: r.spare.coveredDate, balanceCoveredDate: r.spare.balanceCoveredDate },
}));
const byIds = (d, ids) => d.envelopes.filter(e => ids.includes(e.id));

describe('envelopes.month', () => {
  it('equals the page for every non-archived envelope by default, in array order (booked)', () => {
    const d = data();
    const r = ask({}, d);
    expect(r.ok, JSON.stringify(r.error)).toBe(true);
    expect(r.value.lens).toBe('booked');
    expect(r.value.horizon).toBeNull();
    expect(dashboardFields(r.value.envelopes)).toEqual(expected(d, NOW, { lens: 'booked' }, active(d)));
    expect(r.value.envelopes.map(e => e.id)).toEqual(['food', 'fun', 'rent', 'misc']);
    jsonSafe(r.value);
  });

  it('the figures, worked out', () => {
    const byId = Object.fromEntries(dashboardFields(ask({}, data()).value.envelopes).map(e => [e.id, e]));
    // food: 300 − 20 − 80.333 − 15; spent this month 80.333 + 15
    expect(byId.food).toMatchObject({ name: 'Food', balance: 184.67, todayBalance: 184.67, planned: 100, spent: 95.33, fundsTemplates: null });
    // fun: 100 − 30 − 10 − 7 (scheduled, past) − 40 (scheduled, future); Today has neither
    // scheduled row, and neither is spent yet
    expect(byId.fun).toMatchObject({ balance: 13, todayBalance: 60, planned: 25, spent: 40 });
    expect(byId.rent.fundsTemplates).toEqual([{ id: 'tpl', name: 'Monthly', sourceSince: '2026-01-01' }]);
    // misc's plan item starts in January: 8 of the coming 12 months, 240 × 8 / 12
    expect(byId.misc).toMatchObject({ balance: 0, planned: 160, spent: 0 });
    // Spare: food's lowest point is now, less the 4.67 of September's 100 not
    // spent yet (each later month's fill of 100 meets its 100 of groceries);
    // rent pays the Monthly template's 100 for 12 months, 700 − 1200; misc
    // meets 240 a month from January within the 12-month window, 8 × 240 plus 14 September days (112). fun
    // is pinned as the engine projects it (the equivalence test above derives
    // every value from the page's own call).
    expect(byId.food.spare).toEqual({ spare: 180, coveredDate: null, balanceCoveredDate: null });
    expect(byId.rent.spare).toEqual({ spare: -500, coveredDate: null, balanceCoveredDate: null });
    expect(byId.misc.spare).toEqual({ spare: -2032, coveredDate: null, balanceCoveredDate: null });
    expect(byId.fun.spare).toEqual({ spare: -462, coveredDate: null, balanceCoveredDate: null });
  });

  it('envelopes restricts the rows to the ids given, each with its figures in the full set', () => {
    const d = data();
    const r = ask({ envelopes: ['rent', 'fun'] }, d);
    const full = ask({}, d).value.envelopes;
    expect(r.value.envelopes).toEqual(full.filter(e => e.id === 'rent' || e.id === 'fun'));
    expect(r.value.envelopes.map(e => e.id)).toEqual(['fun', 'rent']);
    // Projected alone, as before, rent's spare was 700: the full walk's is
    // what the Envelopes page shows.
    expect(dashboardFields(r.value.envelopes).find(e => e.id === 'rent').spare.spare).toBe(-500);
    expect(expected(d, NOW, { lens: 'booked' }, byIds(d, ['rent', 'fun'])).find(e => e.id === 'rent').spare.spare).toBe(700);
  });

  it('an archived envelope is left out unless named; named, it has no spare', () => {
    const d = data();
    expect(ask({}, d).value.envelopes.some(e => e.id === 'gone')).toBe(false);
    const r = ask({ envelopes: ['gone'] }, d);
    expect(dashboardFields(r.value.envelopes)).toEqual(expected(d, NOW, { lens: 'booked' }, byIds(d, ['gone'])));
    expect(r.value.envelopes).toEqual([{ id: 'gone', name: 'Old car', balance: 45, todayBalance: 45, planned: 50, monthPlanned: 50, fillPlanned: 50, buffer: 0, spent: 0, spare: null, fundsTemplates: null, goal: null, funding: null }]);
  });

  it('follows the forecast lens and its horizon; Today stays Today', () => {
    const d = data();
    const r = ask({ lens: 'forecast', horizon: 'eom' }, d);
    const horizon = resolveHorizonDate('eom', NOW);
    expect(r.value).toMatchObject({ lens: 'forecast', horizon: '2026-09-30' });
    expect(dashboardFields(r.value.envelopes)).toEqual(expected(d, NOW, { lens: 'forecast', horizon }, active(d)));
    const booked = Object.fromEntries(ask({}, d).value.envelopes.map(e => [e.id, e]));
    const fc = Object.fromEntries(r.value.envelopes.map(e => [e.id, e]));
    // Through the month's end: the Internet bill of the 20th is forecast, the
    // Dentist row of 2 Oct is past the horizon.
    expect(booked.fun.balance).toBe(13);
    expect(fc.fun.balance).toBe(13 + 40 - 25);
    expect(fc.fun.todayBalance).toBe(booked.fun.todayBalance);
  });

  it('the Today lens', () => {
    const d = data();
    const r = ask({ lens: 'today' }, d);
    expect(dashboardFields(r.value.envelopes)).toEqual(expected(d, NOW, { lens: 'today' }, active(d)));
    expect(r.value.envelopes.every(e => e.balance === e.todayBalance)).toBe(true);
  });

  it('date picks the month, the plan in force and the templates still drawing', () => {
    const d = data();
    // 2027-02-10: misc's plan item covers all of the coming 12 months; spent
    // this month is February's (none).
    const r = ask({ date: '2027-02-10' }, d);
    expect(dashboardFields(r.value.envelopes)).toEqual(expected(d, at(2027, 2, 10), { lens: 'booked' }, active(d)));
    const misc = r.value.envelopes.find(e => e.id === 'misc');
    expect(misc.planned).toBe(240);
    expect(r.value.envelopes.every(e => e.spent === 0)).toBe(true);
    // Before the ended template's `until`, rent funds it too.
    const june = ask({ date: '2026-06-15' }, d).value.envelopes.find(e => e.id === 'rent');
    expect(june.fundsTemplates.map(f => f.id)).toEqual(['tpl', 'tpl-old']);
  });

  it('monthPlanned is the month\'s own calendar plan, not the average, and leaves a skipped occurrence out', () => {
    // Allowance Boys, 2026-10-04: two 100 allowances due in April and October
    // planned 33.33 a month on average, so the card read "200 of 33.33 spent".
    const half = { Apr: true, Oct: true };
    const allowance = (id, extra = {}) => ({ id, kind: 'expense', envelope_id: 'boys', description: id, default_amount: -100,
      extra_buffer: 0, include: true, monthly_schedule: half, as_schedule: false, ...extra });
    const d = data({
      envelopes: [{ id: 'boys', name: 'Allowance Boys' }],
      budgetItems: [allowance('a1'), allowance('a2')],
      transactions: [
        { id: 'p1', type: 'expense', date: '2026-10-01', payee: 'A', amount: 100, account: 'chk', envelope_id: 'boys', status: 'posted' },
        { id: 'p2', type: 'expense', date: '2026-10-01', payee: 'B', amount: 100, account: 'chk', envelope_id: 'boys', status: 'posted' },
      ],
    });
    const oct = ask({ date: '2026-10-04', spare: false }, d).value.envelopes[0];
    expect(oct).toMatchObject({ planned: 33.33, monthPlanned: 200, spent: 200 });
    // A month the plan leaves empty plans nothing, whatever the average.
    expect(ask({ date: '2026-11-04', spare: false }, d).value.envelopes[0]).toMatchObject({ planned: 33.33, monthPlanned: 0 });
    // A skipped occurrence is not planned for its month.
    const skipped = data({ ...d, budgetItems: [allowance('a1', { skipped_occurrences: ['2026-10'] }), allowance('a2')] });
    expect(ask({ date: '2026-10-04', spare: false }, skipped).value.envelopes[0].monthPlanned).toBe(100);
  });

  it('refuses an unknown envelope id and a horizon without the forecast lens', () => {
    const d = data();
    expect(ask({ envelopes: ['nope'] }, d).error.code).toBe('bad_input');
    expect(ask({ horizon: 'eom' }, d).error).toEqual({ code: 'bad_input', params: { errors: [{ path: 'horizon', message: 'only allowed with lens forecast' }] } });
  });

  it('runs against deep-frozen data without mutating it', () => {
    const d = data();
    const before = JSON.stringify(d);
    ask({ lens: 'forecast' }, d);
    expect(JSON.stringify(d)).toBe(before);
  });
});
