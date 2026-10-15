import { describe, it, expect } from 'vitest';
import { createRegistry } from '../js/core/registry.js';
import { registry } from '../js/core/index.js';
import { ok } from '../js/core/result.js';
import { makeCtx } from '../js/core/context.js';

const obj = { type: 'object', properties: {} };
const ctx = makeCtx({ now: new Date(2026, 9, 1), newId: () => 'id' });

describe('createRegistry', () => {
  it('registers, looks up and lists entries by name', () => {
    const r = createRegistry();
    r.defineQuery({ name: 'b.thing', summary: 'B', input: obj, run: () => ok(1) });
    r.defineCommand({ name: 'a.thing', summary: 'A', input: obj, execute: () => ok({ changes: {}, value: null }) });
    expect(r.get('a.thing').kind).toBe('command');
    expect(r.get('missing')).toBeNull();
    expect(r.list().map(e => e.name)).toEqual(['a.thing', 'b.thing']);
    expect(Object.isFrozen(r.get('a.thing'))).toBe(true);
  });

  it('refuses malformed definitions', () => {
    const r = createRegistry();
    expect(() => r.defineQuery({ name: 'Bad Name', summary: 'x', input: obj, run: () => ok(1) })).toThrow(TypeError);
    expect(() => r.defineQuery({ name: 'x', summary: '', input: obj, run: () => ok(1) })).toThrow(TypeError);
    expect(() => r.defineQuery({ name: 'x', summary: 'x', input: { type: 'string' }, run: () => ok(1) })).toThrow(TypeError);
    expect(() => r.defineCommand({ name: 'x', summary: 'x', input: obj })).toThrow(TypeError);
    expect(() => r.defineCommand({ name: 'y', summary: 'x', input: obj, execute: () => ok({}), payeeAliases: 'no' })).toThrow(TypeError);
    r.defineQuery({ name: 'x', summary: 'x', input: obj, run: () => ok(1) });
    expect(() => r.defineQuery({ name: 'x', summary: 'x', input: obj, run: () => ok(1) })).toThrow(TypeError);
  });
});

describe('ref.resolve', () => {
  const data = {
    meta: {}, transactions: [], envelopeTemplates: [{ id: 't1', name: 'Start of month' }],
    budgetItems: [{ id: 'b1', description: 'Rent' }],
    accounts: [{ id: 'amex', name: 'Amex' }, { id: 'old', name: 'Bank', archived: true }, { id: 'bank', name: 'Bank' }],
    envelopes: [{ id: 'g1', name: 'Groceries' }, { id: 'g2', name: 'groceries ' }],
  };
  const run = (input) => registry.get('ref.resolve').run(data, input, ctx);

  it('matches an exact id first, archived or not', () => {
    expect(run({ kind: 'account', name: 'old' })).toEqual(ok({ id: 'old', name: 'Bank' }));
  });

  it('matches a name case-insensitively among live rows', () => {
    expect(run({ kind: 'account', name: ' bank' })).toEqual(ok({ id: 'bank', name: 'Bank' }));
    expect(run({ kind: 'budgetItem', name: 'rent' })).toEqual(ok({ id: 'b1', name: 'Rent' }));
    expect(run({ kind: 'template', name: 'START OF MONTH' })).toEqual(ok({ id: 't1', name: 'Start of month' }));
  });

  it('reports no match and ambiguity', () => {
    expect(run({ kind: 'account', name: 'Visa' }).error.code).toBe('ref_not_found');
    const amb = run({ kind: 'envelope', name: 'Groceries' });
    expect(amb.error.code).toBe('ref_ambiguous');
    expect(amb.error.params.candidates.map(c => c.id)).toEqual(['g1', 'g2']);
  });
});
