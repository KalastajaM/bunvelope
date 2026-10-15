// tests/core-query-net-worth-projection.test.js — the Net worth page's
// long-horizon projection as a query: `netWorth.projection`.
//
// `pageProjection` copies the page's current code verbatim
// (js/pages/net-worth.js render() inputs, runSims / runWhatIf, growthMap,
// contributionMapFor, paintProjection and paintTable, paintPlanNote's flag;
// facts-4b §3.3, §3.6, §3.7), with `state` → the fixture, `now()` → the fixed
// clock and the DOM left out, and the query must equal it (after round2 where
// the answer rounds).
import { describe, it, expect, vi } from 'vitest';

// `simulate` wrapped in a spy that calls the real one, so the cache tests can
// see which Simulation object each run returned (a cache hit returns the
// cached object itself). Every other test sees the real behaviour.
vi.mock('../js/engine/simulation.js', async (importOriginal) => {
  const mod = await importOriginal();
  return { ...mod, simulate: vi.fn(mod.simulate) };
});

import { registry } from '../js/core/index.js';
import { runQuery } from '../js/core/pipeline.js';
import { makeCtx } from '../js/core/context.js';
import { simulate, projectFromSimulation } from '../js/engine/simulation.js';
import { averageMonthlyContribution, isAssetAccount } from '../js/engine/balances.js';
import { computeAnnualInterest } from '../js/engine/tx-amounts.js';
import { loanRepayment, loanBalancePath } from '../js/engine/loan-schedule.js';
import { normalizeScenarios } from '../js/engine/whatif.js';
import { isTransferItem, scenarioHits, stressCutPct } from '../js/engine/stress.js';
import { round2 } from '../js/utils.js';

function deepFreeze(o) { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); Object.values(o).forEach(deepFreeze); } return o; }
// Clocks are built from explicit components, so every test reads the same
// local calendar day under each zone test:tz runs.
const at = (y, m, d) => new Date(y, m - 1, d, 10, 0, 0);
const NOW = at(2026, 10, 15);
const ctxAt = (now) => makeCtx({ now, newId: (() => { let n = 0; return () => `q${++n}`; })() });
const ask = (input, d, now = NOW) => runQuery(registry, d, 'netWorth.projection', input, ctxAt(now));
const ALL = { Jan: true, Feb: true, Mar: true, Apr: true, May: true, Jun: true, Jul: true, Aug: true, Sep: true, Oct: true, Nov: true, Dec: true };

