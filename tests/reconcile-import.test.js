import { describe, it, expect } from 'vitest';
import * as importing from '../js/import/reconcile-import.js';

const state = {
  accounts: [{ id: 'bank', name: 'Checking' }, { id: 'other', name: 'Savings' }],
  envelopes: [{ id: 'food', name: 'Food' }], meta: {},
  transactions: [{ id: 'old', account: 'bank', type: 'expense', amount: 12, date: '2026-09-01', payee: 'Shop', envelope_id: 'food' }],
};
describe('reconciliation import preparation', () => {
  it('excludes exact bookings but keeps uncertain matches with the existing row for comparison', () => {
    const result = importing.prepareReconcileImport({ state, accountId: 'bank', rows: [
      { date: '2026-09-02', payee: 'Shop', amount: -12 },
    ] });
    expect(result.rows[0]).toMatchObject({ account: 'bank', type: 'expense', amount: 12, envelope_id: 'food', importMatch: { id: 'old' } });
    expect(importing.prepareReconcileImport({ state, accountId: 'bank', rows: [
      { date: '2026-09-01', payee: 'Shop', amount: -12 },
    ] }).rows).toEqual([]);
  });
  it('filters positively identified other accounts and asks for confirmation for unidentified rows', () => {
    const result = importing.filterImportAccount([
      { sourceAccount: 'Checking', payee: 'A' },
      { sourceAccount: 'Savings', payee: 'B' },
      { payee: 'C' },
    ], state.accounts, 'bank');
    expect(result.rows.map(r => r.payee)).toEqual(['A', 'C']);
    expect(result.needsConfirmation).toBe(true);
    expect(result.excluded).toBe(1);
  });
  it('never treats the counterparty account as the statement account', () => {
    expect(importing.csvSourceAccountColumn(['Date', 'Recipient IBAN', 'Amount'])).toBe(-1);
    expect(importing.csvSourceAccountColumn(['Date', 'Account', 'Amount'])).toBe(1);
  });
});
