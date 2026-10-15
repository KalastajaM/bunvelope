import { describe, it, expect } from 'vitest';
import { computeRealizedSales, summarizeTaxYear } from '../js/engine/tax-lots.js';

const buy = (id, date, units, amount, over = {}) => ({
  id, type: 'investment_transfer', direction: 'buy', date, units, amount,
  from_account: 'chk', to_account: 'bro', symbol: 'ABC', ...over,
});
const sell = (id, date, units, amount, over = {}) => ({
  id, type: 'investment_transfer', direction: 'sell', date, units, amount,
  from_account: 'bro', to_account: 'chk', symbol: 'ABC', ...over,
});

describe('computeRealizedSales (FIFO)', () => {
  it('sells the oldest lot first, not the average', () => {
    const sales = computeRealizedSales([
      buy('b1', '2020-01-10', 10, 100),   // 10.00 each
      buy('b2', '2024-01-10', 10, 300),   // 30.00 each
      sell('s1', '2026-03-01', 10, 395, { fee: 5 }), // gross 400
    ]);
    expect(sales).toHaveLength(1);
    const s = sales[0];
    expect(s).toMatchObject({
      id: 's1', accountId: 'bro', symbol: 'ABC', date: '2026-03-01', units: 10,
      grossProceeds: 400, fee: 5, acquisitionCost: 100, actualGain: 295,
      uncostedUnits: 0,
    });
    // Held under ten years: deemed cost 20 % of 400.
    expect(s.deemedCost).toBe(80);
    expect(s.deemedGain).toBe(320);
    expect(s.taxableGain).toBe(295);
    expect(s.method).toBe('actual');
    expect(s.lots).toEqual([{ acquired: '2020-01-10', units: 10, cost: 100 }]);
  });

  it('splits a sale across lots and carries the remainder forward', () => {
    const sales = computeRealizedSales([
      buy('b1', '2020-01-10', 10, 100),
      buy('b2', '2024-01-10', 10, 300),
      sell('s1', '2025-01-01', 15, 450),
      sell('s2', '2026-01-01', 5, 200),
    ]);
    expect(sales[0].acquisitionCost).toBe(250); // 100 + 5 × 30
    expect(sales[0].lots).toEqual([
      { acquired: '2020-01-10', units: 10, cost: 100 },
      { acquired: '2024-01-10', units: 5, cost: 150 },
    ]);
    expect(sales[1].acquisitionCost).toBe(150);
  });

  it('uses 40 % for units held ten years or more', () => {
    const [s] = computeRealizedSales([
      buy('b1', '2010-01-01', 10, 1000),
      sell('s1', '2026-01-01', 10, 1100),
    ]);
    expect(s.deemedCost).toBe(440);
    expect(s.deemedGain).toBe(660);
    expect(s.actualGain).toBe(100);
    expect(s.method).toBe('actual');
  });

  it('chooses the deemed cost when it gives the smaller gain', () => {
    const [s] = computeRealizedSales([
      buy('b1', '2010-01-01', 10, 100),
      sell('s1', '2026-01-01', 10, 1000),
    ]);
    expect(s.actualGain).toBe(900);
    expect(s.deemedGain).toBe(600);
    expect(s.taxableGain).toBe(600);
    expect(s.method).toBe('deemed');
  });

  it('counts the ten years from the purchase date, inclusive', () => {
    const [atTen] = computeRealizedSales([buy('b', '2016-03-01', 1, 10), sell('s', '2026-03-01', 1, 100)]);
    const [justUnder] = computeRealizedSales([buy('b', '2016-03-02', 1, 10), sell('s', '2026-03-01', 1, 100)]);
    expect(atTen.deemedCost).toBe(40);
    expect(justUnder.deemedCost).toBe(20);
  });

  it('a loss stays a loss: the deemed cost cannot make one', () => {
    const [s] = computeRealizedSales([buy('b', '2024-01-01', 10, 500), sell('s', '2026-01-01', 10, 300)]);
    expect(s.actualGain).toBe(-200);
    expect(s.taxableGain).toBe(-200);
    expect(s.method).toBe('actual');
  });

  it('units sold beyond the lots on record have no actual cost; only the deemed cost applies', () => {
    const [s] = computeRealizedSales([buy('b', '2024-01-01', 5, 50), sell('s', '2026-01-01', 10, 200)]);
    expect(s.uncostedUnits).toBe(5);
    expect(s.actualGain).toBeNull();
    expect(s.deemedGain).toBe(160);
    expect(s.taxableGain).toBe(160);
    expect(s.method).toBe('deemed');
  });

  it('keeps accounts apart (FIFO is per securities account)', () => {
    const sales = computeRealizedSales([
      buy('b1', '2020-01-01', 10, 100, { to_account: 'bro' }),
      buy('b2', '2021-01-01', 10, 500, { to_account: 'ost' }),
      sell('s1', '2026-01-01', 10, 600, { from_account: 'ost' }),
    ]);
    expect(sales[0].accountId).toBe('ost');
    expect(sales[0].acquisitionCost).toBe(500);
  });

  it('a same-day sell runs after that day\'s buys', () => {
    const [s] = computeRealizedSales([
      sell('s1', '2026-01-01', 10, 150),
      buy('b1', '2026-01-01', 10, 100),
    ]);
    expect(s.acquisitionCost).toBe(100);
    expect(s.uncostedUnits).toBe(0);
  });

  it('a split (units up, cost flat) spreads the cost over more units', () => {
    const [s] = computeRealizedSales([
      buy('b1', '2020-01-01', 10, 100),
      { id: 'a', type: 'investment_transfer', direction: 'adjust', date: '2022-01-01', units: 10, amount: 0, from_account: 'bro', symbol: 'ABC' },
      sell('s1', '2026-01-01', 10, 200),
    ]);
    expect(s.acquisitionCost).toBe(50);
    expect(s.lots[0].acquired).toBe('2020-01-01');
  });

  it('leaves out excluded accounts', () => {
    const sales = computeRealizedSales([buy('b', '2020-01-01', 1, 10), sell('s', '2026-01-01', 1, 20)], { excludeAccountIds: new Set(['bro']) });
    expect(sales).toEqual([]);
  });

  it('ignores rows that are not trades', () => {
    expect(computeRealizedSales([
      { id: 'd', type: 'investment_transfer', direction: 'dividend', date: '2026-01-01', amount: 5, from_account: 'bro', to_account: 'chk', symbol: 'ABC' },
      { id: 'e', type: 'expense', date: '2026-01-01', amount: 5, account: 'chk' },
    ])).toEqual([]);
  });
});

