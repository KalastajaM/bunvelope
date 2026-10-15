import { describe, it, expect } from 'vitest';
import { validate, assertSchema, toJsonSchema } from '../js/core/schema.js';

const S = {
  type: 'object',
  required: ['amount', 'account'],
  properties: {
    amount: { type: 'money' },
    account: { type: 'ref', kind: 'account' },
    date: { type: 'date' },
    kind: { enum: ['expense', 'income'], default: 'expense' },
    count: { type: 'integer', minimum: 1 },
    tags: { type: 'array', items: { type: 'string' } },
    scheduled: { type: 'boolean' },
  },
};
const data = { accounts: [{ id: 'acc-1', name: 'Bank' }], envelopes: [], budgetItems: [], envelopeTemplates: [], transactions: [], meta: {} };

describe('validate', () => {
  it('coerces money and dates and applies defaults', () => {
    const r = validate({ amount: '12.30', account: 'acc-1', date: '1/10/26' }, S, data);
    expect(r).toEqual({ ok: true, value: { amount: 12.3, account: 'acc-1', date: '2026-10-01', kind: 'expense' } });
  });

  it('reports every field error at once', () => {
    const r = validate({ amount: 'abc', count: 0, extra: 1, tags: [1] }, S, data);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('bad_input');
    const paths = r.error.params.errors.map(e => e.path).sort();
    expect(paths).toEqual(['account', 'amount', 'count', 'extra', 'tags[0]']);
  });

  it('checks that a ref exists when data is given, and skips the check without data', () => {
    expect(validate({ amount: 1, account: 'nope' }, S, data).ok).toBe(false);
    expect(validate({ amount: 1, account: 'nope' }, S, null).ok).toBe(true);
  });

  it('a ref lets a listed literal through without the existence check, and still rejects an unknown id', () => {
    const env = { type: 'object', properties: { envelope: { type: 'ref', kind: 'envelope', nullable: true, allow: ['__none__'] } } };
    const withEnvelopes = { ...data, envelopes: [{ id: 'groc' }] };
    expect(validate({ envelope: '__none__' }, env, withEnvelopes)).toEqual({ ok: true, value: { envelope: '__none__' } });
    expect(validate({ envelope: 'groc' }, env, withEnvelopes).ok).toBe(true);
    expect(validate({ envelope: 'nope' }, env, withEnvelopes).ok).toBe(false);
    expect(() => assertSchema(env)).not.toThrow();
    expect(() => assertSchema({ type: 'string', allow: ['x'] })).toThrow(TypeError);
    expect(toJsonSchema(env).properties.envelope.description).toContain('__none__');
  });

  it('rejects a value outside an enum', () => {
    const r = validate({ amount: 1, account: 'acc-1', kind: 'gift' }, S, data);
    expect(r.ok).toBe(false);
  });

  it('does not mistake inherited names for known fields', () => {
    const r = validate({ constructor: 'x' }, { type: 'object', properties: {} });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.params.errors).toEqual([{ path: 'constructor', message: 'is not a known field' }]);
  });

  it('treats a missing input as an empty object', () => {
    const r = validate(undefined, { type: 'object', properties: {} });
    expect(r).toEqual({ ok: true, value: {} });
  });
});

describe('assertSchema', () => {
  it('throws on an unsupported type', () => {
    expect(() => assertSchema({ type: 'object', properties: { x: { type: 'float' } } })).toThrow(TypeError);
    expect(() => assertSchema({ type: 'object', properties: { r: { type: 'ref' } } })).toThrow(TypeError);
    expect(() => assertSchema(S)).not.toThrow();
  });

  it('does not accept an inherited name as a ref kind or a required property', () => {
    expect(() => assertSchema({ type: 'ref', kind: 'toString' })).toThrow(TypeError);
    expect(() => assertSchema({ type: 'object', properties: {}, required: ['constructor'] })).toThrow(TypeError);
  });
});

describe('toJsonSchema', () => {
  it('maps the extensions to plain JSON Schema', () => {
    const js = toJsonSchema(S);
    expect(js.type).toBe('object');
    expect(js.additionalProperties).toBe(false);
    expect(js.required).toEqual(['amount', 'account']);
    expect(js.properties.amount.type).toEqual(['number', 'string']);
    expect(js.properties.date).toEqual({ type: 'string', format: 'date' });
    expect(js.properties.account.type).toBe('string');
    expect(js.properties.kind).toEqual({ enum: ['expense', 'income'], default: 'expense' });
    expect(js.properties.count).toEqual({ type: 'integer', minimum: 1 });
    expect(JSON.stringify(js)).not.toContain('"kind":"account"');
  });

  it('omits an empty required list', () => {
    expect(toJsonSchema({ type: 'object', properties: {} })).not.toHaveProperty('required');
  });
});

