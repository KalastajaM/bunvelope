// Quick-filter button labels for the Net worth exclude picker's asset groups.
import { describe, it, expect } from 'vitest';
import { assetGroupQuickLabels } from '../js/pages/net-worth-quick-groups.js';

describe('assetGroupQuickLabels', () => {
  it('leaves a group label alone when it collides with nothing', () => {
    const groups = [{ label: 'Collectibles', ids: ['a1'] }];
    expect(assetGroupQuickLabels(groups, ['Spending accounts', 'Savings'], 'Asset or debt'))
      .toEqual([{ label: 'Collectibles', ids: ['a1'] }]);
  });

  it('suffixes a group whose name equals another quick button label', () => {
    const groups = [{ label: 'Savings', ids: ['a1', 'a2'] }];
    expect(assetGroupQuickLabels(groups, ['Spending accounts', 'Savings'], 'Asset or debt'))
      .toEqual([{ label: 'Savings · Asset or debt', ids: ['a1', 'a2'] }]);
  });

  it('only suffixes the colliding group, not the others', () => {
    const groups = [
      { label: 'Savings', ids: ['a1'] },
      { label: 'Collectibles', ids: ['a2'] },
    ];
    expect(assetGroupQuickLabels(groups, ['Savings'], 'Asset or debt')).toEqual([
      { label: 'Savings · Asset or debt', ids: ['a1'] },
      { label: 'Collectibles', ids: ['a2'] },
    ]);
  });

  it('handles no groups and no other labels', () => {
    expect(assetGroupQuickLabels([], [], 'Asset or debt')).toEqual([]);
    expect(assetGroupQuickLabels([{ label: 'X', ids: [] }], [], 'Asset or debt'))
      .toEqual([{ label: 'X', ids: [] }]);
  });
});
