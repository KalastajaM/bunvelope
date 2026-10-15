// Stricter transaction checks at the storage boundary: amounts must be real
// numbers, dates must exist on the calendar, and a write must not introduce
// an account reference that resolves to nothing.

import { describe, it, expect } from 'vitest';
import {
  validateTransactions, validateTransactionAccountRefs,
} from '../js/storage/validators.js';

const tx = (over) => ({ id: 't1', type: 'expense', amount: 10, date: '2026-01-15', ...over });

describe('transaction amounts', () => {
  it.each([
    ['a numeric string', '12.50'],
    ['an empty string', ''],
    ['a boolean', true],
    ['null', null],
    ['NaN', NaN],
    ['Infinity', Infinity],
    ['an object', { v: 1 }],
  ])('rejects %s', (_label, amount) => {
    const r = validateTransactions([tx({ amount })]);
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatch(/invalid amount/);
  });

  it('requires an amount on types whose meaning depends on one', () => {
    for (const type of ['expense', 'income', 'account_transfer', 'debt_payment',
      'investment_transfer', 'envelope_transfer', 'adjustment']) {
      const { amount: _drop, ...row } = tx({ type });
      const r = validateTransactions([row]);
      expect(r.ok, type).toBe(false);
      expect(r.errors[0]).toMatch(/missing amount/);
    }
  });

  it('still accepts a fill carried by its lines, with no top-level amount', () => {
    const fill = { id: 'f1', type: 'fill', date: '2026-01-01', lines: [{ envelope_id: 'e', mode: 'add', amount: 5 }] };
    expect(validateTransactions([fill]).ok).toBe(true);
  });

  it('accepts negative adjustments and plain numbers', () => {
    expect(validateTransactions([tx({ type: 'adjustment', amount: -3.2 })]).ok).toBe(true);
    expect(validateTransactions([tx({ amount: 0 })]).ok).toBe(true);
  });
});

describe('transaction dates', () => {
  it.each(['2026-02-31', '2026-02-29', '2026-04-31', '2026-13-01', '2026-00-10', '2026-01-00'])(
    'rejects the impossible date %s', (date) => {
      expect(validateTransactions([tx({ date })]).ok).toBe(false);
    },
  );

  it('accepts real dates, including a leap day', () => {
    for (const date of ['2024-02-29', '2026-12-31', '2026-01-01']) {
      expect(validateTransactions([tx({ date })]).ok, date).toBe(true);
    }
  });
});

describe('validateTransactionAccountRefs', () => {
  const accounts = [{ id: 'bank', name: 'Bank' }, { id: 'card', name: 'Card', archived: true }];

  it('accepts references to existing (including archived) accounts', () => {
    const r = validateTransactionAccountRefs([
      tx({ account: 'bank' }),
      tx({ id: 't2', type: 'account_transfer', from_account: 'bank', to_account: 'card' }),
    ], accounts);
    expect(r).toEqual({ ok: true, errors: [], truncated: false });
  });

  it('rejects a reference to an account that does not exist', () => {
    const r = validateTransactionAccountRefs([
      tx({ id: 't9', type: 'account_transfer', from_account: 'bank', to_account: 'ghost' }),
    ], accounts);
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatch(/t9.*to_account.*ghost/);
  });

  it('tolerates ids listed as already dangling, so legacy data does not block a save', () => {
    const rows = [tx({ account: 'deleted-long-ago' })];
    expect(validateTransactionAccountRefs(rows, accounts).ok).toBe(false);
    expect(validateTransactionAccountRefs(rows, accounts, { tolerate: ['deleted-long-ago'] }).ok).toBe(true);
  });

  it('skips input that is not a pair of arrays (e.g. encrypted blobs)', () => {
    expect(validateTransactionAccountRefs({ __enc: 1 }, accounts).ok).toBe(true);
    expect(validateTransactionAccountRefs([tx({ account: 'x' })], { __enc: 1 }).ok).toBe(true);
  });
});
