// tests/fill-line-rounding.test.js — fill lines are summed at use; a run of
// float-noisy amounts (0.1 + 0.2) must come out money-exact, not
// 0.30000000000000004. QA report 2026-06-12, triaged 2026-09-29.

import { describe, it, expect } from 'vitest';
import { txEnvelopeEffect, applyAccountEffects } from '../js/engine/balances.js';
import { txAccountDelta } from '../js/engine/tx-amounts.js';

const fill = (lines) => ({
  id: 'f1', type: 'fill', date: '2026-01-01', source: 'new_income', source_account: 'a1', lines,
});

describe('fill line sums are money-exact', () => {
  it('txEnvelopeEffect add-mode sum', () => {
    const tx = fill([
      { envelope_id: 'e1', amount: 0.1 },
      { envelope_id: 'e1', amount: 0.2 },
    ]);
    expect(txEnvelopeEffect(tx, 'e1')).toEqual({ mode: 'add', amount: 0.3 });
  });

  it('txEnvelopeEffect set-mode followed by adds', () => {
    const tx = fill([
      { envelope_id: 'e1', mode: 'set', amount: 0.1 },
      { envelope_id: 'e1', amount: 0.2 },
    ]);
    expect(txEnvelopeEffect(tx, 'e1')).toEqual({ mode: 'set', value: 0.3 });
  });

  it('applyAccountEffects debits the source account by the exact total', () => {
    const tx = fill([
      { envelope_id: 'e1', amount: 0.1 },
      { envelope_id: 'e2', amount: 0.2 },
    ]);
    const deltas = [];
    applyAccountEffects(tx, (id, d) => deltas.push([id, d]));
    expect(deltas).toEqual([['a1', -0.3]]);
  });

  it('txAccountDelta debits the source account by the exact total', () => {
    const tx = fill([
      { envelope_id: 'e1', amount: 0.1 },
      { envelope_id: 'e2', amount: 0.2 },
    ]);
    expect(txAccountDelta(tx, 'a1')).toBe(-0.3);
  });
});
