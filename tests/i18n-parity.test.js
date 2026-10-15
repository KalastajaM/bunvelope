import { describe, test, expect } from 'vitest';
import { _DICTS_FOR_TEST, loadLocale, LOCALES, LOCALE_NAMES } from '../js/ui/i18n.js';

// Every locale but EN is lazy-loaded in production; pull them all in before
// comparing.
await Promise.all(LOCALES.map(loadLocale));

// Recursively collect every leaf key path from a nested dictionary.
// Functions are treated as leaves (parameterised translations).
function leafKeys(obj, prefix = '', out = []) {
  if (obj == null) return out;
  if (typeof obj !== 'object' || typeof obj === 'function') {
    out.push(prefix);
    return out;
  }
  for (const k of Object.keys(obj)) {
    const child = obj[k];
    const next = prefix ? `${prefix}.${k}` : k;
    if (child && typeof child === 'object' && typeof child !== 'function' && !Array.isArray(child)) {
      leafKeys(child, next, out);
    } else {
      out.push(next);
    }
  }
  return out;
}

// Namespaces that are language-asymmetric by design: they map a source-language
// label (Finnish category/envelope names) to its translation, so the FI dict
// has no entries for them.
const ASYMMETRIC_PREFIXES = ['cat.', 'env.names.'];
const isSymmetric = k => !ASYMMETRIC_PREFIXES.some(p => k.startsWith(p));

// Walk a dotted key path back to its value, so a leaf can be inspected and not
// merely counted.
function valueAt(dict, path) {
  let node = dict;
  for (const part of path.split('.')) {
    if (node == null || typeof node !== 'object') return undefined;
    node = node[part];
  }
  return node;
}

const { en } = _DICTS_FOR_TEST;
const enKeys = new Set(leafKeys(en).filter(isSymmetric));

// EN is the reference; every other locale is compared against it in both
// directions, so a key added to one translation and forgotten elsewhere fails
// no matter which side it was added on.
const TRANSLATIONS = LOCALES.filter(l => l !== 'en');

describe('i18n locale registry', () => {
  test('every locale has a display name and a loaded dictionary', () => {
    for (const l of LOCALES) {
      expect(LOCALE_NAMES[l], `no LOCALE_NAMES entry for "${l}"`).toBeTruthy();
      expect(_DICTS_FOR_TEST[l], `no dictionary loaded for "${l}"`).toBeTruthy();
    }
  });
});

describe.each(TRANSLATIONS)('i18n %s/EN parity', (locale) => {
  const dict = _DICTS_FOR_TEST[locale];
  const keys = new Set(leafKeys(dict).filter(isSymmetric));

  test(`every ${locale} key has an EN translation`, () => {
    const missing = [...keys].filter(k => !enKeys.has(k));
    expect(missing, `Keys present in ${locale} but missing from EN:\n${missing.join('\n')}`).toEqual([]);
  });

  test(`every EN key has a ${locale} translation`, () => {
    const missing = [...enKeys].filter(k => !keys.has(k));
    expect(missing, `Keys present in EN but missing from ${locale}:\n${missing.join('\n')}`).toEqual([]);
  });

  // Presence is not enough for a parameterised string. `(a) => …` in one locale
  // against `(a, b) => …` in the other passes every check above while quietly
  // rendering without the second value — a dropped amount or date, in the
  // locale nobody happened to be reading.
  test('parameterised keys take the same arguments in both locales', () => {
    const mismatched = [];
    for (const key of enKeys) {
      if (!keys.has(key)) continue;
      const enVal = valueAt(en, key);
      const val = valueAt(dict, key);
      const enFn = typeof enVal === 'function';
      const isFn = typeof val === 'function';
      if (!enFn && !isFn) continue;
      if (enFn !== isFn) {
        mismatched.push(`${key}: EN is ${enFn ? 'a function' : 'a string'}, ${locale} is ${isFn ? 'a function' : 'a string'}`);
      } else if (enVal.length !== val.length) {
        mismatched.push(`${key}: EN takes ${enVal.length} arg(s), ${locale} takes ${val.length}`);
      }
    }
    expect(mismatched, `Parameterised translations disagree:\n${mismatched.join('\n')}`).toEqual([]);
  });

  // A `{cur}`/`{name}` placeholder is substituted by the caller, so a
  // translation that drops or renames one silently renders the raw token —
  // or, worse, loses the value entirely.
  test('brace placeholders match EN', () => {
    const mismatched = [];
    const braces = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort();
    for (const key of enKeys) {
      if (!keys.has(key)) continue;
      const enVal = valueAt(en, key);
      const val = valueAt(dict, key);
      if (typeof enVal !== 'string' || typeof val !== 'string') continue;
      const a = braces(enVal), b = braces(val);
      if (a.join(',') !== b.join(',')) {
        mismatched.push(`${key}: EN has {${a.join('}, {')}}, ${locale} has {${b.join('}, {')}}`);
      }
    }
    expect(mismatched, `Placeholder sets disagree:\n${mismatched.join('\n')}`).toEqual([]);
  });
});