// Every kind of row the table tells apart: a loan its plan item repays (a
// schedule), a loan nothing repays, an asset with a rate, savings with
// interest tiers, investments with a set rate, a set monthly contribution, a
// loan given, an empty account the skip rule hides, an archived account with
// history; plus saved what-if scenarios of each change type.
const data = deepFreeze({
  meta: {
    country: 'FI',
    whatIfScenarios: [
      { id: 'paycut', name: 'Pay cut', changes: [{ type: 'income', pct: -100, from: '2026-11' }] },
      { id: 'carloan', name: 'Car loan', changes: [{ type: 'monthly', amount: -400, account: 'chk', from: '2026-12', day: 10 }] },
      { id: 'trip', name: 'Trip', changes: [{ type: 'oneoff', date: '2027-02-10', amount: -2500, account: 'chk', label: 'Trip' }] },
      { id: 'crisis', name: 'Crisis', changes: [{ type: 'stress', scenario: 'B', from: '2026-11' }] },
      { id: 'stale', name: 'Old account', changes: [{ type: 'oneoff', date: '2027-01-10', amount: -100, account: 'old', label: 'x' }] },
    ],
  },
  accounts: [
    { id: 'chk', name: 'Checking', type: 'bank', initialBalance: 800 },
    { id: 'card', name: 'Visa', type: 'credit_card', initialBalance: 0 },
    { id: 'sav', name: 'Savings', type: 'savings', initialBalance: 5000, interestTiers: [{ upTo: 10000, rate: 2 }, { rate: 0.5 }] },
    { id: 'bsu', name: 'BSU', type: 'savings', initialBalance: 0, plannedMonthly: 150 },
    { id: 'inv', name: 'Broker', type: 'investment', initialBalance: 10000, expectedGrowth: 5 },
    { id: 'pens', name: 'Pension', type: 'investment', pensionInsurance: true, initialBalance: 2000, expectedGrowth: 4 },
    { id: 'house', name: 'House', type: 'asset', initialBalance: 200000, expectedGrowth: 1 },
    { id: 'mtg', name: 'Mortgage', type: 'loan', initialBalance: -100000, interestRates: [{ from: '2020-01-01', rate: 3 }] },
    { id: 'car', name: 'Car loan', type: 'loan', initialBalance: -8000 },
    { id: 'lent', name: 'Lent', type: 'loan_given', initialBalance: 1000 },
    { id: 'empty', name: 'Empty', type: 'bank', initialBalance: 0 },
    { id: 'old', name: 'Old checking', type: 'bank', initialBalance: 50, archived: true },
  ],
  envelopes: [
    { id: 'rent', name: 'Rent', category: 'Housing' },
    { id: 'groc', name: 'Groceries', category: 'Food' },
  ],
  budgetItems: [
    { id: 'salary', kind: 'income', description: 'Pay', account_id: 'chk', default_amount: 3000, payment_day: 25,
      schedule_day_type: 'exact', include: true, as_schedule: true, as_schedule_since: '2026-10-01', monthly_schedule: ALL },
    { id: 'food', kind: 'expense', description: 'Food', envelope_id: 'groc', account_id: 'chk', default_amount: -900, payment_day: 5,
      schedule_day_type: 'exact', include: true, as_schedule: true, as_schedule_since: '2026-10-01', monthly_schedule: ALL,
      extra_buffer: 200, stress_category: 'B', stress_cut_pcts: { A: 0.5, B: 0.4 } },
    { id: 'save', kind: 'transfer', description: 'Save', account_id: 'chk', to_account_id: 'sav', default_amount: -300, payment_day: 26,
      schedule_day_type: 'exact', include: true, as_schedule: true, as_schedule_since: '2026-10-01', monthly_schedule: ALL },
    { id: 'mortgage', kind: 'loan_payment', description: 'Home loan', envelope_id: 'rent', account_id: 'chk', to_account_id: 'mtg',
      default_amount: -1200, monthly_schedule: ALL, payment_day: 5, as_schedule: true, as_schedule_since: '2026-10-01',
      include: true, schedule_day_type: 'exact', loan_method: 'annuity', loan_end: '2051-09' },
  ],
  envelopeTemplates: [],
  transactions: [
    { id: 'o1', type: 'income', date: '2025-03-10', payee: 'Old', amount: 100, account: 'old', status: 'posted' },
    { id: 'o2', type: 'income', date: '2026-02-10', payee: 'Old', amount: 120, account: 'old', status: 'posted' },
    { id: 'i1', type: 'income', date: '2026-07-25', payee: 'Pay', amount: 3000, account: 'chk', status: 'posted' },
    { id: 'i2', type: 'income', date: '2026-08-25', payee: 'Pay', amount: 3000, account: 'chk', status: 'posted' },
    { id: 'i3', type: 'income', date: '2026-09-25', payee: 'Pay', amount: 3000, account: 'chk', status: 'posted' },
    { id: 'e1', type: 'expense', date: '2026-09-02', payee: 'Shop', amount: 2500.333, account: 'chk', envelope_id: 'groc', status: 'posted' },
    { id: 'c1', type: 'expense', date: '2026-10-03', payee: 'Shop', amount: 60, account: 'card', envelope_id: 'groc', status: 'posted' },
    { id: 't1', type: 'account_transfer', date: '2026-08-10', payee: 'Save', amount: 600, from_account: 'chk', to_account: 'sav', status: 'posted' },
    { id: 'b1', type: 'investment_transfer', direction: 'buy', date: '2026-08-15', payee: 'Broker', amount: 500, units: 5, symbol: 'ABC', from_account: 'chk', to_account: 'inv', status: 'posted' },
    { id: 'p1', type: 'account_transfer', date: '2026-09-05', payee: 'Car', amount: 250, from_account: 'chk', to_account: 'car', status: 'posted' },
    { id: 'a1', type: 'adjustment', target: 'account', target_id: 'house', date: '2026-06-30', payee: 'Valuation', amount: 5000, status: 'posted' },
    { id: 'f1', type: 'expense', date: '2026-11-03', payee: 'Later', amount: 50, account: 'card', envelope_id: 'groc', status: 'scheduled' },
  ],
});
const empty = () => deepFreeze({ meta: {}, accounts: [], envelopes: [], budgetItems: [], envelopeTemplates: [], transactions: [] });

