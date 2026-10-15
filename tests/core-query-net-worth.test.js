// tests/core-query-net-worth.test.js — the Net worth page's history and its
// "Next 24 months" walk as queries: `netWorth.history` and
// `forecast.simulation`.
//
// Each `page*` helper copies the page's current code verbatim
// (js/pages/net-worth.js, net-worth-simulation.js, net-worth-whatif.js;
// facts-4b §3.2, §3.3, §3.8, §3.10), with `state` → the fixture and `now()` →
// the fixed clock, and the query must equal it (after round2 where the
// answer rounds).
import { describe, it, expect, vi } from 'vitest';

// `simulate` wrapped in a spy that calls the real one, so the cache test can
// see which Simulation object each run returned (a cache hit returns the
// cached object itself). Every other test sees the real behaviour.
vi.mock('../js/engine/simulation.js', async (importOriginal) => {
  const mod = await importOriginal();
  return { ...mod, simulate: vi.fn(mod.simulate) };
});

import { registry } from '../js/core/index.js';
import { runQuery } from '../js/core/pipeline.js';
import { makeCtx } from '../js/core/context.js';
import { simulate } from '../js/engine/simulation.js';
import { computeNetWorthHistory, netWorthFromBalances } from '../js/engine/balances.js';
import { normalizeScenarios, diffAlerts } from '../js/engine/whatif.js';
import { isTransferItem, scenarioHits, stressCutPct } from '../js/engine/stress.js';
import { round2 } from '../js/utils.js';

function deepFreeze(o) { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); Object.values(o).forEach(deepFreeze); } return o; }
// Clocks are built from explicit components, so every test reads the same
// local calendar day under each zone test:tz runs.
const at = (y, m, d) => new Date(y, m - 1, d, 10, 0, 0);
const NOW = at(2026, 10, 15);
const ctxAt = (now) => makeCtx({ now, newId: (() => { let n = 0; return () => `q${++n}`; })() });
const ask = (name, input, d, now = NOW) => runQuery(registry, d, name, input, ctxAt(now));
const ALL = { Jan: true, Feb: true, Mar: true, Apr: true, May: true, Jun: true, Jul: true, Aug: true, Sep: true, Oct: true, Nov: true, Dec: true };
const PARTS = ['total', 'spending', 'savings', 'investment', 'pension', 'assets', 'loansGiven', 'debts', 'other'];

// A budget with every account kind the split tells apart, an archived
// account with history, envelopes the plan spends from (dates to act on), a
// stress-cut item and saved what-if scenarios of each change type, plus one
// the cleanup hides (its account is archived).
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
    { id: 'inv', name: 'Broker', type: 'investment', initialBalance: 10000, expectedGrowth: 5 },
    { id: 'pens', name: 'Pension', type: 'investment', pensionInsurance: true, initialBalance: 2000, expectedGrowth: 4 },
    { id: 'house', name: 'House', type: 'asset', initialBalance: 200000, expectedGrowth: 1 },
    { id: 'mtg', name: 'Mortgage', type: 'loan', initialBalance: -100000, interestRates: [{ from: '2020-01-01', rate: 3 }] },
    { id: 'lent', name: 'Lent', type: 'loan_given', initialBalance: 1000 },
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
    { id: 'mortgage', kind: 'loan_payment', description: 'Home loan', envelope_id: 'rent', account_id: 'chk', to_account_id: 'mtg',
      default_amount: -1200, monthly_schedule: ALL, payment_day: 5, as_schedule: true, as_schedule_since: '2026-10-01',
      include: true, schedule_day_type: 'exact', loan_method: 'annuity', loan_end: '2051-09' },
  ],
  envelopeTemplates: [],
  transactions: [
    { id: 'o1', type: 'income', date: '2025-03-10', payee: 'Old', amount: 100, account: 'old', status: 'posted' },
    { id: 'i1', type: 'income', date: '2026-07-25', payee: 'Pay', amount: 3000, account: 'chk', status: 'posted' },
    { id: 'i2', type: 'income', date: '2026-08-25', payee: 'Pay', amount: 3000, account: 'chk', status: 'posted' },
    { id: 'i3', type: 'income', date: '2026-09-25', payee: 'Pay', amount: 3000, account: 'chk', status: 'posted' },
    { id: 'e1', type: 'expense', date: '2026-09-02', payee: 'Shop', amount: 2500.333, account: 'chk', envelope_id: 'groc', status: 'posted' },
    { id: 'c1', type: 'expense', date: '2026-10-03', payee: 'Shop', amount: 60, account: 'card', envelope_id: 'groc', status: 'posted' },
    { id: 't1', type: 'account_transfer', date: '2026-08-10', payee: 'Save', amount: 600, from_account: 'chk', to_account: 'sav', status: 'posted' },
    { id: 'b1', type: 'investment_transfer', direction: 'buy', date: '2026-08-15', payee: 'Broker', amount: 500, units: 5, symbol: 'ABC', from_account: 'chk', to_account: 'inv', status: 'posted' },
    { id: 'a1', type: 'adjustment', target: 'account', target_id: 'house', date: '2026-06-30', payee: 'Valuation', amount: 5000, status: 'posted' },
    { id: 'f1', type: 'expense', date: '2026-11-03', payee: 'Later', amount: 50, account: 'card', envelope_id: 'groc', status: 'scheduled' },
  ],
});
const empty = () => deepFreeze({ meta: {}, accounts: [], envelopes: [], budgetItems: [], envelopeTemplates: [], transactions: [] });

