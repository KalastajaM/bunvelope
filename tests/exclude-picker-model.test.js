import { describe, it, expect } from 'vitest';
import { sectionView } from '../js/ui/exclude-picker-model.js';
import { foldText } from '../js/ui/option-filter.js';

const item = (id, label) => ({ id, label });

const plainSection = {
  groups: [
    { label: 'Housing', items: [item('rent', 'Rent'), item('elec', 'Electricity')] },
    { label: 'Food', items: [item('groc', 'Groceries'), item('cafe', 'Café & lunch')] },
  ],
};

describe('sectionView — no search, no pin/cap', () => {
  it('keeps the original grouping unchanged', () => {
    const out = sectionView(plainSection, new Set(), '', 'Excluded');
    expect(out).toEqual({
      groups: [
        { label: 'Housing', items: [item('rent', 'Rent'), item('elec', 'Electricity')] },
        { label: 'Food', items: [item('groc', 'Groceries'), item('cafe', 'Café & lunch')] },
      ],
      hidden: 0,
      total: 4,
    });
  });

  it('total always counts every item in the section', () => {
    const out = sectionView(plainSection, new Set(['rent']), '', 'Excluded');
    expect(out.total).toBe(4);
  });
});

describe('sectionView — searching', () => {
  it('matches across groups by group label + item label, dropping empty groups', () => {
    const out = sectionView(plainSection, new Set(), foldText('gro'), 'Excluded');
    expect(out).toEqual({
      groups: [{ label: 'Food', items: [item('groc', 'Groceries')] }],
      hidden: 0,
      total: 4,
    });
  });

  it('ignores pin and cap while searching', () => {
    const section = { ...plainSection, pinSelected: true, cap: 1 };
    const out = sectionView(section, new Set(['rent', 'elec']), foldText('e'), 'Excluded');
    // Every item's "group label + item label" contains "e" somewhere (Rent,
    // Electricity, Groceries, Café all do), so all 4 match — well past the
    // cap of 1 — and none is pulled into a leading "Excluded" group despite
    // both being pinned.
    expect(out.hidden).toBe(0);
    expect(out.groups.find(g => g.label === 'Excluded')).toBeUndefined();
    const total = out.groups.reduce((s, g) => s + g.items.length, 0);
    expect(total).toBe(4);
  });
});

describe('sectionView — pinSelected', () => {
  it('puts chosen items first under the pinned label, in original order, removed from their groups', () => {
    const section = { ...plainSection, pinSelected: true };
    const out = sectionView(section, new Set(['cafe', 'rent']), '', 'Excluded');
    expect(out.groups[0]).toEqual({ label: 'Excluded', items: [item('rent', 'Rent'), item('cafe', 'Café & lunch')] });
    expect(out.groups[1]).toEqual({ label: 'Housing', items: [item('elec', 'Electricity')] });
    expect(out.groups[2]).toEqual({ label: 'Food', items: [item('groc', 'Groceries')] });
  });

  it('omits the pinned group entirely when nothing is chosen', () => {
    const section = { ...plainSection, pinSelected: true };
    const out = sectionView(section, new Set(), '', 'Excluded');
    expect(out.groups.some(g => g.label === 'Excluded')).toBe(false);
    expect(out.groups).toHaveLength(2);
  });

  it('drops a group left empty once its only item is pinned', () => {
    const section = { groups: [{ label: 'Solo', items: [item('a', 'A')] }], pinSelected: true };
    const out = sectionView(section, new Set(['a']), '', 'Excluded');
    expect(out.groups).toEqual([{ label: 'Excluded', items: [item('a', 'A')] }]);
  });
});

describe('sectionView — cap', () => {
  it('keeps only the first N non-pinned items in group order and reports hidden', () => {
    const section = { ...plainSection, cap: 3 };
    const out = sectionView(section, new Set(), '', 'Excluded');
    expect(out.groups).toEqual([
      { label: 'Housing', items: [item('rent', 'Rent'), item('elec', 'Electricity')] },
      { label: 'Food', items: [item('groc', 'Groceries')] },
    ]);
    expect(out.hidden).toBe(1);
    expect(out.total).toBe(4);
  });

  it('drops a group emptied entirely by the cap', () => {
    const section = { ...plainSection, cap: 2 };
    const out = sectionView(section, new Set(), '', 'Excluded');
    expect(out.groups).toEqual([{ label: 'Housing', items: [item('rent', 'Rent'), item('elec', 'Electricity')] }]);
    expect(out.hidden).toBe(2);
  });

  it('pinned items do not count against the cap', () => {
    const section = { ...plainSection, pinSelected: true, cap: 2 };
    // 'rent' is pinned; the cap of 2 applies only to the 3 remaining items.
    const out = sectionView(section, new Set(['rent']), '', 'Excluded');
    expect(out.groups[0]).toEqual({ label: 'Excluded', items: [item('rent', 'Rent')] });
    expect(out.groups[1]).toEqual({ label: 'Housing', items: [item('elec', 'Electricity')] });
    expect(out.groups[2]).toEqual({ label: 'Food', items: [item('groc', 'Groceries')] });
    expect(out.hidden).toBe(1); // 'Café & lunch' left out
  });

  it('a cap of 0 hides every non-pinned item', () => {
    const section = { ...plainSection, cap: 0 };
    const out = sectionView(section, new Set(), '', 'Excluded');
    expect(out.groups).toEqual([]);
    expect(out.hidden).toBe(4);
  });
});
