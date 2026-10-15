import { describe, it, expect } from 'vitest';
import { transferRowName, TRANSFER_ROW_COLOR } from '../js/pages/budget-plan-transfer.js';

const ACCOUNTS = [
  { id: 'checking', name: 'Checking' },
  { id: 'savings', name: 'Savings' },
];

describe('transferRowName', () => {
  it('builds "from → to" from account names when both resolve', () => {
    const item = { account_id: 'checking', to_account_id: 'savings' };
    expect(transferRowName(item, ACCOUNTS)).toBe('Checking → Savings');
  });

  it('falls back to the raw id when an account was deleted', () => {
    const item = { account_id: 'checking', to_account_id: 'gone' };
    expect(transferRowName(item, ACCOUNTS)).toBe('Checking → gone');
  });

  it('falls back to "?" when an id is missing entirely', () => {
    const item = { account_id: null, to_account_id: 'savings' };
    expect(transferRowName(item, ACCOUNTS)).toBe('? → Savings');
  });

  it('handles an empty or missing accounts list without throwing', () => {
    const item = { account_id: 'checking', to_account_id: 'savings' };
    expect(transferRowName(item, [])).toBe('checking → savings');
    expect(transferRowName(item, undefined)).toBe('checking → savings');
  });

  it('handles a missing item without throwing', () => {
    expect(transferRowName(undefined, ACCOUNTS)).toBe('? → ?');
  });
});

describe('TRANSFER_ROW_COLOR', () => {
  it('is a neutral colour, not the income green', () => {
    expect(TRANSFER_ROW_COLOR).not.toBe('#34c759');
    expect(TRANSFER_ROW_COLOR).toMatch(/^#[0-9a-f]{6}$/i);
  });
});
