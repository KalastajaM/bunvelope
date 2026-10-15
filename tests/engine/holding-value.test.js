import { describe, it, expect } from 'vitest';
import {
  holdingPrice,
  holdingValue,
  summarizeHoldings,
  portfolioValueByAccount,
} from '../../js/engine.js';

const h = (symbol, units, costBasis, accountId = 'inv') => ({ accountId, symbol, units, costBasis });

describe('holdingPrice', () => {
  it('returns the stored price when finite', () => {
    expect(holdingPrice(h('AAPL', 10, 1000), { AAPL: { price: 150 } })).toBe(150);
  });

  it('treats a missing, null or non-finite price as absent — not as zero', () => {
    const held = h('AAPL', 10, 1000);
    expect(holdingPrice(held, {})).toBe(null);
    expect(holdingPrice(held, { AAPL: {} })).toBe(null);
    expect(holdingPrice(held, { AAPL: { price: null } })).toBe(null);
    expect(holdingPrice(held, { AAPL: { price: NaN } })).toBe(null);
    expect(holdingPrice(held, { AAPL: { price: Infinity } })).toBe(null);
  });

  it('survives a missing prices map or holding', () => {
    expect(holdingPrice(h('AAPL', 1, 1), undefined)).toBe(null);
    expect(holdingPrice(undefined, { AAPL: { price: 1 } })).toBe(null);
  });

  it('does not resolve a price of 0 to the fallback — free is a real price', () => {
    expect(holdingPrice(h('X', 5, 100), { X: { price: 0 } })).toBe(0);
    expect(holdingValue(h('X', 5, 100), { X: { price: 0 } })).toBe(0);
  });
});

describe('holdingValue', () => {
  it('is units × price when a price is known', () => {
    expect(holdingValue(h('AAPL', 10, 1000), { AAPL: { price: 150 } })).toBe(1500);
  });

  it('falls back to cost basis when no price is known', () => {
    expect(holdingValue(h('FUND', 3, 900), {})).toBe(900);
  });
});

describe('summarizeHoldings', () => {
  const prices = { A: { price: 20 }, B: { price: 5 } };
  // A: 10 units cost 100 → worth 200. B: 10 units cost 100 → worth 50.
  // C: unpriced, cost 400.
  const rows = [h('A', 10, 100), h('B', 10, 100), h('C', 4, 400)];

  it('separates total cost from the cost that could be valued', () => {
    const s = summarizeHoldings(rows, prices);
    expect(s.cost).toBe(600);
    expect(s.costPriced).toBe(200);
    expect(s.valuePriced).toBe(250);
  });

  it('values the portfolio with the cost-basis fallback, so nothing disappears', () => {
    expect(summarizeHoldings(rows, prices).value).toBe(650);
  });

  it('reports the gain on what could be valued, either way it is derived', () => {
    const s = summarizeHoldings(rows, prices);
    expect(s.unrealized).toBe(50);
    // The dashboard derived the same figure as `value − cost`; the identity
    // is what let two surfaces agree on the amount while disagreeing on the
    // percentage.
    expect(s.value - s.cost).toBeCloseTo(s.unrealized, 10);
  });

  it('divides the gain by priced cost, not by cost that never had a price', () => {
    const s = summarizeHoldings(rows, prices);
    expect(s.unrealizedPct).toBeCloseTo(25, 10); // 50 / 200
    // The old dashboard denominator was total cost — 50/600 ≈ 8.3%, which
    // reports a smaller gain the more unpriced holdings you own.
    expect(s.unrealizedPct).not.toBeCloseTo((50 / 600) * 100, 5);
  });

  it('counts only open positions when reporting priced / missing', () => {
    const closed = h('D', 0, 0);
    const s = summarizeHoldings([...rows, closed], prices);
    expect(s.priced).toBe(2);
    expect(s.missingPrice).toBe(1); // C only — D holds nothing
  });

  it('has no percentage to report when nothing is priced', () => {
    const s = summarizeHoldings([h('C', 4, 400)], {});
    expect(s.unrealized).toBe(0);
    expect(s.unrealizedPct).toBe(0);
    expect(s.value).toBe(400);
  });

  it('handles an empty or missing list', () => {
    expect(summarizeHoldings([], {}).value).toBe(0);
    expect(summarizeHoldings(undefined, {}).cost).toBe(0);
  });
});

describe('portfolioValueByAccount', () => {
  const prices = { A: { price: 20 }, B: { price: 5 } };

  it('sums market value per account', () => {
    const map = portfolioValueByAccount(
      [h('A', 10, 100, 'inv1'), h('B', 10, 100, 'inv1'), h('A', 1, 10, 'inv2')],
      prices,
    );
    expect(map.get('inv1')).toBe(250);
    expect(map.get('inv2')).toBe(20);
  });

  it('seeds tracked accounts at zero so an empty portfolio still reports one', () => {
    const map = portfolioValueByAccount([], prices, ['inv1', 'inv2']);
    expect(map.get('inv1')).toBe(0);
    expect(map.get('inv2')).toBe(0);
  });

  it('does not let a seed overwrite a real value', () => {
    const map = portfolioValueByAccount([h('A', 2, 10, 'inv1')], prices, ['inv1']);
    expect(map.get('inv1')).toBe(40);
  });
});

// QA 2026-09-23 #2 — a buy recorded without units ("I put €100 into X") is a
// legitimate row (add-tx.js §1.2 note) and aggregates to a holding with cost
// basis but zero units. Once its symbol had a price it was valued at
// 0 × price: worth nothing, a −100% unrealized P/L on the dashboard.
describe('unit-less holdings with a price', () => {
  const unitless = h('FUND', 0, 100);
  const prices = { FUND: { price: 12.5 } };

  it('holdingValue falls back to cost basis when there are no units to price', () => {
    expect(holdingValue(unitless, prices)).toBe(100);
    expect(holdingValue({ ...unitless, units: undefined }, prices)).toBe(100);
  });

  it('summarizeHoldings reports no gain or loss on a position it cannot value', () => {
    const s = summarizeHoldings([unitless], prices);
    expect(s.value).toBe(100);
    expect(s.unrealized).toBe(0);
    expect(s.unrealizedPct).toBe(0);
    expect(s.priced).toBe(0);
  });

  it('does not dilute the gain on the holdings that can be valued', () => {
    const s = summarizeHoldings([h('A', 10, 100), unitless], { ...prices, A: { price: 11 } });
    expect(s.value).toBe(210);
    expect(s.unrealized).toBe(10);
    expect(s.unrealizedPct).toBeCloseTo(10, 9);
  });

  it('portfolioValueByAccount keeps the unit-less position at cost', () => {
    expect(portfolioValueByAccount([unitless], prices).get('inv')).toBe(100);
  });

  it('a closed position (no units, no cost) is still worth zero', () => {
    expect(holdingValue(h('FUND', 0, 0), prices)).toBe(0);
  });
});


describe('value-only holdings', () => {
  it('keeps market value and missing-price counts but excludes costs and gains', () => {
    const rows = [h('FUND', 2, 100), { ...h('RING', 10, 0), valuationOnly: true },
      { ...h('UNPRICED', 1, 50), valuationOnly: true }];
    expect(summarizeHoldings(rows, { FUND: { price: 60 }, RING: { price: 20 } })).toMatchObject({
      cost: 100, costPriced: 100, value: 320, valuePriced: 320,
      unrealized: 20, unrealizedPct: 20, priced: 2, missingPrice: 1,
    });
  });
});
