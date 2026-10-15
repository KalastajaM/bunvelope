import { describe, it, expect } from 'vitest';
import { fillLineForRow } from '../js/pages/fill-line.js';
import { computeEnvelopeBalances } from '../js/engine.js';

// Regression guard for the "Set ignores future transactions" bug.
//
// The Fill sheet's `curBal` is the PROJECTED balance (future-dated rows
// included). "Set to X" must make that projected balance become exactly X.
// The old code stored an absolute `set` line, which the engine applied at
// today's date slot only to have future-dated rows re-apply on top — netting
// zero change. `fillLineForRow` now emits an `add` line of the delta, which is
// order-independent, so the projected balance always lands on the target.

describe('fillLineForRow — set mode with a future transaction', () => {
  // Reproduces the reported scenario: a posted +250 today and a future-dated
  // −310,24 expense give a projected (future-inclusive) balance of −60,24 and
  // an as-of-today balance of +250.
  const ENV = 'mathildedal';
  function scenarioTxs(extra = []) {
    return [
      // Today: +250 already in the envelope (posted).
      { id: 'seed', type: 'income', date: '2026-07-01', status: 'posted',
        envelope_id: ENV, amount: 250 },
      // Future: −310,24 expense not yet cleared.
      { id: 'future', type: 'expense', date: '2026-08-20', status: 'posted',
        envelope_id: ENV, amount: 310.24 },
      ...extra,
    ];
  }

  it('projected balance before the fill is the reported −60,24', () => {
    const bal = computeEnvelopeBalances(scenarioTxs()).get(ENV);
    expect(round(bal)).toBe(-60.24);
  });

  it('set 250 emits an add-delta that lands the projected balance on 250', () => {
    const curBal = computeEnvelopeBalances(scenarioTxs()).get(ENV); // −60,24
    const line = fillLineForRow({ envelopeId: ENV, mode: 'set', value: 250, curBal });
    // The realized amount matches the delta the sheet displays.
    expect(line).toEqual({ envelope_id: ENV, amount: 310.24, mode: 'add' });

    const fill = { id: 'fill1', type: 'fill', date: '2026-07-15', status: 'posted',
      lines: [line] };
    const projected = computeEnvelopeBalances(scenarioTxs([fill])).get(ENV);
    expect(round(projected)).toBe(250);
  });

  it('set below the current balance yields a negative add-delta', () => {
    const curBal = computeEnvelopeBalances(scenarioTxs()).get(ENV); // −60,24
    const line = fillLineForRow({ envelopeId: ENV, mode: 'set', value: -100, curBal });
    expect(line.mode).toBe('add');
    expect(round(line.amount)).toBe(-39.76); // −100 − (−60,24)

    const fill = { id: 'fill1', type: 'fill', date: '2026-07-15', status: 'posted',
      lines: [line] };
    const projected = computeEnvelopeBalances(scenarioTxs([fill])).get(ENV);
    expect(round(projected)).toBe(-100);
  });
});

describe('fillLineForRow — no future activity', () => {
  it('set target over a plain prior balance equals target − prior', () => {
    const line = fillLineForRow({ envelopeId: 'A', mode: 'set', value: 300, curBal: 100 });
    expect(line).toEqual({ envelope_id: 'A', amount: 200, mode: 'add' });
  });

  it('add mode passes the value straight through', () => {
    const line = fillLineForRow({ envelopeId: 'A', mode: 'add', value: 75, curBal: 100 });
    expect(line).toEqual({ envelope_id: 'A', amount: 75, mode: 'add' });
  });

  it('no-op rows return null', () => {
    expect(fillLineForRow({ envelopeId: 'A', mode: 'set', value: 100, curBal: 100 })).toBeNull();
    expect(fillLineForRow({ envelopeId: 'A', mode: 'add', value: 0, curBal: 50 })).toBeNull();
    expect(fillLineForRow({ envelopeId: 'A', mode: 'add', value: NaN, curBal: 50 })).toBeNull();
  });
});

function round(n) { return Math.round(n * 100) / 100; }
