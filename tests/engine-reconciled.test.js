import { describe, it, expect } from 'vitest';
import {
  isReconciledRow, reconciledLedgerBalance, reconciledBalanceShift, findReconciledDrift, reconciledDriftChanges,
} from '../js/engine/reconciled.js';

const checking = {
  id: 'chk', type: 'bank', initialBalance: 100,
  lastReconciledAt: '2026-09-30', lastReconciledBalance: 40, lastReconciledLedger: 40,
};
const card = { id: 'card', type: 'credit_card', initialBalance: 0 }; // never reconciled

const groceries = { id: 't1', type: 'expense', account: 'chk', amount: 50, date: '2026-09-10', cleared: true };
const rent = { id: 't2', type: 'expense', account: 'chk', amount: 10, date: '2026-09-28', cleared: true };
const october = { id: 't3', type: 'expense', account: 'chk', amount: 5, date: '2026-10-02', cleared: true };
const uncleared = { id: 't4', type: 'expense', account: 'chk', amount: 7, date: '2026-09-29' };
const onCard = { id: 't5', type: 'expense', account: 'card', amount: 9, date: '2026-09-01', cleared: true };

describe('isReconciledRow', () => {
  const accounts = [checking, card];
  it('is a cleared row on a reconciled account, dated on or before the reconcile date', () => {
    expect(isReconciledRow(groceries, accounts)).toBe(true);
    expect(isReconciledRow({ ...rent, date: '2026-09-30' }, accounts)).toBe(true);
  });
  it('is not a row after the reconcile date, an uncleared row, or one on an unreconciled account', () => {
    expect(isReconciledRow(october, accounts)).toBe(false);
    expect(isReconciledRow(uncleared, accounts)).toBe(false);
    expect(isReconciledRow(onCard, accounts)).toBe(false);
  });
  it('counts a transfer by either side', () => {
    const transfer = { id: 'x', type: 'account_transfer', from_account: 'card', to_account: 'chk', amount: 20, date: '2026-09-15', cleared: true };
    expect(isReconciledRow(transfer, accounts)).toBe(true);
  });
});

describe('reconciledLedgerBalance', () => {
  it('is the opening balance plus every cleared row up to the reconcile date', () => {
    expect(reconciledLedgerBalance(checking, [groceries, rent, october, uncleared, onCard])).toBe(40);
  });
  it('is null for an account that was never reconciled', () => {
    expect(reconciledLedgerBalance(card, [onCard])).toBeNull();
  });
});

describe('reconciledBalanceShift', () => {
  const accounts = [checking, card];
  it('reports what an edit does to a reconciled balance', () => {
    const shift = reconciledBalanceShift(accounts, [groceries], [{ ...groceries, amount: 55 }]);
    expect(shift).toEqual([{ accountId: 'chk', shift: -5 }]);
  });
  it('reports a deletion and an un-clearing', () => {
    expect(reconciledBalanceShift(accounts, [rent], [])).toEqual([{ accountId: 'chk', shift: 10 }]);
    expect(reconciledBalanceShift(accounts, [rent], [{ ...rent, cleared: false }])).toEqual([{ accountId: 'chk', shift: 10 }]);
  });
  it('reports moving a row out past the reconcile date', () => {
    expect(reconciledBalanceShift(accounts, [rent], [{ ...rent, date: '2026-10-01' }])).toEqual([{ accountId: 'chk', shift: 10 }]);
  });
  it('is empty for edits that leave the reconciled balance alone', () => {
    expect(reconciledBalanceShift(accounts, [groceries], [{ ...groceries, payee: 'Shop', envelope_id: 'food' }])).toEqual([]);
    expect(reconciledBalanceShift(accounts, [october], [{ ...october, amount: 99 }])).toEqual([]);
    expect(reconciledBalanceShift(accounts, [onCard], [])).toEqual([]);
  });
});

