// The tour's rail step describes what the rail becomes on a narrow screen.
// Below the 840px breakpoint (css/mobile.css, buildMobileBar in
// js/ui/shell.js) it is an off-canvas drawer opened by a menu button in the
// mobile bar, not a top bar (the top bar is a separate layout setting).
import { describe, it, expect, afterAll } from 'vitest';
import { t, setLang, loadLocale, LOCALES } from '../js/ui/i18n.js';

await Promise.all(LOCALES.map(loadLocale));
afterAll(() => setLang('en'));

const MENU = { en: /menu button/, fi: /valikkopainikkeesta/, nl: /menuknop/ };
const TOP_BAR = { en: /top bar/i, fi: /yläpalk/i, nl: /balk bovenaan|bovenbalk/i };

describe('tour rail step on narrow screens', () => {
  for (const lang of ['en', 'fi', 'nl']) {
    it(`${lang}: names the menu button, not a top bar`, () => {
      setLang(lang);
      const body = t('tour.steps.rail.body');
      expect(body).toMatch(MENU[lang]);
      expect(body).not.toMatch(TOP_BAR[lang]);
    });
  }
});
