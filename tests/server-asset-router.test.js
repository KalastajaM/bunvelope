// Integration cover for the asset router — the wiring, not just the string
// rewriting. `server/index.js` boots a database on import, so the router is
// exported separately and mounted here on a bare app.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import express from 'express';
import { assetRouter, createAssetVersion, resolveAssetPath } from '../server/asset-fingerprint.js';

let server; let base; let version; let root;

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'bv-router-'));
  await mkdir(path.join(root, 'js', 'ui'), { recursive: true });
  await mkdir(path.join(root, 'css'), { recursive: true });
  await writeFile(
    path.join(root, 'js', 'app.js'),
    `import { openSheet } from './ui/sheet.js';\nawait import('./ui/sheet.js');\nexport const boot = 1;\n`,
  );
  await writeFile(path.join(root, 'js', 'ui', 'sheet.js'), 'export const openSheet = () => {};');
  await writeFile(path.join(root, 'css', 'app.css'), 'body{color:red}');

  version = createAssetVersion({ root, ttlMs: 0 });
  const app = express();
  app.use(assetRouter({ root, version }));
  server = http.createServer(app);
  await new Promise(resolve => server.listen(0, resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(() => new Promise(resolve => server.close(resolve)));

const get = (url) => fetch(`${base}${url}`);

describe('assetRouter', () => {
  it('stamps every import in a served module', async () => {
    const v = await version.refresh();
    const body = await (await get('/js/app.js')).text();
    expect(body).toContain(`from './ui/sheet.js?v=${v}'`);
    expect(body).toContain(`import('./ui/sheet.js?v=${v}')`);
  });

  it('serves JS as a module type the browser will execute', async () => {
    const res = await get('/js/app.js');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/javascript/);
  });

  it('caches immutably only when the URL names the current build', async () => {
    const v = await version.refresh();
    expect((await get(`/js/app.js?v=${v}`)).headers.get('cache-control'))
      .toBe('public, max-age=31536000, immutable');
    expect((await get('/js/app.js?v=stale')).headers.get('cache-control')).toBe('no-cache');
    expect((await get('/js/app.js')).headers.get('cache-control')).toBe('no-cache');
  });

  it('applies the same rule to CSS', async () => {
    const v = await version.refresh();
    expect((await get(`/css/app.css?v=${v}`)).headers.get('cache-control'))
      .toBe('public, max-age=31536000, immutable');
    expect((await get('/css/app.css')).headers.get('cache-control')).toBe('no-cache');
  });

  // The whole point: an edit must change the token, so the next HTML load
  // names URLs the browser has never seen and cannot serve from cache.
  it('issues a new token after a file changes, without a restart', async () => {
    const before = await version.refresh();
    await writeFile(path.join(root, 'js', 'ui', 'sheet.js'), 'export const openSheet = () => 42;');
    const after = await version.refresh();
    expect(after).not.toBe(before);

    const body = await (await get('/js/app.js')).text();
    expect(body).toContain(`?v=${after}`);
    expect(body).not.toContain(`?v=${before}`);
    // And the previously-immutable URL stops being immutable.
    expect((await get(`/js/app.js?v=${before}`)).headers.get('cache-control')).toBe('no-cache');
  });

  it('404s a module that does not exist rather than serving an empty one', async () => {
    expect((await get('/js/nope.js')).status).toBe(404);
  });

  it('resolves an ordinary path inside the root', () => {
    expect(resolveAssetPath(root, '/js/app.js')).toBe(path.join(root, 'js', 'app.js'));
  });

  it('neutralises traversal instead of escaping the root', () => {
    // A request path always starts with "/", and `path.posix.normalize` drops
    // leading `..` segments from an absolute path. So traversal collapses to a
    // path INSIDE the root — harmless, and 404s because nothing is there.
    // Asserting null here would have pinned the wrong guarantee.
    expect(resolveAssetPath(root, '/../../etc/passwd')).toBe(path.join(root, 'etc', 'passwd'));
    expect(resolveAssetPath(root, '/js/../../secret.js')).toBe(path.join(root, 'secret.js'));
    // Percent-encoding is decoded before normalising, not after.
    expect(resolveAssetPath(root, '/%2e%2e/%2e%2e/etc/passwd'))
      .toBe(path.join(root, 'etc', 'passwd'));
  });

  it('treats a path without a leading slash as absolute too', () => {
    // Forced to absolute before normalising, so this collapses to /secret.js
    // rather than a relative `../secret.js` — which, prefixed with ".", would
    // have produced a literal "..." directory.
    expect(resolveAssetPath(root, 'js/../../secret.js')).toBe(path.join(root, 'secret.js'));
  });

  it('rejects malformed input outright', () => {
    expect(resolveAssetPath(root, '/js/\0.js')).toBeNull();
    expect(resolveAssetPath(root, '/js/%E0%A4%A.js')).toBeNull(); // bad encoding
    expect(resolveAssetPath(root, null)).toBe(root);
  });

  it('does not serve anything through a traversal URL', async () => {
    expect((await get('/js/%2e%2e/%2e%2e/etc/passwd.js')).status).toBeGreaterThanOrEqual(400);
  });
});
