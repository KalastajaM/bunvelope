import { describe, it, expect } from 'vitest';
import { parseRoute, serializeRoute, historyActionFor, startupPage } from '../js/ui/router.js';

const KNOWN = ['dashboard', 'transactions', 'budget-plan', 'settings'];

describe('parseRoute', () => {
  it('reads the canonical #/page form', () => {
    expect(parseRoute('#/transactions', KNOWN)).toBe('transactions');
    expect(parseRoute('#/budget-plan', KNOWN)).toBe('budget-plan');
  });

  it('tolerates hand-typed variants', () => {
    expect(parseRoute('#transactions', KNOWN)).toBe('transactions');
    expect(parseRoute('#/transactions/', KNOWN)).toBe('transactions');
    expect(parseRoute('#/settings?x=1', KNOWN)).toBe('settings');
  });

  it('returns null for empty, unknown or malformed hashes', () => {
    expect(parseRoute('', KNOWN)).toBeNull();
    expect(parseRoute('#', KNOWN)).toBeNull();
    expect(parseRoute('#/', KNOWN)).toBeNull();
    expect(parseRoute('#/nope', KNOWN)).toBeNull();
    expect(parseRoute('#/%E0%A4%A', KNOWN)).toBeNull();
    expect(parseRoute(undefined, KNOWN)).toBeNull();
  });

  it('round-trips serializeRoute', () => {
    for (const p of KNOWN) expect(parseRoute(serializeRoute(p), KNOWN)).toBe(p);
  });
});

describe('historyActionFor', () => {
  it('pushes when moving to a different page', () => {
    expect(historyActionFor({ page: 'transactions', currentHash: '#/dashboard', first: false })).toBe('push');
  });

  it('does not grow history on a re-render of the current page', () => {
    expect(historyActionFor({ page: 'transactions', currentHash: '#/transactions', first: false })).toBe('none');
  });

  it('replaces the entry on the first render after a budget load', () => {
    expect(historyActionFor({ page: 'dashboard', currentHash: '', first: true })).toBe('replace');
    expect(historyActionFor({ page: 'settings', currentHash: '#/settings', first: true })).toBe('none');
  });
});

describe('startupPage', () => {
  it('restores the deep-linked page when the loader asks for the default', () => {
    expect(startupPage({ requested: 'dashboard', filter: undefined, hash: '#/settings', known: KNOWN })).toBe('settings');
  });

  it('falls back to the overview for an unknown hash', () => {
    expect(startupPage({ requested: 'dashboard', filter: undefined, hash: '#/bogus', known: KNOWN })).toBe('dashboard');
    expect(startupPage({ requested: 'dashboard', filter: undefined, hash: '', known: KNOWN })).toBe('dashboard');
  });

  it('honours an explicit page or filter over the URL', () => {
    expect(startupPage({ requested: 'transactions', filter: undefined, hash: '#/settings', known: KNOWN })).toBe('transactions');
    expect(startupPage({ requested: 'dashboard', filter: 'x', hash: '#/settings', known: KNOWN })).toBe('dashboard');
  });
});
