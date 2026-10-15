// Three integrity invariants, all of the same family: data that is wrong in a
// way nothing else in the app would ever mention.
//
//   dates         — every date comparison in the engine is a LEXICOGRAPHIC
//                   string compare, correct for ISO strings and meaningless
//                   for anything else. `2026-8-6` sorts after `2026-12-01`.
//   selfTransfers — both legs hit the same id and cancel in txAccountDelta, so
//                   the row moves nothing while still counting as activity.
//   duplicateIds  — tx.id keys every Map the app builds over transactions, so
//                   one row becomes unreachable and the other answers for both.

import { describe, it, expect } from 'vitest';
import { runInvariantCheck, validateTxDate, validateSelfTransfer } from '../../js/engine.js';

const ACCOUNTS = [{ id: 'cash' }, { id: 'savings' }];
const ENVELOPES = [{ id: 'food' }, { id: 'rent' }];
const run = txs => runInvariantCheck({
  accounts: ACCOUNTS, envelopes: ENVELOPES, transactions: txs,
});
const ok = (over = {}) => ({
  id: 't1', type: 'expense', date: '2026-08-06', status: 'posted',
  amount: 10, account: 'cash', envelope_id: 'food', ...over,
});

describe('validateTxDate', () => {
  it('accepts a well-formed ISO date', () => {
    expect(validateTxDate(ok())).toEqual([]);
  });

  it('rejects a missing date', () => {
    const p = validateTxDate({ type: 'expense' });
    expect(p).toHaveLength(1);
    expect(p[0].code).toBe('invalidDate');
    expect(p[0].params.date).toBe('(missing)');
  });

  it('rejects an unpadded date that would sort wrongly', () => {
    // '2026-8-6' > '2026-12-01' as a string — it would sort to the end of the
    // year and bucket into no month at all.
    expect(validateTxDate(ok({ date: '2026-8-6' }))[0].code).toBe('invalidDate');
  });

  it('rejects an empty string, a non-string and a timestamp', () => {
    expect(validateTxDate(ok({ date: '' }))).toHaveLength(1);
    expect(validateTxDate(ok({ date: 20260806 }))).toHaveLength(1);
    expect(validateTxDate(ok({ date: '2026-08-06T10:00:00Z' }))).toHaveLength(1);
  });

  it('describes a blank date as missing rather than rendering nothing', () => {
    // Otherwise the dialog reads "has an unusable date ()".
    expect(validateTxDate(ok({ date: '' }))[0].params.date).toBe('(missing)');
    expect(validateTxDate(ok({ date: null }))[0].params.date).toBe('(missing)');
  });

  it('rejects a day that does not exist even though JS would parse it', () => {
    // new Date(2026, 1, 31) silently rolls into March.
    expect(validateTxDate(ok({ date: '2026-02-31' }))).toHaveLength(1);
    expect(validateTxDate(ok({ date: '2026-13-01' }))).toHaveLength(1);
  });

  it('accepts a real leap day and rejects a fake one', () => {
    expect(validateTxDate(ok({ date: '2024-02-29' }))).toEqual([]);
    expect(validateTxDate(ok({ date: '2026-02-29' }))).toHaveLength(1);
  });
});

describe('validateSelfTransfer', () => {
  it('accepts a transfer between two different accounts', () => {
    expect(validateSelfTransfer({
      type: 'account_transfer', from_account: 'cash', to_account: 'savings', amount: 50,
    })).toEqual([]);
  });

  it('flags an account transfer that starts and ends in one place', () => {
    const p = validateSelfTransfer({
      type: 'account_transfer', from_account: 'cash', to_account: 'cash', amount: 50,
    });
    expect(p).toHaveLength(1);
    expect(p[0].code).toBe('selfTransferAccount');
    expect(p[0].params).toEqual({ id: 'cash', type: 'account_transfer' });
  });

  it('flags debt payments and investment transfers the same way', () => {
    for (const type of ['debt_payment', 'investment_transfer']) {
      const p = validateSelfTransfer({ type, from_account: 'cash', to_account: 'cash', amount: 5 });
      expect(p, type).toHaveLength(1);
    }
  });

  it('flags an envelope transfer that goes nowhere', () => {
    const p = validateSelfTransfer({
      type: 'envelope_transfer', from_envelope_id: 'food', to_envelope_id: 'food', amount: 20,
    });
    expect(p[0].code).toBe('selfTransferEnvelope');
  });

  it('ignores a one-sided transfer, which is a different problem', () => {
    expect(validateSelfTransfer({ type: 'account_transfer', from_account: 'cash' })).toEqual([]);
    expect(validateSelfTransfer({ type: 'envelope_transfer', to_envelope_id: 'food' })).toEqual([]);
  });

  it('ignores types that have no two sides', () => {
    expect(validateSelfTransfer(ok())).toEqual([]);
    expect(validateSelfTransfer({ type: 'income', account: 'cash' })).toEqual([]);
  });
});