// ── The page's code, verbatim ──────────────────────────────────────────────

const pad = n => String(n).padStart(2, '0');
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const SHIFT_PCT = 2;

// net-worth.js:106-122, the page filter's `counted`
function pageCounted(state, excludedIds = []) {
  const exAcc = new Set(excludedIds);
  const nExcluded = exAcc.size;
  return nExcluded ? (state.accounts || []).filter(a => !exAcc.has(a.id)) : (state.accounts || []);
}

// net-worth.js:209-215
function pageHistory(state, today, excludedIds) {
  const counted = pageCounted(state, excludedIds);
  const dates = [];
  for (let k = 24; k >= 1; k--) dates.push(ymd(new Date(today.getFullYear(), today.getMonth() - k + 1, 0)));
  dates.push(ymd(today));
  return computeNetWorthHistory(counted, state.transactions, dates);
}

// net-worth.js:102-104, 139-143 (runSims), 157-162 (runWhatIf)
function pageSims(state, today, liveAccounts = state.accounts) {
  const simSource = () => (liveAccounts === state.accounts ? state : { ...state, accounts: liveAccounts });
  return {
    low: simulate({ source: simSource(), today, shiftPct: -SHIFT_PCT, trackAlerts: false }),
    base: simulate({ source: simSource(), today }),
    high: simulate({ source: simSource(), today, shiftPct: SHIFT_PCT, trackAlerts: false }),
  };
}
// net-worth-whatif.js:29-31 (the page's stress cut, before the move)
const whatIfStressCut = (item, scenario) => (
  !isTransferItem(item) && scenarioHits(scenario, item) ? stressCutPct(item, scenario) : 0
);
function pageWhatIf(state, today, whatIfId, liveAccounts = state.accounts) {
  const simSource = () => (liveAccounts === state.accounts ? state : { ...state, accounts: liveAccounts });
  const scenarios = normalizeScenarios(state.meta?.whatIfScenarios, { accounts: state.accounts, budgetItems: state.budgetItems });
  const sc = scenarios.find(s => s.id === whatIfId) || null;
  return sc ? { sim: simulate({ source: simSource(), today, scenario: sc, stressCut: whatIfStressCut }), name: sc.name } : null;
}

// net-worth-simulation.js:54, the lines over the counted accounts
const pageSplit = (sim, countedAccounts) => sim.monthly.map(p => netWorthFromBalances(countedAccounts, p.accounts));

// What the query answers for a run: the page's split, rounded, with the date.
const pointsOf = (sim, counted) => pageSplit(sim, counted).map((s, i) => ({
  date: sim.monthly[i].date, ...Object.fromEntries(PARTS.map(k => [k, round2(s[k])])),
}));
const roundRow = (p) => ({ date: p.date, ...Object.fromEntries(PARTS.map(k => [k, round2(p[k])])) });

// ── netWorth.history ───────────────────────────────────────────────────────

