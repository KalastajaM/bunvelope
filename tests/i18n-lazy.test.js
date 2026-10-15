// tests/i18n-lazy.test.js — the lazy-locale contract: before loadLocale(l)
// resolves, t() must fall back to English (never undefined); afterwards it
// serves that locale. Pins the fallback path the boot await relies on.

import { describe, it, expect } from 'vitest';
import { t, setLang, getLang, loadLocale, isLocaleLoaded, LOCALES } from '../js/ui/i18n.js';

// One representative key per translated locale — enough to prove the
// dictionary actually swapped in, without duplicating the parity test.
const SAMPLE = { fi: 'Tallenna', nl: 'Opslaan' };

describe('lazy locale loading', () => {
  it.each(LOCALES.filter(l => l !== 'en'))(
    'falls back to English while %s is not loaded, switches after',
    async (locale) => {
      setLang(locale);
      expect(isLocaleLoaded(locale)).toBe(false);
      // EN fallback, not undefined.
      expect(t('common.save')).toBe('Save');

      await loadLocale(locale);
      expect(isLocaleLoaded(locale)).toBe(true);
      expect(t('common.save')).toBe(SAMPLE[locale]);

      setLang('en');
      expect(t('common.save')).toBe('Save');
    },
  );

  it('treats English as always loaded', () => {
    expect(isLocaleLoaded('en')).toBe(true);
  });

  it('falls back to the default locale for an unknown language', () => {
    setLang('zz');
    expect(getLang()).toBe('fi');
    setLang('en');
  });
});
