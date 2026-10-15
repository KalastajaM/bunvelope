// Page filters' saved exclusions: per page and budget, validated on load.
import { describe, it, expect } from 'vitest';
import {
  pageFilterKey, sanitizeExclusions, exclusionCount, loadPageFilter, savePageFilter, budgetKeyOf,
} from '../js/ui/page-filter.js';

function memoryStorage() {
  const data = new Map();
  return {
    data,
    getItem: k => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => { data.set(k, String(v)); },
    removeItem: k => { data.delete(k); },
  };
}
const throwing = { getItem() { throw new Error('x'); }, setItem() { throw new Error('x'); }, removeItem() { throw new Error('x'); } };
const allowed = () => ({ envelopes: new Set(['food', 'house']), payees: new Set(['Store', '(no payee)']) });

describe('page filter storage', () => {
  it('keys by page and budget, with a default budget', () => {
    expect(pageFilterKey('reports', 'My budget')).toBe('bv.pageFilter.reports.My budget');
    expect(pageFilterKey('reports', undefined)).toBe('bv.pageFilter.reports._default');
  });

  it('keys a cloud budget by id, so a rename keeps its exclusions', () => {
    expect(budgetKeyOf({ kind: 'cloud', budgetId: 'b1', name: 'Home' })).toBe('cloud:b1');
    expect(budgetKeyOf({ name: 'Guest (demo)' })).toBe('Guest (demo)');
    expect(budgetKeyOf(null)).toBeUndefined();
    expect(pageFilterKey('reports', budgetKeyOf(null))).toBe('bv.pageFilter.reports._default');
  });

  it('keeps only known, unique string ids per section and fills missing sections', () => {
    expect(sanitizeExclusions({ envelopes: ['house', 'gone', 3, 'house'], payees: 'Store', extra: ['x'] }, allowed()))
      .toEqual({ envelopes: ['house'], payees: [] });
    expect(sanitizeExclusions(null, allowed())).toEqual({ envelopes: [], payees: [] });
  });

  it('counts exclusions across sections', () => {
    expect(exclusionCount({ envelopes: ['a'], payees: ['b', 'c'] })).toBe(3);
    expect(exclusionCount({ envelopes: [], payees: [] })).toBe(0);
  });

  it('saves per budget, loads validated, and removes the key when empty', () => {
    const s = memoryStorage();
    savePageFilter('reports', 'A', { envelopes: ['house'], payees: ['Store'] }, s);
    expect(loadPageFilter('reports', 'A', allowed(), s)).toEqual({ envelopes: ['house'], payees: ['Store'] });
    expect(loadPageFilter('reports', 'B', allowed(), s)).toEqual({ envelopes: [], payees: [] });
    savePageFilter('reports', 'A', { envelopes: [], payees: [] }, s);
    expect(s.data.has('bv.pageFilter.reports.A')).toBe(false);
    s.setItem('bv.pageFilter.reports.C', '{bad');
    expect(loadPageFilter('reports', 'C', allowed(), s)).toEqual({ envelopes: [], payees: [] });
  });

  it('survives missing or throwing storage', () => {
    expect(loadPageFilter('reports', 'A', allowed(), null)).toEqual({ envelopes: [], payees: [] });
    expect(loadPageFilter('reports', 'A', allowed(), throwing)).toEqual({ envelopes: [], payees: [] });
    expect(() => savePageFilter('reports', 'A', { envelopes: ['food'], payees: [] }, throwing)).not.toThrow();
    expect(() => savePageFilter('reports', 'A', { envelopes: ['food'], payees: [] }, null)).not.toThrow();
  });

  it('keeps a saved selection in memory when storage is missing or blocked', () => {
    for (const storage of [null, throwing]) {
      savePageFilter('reports', 'Mem', { envelopes: ['house', 'gone'], payees: ['Store'] }, storage);
      expect(loadPageFilter('reports', 'Mem', allowed(), storage)).toEqual({ envelopes: ['house'], payees: ['Store'] });
      expect(loadPageFilter('reports', 'Other', allowed(), storage)).toEqual({ envelopes: [], payees: [] });
      savePageFilter('reports', 'Mem', { envelopes: [], payees: [] }, storage);
      expect(loadPageFilter('reports', 'Mem', allowed(), storage)).toEqual({ envelopes: [], payees: [] });
    }
  });

  it('keeps the latest save when storage can be read but not written (quota full)', () => {
    const s = memoryStorage();
    savePageFilter('reports', 'Full', { envelopes: ['house'], payees: [] }, s);
    const full = { ...s, setItem() { throw new Error('quota'); }, removeItem() { throw new Error('quota'); } };
    savePageFilter('reports', 'Full', { envelopes: ['food'], payees: [] }, full);
    expect(loadPageFilter('reports', 'Full', allowed(), full)).toEqual({ envelopes: ['food'], payees: [] });
    savePageFilter('reports', 'Full', { envelopes: [], payees: [] }, full);
    expect(loadPageFilter('reports', 'Full', allowed(), full)).toEqual({ envelopes: [], payees: [] });
  });

  it('with prune, drops ids that no longer exist from storage too', () => {
    const s = memoryStorage();
    s.setItem('bv.pageFilter.reports.P', JSON.stringify({ envelopes: ['house'], payees: ['Store', 'Merged away'] }));
    expect(loadPageFilter('reports', 'P', allowed(), s)).toEqual({ envelopes: ['house'], payees: ['Store'] });
    expect(JSON.parse(s.getItem('bv.pageFilter.reports.P')).payees).toEqual(['Store', 'Merged away']);
    expect(loadPageFilter('reports', 'P', allowed(), s, { prune: true })).toEqual({ envelopes: ['house'], payees: ['Store'] });
    expect(JSON.parse(s.getItem('bv.pageFilter.reports.P')).payees).toEqual(['Store']);
    // So a payee that comes back later is not silently excluded again.
    const back = { envelopes: new Set(['food', 'house']), payees: new Set(['Store', 'Merged away']) };
    expect(loadPageFilter('reports', 'P', back, s).payees).toEqual(['Store']);
  });
});
