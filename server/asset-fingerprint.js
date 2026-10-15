// server/asset-fingerprint.js — per-deploy version tokens for static assets,
// without a build step.
//
// The problem this replaces: assets were served with `max-age=600`, which
// bought zero revalidation while a user was active at the cost of a ten-minute
// window where a deploy was invisible. HTML stays fresh (`no-cache`), so the
// page shell updates while the ES modules behind it do not — the app LOOKS
// current and behaves like the old build. Diagnosing that from the outside is
// genuinely hard: only the changed files misbehave, so half a feature works.
//
// Fingerprinting normally needs a bundler to rewrite import specifiers. This
// app has no build step and must keep running as plain files over
// `python3 -m http.server` for FSAPI mode, so the raw sources have to stay
// valid exactly as they are on disk. The rewrite therefore happens at SERVE
// time, in the cloud server only:
//
//   1. Every local `<script src>` / `<link href>` in index.html gains `?v=<id>`.
//   2. Every relative module specifier inside served JS gains the same `?v=<id>`.
//   3. A request carrying the CURRENT id is cached immutably for a year;
//      anything else is `no-cache`.
//
// One token for the whole deploy rather than a per-file hash: a module graph
// where each file's URL depends on its own content forces every importer to
// change whenever a leaf changes, which is precisely the cascade a bundler
// exists to compute. A single id re-fetches slightly more than necessary on a
// deploy and needs no graph at all.
//
// Rule 3 is the safety net. If a URL is ever missed by the rewriting, it
// arrives without the current token and is simply revalidated every time —
// correct, just not fast. Nothing can be cached long under a stale identity.

import { readdir, stat, readFile } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import express from 'express';

/**
 * Relative module specifiers in JS source.
 *
 * Covers the three shapes this codebase uses — `from './x.js'`,
 * `import('./x.js')`, and the side-effect `import './x.js'` — and only for
 * specifiers that are relative (`./`, `../`) and end in `.js`. Bare and
 * absolute specifiers are left alone: there are none here, and rewriting one
 * would break it.
 *
 * Idempotent by construction: a specifier that already carries `?v=` no longer
 * ends in `.js`, so a second pass cannot double-append.
 */
const MODULE_SPECIFIER = /(\bfrom\s+|\bimport\s*\(\s*|\bimport\s+)(['"])(\.{1,2}\/[^'"\n]*?\.js)\2/g;

/** Local asset URLs in HTML attributes. Absolute and protocol-relative URLs
 *  are deliberately excluded. */
const HTML_ASSET = /\b(src|href)="(?!https?:|\/\/|data:)([^"?]+\.(?:js|css))"/g;

/** Append `?v=<version>` to every relative module specifier in `source`. */
export function rewriteModuleImports(source, version) {
  if (!version || typeof source !== 'string') return source;
  return source.replace(
    MODULE_SPECIFIER,
    (_m, lead, quote, spec) => `${lead}${quote}${spec}?v=${version}${quote}`,
  );
}

/** Append `?v=<version>` to every local script/stylesheet URL in `html`. */
export function rewriteHtmlAssets(html, version) {
  if (!version || typeof html !== 'string') return html;
  return html.replace(HTML_ASSET, (_m, attr, url) => `${attr}="${url}?v=${version}"`);
}

/** Every file under `dirs`, recursively, as absolute paths. */
async function collectFiles(root, dirs) {
  const out = [];
  const walk = async (dir) => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // A configured directory that does not exist is not an error.
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) out.push(full);
    }
  };
  for (const dir of dirs) await walk(path.join(root, dir));
  out.sort();
  return out;
}

/**
 * A version token for the current contents of the asset tree, recomputed at
 * most once per `ttlMs`.
 *
 * Derived from each file's size and mtime rather than its bytes. Every way
 * this app is deployed rewrites mtime — a git checkout, a fresh clone, an
 * editor save — and stat-ing ~70 files is cheap enough to do on a timer where
 * hashing a megabyte of source would not be.
 *
 * The TTL is what keeps `git pull` working without a restart, which is how the
 * app is developed: `express.static` already serves whatever is on disk, and a
 * couple of seconds later the token follows, so the browser is handed new URLs
 * on its next load of the (uncached) HTML.
 */
export function createAssetVersion({ root, dirs = ['js', 'css'], ttlMs = 2000, now = () => Date.now() }) {
  let cached = null;
  let computedAt = -Infinity;
  let inflight = null;

  async function compute() {
    const files = await collectFiles(root, dirs);
    const hash = crypto.createHash('sha256');
    for (const file of files) {
      try {
        const st = await stat(file);
        hash.update(path.relative(root, file));
        hash.update(`:${st.size}:${Math.floor(st.mtimeMs)}\n`);
      } catch {
        // Vanished mid-scan; the next refresh will settle it.
      }
    }
    return hash.digest('hex').slice(0, 12);
  }

  return {
    /** Recompute if the cached token has aged out. Safe to call per request. */
    async refresh() {
      if (cached !== null && now() - computedAt < ttlMs) return cached;
      // Collapse concurrent refreshes; a burst of module requests after a
      // reload would otherwise each walk the tree.
      if (!inflight) {
        inflight = compute().then((v) => {
          cached = v;
          computedAt = now();
          inflight = null;
          return v;
        }).catch((err) => {
          inflight = null;
          throw err;
        });
      }
      return inflight;
    },
    /** Last computed token, or null before the first refresh. Synchronous, for
     *  `express.static`'s `setHeaders`, which cannot await. */
    current() {
      return cached;
    },
  };
}

