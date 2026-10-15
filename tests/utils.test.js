import { describe, it, expect } from 'vitest';
import { validateAmount, escHtml, filterArchivedForSelect } from '../js/utils.js';

describe('validateAmount', () => {
  it('accepts finite numbers', () => {
    expect(validateAmount(0)).toBe(0);
    expect(validateAmount(12.34)).toBe(12.34);
    expect(validateAmount(-5)).toBe(-5);
  });

  it('accepts numeric strings', () => {
    expect(validateAmount('12.34')).toBe(12.34);
    expect(validateAmount('  -5 ')).toBe(-5);
  });

  it('rejects NaN, null, undefined, non-numeric strings', () => {
    expect(validateAmount(NaN)).toBeNull();
    expect(validateAmount(null)).toBeNull();
    expect(validateAmount(undefined)).toBeNull();
    expect(validateAmount('abc')).toBeNull();
    expect(validateAmount('')).toBeNull();
  });

  it('rejects Infinity and out-of-range values', () => {
    expect(validateAmount(Infinity)).toBeNull();
    expect(validateAmount(-Infinity)).toBeNull();
    expect(validateAmount(1e13)).toBeNull();
    expect(validateAmount(-1e13)).toBeNull();
  });

  it('rejects booleans and objects', () => {
    expect(validateAmount(true)).toBeNull();
    expect(validateAmount({})).toBeNull();
    expect(validateAmount([])).toBeNull();
  });
});

describe('escHtml', () => {
  it('escapes the five HTML-special characters', () => {
    expect(escHtml('&')).toBe('&amp;');
    expect(escHtml('<')).toBe('&lt;');
    expect(escHtml('>')).toBe('&gt;');
    expect(escHtml('"')).toBe('&quot;');
    expect(escHtml("'")).toBe('&#39;');
  });

  it('escapes a real XSS payload so it cannot break out of an attribute', () => {
    const payload = `" onclick="alert(1)`;
    const escaped = escHtml(payload);
    expect(escaped).not.toContain('"');
    expect(escaped).toBe('&quot; onclick=&quot;alert(1)');
  });

  it('escapes an XSS payload so it cannot break out of element content', () => {
    const payload = `<img src=x onerror=alert(1)>`;
    expect(escHtml(payload)).toBe('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('coerces null and undefined to empty string', () => {
    expect(escHtml(null)).toBe('');
    expect(escHtml(undefined)).toBe('');
  });

  it('stringifies numbers and other primitives', () => {
    expect(escHtml(42)).toBe('42');
    expect(escHtml(0)).toBe('0');
    expect(escHtml(true)).toBe('true');
  });

  it('escapes & first so pre-existing entities are re-escaped only once', () => {
    // `&lt;` in the input should become `&amp;lt;` — the function escapes & before <.
    expect(escHtml('&lt;')).toBe('&amp;lt;');
  });
});

describe('filterArchivedForSelect', () => {
  const active   = { id: 'a', name: 'Active' };
  const archived = { id: 'b', name: 'Archived', archived: true };
  const archived2 = { id: 'c', name: 'Archived 2', archived: true };

  it('hides archived items when the setting is off', () => {
    const out = filterArchivedForSelect([active, archived], false);
    expect(out).toEqual([active]);
  });

  it('shows archived items when the setting is on', () => {
    const out = filterArchivedForSelect([active, archived], true);
    expect(out).toEqual([active, archived]);
  });

  it('always keeps an archived item whose id is in keepIds (referenced by the tx)', () => {
    const out = filterArchivedForSelect([active, archived, archived2], false, ['b']);
    expect(out).toEqual([active, archived]);
  });

  it('accepts a Set for keepIds', () => {
    const out = filterArchivedForSelect([active, archived], false, new Set(['b']));
    expect(out).toEqual([active, archived]);
  });

  it('preserves the input array order (= display order)', () => {
    const out = filterArchivedForSelect([archived, active], true);
    expect(out.map(x => x.id)).toEqual(['b', 'a']);
  });

  it('is null-safe', () => {
    expect(filterArchivedForSelect(null, false)).toEqual([]);
    expect(filterArchivedForSelect(undefined, true)).toEqual([]);
  });
});
