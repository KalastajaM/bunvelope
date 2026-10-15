// computeSpentThisMonthByEnvelope — the "X of Y spent" figure on the envelope
// card. It is the operand the card needs for its "short" line to be checkable:
// the forecast charges plan − this-month spend as still to come, so the card's
// spent figure has to be exactly what was SPENT, never fills or reallocations.
import { describe, it, expect } from 'vitest';
import { computeSpentThisMonthByEnvelope } from '../../js/engine.js';

const TODAY = new Date(2026, 8, 24); // 24 Sep 2026, local

describe('computeSpentThisMonthByEnvelope', () => {
  it('sums this month\'s spend per envelope, splits included', () => {
    const txs = [
      { id: 'a', type: 'expense', date: '2026-09-03', envelope_id: 'groceries', amount: 47.41 },
      { id: 'b', type: 'expense', date: '2026-09-14', amount: 43.38,
        envelope_splits: [
          { envelope_id: 'groceries', amount: 39.79 },
          { envelope_id: 'other', amount: 3.59 },
        ] },
    ];
    const out = computeSpentThisMonthByEnvelope(txs, TODAY);
    expect(out.get('groceries')).toBe(87.2);
    expect(out.get('other')).toBe(3.59);
  });

  it('does not count fills, reallocations or adjustments as spending', () => {
    // The Groceries case that prompted this: 800 filled, 175.38 moved out by
    // "Set" fills, 224.62 actually spent. Only the last is spending.
    const txs = [
      { id: 'f1', type: 'fill', date: '2026-09-01',
        lines: [{ envelope_id: 'groceries', amount: 400, mode: 'add' }] },
      { id: 'f2', type: 'fill', date: '2026-09-15',
        lines: [{ envelope_id: 'groceries', amount: -113.59, mode: 'add' }] },
      { id: 'adj', type: 'adjustment', date: '2026-09-02', target: 'envelope',
        target_id: 'groceries', amount: -20 },
      { id: 'e', type: 'expense', date: '2026-09-10', envelope_id: 'groceries', amount: 224.62 },
    ];
    expect(computeSpentThisMonthByEnvelope(txs, TODAY).get('groceries')).toBe(224.62);
  });

  it('skips other months, future-dated rows and scheduled rows', () => {
    const txs = [
      { id: 'prev', type: 'expense', date: '2026-08-31', envelope_id: 'g', amount: 10 },
      { id: 'next', type: 'expense', date: '2026-10-01', envelope_id: 'g', amount: 10 },
      { id: 'later', type: 'expense', date: '2026-09-25', envelope_id: 'g', amount: 10 },
      { id: 'sched', type: 'expense', date: '2026-09-20', envelope_id: 'g', amount: 10,
        status: 'scheduled' },
      { id: 'today', type: 'expense', date: '2026-09-24T10:00:00', envelope_id: 'g', amount: 5 },
    ];
    const out = computeSpentThisMonthByEnvelope(txs, TODAY);
    expect(out.get('g')).toBe(5);
  });

  it('drops the unenveloped sentinel and envelopes with no spend', () => {
    const txs = [
      { id: 'n', type: 'expense', date: '2026-09-05', envelope_id: '__none__', amount: 30 },
    ];
    expect(computeSpentThisMonthByEnvelope(txs, TODAY).size).toBe(0);
  });

  it('refuses to run without a clock', () => {
    // @ts-expect-error — deliberately missing
    expect(() => computeSpentThisMonthByEnvelope([], undefined)).toThrow(TypeError);
  });
});
