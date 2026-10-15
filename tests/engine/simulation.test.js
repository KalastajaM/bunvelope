// The projection walk (spec: docs/superpowers/specs/2026-09-25-projection-simulation-design.md).
// Every test passes an explicit clock; the engine reads none.
import { describe, it, expect, beforeEach } from 'vitest';
import {
  simulate, lensTransactions, computeAccountBalances, computeEnvelopeBalances,
  computeUnallocated, LENS_FORECAST, projectNetWorth, projectFromSimulation,
} from '../../js/engine.js';
import { _resetSimulationCache } from '../../js/engine/simulation.js';
import { _resetLensCache } from '../../js/engine/lens.js';

const TODAY = new Date(2026, 8, 25); // 2026-09-25, local time

const allMonths = {
  Jan: true, Feb: true, Mar: true, Apr: true, May: true, Jun: true,
  Jul: true, Aug: true, Sep: true, Oct: true, Nov: true, Dec: true,
};

const salary = {
  id: 'inc1', kind: 'income', as_schedule: true, account_id: 'a1',
  monthly_schedule: allMonths, payment_day: 5, default_amount: 2000,
  as_schedule_since: '2026-01-01', description: 'Salary',
};
const rent = {
  id: 'exp1', envelope_id: 'e1', as_schedule: true, account_id: 'a1',
  monthly_schedule: allMonths, payment_day: 5, default_amount: 800,
  as_schedule_since: '2026-01-01', description: 'Rent',
};

function base(extra = {}) {
  return {
    accounts: [
      { id: 'a1', name: 'Checking', type: 'bank', initialBalance: 1000 },
      { id: 'sav', name: 'Savings', type: 'savings', initialBalance: 5000 },
    ],
    envelopes: [{ id: 'e1', name: 'Rent' }],
    budgetItems: [salary, rent],
    envelopeTemplates: [],
    transactions: [
      { id: 't1', type: 'fill', date: '2026-09-01', lines: [{ envelope_id: 'e1', amount: 800 }] },
      { id: 't2', type: 'income', date: '2027-03-10', amount: 300, account: 'a1' },
    ],
    meta: { country: 'FI' },
    ...extra,
  };
}

beforeEach(() => { _resetSimulationCache(); _resetLensCache(); });

describe('simulate — the walk', () => {
  it('needs a clock', () => {
    expect(() => simulate({ source: base() })).toThrow();
  });

  it('rejects a months that is not a non-negative integer instead of hanging', () => {
    for (const months of [NaN, '24', -1, 1.5, Infinity]) {
      expect(() => simulate({ source: base(), today: TODAY, months: /** @type {any} */ (months) }))
        .toThrow(/simulate.*months/);
    }
  });

  it('runs from today to the last day of the 24th month, one snapshot per month-end', () => {
    const sim = simulate({ source: base(), today: TODAY });
    expect(sim.startDate).toBe('2026-09-25');
    expect(sim.endDate).toBe('2028-09-30');
    expect(sim.monthly).toHaveLength(25);
    expect(sim.monthly[0].date).toBe('2026-09-30');
    expect(sim.monthly[12].date).toBe('2027-09-30');
    expect(sim.monthly[24].date).toBe('2028-09-30');
    expect(sim.opening.date).toBe('2026-09-25');
    expect(sim.rows.every(r => (r.date || '') <= sim.endDate)).toBe(true);
  });

  it('agrees with the Forecast lens at every month-end, accounts, envelopes and Unallocated', () => {
    const source = base();
    const sim = simulate({ source, today: TODAY });
    const rows = lensTransactions(source, { lens: LENS_FORECAST, horizon: sim.endDate, today: TODAY });
    for (const snap of sim.monthly) {
      const acc = computeAccountBalances(source.accounts, rows, { asOf: snap.date });
      const env = computeEnvelopeBalances(rows, { asOf: snap.date });
      for (const a of source.accounts) expect(snap.accounts.get(a.id)).toBeCloseTo(acc.get(a.id) ?? 0, 2);
      expect(snap.envelopes.get('e1') ?? 0).toBeCloseTo(env.get('e1') ?? 0, 2);
      expect(snap.unallocated).toBeCloseTo(computeUnallocated(acc, env, source.accounts), 2);
    }
  });

  it('opens on today\'s balances, future-dated booked rows not yet applied', () => {
    const sim = simulate({ source: base(), today: TODAY });
    expect(sim.opening.accounts.get('a1')).toBe(1000);
    expect(sim.opening.envelopes.get('e1')).toBe(800);
    expect(sim.opening.netWorth.total).toBe(6000);
  });

  it('returns the identical object for identical inputs', () => {
    const source = base();
    expect(simulate({ source, today: TODAY })).toBe(simulate({ source, today: TODAY }));
    expect(simulate({ source, today: TODAY, shiftPct: 2 })).not.toBe(simulate({ source, today: TODAY }));
  });
});