// ── The page's code, verbatim ──────────────────────────────────────────────

const SHIFT_PCT = 2;

// net-worth.js:46-55
function growthFor(account, balance) {
  if (Number.isFinite(account.expectedGrowth)) return { pct: account.expectedGrowth, source: 'set' };
  // A loan given's interest is paid out in cash, not added to the loan.
  if (account.type === 'loan_given') return { pct: null, source: 'none' };
  if (Array.isArray(account.interestTiers) && account.interestTiers.length && balance > 0) {
    const annual = computeAnnualInterest(balance, account.interestTiers);
    if (annual > 0) return { pct: round2((annual / balance) * 100), source: 'interest' };
  }
  return { pct: null, source: 'none' };
}
// net-worth-contribution.js:29-35, as it was before the move
function contributionFor(account, amounts, source) {
  if (Number.isFinite(account.plannedMonthly)) return { amount: account.plannedMonthly, source: 'set' };
  if (isAssetAccount(account)) return { amount: 0, source: 'none' };
  return source === 'history'
    ? { amount: amounts.history, source: 'history' }
    : { amount: amounts.plan, source: 'plan' };
}
// net-worth-whatif.js:29-31 (the page's stress cut, before the move)
const whatIfStressCut = (item, scenario) => (
  !isTransferItem(item) && scenarioHits(scenario, item) ? stressCutPct(item, scenario) : 0
);

/**
 * The page's render() inputs, then paintProjection and paintTable without
 * the DOM. `live` is the page's `liveAccounts` (account overrides): saveNumber
 * puts the same copies into `accounts`, so the table reads them too.
 */
function pageProjection(state, today, { horizon, contributionSource = 'plan', excludedIds = [], live = state.accounts, whatIfId = null }) {
  // net-worth.js:102-122
  const liveAccounts = live;
  const simSource = () => (liveAccounts === state.accounts ? state : { ...state, accounts: liveAccounts });
  const active = (state.accounts || []).filter(a => !a.archived);
  const exAcc = new Set(excludedIds);
  const nExcluded = exAcc.size;
  // saveNumber (645-656): `accounts[idx] = next.find(a => a.id === accountId)`
  const accounts = active.filter(a => !exAcc.has(a.id)).map(a => liveAccounts.find(x => x.id === a.id) || a);
  const counted = nExcluded ? (state.accounts || []).filter(a => !exAcc.has(a.id)) : (state.accounts || []);
  // 126-135
  const loanSchedules = new Map();
  for (const a of counted) {
    if (!a || a.type !== 'loan' || a.archived) continue;
    const r = loanRepayment(a, {
      budgetItems: state.budgetItems, transactions: state.transactions, today, country: state.meta?.country ?? 'FI',
    });
    if (r.status === 'ok' && r.schedule.rows.length) loanSchedules.set(a.id, r.schedule);
  }
  const scheduledPaths = () => new Map([...loanSchedules].map(([id, sch]) => [id, loanBalancePath(sch, today, horizon * 12 + 1)]));
  // 139-147
  const runSims = () => ({
    low: simulate({ source: simSource(), today, shiftPct: -SHIFT_PCT, trackAlerts: false }),
    base: simulate({ source: simSource(), today }),
    high: simulate({ source: simSource(), today, shiftPct: SHIFT_PCT, trackAlerts: false }),
  });
  const sims = runSims();
  const averages = averageMonthlyContribution(counted, state.transactions, today, 12);
  // 155-163
  const scenarios = normalizeScenarios(state.meta?.whatIfScenarios, { accounts: state.accounts, budgetItems: state.budgetItems });
  const selectedScenario = () => scenarios.find(s => s.id === whatIfId) || null;
  const runWhatIf = () => {
    const sc = selectedScenario();
    return sc ? simulate({ source: simSource(), today, scenario: sc, stressCut: whatIfStressCut }) : null;
  };
  const whatIfSim = runWhatIf();
  // 398-418
  function growthMap() {
    const m = new Map();
    for (const a of accounts) m.set(a.id, growthFor(a, sims.base.opening.accounts.get(a.id) ?? 0).pct);
    return m;
  }
  const amountsFor = a => ({ plan: sims.base.lastYearContribution.get(a.id) ?? 0, history: averages.get(a.id) ?? 0 });
  function contributionMapFor(sim) {
    const m = new Map();
    for (const a of accounts) {
      const amounts = { plan: sim.lastYearContribution.get(a.id) ?? 0, history: averages.get(a.id) ?? 0 };
      m.set(a.id, contributionFor(a, amounts, contributionSource).amount);
    }
    return m;
  }
  function contributionMap() {
    return contributionMapFor(sims.base);
  }
  // paintProjection (457-489)
  const growth = growthMap();
  const contribution = contributionMap();
  const scheduled = scheduledPaths();
  const run = (sim, shiftPct, contrib = contribution) => projectFromSimulation({
    accounts: counted, sim, growthPct: growth, contribution: contrib, years: horizon, shiftPct, scheduled,
  });
  const low = run(sims.low, -SHIFT_PCT), base = run(sims.base, 0), high = run(sims.high, SHIFT_PCT);
  const whatIfScenario = selectedScenario();
  const whatIfLine = whatIfSim && whatIfScenario ? run(whatIfSim, 0, contributionMapFor(whatIfSim)) : null;
  // paintTable (535-622), the cells' values
  const rows = [];
  let used = 0, plan = 0, actual = 0;
  for (const a of accounts) {
    const bal = sims.base.opening.accounts.get(a.id) ?? (Number(a.initialBalance) || 0);
    const g = growthFor(a, bal);
    const avg = averages.get(a.id) ?? 0;
    const amounts = amountsFor(a);
    const c = contributionFor(a, amounts, contributionSource);
    if (Math.abs(bal) < 0.005 && Math.abs(c.amount) < 0.005 && g.pct === null) continue;
    used += c.amount;
    plan += contributionFor(a, amounts, 'plan').amount;
    actual += avg;
    const single = projectFromSimulation({
      accounts: [a], sim: sims.base, growthPct: growth, contribution, years: horizon, scheduled,
    });
    rows.push({
      id: a.id, bal, g, c, avg,
      tipPlan: sims.base.lastYearContribution.get(a.id) ?? 0,
      at: single[single.length - 1].total,
      sch: loanSchedules.get(a.id) || null,
    });
  }
  const totals = { used: round2(used), plan: round2(plan), actual: round2(actual) };
  // paintPlanNote (505), over paintTable's returned (rounded) totals
  const gap = Math.abs(totals.actual) >= 1 && totals.actual - totals.plan > Math.abs(totals.actual) / 2;
  return { low, base, high, whatIfLine, rows, shownIds: rows.map(r => r.id), tableIds: accounts.map(a => a.id), totals, gap };
}

