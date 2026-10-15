// §1.3 — duplicate ids were detected after the fact by runInvariantCheck and
// never prevented. These assert the write-path validators refuse them, so a
// corrupting import is a refused import rather than a corrupted ledger.
import { describe, it, expect } from 'vitest';
import {
  validateTransactions, validateEnvelopes, validateAccounts,
  validateBudgetItems, validateEnvelopeTemplates, validateCollection,
} from '../js/storage/validators.js';

const tx = (id, over = {}) => ({ id, type: 'expense', amount: 1, date: '2026-01-01', ...over });

describe('id uniqueness at the storage boundary', () => {
  it('validateTransactions rejects two rows sharing an id', () => {
    const r = validateTransactions([tx('t1'), tx('t2'), tx('t1')]);
    expect(r.ok).toBe(false);
    expect(r.errors.join('\n')).toMatch(/duplicate id "t1"/);
  });

  it('validateTransactions now requires an id', () => {
    const r = validateTransactions([{ type: 'expense', amount: 1, date: '2026-01-01' }]);
    expect(r.ok).toBe(false);
    expect(r.errors.join('\n')).toMatch(/missing id/);
  });

  it('validateTransactions accepts a clean array', () => {
    expect(validateTransactions([tx('a'), tx('b')]).ok).toBe(true);
  });

  it.each([
    ['envelopes',         validateEnvelopes,         id => ({ id, name: 'E' })],
    ['accounts',          validateAccounts,          id => ({ id, name: 'A' })],
    ['budgetItems',       validateBudgetItems,       id => ({ id })],
    ['envelopeTemplates', validateEnvelopeTemplates, id => ({ id })],
  ])('%s rejects a duplicate id', (name, validate, make) => {
    const clean = validate([make('x'), make('y')]);
    expect(clean.ok).toBe(true);

    const dirty = validate([make('x'), make('y'), make('x')]);
    expect(dirty.ok).toBe(false);
    expect(dirty.errors.join('\n')).toMatch(new RegExp(`${name}\\[2\\] duplicate id "x"`));
  });

  it('the save path refuses a duplicate, so it never reaches disk', () => {
    // validateCollection is what assertCollection (and therefore every
    // writeJson/writeBatch) runs before touching the folder.
    const r = validateCollection('transactions.json', [tx('dup'), tx('dup')]);
    expect(r.ok).toBe(false);
  });
});