const JAN1 = new Date(2026, 0, 1);
const bare = (accounts, transactions = []) => ({
  accounts, envelopes: [], budgetItems: [], envelopeTemplates: [], transactions, meta: { country: 'FI' },
});
const simRows = (sim, kind) => sim.rows.filter(r => r.sim === kind);

describe('simulate — interest', () => {
  it.each([[9000, 'income', 1000, 90, 200], [10000, 'expense', 1000, 200, 90]])(
    'reselects the full-balance tier after a %s balance changes via %s', (initialBalance, type, amount, before, after) => {
      const sim = simulate({
        source: bare([{ id: 'sav', type: 'savings', initialBalance, interestTierMode: 'full-balance',
          interestTiers: [{ upTo: 10000, rate: 1 }, { rate: 2 }] }],
        [{ id: 'change', type, account: 'sav', amount, date: '2026-07-01' }]), today: JAN1,
      });
      expect(simRows(sim, 'interest')[0].amount).toBe(Math.round((181 * before + 184 * after) / 365 * 100) / 100);
    });

  it('accrues daily against the tiers and pays yearly on Dec 31 by default', () => {
    const sim = simulate({
      source: bare([{ id: 'sav', type: 'savings', initialBalance: 10000,
        interestTiers: [{ upTo: 5000, rate: 1 }, { rate: 2 }] }]),
      today: JAN1,
    });
    const rows = simRows(sim, 'interest');
    expect(rows.map(r => r.date)).toEqual(['2026-12-31', '2027-12-31']);
    expect(rows.map(r => r.amount)).toEqual([150, 153]); // 50 + 100, then 50 + 5150 × 2 %
    expect(rows[0]).toMatchObject({ type: 'adjustment', target: 'account', target_id: 'sav', is_forecast: true });
  });

  it('accrues each part of the year at the rate of the tier the balance was in', () => {
    const sim = simulate({
      source: bare([{ id: 'sav', type: 'savings', initialBalance: 4000,
        interestTiers: [{ upTo: 5000, rate: 1 }, { rate: 3 }] }],
      [{ id: 'in', type: 'income', account: 'sav', amount: 2000, date: '2026-07-01' }]),
      today: JAN1,
    });
    // Jan 1–Jun 30: 181 days at 40/yr; Jul 1–Dec 31: 184 days at 50 + 30 = 80/yr.
    expect(simRows(sim, 'interest')[0].amount).toBe(Math.round((181 * 40 + 184 * 80) / 365 * 100) / 100);
  });

  it('pays on the account\'s schedule', () => {
    const acct = payout => bare([{ id: 'sav', type: 'savings', initialBalance: 12000,
      interestTiers: [{ rate: 1.2 }], interestPayout: payout }]);
    const monthly = simRows(simulate({ source: acct('monthly'), today: JAN1 }), 'interest');
    expect(monthly).toHaveLength(25);
    expect(monthly.slice(0, 2).map(r => r.date)).toEqual(['2026-01-31', '2026-02-28']);
    expect(monthly[0].amount).toBe(Math.round(31 * 144 / 365 * 100) / 100);
    const quarterly = simRows(simulate({ source: acct('quarterly'), today: JAN1 }), 'interest');
    expect(quarterly.slice(0, 4).map(r => r.date)).toEqual(['2026-03-31', '2026-06-30', '2026-09-30', '2026-12-31']);
  });

  it('credits no interest onto a loan given: it is paid in cash', () => {
    const sim = simulate({ source: bare([{ id: 'lg', type: 'loan_given', initialBalance: 55000, interestTiers: [{ rate: 2.5 }] }]), today: JAN1 });
    expect(simRows(sim, 'interest')).toEqual([]);
  });

  it('writes no row when nothing accrued, and expectedGrowth overrides the tiers', () => {
    const zero = simulate({ source: bare([{ id: 'sav', type: 'savings', initialBalance: 1000, interestTiers: [{ rate: 0 }] }]), today: JAN1 });
    expect(simRows(zero, 'interest')).toEqual([]);
    const both = simulate({ source: bare([{ id: 'sav', type: 'savings', initialBalance: 1000,
      interestTiers: [{ rate: 3 }], expectedGrowth: 5 }]), today: JAN1 });
    expect(simRows(both, 'interest')).toEqual([]);
    expect(simRows(both, 'growth').length).toBeGreaterThan(0);
  });
});

