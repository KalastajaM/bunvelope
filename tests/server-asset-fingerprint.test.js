// Fingerprinting has to hold two things at once: served assets carry a
// per-deploy token so they can be cached immutably, and the files on disk stay
// valid plain ES modules so FSAPI mode keeps working over
// `python3 -m http.server`. That rules out a build step and puts the rewriting
// in the request path, where a regex over source is doing work a bundler would
// normally do with a parser — so most of what is pinned here is what the
// rewriter must NOT touch.

import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, utimes, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  rewriteModuleImports, rewriteHtmlAssets, createAssetVersion, cacheControlFor,
} from '../server/asset-fingerprint.js';

const V = 'abc123def456';

describe('rewriteModuleImports', () => {
  it('stamps a static import', () => {
    expect(rewriteModuleImports(`import { x } from './utils.js';`, V))
      .toBe(`import { x } from './utils.js?v=${V}';`);
  });

  it('stamps a parent-relative import and keeps the quote style', () => {
    expect(rewriteModuleImports(`import a from "../ui/sheet.js";`, V))
      .toBe(`import a from "../ui/sheet.js?v=${V}";`);
  });

  it('stamps a dynamic import, with or without spacing', () => {
    expect(rewriteModuleImports(`await import('./pages/x.js')`, V))
      .toBe(`await import('./pages/x.js?v=${V}')`);
    expect(rewriteModuleImports(`import( "./a/b.js" )`, V))
      .toBe(`import( "./a/b.js?v=${V}" )`);
  });

  it('stamps a re-export and a side-effect import', () => {
    expect(rewriteModuleImports(`export { a } from './engine.js';`, V))
      .toBe(`export { a } from './engine.js?v=${V}';`);
    expect(rewriteModuleImports(`import './boot.js';`, V))
      .toBe(`import './boot.js?v=${V}';`);
  });

  it('stamps every specifier in a realistic module head', () => {
    const src = [
      `import { state } from '../app.js';`,
      `import { openSheet } from '../ui/sheet.js';`,
      `import { t } from '../ui/i18n.js';`,
    ].join('\n');
    const out = rewriteModuleImports(src, V);
    expect(out.match(new RegExp(`\\?v=${V}`, 'g'))).toHaveLength(3);
  });

  // The rewriter must leave anything it cannot be sure about alone: a wrong
  // rewrite is a module that 404s, which is worse than a slow one.
  it('leaves bare and absolute specifiers alone', () => {
    const src = `import x from 'express';\nimport y from '/js/app.js';\nimport z from 'https://cdn/x.js';`;
    expect(rewriteModuleImports(src, V)).toBe(src);
  });

  it('leaves non-.js relative specifiers alone', () => {
    const src = `import s from './styles.css';\nimport j from './data.json';`;
    expect(rewriteModuleImports(src, V)).toBe(src);
  });

  it('is idempotent — a second pass cannot double-stamp', () => {
    const once = rewriteModuleImports(`import a from './x.js';`, V);
    expect(rewriteModuleImports(once, V)).toBe(once);
  });

  it('does not touch the word "from" in ordinary prose or property access', () => {
    const src = `const from = './x.js';\nobj.from = './y.js';\n// copied from './z.js' by hand`;
    const out = rewriteModuleImports(src, V);
    expect(out).toContain(`const from = './x.js';`);
    expect(out).toContain(`obj.from = './y.js';`);
  });

  it('returns the source untouched when there is no version', () => {
    const src = `import a from './x.js';`;
    expect(rewriteModuleImports(src, null)).toBe(src);
    expect(rewriteModuleImports(src, '')).toBe(src);
  });
});

describe('rewriteHtmlAssets', () => {
  it('stamps local scripts and stylesheets', () => {
    const html = `<link rel="stylesheet" href="css/app.css">\n<script type="module" src="js/app.js"></script>`;
    const out = rewriteHtmlAssets(html, V);
    expect(out).toContain(`href="css/app.css?v=${V}"`);
    expect(out).toContain(`src="js/app.js?v=${V}"`);
  });

  it('leaves absolute and protocol-relative URLs alone', () => {
    const html = [
      `<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>`,
      `<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Geist">`,
      `<script src="//cdn.example/x.js"></script>`,
    ].join('\n');
    expect(rewriteHtmlAssets(html, V)).toBe(html);
  });

  it('leaves a URL that already carries a query alone', () => {
    const html = `<script src="js/app.js?v=old"></script>`;
    expect(rewriteHtmlAssets(html, V)).toBe(html);
  });

  it('ignores assets it has no caching story for', () => {
    const html = `<img src="logo.png">`;
    expect(rewriteHtmlAssets(html, V)).toBe(html);
  });
});

