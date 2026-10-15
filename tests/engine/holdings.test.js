import { describe, it, expect, beforeEach } from 'vitest';
import { computeHoldings, listHoldings, txSymbol, txAccountDelta } from '../../js/engine.js';
import { _holdingsStats, _resetHoldingsStats } from '../../js/engine/balance-cache.js';

const buy = (date, units, price, fee = 0, symbol = 'AAPL', acct = 'inv', from = 'cash') => ({
  id: `b-${date}-${symbol}-${units}`,
  type: 'investment_transfer',
  direction: 'buy',
  date,
  amount: units * price + fee,
  units,
  pricePerUnit: price,
  fee: fee || undefined,
  symbol,
  from_account: from,
  to_account: acct,
});
const sell = (date, units, price, fee = 0, symbol = 'AAPL', acct = 'inv', to = 'cash') => ({
  id: `s-${date}-${symbol}-${units}`,
  type: 'investment_transfer',
  direction: 'sell',
  date,
  amount: units * price - fee,
  units,
  pricePerUnit: price,
  fee: fee || undefined,
  symbol,
  from_account: acct,
  to_account: to,
});

describe('txSymbol', () => {
  it('normalises whitespace and case', () => {
    expect(txSymbol({ symbol: ' aapl ' })).toBe('AAPL');
  });
  it('returns null for missing/blank', () => {
    expect(txSymbol({ symbol: '' })).toBe(null);
    expect(txSymbol({})).toBe(null);
    expect(txSymbol(null)).toBe(null);
  });
});

describe('computeHoldings', () => {
  it('aggregates buys into units + cost basis', () => {
    const txs = [buy('2024-01-10', 10, 100), buy('2024-02-05', 5, 110)];
    const out = computeHoldings(txs);
    const h = out.get('inv').get('AAPL');
    expect(h.units).toBe(15);
    expect(h.costBasis).toBe(1550); // 10*100 + 5*110
    expect(h.realized).toBe(0);
  });

  it('uses average cost on partial sells', () => {
    const txs = [
      buy('2024-01-10', 10, 100),   // cost basis 1000, avg 100
      buy('2024-02-05', 10, 200),   // cost basis 3000, avg 150
      sell('2024-03-01', 5, 220),   // proceeds 1100, cost removed 750, realized 350
    ];
    const h = computeHoldings(txs).get('inv').get('AAPL');
    expect(h.units).toBe(15);
    expect(h.costBasis).toBe(2250); // 3000 − 750
    expect(h.realized).toBe(350);
  });

  it('zeroes out a fully-sold holding', () => {
    const txs = [buy('2024-01-10', 10, 100), sell('2024-04-01', 10, 130)];
    const h = computeHoldings(txs).get('inv').get('AAPL');
    expect(h.units).toBe(0);
    expect(h.costBasis).toBe(0);
    expect(h.realized).toBe(300); // 1300 − 1000
  });

  it('skips rows without symbol, and zero-cash zero-unit rows', () => {
    const txs = [
      { ...buy('2024-01-10', 10, 100), symbol: undefined },
      { ...buy('2024-02-10', 0, 0), symbol: 'AAPL', amount: 0 }, // no units, no cash
    ];
    const out = computeHoldings(txs);
    expect(out.size).toBe(0);
  });

  it('buys with cash but no units still count toward cost basis', () => {
    // E.g. fund subscriptions where the broker statement only records the
    // amount invested, not the unit count.
    const txs = [
      { ...buy('2024-01-10', 0, 0), symbol: 'FUND', amount: 100 },
      { ...buy('2024-02-10', 0, 0), symbol: 'FUND', amount: 50 },
    ];
    const h = computeHoldings(txs).get('inv').get('FUND');
    expect(h.units).toBe(0);
    expect(h.costBasis).toBe(150);
  });

  it('sells without units are skipped (we cannot reduce position correctly)', () => {
    const txs = [
      buy('2024-01-10', 10, 100),
      { ...sell('2024-02-01', 0, 0), symbol: 'AAPL', amount: 200 },
    ];
    const h = computeHoldings(txs).get('inv').get('AAPL');
    expect(h.units).toBe(10);
    expect(h.costBasis).toBe(1000);
    expect(h.realized).toBe(0);
  });

  it('keeps buckets separate per (account, symbol)', () => {
    const txs = [
      buy('2024-01-10', 10, 100, 0, 'AAPL', 'inv1'),
      buy('2024-02-05', 3, 200, 0, 'MSFT', 'inv1'),
      buy('2024-03-01', 1, 50,  0, 'AAPL', 'inv2'),
    ];
    const out = computeHoldings(txs);
    expect(out.get('inv1').get('AAPL').units).toBe(10);
    expect(out.get('inv1').get('MSFT').units).toBe(3);
    expect(out.get('inv2').get('AAPL').units).toBe(1);
  });

  it('processes rows in date order regardless of input order', () => {
    const txs = [
      sell('2024-03-01', 5, 220),
      buy('2024-01-10', 10, 100),
      buy('2024-02-05', 10, 200),
    ];
    const h = computeHoldings(txs).get('inv').get('AAPL');
    expect(h.units).toBe(15);
    expect(h.realized).toBe(350);
  });
});