// What the answer's shown rows hold for the page's cells.
const rowOf = (r) => ({
  id: r.id,
  balance: round2(r.bal),
  growthPct: r.g.pct,
  growthSource: r.g.source,
  contribution: round2(r.c.amount),
  contributionSource: r.c.source,
  plan: round2(r.tipPlan),
  history: round2(r.avg),
  atHorizon: r.at,
  loan: r.sch ? { payoffDate: r.sch.payoffDate } : null,
  shown: true,
});

function expectEqualsPage(answer, page, years) {
  expect(answer.years).toBe(years);
  expect(answer.base).toEqual(page.base);
  expect(answer.low).toEqual(page.low);
  expect(answer.high).toEqual(page.high);
  expect(answer.whatIf).toEqual(page.whatIfLine);
  expect(answer.base).toHaveLength(years + 1);
  // Every table account, in the page's order; the shown ones are the page's rows.
  expect(answer.accounts.map(a => a.id)).toEqual(page.tableIds);
  expect(answer.accounts.filter(a => a.shown)).toEqual(page.rows.map(rowOf));
  expect(answer.accounts.filter(a => !a.shown).map(a => a.id)).toEqual(page.tableIds.filter(id => !page.shownIds.includes(id)));
  expect(answer.table).toEqual({ ...page.totals, gap: page.gap });
}

// ── netWorth.projection ───────────────────────────────────────────────────

