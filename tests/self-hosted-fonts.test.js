// The webfonts are self-hosted. A missing file is not an error anywhere: the
// browser quietly falls back to Georgia or the system sans, and nobody
// notices until the headings look wrong. So pin the wiring instead.
import { describe, it, expect } from 'vitest';
import { readFile, stat } from 'node:fs/promises';
import { isServableAsset } from '../server/asset-fingerprint.js';

const read = (p) => readFile(new URL(`../${p}`, import.meta.url), 'utf8');
const exists = async (p) => (await stat(new URL(`../${p}`, import.meta.url))).isFile();

describe('self-hosted fonts', () => {
  it('every url in css/fonts.css is a woff2 file on disk that the server may serve', async () => {
    const css = await read('css/fonts.css');
    const urls = [...css.matchAll(/url\('\.\.\/([^']+)'\)/g)].map((m) => m[1]);
    expect(urls.length).toBe(8);
    for (const u of urls) {
      expect(u).toMatch(/^fonts\/[a-z-]+\.woff2$/);
      expect(await exists(u), u).toBe(true);
      expect(isServableAsset(u), u).toBe(true);
    }
  });

  it('covers every family the stylesheets name, in both subsets', async () => {
    const css = await read('css/fonts.css');
    for (const family of ['Geist', 'Geist Mono', 'Instrument Serif']) {
      const faces = css.split('@font-face').filter((b) => b.includes(`font-family: '${family}';`));
      expect(faces.length, family).toBeGreaterThanOrEqual(2);
    }
    const app = await read('css/app.css');
    expect(app).toMatch(/--font-display: 'Instrument Serif'/);
    expect(app).toMatch(/--font-mono: 'Geist Mono'/);
  });

  it('index.html loads the stylesheet, preloads files that exist, and calls no font host', async () => {
    const html = await read('index.html');
    expect(html).toContain('href="css/fonts.css"');
    const preloads = [...html.matchAll(/rel="preload" href="([^"]+)" as="font"/g)].map((m) => m[1]);
    expect(preloads.length).toBeGreaterThan(0);
    for (const p of preloads) expect(await exists(p), p).toBe(true);
    expect(html).not.toMatch(/fonts\.(googleapis|gstatic)\.com/);
  });

  it('ships the license with the files', async () => {
    for (const f of ['OFL-geist.txt', 'OFL-geistmono.txt', 'OFL-instrumentserif.txt']) {
      expect(await read(`fonts/${f}`)).toMatch(/SIL OPEN FONT LICENSE/i);
    }
  });
});