describe('netWorth.history', () => {
  it('equals the page: 24 preceding month-ends and today, archived accounts left out', () => {
    const r = ask('netWorth.history', {}, data);
    expect(r.ok, JSON.stringify(r)).toBe(true);
    const want = pageHistory(data, NOW);
    expect(r.value.points).toEqual(want.map(roundRow));
    expect(r.value.points).toHaveLength(25);
    expect(r.value.points[0].date).toBe('2024-10-31');
    expect(r.value.points.at(-2).date).toBe('2026-09-30');
    expect(r.value.points.at(-1).date).toBe('2026-10-15');
    // The archived account has rows, but excluding it changes nothing.
    expect(ask('netWorth.history', { excludeAccounts: ['old'] }, data).value.points).toEqual(r.value.points);
  });

  it('an excluded account leaves the totals; nothing excluded is the unfiltered list', () => {
    const r = ask('netWorth.history', { excludeAccounts: ['house', 'card'] }, data);
    expect(r.value.points).toEqual(pageHistory(data, NOW, ['house', 'card']).map(roundRow));
    const all = ask('netWorth.history', {}, data).value.points.at(-1);
    expect(r.value.points.at(-1).assets).toBe(0);
    expect(r.value.points.at(-1).total).toBe(round2(all.total - all.assets + 60));
  });

  it('months and date choose the window', () => {
    const r = ask('netWorth.history', { months: 3, date: '2026-06-30' }, data);
    expect(r.value.points.map(p => p.date)).toEqual(['2026-03-31', '2026-04-30', '2026-05-31', '2026-06-30']);
    const today = new Date(2026, 5, 30);
    const want = computeNetWorthHistory(data.accounts, data.transactions, ['2026-03-31', '2026-04-30', '2026-05-31', '2026-06-30']);
    expect(r.value.points).toEqual(want.map(roundRow));
    expect(pageHistory(data, today).at(-1)).toEqual(want.at(-1));
  });

  it('refuses months outside 1..60 and an unknown account', () => {
    expect(ask('netWorth.history', { months: 0 }, data).error.code).toBe('bad_input');
    expect(ask('netWorth.history', { months: 61 }, data).error.code).toBe('bad_input');
    expect(ask('netWorth.history', { excludeAccounts: ['nope'] }, data).error.code).toBe('bad_input');
  });

  it('an empty budget: zeros at every date', () => {
    const r = ask('netWorth.history', { months: 2 }, empty());
    expect(r.value.points).toEqual(['2026-08-31', '2026-09-30', '2026-10-15'].map(date => ({ date, ...Object.fromEntries(PARTS.map(k => [k, 0])) })));
  });

  it('is JSON-safe', () => {
    const r = ask('netWorth.history', {}, data);
    expect(JSON.parse(JSON.stringify(r.value))).toEqual(r.value);
  });
});

// ── forecast.simulation ────────────────────────────────────────────────────

