import { describe, it, expect } from 'vitest';
import { rowDiff, invert, applyDiff, deepEqual, mergeMetaChanges } from '../js/core/diff.js';

const tx = (id, extra = {}) => ({ id, type: 'expense', amount: 1, date: '2026-10-01', ...extra });
const base = () => ({
  meta: { name: 'B', country: 'FI' },
  accounts: [], envelopes: [], budgetItems: [], envelopeTemplates: [],
  transactions: [tx('a'), tx('b'), tx('c')],
});

describe('deepEqual', () => {
  it('compares plain data regardless of key order', () => {
    expect(deepEqual({ a: 1, b: [1, { c: 2 }] }, { b: [1, { c: 2 }], a: 1 })).toBe(true);
    expect(deepEqual({ a: 1 }, { a: 1, b: undefined })).toBe(false);
    expect(deepEqual([1, 2], [2, 1])).toBe(false);
  });
});

describe('rowDiff', () => {
  it('finds added, removed and changed rows by id', () => {
    const before = base();
    const next = [tx('a'), tx('c', { amount: 5 }), tx('d')];
    const d = rowDiff(before, { transactions: next });
    expect(d.transactions.added).toEqual([{ row: tx('d'), index: 2 }]);
    expect(d.transactions.removed).toEqual([{ row: tx('b'), index: 1 }]);
    expect(d.transactions.changed).toEqual([{ id: 'c', before: tx('c'), after: tx('c', { amount: 5 }) }]);
  });

  it('omits unchanged kinds and diffs meta by key', () => {
    const before = base();
    const d = rowDiff(before, { transactions: before.transactions, meta: { name: 'C', country: 'FI', policies: ['strict-ledger'] } });
    expect(d).toEqual({ meta: { changed: [
      { key: 'name', before: 'B', after: 'C' },
      { key: 'policies', before: undefined, after: ['strict-ledger'] },
    ] } });
  });

  it('throws on a row without an id', () => {
    expect(() => rowDiff(base(), { transactions: [{ type: 'expense' }] })).toThrow(TypeError);
  });

  it('records a pure reorder as order alone', () => {
    const d = rowDiff(base(), { transactions: [tx('c'), tx('b'), tx('a')] });
    expect(d).toEqual({ transactions: { added: [], removed: [], changed: [], order: { before: ['a', 'b', 'c'], after: ['c', 'b', 'a'] } } });
  });

  it('records a reorder beside an edit, with the full id sequences', () => {
    const d = rowDiff(base(), { transactions: [tx('c'), tx('x'), tx('a', { amount: 5 })] });
    expect(d.transactions).toEqual({
      added: [{ row: tx('x'), index: 1 }],
      removed: [{ row: tx('b'), index: 1 }],
      changed: [{ id: 'a', before: tx('a'), after: tx('a', { amount: 5 }) }],
      order: { before: ['a', 'b', 'c'], after: ['c', 'x', 'a'] },
    });
  });

  it('does not throw when adding and removing without reordering the rest', () => {
    const before = base();
    const next = [tx('a'), tx('x'), tx('c')];
    const d = rowDiff(before, { transactions: next });
    expect(d.transactions.added).toEqual([{ row: tx('x'), index: 1 }]);
    expect(d.transactions.removed).toEqual([{ row: tx('b'), index: 1 }]);
    expect(d.transactions.changed).toEqual([]);
  });
});

