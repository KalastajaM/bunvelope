// tests/session-commit-checks.test.js
import { describe, it, expect } from 'vitest';
import { applyCommitChecks, firstUnknownTypeRow } from '../js/session/commit-checks.js';

const before = {
  meta: { payeeAliases: { 'k market': 'K-Market' } },
  accounts: [], envelopes: [], budgetItems: [], envelopeTemplates: [],
  transactions: [{ id: 'old', type: 'legacy_kind', amount: 1, date: '2026-09-01', account: 'bank' }],
};

describe('applyCommitChecks', () => {
  it('normalises signs and aliases payees on new rows only', () => {
    const changes = { transactions: [
      { ...before.transactions[0], payee: 'k market' },
      { id: 'n', type: 'expense', amount: -12.5, date: '2026-10-01', account: 'bank', payee: 'k market' },
    ] };
    const r = applyCommitChecks(before, changes);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const [old, added] = r.value.transactions;
    expect(old.payee).toBe('k market');
    expect(added.payee).toBe('K-Market');
    expect(added.amount).toBe(12.5);
  });

  it('refuses a new row of an unknown type, unless allowed', () => {
    const changes = { transactions: [...before.transactions, { id: 'x', type: 'expnese', amount: 1, date: '2026-10-01', account: 'bank' }] };
    expect(applyCommitChecks(before, changes)).toEqual({ ok: false, error: { code: 'unknown_tx_type', params: { id: 'x', type: 'expnese' } } });
    expect(applyCommitChecks(before, changes, { allowUnknownTypes: true }).ok).toBe(true);
  });

  it('can skip payee aliases (Undo re-inserting a row as it was)', () => {
    const changes = { transactions: [{ id: 'n', type: 'expense', amount: 1, date: '2026-10-01', account: 'bank', payee: 'k market' }] };
    const r = applyCommitChecks(before, changes, { applyAliases: false });
    expect(r.value.transactions[0].payee).toBe('k market');
  });

  it('validates every changed collection', () => {
    const r = applyCommitChecks(before, { accounts: [{ id: 'a' }] });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('invalid_collection');
    expect(r.error.params.kind).toBe('accounts');
  });
});

describe('firstUnknownTypeRow', () => {
  it('lets a legacy row keep its type and catches a retyped one', () => {
    const prev = [{ id: 'a', type: 'legacy_kind' }];
    expect(firstUnknownTypeRow(prev, [{ id: 'a', type: 'legacy_kind', note: 'x' }])).toBeNull();
    expect(firstUnknownTypeRow(prev, [{ id: 'a', type: 'other_kind' }])).toEqual({ id: 'a', type: 'other_kind' });
  });
});