describe('forecast.simulation', () => {
  it('equals the page\'s base run: month-end lines over every account, its dates to act on', () => {
    const r = ask('forecast.simulation', {}, data);
    expect(r.ok, JSON.stringify(r)).toBe(true);
    const { base } = pageSims(data, NOW);
    expect(r.value.start).toBe(base.startDate);
    expect(r.value.end).toBe(base.endDate);
    expect(r.value.start).toBe('2026-10-15');
    expect(r.value.end).toBe('2028-10-31');
    expect(r.value.points).toEqual(pointsOf(base, pageCounted(data)));
    expect(r.value.points).toHaveLength(25);
    expect(r.value.alerts).toEqual(base.alerts);
    expect(r.value.alerts.length).toBeGreaterThan(0);
    expect(r.value.whatIf).toBeNull();
    expect(r.value.alertsDiff).toBeNull();
  });

  it('the band runs: shiftPct ±2 with alerts: false', () => {
    const sims = pageSims(data, NOW);
    const low = ask('forecast.simulation', { shiftPct: -2, alerts: false }, data).value;
    const high = ask('forecast.simulation', { shiftPct: 2, alerts: false }, data).value;
    expect(low.points).toEqual(pointsOf(sims.low, pageCounted(data)));
    expect(high.points).toEqual(pointsOf(sims.high, pageCounted(data)));
    expect(low.alerts).toEqual([]);
    expect(high.points.at(-1).total).toBeGreaterThan(low.points.at(-1).total);
  });

  it('an excluded account narrows the totals and parts, not the walk or its alerts', () => {
    const all = ask('forecast.simulation', {}, data).value;
    const r = ask('forecast.simulation', { excludeAccounts: ['inv', 'house'] }, data).value;
    const { base } = pageSims(data, NOW);
    expect(r.points).toEqual(pointsOf(base, pageCounted(data, ['inv', 'house'])));
    expect(r.points.at(-1).assets).toBe(0);
    expect(r.points.at(-1).investment).toBe(0);
    expect(r.points.at(-1).total).not.toBe(all.points.at(-1).total);
    expect(r.alerts).toEqual(all.alerts);
  });

  it('months: a shorter walk', () => {
    const r = ask('forecast.simulation', { months: 12 }, data).value;
    const sim = simulate({ source: data, today: NOW, months: 12 });
    expect(r.points).toEqual(pointsOf(sim, data.accounts));
    expect(r.points).toHaveLength(13);
    expect(r.end).toBe('2027-10-31');
  });

  it('date: the walk starts that day', () => {
    const r = ask('forecast.simulation', { date: '2026-12-01', months: 6 }, data).value;
    const sim = simulate({ source: data, today: new Date(2026, 11, 1), months: 6 });
    expect(r.start).toBe('2026-12-01');
    expect(r.points).toEqual(pointsOf(sim, data.accounts));
    expect(r.alerts).toEqual(sim.alerts);
  });

  for (const [id, name] of [['paycut', 'Pay cut'], ['carloan', 'Car loan'], ['trip', 'Trip'], ['crisis', 'Crisis']]) {
    it(`what-if ${id}: the scenario's run, its alerts and the diff from the base run`, () => {
      const r = ask('forecast.simulation', { whatIf: id }, data);
      expect(r.ok, JSON.stringify(r)).toBe(true);
      const { base } = pageSims(data, NOW);
      const what = pageWhatIf(data, NOW, id);
      expect(r.value.whatIf).toEqual({ id, name });
      expect(r.value.points).toEqual(pointsOf(what.sim, pageCounted(data)));
      expect(r.value.alerts).toEqual(what.sim.alerts);
      expect(r.value.alertsDiff).toEqual(diffAlerts(base.alerts, what.sim.alerts));
      // Not vacuous: the scenario moves the line.
      expect(r.value.points.at(-1).total).not.toBe(pointsOf(base, data.accounts).at(-1).total);
    });
  }

  it('a what-if diff with something in it (losing the pay overdraws the checking account)', () => {
    const r = ask('forecast.simulation', { whatIf: 'paycut' }, data).value;
    expect(r.alertsDiff.added.map(a => `${a.kind}:${a.id}`)).toContain('account-negative:chk');
  });

  it('a what-if with an excluded account: the totals narrow, the diff does not', () => {
    const r = ask('forecast.simulation', { whatIf: 'trip', excludeAccounts: ['house'] }, data).value;
    const what = pageWhatIf(data, NOW, 'trip');
    expect(r.points).toEqual(pointsOf(what.sim, pageCounted(data, ['house'])));
    expect(r.alertsDiff).toEqual(ask('forecast.simulation', { whatIf: 'trip' }, data).value.alertsDiff);
  });

  it('an unknown what-if, or one the cleanup hides: not_found', () => {
    for (const id of ['nope', 'stale']) {
      const r = ask('forecast.simulation', { whatIf: id }, data);
      expect(r.ok).toBe(false);
      expect(r.error).toEqual({ code: 'not_found', params: { kind: 'whatIf', id } });
    }
  });

  it('a what-if with alerts: false has neither alerts nor a diff', () => {
    const r = ask('forecast.simulation', { whatIf: 'trip', alerts: false }, data).value;
    expect(r.alerts).toEqual([]);
    expect(r.alertsDiff).toBeNull();
    expect(r.whatIf).toEqual({ id: 'trip', name: 'Trip' });
  });

  it('account overrides: the walk sees the overlaid accounts, as the page\'s liveAccounts', () => {
    const overrides = [{ id: 'inv', expectedGrowth: 12 }, { id: 'sav', expectedGrowth: 3, plannedMonthly: 250 }, { id: 'house', expectedGrowth: null }];
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
    const r = ask('forecast.simulation', { accountOverrides: overrides }, data).value;
    const { base } = pageSims(data, NOW, live);
    expect(r.points).toEqual(pointsOf(base, pageCounted(data)));
    expect(r.alerts).toEqual(base.alerts);
    const plain = ask('forecast.simulation', {}, data).value;
    expect(r.points.at(-1).investment).toBeGreaterThan(plain.points.at(-1).investment);
    expect(r.points.at(-1).assets).toBeLessThan(plain.points.at(-1).assets);
    // ...and a what-if run sees them too.
    const w = ask('forecast.simulation', { whatIf: 'trip', accountOverrides: overrides }, data).value;
    expect(w.points).toEqual(pointsOf(pageWhatIf(data, NOW, 'trip', live).sim, pageCounted(data)));
  });

  it('an override for an unknown account is ignored', () => {
    const r = ask('forecast.simulation', { accountOverrides: [{ id: 'nope', expectedGrowth: 50 }] }, data).value;
    expect(r.points).toEqual(ask('forecast.simulation', {}, data).value.points);
  });

  it('refuses bad input', () => {
    for (const input of [{ months: 0 }, { months: 61 }, { shiftPct: 21 }, { shiftPct: -21 }, { excludeAccounts: ['nope'] },
      { accountOverrides: [{ id: 'chk', interestTiers: [] }] }, { accountOverrides: [{ expectedGrowth: 1 }] }]) {
      expect(ask('forecast.simulation', input, data).error.code, JSON.stringify(input)).toBe('bad_input');
    }
  });

  it('an empty budget walks nothing', () => {
    const r = ask('forecast.simulation', { months: 1 }, empty()).value;
    expect(r.points).toEqual(['2026-10-31', '2026-11-30'].map(date => ({ date, ...Object.fromEntries(PARTS.map(k => [k, 0])) })));
    expect(r.alerts).toEqual([]);
  });

  it('is JSON-safe and does not hand out the cached run\'s alerts', () => {
    const r = ask('forecast.simulation', { whatIf: 'paycut' }, data).value;
    expect(JSON.parse(JSON.stringify(r))).toEqual(r);
    const firstDate = r.alerts[0].firstDate;
    r.alerts[0].firstDate = 'mutated';
    r.alertsDiff.added[0].firstDate = 'mutated';
    const again = ask('forecast.simulation', { whatIf: 'paycut' }, data).value;
    expect(again.alerts[0].firstDate).toBe(firstDate);
    expect(again.alertsDiff.added[0].firstDate).not.toBe('mutated');
  });
});