describe('netWorth.projection equals the page', () => {
  for (const years of [5, 10, 20]) {
    for (const contribution of ['plan', 'history']) {
      it(`${years} years, ${contribution} contributions`, () => {
        const r = ask({ years, contribution }, data);
        expect(r.ok, JSON.stringify(r)).toBe(true);
        expectEqualsPage(r.value, pageProjection(data, NOW, { horizon: years, contributionSource: contribution }), years);
      });
    }
  }

  it('the default contribution source is the plan', () => {
    expect(ask({ years: 10 }, data).value).toEqual(ask({ years: 10, contribution: 'plan' }, data).value);
  });

  it('each kind of row: the scheduled loan, the unscheduled loan, the asset, interest tiers, a set rate and amount', () => {
    const v = ask({ years: 20 }, data).value;
    const row = Object.fromEntries(v.accounts.map(a => [a.id, a]));
    // The plan item repays the mortgage: it follows its schedule to a payoff month.
    expect(row.mtg.loan).toEqual({ payoffDate: expect.stringMatching(/^2051-0\d-\d\d$/) });
    expect(row.mtg.shown).toBe(true);
    // Nothing repays the car loan: no schedule, it moves by its rate and contribution.
    expect(row.car.loan).toBeNull();
    expect(row.car.balance).toBe(-7750);
    // An asset moves by its rate; it gets no contribution.
    expect(row.house).toMatchObject({ growthPct: 1, growthSource: 'set', contribution: 0, contributionSource: 'none', loan: null });
    // Savings with interest tiers: the rate the tiers give at its balance.
    expect(row.sav).toMatchObject({ growthSource: 'interest', contributionSource: 'plan' });
    expect(row.sav.growthPct).toBeGreaterThan(0);
    expect(row.inv).toMatchObject({ growthPct: 5, growthSource: 'set' });
    expect(row.bsu).toMatchObject({ balance: 0, contribution: 150, contributionSource: 'set', growthSource: 'none', growthPct: null, shown: true });
    expect(row.lent).toMatchObject({ growthPct: null, growthSource: 'none' });
    // No balance, no contribution, no rate: the skip rule hides it.
    expect(row.empty).toMatchObject({ shown: false, balance: 0, contribution: 0, growthPct: null });
    // The archived account is not a table row (the engine skips it in the lines).
    expect(row.old).toBeUndefined();
    // Not vacuous: the scheduled mortgage is repaid inside 25 years, so the
    // 20-year figure is far above today's.
    expect(row.mtg.atHorizon).toBeGreaterThan(row.mtg.balance);
    expect(v.base.at(-1).total).toBeGreaterThan(v.low.at(-1).total);
    expect(v.high.at(-1).total).toBeGreaterThan(v.base.at(-1).total);
  });

  it('an excluded account leaves the lines and the table', () => {
    for (const contribution of ['plan', 'history']) {
      const r = ask({ years: 10, contribution, excludeAccounts: ['inv', 'mtg'] }, data);
      expect(r.ok, JSON.stringify(r)).toBe(true);
      expectEqualsPage(r.value, pageProjection(data, NOW, { horizon: 10, contributionSource: contribution, excludedIds: ['inv', 'mtg'] }), 10);
      expect(r.value.accounts.map(a => a.id)).not.toContain('inv');
      expect(r.value.base.at(-1).total).not.toBe(ask({ years: 10, contribution }, data).value.base.at(-1).total);
    }
  });

  it('account overrides: the lines and the table read the overlaid accounts, as the page\'s liveAccounts', () => {
    const overrides = [{ id: 'inv', expectedGrowth: 12 }, { id: 'sav', expectedGrowth: 3, plannedMonthly: 250 },
      { id: 'house', expectedGrowth: null }, { id: 'bsu', plannedMonthly: null }];
    const live = data.accounts.map(a => {
      const o = overrides.find(x => x.id === a.id);
      if (!o) return a;
      const out = { ...a };
      for (const field of ['expectedGrowth', 'plannedMonthly']) {
        if (!(field in o)) continue;
        if (o[field] === null) delete out[field]; else out[field] = o[field];
      }
      return out;
    });
    for (const contribution of ['plan', 'history']) {
      const r = ask({ years: 20, contribution, accountOverrides: overrides }, data);
      expect(r.ok, JSON.stringify(r)).toBe(true);
      expectEqualsPage(r.value, pageProjection(data, NOW, { horizon: 20, contributionSource: contribution, live }), 20);
      const row = Object.fromEntries(r.value.accounts.map(a => [a.id, a]));
      expect(row.inv).toMatchObject({ growthPct: 12, growthSource: 'set' });
      expect(row.sav).toMatchObject({ growthPct: 3, growthSource: 'set', contribution: 250, contributionSource: 'set' });
      expect(row.house).toMatchObject({ growthPct: null, growthSource: 'none' });
      expect(row.bsu).toMatchObject({ shown: false, contributionSource: contribution });
    }
  });

  it('an override for an unknown account is ignored', () => {
    const r = ask({ years: 10, accountOverrides: [{ id: 'nope', expectedGrowth: 50 }] }, data).value;
    expect(r).toEqual(ask({ years: 10 }, data).value);
  });

  for (const id of ['paycut', 'carloan', 'trip', 'crisis']) {
    it(`what-if ${id}: its own line, with its run's contribution map`, () => {
      for (const years of [5, 10, 20]) {
        for (const contribution of ['plan', 'history']) {
          const r = ask({ years, contribution, whatIf: id }, data);
          expect(r.ok, JSON.stringify(r)).toBe(true);
          const page = pageProjection(data, NOW, { horizon: years, contributionSource: contribution, whatIfId: id });
          expectEqualsPage(r.value, page, years);
          // The base, band and table are the plain run's.
          const plain = ask({ years, contribution }, data).value;
          expect({ ...r.value, whatIf: null }).toEqual(plain);
          // Not vacuous: the scenario moves its line.
          expect(r.value.whatIf.at(-1).total).not.toBe(r.value.base.at(-1).total);
        }
      }
    });
  }

  it('a what-if with an excluded account and overrides', () => {
    const overrides = [{ id: 'inv', expectedGrowth: 9 }];
    const live = data.accounts.map(a => (a.id === 'inv' ? { ...a, expectedGrowth: 9 } : a));
    const r = ask({ years: 20, whatIf: 'carloan', excludeAccounts: ['house'], accountOverrides: overrides }, data);
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expectEqualsPage(r.value, pageProjection(data, NOW, { horizon: 20, excludedIds: ['house'], live, whatIfId: 'carloan' }), 20);
  });

  it('an unknown what-if, or one the cleanup hides: not_found', () => {
    for (const id of ['nope', 'stale']) {
      const r = ask({ years: 10, whatIf: id }, data);
      expect(r.ok).toBe(false);
      expect(r.error).toEqual({ code: 'not_found', params: { kind: 'whatIf', id } });
    }
  });

  it('date: the projection starts that day', () => {
    const r = ask({ years: 5, date: '2027-03-01' }, data);
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expectEqualsPage(r.value, pageProjection(data, new Date(2027, 2, 1, 12), { horizon: 5 }), 5);
  });
});

