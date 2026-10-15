// tests/core-projection.test.js — the Net worth page's projection helpers in
// core (js/core/projection.js): growth and contribution per account, the
// loans' repayment paths, the table's sums and the plan-vs-actual flag, and
// the two one-slot memos (the account-overrides overlay and the what-if
// scenario list) that keep `simulate`'s identity-keyed cache hitting.
//
// Each `page*` helper below copies the page's current code verbatim
// (js/pages/net-worth.js; facts-4b §3.6, §3.7), with `state` → the fixture
// and `now()` → the fixed clock, and the core helper must equal it.
import { describe, it, expect } from 'vitest';
import {
  growthFor, contributionFor, readContributionSource, loanSchedulesFor, loanPaths,
  contributionTable, planGap, accountsWithOverrides, whatIfScenarios, withAccountOverrides,
  amountsOf, cachedAverages, cachedLoanSchedules, cachedLoanPaths,
} from '../js/core/projection.js';
import * as pageContribution from '../js/pages/net-worth-contribution.js';
import { computeAnnualInterest, isAssetAccount, simulate, averageMonthlyContribution } from '../js/engine.js';
import { loanRepayment, loanBalancePath } from '../js/engine/loan-schedule.js';
import { normalizeScenarios } from '../js/engine/whatif.js';
import { round2 } from '../js/utils.js';

function deepFreeze(o) { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); Object.values(o).forEach(deepFreeze); } return o; }
const at = (y, m, d) => new Date(y, m - 1, d, 10, 0, 0);
const NOW = at(2026, 10, 15);
const ALL = { Jan: true, Feb: true, Mar: true, Apr: true, May: true, Jun: true, Jul: true, Aug: true, Sep: true, Oct: true, Nov: true, Dec: true };

// ── The page's code, verbatim ──────────────────────────────────────────────

// net-worth.js:46-55
function pageGrowthFor(account, balance) {
  if (Number.isFinite(account.expectedGrowth)) return { pct: account.expectedGrowth, source: 'set' };
  // A loan given's interest is paid out in cash, not added to the loan.
  if (account.type === 'loan_given') return { pct: null, source: 'none' };
  if (Array.isArray(account.interestTiers) && account.interestTiers.length && balance > 0) {
    const annual = computeAnnualInterest(balance, account.interestTiers);
    if (annual > 0) return { pct: round2((annual / balance) * 100), source: 'interest' };
  }
  return { pct: null, source: 'none' };
}

// net-worth-contribution.js (before the move)
function pageReadContributionSource(prefs) {
  return prefs?.contributionSource === 'history' ? 'history' : 'plan';
}
function pageContributionFor(account, amounts, source) {
  if (Number.isFinite(account.plannedMonthly)) return { amount: account.plannedMonthly, source: 'set' };
  if (isAssetAccount(account)) return { amount: 0, source: 'none' };
  return source === 'history'
    ? { amount: amounts.history, source: 'history' }
    : { amount: amounts.plan, source: 'plan' };
}

// net-worth.js:126-135
function pageLoanSchedules(state, counted, today) {
  const loanSchedules = new Map();
  for (const a of counted) {
    if (!a || a.type !== 'loan' || a.archived) continue;
    const r = loanRepayment(a, {
      budgetItems: state.budgetItems, transactions: state.transactions, today, country: state.meta?.country ?? 'FI',
    });
    if (r.status === 'ok' && r.schedule.rows.length) loanSchedules.set(a.id, r.schedule);
  }
  return loanSchedules;
}
const pageScheduledPaths = (loanSchedules, today, horizon) => new Map([...loanSchedules].map(([id, sch]) => [id, loanBalancePath(sch, today, horizon * 12 + 1)]));