describe('findReconciledDrift', () => {
  it('is empty while the cleared rows still add up to what was reconciled', () => {
    expect(findReconciledDrift([checking, card], [groceries, rent, october, uncleared])).toEqual([]);
  });
  it('names the account and the difference once a reconciled row changed', () => {
    const drift = findReconciledDrift([checking, card], [{ ...groceries, amount: 45 }, rent]);
    expect(drift).toEqual([{ accountId: 'chk', reconciledAt: '2026-09-30', expected: 40, actual: 45, gap: 5 }]);
  });
  it('falls back to the statement balance for an account reconciled before the ledger was recorded', () => {
    const legacy = { ...checking, lastReconciledLedger: undefined, lastReconciledBalance: 38 };
    expect(findReconciledDrift([legacy], [groceries, rent])).toEqual([
      { accountId: 'chk', reconciledAt: '2026-09-30', expected: 38, actual: 40, gap: 2 },
    ]);
  });
  it('skips accounts with no reconcile and archived accounts', () => {
    expect(findReconciledDrift([card, { ...checking, archived: true }], [{ ...groceries, amount: 1 }])).toEqual([]);
  });
});

describe('reconciledDriftChanges', () => {
  const STAMP = '2026-10-01T09:00:00.000Z';
  const stamped = { ...checking, lastReconciledStamp: STAMP };
  const edit = (at, before, after) => ({ at, op: 'edit', id: before.id, fields: ['amount'], before, after });

  it('with the reconcile\'s time: edits, un-clears, deletes and additions after it, in the reconciled period', () => {
    const added = { id: 't6', type: 'expense', account: 'chk', amount: 3, date: '2026-09-20', cleared: true, created_at: '2026-10-03T10:00:00.000Z' };
    const log = [
      // The reconciliation's own tick, before its stamp: not a cause.
      edit('2026-10-01T08:59:00.000Z', { ...uncleared }, { ...uncleared, cleared: true }),
      edit('2026-10-02T10:00:00.000Z', groceries, { ...groceries, amount: 45 }),
      edit('2026-10-02T11:00:00.000Z', rent, { ...rent, cleared: false }),
      { at: '2026-10-02T12:00:00.000Z', op: 'delete', id: 'tx', fields: [], before: { ...rent, id: 'tx', amount: 2 } },
      // A row after the reconcile date: not in its period.
      edit('2026-10-02T13:00:00.000Z', october, { ...october, amount: 50 }),
    ];
    const txs = [{ ...groceries, amount: 45 }, { ...rent, cleared: false }, { ...uncleared, cleared: true }, october, added];
    const r = reconciledDriftChanges(stamped, txs, log);
    expect(r.timingKnown).toBe(true);
    expect(r.changes.map(c => [c.id, c.kind, c.shift, c.exists])).toEqual([
      ['t1', 'edited', 5, true],
      ['t2', 'uncleared', 10, true],
      ['tx', 'deleted', 2, false],
      ['t6', 'added', -3, true],
    ]);
    expect(r.changes[0]).toMatchObject({ date: '2026-09-10', at: '2026-10-02T10:00:00.000Z' });
  });

  it('without the reconcile\'s time: only changes to rows that were already reconciled, and says so', () => {
    const log = [
      edit('2026-10-01T08:59:00.000Z', { ...uncleared }, { ...uncleared, cleared: true }),
      edit('2026-10-02T10:00:00.000Z', groceries, { ...groceries, amount: 45 }),
    ];
    const r = reconciledDriftChanges(checking, [{ ...groceries, amount: 45 }], log);
    expect(r.timingKnown).toBe(false);
    expect(r.changes.map(c => [c.id, c.kind, c.shift])).toEqual([['t1', 'edited', 5]]);
  });

  it('several changes to one row are one entry with the summed shift', () => {
    const g2 = { ...groceries, amount: 45 };
    const log = [
      edit('2026-10-02T10:00:00.000Z', groceries, g2),
      edit('2026-10-02T11:00:00.000Z', g2, { ...g2, amount: 40 }),
    ];
    const r = reconciledDriftChanges(stamped, [{ ...g2, amount: 40 }], log);
    expect(r.changes).toHaveLength(1);
    expect(r.changes[0]).toMatchObject({ id: 't1', shift: 10, at: '2026-10-02T11:00:00.000Z' });
  });

  it('an account never reconciled has nothing to list', () => {
    expect(reconciledDriftChanges(card, [onCard], [])).toEqual({ timingKnown: false, changes: [] });
  });
});
