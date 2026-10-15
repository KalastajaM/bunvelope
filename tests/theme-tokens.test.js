// Dark theme guards, computed from the CSS text itself:
//  1. token parity — every colour token the light theme defines has a dark
//     value (or is a pure alias of one), so a new token cannot silently render
//     its cream-theme value on a near-black page;
//  2. data-bar contrast — envelope meters and spark bars clear 3:1 non-text
//     contrast (WCAG 1.4.11) against their track / card in dark.
import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');

/** Custom properties declared in the first top-level block opened by `selector {`. */
function tokensOf(css, selector) {
  const src = stripComments(css);
  const start = src.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`no "${selector} {" block`);
  const open = src.indexOf('{', start);
  const body = src.slice(open + 1, src.indexOf('}', open));
  const out = new Map();
  for (const decl of body.split(';')) {
    const m = decl.match(/^\s*(--[a-z0-9-]+)\s*:\s*([\s\S]+?)\s*$/i);
    if (m) out.set(m[1], m[2].replace(/\s+/g, ' '));
  }
  return out;
}

const appCss = read('css/app.css');
const refineCss = read('css/bunvelope-refine.css');
const darkCss = read('css/theme-dark.css');

// Refine loads after app.css, so its value wins for a token both define.
const light = new Map([...tokensOf(appCss, ':root'), ...tokensOf(refineCss, ':root')]);
const dark = tokensOf(darkCss, ':root[data-theme="dark"]');

/** Tokens that carry no colour. A new token must be either colour-shaped or
 *  listed here, so nothing slips past by being unclassified. */
const NON_COLOUR = /^--(r-[a-z]+|density|pad-[a-z-]+|row-min-h|ease|dur-[a-z]+|font-[a-z]+)$/;
const COLOUR_SHAPE = /oklch\(|rgba?\(|hsla?\(|color-mix\(|#[0-9a-f]{3,8}\b/i;
const ALIAS = /^var\((--[a-z0-9-]+)\)$/i;
/** Dark-only helpers with no light counterpart. */
const DARK_ONLY = new Set(['--bar-l']);

describe('dark token parity', () => {
  test('parsed both themes', () => {
    expect(light.size).toBeGreaterThan(40);
    expect(dark.size).toBeGreaterThan(30);
  });

  test('every light token is classified as colour or non-colour', () => {
    const unclassified = [...light].filter(([name, value]) =>
      !NON_COLOUR.test(name) && !COLOUR_SHAPE.test(value) && !ALIAS.test(value));
    expect(unclassified).toEqual([]);
  });

  test('every light colour token has a dark value or aliases one that does', () => {
    const covered = (name, seen = new Set()) => {
      if (dark.has(name)) return true;
      const value = light.get(name);
      const alias = value && value.match(ALIAS);
      if (!alias || seen.has(name)) return false;
      seen.add(name);
      return covered(alias[1], seen);
    };
    const missing = [...light.keys()]
      .filter((name) => !NON_COLOUR.test(name))
      .filter((name) => !covered(name));
    expect(missing).toEqual([]);
  });

  test('the dark block defines nothing the light theme lacks (typo guard)', () => {
    const extra = [...dark.keys()].filter((n) => !light.has(n) && !DARK_ONLY.has(n));
    expect(extra).toEqual([]);
  });
});

// ── OKLCH → WCAG relative luminance ────────────────────────────────────────
function oklchToLinearSrgb([L, C, H]) {
  const h = (H * Math.PI) / 180;
  const a = C * Math.cos(h), b = C * Math.sin(h);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.2914855480 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
  ].map((x) => Math.min(1, Math.max(0, x)));
}
const luminance = (c) => {
  const [r, g, b] = oklchToLinearSrgb(c);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (x, y) => {
  const [hi, lo] = [luminance(x), luminance(y)].sort((p, q) => q - p);
  return (hi + 0.05) / (lo + 0.05);
};
const parseOklch = (value) => {
  const m = String(value).match(/^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\)$/);
  if (!m) throw new Error(`not a literal oklch(): ${value}`);
  return m.slice(1, 4).map(Number);
};
const darkColour = (name) => {
  while (!dark.has(name) && ALIAS.test(light.get(name) || '')) name = light.get(name).match(ALIAS)[1];
  return parseOklch(dark.get(name));
};

describe('dark data bars clear 3:1 against their track', () => {
  const darkRules = stripComments(darkCss);
  const barL = Number(dark.get('--bar-l'));

  // Every bar formula in theme-dark.css must use --bar-l with one chroma factor.
  const factors = [...darkRules.matchAll(/var\(--bar-l\) calc\(c \* ([\d.]+)\) h\)/g)].map((m) => Number(m[1]));
  const factor = factors[0];

  test('bar rules use --bar-l and a single chroma factor', () => {
    expect(barL).toBeGreaterThan(0);
    expect(factors.length).toBeGreaterThanOrEqual(4); // env meter, list meter, funded, spark
    expect(new Set(factors).size).toBe(1);
    expect(darkRules).toMatch(/\.env-meter\s*\{\s*background:\s*var\(--bg-sunken\)/);
  });

  // Neutral envelope meter defaults and the dashboard spark accents.
  const fillTokens = ['--mint', '--accent', '--peach', '--sky', '--lilac'];

  const tracks = {
    'meter track (--bg-sunken)': darkColour('--bg-sunken'),
    'card (--surface)': darkColour('--surface'),
    'card hover (--surface-alt)': darkColour('--surface-alt'),
  };

  test('neutral meter / accent fills at --bar-l', () => {
    expect(fillTokens).toEqual(expect.arrayContaining(['--mint', '--accent']));
    for (const token of fillTokens) {
      const [, c, h] = darkColour(token);
      const bar = [barL, c * factor, h];
      for (const [where, bg] of Object.entries(tracks)) {
        expect(contrast(bar, bg), `${token} bar on ${where}`).toBeGreaterThanOrEqual(3);
      }
    }
  });

  test('state fills (tight / over / funded / low) on the meter track', () => {
    const track = tracks['meter track (--bg-sunken)'];
    const low = darkRules.match(/\.env-list-row\.low \.env-list-meter \.fill \{ background: (oklch\([^)]+\))/);
    const states = {
      '--warn': darkColour('--warn'),
      '--danger': darkColour('--danger'),
      '--success': darkColour('--success'),
      '.env-list-row.low': parseOklch(low[1]),
    };
    for (const [name, colour] of Object.entries(states)) {
      expect(contrast(colour, track), name).toBeGreaterThanOrEqual(3);
    }
  });
});
