import { describe, it, expect } from 'vitest';
import { validateSchema } from '../js/data.js';

describe('validateSchema', () => {
  it('accepts a valid v4 payload', () => {
    const bundle = {
      envelopes:    [{ id: 'e1', name: 'Food', category: 'Needs' }],
      budgetItems:  [],
      transactions: [{ id: 't1', type: 'expense', envelope_id: 'e1', amount: 5, account: 'bank', date: '2026-01-01' }],
      accounts:     [{ id: 'bank', name: 'Bank', initialBalance: 100 }],
      scheduled:    [],
      meta:         { schemaVersion: 4 },
    };
    const result = validateSchema(bundle);
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('flags non-array envelopes', () => {
    const bundle = { envelopes: 'not-an-array', budgetItems: [], transactions: [], accounts: [], scheduled: [], meta: {} };
    const r = validateSchema(bundle);
    expect(r.ok).toBe(false);
    expect(r.errors.some(e => e.includes('envelopes'))).toBe(true);
  });

  it('flags envelope missing id or name', () => {
    const bundle = {
      envelopes: [{ name: 'no-id' }, { id: 'x' /* no name */ }],
      budgetItems: [], transactions: [], accounts: [], scheduled: [], meta: {},
    };
    const r = validateSchema(bundle);
    expect(r.ok).toBe(false);
    expect(r.errors.length).toBeGreaterThanOrEqual(2);
  });

  it('flags transaction with invalid amount', () => {
    const bundle = {
      envelopes: [], budgetItems: [],
      transactions: [{ id: 't1', type: 'expense', envelope_id: 'e', amount: 'abc', account: 'bank', date: '2026-01-01' }],
      accounts: [], scheduled: [], meta: {},
    };
    const r = validateSchema(bundle);
    expect(r.ok).toBe(false);
    expect(r.errors.some(e => e.includes('t1') && e.includes('amount'))).toBe(true);
  });

  it('flags transaction with invalid date', () => {
    const bundle = {
      envelopes: [], budgetItems: [],
      transactions: [{ id: 't1', type: 'expense', amount: 5, date: 'not-a-date' }],
      accounts: [], scheduled: [], meta: {},
    };
    const r = validateSchema(bundle);
    expect(r.ok).toBe(false);
    expect(r.errors.some(e => e.includes('date'))).toBe(true);
  });

  it('flags account with non-finite initialBalance', () => {
    const bundle = {
      envelopes: [], budgetItems: [], transactions: [],
      accounts: [{ id: 'bank', name: 'Bank', initialBalance: 'bogus' }],
      scheduled: [], meta: {},
    };
    const r = validateSchema(bundle);
    expect(r.ok).toBe(false);
    expect(r.errors.some(e => e.includes('initialBalance'))).toBe(true);
  });

  it('flags missing or non-numeric meta.schemaVersion', () => {
    const mk = (meta) => ({
      envelopes: [], budgetItems: [], transactions: [], accounts: [], scheduled: [], meta,
    });
    const r1 = validateSchema(mk({}));
    expect(r1.ok).toBe(false);
    expect(r1.errors.some(e => e.includes('schemaVersion'))).toBe(true);

    const r2 = validateSchema(mk({ schemaVersion: '4' }));
    expect(r2.ok).toBe(false);
    expect(r2.errors.some(e => e.includes('schemaVersion'))).toBe(true);

    const r3 = validateSchema(mk({ schemaVersion: NaN }));
    expect(r3.ok).toBe(false);
    expect(r3.errors.some(e => e.includes('schemaVersion'))).toBe(true);
  });

  it('truncates error list at 20 to avoid UI overload', () => {
    const envelopes = [];
    for (let i = 0; i < 50; i++) envelopes.push({ /* missing id and name */ });
    const r = validateSchema({ envelopes, budgetItems: [], transactions: [], accounts: [], scheduled: [], meta: {} });
    expect(r.ok).toBe(false);
    expect(r.errors.length).toBeLessThanOrEqual(20);
    expect(r.truncated).toBe(true);
  });
});
