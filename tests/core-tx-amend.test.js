import { describe, it, expect } from 'vitest';
import { registry } from '../js/core/index.js';
import { runCommand } from '../js/core/pipeline.js';
import { makeCtx } from '../js/core/context.js';
import { round2 } from '../js/utils.js';

function deepFreeze(o) { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); Object.values(o).forEach(deepFreeze); } return o; }
const NOW = new Date(2026, 9, 2, 10, 0, 0);
const ctx = () => makeCtx({ now: NOW, newId: (() => { let n = 0; return () => `n${++n}`; })() });
const base = { id: 't1', type: 'expense', date: '2026-10-01', payee: 'A', amount: 10, account: 'chk', envelope_id: 'groc', budget_item_id: 'rent', note: null, created_at: '2026-10-01T08:00:00.000Z' };
const adj = { id: 'adj', type: 'adjustment', target: 'account', target_id: 'chk', amount: -5, date: '2026-10-01' };
const data = () => deepFreeze({
  meta: {}, budgetItems: [{ id: 'rent', description: 'Rent' }], envelopeTemplates: [],
  accounts: [{ id: 'chk', name: 'Checking' }, { id: 'sav', name: 'Savings' }, { id: 'broker', name: 'Broker', type: 'investment' }, { id: 'loan', name: 'Car loan', type: 'loan' }],
  envelopes: [{ id: 'groc', name: 'Groceries' }, { id: 'fun', name: 'Fun' }],
  transactions: [base, adj],
});
const amend = (input, d = data()) => runCommand(registry, d, 'transaction.amend', input, ctx());

