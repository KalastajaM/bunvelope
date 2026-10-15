// @vitest-environment jsdom
// Finnish: one term per concept (envelope = kirjekuori, template = pohja,
// plan item = budjettirivi), no English left in the UI, and the currency
// symbol after the amount ("8 531,97 €") when the UI language is Finnish,
// while English and Dutch keep "€ 8 531,97".
import { describe, it, expect, afterEach } from 'vitest';
import { _DICTS_FOR_TEST, loadLocale, setLang, t } from '../js/ui/i18n.js';
import { fmt, setFormatDefaults } from '../js/utils.js';
import { moneyEl } from '../js/ui/money.js';

await loadLocale('fi');
const fi = _DICTS_FOR_TEST.fi;

function leaves(obj, prefix = '', out = []) {
  for (const [k, v] of Object.entries(obj || {})) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (typeof v === 'string') out.push([path, v]);
    else if (typeof v === 'function') {
      // Parameterised strings: render with neutral arguments.
      try { out.push([path, String(v(1, 'X', 'Y', 'Z'))]); } catch { /* not a plain template */ }
    } else if (v && typeof v === 'object') leaves(v, path, out);
  }
  return out;
}
const all = leaves(fi);

afterEach(() => { setLang('en'); });

describe('Finnish terminology', () => {
  it('the Transactions/Dashboard hero label is Finnish only', () => {
    expect(fi.dashboard?.heroLabel ?? fi.transactions?.heroLabel).toBeDefined();
    expect(all.filter(([, v]) => /UNALLOCATED/.test(v))).toEqual([]);
    expect(all.find(([p]) => p.endsWith('heroLabel'))[1]).toBe('KOHDISTAMATTA');
  });

  it('envelope is always "kirjekuori", never a bare "kuori"', () => {
    const bare = all.filter(([, v]) => /(?<![Kk]irje)(?<!Vero)kuor/i.test(v));
    expect(bare).toEqual([]);
    expect(fi.nav.envelopes).toBe('Kirjekuoret');
  });

  it('a template is "pohja": the page is "Pohjat"', () => {
    expect(fi.nav.templates).toBe('Pohjat');
    // Mallit / malli for the envelope templates is gone (the CSV import's
    // saved column mappings and the AI model keep their own words).
    const tmpl = all.filter(([p, v]) => /\b[Mm]alli(t|a|n|en|lle|ksi)?\b/.test(v)
      && !p.startsWith('txImport.') && !p.startsWith('ai.'));
    expect(tmpl).toEqual([]);
  });

  it('a plan item is "budjettirivi", not "erä"', () => {
    expect(all.filter(([, v]) => /budjettier/i.test(v))).toEqual([]);
    expect(fi.budgetPlan.addItem).toBe('+ Lisää budjettirivi');
    expect(fi.budgetPlan.itemsCount(3)).toBe('3 budjettiriviä');
  });

  it('healthy, the Review deposit column and the device hint read naturally', () => {
    expect(all.find(([p]) => p.endsWith('aomHealthGreen'))[1]).toBe('hyvä');
    expect(all.filter(([, v]) => /Talletus \(D\)/.test(v))).toEqual([]);
    expect(all.some(([, v]) => v.includes('kaikilla laitteilla, joilla kirjaudut'))).toBe(true);
  });
});

describe('currency placement follows the UI language', () => {
  it('Finnish: amount then symbol; English and Dutch: symbol then amount', () => {
    setFormatDefaults({ currency: 'EUR', locale: 'fi-FI' });
    const nb = (s) => s.replace(/\s/g, ' ');
    setLang('fi');
    expect(nb(fmt(8531.97))).toBe('8 531,97 €');
    expect(nb(fmt(-588.97))).toBe('−588,97 €');
    expect(nb(fmt(12, { signed: true }))).toBe('+12,00 €');
    setLang('en');
    expect(nb(fmt(8531.97))).toBe('€ 8 531,97');
    setLang('nl');
    expect(nb(fmt(8531.97))).toBe('€ 8 531,97');
  });

  it('moneyEl puts the symbol span after the number in Finnish', () => {
    setLang('fi');
    const el = moneyEl(8531.97);
    expect(el.lastChild.className).toContain('cur');
    expect(el.textContent.replace(/\s/g, ' ')).toBe('8 531,97€');
    setLang('en');
    expect(moneyEl(1).firstChild.className).toBe('cur');
  });

  it('t() keeps working after the switch', () => {
    setLang('fi');
    expect(t('nav.templates')).toBe('Pohjat');
  });
});