// net-worth.js paintTable (535-622), the sums without the DOM
function pageTable(accounts, sims, averages, contributionSource) {
  const amountsFor = a => ({ plan: sims.base.lastYearContribution.get(a.id) ?? 0, history: averages.get(a.id) ?? 0 });
  let used = 0, plan = 0, actual = 0;
  const shown = [];
  for (const a of accounts) {
    const bal = sims.base.opening.accounts.get(a.id) ?? (Number(a.initialBalance) || 0);
    const g = pageGrowthFor(a, bal);
    const avg = averages.get(a.id) ?? 0;
    const amounts = amountsFor(a);
    const c = pageContributionFor(a, amounts, contributionSource);
    if (Math.abs(bal) < 0.005 && Math.abs(c.amount) < 0.005 && g.pct === null) continue;
    used += c.amount;
    plan += pageContributionFor(a, amounts, 'plan').amount;
    actual += avg;
    shown.push({ id: a.id, bal, g, c });
  }
  return { shown, used: round2(used), plan: round2(plan), actual: round2(actual) };
}

// net-worth.js paintPlanNote (505)
const pageGap = ({ plan, actual }) => Math.abs(actual) >= 1 && actual - plan > Math.abs(actual) / 2;

// ── Fixture ────────────────────────────────────────────────────────────────

const mortgage = {
  id: 'mortgage', kind: 'loan_payment', description: 'Home loan', envelope_id: 'rent', account_id: 'chk', to_account_id: 'mtg',
  default_amount: -474.21, monthly_schedule: ALL, payment_day: 5, as_schedule: true, as_schedule_since: '2026-10-01',
  include: true, schedule_day_type: 'exact', loan_method: 'annuity', loan_end: '2051-09',
};
const data = deepFreeze({
  meta: { country: 'FI' },
  accounts: [
    { id: 'chk', name: 'Checking', type: 'bank', initialBalance: 800 },
    { id: 'sav', name: 'Savings', type: 'savings', initialBalance: 5000, interestTiers: [{ upTo: 10000, rate: 2 }, { rate: 0.5 }] },
    { id: 'low', name: 'Low tier', type: 'savings', initialBalance: 0, interestTiers: [{ rate: 1 }] },
    { id: 'inv', name: 'Broker', type: 'investment', initialBalance: 10000, expectedGrowth: 5 },
    { id: 'house', name: 'House', type: 'asset', initialBalance: 200000, expectedGrowth: 1 },
    { id: 'car', name: 'Car', type: 'asset', initialBalance: 9000 },
    { id: 'mtg', name: 'Mortgage', type: 'loan', initialBalance: -100000, interestRates: [{ from: '2020-01-01', rate: 3 }] },
    { id: 'mtg2', name: 'Unplanned loan', type: 'loan', initialBalance: -5000 },
    { id: 'lent', name: 'Lent', type: 'loan_given', initialBalance: 1000, interestTiers: [{ rate: 4 }] },
    { id: 'empty', name: 'Empty', type: 'bank', initialBalance: 0 },
    { id: 'set', name: 'Set', type: 'bank', initialBalance: 0, plannedMonthly: 150 },
    { id: 'oldmtg', name: 'Old loan', type: 'loan', initialBalance: -2000, archived: true },
  ],
  envelopes: [{ id: 'rent', name: 'Rent' }, { id: 'groc', name: 'Groceries' }],
  budgetItems: [
    { id: 'salary', kind: 'income', description: 'Pay', account_id: 'chk', default_amount: 3000, payment_day: 25,
      schedule_day_type: 'exact', include: true, as_schedule: true, as_schedule_since: '2026-10-01', monthly_schedule: ALL },
    { id: 'food', kind: 'expense', description: 'Food', envelope_id: 'groc', account_id: 'chk', default_amount: -600, payment_day: 5,
      schedule_day_type: 'exact', include: true, as_schedule: true, as_schedule_since: '2026-10-01', monthly_schedule: ALL },
    mortgage,
    { ...mortgage, id: 'oldpay', to_account_id: 'oldmtg' },
  ],
  envelopeTemplates: [],
  transactions: [
    { id: 'i1', type: 'income', date: '2026-07-25', payee: 'Pay', amount: 3000, account: 'chk', status: 'posted' },
    { id: 'i2', type: 'income', date: '2026-08-25', payee: 'Pay', amount: 3000, account: 'chk', status: 'posted' },
    { id: 'i3', type: 'income', date: '2026-09-25', payee: 'Pay', amount: 3000, account: 'chk', status: 'posted' },
    { id: 'e1', type: 'expense', date: '2026-09-02', payee: 'Shop', amount: 2500, account: 'chk', envelope_id: 'groc', status: 'posted' },
    { id: 't1', type: 'account_transfer', date: '2026-08-10', payee: 'Save', amount: 600, from_account: 'chk', to_account: 'sav', status: 'posted' },
  ],
});

