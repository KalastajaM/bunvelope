// Selling more units than the ledger recorded buying used to book the FULL
// cash proceeds against only the cost that could be removed, reporting every
// unaccounted unit as pure profit. The usual cause is benign — a position
// transferred in from another broker whose original buy was never entered —
// which is exactly why it stayed invisible: the position looks plausible and
// only the realized figure is wrong.

import { describe, it, expect } from 'vitest';
import { computeHoldings } from '../../js/engine.js';

const buy = (units, amount, date = '2026-01-05') => ({
  id: `b-${date}-${units}`, type: 'investment_transfer', direction: 'buy',
  date, symbol: 'ACME', units, amount,
  from_account: 'cash', to_account: 'broker',
});
const sell = (units, amount, date = '2026-06-05') => ({
  id: `s-${date}-${units}`, type: 'investment_transfer', direction: 'sell',
  date, symbol: 'ACME', units, amount,
  from_account: 'broker', to_account: 'cash',
});

const acme = txs => computeHoldings(txs).get('broker').get('ACME');

describe('computeHoldings oversell', () => {
  it('books a normal partial sell exactly as before', () => {
    // Buy 100 @ 10 = 1000. Sell 40 for 500; cost removed 400 → realized 100.
    const h = acme([buy(100, 1000), sell(40, 500)]);
    expect(h.units).toBe(60);
    expect(h.costBasis).toBe(600);
    expect(h.realized).toBe(100);
    expect(h.oversoldUnits).toBe(0);
  });

  it('books a full exit exactly as before', () => {
    const h = acme([buy(100, 1000), sell(100, 1200)]);
    expect(h.units).toBe(0);
    expect(h.costBasis).toBe(0);
    expect(h.realized).toBe(200);
    expect(h.oversoldUnits).toBe(0);
  });

  it('only books P/L on the units it can cost when oversold', () => {
    // Hold 50 @ 10 = 500. Sell 100 for 1000 — half the units have no cost here.
    // Accountable proceeds = 1000 × 50/100 = 500, cost removed 500 → realized 0.
    // Regression: realized was 1000 − 500 = 500, i.e. pure invented profit.
    const h = acme([buy(50, 500), sell(100, 1000)]);
    expect(h.realized).toBe(0);
    expect(h.units).toBe(0);
    expect(h.costBasis).toBe(0);
  });

  it('records how many units were sold beyond the record', () => {
    const h = acme([buy(50, 500), sell(100, 1000)]);
    expect(h.oversoldUnits).toBe(50);
  });

  it('still books a real gain on the accountable part', () => {
    // Hold 50 @ 10 = 500. Sell 100 for 1600 → accountable proceeds 800,
    // cost 500 → realized 300, and 50 units flagged as unaccounted.
    const h = acme([buy(50, 500), sell(100, 1600)]);
    expect(h.realized).toBe(300);
    expect(h.oversoldUnits).toBe(50);
  });

  it('books nothing and flags everything when no buy was ever recorded', () => {
    const h = acme([sell(30, 450)]);
    expect(h.realized).toBe(0);
    expect(h.oversoldUnits).toBe(30);
    expect(h.units).toBe(0);
  });

  it('accumulates oversold units across several bad sells', () => {
    const h = acme([buy(10, 100), sell(30, 300, '2026-06-05'), sell(5, 50, '2026-07-05')]);
    expect(h.oversoldUnits).toBe(25);
  });
});
