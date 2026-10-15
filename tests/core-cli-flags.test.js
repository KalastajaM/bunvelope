import { describe, it, expect } from 'vitest';
import { cliFlags, inputFromCliOptions, camelToKebab, kebabToCamel } from '../js/core/cli-flags.js';

const S = {
  type: 'object',
  required: ['amount'],
  properties: {
    amount: { type: 'money', description: 'How much' },
    fromEnvelope: { type: 'ref', kind: 'envelope', nullable: true },
    toEnvelope: { type: 'ref', kind: 'envelope' },
    scheduled: { type: 'boolean' },
    count: { type: 'integer' },
    lines: { type: 'array', items: { type: 'object', properties: { amount: { type: 'money' } } } },
  },
};

describe('cli flags', () => {
  it('converts between camel and kebab case', () => {
    expect(camelToKebab('fromEnvelope')).toBe('from-envelope');
    expect(kebabToCamel('from-envelope')).toBe('fromEnvelope');
    expect(kebabToCamel(camelToKebab('postDue'))).toBe('postDue');
  });

  it('lists top-level properties as flags', () => {
    expect(cliFlags(S).map(f => [f.flag, f.required])).toEqual([
      ['--amount', true], ['--from-envelope', false], ['--to-envelope', false], ['--scheduled', false], ['--count', false], ['--lines', false],
    ]);
    expect(cliFlags(S)[0].description).toBe('How much');
  });

  it('builds input from options', () => {
    const r = inputFromCliOptions({ amount: '-800', 'from-envelope': 'Salary Buffer', scheduled: true, count: '3', lines: '[{"amount":5}]' }, S);
    expect(r).toEqual({ ok: true, value: { amount: '-800', fromEnvelope: 'Salary Buffer', scheduled: true, count: 3, lines: [{ amount: 5 }] } });
  });

  it('reads the literal null as null for a nullable property only', () => {
    expect(inputFromCliOptions({ 'from-envelope': 'null', amount: '5' }, S)).toEqual({ ok: true, value: { fromEnvelope: null, amount: '5' } });
    // Not nullable: the text stays text (and the ref resolver will reject it).
    expect(inputFromCliOptions({ 'to-envelope': 'null' }, S)).toEqual({ ok: true, value: { toEnvelope: 'null' } });
    // Only the exact literal.
    expect(inputFromCliOptions({ 'from-envelope': 'Null' }, S)).toEqual({ ok: true, value: { fromEnvelope: 'Null' } });
  });

  it('does not mistake an inherited name for a flag', () => {
    const r = inputFromCliOptions({ constructor: 'x' }, S);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.params.errors).toEqual([{ path: '--constructor', message: 'is not a known flag' }]);
  });

  it('rejects unknown flags, bare non-boolean flags and bad JSON', () => {
    const r = inputFromCliOptions({ amont: '5', amount: true, lines: '[oops' }, S);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.params.errors.map(e => e.path).sort()).toEqual(['--amont', '--amount', '--lines']);
  });
});