describe('simulate — value growth', () => {
  it('matches projectNetWorth\'s monthly compounding within rounding', () => {
    const accounts = [{ id: 'fund', type: 'investment', initialBalance: 10000, expectedGrowth: 7 }];
    const sim = simulate({ source: bare(accounts), today: JAN1 });
    const p = projectNetWorth({
      accounts, balances: new Map([['fund', 10000]]), growthPct: new Map([['fund', 7]]),
      contribution: new Map(), years: 2,
    });
    // One round2 per month-end: at most half a cent each.
    expect(Math.abs(sim.monthly[11].accounts.get('fund') - p[1].total)).toBeLessThan(0.07);
    expect(Math.abs(sim.monthly[23].accounts.get('fund') - p[2].total)).toBeLessThan(0.13);
  });

  it('grows the month today falls in only for the days left in it', () => {
    const sim = simulate({
      source: bare([{ id: 'fund', type: 'investment', initialBalance: 10000, expectedGrowth: 7 }]),
      today: new Date(2026, 8, 16), // 15 of September's 30 days remain, the 16th included
    });
    const first = simRows(sim, 'growth')[0];
    expect(first.date).toBe('2026-09-30');
    expect(first.amount).toBe(Math.round(10000 * (Math.pow(1.07, 0.5 / 12) - 1) * 100) / 100);
  });
});

describe('simulate — the band', () => {
  it('moves growth only; booked and scheduled rows are identical in every run', () => {
    const source = base({ accounts: [
      { id: 'a1', name: 'Checking', type: 'bank', initialBalance: 1000 },
      { id: 'sav', name: 'Savings', type: 'savings', initialBalance: 5000, interestTiers: [{ rate: 1 }] },
    ] });
    const plain = sim => sim.rows.filter(r => !r.sim).map(r => `${r.id}|${r.date}|${r.amount}`);
    const low = simulate({ source, today: TODAY, shiftPct: -2 });
    const mid = simulate({ source, today: TODAY });
    const high = simulate({ source, today: TODAY, shiftPct: 2 });
    expect(plain(low)).toEqual(plain(mid));
    expect(plain(high)).toEqual(plain(mid));
    expect(simRows(low, 'interest')).toEqual([]); // 1 % − 2 floors at 0
    expect(simRows(high, 'interest')[0].amount).toBeGreaterThan(simRows(mid, 'interest')[0].amount);
  });

  it('keeps a 0 % tier at 0 and lets a shifted expectedGrowth go negative', () => {
    const zeroTier = simulate({ source: bare([{ id: 'sav', type: 'savings', initialBalance: 1000, interestTiers: [{ rate: 0 }] }]), today: JAN1, shiftPct: 2 });
    expect(simRows(zeroTier, 'interest')).toEqual([]);
    const shrinking = simulate({ source: bare([{ id: 'fund', type: 'investment', initialBalance: 1000, expectedGrowth: 1 }]), today: JAN1, shiftPct: -2 });
    expect(simRows(shrinking, 'growth')[0].amount).toBeLessThan(0);
  });
});