describe('summarizeTaxYear', () => {
  const sales = computeRealizedSales([
    buy('b1', '2020-01-01', 10, 100),
    buy('b2', '2024-01-01', 10, 600),
    sell('s1', '2025-12-31', 5, 99),     // 2025
    sell('s2', '2026-02-01', 5, 300),    // 2026: cost 50; actual 250, deemed 240 → 240
    sell('s3', '2026-05-01', 5, 200),    // 2026: cost 300, loss −100
  ]);

  it('totals one calendar year', () => {
    const y = summarizeTaxYear(sales, 2026);
    expect(y.sales.map(s => s.id)).toEqual(['s2', 's3']);
    expect(y).toMatchObject({ year: 2026, grossProceeds: 500, purchaseCost: 350, gains: 240, losses: -100, net: 140 });
  });

  it('applies the €1,000 small-sales rules to selling prices and purchase prices', () => {
    const y = summarizeTaxYear(sales, 2026);
    expect(y.gainsExempt).toBe(true);        // selling prices ≤ 1,000
    expect(y.lossesDeductible).toBe(false);  // purchase prices ≤ 1,000
    const big = summarizeTaxYear(computeRealizedSales([
      buy('b', '2020-01-01', 100, 2000), sell('s', '2026-01-01', 100, 1500),
    ]), 2026);
    expect(big.gainsExempt).toBe(false);
    expect(big.lossesDeductible).toBe(true);
  });

  it('the deducted cost foots: proceeds − deductedCost = net, with a fee, a deemed and an uncosted sale', () => {
    const mixed = computeRealizedSales([
      buy('b1', '2020-01-01', 10, 100),
      buy('b2', '2024-01-01', 10, 900),
      sell('fee', '2025-03-01', 5, 291.99, { fee: 8.01 }), // a sale with an expense
      sell('act', '2025-06-01', 5, 1000),
      sell('los', '2025-07-01', 5, 400),                   // a loss
      sell('unc', '2025-09-01', 10, 600),                  // 5 units without cost → deemed
    ]);
    const y = summarizeTaxYear(mixed, 2025);
    expect(y.sales.map(s => s.method)).toContain('deemed');
    expect(y.sales.some(s => s.fee > 0)).toBe(true);
    expect(y.salesWithoutCost).toBe(1);
    expect(Math.round((y.grossProceeds - y.deductedCost) * 100) / 100).toBe(y.net);
    // purchaseCost stays the acquisition cost alone (the small-sales rule).
    expect(y.purchaseCost).toBe(Math.round(y.sales.reduce((n, s) => n + s.acquisitionCost, 0) * 100) / 100);
    expect(y.deductedCost).not.toBe(y.purchaseCost);
  });

  it('a fee sale deducts acquisition cost plus the fee', () => {
    const y = summarizeTaxYear(computeRealizedSales([
      buy('b1', '2020-01-10', 10, 100), sell('s1', '2026-03-01', 10, 395, { fee: 5 }),
    ]), 2026);
    expect(y).toMatchObject({ grossProceeds: 400, purchaseCost: 100, deductedCost: 105, net: 295 });
  });

  it('a deemed sale deducts the deemed cost', () => {
    const y = summarizeTaxYear(computeRealizedSales([
      buy('b1', '2020-01-10', 10, 50), sell('s1', '2026-03-01', 10, 400),
    ]), 2026);
    expect(y.sales[0].method).toBe('deemed');
    expect(y).toMatchObject({ grossProceeds: 400, purchaseCost: 50, deductedCost: 80, net: 320 });
  });

  it('lists the years that have sales, newest first', () => {
    expect(summarizeTaxYear(sales, 2026).years).toEqual([2026, 2025]);
  });
});

describe('computeRealizedSales with manual rows', () => {
  it('lots a manual buy and sells it FIFO like a real one', () => {
    const [s] = computeRealizedSales([sell('s', '2026-01-01', 5, 100)], {
      manualRows: { bro: { ABC: [{ id: 'm1', date: '2019-06-01', direction: 'buy', units: 5, amount: 40 }] } },
    });
    expect(s.acquisitionCost).toBe(40);
    expect(s.lots).toEqual([{ acquired: '2019-06-01', units: 5, cost: 40 }]);
  });
});
