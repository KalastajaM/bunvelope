// The Dashboard's "date to act on" card shows only the earliest alert from
// the Net worth simulation.
import { describe, it, expect } from 'vitest';
import { firstAlert } from '../js/pages/net-worth-alerts.js';

describe('firstAlert', () => {
  it('returns null for an empty or missing list', () => {
    expect(firstAlert([])).toBeNull();
    expect(firstAlert(undefined)).toBeNull();
  });

  it('picks the alert with the earliest firstDate', () => {
    const later = { kind: 'account-negative', id: 'a1', firstDate: '2026-11-05' };
    const earlier = { kind: 'envelope-short', id: 'e1', firstDate: '2026-10-01' };
    expect(firstAlert([later, earlier])).toBe(earlier);
  });

  it('keeps the existing order on a tie', () => {
    const first = { kind: 'account-negative', id: 'a1', firstDate: '2026-10-01' };
    const second = { kind: 'envelope-short', id: 'e1', firstDate: '2026-10-01' };
    expect(firstAlert([first, second])).toBe(first);
    expect(firstAlert([second, first])).toBe(second);
  });

  it('works with a single alert', () => {
    const only = { kind: 'unallocated-negative', id: null, firstDate: '2026-09-15' };
    expect(firstAlert([only])).toBe(only);
  });
});
