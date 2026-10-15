// Payee aliases (merged spellings renamed on new rows) and hidden payees.
import { describe, it, expect } from 'vitest';
import {
  getPayeeAliases, addPayeeAliases, removePayeeAlias, applyPayeeAliases,
  getHiddenPayees, setPayeeHidden, withAliasTargets,
} from '../js/state/payee-aliases.js';

describe('getPayeeAliases / getHiddenPayees', () => {
  it('reads defensively', () => {
    expect(getPayeeAliases(undefined)).toEqual({});
    expect(getPayeeAliases({ payeeAliases: [1] })).toEqual({});
    expect(getPayeeAliases({ payeeAliases: { 'lidl 1': 'Lidl', bad: 3, empty: '  ' } })).toEqual({ 'lidl 1': 'Lidl' });
    expect([...getHiddenPayees({ payeeHidden: ['a', 2, 'b'] })]).toEqual(['a', 'b']);
    expect(getHiddenPayees({}).size).toBe(0);
  });
});

describe('addPayeeAliases', () => {
  it('maps every merged-away spelling to the kept name, never the kept name itself (exact match)', () => {
    // 'Lidl' is spelled exactly like the target already, so it gets no alias;
    // the other two spellings, though they fold to the same key as 'Lidl', do.
    const out = addPayeeAliases({}, ['LIDL 1234', 'Lidl', 'lidl oy'], 'Lidl');
    expect(out).toEqual({ 'lidl 1234': 'Lidl', 'lidl oy': 'Lidl' });
  });

  it('records an alias for a case-only merge (same folded key as the target, different spelling)', () => {
    // Merging "lidl" into "Lidl": same folded key, but not the same exact
    // string, so a future "lidl" row should still arrive renamed.
    const out = addPayeeAliases({}, ['lidl'], 'Lidl');
    expect(out).toEqual({ lidl: 'Lidl' });
  });

  it('repoints aliases whose target was merged away, and drops an alias for the new kept name', () => {
    const before = { 'ah 12': 'AH', 'albert heijn': 'Albert Heijn' };
    const out = addPayeeAliases(before, ['AH'], 'Albert Heijn');
    expect(out).toEqual({ 'ah 12': 'Albert Heijn', ah: 'Albert Heijn' });
    const back = addPayeeAliases(out, ['Albert Heijn'], 'AH');
    expect(back['ah']).toBeUndefined();
    expect(back['albert heijn']).toBe('AH');
    expect(back['ah 12']).toBe('AH');
  });

  it('removes one alias', () => {
    expect(removePayeeAlias({ a: 'A', b: 'B' }, 'a')).toEqual({ b: 'B' });
  });
});

describe('applyPayeeAliases', () => {
  const aliases = { 'lidl 1234': 'Lidl' };
  const prev = [{ id: 'old', payee: 'LIDL 1234', type: 'expense' }];

  it('renames only rows that are new in this write', () => {
    const next = [
      { id: 'old', payee: 'LIDL 1234', type: 'expense' },
      { id: 'new', payee: ' lidl 1234 ', type: 'expense' },
    ];
    const { transactions, renamed } = applyPayeeAliases(prev, next, aliases);
    expect(renamed).toBe(1);
    expect(transactions[0]).toBe(next[0]);
    expect(transactions[1]).toEqual({ id: 'new', payee: 'Lidl', type: 'expense' });
  });

  it('leaves rows without an id and envelope-internal rows alone', () => {
    const next = [
      { payee: 'LIDL 1234', type: 'expense' },
      { id: 'f', payee: 'lidl 1234', type: 'fill' },
    ];
    const out = applyPayeeAliases([], next, aliases);
    expect(out.renamed).toBe(0);
    expect(out.transactions).toBe(next);
  });

  it('returns the same array when nothing matches or there are no aliases', () => {
    const next = [{ id: 'n', payee: 'Prisma', type: 'expense' }];
    expect(applyPayeeAliases([], next, aliases).transactions).toBe(next);
    expect(applyPayeeAliases([], next, {}).transactions).toBe(next);
  });
});

describe('setPayeeHidden', () => {
  it('adds and removes a lowercased key, sorted and unique', () => {
    expect(setPayeeHidden(['b'], 'A', true)).toEqual(['a', 'b']);
    expect(setPayeeHidden(['a', 'b'], 'a', true)).toEqual(['a', 'b']);
    expect(setPayeeHidden(['a', 'b'], 'A', false)).toEqual(['b']);
  });
});

describe('withAliasTargets', () => {
  it('adds the kept name of every remembered spelling in the set, lowercased', () => {
    const out = withAliasTargets(['LIDL 1234', 'Netflix'], { 'lidl 1234': 'Lidl' });
    expect([...out].sort()).toEqual(['lidl', 'lidl 1234', 'netflix']);
  });

  it('ignores blanks and non-strings, and returns a lowercased copy with no aliases', () => {
    expect([...withAliasTargets(['', null, 'Spotify'], {})]).toEqual(['spotify']);
  });
});