/**
 * Cache-Control for a static asset, given the `?v=` the client asked for.
 *
 * Immutable for a year when the token matches the current deploy — the URL
 * then names one specific build and can never go stale. Everything else
 * revalidates, which covers first loads, stale bookmarks, and any URL the
 * rewriting missed.
 */
export function cacheControlFor({ requestedVersion, currentVersion, immutableMaxAge = 31536000 }) {
  if (currentVersion && requestedVersion && requestedVersion === currentVersion) {
    return `public, max-age=${immutableMaxAge}, immutable`;
  }
  return 'no-cache';
}

/**
 * Resolve a request path to a file inside `root`, or null if it cannot be.
 *
 * The input is forced to absolute form before normalising, which is what makes
 * traversal harmless: `path.posix.normalize` drops leading `..` from an
 * absolute path, so `/../../etc/passwd` collapses to `/etc/passwd` and lands
 * inside the root, where it simply does not exist. Normalising the raw string
 * instead would leave a relative `../secret.js`, and prefixing that with `.`
 * yields a literal `...` directory — contained by luck rather than by rule.
 *
 * The containment check afterwards is therefore belt and braces. It stays
 * because it is the assertion that would actually fail if the reasoning above
 * ever stopped holding.
 */
export function resolveAssetPath(root, urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(String(urlPath || ''));
  } catch {
    return null; // Malformed percent-encoding.
  }
  if (decoded.includes('\0')) return null;
  const absolute = path.posix.normalize(`/${decoded.replace(/^\/+/, '')}`);
  const full = path.resolve(root, `.${absolute}`);
  return full === root || full.startsWith(root + path.sep) ? full : null;
}

/**
 * Top-level directories the browser actually requests. The router is mounted
 * at the app root, which in the container and in a dev checkout is also where
 * `server/`, `node_modules/`, `package.json` and the docs live; serving the
 * root wholesale handed out the server source (including the secrets module),
 * the SQL migrations and the full dependency tree, unauthenticated.
 *
 * An allowlist rather than a denylist because the failure modes differ: a
 * missing entry here is a visible 404 in the browser the first time it is
 * requested, while a missing denylist entry is a silent leak. index.html is
 * not listed; it has its own route in server/index.js.
 */
export const SERVABLE_PREFIXES = Object.freeze([
  'js/',
  'css/',
  'fonts/',
  'budgets/example-project/',
]);

/** True when `relPath` (POSIX, relative to the app root) may be served. */
export function isServableAsset(relPath, prefixes = SERVABLE_PREFIXES) {
  if (typeof relPath !== 'string') return false;
  return prefixes.some((prefix) => relPath.startsWith(prefix));
}

/**
 * Router serving the asset tree with fingerprinted, immutably-cacheable URLs.
 *
 * Lives here rather than inline in `server/index.js` so the wiring — not just
 * the string rewriting — can be mounted on a bare app and tested. `index.js`
 * boots a database on import, which would otherwise put this whole path out of
 * reach of the suite.
 */
export function assetRouter({ root, version, prefixes = SERVABLE_PREFIXES }) {
  const router = express.Router();

  // Gate before either handler: the path is resolved exactly as the handlers
  // resolve it, so an encoded `..` cannot pass the check under one spelling
  // and be served under another.
  router.use((req, _res, next) => {
    const filePath = resolveAssetPath(root, req.path);
    const rel = filePath ? path.relative(root, filePath).split(path.sep).join('/') : null;
    if (!isServableAsset(rel, prefixes)) return next('router');
    next();
  });

  // JS is rewritten, so it cannot come from `express.static`: the entry module
  // would carry a token and everything it imports would not.
  router.get(/\.js$/, async (req, res, next) => {
    try {
      const filePath = resolveAssetPath(root, req.path);
      if (!filePath) return next();
      let source;
      try {
        source = await readFile(filePath, 'utf8');
      } catch {
        return next(); // Not a file — let static or the 404 handler answer.
      }
      const current = await version.refresh();
      res.set('cache-control', cacheControlFor({
        requestedVersion: typeof req.query.v === 'string' ? req.query.v : null,
        currentVersion: current,
      }));
      res.type('application/javascript').send(rewriteModuleImports(source, current));
    } catch (err) { next(err); }
  });

  router.use(express.static(root, {
    index: false,
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('.html')) {
        res.setHeader('cache-control', 'no-cache');
        return;
      }
      if (!/\.(css|svg|png|ico|woff2?)$/.test(filePath)) return;
      // `current()` rather than a refresh: `setHeaders` cannot await, and the
      // HTML route has already refreshed by the time a browser asks for the
      // assets that HTML named.
      res.setHeader('cache-control', cacheControlFor({
        requestedVersion: typeof res.req?.query?.v === 'string' ? res.req.query.v : null,
        currentVersion: version.current(),
      }));
    },
  }));

  return router;
}