describe('runInvariantCheck integrity categories', () => {
  it('reports zero for clean data and exposes every category', () => {
    const out = run([ok(), ok({ id: 't2', date: '2026-08-07' })]);
    expect(out.totalProblems).toBe(0);
    expect(out.byCategory).toEqual({
      splits: 0, accountRefs: 0, envelopeRefs: 0, signs: 0,
      duplicateKeys: 0, dates: 0, selfTransfers: 0, duplicateIds: 0,
      staleKeys: 0, coercions: 0, conservation: 0, unknownTypes: 0, itemLinks: 0, reconciled: 0, clearedScheduled: 0,
    });
  });

  it('counts a bad date once and names the row', () => {
    const out = run([ok({ date: 'yesterday' })]);
    expect(out.byCategory.dates).toBe(1);
    expect(out.totalProblems).toBe(1);
    expect(out.problems[0]).toMatchObject({ id: 't1', category: 'dates', code: 'invalidDate' });
  });

  it('counts a self transfer', () => {
    const out = run([{
      id: 'x', type: 'account_transfer', date: '2026-08-06',
      from_account: 'cash', to_account: 'cash', amount: 50,
    }]);
    expect(out.byCategory.selfTransfers).toBe(1);
  });

  it('flags every row sharing an id, not just the extras', () => {
    const out = run([ok({ id: 'dup' }), ok({ id: 'dup', amount: 20 })]);
    expect(out.byCategory.duplicateIds).toBe(2);
    const dupes = out.problems.filter(p => p.category === 'duplicateIds');
    expect(dupes).toHaveLength(2);
    expect(dupes[0].params).toEqual({ id: 'dup', count: 2 });
  });

  it('does not treat missing ids as duplicates of each other', () => {
    const out = run([ok({ id: undefined }), ok({ id: undefined })]);
    expect(out.byCategory.duplicateIds).toBe(0);
  });

  it('accumulates independently of the existing categories', () => {
    const out = run([
      ok({ id: 'a', date: 'nope' }),
      ok({ id: 'b', amount: -5 }),
      { id: 'c', type: 'envelope_transfer', date: '2026-08-06',
        from_envelope_id: 'food', to_envelope_id: 'food', amount: 9 },
      ok({ id: 'd' }), ok({ id: 'd' }),
    ]);
    expect(out.byCategory.dates).toBe(1);
    expect(out.byCategory.signs).toBe(1);
    expect(out.byCategory.selfTransfers).toBe(1);
    expect(out.byCategory.duplicateIds).toBe(2);
    expect(out.totalProblems).toBe(5);
  });
});

describe('runInvariantCheck reconciled category', () => {
  const reconciled = { id: 'cash', initialBalance: 0, lastReconciledAt: '2026-08-31', lastReconciledBalance: -10, lastReconciledLedger: -10 };
  const check = txs => runInvariantCheck({ accounts: [reconciled, { id: 'savings' }], envelopes: ENVELOPES, transactions: txs });

  it('is clean while the cleared rows match the reconcile', () => {
    expect(check([ok({ cleared: true })]).byCategory.reconciled).toBe(0);
  });

  it('reports an account whose reconciled rows changed since, with the gap', () => {
    const out = check([ok({ cleared: true, amount: 12 })]);
    expect(out.byCategory.reconciled).toBe(1);
    expect(out.totalProblems).toBe(1);
    expect(out.problems[0]).toMatchObject({
      id: null, category: 'reconciled', code: 'reconciledDrift',
      params: { accountId: 'cash', date: '2026-08-31', expected: -10, actual: -12, gap: -2 },
    });
  });
});

describe('runInvariantCheck clearedScheduled category', () => {
  it('reports a row that is cleared but still scheduled, and not a forecast row', () => {
    const out = run([ok({ cleared: true, status: 'scheduled' }), ok({ id: 'f', cleared: true, status: 'scheduled', is_forecast: true })]);
    expect(out.byCategory.clearedScheduled).toBe(1);
    expect(out.problems.find(p => p.category === 'clearedScheduled')).toMatchObject({ id: 't1', code: 'clearedScheduled' });
  });
  it('is clean for a scheduled row not yet cleared, and a cleared posted one', () => {
    expect(run([ok({ status: 'scheduled' }), ok({ id: 't2', cleared: true })]).byCategory.clearedScheduled).toBe(0);
  });
});
