// `isAccountPickerEnabled` / `resolvePlanItemAccountId`: the plan editor's
// account-field rules, letting an expense item keep a chosen account whether
// or not it posts on a schedule while every other kind keeps today's rule.

import { describe, it, expect } from 'vitest';
import { isAccountPickerEnabled, accountEmptyLabelKey } from '../js/pages/budget-plan-account-rules.js';
import { resolvePlanItemAccountId } from '../js/core/plan-item-rules.js';

describe('isAccountPickerEnabled', () => {
  it('is always enabled for expense, scheduled or not', () => {
    expect(isAccountPickerEnabled('expense', true)).toBe(true);
    expect(isAccountPickerEnabled('expense', false)).toBe(true);
  });

  it('follows scheduling for income', () => {
    expect(isAccountPickerEnabled('income', true)).toBe(true);
    expect(isAccountPickerEnabled('income', false)).toBe(false);
  });

  it('follows scheduling for investment_transfer', () => {
    expect(isAccountPickerEnabled('investment_transfer', true)).toBe(true);
    expect(isAccountPickerEnabled('investment_transfer', false)).toBe(false);
  });

  it('follows scheduling for account_transfer (always true in practice, forced scheduled)', () => {
    expect(isAccountPickerEnabled('account_transfer', true)).toBe(true);
    expect(isAccountPickerEnabled('account_transfer', false)).toBe(false);
  });
});

describe('resolvePlanItemAccountId', () => {
  it('keeps the picker value for expense whether or not scheduled', () => {
    expect(resolvePlanItemAccountId('expense', true, 'acc-1')).toBe('acc-1');
    expect(resolvePlanItemAccountId('expense', false, 'acc-1')).toBe('acc-1');
  });

  it('keeps null for an unpicked expense account', () => {
    expect(resolvePlanItemAccountId('expense', false, null)).toBeNull();
  });

  it('clears the account for income when not scheduled', () => {
    expect(resolvePlanItemAccountId('income', false, 'acc-1')).toBeNull();
  });

  it('keeps the account for income when scheduled', () => {
    expect(resolvePlanItemAccountId('income', true, 'acc-1')).toBe('acc-1');
  });

  it('clears the account for investment_transfer when not scheduled', () => {
    expect(resolvePlanItemAccountId('investment_transfer', false, 'acc-1')).toBeNull();
  });

  it('keeps the account for investment_transfer when scheduled', () => {
    expect(resolvePlanItemAccountId('investment_transfer', true, 'acc-1')).toBe('acc-1');
  });

  it('keeps the account for account_transfer (always scheduled in practice)', () => {
    expect(resolvePlanItemAccountId('account_transfer', true, 'acc-1')).toBe('acc-1');
  });
});

describe('accountEmptyLabelKey', () => {
  it('reads "from history" only for an unscheduled expense-type item', () => {
    expect(accountEmptyLabelKey('expense', false)).toBe('budgetPlan.accountFromHistory');
    expect(accountEmptyLabelKey('expense', true)).toBe('budgetPlan.chooseAccount');
    for (const kind of ['income', 'investment_transfer', 'account_transfer']) {
      expect(accountEmptyLabelKey(kind, false)).toBe('budgetPlan.chooseAccount');
      expect(accountEmptyLabelKey(kind, true)).toBe('budgetPlan.chooseAccount');
    }
  });
});