describe('simulate — dates to act on', () => {
  const alertSource = (extra = {}) => ({
    accounts: [
      { id: 'a1', name: 'Checking', type: 'bank', initialBalance: 500 },
      { id: 'cc', name: 'Card', type: 'credit_card', initialBalance: -200 },
      { id: 'old', name: 'Old', type: 'bank', initialBalance: -50, archived: true },
    ],
    envelopes: [{ id: 'e1', name: 'Groceries' }, { id: 'e2', name: 'Misc' }],
    budgetItems: [{ id: 'buf', envelope_id: 'e1', extra_buffer: 50 }],
    envelopeTemplates: [],
    transactions: [
      { id: 'f1', type: 'fill', date: '2026-09-01', lines: [{ envelope_id: 'e1', amount: 100 }] },
      { id: 'x0', type: 'expense', date: '2026-09-02', amount: 10, account: 'a1', envelope_id: 'e2' },
      { id: 'x1', type: 'expense', date: '2026-10-05', amount: 60, account: 'a1', envelope_id: 'e1' },
      { id: 'x2', type: 'expense', date: '2026-10-10', amount: 800, account: 'a1', envelope_id: '__none__' },
      { id: 'i1', type: 'income', date: '2026-11-01', amount: 1000, account: 'a1', envelope_id: '__none__' },
    ],
    meta: { country: 'FI' },
    ...extra,
  });
  const find = (sim, kind, id = null) => sim.alerts.find(a => a.kind === kind && a.id === id);

  it('finds an account going below 0, with its lowest point', () => {
    const a = find(simulate({ source: alertSource(), today: TODAY }), 'account-negative', 'a1');
    // 500 − 10 − 60 − 800 = −370 on Oct 10.
    expect(a).toMatchObject({ firstDate: '2026-10-10', low: -370, lowDate: '2026-10-10', threshold: 0 });
  });

  it('ignores credit cards and archived accounts', () => {
    const sim = simulate({ source: alertSource(), today: TODAY });
    expect(find(sim, 'account-negative', 'cc')).toBeUndefined();
    expect(find(sim, 'account-negative', 'old')).toBeUndefined();
  });

  it('measures an envelope against its floor, and says "now" for one already short', () => {
    const sim = simulate({ source: alertSource(), today: TODAY });
    expect(find(sim, 'envelope-short', 'e1')).toMatchObject({ firstDate: '2026-10-05', low: 40, threshold: 50 });
    expect(find(sim, 'envelope-short', 'e2')).toMatchObject({ firstDate: '2026-09-25', low: -10, threshold: 0 });
  });

  it('finds Unallocated below 0', () => {
    const u = find(simulate({ source: alertSource(), today: TODAY }), 'unallocated-negative');
    expect(u?.firstDate).toBe('2026-10-10');
  });

  it('sorts alerts by first date', () => {
    const dates = simulate({ source: alertSource(), today: TODAY }).alerts.map(a => a.firstDate);
    expect(dates).toEqual([...dates].sort());
  });

  it('compares crisis cash with the emergency target, and skips it with no emergency envelope', () => {
    expect(find(simulate({ source: alertSource(), today: TODAY }), 'crisis-cash-below')).toBeUndefined();
    const source = {
      accounts: [
        { id: 'a1', name: 'Checking', type: 'bank', initialBalance: 0 },
        { id: 'sav', name: 'Savings', type: 'savings', initialBalance: 3500 },
      ],
      envelopes: [{ id: 'emg', name: 'Emergency' }, { id: 'e1', name: 'Rent' }],
      budgetItems: [{
        id: 'ess', envelope_id: 'e1', as_schedule: true, account_id: 'a1', include_in_emergency_budget: true,
        monthly_schedule: allMonths, payment_day: 5, default_amount: 500, as_schedule_since: '2026-01-01',
      }],
      envelopeTemplates: [],
      transactions: [],
      meta: { country: 'FI', emergency_envelope_id: 'emg', emergency_duration_months: 6 },
    };
    const sim = simulate({ source, today: TODAY });
    const c = find(sim, 'crisis-cash-below');
    // Target 500 × 6 = 3 000; 3 500 falls to 3 000 at the first bill, below it at the second.
    const bills = sim.rows.filter(r => r.type === 'expense' && r.account === 'a1').map(r => r.date);
    expect(c).toMatchObject({ threshold: 3000, firstDate: bills[1] });
  });

  it('skips the alert work when trackAlerts is false, and walks the same balances', () => {
    const source = alertSource({ accounts: [
      ...alertSource().accounts,
      { id: 'sav', name: 'Savings', type: 'savings', initialBalance: 5000, interestTiers: [{ rate: 2 }] },
    ] });
    const full = simulate({ source, today: TODAY });
    const quiet = simulate({ source, today: TODAY, trackAlerts: false });
    expect(full.alerts.length).toBeGreaterThan(0);
    expect(quiet.alerts).toEqual([]);
    expect(quiet).not.toBe(full); // part of the cache key
    expect(quiet.monthly.map(m => [...m.accounts])).toEqual(full.monthly.map(m => [...m.accounts]));
    expect(quiet.monthly.map(m => [...m.envelopes])).toEqual(full.monthly.map(m => [...m.envelopes]));
  });
});

