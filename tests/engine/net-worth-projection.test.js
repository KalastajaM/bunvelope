// Net worth history, contributions and the long-horizon projection
// (owner request 2026-09-24; kept out of the Forecast lens by decision).
import { describe, it, expect } from 'vitest';
import {
  computeNetWorth, computeNetWorthHistory, averageMonthlyContribution, projectNetWorth,
} from '../../js/engine.js';

const accounts = [
  { id: 'bank', type: 'bank', initialBalance: 1000 },
  { id: 'fund', type: 'investment', initialBalance: 10000 },
  { id: 'home', type: 'asset', initialBalance: 200000 },
  { id: 'gone', type: 'bank', initialBalance: 50, archived: true },
];
const txs = [
  { id: 'i1', type: 'income', account: 'bank', amount: 3000, date: '2026-01-25' },
  { id: 'b1', type: 'investment_transfer', direction: 'buy', from_account: 'bank', to_account: 'fund', amount: 500, date: '2026-02-01' },
  { id: 'v1', type: 'adjustment', target: 'account', target_id: 'home', amount: 5000, date: '2026-03-15' },
  { id: 'e1', type: 'expense', account: 'bank', amount: 200, date: '2026-03-20' },
];

describe('computeNetWorthHistory', () => {
  it('gives net worth at each date and ends on today\'s figure', () => {
    const h = computeNetWorthHistory(accounts, txs, ['2025-12-31', '2026-02-28', '2026-03-31']);
    expect(h.map(p => p.total)).toEqual([211000, 214000, 218800]);
    expect(h[2].total).toBe(computeNetWorth(accounts, txs).total);
    expect(h[1].assets).toBe(200000);
    expect(h[2].assets).toBe(205000);
  });
});

describe('averageMonthlyContribution', () => {
  it('averages net inflow per account and ignores revaluations', () => {
    const c = averageMonthlyContribution(accounts, txs, new Date(2026, 8, 24), 12);
    expect(c.get('fund')).toBe(round2(500 / 12));
    expect(c.get('bank')).toBe(round2((3000 - 500 - 200) / 12));
    expect(c.get('home')).toBe(0); // the +5 000 value update is not money put in
  });

  it('needs a clock', () => {
    expect(() => averageMonthlyContribution(accounts, txs)).toThrow();
  });
});

describe('projectNetWorth', () => {
  const balances = new Map([['bank', 1000], ['fund', 10000], ['home', 200000]]);
  const none = new Map();

  it('compounds each account by its own rate', () => {
    const growth = new Map([['fund', 7], ['home', 1.5], ['bank', null]]);
    const p = projectNetWorth({ accounts, balances, growthPct: growth, contribution: none, years: 2 });
    expect(p[0].total).toBe(211000);
    // Monthly compounding of a yearly rate lands on the yearly rate exactly.
    expect(p[1].total).toBeCloseTo(1000 + 10000 * 1.07 + 200000 * 1.015, 2);
    expect(p[2].total).toBeCloseTo(1000 + 10000 * 1.07 ** 2 + 200000 * 1.015 ** 2, 2);
  });

  it('adds contributions and shifts only accounts that have a rate', () => {
    const growth = new Map([['fund', 5]]);
    const contrib = new Map([['bank', 100]]);
    const base = projectNetWorth({ accounts, balances, growthPct: growth, contribution: contrib, years: 1 });
    const high = projectNetWorth({ accounts, balances, growthPct: growth, contribution: contrib, years: 1, shiftPct: 2 });
    expect(base[1].total).toBeCloseTo(1000 + 1200 + 10000 * 1.05 + 200000, 2);
    expect(high[1].total - base[1].total).toBeCloseTo(10000 * 0.02, 2);
  });

  it('leaves archived accounts out', () => {
    const p = projectNetWorth({ accounts, balances: new Map(), growthPct: none, contribution: none, years: 0 });
    expect(p).toEqual([{ year: 0, total: 211000 }]);
  });

  it('adds a lump at the end of its month, after that month\'s growth', () => {
    const accts = [{ id: 'fund', type: 'investment', initialBalance: 1000 }];
    const bal = new Map([['fund', 1000]]);
    const growth = new Map([['fund', 12]]);
    const atEnd = projectNetWorth({
      accounts: accts, balances: bal, growthPct: growth, contribution: none, years: 1,
      lumps: [{ month: 12, accountId: 'fund', amount: 100 }],
    });
    expect(atEnd[1].total).toBeCloseTo(1000 * 1.12 + 100, 2);
    const atStart = projectNetWorth({
      accounts: accts, balances: bal, growthPct: growth, contribution: none, years: 1,
      lumps: [{ month: 1, accountId: 'fund', amount: 100 }],
    });
    const f = Math.pow(1.12, 1 / 12);
    expect(atStart[1].total).toBeCloseTo(1000 * 1.12 + 100 * f ** 11, 2);
  });

  it('places a lump in the year its month falls in, and ignores unknown or archived accounts', () => {
    const p = projectNetWorth({
      accounts, balances, growthPct: none, contribution: none, years: 3,
      lumps: [
        { month: 25, accountId: 'bank', amount: 500 },
        { month: 2, accountId: 'nope', amount: 999 },
        { month: 2, accountId: 'gone', amount: 999 },
      ],
    });
    expect(p.map(x => x.total)).toEqual([211000, 211000, 211000, 211500]);
  });
});

function round2(n) { return Math.round(n * 100) / 100; }
