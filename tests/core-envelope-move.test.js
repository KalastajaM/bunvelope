import { describe, it, expect } from 'vitest';
import { registry } from '../js/core/index.js';
import { runCommand } from '../js/core/pipeline.js';
import { makeCtx } from '../js/core/context.js';

function deepFreeze(o) { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); Object.values(o).forEach(deepFreeze); } return o; }
const NOW = new Date(2026, 9, 2, 10, 0, 0);
const ctx = () => makeCtx({ now: NOW, newId: (() => { let n = 0; return () => `n${++n}`; })() });
const data = () => deepFreeze({
  meta: {}, budgetItems: [], envelopeTemplates: [],
  accounts: [{ id: 'chk', name: 'Checking' }],
  envelopes: [{ id: 'groc', name: 'Groceries' }, { id: 'fun', name: 'Fun' }],
  transactions: [],
});

const move = (input) => runCommand(registry, data(), 'envelope.move', input, ctx());
const record = (input) => runCommand(registry, data(), 'transaction.record', input, ctx());

describe('envelope.move', () => {
  it('stores the same row as transaction.record for envelope_transfer', () => {
    const moveResult = move({ fromEnvelope: 'groc', toEnvelope: 'fun', amount: '12.50' });
    const recordResult = record({ type: 'envelope_transfer', fromEnvelope: 'groc', toEnvelope: 'fun', amount: '12.50' });

    const moveRow = moveResult.value.value;
    const recordRow = recordResult.value.value;

    // Remove id as it will be different
    const { id: _moveId, ...moveWithoutId } = moveRow;
    const { id: _recordId, ...recordWithoutId } = recordRow;

    expect(moveWithoutId).toEqual(recordWithoutId);
  });

  it('defaults the payee to empty string', () => {
    const r = move({ fromEnvelope: 'groc', toEnvelope: 'fun', amount: 5 }).value.value;
    expect(r.payee).toBe('');
  });

  it('defaults the date to today', () => {
    const r = move({ fromEnvelope: 'groc', toEnvelope: 'fun', amount: 5 }).value.value;
    expect(r.date).toBe('2026-10-02');
  });

  it('accepts explicit null for fromEnvelope (unallocated)', () => {
    const r = move({ fromEnvelope: null, toEnvelope: 'groc', amount: 5 }).value.value;
    expect(r.from_envelope_id).toBeNull();
    expect(r.to_envelope_id).toBe('groc');
  });

  it('accepts explicit null for toEnvelope (unallocated)', () => {
    const r = move({ fromEnvelope: 'groc', toEnvelope: null, amount: 5 }).value.value;
    expect(r.from_envelope_id).toBe('groc');
    expect(r.to_envelope_id).toBeNull();
  });

  it('rejects same_envelope error', () => {
    expect(move({ fromEnvelope: 'groc', toEnvelope: 'groc', amount: 5 }).error.code).toBe('same_envelope');
  });

  it('rejects same_envelope when both are null (unallocated)', () => {
    expect(move({ fromEnvelope: null, toEnvelope: null, amount: 5 }).error.code).toBe('same_envelope');
  });

  it('refuses a call that omits an envelope key (null must be explicit)', () => {
    expect(move({ toEnvelope: 'fun', amount: 5 }).error.code).toBe('bad_input');
    expect(move({ fromEnvelope: 'groc', amount: 5 }).error.code).toBe('bad_input');
  });

  it('stores a caller-supplied payee', () => {
    expect(move({ fromEnvelope: 'groc', toEnvelope: 'fun', amount: 5, payee: 'Rebalance' }).value.value.payee).toBe('Rebalance');
  });

  it('does not store force on the row (it only lifts the policy checks)', () => {
    const row = move({ fromEnvelope: 'groc', toEnvelope: 'fun', amount: 5, force: true }).value.value;
    expect(row).not.toHaveProperty('force');
  });

  it('rejects unknown envelope with bad_input', () => {
    expect(move({ fromEnvelope: 'unknown', toEnvelope: 'groc', amount: 5 }).error.code).toBe('bad_input');
    expect(move({ fromEnvelope: 'groc', toEnvelope: 'unknown', amount: 5 }).error.code).toBe('bad_input');
  });

  it('accepts optional date, note, and force parameters', () => {
    const r = move({ fromEnvelope: 'groc', toEnvelope: 'fun', amount: 5, date: '2026-10-01', note: 'test transfer', force: true }).value.value;
    expect(r.date).toBe('2026-10-01');
    expect(r.note).toBe('test transfer');
  });

  it('trims the note and converts blank to null', () => {
    expect(move({ fromEnvelope: 'groc', toEnvelope: 'fun', amount: 1, note: '  n  ' }).value.value.note).toBe('n');
    expect(move({ fromEnvelope: 'groc', toEnvelope: 'fun', amount: 1, note: '   ' }).value.value.note).toBeNull();
  });

  it('rounds the amount using money rounding', () => {
    const r = move({ fromEnvelope: 'groc', toEnvelope: 'fun', amount: '12.125' }).value.value;
    expect(r.amount).toBe(12.13);
  });

  it('returns the row as the value', () => {
    const result = move({ fromEnvelope: 'groc', toEnvelope: 'fun', amount: 5 });
    expect(result.ok).toBe(true);
    expect(result.value.value.type).toBe('envelope_transfer');
    expect(result.value.value.from_envelope_id).toBe('groc');
    expect(result.value.value.to_envelope_id).toBe('fun');
  });
});