describe('growthFor', () => {
  const cases = [
    ['expectedGrowth wins', { type: 'savings', expectedGrowth: 3.5, interestTiers: [{ rate: 2 }] }, 5000],
    ['expectedGrowth 0 is set', { type: 'bank', expectedGrowth: 0 }, 100],
    ['a loan given earns nothing here', { type: 'loan_given', interestTiers: [{ rate: 4 }] }, 1000],
    ['tiers give the interest rate', { type: 'savings', interestTiers: [{ upTo: 10000, rate: 2 }, { rate: 0.5 }] }, 15000],
    ['tiers on a zero balance: none', { type: 'savings', interestTiers: [{ rate: 2 }] }, 0],
    ['tiers on a negative balance: none', { type: 'savings', interestTiers: [{ rate: 2 }] }, -10],
    ['a zero-rate tier: none', { type: 'savings', interestTiers: [{ rate: 0 }] }, 5000],
    ['empty tiers: none', { type: 'savings', interestTiers: [] }, 5000],
    ['no rate at all', { type: 'bank' }, 5000],
    ['a non-finite expectedGrowth is not set', { type: 'bank', expectedGrowth: '5' }, 5000],
  ];
  for (const [name, account, balance] of cases) {
    it(name, () => expect(growthFor(account, balance)).toEqual(pageGrowthFor(account, balance)));
  }
  it('rounds the interest rate to two decimals', () => {
    expect(growthFor({ type: 'savings', interestTiers: [{ upTo: 1000, rate: 3 }, { rate: 1 }] }, 3333)).toEqual({ pct: 1.6, source: 'interest' });
  });
});

describe('contributionFor and readContributionSource', () => {
  const amounts = { plan: -250, history: 400 };
  const accounts = [{ type: 'bank' }, { type: 'bank', plannedMonthly: 100 }, { type: 'bank', plannedMonthly: 0 },
    { type: 'asset' }, { type: 'asset', plannedMonthly: 50 }, { type: 'savings', plannedMonthly: null }];
  it('equals the page for every account and source', () => {
    for (const a of accounts) {
      for (const src of ['plan', 'history']) expect(contributionFor(a, amounts, src)).toEqual(pageContributionFor(a, amounts, src));
    }
  });
  it('reads the saved source as the page did', () => {
    for (const prefs of [undefined, null, {}, { contributionSource: 'history' }, { contributionSource: 'plan' }, { contributionSource: 'x' }]) {
      expect(readContributionSource(prefs)).toBe(pageReadContributionSource(prefs));
    }
  });
  it('the page module re-exports the core reader', () => {
    expect(pageContribution.readContributionSource).toBe(readContributionSource);
    expect(pageContribution).not.toHaveProperty('contributionFor');
  });
});

describe('loanSchedulesFor and loanPaths', () => {
  it('equals the page: the one enabled scheduled item per non-archived loan', () => {
    const got = loanSchedulesFor(data.accounts, { budgetItems: data.budgetItems, transactions: data.transactions, today: NOW, country: 'FI' });
    const want = pageLoanSchedules(data, data.accounts, NOW);
    expect([...got.keys()]).toEqual(['mtg']);
    expect(got).toEqual(want);
    for (const horizon of [5, 10, 20]) {
      expect(loanPaths(got, NOW, horizon * 12 + 1)).toEqual(pageScheduledPaths(want, NOW, horizon));
    }
  });
  it('the country defaults to FI, as the page\'s meta fallback', () => {
    const got = loanSchedulesFor(data.accounts, { budgetItems: data.budgetItems, transactions: data.transactions, today: NOW });
    expect(got).toEqual(pageLoanSchedules({ ...data, meta: {} }, data.accounts, NOW));
  });
  it('none without a paying item; an excluded loan is not looked at', () => {
    expect(loanSchedulesFor(data.accounts, { budgetItems: [], transactions: [], today: NOW }).size).toBe(0);
    const counted = data.accounts.filter(a => a.id !== 'mtg');
    expect(loanSchedulesFor(counted, { budgetItems: data.budgetItems, transactions: data.transactions, today: NOW }).size).toBe(0);
  });
});

