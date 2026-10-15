import { describe, it, expect } from 'vitest';
import { filterOptionGroups, foldText } from '../js/ui/option-filter.js';

const groups = [
  { label: 'Housing', options: [{ value: 'rent', text: 'Rent' }, { value: 'elec', text: 'Electricity' }] },
  { label: 'Food', options: [{ value: 'groc', text: 'Groceries' }, { value: 'cafe', text: 'Café & lunch' }] },
];

describe('filterOptionGroups', () => {
  it('returns everything for an empty query', () => {
    expect(filterOptionGroups(groups, '  ')).toBe(groups);
  });
  it('keeps matching options and drops empty groups', () => {
    expect(filterOptionGroups(groups, 'gro')).toEqual([
      { label: 'Food', options: [{ value: 'groc', text: 'Groceries' }] },
    ]);
  });
  it('keeps a whole group when its label matches', () => {
    expect(filterOptionGroups(groups, 'housing')[0].options).toHaveLength(2);
  });
  it('ignores case and accents', () => {
    expect(filterOptionGroups(groups, 'CAFE')[0].options[0].value).toBe('cafe');
    expect(foldText('Ärrä')).toBe('arra');
  });
});