describe('listHoldings + overrides', () => {
  it('uses computed units/costBasis when transactions exist (override does not mask them)', () => {
    const txs = [buy('2024-01-10', 10, 100)];
    const overrides = { inv: { AAPL: { units: 12, costBasis: 1200, name: 'Apple' } } };
    const rows = listHoldings(txs, overrides);
    expect(rows).toHaveLength(1);
    const r = rows[0];
    expect(r.units).toBe(10);
    expect(r.costBasis).toBe(1000);
    // The override's name still surfaces as a display label.
    expect(r.name).toBe('Apple');
    expect(r.overridden).toBe(false);
    expect(r.realized).toBe(0);
  });

  it('surfaces overrides that have no transaction history (watchlist case)', () => {
    const overrides = { inv: { TSLA: { units: 4, costBasis: 800 } } };
    const rows = listHoldings([], overrides);
    expect(rows).toHaveLength(1);
    expect(rows[0].symbol).toBe('TSLA');
    expect(rows[0].overridden).toBe(true);
  });
});

describe('listHoldings with manual rows', () => {
  it('synthesises manual buy rows alongside real txs', () => {
    const txs = [buy('2024-01-10', 10, 100)]; // 10 units, basis 1000
    const manual = {
      inv: {
        AAPL: [{ id: 'm-1', date: '2024-02-01', direction: 'buy', units: 5, amount: 600 }],
      },
    };
    const rows = listHoldings(txs, {}, manual);
    expect(rows).toHaveLength(1);
    expect(rows[0].units).toBe(15);
    expect(rows[0].costBasis).toBe(1600);
  });

  it('manual sells reduce units and accrue realized', () => {
    const txs = [buy('2024-01-10', 10, 100)];
    const manual = {
      inv: {
        AAPL: [{ id: 'm-1', date: '2024-02-01', direction: 'sell', units: 4, amount: 500 }],
      },
    };
    const rows = listHoldings(txs, {}, manual);
    expect(rows[0].units).toBe(6);
    expect(rows[0].costBasis).toBe(600); // 10*100 - 4*100
    expect(rows[0].realized).toBe(100); // 500 - 4*100
  });

  it('override does not mask computed values when transactions exist', () => {
    const txs = [buy('2024-01-10', 10, 100)];
    const manual = { inv: { AAPL: [{ id: 'm-1', date: '2024-02-01', direction: 'buy', units: 5, amount: 600 }] } };
    const overrides = { inv: { AAPL: { units: 99, costBasis: 9999 } } };
    const rows = listHoldings(txs, overrides, manual);
    expect(rows[0].units).toBe(15);
    expect(rows[0].costBasis).toBe(1600);
    expect(rows[0].overridden).toBe(false);
  });

  it('manual rows for an account/symbol with no txs surface as a holding', () => {
    const manual = {
      inv: { ZZZ: [{ id: 'm-1', date: '2024-04-01', direction: 'buy', units: 3, amount: 60 }] },
    };
    const rows = listHoldings([], {}, manual);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ accountId: 'inv', symbol: 'ZZZ', units: 3, costBasis: 60 });
  });
});

