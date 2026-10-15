import { describe, test, expect } from 'vitest';
import {
  incomeItemsFor, nextMonthOf, todayYmdOf, defaultAccountId, defaultChange,
} from '../js/pages/net-worth-whatif.js';

describe('incomeItemsFor', () => {
  test('keeps income and dividend-direction investment transfers, drops the rest', () => {
    const items = [
      { id: 'i1', kind: 'income' },
      { id: 'i2', kind: 'investment_transfer', direction: 'dividend' },
      { id: 'i3', kind: 'investment_transfer', direction: 'buy' },
      { id: 'i4', kind: 'expense' },
    ];
    expect(incomeItemsFor(items).map(i => i.id)).toEqual(['i1', 'i2']);
  });

  test('handles a missing/undefined list', () => {
    expect(incomeItemsFor(undefined)).toEqual([]);
  });
});

describe('nextMonthOf / todayYmdOf', () => {
  test('nextMonthOf rolls over the year in December', () => {
    expect(nextMonthOf(new Date(2026, 11, 15))).toBe('2027-01');
  });

  test('nextMonthOf mid-year', () => {
    expect(nextMonthOf(new Date(2026, 8, 28))).toBe('2026-10');
  });

  test('todayYmdOf pads month and day', () => {
    expect(todayYmdOf(new Date(2026, 0, 5))).toBe('2026-01-05');
  });
});

describe('defaultAccountId', () => {
  test('prefers a non-archived spending account', () => {
    const accounts = [
      { id: 'asset1', type: 'asset' },
      { id: 'bank1', type: 'bank' },
      { id: 'inv1', type: 'investment' },
    ];
    expect(defaultAccountId(accounts)).toBe('bank1');
  });

  test('skips archived accounts', () => {
    const accounts = [
      { id: 'bank1', type: 'bank', archived: true },
      { id: 'bank2', type: 'bank' },
    ];
    expect(defaultAccountId(accounts)).toBe('bank2');
  });

  test('falls back to the first non-archived account when none is a spending account', () => {
    const accounts = [
      { id: 'asset1', type: 'asset' },
      { id: 'inv1', type: 'investment' },
    ];
    expect(defaultAccountId(accounts)).toBe('asset1');
  });

  test('null when every account is archived or there are none', () => {
    expect(defaultAccountId([{ id: 'a', type: 'bank', archived: true }])).toBeNull();
    expect(defaultAccountId([])).toBeNull();
    expect(defaultAccountId(undefined)).toBeNull();
  });
});

describe('defaultChange', () => {
  const today = new Date(2026, 8, 28); // 2026-09-28
  const accounts = [{ id: 'bank1', type: 'bank' }];

  test('income: 0%, from next month', () => {
    expect(defaultChange('income', { today, accounts })).toEqual({ type: 'income', pct: 0, from: '2026-10' });
  });

  test('monthly: 0 amount, default account, next month, day 1', () => {
    expect(defaultChange('monthly', { today, accounts })).toEqual({
      type: 'monthly', amount: 0, account: 'bank1', from: '2026-10', day: 1,
    });
  });

  test('oneoff: today\'s date, 0 amount, default account, empty label', () => {
    expect(defaultChange('oneoff', { today, accounts })).toEqual({
      type: 'oneoff', date: '2026-09-28', amount: 0, account: 'bank1', label: '',
    });
  });

  test('stress: the first (most severe) scenario, from next month', () => {
    expect(defaultChange('stress', { today, accounts })).toEqual({ type: 'stress', scenario: 'A', from: '2026-10' });
  });

  test('unknown type returns null', () => {
    expect(defaultChange('bogus', { today, accounts })).toBeNull();
  });
});

describe('what-if review fixes', () => {
  test('offers only enabled income items', () => {
    const items = [
      { id: 'a', kind: 'income', include: true },
      { id: 'b', kind: 'income', include: false },
      { id: 'c', kind: 'income' },
      { id: 'd', kind: 'expense', include: true },
    ];
    expect(incomeItemsFor(items).map(i => i.id)).toEqual(['a', 'c']);
  });
});