describe('nullable and null-as-absent', () => {
  const N = { type: 'object', required: ['a'], properties: {
    a: { type: 'string' },
    env: { type: 'string', nullable: true },
    note: { type: 'string' },
    kind: { enum: ['x', 'y'], default: 'x' },
  } };
  it('keeps null for a nullable field and drops it elsewhere', () => {
    expect(validate({ a: 'v', env: null, note: null, kind: null }, N)).toEqual({ ok: true, value: { a: 'v', env: null, kind: 'x' } });
  });
  it('reports a required field given as null as required', () => {
    const r = validate({ a: null }, N);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.params.errors).toEqual([{ path: 'a', message: 'is required' }]);
  });
  it('exports nullable as a null type or enum member', () => {
    const js = toJsonSchema({ type: 'object', properties: { env: { type: 'string', nullable: true }, k: { enum: ['a'], nullable: true } } });
    expect(js.properties.env.type).toEqual(['string', 'null']);
    expect(js.properties.k.enum).toEqual(['a', null]);
  });
});

describe('dates are real calendar dates', () => {
  const D = { type: 'object', properties: { d: { type: 'date' } } };
  it('rejects impossible dates in both formats', () => {
    expect(validate({ d: '2026-02-31' }, D).ok).toBe(false);
    expect(validate({ d: '31/02/26' }, D).ok).toBe(false);
    expect(validate({ d: '2026-02-28' }, D)).toEqual({ ok: true, value: { d: '2026-02-28' } });
  });
});

describe('money bounds reach the JSON Schema', () => {
  it('emits minimum and maximum for money', () => {
    const js = toJsonSchema({ type: 'object', properties: { m: { type: 'money', minimum: 0.01, maximum: 10 } } });
    expect(js.properties.m).toMatchObject({ minimum: 0.01, maximum: 10 });
  });
});

describe('anyOf: a value that may take one of several shapes', () => {
  // A plan item's month: `true` (the default amount) or a custom amount > 0.
  const MONTH = { anyOf: [{ enum: [true] }, { type: 'money', minimum: 0.01 }], description: 'on, or a custom amount' };
  const A = { type: 'object', properties: { m: MONTH, n: { anyOf: [{ type: 'string' }, { type: 'integer' }], nullable: true } } };

  it('accepts a value that matches any branch, as that branch reads it', () => {
    expect(validate({ m: true }, A)).toEqual({ ok: true, value: { m: true } });
    expect(validate({ m: 120 }, A)).toEqual({ ok: true, value: { m: 120 } });
    expect(validate({ m: '12.50' }, A)).toEqual({ ok: true, value: { m: 12.5 } });
    expect(validate({ n: null }, A)).toEqual({ ok: true, value: { n: null } });
  });

  it('refuses a value no branch accepts, with one error at its path', () => {
    for (const bad of [false, 0, -5, 'x', {}]) {
      const r = validate({ m: bad }, A);
      expect(r.ok).toBe(false);
      if (r.ok) continue;
      expect(r.error.params.errors).toEqual([{ path: 'm', message: expect.stringMatching(/^must match one of the allowed shapes \(.+; or .+\)$/) }]);
    }
  });

  it('is checked branch by branch by assertSchema', () => {
    expect(() => assertSchema(A)).not.toThrow();
    expect(() => assertSchema({ anyOf: [] })).toThrow(TypeError);
    expect(() => assertSchema({ anyOf: [{ type: 'float' }] })).toThrow(TypeError);
    expect(() => assertSchema({ type: 'string', anyOf: [{ type: 'string' }] })).toThrow(TypeError);
  });

  it('exports as JSON Schema anyOf, with null as one more branch when nullable', () => {
    const js = toJsonSchema(A);
    expect(js.properties.m).toEqual({
      description: 'on, or a custom amount',
      anyOf: [{ enum: [true] }, { description: 'Amount: a number or a decimal string', type: ['number', 'string'], minimum: 0.01 }],
    });
    expect(js.properties.n.anyOf).toEqual([{ type: 'string' }, { type: 'integer' }, { type: 'null' }]);
  });
});