const dividend = (date, amount, symbol = 'AAPL', acct = 'inv', to = 'cash') => ({
  id: `d-${date}-${symbol}-${amount}`,
  type: 'investment_transfer',
  direction: 'dividend',
  date,
  amount,
  symbol,
  from_account: acct,
  to_account: to,
});

describe('dividend direction', () => {
  it('credits the cash account but does not move the investment account', () => {
    const tx = dividend('2024-04-15', 25);
    expect(txAccountDelta(tx, 'cash')).toBe(25);
    expect(txAccountDelta(tx, 'inv')).toBe(0);
    expect(txAccountDelta(tx, 'other')).toBe(0);
  });

  it('does not change units, cost basis, or realised P/L', () => {
    const txs = [
      buy('2024-01-10', 10, 100), // 10 units, basis 1000
      dividend('2024-04-15', 25),
    ];
    const h = computeHoldings(txs).get('inv').get('AAPL');
    expect(h.units).toBe(10);
    expect(h.costBasis).toBe(1000);
    expect(h.realized).toBe(0);
    expect(h.distributions).toBe(25);
  });

  it('accumulates distributions across multiple dividends', () => {
    const txs = [
      buy('2024-01-10', 10, 100),
      dividend('2024-04-15', 25),
      dividend('2024-07-15', 30.50),
      dividend('2024-10-15', 28),
    ];
    const h = computeHoldings(txs).get('inv').get('AAPL');
    expect(h.distributions).toBe(83.50);
    expect(h.units).toBe(10);
    expect(h.costBasis).toBe(1000);
  });

  it('skips dividend rows with non-positive cash', () => {
    const txs = [
      buy('2024-01-10', 10, 100),
      { ...dividend('2024-04-15', 0), amount: 0 },
    ];
    const h = computeHoldings(txs).get('inv').get('AAPL');
    expect(h.distributions).toBe(0);
  });

  it('listHoldings exposes distributions on each row', () => {
    const txs = [buy('2024-01-10', 10, 100), dividend('2024-04-15', 25)];
    const rows = listHoldings(txs);
    expect(rows).toHaveLength(1);
    expect(rows[0].distributions).toBe(25);
  });

  it('override-only rows have zero distributions', () => {
    const overrides = { inv: { TSLA: { units: 4, costBasis: 800 } } };
    const rows = listHoldings([], overrides);
    expect(rows[0].distributions).toBe(0);
  });

  it('a dividend without a symbol is skipped (cannot be tied to a holding)', () => {
    const txs = [
      buy('2024-01-10', 10, 100),
      { ...dividend('2024-04-15', 25), symbol: undefined },
    ];
    const h = computeHoldings(txs).get('inv').get('AAPL');
    expect(h.distributions).toBe(0);
  });
});