describe('transaction.amend', () => {
  it('edits fields in place and stamps modified_at', () => {
    const r = amend({ id: 't1', amount: 12, payee: 'B' });
    expect(r.value.value).toMatchObject({ amount: 12, payee: 'B', envelope_id: 'groc', modified_at: NOW.toISOString(), created_at: base.created_at });
    expect(r.value.changes.transactions[0].id).toBe('t1');
    expect(r.value.changes.transactions).toHaveLength(2);
    expect(r.value.changes.transactions[1]).toBe(adj);
  });

  it('keeps an income row\'s interest_of through an edit, drops it on a type change, checks a new one', () => {
    const interest = { id: 'i1', type: 'income', date: '2026-10-01', payee: 'Sam', amount: 10, account: 'chk', envelope_id: null, interest_of: 'lg', note: null };
    const d = deepFreeze({ ...data(), accounts: [...data().accounts, { id: 'lg', name: 'Loan to Sam', type: 'loan_given' }], transactions: [interest] });
    expect(amend({ id: 'i1', type: 'income', amount: 12, payee: 'Sam K', account: 'chk', envelope: null }, d).value.value)
      .toMatchObject({ amount: 12, interest_of: 'lg' });
    expect(amend({ id: 'i1', type: 'expense', account: 'chk', envelope: 'groc' }, d).value.value).not.toHaveProperty('interest_of');
    expect(amend({ id: 'i1', interestOf: null }, d).value.value).not.toHaveProperty('interest_of');
    expect(amend({ id: 'i1', interestOf: 'sav' }, d).error.code).toBe('bad_input');
    // A link the loan no longer fits (its type changed) does not lock the row.
    const changed = deepFreeze({ ...d, accounts: d.accounts.map(a => (a.id === 'lg' ? { ...a, type: 'savings' } : a)) });
    expect(amend({ id: 'i1', payee: 'X' }, changed).ok).toBe(true);
  });

  it('does not invent a creation time for a row that has none', () => {
    const { created_at: _c, ...legacy } = base;
    const d = deepFreeze({ ...data(), transactions: [legacy] });
    expect(amend({ id: 't1', payee: 'B' }, d).value.value).not.toHaveProperty('created_at');
  });

  it('every amend drops stray fields of another type, not only a type change', () => {
    const legacy = deepFreeze({ ...data(), transactions: [{ ...base, from_account: 'sav' }] });
    const v = amend({ id: 't1', amount: 12 }, legacy).value.value;
    expect(v).toMatchObject({ type: 'expense', amount: 12, account: 'chk', envelope_id: 'groc' });
    expect(v).not.toHaveProperty('from_account');
  });

  it('does not strip a row of a type it does not describe bare: the row checks answer for it', () => {
    const fill = { id: 'f1', type: 'fill', date: '2026-10-01', amount: 5, envelope_id: 'groc' };
    const d = deepFreeze({ ...data(), transactions: [fill] });
    expect(amend({ id: 'f1', note: 'x' }, d).error.code).toBe('field_not_allowed');
  });

  it('changing type strips the old type fields', () => {
    const v = amend({ id: 't1', type: 'account_transfer', fromAccount: 'chk', toAccount: 'sav' }).value.value;
    expect(v).toMatchObject({ type: 'account_transfer', from_account: 'chk', to_account: 'sav' });
    for (const f of ['account', 'envelope_id', 'budget_item_id']) expect(v).not.toHaveProperty(f);
  });

  it('changing type applies the same null defaults as transaction.record', () => {
    const v = amend({ id: 't1', type: 'envelope_transfer', toEnvelope: 'fun' }).value.value;
    expect(v).toMatchObject({ type: 'envelope_transfer', from_envelope_id: null, to_envelope_id: 'fun' });
    const inc = amend({ id: 't1', type: 'income' }).value.value;
    expect(inc.envelope_id).toBe('groc');
  });

  it('clears fields with null and keeps null where it means none', () => {
    const v = amend({ id: 't1', budgetItem: null, envelope: null }).value.value;
    expect(v).not.toHaveProperty('budget_item_id');
    expect(v.envelope_id).toBeNull();
  });

  it('switching from splits to one envelope drops the splits', () => {
    const r = amend({ id: 't1', splits: [{ envelope: 'groc', amount: 6 }, { envelope: 'fun', amount: 4 }] });
    expect(r.value.value).toMatchObject({ envelope_id: null, envelope_splits: [{ envelope_id: 'groc', amount: 6 }, { envelope_id: 'fun', amount: 4 }] });
    const r2 = runCommand(registry, r.value.after, 'transaction.amend', { id: 't1', envelope: 'fun' }, ctx());
    expect(r2.value.value.envelope_id).toBe('fun');
    expect(r2.value.value).not.toHaveProperty('envelope_splits');
  });

  it('splits: null removes the splits and keeps envelope_id as given', () => {
    const r = amend({ id: 't1', splits: [{ envelope: 'groc', amount: 6 }, { envelope: 'fun', amount: 4 }] });
    const r2 = runCommand(registry, r.value.after, 'transaction.amend', { id: 't1', splits: null, envelope: 'fun' }, ctx());
    expect(r2.value.value.envelope_id).toBe('fun');
    expect(r2.value.value).not.toHaveProperty('envelope_splits');
  });

  it('amends an adjustment with a signed amount and a new target', () => {
    expect(amend({ id: 'adj', amount: -7, targetId: 'sav' }).value.value).toMatchObject({ amount: -7, target_id: 'sav' });
  });

  it('refuses targetId on a row that is not an adjustment', () => {
    expect(amend({ id: 't1', targetId: 'sav' }).error).toEqual({ code: 'field_not_allowed', params: { field: 'target_id', type: 'expense' } });
  });

  it('refuses a non-positive amount on a non-adjustment and an unknown id', () => {
    const e = amend({ id: 't1', amount: -3 }).error;
    expect(e.code).toBe('bad_input');
    expect(e.params.errors).toEqual([{ path: 'amount', message: 'must be positive' }]);
    expect(amend({ id: 't1', amount: 0 }).error.code).toBe('bad_input');
    expect(amend({ id: 'nope', amount: 3 }).error).toEqual({ code: 'tx_not_found', params: { id: 'nope' } });
  });

  it('status changes follow Budget: scheduled drops cleared, posted sets it once', () => {
    const cleared = deepFreeze({ ...data(), transactions: [{ ...base, cleared: true }] });
    expect(amend({ id: 't1', status: 'scheduled' }, cleared).value.value).toMatchObject({ status: 'scheduled' });
    expect(amend({ id: 't1', status: 'scheduled' }, cleared).value.value).not.toHaveProperty('cleared');
    expect(amend({ id: 't1', status: 'posted' }).value.value).toMatchObject({ status: 'posted', cleared: true });
    const uncleared = deepFreeze({ ...data(), transactions: [{ ...base, cleared: false }] });
    expect(amend({ id: 't1', status: 'posted' }, uncleared).value.value.cleared).toBe(false);
  });

  it('flags a row and re-checks the row rules', () => {
    expect(amend({ id: 't1', flagged: true }).value.value.flagged).toBe(true);
    const r = amend({ id: 't1', type: 'account_transfer', fromAccount: 'chk', toAccount: 'chk' });
    expect(r.error.code).toBe('same_account');
  });

  it('cannot retype a row to or from an adjustment', () => {
    expect(amend({ id: 't1', type: 'adjustment' }).error.code).toBe('bad_input');
    expect(amend({ id: 'adj', type: 'expense', account: 'chk' }).error).toEqual({ code: 'field_not_allowed', params: { field: 'type', type: 'adjustment' } });
    expect(amend({ id: 'adj', note: 'x' }).error).toBeUndefined();
  });

  it('refuses an adjustment that has no target', () => {
    const d = deepFreeze({ ...data(), transactions: [{ id: 'adj2', type: 'adjustment', amount: -1, date: '2026-10-01' }] });
    expect(amend({ id: 'adj2', note: 'x' }, d).error).toEqual({ code: 'field_required', params: { field: 'target' } });
    const d2 = deepFreeze({ ...data(), transactions: [{ id: 'adj3', type: 'adjustment', target: 'account', amount: -1, date: '2026-10-01' }] });
    expect(amend({ id: 'adj3', note: 'x' }, d2).error).toEqual({ code: 'field_required', params: { field: 'target_id' } });
  });

  it('stores amounts in cents', () => {
    expect(amend({ id: 'adj', amount: -7.005 }).value.value.amount).toBe(round2(-7.005));
    expect(amend({ id: 't1', amount: '12.345' }).value.value.amount).toBe(round2(12.345));
    const r = runCommand(registry, data(), 'transaction.record', { type: 'expense', amount: '12.345', account: 'chk' }, ctx());
    expect(r.value.value.amount).toBe(round2(12.345));
  });
});

describe('adjustment target edits', () => {
  it('switches collections only to an existing target', () => {
    expect(amend({ id: 'adj', target: 'envelope', targetId: 'groc' }).value.value)
      .toMatchObject({ target: 'envelope', target_id: 'groc' });
    expect(amend({ id: 'adj', targetId: 'missing' }).error.code).toBe('ref_not_found');
    expect(amend({ id: 'adj', target: 'envelope' }).error.code).toBe('ref_not_found');
    expect(amend({ id: 't1', target: 'account' }).error.code).toBe('field_not_allowed');
  });
});
