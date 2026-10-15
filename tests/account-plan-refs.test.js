// Plan items using an account — the account delete/archive warnings.
import { describe, it, expect } from 'vitest';
import { planItemsUsingAccount, plannedItemsForecastingFromAccount } from '../js/pages/account-plan-refs.js';

describe('planItemsUsingAccount', () => {
  it('counts items referencing the account via account_id, to_account_id or investment_account_id', () => {
    const items = [
      { id: '1', as_schedule: true, account_id: 'acc1' },
      { id: '2', as_schedule: true, to_account_id: 'acc1' },
      { id: '3', as_schedule: true, investment_account_id: 'acc1' },
      { id: '4', as_schedule: true, account_id: 'acc2' },
    ];
    expect(planItemsUsingAccount(items, 'acc1')).toBe(3);
  });

  it('counts an item once even when it references the account under two fields', () => {
    const items = [{ id: '1', as_schedule: true, account_id: 'acc1', to_account_id: 'acc1' }];
    expect(planItemsUsingAccount(items, 'acc1')).toBe(1);
  });

  it('returns 0 when nothing references the account', () => {
    expect(planItemsUsingAccount([{ as_schedule: true, account_id: 'acc2' }], 'acc1')).toBe(0);
  });

  it('handles missing or empty input', () => {
    expect(planItemsUsingAccount([], 'acc1')).toBe(0);
    expect(planItemsUsingAccount(null, 'acc1')).toBe(0);
    expect(planItemsUsingAccount([{ as_schedule: true, account_id: 'acc1' }], '')).toBe(0);
    expect(planItemsUsingAccount([null, undefined, { as_schedule: true, account_id: 'acc1' }], 'acc1')).toBe(1);
  });

  it('leaves out items that never post: not scheduled, or Disabled', () => {
    const items = [
      { id: '1', as_schedule: false, account_id: 'acc1' },
      { id: '2', as_schedule: true, include: false, to_account_id: 'acc1' },
      { id: '3', as_schedule: true, include: true, investment_account_id: 'acc1' },
      { id: '4', as_schedule: true, account_id: 'acc1' },
    ];
    expect(planItemsUsingAccount(items, 'acc1')).toBe(2);
  });
});

describe('plannedItemsForecastingFromAccount', () => {
  it('counts unscheduled, enabled items naming the account, and nothing that posts', () => {
    const items = [
      { id: '1', as_schedule: false, account_id: 'acc1' },
      { id: '2', account_id: 'acc1' },
      { id: '3', as_schedule: false, include: false, account_id: 'acc1' },
      { id: '4', as_schedule: true, account_id: 'acc1' },
      { id: '5', as_schedule: false, account_id: 'acc2' },
      { id: '6', as_schedule: false, to_account_id: 'acc1' },
    ];
    expect(plannedItemsForecastingFromAccount(items, 'acc1')).toBe(2);
    // The two counts never overlap: one item is either scheduled or not.
    expect(planItemsUsingAccount(items, 'acc1')).toBe(1);
  });

  it('handles missing input', () => {
    expect(plannedItemsForecastingFromAccount(null, 'acc1')).toBe(0);
    expect(plannedItemsForecastingFromAccount([{ account_id: 'acc1' }], '')).toBe(0);
  });
});
