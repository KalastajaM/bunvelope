// The asset router is mounted at the app root, so without an allowlist it
// served the server's own source, the lockfile and node_modules to anyone
// who asked. Mounted here on the real repo root: the leak is about what is
// actually on disk next to index.html, not about a synthetic fixture.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { assetRouter, createAssetVersion, isServableAsset } from '../server/asset-fingerprint.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let server; let base;

beforeAll(async () => {
  const app = express();
  app.use(assetRouter({ root: ROOT, version: createAssetVersion({ root: ROOT }) }));
  server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(() => new Promise(resolve => server.close(resolve)));

const status = async (url) => (await fetch(`${base}${url}`)).status;

describe('asset router allowlist', () => {
  it.each([
    '/server/ai/secrets.js',
    '/server/auth.js',
    '/server/index.js',
    '/package.json',
    '/package-lock.json',
    '/server/migrations/0001_init.sql',
    '/node_modules/express/package.json',
    '/node_modules/express/index.js',
    '/BACKLOG.md',
    '/AGENTS.md',
    '/docs/CLI.md',
    '/bin/bunvelope.mjs',
    '/tests/utils.test.js',
    '/Dockerfile',
    '/budgets/other/meta.json',
    '/js/../server/auth.js',
    '/%2e%2e/server/auth.js',
  ])('404s %s', async (url) => {
    expect(await status(url)).toBe(404);
  });

  it('still serves the client modules and stylesheets', async () => {
    expect(await status('/js/app.js')).toBe(200);
    expect(await status('/js/ui/virtual-list.css')).toBe(200);
    expect(await status('/css/app.css')).toBe(200);
  });

  it('classifies paths by prefix, not substring', () => {
    expect(isServableAsset('js/app.js')).toBe(true);
    expect(isServableAsset('budgets/example-project/budget-meta.json')).toBe(true);
    expect(isServableAsset('jsx/app.js')).toBe(false);
    expect(isServableAsset('server/js/app.js')).toBe(false);
    expect(isServableAsset('budgets/example-projectX/a.json')).toBe(false);
  });
});
