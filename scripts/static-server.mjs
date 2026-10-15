// scripts/static-server.mjs — the static-mode dev server (local folder and
// guest mode): serves the repo root like `python3 -m http.server`, but every
// response says `Cache-Control: no-store`.
//
// Why not the Python one: it sends no cache headers, so Chrome caches the ES
// modules heuristically, and after a branch switch or a pull a page can load a
// mix of old and new modules and fail with "does not provide an export named
// …" until each module is fetched again (BACKLOG 2026-10-02). index.html ships
// an empty <script id="bv-mode">, so the client stays in static mode; /api/*
// is a 404, exactly as with any static server.
//
//   node scripts/static-server.mjs [port]      (default 8080, or $PORT)
//
// The e2e static project runs the same server (e2e/static-server.js).

import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
};

/**
 * Start serving the repo root on `port` (127.0.0.1). Resolves the server once
 * it listens.
 * @param {number} port
 * @param {string} [label]
 */
export function startStaticServer(port, label = 'static server') {
  const server = http.createServer(async (req, res) => {
    try {
      let rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      if (rel.endsWith('/')) rel += 'index.html';
      const file = path.resolve(ROOT, `.${rel}`);
      // Stay inside the repo root (../ traversal, sibling-prefix directories).
      if (file !== ROOT && !file.startsWith(ROOT + path.sep)) {
        res.writeHead(403).end('forbidden');
        return;
      }
      if (!(await stat(file)).isFile()) throw new Error('not a file');
      const body = await readFile(file);
      res.writeHead(200, {
        'content-type': TYPES[path.extname(file)] || 'application/octet-stream',
        'cache-control': 'no-store',
      });
      res.end(body);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain', 'cache-control': 'no-store' }).end('not found');
    }
  });
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      console.log(`${label} on http://localhost:${port}`);
      resolve(server);
    });
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.argv[2] || process.env.PORT || 8080);
  startStaticServer(port, 'Bunvelope (static mode)');
}
