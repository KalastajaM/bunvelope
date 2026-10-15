import { describe, it, expect } from 'vitest';
import { registry } from '../js/core/index.js';
import { runCommand } from '../js/core/pipeline.js';
import { makeCtx } from '../js/core/context.js';
import { assignShortCode } from '../js/core/short-codes.js';

const ctx = makeCtx({ now: new Date('2026-10-07T12:00:00Z'), newId: () => 'new-id' });
const data = () => ({ meta: {}, accounts: [{ id: 'bank', name: 'Bank', type: 'bank', code: 'BA01' }],
  envelopes: [{ id: 'food', name: 'Food', code: 'FO01', archived: true }],
  budgetItems: [], envelopeTemplates: [], transactions: [] });

describe.each(['account', 'envelope'])('%s short codes', kind => {
  it('generates a four-character code and skips occupied codes across collections', () => {
    const r = runCommand(registry, data(), `${kind}.create`, { name: 'Food shop' }, ctx);
    expect(r.ok).toBe(true);
    expect(r.value.after[kind === 'account' ? 'accounts' : 'envelopes'].at(-1).code).toBe('FO02');
  });
  it('normalizes a custom code and allows editing without changing identity', () => {
    const id = kind === 'account' ? 'bank' : 'food';
    const r = runCommand(registry, data(), `${kind}.update`, { id, fields: { code: ' ab12 ' } }, ctx);
    expect(r.ok).toBe(true);
    expect(r.value.after[kind === 'account' ? 'accounts' : 'envelopes'][0]).toMatchObject({ id, code: 'AB12' });
  });
  it('refuses duplicates, including archived and cross-collection codes', () => {
    for (const code of ['ba01', 'FO01']) {
      const r = runCommand(registry, data(), `${kind}.create`, { name: 'New', code }, ctx);
      expect(r).toMatchObject({ ok: false, error: { code: 'code_taken' } });
    }
    const r = runCommand(registry, data(), `${kind}.update`, {
      id: kind === 'account' ? 'bank' : 'food', fields: { code: kind === 'account' ? 'fo01' : 'BA01' },
    }, ctx);
    expect(r).toMatchObject({ ok: false, error: { code: 'code_taken' } });
  });
  it('accepts its own unchanged code', () => {
    const r = runCommand(registry, data(), `${kind}.update`, {
      id: kind === 'account' ? 'bank' : 'food', fields: { code: kind === 'account' ? 'ba01' : 'fo01' },
    }, ctx);
    expect(r.ok).toBe(true);
  });
  it.each(['ABC', 'ABCDE', 'A-01', 'åb01'])('rejects malformed code %s', code => {
    expect(runCommand(registry, data(), `${kind}.create`, { name: 'New', code }, ctx))
      .toMatchObject({ ok: false, error: { code: 'code_invalid' } });
  });
});

it('falls back to unused four-character codes when a prefix is full', () => {
  const accounts = Array.from({ length: 99 }, (_, i) => ({ code: `FO${String(i + 1).padStart(2, '0')}` }));
  expect(assignShortCode({ accounts }, 'envelope', { name: 'Food' }).value.code).toBe('0000');
});