describe('contributionTable and planGap', () => {
  const sims = { base: simulate({ source: data, today: NOW }) };
  const averages = averageMonthlyContribution(data.accounts, data.transactions, NOW, 12);
  const active = data.accounts.filter(a => !a.archived);

  for (const source of ['plan', 'history']) {
    it(`equals the page's table sums and skip rule (${source})`, () => {
      const got = contributionTable(active, {
        opening: sims.base.opening.accounts, lastYearContribution: sims.base.lastYearContribution, averages, source,
      });
      const want = pageTable(active, sims, averages, source);
      expect({ used: got.used, plan: got.plan, actual: got.actual }).toEqual({ used: want.used, plan: want.plan, actual: want.actual });
      expect(got.rows.map(r => r.account.id)).toEqual(active.map(a => a.id));
      expect(got.rows.filter(r => r.shown).map(r => r.account.id)).toEqual(want.shown.map(r => r.id));
      for (const w of want.shown) {
        const r = got.rows.find(x => x.account.id === w.id);
        expect(r.balance).toBe(w.bal);
        expect(r.growth).toEqual(w.g);
        expect(r.contribution).toEqual(w.c);
      }
      // The case the skip rule exists for: no balance, no amount, no rate.
      expect(got.rows.find(r => r.account.id === 'empty').shown).toBe(false);
      expect(got.rows.find(r => r.account.id === 'set').shown).toBe(true);
    });
  }

  it('a balance missing from the opening falls back to the initial balance, as the table did', () => {
    const extra = { id: 'ghost', type: 'bank', initialBalance: 12.5 };
    const got = contributionTable([extra], { opening: new Map(), lastYearContribution: new Map(), averages: new Map(), source: 'plan' });
    expect(got.rows[0]).toMatchObject({ balance: 12.5, shown: true, amounts: { plan: 0, history: 0 } });
  });

  it('planGap equals the page\'s condition', () => {
    const pairs = [
      { plan: 0, actual: 0 }, { plan: 0, actual: 0.99 }, { plan: 0, actual: 1 }, { plan: 100, actual: 300 },
      { plan: 150, actual: 300 }, { plan: 149.99, actual: 300 }, { plan: -500, actual: 100 }, { plan: -400, actual: -100 },
      { plan: 300, actual: 100 }, { plan: -1, actual: -1 },
    ];
    for (const p of pairs) expect(planGap(p)).toBe(pageGap(p));
  });
});