describe('invert and applyDiff', () => {
  it('undoes a change on the current data, keeping later edits to other rows', () => {
    const before = base();
    const next = [tx('a'), tx('c', { amount: 5 }), tx('d')];
    const d = rowDiff(before, { transactions: next });
    // Someone edits row a afterwards; undo must keep that.
    const current = { ...before, transactions: [tx('a', { note: 'later' }), tx('c', { amount: 5 }), tx('d')] };
    const r = applyDiff(current, invert(d));
    expect(r).toEqual({ ok: true, value: { transactions: [tx('a', { note: 'later' }), tx('b'), tx('c')] } });
  });

  it('refuses when a row it would restore was edited since', () => {
    const before = base();
    const d = rowDiff(before, { transactions: [tx('a'), tx('b'), tx('c', { amount: 5 })] });
    const current = { ...before, transactions: [tx('a'), tx('b'), tx('c', { amount: 9 })] };
    const r = applyDiff(current, invert(d));
    expect(r).toEqual({ ok: false, error: { code: 'diff_conflict', params: { kind: 'transactions', id: 'c' } } });
  });

  it('applies a reorder and round-trips it through the inverse', () => {
    const before = base();
    const next = [tx('c'), tx('x'), tx('a', { amount: 5 })];
    const d = rowDiff(before, { transactions: next });
    const forward = applyDiff(before, d);
    expect(forward).toEqual({ ok: true, value: { transactions: next } });
    const back = applyDiff({ ...before, transactions: forward.value.transactions }, invert(d));
    expect(back).toEqual({ ok: true, value: { transactions: before.transactions } });
    expect(invert(d).transactions.order).toEqual({ before: ['c', 'x', 'a'], after: ['a', 'b', 'c'] });
  });

  it('keeps each row object when it reorders', () => {
    const before = base();
    const d = rowDiff(before, { transactions: [...before.transactions].reverse() });
    const r = applyDiff(before, d);
    r.value.transactions.forEach((row, i) => expect(row).toBe(before.transactions[2 - i]));
  });

  it('refuses a reorder when the current order is not the one it started from', () => {
    const before = base();
    const d = rowDiff(before, { transactions: [tx('c'), tx('a'), tx('b')] });
    const moved = { ...before, transactions: [tx('b'), tx('a'), tx('c')] };
    expect(applyDiff(moved, d)).toEqual({ ok: false, error: { code: 'diff_conflict', params: { kind: 'transactions', id: null } } });
  });

  it('refuses a reorder when another row appeared since', () => {
    const before = base();
    const d = rowDiff(before, { transactions: [tx('c'), tx('b'), tx('a')] });
    const grown = { ...before, transactions: [...before.transactions, tx('z')] };
    expect(applyDiff(grown, d)).toEqual({ ok: false, error: { code: 'diff_conflict', params: { kind: 'transactions', id: null } } });
  });

  it('round-trips meta, deleting a key that did not exist', () => {
    const before = base();
    const d = rowDiff(before, { meta: { ...before.meta, policies: ['strict-ledger'] } });
    const after = { ...before, meta: { ...before.meta, policies: ['strict-ledger'] } };
    expect(applyDiff(after, invert(d))).toEqual({ ok: true, value: { meta: { name: 'B', country: 'FI' } } });
  });
});

describe('mergeMetaChanges', () => {
  it('merges primitive arrays by added and removed elements', () => {
    const current = { scheduledTombstones: ['a', 'z'], name: 'B' };
    const metaDiff = { changed: [{ key: 'scheduledTombstones', before: ['a'], after: ['a', 'b'] }] };
    expect(mergeMetaChanges(current, metaDiff)).toEqual({ scheduledTombstones: ['a', 'z', 'b'], name: 'B' });
    const removal = { changed: [{ key: 'scheduledTombstones', before: ['a', 'b'], after: ['a'] }] };
    expect(mergeMetaChanges({ scheduledTombstones: ['a', 'b', 'z'] }, removal)).toEqual({ scheduledTombstones: ['a', 'z'] });
  });
  it('stores the command\'s array exactly when the key has not moved: its order, and a deleted key', () => {
    const reopen = { changed: [{ key: 'reopened_months', before: ['2026-06'], after: ['2026-03', '2026-06'] }] };
    expect(mergeMetaChanges({ reopened_months: ['2026-06'] }, reopen)).toEqual({ reopened_months: ['2026-03', '2026-06'] });
    const clear = { changed: [{ key: 'reopened_months', before: ['2026-03'], after: undefined }] };
    expect(mergeMetaChanges({ reopened_months: ['2026-03'], x: 1 }, clear)).toEqual({ x: 1 });
  });
  it('keeps a key the app keeps sorted sorted when it merges by element', () => {
    const reopen = { changed: [{ key: 'reopened_months', before: ['2026-06'], after: ['2026-03', '2026-06'] }] };
    expect(mergeMetaChanges({ reopened_months: ['2026-06', '2026-07'] }, reopen))
      .toEqual({ reopened_months: ['2026-03', '2026-06', '2026-07'] });
    const hide = { changed: [{ key: 'payeeHidden', before: ['m'], after: ['b', 'm'] }] };
    expect(mergeMetaChanges({ payeeHidden: ['m', 'z'] }, hide)).toEqual({ payeeHidden: ['b', 'm', 'z'] });
  });
  it('deletes the key when the command deleted it and the merge leaves nothing', () => {
    const clear = { changed: [{ key: 'reopened_months', before: ['2026-03', '2026-04'], after: undefined }] };
    expect(mergeMetaChanges({ reopened_months: ['2026-04', '2026-03'] }, clear)).toEqual({});
  });
  it('sets other keys and deletes undefined ones', () => {
    const metaDiff = { changed: [{ key: 'name', before: 'B', after: 'C' }, { key: 'x', before: 1, after: undefined }] };
    expect(mergeMetaChanges({ name: 'B', x: 1 }, metaDiff)).toEqual({ name: 'C' });
  });
});
