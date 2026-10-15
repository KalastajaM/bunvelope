import { describe, it, expect } from 'vitest';
import { computeEnvelopeRunningBalances } from '../js/engine.js';
import { round2 } from '../js/utils.js';

// Regression guard for the envelope-ledger "Fill (set)" display bug.
//
// `set`-mode fill lines store an ABSOLUTE target in `line.amount`, not the
// amount actually moved into the envelope. The transactions ledger, when
// filtered to a single envelope, must show the per-row contribution so it
// reconciles with the running-balance column. For `add` fills the stored
// amount already equals that step; for `set` fills it does NOT — the real
// contribution is `target − priorBalance`.
//
// The page derives the contribution by diffing consecutive running balances
// (see envStepByTxId in js/pages/transactions.js). This test reproduces that
// derivation and asserts it yields the delta, not the raw target.
function stepByTxId(transactions, envelopeId) {
  const run = computeEnvelopeRunningBalances(transactions, envelopeId);
  const steps = new Map();
  let prev = 0;
  for (const [txId, after] of run) {
    steps.set(txId, round2(after - prev));
    prev = after;
  }
  return steps;
}

describe('Fill (set) ledger contribution', () => {
  it('shows the delta (target − prior balance), not the raw target', () => {
    const txs = [
      { id: 'add1', type: 'fill', date: '2026-07-01', status: 'posted',
        lines: [{ envelope_id: 'A', amount: 100, mode: 'add' }] },
      { id: 'set1', type: 'fill', date: '2026-07-13', status: 'posted',
        lines: [{ envelope_id: 'A', amount: 300, mode: 'set' }] },
    ];
    const steps = stepByTxId(txs, 'A');
    // add: contribution equals the stored amount.
    expect(steps.get('add1')).toBe(100);
    // set to 300 over a prior balance of 100 → only +200 actually moved, even
    // though line.amount is 300. The naive `sum(line.amount)` would show 300.
    expect(steps.get('set1')).toBe(200);
  });

  it('handles set below the current balance (negative contribution)', () => {
    const txs = [
      { id: 'add1', type: 'fill', date: '2026-07-01', status: 'posted',
        lines: [{ envelope_id: 'A', amount: 100, mode: 'add' }] },
      { id: 'set1', type: 'fill', date: '2026-07-13', status: 'posted',
        lines: [{ envelope_id: 'A', amount: 40, mode: 'set' }] },
    ];
    const steps = stepByTxId(txs, 'A');
    expect(steps.get('set1')).toBe(-60);
  });

  it('set as the first touch equals the target', () => {
    const txs = [
      { id: 'set1', type: 'fill', date: '2026-07-13', status: 'posted',
        lines: [{ envelope_id: 'A', amount: 250, mode: 'set' }] },
    ];
    const steps = stepByTxId(txs, 'A');
    expect(steps.get('set1')).toBe(250);
  });
});
