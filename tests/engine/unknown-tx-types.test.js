// A transaction whose `type` the engine does not know moves no money: every
// balance walker falls through to zero for it. The storage validator only
// asks for a non-empty string (so a legacy row cannot lock the budget), which
// is why runInvariantCheck has to be the place that says so.

import { describe, it, expect } from 'vitest';
import {
  TX_TYPES,
  isKnownTxType,
  validateTxType,
  runInvariantCheck,
  computeAccountBalances,
  computeEnvelopeBalances,
  txAccountDelta,
} from '../../js/engine.js';

const ACCOUNTS = [{ id: 'a', initialBalance: 100 }, { id: 'b', initialBalance: 0 }];
const ENVELOPES = [{ id: 'food' }, { id: 'rent' }];
const run = (txs) => runInvariantCheck({ accounts: ACCOUNTS, envelopes: ENVELOPES, transactions: txs });

// The F5 example: a typo'd expense.
const TYPO = { id: 'bad', type: 'expnese', amount: 10, account: 'a', date: '2026-09-01' };

describe('TX_TYPES / isKnownTxType', () => {
  it('lists exactly the types the engine gives an effect to', () => {
    expect([...TX_TYPES].sort()).toEqual([
      'account_transfer', 'adjustment', 'debt_payment', 'envelope_transfer',
      'expense', 'fill', 'income', 'investment_transfer',
    ]);
    expect(Object.isFrozen(TX_TYPES)).toBe(true);
  });

  it('accepts every listed type', () => {
    for (const type of TX_TYPES) expect(isKnownTxType(type)).toBe(true);
  });

  it('rejects typos, near misses, non-strings and absence', () => {
    for (const type of ['expnese', 'Expense', 'transfer', ' expense', '', null, undefined, 1, {}]) {
      expect(isKnownTxType(type)).toBe(false);
    }
  });
});

describe('validateTxType', () => {
  it('reports an unsupported type with its value', () => {
    expect(validateTxType(TYPO)).toEqual([{
      code: 'unknownTxType',
      params: { type: 'expnese' },
      message: 'has unsupported type "expnese" and moves no money',
    }]);
  });

  it('reports an absent or blank type as (missing)', () => {
    const { type: _omit, ...noType } = TYPO;
    expect(validateTxType(noType)[0].params).toEqual({ type: '(missing)' });
    expect(validateTxType({ ...TYPO, type: '' })[0].params).toEqual({ type: '(missing)' });
  });

  it('is silent for known types and for non-rows', () => {
    for (const type of TX_TYPES) expect(validateTxType({ ...TYPO, type })).toEqual([]);
    expect(validateTxType(null)).toEqual([]);
    expect(validateTxType(undefined)).toEqual([]);
  });
});

describe('runInvariantCheck unknownTypes', () => {
  it('reports the typo under its own category, code and params', () => {
    const out = run([TYPO]);
    expect(out.byCategory.unknownTypes).toBe(1);
    // Nothing else trips: the ref, sign and conservation checks key off a
    // known type, so the row would otherwise be reported by nobody.
    expect(out.totalProblems).toBe(1);
    expect(out.problems).toEqual([{
      id: 'bad',
      category: 'unknownTypes',
      code: 'unknownTxType',
      params: { type: 'expnese' },
      message: 'has unsupported type "expnese" and moves no money',
    }]);
  });

  it('reports a row with no type', () => {
    const { type: _omit, ...noType } = TYPO;
    const out = run([noType]);
    expect(out.byCategory.unknownTypes).toBe(1);
    expect(out.problems[0]).toMatchObject({ category: 'unknownTypes', params: { type: '(missing)' } });
  });

  it('does not also report a negative amount on an unknown type as a sign bust', () => {
    const out = run([{ ...TYPO, amount: -10 }]);
    expect(out.byCategory.unknownTypes).toBe(1);
    expect(out.byCategory.signs).toBe(0);
    expect(out.totalProblems).toBe(1);
  });

  it('does not flag well-formed rows of every known type', () => {
    const out = run([
      { id: 'e', type: 'expense', date: '2026-09-01', account: 'a', envelope_id: 'food', amount: 5 },
      { id: 'i', type: 'income', date: '2026-09-01', account: 'a', amount: 5 },
      { id: 'at', type: 'account_transfer', date: '2026-09-01', from_account: 'a', to_account: 'b', amount: 5 },
      { id: 'dp', type: 'debt_payment', date: '2026-09-01', from_account: 'a', to_account: 'b', amount: 5 },
      { id: 'it', type: 'investment_transfer', date: '2026-09-01', from_account: 'a', to_account: 'b', amount: 5 },
      { id: 'et', type: 'envelope_transfer', date: '2026-09-01', from_envelope_id: 'food', to_envelope_id: 'rent', amount: 5 },
      { id: 'f', type: 'fill', date: '2026-09-01', lines: [{ envelope_id: 'food', amount: 5 }] },
      { id: 'adj', type: 'adjustment', date: '2026-09-01', target: 'account', target_id: 'a', amount: -5 },
    ]);
    expect(out.byCategory.unknownTypes).toBe(0);
    expect(out.problems.filter((p) => p.category === 'unknownTypes')).toEqual([]);
  });
});

describe('an unknown-type row moves no money (why it has to be reported)', () => {
  it('leaves account and envelope balances exactly as without it', () => {
    const real = { id: 'ok', type: 'expense', amount: 10, account: 'a', envelope_id: 'food', date: '2026-09-01' };
    const withTypo = [real, { ...TYPO, envelope_id: 'food' }];
    expect(txAccountDelta(TYPO, 'a')).toBe(0);
    expect(computeAccountBalances(ACCOUNTS, withTypo).get('a'))
      .toBe(computeAccountBalances(ACCOUNTS, [real]).get('a'));
    expect(computeEnvelopeBalances(withTypo).get('food') ?? 0)
      .toBe(computeEnvelopeBalances([real]).get('food') ?? 0);
  });
});
