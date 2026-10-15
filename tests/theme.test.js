import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { resolveTheme, normalizeThemePref } from '../js/ui/theme.js';

const BOOT_SRC = readFileSync(new URL('../js/theme-boot.js', import.meta.url), 'utf8');

/** Run js/theme-boot.js against a fake browser; returns handles to drive it. */
function runBoot({ stored, osDark, storageThrows = false, noMatchMedia = false }) {
  const listeners = [];
  const mq = {
    matches: osDark,
    addEventListener: (type, fn) => { if (type === 'change') listeners.push(fn); },
  };
  const store = new Map(stored == null ? [] : [['bv-theme', stored]]);
  const localStorage = {
    getItem: (k) => { if (storageThrows) throw new Error('blocked'); return store.has(k) ? store.get(k) : null; },
    setItem: (k, v) => store.set(k, String(v)),
  };
  const documentElement = { dataset: {} };
  const winListeners = [];
  const window = {
    localStorage,
    matchMedia: noMatchMedia ? undefined : () => mq,
    addEventListener: (type, fn) => winListeners.push([type, fn]),
  };
  vm.runInNewContext(BOOT_SRC, { window, document: { documentElement } });
  return {
    theme: () => documentElement.dataset.theme,
    flipOs(dark) { mq.matches = dark; listeners.forEach((fn) => fn()); },
    /** Simulate another tab writing localStorage (the `storage` event). */
    otherTabWrites(key, value) {
      if (value == null) store.delete(key); else store.set(key, value);
      winListeners.filter(([t]) => t === 'storage').forEach(([, fn]) => fn({ key, newValue: value }));
    },
    store,
    listeners,
  };
}

const PREFS = ['light', 'dark', 'system', null, '', 'sepia'];

describe('resolveTheme', () => {
  test('explicit choices win over the OS', () => {
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('dark', false)).toBe('dark');
  });
  test('system and unknown values follow the OS', () => {
    for (const v of ['system', null, undefined, '', 'sepia', 42]) {
      expect(resolveTheme(v, true)).toBe('dark');
      expect(resolveTheme(v, false)).toBe('light');
    }
  });
  test('normalizeThemePref defaults to system', () => {
    expect(normalizeThemePref('dark')).toBe('dark');
    expect(normalizeThemePref('light')).toBe('light');
    expect(normalizeThemePref('system')).toBe('system');
    expect(normalizeThemePref(null)).toBe('system');
    expect(normalizeThemePref('DARK')).toBe('system');
  });
});

describe('theme-boot.js', () => {
  test('agrees with resolveTheme for every stored value and OS setting', () => {
    for (const stored of PREFS) {
      for (const osDark of [false, true]) {
        expect(runBoot({ stored, osDark }).theme()).toBe(resolveTheme(stored, osDark));
      }
    }
  });

  test('keeps following the OS while in System mode', () => {
    const boot = runBoot({ stored: 'system', osDark: false });
    expect(boot.theme()).toBe('light');
    boot.flipOs(true);
    expect(boot.theme()).toBe('dark');
    boot.flipOs(false);
    expect(boot.theme()).toBe('light');
  });

  test('an OS flip is ignored after an explicit choice, even one made later', () => {
    const boot = runBoot({ stored: null, osDark: true });
    expect(boot.theme()).toBe('dark');
    boot.store.set('bv-theme', 'light'); // what the Tweaks panel writes
    boot.flipOs(false);
    boot.flipOs(true);
    expect(boot.theme()).toBe('light');
  });

  test('a theme chosen in another tab applies here', () => {
    const boot = runBoot({ stored: 'light', osDark: false });
    expect(boot.theme()).toBe('light');
    boot.otherTabWrites('bv-theme', 'dark');
    expect(boot.theme()).toBe('dark');
    boot.otherTabWrites('bv-theme', 'system'); // follows the OS again (light)
    expect(boot.theme()).toBe('light');
  });

  test('other keys changing in another tab are ignored', () => {
    const boot = runBoot({ stored: 'light', osDark: true });
    boot.store.set('bv-theme', 'dark'); // changed without an event for our key
    boot.otherTabWrites('bv-prefs', '{}');
    expect(boot.theme()).toBe('light');
  });

  test('blocked storage falls back to System instead of throwing', () => {
    expect(runBoot({ stored: 'light', osDark: true, storageThrows: true }).theme()).toBe('dark');
  });

  test('no matchMedia renders light', () => {
    expect(runBoot({ stored: null, osDark: true, noMatchMedia: true }).theme()).toBe('light');
  });
});

describe('index.html wiring', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const head = html.slice(0, html.indexOf('</head>'));

  test('boot script is a blocking classic script in <head>, before the stylesheets', () => {
    const tag = head.match(/<script[^>]*src="js\/theme-boot\.js"[^>]*><\/script>/);
    expect(tag).not.toBeNull();
    expect(tag[0]).not.toMatch(/type="module"|\bdefer\b|\basync\b/);
    expect(head.indexOf('src="js/theme-boot.js"')).toBeLessThan(head.indexOf('href="css/app.css"'));
  });

  test('declares both colour schemes and links the dark sheet last', () => {
    expect(head).toMatch(/<meta name="color-scheme" content="light dark">/);
    const links = [...head.matchAll(/<link rel="stylesheet" href="(css\/[^"]+)"/g)].map((m) => m[1]);
    expect(links[links.length - 1]).toBe('css/theme-dark.css');
  });
});