describe('netWorth.projection: the plan-versus-actual flag', () => {
  // Twelve months of pay into the account, but no plan item: the plan adds
  // nothing, the last 12 months added 1,000 a month.
  const months = Array.from({ length: 12 }, (_, i) => new Date(2025, 9 + i, 20));
  const pad = n => String(n).padStart(2, '0');
  const pay = months.map((d, i) => ({ id: `p${i}`, type: 'income', date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-20`, payee: 'Pay', amount: 1000, account: 'chk', status: 'posted' }));
  const noPlan = deepFreeze({ meta: {}, accounts: [{ id: 'chk', name: 'Checking', type: 'bank', initialBalance: 0 }],
    envelopes: [], budgetItems: [], envelopeTemplates: [], transactions: pay });
  const withPlan = deepFreeze({ ...noPlan, budgetItems: [
    { id: 'salary', kind: 'income', description: 'Pay', account_id: 'chk', default_amount: 1000, payment_day: 20,
      schedule_day_type: 'exact', include: true, as_schedule: true, as_schedule_since: '2026-10-01', monthly_schedule: ALL },
  ] });

  it('the plan adds far less than the last 12 months: gap', () => {
    for (const contribution of ['plan', 'history']) {
      const v = ask({ years: 10, contribution }, noPlan).value;
      expectEqualsPage(v, pageProjection(noPlan, NOW, { horizon: 10, contributionSource: contribution }), 10);
      expect(v.table).toEqual({ used: contribution === 'plan' ? 0 : 1000, plan: 0, actual: 1000, gap: true });
    }
  });

  it('the plan carries the pay: no gap', () => {
    const v = ask({ years: 10 }, withPlan).value;
    expectEqualsPage(v, pageProjection(withPlan, NOW, { horizon: 10 }), 10);
    expect(v.table).toMatchObject({ actual: 1000, gap: false });
    expect(v.table.plan).toBeGreaterThan(500);
  });
});

describe('netWorth.projection: input and output', () => {
  it('refuses bad input', () => {
    for (const input of [{}, { years: 0 }, { years: 51 }, { years: 2.5 }, { years: 10, contribution: 'average' },
      { years: 10, excludeAccounts: ['nope'] }, { years: 10, accountOverrides: [{ id: 'chk', interestTiers: [] }] }]) {
      expect(ask(input, data).error.code, JSON.stringify(input)).toBe('bad_input');
    }
  });

  it('an empty budget: flat zero lines, no rows', () => {
    const v = ask({ years: 3 }, empty()).value;
    const zeros = [0, 1, 2, 3].map(year => ({ year, total: 0 }));
    expect(v).toEqual({ years: 3, base: zeros, low: zeros, high: zeros, whatIf: null, accounts: [], table: { used: 0, plan: 0, actual: 0, gap: false } });
  });

  it('is JSON-safe', () => {
    const v = ask({ years: 20, whatIf: 'paycut', contribution: 'history' }, data).value;
    expect(JSON.parse(JSON.stringify(v))).toEqual(v);
  });
});

// ── The simulate cache ────────────────────────────────────────────────────
//
// Checked by identity, not timing: `simulate` returns the cached Simulation
// object itself on a hit, so two runs that returned the same object computed
// once. The spy (vi.mock above) records what each call returned.

describe('netWorth.projection shares simulate\'s runs', () => {
  const returned = () => simulate.mock.results.map(r => r.value);

  it('a page render: the projection reuses the four forecast.simulation runs', () => {
    const input = { accountOverrides: [{ id: 'inv', expectedGrowth: 6 }], excludeAccounts: ['house'] };
    simulate.mockClear();
    const sim = (extra) => runQuery(registry, { ...data }, 'forecast.simulation', { ...input, ...extra }, ctxAt(NOW));
    sim({});
    sim({ shiftPct: -2, alerts: false });
    sim({ shiftPct: 2, alerts: false });
    sim({ whatIf: 'crisis' });
    const before = new Set(returned());
    const n = simulate.mock.calls.length;
    expect(ask({ years: 10, whatIf: 'crisis', ...input }, { ...data }).ok).toBe(true);
    const mine = returned().slice(n);
    expect(mine).toHaveLength(4);
    for (const run of mine) expect(before.has(run)).toBe(true);
  });

  it('default inputs share the page\'s base and band runs', () => {
    simulate.mockClear();
    ask({ years: 5 }, data);
    const [low, base, high] = returned();
    expect(base).toBe(simulate({ source: data, today: NOW }));
    expect(low).toBe(simulate({ source: data, today: NOW, shiftPct: -2, trackAlerts: false }));
    expect(high).toBe(simulate({ source: data, today: NOW, shiftPct: 2, trackAlerts: false }));
  });

  it('a horizon or source toggle re-walks nothing', () => {
    simulate.mockClear();
    ask({ years: 5, whatIf: 'trip' }, data);
    const first = returned();
    ask({ years: 20, contribution: 'history', whatIf: 'trip' }, data);
    expect(returned().slice(first.length)).toEqual(first);
    returned().slice(first.length).forEach((run, i) => expect(run).toBe(first[i]));
  });
});

// Owner decision 2026-10-05: a card paid off from its `settledFrom` account
// does not pile up the plan's spending over the years; the paying account
// carries it, and net worth itself does not move.
describe('netWorth.projection — a card settled from an account', () => {
  const onCard = (settled) => deepFreeze({
    ...data,
    accounts: data.accounts.map(a => (a.id === 'card' && settled ? { ...a, settledFrom: 'chk' } : a)),
    budgetItems: data.budgetItems.map(it => (it.id === 'food' ? { ...it, account_id: 'card' } : it)),
  });
  const rowOf = (v, id) => v.accounts.find(a => a.id === id);

  it('keeps the card near one month of spending and moves its contribution to the paying account', () => {
    const plain = ask({ years: 10 }, onCard(false)).value;
    const settled = ask({ years: 10 }, onCard(true)).value;
    expect(rowOf(plain, 'card').atHorizon).toBeLessThan(-100000);
    expect(rowOf(settled, 'card').contribution).toBe(0);
    expect(rowOf(settled, 'card').atHorizon).toBeGreaterThan(-1000);
    expect(rowOf(settled, 'chk').contribution).toBeCloseTo(rowOf(plain, 'chk').contribution - 900, 2);
    expect(settled.base.map(p => p.total)).toEqual(plain.base.map(p => p.total));
  });
});
