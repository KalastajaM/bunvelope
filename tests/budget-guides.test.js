// @vitest-environment jsdom
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { buildGuidesCard, openBudgetGuide } from '../js/ui/budget-guides.js';
import { openHelpSheet, addPageHelp } from '../js/ui/info-button.js';
import { hasOpenSheet, requestCloseTopSheet } from '../js/ui/sheet.js';
import { t, loadLocale, setLang, LOCALES } from '../js/ui/i18n.js';

await Promise.all(LOCALES.map(loadLocale));

beforeEach(() => {
  setLang('en');
  document.body.innerHTML = '<div id="app-root"></div><div id="sheet-host"></div>';
  vi.stubGlobal('requestAnimationFrame', cb => setTimeout(cb, 0));
});
afterEach(async () => {
  while (hasOpenSheet()) await requestCloseTopSheet();
  setLang('en');
  vi.unstubAllGlobals();
});

const guide = () => document.querySelector('[data-sheet-open] .budget-guide');
const chapter = () => guide().querySelector('h2').textContent;

describe('budgeting guides', () => {
  for (const lang of LOCALES) {
    it(`${lang}: opens a selected chapter, moves in both directions, and closes at the end`, () => {
      setLang(lang);
      document.getElementById('app-root').append(buildGuidesCard());
      const links = document.querySelectorAll('.guide-list button');
      expect(links).toHaveLength(5);
      links[2].click();
      expect(chapter()).toBe(t('guides.planning.title'));
      guide().querySelector('.guide-navigation button').click();
      expect(chapter()).toBe(t('guides.allocation.title'));
      expect(document.activeElement).toBe(guide().querySelector('h2'));
      guide().querySelector('.guide-navigation button:last-child').click();
      expect(chapter()).toBe(t('guides.planning.title'));
      const chapters = guide().querySelector('select');
      expect(chapters.value).toBe('planning');
      expect(guide().querySelector('label').htmlFor).toBe(chapters.id);
      chapters.focus();
      chapters.value = 'accounts';
      chapters.dispatchEvent(new Event('change', { bubbles: true }));
      expect(guide().querySelector('.guide-navigation button').disabled).toBe(true);
      chapters.value = 'stress';
      chapters.dispatchEvent(new Event('change', { bubbles: true }));
      expect(chapter()).toBe(t('guides.stress.title'));
      expect(chapters.value).toBe('stress');
      expect(document.activeElement).toBe(chapters);
      expect(guide().textContent).not.toMatch(/guides\.[a-z]/);
      expect(guide().querySelectorAll('article section')).toHaveLength(3);
      guide().querySelector('.guide-navigation button:last-child').click();
      expect(hasOpenSheet()).toBe(false);
    });
  }

  it('links concept help to the relevant guide while keeping the explanation underneath', async () => {
    openHelpSheet('unallocated');
    document.querySelector('.guide-link').click();
    expect(chapter()).toBe(t('guides.allocation.title'));
    expect(document.querySelectorAll('[data-sheet-open]')).toHaveLength(2);
    await requestCloseTopSheet();
    expect(document.querySelector('[data-sheet-open]').textContent).toContain(t('help.unallocated.title'));
    expect(document.querySelectorAll('[data-sheet-open]')).toHaveLength(1);
  });

  it('makes a page explanation link to its explicitly chosen guide', () => {
    const heading = document.createElement('h1');
    heading.textContent = 'Stress';
    document.getElementById('app-root').append(heading);
    addPageHelp(heading, 'stress.sub', { guide: 'stress' });
    heading.querySelector('button').click();
    document.querySelector('.guide-link').click();
    expect(chapter()).toBe(t('guides.stress.title'));
  });

  it('opens at the start for an unknown chapter', () => {
    openBudgetGuide('missing');
    expect(chapter()).toBe(t('guides.accounts.title'));
  });
});