describe('simulate — hand-off to the long projection', () => {
  it('takes the last simulated year\'s net inflow per account, without growth rows', () => {
    const source = base({
      accounts: [
        { id: 'a1', name: 'Checking', type: 'bank', initialBalance: 1000 },
        { id: 'sav', name: 'Savings', type: 'savings', initialBalance: 5000, expectedGrowth: 5 },
        { id: 'home', name: 'Home', type: 'asset', initialBalance: 200000 },
      ],
      budgetItems: [salary],
      transactions: [],
    });
    const sim = simulate({ source, today: TODAY });
    expect(sim.lastYearContribution.get('a1')).toBe(2000);
    expect(sim.lastYearContribution.get('sav')).toBe(0);
    expect(sim.lastYearContribution.get('home')).toBe(0);
  });

  it('counts a booked one-off in the last year once, in the balance, not as a monthly inflow', () => {
    const accounts = [{ id: 'a1', name: 'Checking', type: 'bank', initialBalance: 1000 }];
    const plain = base({ accounts, budgetItems: [salary], transactions: [] });
    const withOneOff = base({
      accounts, budgetItems: [salary],
      transactions: [{ id: 'bonus', type: 'income', account: 'a1', amount: 12000, date: '2028-06-01' }],
    });
    const without = simulate({ source: plain, today: TODAY });
    const sim = simulate({ source: withOneOff, today: TODAY });
    expect(sim.lastYearContribution.get('a1')).toBe(2000);
    expect(round2(sim.monthly[24].accounts.get('a1') - without.monthly[24].accounts.get('a1'))).toBe(12000);
  });

  it('carries booked rows after the walk into the years they land in', () => {
    const accounts = [
      { id: 'a1', name: 'Checking', type: 'bank', initialBalance: 1000 },
      { id: 'sav', name: 'Savings', type: 'savings', initialBalance: 0 },
    ];
    const source = bare(accounts, [
      { id: 'late', type: 'income', account: 'a1', amount: 55000, date: '2031-08-17' },
      { id: 'mv', type: 'account_transfer', from_account: 'a1', to_account: 'sav', amount: 100, date: '2030-01-15' },
      { id: 'gen', type: 'income', account: 'a1', amount: 7, date: '2031-01-01', is_forecast: true },
    ]);
    const sim = simulate({ source, today: TODAY }); // endDate 2028-09-30
    expect(sim.laterBooked).toEqual(expect.arrayContaining([
      { month: 35, accountId: 'a1', amount: 55000 },
      { month: 16, accountId: 'a1', amount: -100 },
      { month: 16, accountId: 'sav', amount: 100 },
    ]));
    expect(sim.laterBooked).toHaveLength(3);
    expect(sim.rows.some(r => r.id === 'late')).toBe(false);

    const p = projectFromSimulation({
      accounts, sim, growthPct: new Map(), contribution: new Map(), years: 10,
    });
    // Month 35 after the walk is projection year 3, joined year 5.
    expect(p.map(x => x.total)).toEqual([1000, 1000, 1000, 1000, 1000, 56000, 56000, 56000, 56000, 56000, 56000]);
    const bankOnly = projectFromSimulation({ accounts: [accounts[0]], sim, growthPct: new Map(), contribution: new Map(), years: 5 });
    expect(bankOnly[5].total).toBe(1000 - 100 + 55000);
  });

  it('joins years 1 and 2 from the walk and continues with the same band', () => {
    const accounts = [{ id: 'fund', type: 'investment', initialBalance: 10000, expectedGrowth: 7 }];
    const sim = simulate({ source: bare(accounts), today: JAN1, shiftPct: 2 });
    const growthPct = new Map([['fund', 7]]);
    const p = projectFromSimulation({ accounts, sim, growthPct, contribution: new Map(), years: 3, shiftPct: 2 });
    expect(p[0].total).toBe(10000);
    expect(p[1].total).toBe(round2(sim.monthly[12].accounts.get('fund')));
    expect(p[2].total).toBe(round2(sim.monthly[24].accounts.get('fund')));
    expect(p[3].total).toBeCloseTo(sim.monthly[24].accounts.get('fund') * 1.09, 1);
  });

  it('carries interest accrued since the last payout into the long projection', () => {
    // Paid yearly: month 24 (2028-09-30) holds Jan–Sep 2028's interest, earned
    // but not yet paid. It is not in monthly[24]; it is in the long line.
    const accounts = [{ id: 'sav', type: 'savings', initialBalance: 20000, interestTiers: [{ rate: 3 }] }];
    const sim = simulate({ source: bare(accounts), today: TODAY });
    const paid = sim.monthly[24].accounts.get('sav');
    const days2028 = 31 + 29 + 31 + 30 + 31 + 30 + 31 + 31 + 30; // Jan 1 – Sep 30, a leap year
    const expected = paid * 0.03 * days2028 / 365;
    expect(Math.abs(sim.accruedAtEnd.get('sav') - expected)).toBeLessThan(0.01);
    expect(sim.accruedAtEnd.get('sav')).toBe(round2(sim.accruedAtEnd.get('sav')));

    const growthPct = new Map([['sav', 3]]);
    const p = projectFromSimulation({ accounts, sim, growthPct, contribution: new Map(), years: 3 });
    const project = balance => projectNetWorth({
      accounts, balances: new Map([['sav', balance]]), growthPct, contribution: new Map(), years: 1,
    })[1].total;
    expect(p[2].total).toBe(round2(paid)); // month 24 itself is money actually paid
    expect(p[3].total).toBe(project(paid + sim.accruedAtEnd.get('sav')));
    expect(p[3].total - project(paid)).toBeCloseTo(sim.accruedAtEnd.get('sav') * 1.03, 1);
    expect(sim.monthly[24].accounts.get('sav')).toBe(paid); // not mutated
  });

  it('reports no pending accrual for an account paid at the walk\'s last month-end', () => {
    const accounts = [{ id: 'sav', type: 'savings', initialBalance: 20000, interestTiers: [{ rate: 3 }], interestPayout: 'monthly' }];
    const sim = simulate({ source: bare(accounts), today: TODAY });
    expect(sim.accruedAtEnd.has('sav')).toBe(false);
  });
});

function round2(n) { return Math.round(n * 100) / 100; }
