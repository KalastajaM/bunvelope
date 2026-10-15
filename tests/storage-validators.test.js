import { describe, it, expect } from 'vitest';
import {
  validateBundle,
  validateCollection,
  assertCollection,
} from '../js/storage/validators.js';

describe('validateBundle', () => {
  it('accepts a minimal v7 bundle', () => {
    const bundle = {
      envelopes: [{ id: 'e1', name: 'Groceries' }],
      accounts: [{ id: 'a1', name: 'Checking' }],
      transactions: [{ id: 't1', type: 'expense', amount: 5, date: '2026-01-01' }],
      budgetItems: [{ id: 'b1' }],
      envelopeTemplates: [],
      meta: { schemaVersion: 8 },
    };
    expect(validateBundle(bundle).ok).toBe(true);
  });

  it('flags missing required arrays', () => {
    const bundle = { meta: { schemaVersion: 8 } };
    const r = validateBundle(bundle);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes('envelopes'))).toBe(true);
    expect(r.errors.some((e) => e.includes('accounts'))).toBe(true);
    expect(r.errors.some((e) => e.includes('transactions'))).toBe(true);
  });

  it('treats envelopeTemplates as optional', () => {
    const bundle = {
      envelopes: [],
      accounts: [],
      transactions: [],
      budgetItems: [],
      meta: { schemaVersion: 8 },
    };
    expect(validateBundle(bundle).ok).toBe(true);
  });
});

describe('validateCollection', () => {
  it('returns ok for unknown keys (forward-compat for new file types)', () => {
    expect(validateCollection('unknown', null).ok).toBe(true);
  });

  it('catches non-finite transaction amounts', () => {
    const r = validateCollection('transactions', [
      { id: 't1', type: 'expense', amount: 'not-a-number', date: '2026-01-01' },
    ]);
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatch(/invalid amount/);
  });

  it('catches malformed dates', () => {
    const r = validateCollection('transactions', [
      { id: 't1', type: 'expense', amount: 1, date: '2026-13-99' },
    ]);
    expect(r.ok).toBe(false);
  });

  it('routes by on-disk filename too', () => {
    const r = validateCollection('budget-items.json', 'not-an-array');
    expect(r.ok).toBe(false);
  });
});

describe('assertCollection', () => {
  it('passes silently when valid', () => {
    expect(() => assertCollection('envelopes', [{ id: 'e1', name: 'X' }])).not.toThrow();
  });

  it('throws with validationErrors attached when invalid', () => {
    try {
      assertCollection('envelopes', [{ id: '', name: '' }]);
      throw new Error('expected throw');
    } catch (err) {
      expect(err.message).toMatch(/Invalid envelopes/);
      expect(Array.isArray(err.validationErrors)).toBe(true);
      expect(err.validationErrors.length).toBeGreaterThan(0);
    }
  });
});
