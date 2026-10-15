import { describe, it, expect } from 'vitest';
import { registry } from '../js/core/index.js';
import { runCommand } from '../js/core/pipeline.js';
import { makeCtx } from '../js/core/context.js';

function deepFreeze(o) { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); Object.values(o).forEach(deepFreeze); } return o; }
const NOW = new Date(2026, 9, 2, 10, 0, 0);
const ctx = () => makeCtx({ now: NOW, newId: (() => { let n = 0; return () => `n${++n}`; })() });
const data = () => deepFreeze({
  meta: {}, budgetItems: [{ id: 'rent', description: 'Rent' }], envelopeTemplates: [],
  accounts: [{ id: 'chk', name: 'Checking' }, { id: 'sav', name: 'Savings' }, { id: 'broker', name: 'Broker', type: 'investment' }, { id: 'loan', name: 'Car loan', type: 'loan' }],
  envelopes: [{ id: 'groc', name: 'Groceries' }, { id: 'fun', name: 'Fun' }],
  transactions: [],
});
const record = (input) => runCommand(registry, data(), 'transaction.record', input, ctx());
const stamp = { created_at: NOW.toISOString(), modified_at: NOW.toISOString() };

describe('transaction.record', () => {
  it('records an expense exactly as the add form did', () => {
    const r = record({ type: 'expense', amount: '12.30', account: 'chk', envelope: 'groc', payee: 'K-Market', date: '2026-10-01', budgetItem: 'rent' });
    expect(r.value.value).toEqual({ id: 'n1', type: 'expense', date: '2026-10-01', payee: 'K-Market', amount: 12.3, account: 'chk', envelope_id: 'groc', budget_item_id: 'rent', note: null, ...stamp });
    expect(r.value.changes.transactions).toHaveLength(1);
  });

  it('records a split expense with envelope_id null', () => {
    const r = record({ type: 'expense', amount: 30, account: 'chk', splits: [{ envelope: 'groc', amount: 20 }, { envelope: 'fun', amount: 10 }] });
    expect(r.value.value).toMatchObject({ envelope_id: null, envelope_splits: [{ envelope_id: 'groc', amount: 20 }, { envelope_id: 'fun', amount: 10 }] });
  });

  it('defaults the date to today, the payee to empty and leaves cleared unset', () => {
    const v = record({ type: 'income', amount: 100, account: 'chk' }).value.value;
    expect(v).toMatchObject({ date: '2026-10-02', payee: '', envelope_id: null });
    expect(v).not.toHaveProperty('cleared');
  });

  it('records scheduled rows without cleared, and cleared when asked', () => {
    expect(record({ type: 'expense', amount: 1, account: 'chk', scheduled: true }).value.value).toMatchObject({ status: 'scheduled' });
    expect(record({ type: 'expense', amount: 1, account: 'chk', cleared: true }).value.value.cleared).toBe(true);
  });

  it('records transfers and refuses the same account or envelope', () => {
    expect(record({ type: 'account_transfer', amount: 5, fromAccount: 'chk', toAccount: 'sav' }).value.value).toMatchObject({ from_account: 'chk', to_account: 'sav' });
    expect(record({ type: 'account_transfer', amount: 5, fromAccount: 'chk', toAccount: 'chk' }).error.code).toBe('same_account');
    expect(record({ type: 'envelope_transfer', amount: 5, fromEnvelope: null, toEnvelope: 'groc' }).value.value).toMatchObject({ from_envelope_id: null, to_envelope_id: 'groc' });
    expect(record({ type: 'envelope_transfer', amount: 5, fromEnvelope: 'groc', toEnvelope: 'groc' }).error.code).toBe('same_envelope');
  });

  it('records investment buys, refuses unit-less sells, and strips dividend extras', () => {
    const buy = record({ type: 'investment_transfer', amount: 500, direction: 'buy', fromAccount: 'chk', toAccount: 'broker', envelope: 'fun', units: 13.82, pricePerUnit: 36.18, fee: 2.59, symbol: ' dk0060609279 ' }).value.value;
    expect(buy).toMatchObject({ direction: 'buy', units: 13.82, pricePerUnit: 36.18, fee: 2.59, symbol: 'DK0060609279' });
    expect(record({ type: 'investment_transfer', amount: 5, direction: 'sell', fromAccount: 'broker', toAccount: 'chk' }).error.code).toBe('sell_needs_units');
    const div = record({ type: 'investment_transfer', amount: 5, direction: 'dividend', fromAccount: 'broker', toAccount: 'chk', fee: 1, units: 2, symbol: 'X' }).value.value;
    expect(div).not.toHaveProperty('fee');
    expect(div).not.toHaveProperty('units');
  });

  it('links interest income to a loan given (interestOf) and refuses any other link', () => {
    const d = deepFreeze({ ...data(), accounts: [...data().accounts, { id: 'lg', name: 'Loan to Sam', type: 'loan_given' }] });
    const rec = (input) => runCommand(registry, d, 'transaction.record', input, ctx());
    expect(rec({ type: 'income', amount: 12, account: 'chk', interestOf: 'lg' }).value.value).toMatchObject({ type: 'income', interest_of: 'lg' });
    expect(rec({ type: 'income', amount: 12, account: 'chk', interestOf: null }).value.value).not.toHaveProperty('interest_of');
    const notLoan = rec({ type: 'income', amount: 12, account: 'chk', interestOf: 'sav' });
    expect(notLoan.error.code).toBe('bad_input');
    expect(notLoan.error.params.errors[0].path).toBe('interestOf');
    expect(rec({ type: 'income', amount: 12, account: 'chk', interestOf: 'ghost' }).error.code).toBe('bad_input');
    expect(rec({ type: 'expense', amount: 12, account: 'chk', interestOf: 'lg' }).error).toMatchObject({ code: 'field_not_allowed', params: { field: 'interest_of' } });
  });

  it('records a loan principal as debt_payment', () => {
    expect(record({ type: 'debt_payment', amount: 200, fromAccount: 'chk', toAccount: 'loan' }).value.value).toMatchObject({ type: 'debt_payment', from_account: 'chk', to_account: 'loan', envelope_id: null });
  });

  it('refuses fields that do not belong to the type, and missing required ones', () => {
    expect(record({ type: 'account_transfer', amount: 5, fromAccount: 'chk', toAccount: 'sav', envelope: 'groc' }).error).toEqual({ code: 'field_not_allowed', params: { field: 'envelope_id', type: 'account_transfer' } });
    expect(record({ type: 'expense', amount: 5 }).error).toEqual({ code: 'field_required', params: { field: 'account' } });
  });

  it('links a posted forecast occurrence and tags a source', () => {
    expect(record({ type: 'expense', amount: 5, account: 'chk', fromBudget: 'rent:2026-10', source: 'ai-import' }).value.value).toMatchObject({ from_budget: 'rent:2026-10', source: 'ai-import' });
  });

  it('a row that settles a plan occurrence is stored as posted; other rows carry no status', () => {
    expect(record({ type: 'expense', amount: 5, account: 'chk', fromBudget: 'rent:2026-10' }).value.value.status).toBe('posted');
    expect(record({ type: 'expense', amount: 5, account: 'chk' }).value.value).not.toHaveProperty('status');
    expect(record({ type: 'expense', amount: 5, account: 'chk', fromBudget: null }).value.value).not.toHaveProperty('status');
  });

  it('stores the deliberate "No envelope" choice as is, but not inside splits', () => {
    expect(record({ type: 'expense', amount: 5, account: 'chk', envelope: '__none__' }).value.value.envelope_id).toBe('__none__');
    expect(record({ type: 'income', amount: 5, account: 'chk', envelope: '__none__' }).value.value.envelope_id).toBe('__none__');
    expect(record({ type: 'expense', amount: 5, account: 'chk', envelope: 'nope' }).error.code).toBe('bad_input');
    expect(record({ type: 'expense', amount: 6, account: 'chk', splits: [{ envelope: '__none__', amount: 3 }, { envelope: 'fun', amount: 3 }] }).error.code).toBe('bad_input');
  });

  it('refuses a zero amount and an unknown account', () => {
    expect(record({ type: 'expense', amount: 0, account: 'chk' }).error.code).toBe('bad_input');
    expect(record({ type: 'expense', amount: 1, account: 'visa' }).error.code).toBe('bad_input');
  });

  it('stores investment extras only when positive, rounded as the add form rounds them', () => {
    const inv = (extra) => record({ type: 'investment_transfer', amount: 5, direction: 'buy', fromAccount: 'chk', toAccount: 'broker', ...extra }).value.value;
    const zero = inv({ fee: 0, units: 0, pricePerUnit: 0, symbol: '   ' });
    for (const f of ['fee', 'units', 'pricePerUnit', 'symbol']) expect(zero).not.toHaveProperty(f);
    expect(inv({ fee: 0.001 })).not.toHaveProperty('fee');
    expect(inv({ fee: 2.595, units: 1.23456789, pricePerUnit: 36.123456 })).toMatchObject({ fee: 2.6, units: 1.234568, pricePerUnit: 36.12346 });
  });

  it('trims the payee and the note, and a blank note becomes null', () => {
    expect(record({ type: 'expense', amount: 1, account: 'chk', payee: '  A  ', note: '  n  ' }).value.value).toMatchObject({ payee: 'A', note: 'n' });
    expect(record({ type: 'expense', amount: 1, account: 'chk', note: '   ' }).value.value.note).toBeNull();
  });

  it('refuses a split over fewer than two envelopes, and a split drops the budget item', () => {
    const r = record({ type: 'expense', amount: 5, account: 'chk', splits: [{ envelope: 'groc', amount: 5 }] });
    expect(r.error).toEqual({ code: 'split_invalid', params: { problems: ['tooFewSplits'] } });
    const v = record({ type: 'expense', amount: 30, account: 'chk', budgetItem: 'rent', splits: [{ envelope: 'groc', amount: 20 }, { envelope: 'fun', amount: 10 }] }).value.value;
    expect(v).not.toHaveProperty('budget_item_id');
  });

  it('a split line can name the plan item it pays', () => {
    const v = record({ type: 'expense', amount: 30, account: 'chk', splits: [
      { envelope: 'groc', amount: 20, budgetItem: 'rent' }, { envelope: 'fun', amount: 10 },
    ] }).value.value;
    expect(v.envelope_splits).toEqual([
      { envelope_id: 'groc', amount: 20, budget_item_id: 'rent' }, { envelope_id: 'fun', amount: 10 },
    ]);
  });

  it('an envelope transfer always carries both envelope keys', () => {
    const v = record({ type: 'envelope_transfer', amount: 5, toEnvelope: 'groc' }).value.value;
    expect(v).toHaveProperty('from_envelope_id', null);
    expect(v.to_envelope_id).toBe('groc');
  });
});