// ── The simulate cache ────────────────────────────────────────────────────
//
// Checked by identity, not timing: `simulate` returns the cached Simulation
// object itself on a hit, so two runs that returned the same object computed
// once. The spy (vi.mock above) records what each call returned.

describe('forecast.simulation keeps simulate\'s cache hitting', () => {
  const returned = () => simulate.mock.results.map(r => r.value);

  it('two identical calls on one snapshot: the second is a cache hit', () => {
    simulate.mockClear();
    ask('forecast.simulation', {}, data);
    ask('forecast.simulation', {}, data);
    const [a, b] = returned();
    expect(simulate).toHaveBeenCalledTimes(2);
    expect(b).toBe(a);
  });

  it('default inputs share the page\'s base run (the Dashboard pre-warms Net worth)', () => {
    simulate.mockClear();
    ask('forecast.simulation', {}, data);
    const page = simulate({ source: data, today: NOW });
    expect(page).toBe(returned()[0]);
  });

  it('a fresh snapshot object over the same arrays still hits (a session builds one per query)', () => {
    simulate.mockClear();
    ask('forecast.simulation', { shiftPct: 2, alerts: false }, data);
    ask('forecast.simulation', { shiftPct: 2, alerts: false }, { ...data });
    const [a, b] = returned();
    expect(b).toBe(a);
  });

  it('equal account overrides in a new array: the overlay is memoised, so it hits', () => {
    simulate.mockClear();
    ask('forecast.simulation', { accountOverrides: [{ id: 'inv', expectedGrowth: 7 }] }, data);
    ask('forecast.simulation', { accountOverrides: [{ id: 'inv', expectedGrowth: 7 }] }, data);
    const [a, b] = returned();
    expect(b).toBe(a);
    expect(simulate.mock.calls[1][0].source.accounts).toBe(simulate.mock.calls[0][0].source.accounts);
  });

  it('a what-if: the scenario object and the cut function keep their identity, so both runs hit', () => {
    simulate.mockClear();
    ask('forecast.simulation', { whatIf: 'crisis' }, data);
    ask('forecast.simulation', { whatIf: 'crisis' }, data);
    const calls = simulate.mock.calls.map(c => c[0]);
    const res = returned();
    // Each call runs the scenario and the base run its diff is against.
    expect(calls).toHaveLength(4);
    const firstWhat = calls.findIndex(c => c.scenario);
    const secondWhat = calls.findIndex((c, i) => i > firstWhat && c.scenario);
    expect(calls[secondWhat].scenario).toBe(calls[firstWhat].scenario);
    expect(calls[secondWhat].stressCut).toBe(calls[firstWhat].stressCut);
    expect(res[secondWhat]).toBe(res[firstWhat]);
    const bases = calls.map((c, i) => (c.scenario ? null : res[i])).filter(Boolean);
    expect(bases[1]).toBe(bases[0]);
    // The base run inside a what-if call is the plain default run.
    expect(bases[0]).toBe(simulate({ source: data, today: NOW }));
  });
});