describe('accountsWithOverrides', () => {
  const accounts = data.accounts;

  it('no overrides: the accounts array itself', () => {
    expect(accountsWithOverrides(accounts, undefined)).toBe(accounts);
    expect(accountsWithOverrides(accounts, [])).toBe(accounts);
  });

  it('lays each override on a copy, as the page\'s saveNumber did; untouched accounts by reference', () => {
    const out = accountsWithOverrides(accounts, [
      { id: 'chk', expectedGrowth: 2.5 },
      { id: 'inv', expectedGrowth: null, plannedMonthly: 300 },
      { id: 'set', plannedMonthly: null },
    ]);
    expect(out).not.toBe(accounts);
    expect(out.find(a => a.id === 'chk')).toEqual({ ...accounts[0], expectedGrowth: 2.5 });
    const inv = out.find(a => a.id === 'inv');
    expect(inv.plannedMonthly).toBe(300);
    expect('expectedGrowth' in inv).toBe(false);
    expect('plannedMonthly' in out.find(a => a.id === 'set')).toBe(false);
    expect(out.find(a => a.id === 'sav')).toBe(accounts.find(a => a.id === 'sav'));
    expect(out.map(a => a.id)).toEqual(accounts.map(a => a.id));
    // The stored accounts are not touched (the fixture is frozen too).
    expect(accounts.find(a => a.id === 'inv').expectedGrowth).toBe(5);
  });

  it('a later override for one id wins a field both set; an unknown id is ignored', () => {
    const out = accountsWithOverrides(accounts, [
      { id: 'chk', expectedGrowth: 1, plannedMonthly: 10 }, { id: 'chk', expectedGrowth: 2 }, { id: 'nope', expectedGrowth: 9 },
    ]);
    expect(out.find(a => a.id === 'chk')).toMatchObject({ expectedGrowth: 2, plannedMonthly: 10 });
    expect(out).toHaveLength(accounts.length);
  });

  it('memoised one slot on the accounts identity and the overrides\' content', () => {
    const a = accountsWithOverrides(accounts, [{ id: 'chk', expectedGrowth: 2.5 }]);
    expect(accountsWithOverrides(accounts, [{ id: 'chk', expectedGrowth: 2.5 }])).toBe(a);
    const b = accountsWithOverrides(accounts, [{ id: 'chk', expectedGrowth: 3 }]);
    expect(b).not.toBe(a);
    expect(accountsWithOverrides([...accounts], [{ id: 'chk', expectedGrowth: 3 }])).not.toBe(b);
  });
});

describe('whatIfScenarios', () => {
  const raw = [
    { id: 'trip', name: 'Trip', changes: [{ type: 'oneoff', date: '2027-02-10', amount: -2500, account: 'chk', label: 'Trip' }] },
    { id: 'stale', name: 'Old', changes: [{ type: 'oneoff', date: '2027-02-10', amount: -10, account: 'oldmtg', label: 'x' }] },
  ];

  it('equals normalizeScenarios and keeps its identity while the inputs do', () => {
    const list = whatIfScenarios(raw, data.accounts, data.budgetItems);
    expect(list).toEqual(normalizeScenarios(raw, { accounts: data.accounts, budgetItems: data.budgetItems }));
    expect(list.map(s => s.id)).toEqual(['trip']);
    expect(whatIfScenarios(raw, data.accounts, data.budgetItems)).toBe(list);
    expect(whatIfScenarios([...raw], data.accounts, data.budgetItems)).not.toBe(list);
  });

  it('a different accounts or budget items identity recomputes', () => {
    const list = whatIfScenarios(raw, data.accounts, data.budgetItems);
    const other = whatIfScenarios(raw, [...data.accounts], data.budgetItems);
    expect(other).not.toBe(list);
    expect(other).toEqual(list);
    expect(whatIfScenarios(raw, data.accounts, [...data.budgetItems])).not.toBe(other);
  });
});

describe('withAccountOverrides', () => {
  it('the data itself without overrides; else a copy over the memoised overlay', () => {
    expect(withAccountOverrides(data, undefined)).toEqual({ source: data, accounts: data.accounts });
    expect(withAccountOverrides(data, []).source).toBe(data);
    const overrides = [{ id: 'chk', expectedGrowth: 2 }];
    const { source, accounts } = withAccountOverrides(data, overrides);
    expect(accounts).toBe(accountsWithOverrides(data.accounts, overrides));
    expect(source).toEqual({ ...data, accounts });
    expect(withAccountOverrides(data, [...overrides]).accounts).toBe(accounts);
  });
  it('a snapshot without accounts walks one frozen empty array', () => {
    const { source, accounts } = withAccountOverrides({ meta: {} }, undefined);
    expect(accounts).toEqual([]);
    expect(source.accounts).toBe(accounts);
    expect(withAccountOverrides({ meta: {} }, undefined).accounts).toBe(accounts);
  });
});