// The root route rewrites the real index.html, and that file is where a missed
// asset would cost the most: an unstamped entry module means the whole graph
// under it stays on the old, unversioned URLs.
describe('rewriteHtmlAssets over the real index.html', () => {
  it('stamps every local asset and no remote one', async () => {
    const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
    const out = rewriteHtmlAssets(html, V);

    const local = html.match(/\b(?:src|href)="(?!https?:|\/\/|data:)[^"?]+\.(?:js|css)"/g) || [];
    expect(local.length, 'index.html should reference local assets').toBeGreaterThan(0);
    for (const ref of local) {
      const url = ref.match(/="([^"]+)"/)[1];
      expect(out, `${url} should be stamped`).toContain(`${url}?v=${V}`);
    }

    // The entry module specifically — everything else is reached through it.
    expect(out).toContain(`src="js/app.js?v=${V}"`);
    // No third-party font request is left in the page head.
    expect(html).not.toMatch(/fonts\.(googleapis|gstatic)\.com/);
  });

  it('leaves the bv-mode placeholder intact for the mode injection', async () => {
    const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
    expect(rewriteHtmlAssets(html, V)).toContain('<script id="bv-mode"></script>');
  });
});

describe('cacheControlFor', () => {
  it('caches immutably when the request names the current build', () => {
    expect(cacheControlFor({ requestedVersion: V, currentVersion: V }))
      .toBe('public, max-age=31536000, immutable');
  });

  // The safety net: anything not positively identified as the current build
  // revalidates, so a URL the rewriting missed is slow rather than wrong.
  it('revalidates an old, absent or unknown version', () => {
    expect(cacheControlFor({ requestedVersion: 'stale', currentVersion: V })).toBe('no-cache');
    expect(cacheControlFor({ requestedVersion: null, currentVersion: V })).toBe('no-cache');
    expect(cacheControlFor({ requestedVersion: V, currentVersion: null })).toBe('no-cache');
  });
});

describe('createAssetVersion', () => {
  async function fixture() {
    const root = await mkdtemp(path.join(tmpdir(), 'bv-fp-'));
    await mkdir(path.join(root, 'js', 'ui'), { recursive: true });
    await mkdir(path.join(root, 'css'), { recursive: true });
    await writeFile(path.join(root, 'js', 'app.js'), 'export const a = 1;');
    await writeFile(path.join(root, 'js', 'ui', 'sheet.js'), 'export const b = 2;');
    await writeFile(path.join(root, 'css', 'app.css'), 'body{}');
    return root;
  }

  it('produces a stable token for unchanged files', async () => {
    const root = await fixture();
    const a = createAssetVersion({ root, ttlMs: 0 });
    const b = createAssetVersion({ root, ttlMs: 0 });
    expect(await a.refresh()).toBe(await b.refresh());
  });

  it('changes when a file changes — the whole point', async () => {
    const root = await fixture();
    const v = createAssetVersion({ root, ttlMs: 0 });
    const before = await v.refresh();
    await writeFile(path.join(root, 'js', 'ui', 'sheet.js'), 'export const b = 22222;');
    expect(await v.refresh()).not.toBe(before);
  });

  it('changes when only the mtime moves, as a git checkout does', async () => {
    const root = await fixture();
    const v = createAssetVersion({ root, ttlMs: 0 });
    const before = await v.refresh();
    const when = new Date(Date.now() + 60_000);
    await utimes(path.join(root, 'js', 'app.js'), when, when);
    expect(await v.refresh()).not.toBe(before);
  });

  it('changes when a file is added', async () => {
    const root = await fixture();
    const v = createAssetVersion({ root, ttlMs: 0 });
    const before = await v.refresh();
    await writeFile(path.join(root, 'js', 'new.js'), 'export const c = 3;');
    expect(await v.refresh()).not.toBe(before);
  });

  it('holds the token for the TTL, then picks the change up', async () => {
    const root = await fixture();
    let clock = 1000;
    const v = createAssetVersion({ root, ttlMs: 2000, now: () => clock });
    const before = await v.refresh();
    await writeFile(path.join(root, 'js', 'app.js'), 'export const a = 999;');

    clock = 2500; // inside the window
    expect(await v.refresh()).toBe(before);
    clock = 4000; // past it
    expect(await v.refresh()).not.toBe(before);
  });

  it('exposes the last token synchronously for setHeaders', async () => {
    const root = await fixture();
    const v = createAssetVersion({ root, ttlMs: 0 });
    expect(v.current()).toBeNull();
    const token = await v.refresh();
    expect(v.current()).toBe(token);
  });

  it('survives a missing asset directory', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'bv-fp-empty-'));
    const v = createAssetVersion({ root, ttlMs: 0 });
    await expect(v.refresh()).resolves.toEqual(expect.any(String));
  });
});