describe('manual adjust rows', () => {
  it('apply signed unit and cost deltas without touching realised P/L', () => {
    const txs = [buy('2024-01-10', 10, 100)]; // 10 units, basis 1000
    // 2-for-1 split: units +10, costBasis flat. Then a NAV-deducted fee:
    // costBasis -25, units flat.
    const manual = {
      inv: {
        AAPL: [
          { id: 'm-split', date: '2024-03-15', direction: 'adjust', units: 10, amount: 0 },
          { id: 'm-fee',   date: '2024-06-30', direction: 'adjust', units: 0, amount: -25 },
        ],
      },
    };
    const rows = listHoldings(txs, {}, manual);
    expect(rows).toHaveLength(1);
    expect(rows[0].units).toBe(20);
    expect(rows[0].costBasis).toBe(975);
    expect(rows[0].realized).toBe(0);
  });

  it('adjust rows with no symbol bucket are created on the fly (watchlist case)', () => {
    const manual = {
      inv: {
        ZZZ: [{ id: 'm', date: '2024-04-01', direction: 'adjust', units: 5, amount: 100 }],
      },
    };
    const rows = listHoldings([], {}, manual);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ accountId: 'inv', symbol: 'ZZZ', units: 5, costBasis: 100 });
    expect(rows[0].realized).toBe(0);
  });

  it('zero-delta adjust rows are skipped', () => {
    const txs = [buy('2024-01-10', 10, 100)];
    const manual = {
      inv: {
        AAPL: [{ id: 'm', date: '2024-02-01', direction: 'adjust', units: 0, amount: 0 }],
      },
    };
    const rows = listHoldings(txs, {}, manual);
    expect(rows[0].units).toBe(10);
    expect(rows[0].costBasis).toBe(1000);
  });

  it('adjust does not change realised P/L on a partially-sold holding', () => {
    const txs = [
      buy('2024-01-10', 10, 100),    // 10 units, basis 1000
      sell('2024-03-01', 4, 150),    // 4 units sold @ 150 → realised 200
    ];
    const manual = {
      inv: { AAPL: [{ id: 'm', date: '2024-04-01', direction: 'adjust', units: 0, amount: -10 }] },
    };
    const rows = listHoldings(txs, {}, manual);
    expect(rows[0].realized).toBe(200);
    expect(rows[0].costBasis).toBe(590); // 1000 − 4*100 (avg) − 10 fee
  });
});

describe('listHoldings memoization', () => {
  beforeEach(() => _resetHoldingsStats());

  it('returns the same reference for the same (txs, overrides, manualRows)', () => {
    const txs = [buy('2024-01-10', 10, 100)];
    const overrides = { inv: { TSLA: { units: 1, costBasis: 200 } } };
    const manual = { inv: { AAPL: [{ id: 'm', date: '2024-02-01', direction: 'buy', units: 1, amount: 110 }] } };
    const a = listHoldings(txs, overrides, manual);
    const b = listHoldings(txs, overrides, manual);
    expect(b).toBe(a);
    expect(_holdingsStats.hits).toBe(1);
    expect(_holdingsStats.misses).toBe(1);
  });

  it('treats nullish overrides/manualRows as the same stable empty key', () => {
    const txs = [buy('2024-01-10', 10, 100)];
    const a = listHoldings(txs);
    const b = listHoldings(txs, undefined, undefined);
    const c = listHoldings(txs, null, null);
    expect(b).toBe(a);
    expect(c).toBe(a);
    expect(_holdingsStats.hits).toBe(2);
    expect(_holdingsStats.misses).toBe(1);
  });

  it('busts the cache when transactions array identity changes', () => {
    const txs1 = [buy('2024-01-10', 10, 100)];
    const txs2 = [...txs1];
    const a = listHoldings(txs1);
    const b = listHoldings(txs2);
    expect(b).not.toBe(a);
    expect(_holdingsStats.misses).toBe(2);
  });

  it('busts the cache when overrides identity changes', () => {
    const txs = [buy('2024-01-10', 10, 100)];
    const a = listHoldings(txs, { inv: { AAPL: { units: 11, costBasis: 1100 } } });
    const b = listHoldings(txs, { inv: { AAPL: { units: 11, costBasis: 1100 } } });
    // Different object identity even though contents match — different cache entry.
    expect(b).not.toBe(a);
    expect(_holdingsStats.misses).toBe(2);
  });
});