describe('amountsOf', () => {
  it('the run\'s last year and the 12-month average, 0 when missing', () => {
    const last = new Map([['chk', 120]]);
    const avg = new Map([['chk', 80], ['sav', 50]]);
    expect(amountsOf('chk', last, avg)).toEqual({ plan: 120, history: 80 });
    expect(amountsOf('sav', last, avg)).toEqual({ plan: 0, history: 50 });
    expect(amountsOf('none', last, avg)).toEqual({ plan: 0, history: 0 });
  });
});

// The projection's inputs a horizon or source toggle does not change: one
// slot each, so a second call with the same inputs reuses the first's result.
describe('the projection memos', () => {
  const ctx = { budgetItems: data.budgetItems, transactions: data.transactions, today: NOW, country: 'FI' };
  const sameDay = () => new Date(NOW.getTime());

  it('cachedAverages equals averageMonthlyContribution over the counted accounts, and reuses it', () => {
    const a = cachedAverages(data.accounts, undefined, data.transactions, NOW);
    expect(a).toEqual(averageMonthlyContribution(data.accounts, data.transactions, NOW, 12));
    expect(cachedAverages(data.accounts, undefined, data.transactions, sameDay())).toBe(a);
    const ex = cachedAverages(data.accounts, ['chk'], data.transactions, NOW);
    expect(ex).not.toBe(a);
    expect(ex).toEqual(averageMonthlyContribution(data.accounts.filter(x => x.id !== 'chk'), data.transactions, NOW, 12));
    expect(cachedAverages(data.accounts, ['chk'], data.transactions, NOW)).toBe(ex);
    expect(cachedAverages([...data.accounts], ['chk'], data.transactions, NOW)).not.toBe(ex);
    const t = cachedAverages(data.accounts, ['chk'], [...data.transactions], NOW);
    expect(t).not.toBe(ex);
    expect(cachedAverages(data.accounts, ['chk'], data.transactions, at(2026, 10, 16))).not.toBe(t);
  });

  it('cachedLoanSchedules equals loanSchedulesFor over the counted accounts, and reuses it', () => {
    const s = cachedLoanSchedules(data.accounts, undefined, ctx);
    expect(s).toEqual(loanSchedulesFor(data.accounts, ctx));
    expect(cachedLoanSchedules(data.accounts, undefined, { ...ctx, today: sameDay() })).toBe(s);
    expect(cachedLoanSchedules(data.accounts, ['mtg'], ctx).size).toBe(0);
    const again = cachedLoanSchedules(data.accounts, undefined, ctx);
    expect(again).not.toBe(s);
    expect(again).toEqual(s);
    expect(cachedLoanSchedules(data.accounts, undefined, ctx)).toBe(again);
    for (const changed of [{ budgetItems: [...data.budgetItems] }, { transactions: [...data.transactions] }, { country: 'SE' }, { today: at(2026, 10, 16) }]) {
      const next = cachedLoanSchedules(data.accounts, undefined, { ...ctx, ...changed });
      expect(next).not.toBe(again);
      expect(cachedLoanSchedules(data.accounts, undefined, { ...ctx, ...changed })).toBe(next);
    }
    expect(cachedLoanSchedules([...data.accounts], undefined, ctx)).not.toBe(again);
  });

  it('cachedLoanPaths equals loanPaths, and reuses it for the same schedules, day and months', () => {
    const schedules = cachedLoanSchedules(data.accounts, undefined, ctx);
    const p = cachedLoanPaths(schedules, NOW, 121);
    expect(p).toEqual(loanPaths(schedules, NOW, 121));
    expect(cachedLoanPaths(schedules, sameDay(), 121)).toBe(p);
    const longer = cachedLoanPaths(schedules, NOW, 241);
    expect(longer).not.toBe(p);
    expect(longer.get('mtg')).toHaveLength(242);
    expect(cachedLoanPaths(new Map(schedules), NOW, 241)).not.toBe(longer);
  });
});

it('uses the full-balance tier for the projected growth estimate', () => {
  expect(growthFor({ type: 'savings', interestTierMode: 'full-balance', interestTiers: [{ upTo: 10000, rate: 1 }, { rate: 2 }] }, 10000)).toEqual({ pct: 2, source: 'interest' });
});
