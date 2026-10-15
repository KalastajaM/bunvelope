// tests/core-basics.test.js
import { describe, it, expect } from 'vitest';
import { ok, fail } from '../js/core/result.js';
import { makeCtx, isoDate } from '../js/core/context.js';
import { ERROR_CODES, errorKey, describeError } from '../js/core/errors.js';
import { t, setLang } from '../js/ui/i18n.js';

describe('core result', () => {
  it('wraps values and errors', () => {
    expect(ok(3)).toEqual({ ok: true, value: 3 });
    expect(fail('bad_input', { errors: [] })).toEqual({ ok: false, error: { code: 'bad_input', params: { errors: [] } } });
    expect(fail('no_budget')).toEqual({ ok: false, error: { code: 'no_budget', params: {} } });
  });
});

describe('core context', () => {
  it('derives local today from the injected clock', () => {
    const ctx = makeCtx({ now: new Date(2026, 9, 1, 23, 30), newId: () => 'x' });
    expect(ctx.today).toEqual(new Date(2026, 9, 1));
    expect(ctx.todayIso).toBe('2026-10-01');
    expect(ctx.country).toBe('FI');
    expect(ctx.newId()).toBe('x');
    expect(Object.isFrozen(ctx)).toBe(true);
  });

  it('hands out copies of its dates', () => {
    const ctx = makeCtx({ now: new Date(2026, 9, 1, 9), newId: () => 'x' });
    ctx.today.setFullYear(1999);
    ctx.now.setFullYear(1999);
    expect(ctx.today).toEqual(new Date(2026, 9, 1));
    expect(ctx.now.getFullYear()).toBe(2026);
  });

  it('refuses a missing clock or id generator', () => {
    expect(() => makeCtx({ newId: () => 'x' })).toThrow(TypeError);
    expect(() => makeCtx({ now: new Date() })).toThrow(TypeError);
  });

  it('formats local dates', () => {
    expect(isoDate(new Date(2026, 0, 5))).toBe('2026-01-05');
  });
});

describe('core errors', () => {
  it('has an English message for every code', () => {
    setLang('en');
    for (const code of ERROR_CODES) {
      const text = describeError({ code, params: { name: 'n', kind: 'envelope', id: 'i', type: 'x', date: '2026-10-01', message: 'm', errors: [] } }, t);
      expect(text, code).not.toBe(errorKey(code));
      expect(typeof text).toBe('string');
    }
  });

  it('falls back to the code for an unknown error', () => {
    expect(describeError({ code: 'nope', params: {} }, t)).toBe('nope');
  });

  it('maps codes to camel-case i18n keys', () => {
    expect(errorKey('ref_not_found')).toBe('coreError.refNotFound');
  });
});
