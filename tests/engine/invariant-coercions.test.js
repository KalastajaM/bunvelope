// §1.4 — round2 maps a non-finite number to 0 rather than throwing. That
// coercion stays (thirteen engine modules call round2 on the paint path, and
// a throw turns a wrong number into a blank screen) — what was missing is any
// way for the owner to find out it happened.
import { describe, it, expect } from 'vitest';
import { runInvariantCheck, validateAmountCoercion } from '../../js/engine/insights.js';
import { round2 } from '../../js/utils.js';

const ok = over => ({
  id: 't1', type: 'expense', date: '2026-08-06',
  account: 'cash', envelope_id: 'food', amount: 10, ...over,
});
const state = txs => ({
  accounts: [{ id: 'cash', name: 'Cash' }],
  envelopes: [{ id: 'food', name: 'Food' }, { id: 'rent', name: 'Rent' }],
  transactions: txs,
});

describe('non-finite money is reported, not just coerced', () => {
  it('round2 still coerces rather than throwing', () => {
    // The defence is the report, not a throw — pin the behaviour that must
    // NOT change.
    expect(round2(Infinity)).toBe(0);
    expect(round2(NaN)).toBe(0);
    expect(round2('abc')).toBe(0);
  });

  it('an amount of 1e309 is reported with the row id', () => {
    // 1e309 overflows to Infinity. Going through JSON.parse is the real
    // path — this is what a stored ledger carrying an overflowed figure
    // deserialises to, and it keeps the literal out of the source.
    const overflowed = JSON.parse('{"amount": 1e309}').amount;
    expect(overflowed).toBe(Infinity);
    const out = runInvariantCheck(state([ok({ amount: overflowed })]));
    expect(out.byCategory.coercions).toBe(1);
    expect(out.totalProblems).toBe(1);
    const p = out.problems.find(x => x.code === 'nonFiniteAmount');
    expect(p.id).toBe('t1');
    expect(p.params.field).toBe('amount');
  });

  it('reports NaN and unparseable text too', () => {
    expect(runInvariantCheck(state([ok({ amount: NaN })])).byCategory.coercions).toBe(1);
    expect(runInvariantCheck(state([ok({ amount: 'abc' })])).byCategory.coercions).toBe(1);
  });

  it('finds a bad figure inside splits and fill lines', () => {
    const split = validateAmountCoercion({
      id: 'x', type: 'expense', amount: 10,
      envelope_splits: [{ envelope_id: 'food', amount: 5 },
                        { envelope_id: 'rent', amount: Infinity }],
    });
    expect(split).toHaveLength(1);
    expect(split[0].params.field).toBe('envelope_splits[1].amount');

    const line = validateAmountCoercion({
      id: 'y', type: 'fill', lines: [{ envelope_id: 'food', amount: 'x' }],
    });
    expect(line[0].params.field).toBe('lines[0].amount');
  });

  it('says nothing about clean or absent amounts', () => {
    expect(validateAmountCoercion(ok())).toEqual([]);
    expect(validateAmountCoercion({ id: 'f', type: 'fill' })).toEqual([]);
    expect(validateAmountCoercion({ id: 'f', type: 'fill', amount: null })).toEqual([]);
    expect(runInvariantCheck(state([ok()])).byCategory.coercions).toBe(0);
  });
});
