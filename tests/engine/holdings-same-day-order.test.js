// QA 2026-09-23 #1 — same-day buy and sell were processed in array order.
//
// `computeHoldings` date-sorts, but a same-date tie fell back to array order,
// so a sell recorded before that day's buy ran against an empty position: it
// removed nothing, booked no realized P/L, and the buy then left the units
// open forever. Array order is entry order, not trade order, so the same two
// trades gave two different positions depending on which was typed first.

import { describe, it, expect } from 'vitest';
import { computeHoldings } from '../../js/engine.js';

const row = (direction, units, amount, date = '2026-03-10', id = `${direction}-${date}`) => ({
  id, type: 'investment_transfer', direction, date, symbol: 'ACME', units, amount,
  ...(direction === 'buy'
    ? { from_account: 'cash', to_account: 'broker' }
    : { from_account: 'broker', to_account: 'cash' }),
});

const holding = txs => computeHoldings(txs).get('broker')?.get('ACME');

describe('computeHoldings same-day ordering', () => {
  it('processes a same-day buy before a sell listed ahead of it', () => {
    const sellFirst = holding([row('sell', 10, 1100), row('buy', 10, 1000)]);
    expect(sellFirst.units).toBe(0);
    expect(sellFirst.realized).toBe(100);
    expect(sellFirst.oversoldUnits).toBe(0);
  });

  it('gives the same position whichever order the rows were entered in', () => {
    const a = holding([row('sell', 10, 1100), row('buy', 10, 1000)]);
    const b = holding([row('buy', 10, 1000), row('sell', 10, 1100)]);
    expect(a).toEqual(b);
  });

  it('still orders by date first — a later-dated buy does not fund an earlier sell', () => {
    const h = holding([row('buy', 10, 1000, '2026-03-11'), row('sell', 10, 1100, '2026-03-10')]);
    expect(h.oversoldUnits).toBe(10);
    expect(h.units).toBe(10);
  });

  it('keeps array order among same-day sells (stable otherwise)', () => {
    // Two sells at different prices on one day after a two-lot buy: average
    // cost makes the realized total order-independent, but the tie-break
    // must not reorder them relative to each other.
    const txs = [
      row('buy', 20, 2000, '2026-03-01'),
      row('sell', 5, 600, '2026-03-10', 's1'),
      row('sell', 5, 400, '2026-03-10', 's2'),
    ];
    const h = holding(txs);
    expect(h.units).toBe(10);
    expect(h.realized).toBe(0);
  });
});
