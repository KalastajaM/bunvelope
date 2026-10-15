// server/index.js — Express bootstrap. Serves the static frontend,
// /api/* JSON endpoints, /auth/* OAuth routes, and injects the cloud
// mode marker into index.html.

import 'dotenv/config';
import path from 'node:path';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import express from 'express';
import compression from 'compression';
import helmet from 'helmet';
import passport from 'passport';
import pinoHttp from 'pino-http';
import { pool, runMigrations, createHealthcheck } from './db.js';
import { healthHandler } from './health.js';
import { createShutdown } from './shutdown.js';
import {
  sessionMiddleware,
  configurePassport,
  mountAuthRoutes,
  readAuthMode,
  ensureBypassUser,
} from './auth.js';
import { mountApi } from './api-mount.js';
import { httpLoggerOptions, errorHandler } from './logging.js';
import { budgetRoutes } from './routes/budgets.js';
import { aiRoutes } from './routes/ai.js';
import { pricesRoutes } from './routes/prices.js';
import { cspDirectives } from './csp.js';
import { trustProxySetting } from './proxy.js';
import { createAssetVersion, rewriteHtmlAssets, assetRouter } from './asset-fingerprint.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const app = express();
// Behind a TLS-terminating reverse proxy set TRUST_PROXY=1 so req.ip and
// req.secure come from X-Forwarded-*; run directly, nothing is trusted.
app.set('trust proxy', trustProxySetting(process.env.TRUST_PROXY));

// Per-request nonce for the inline mode-marker script (the only inline
// script we serve). All other scripts are external modules under /js.
app.use((_req, res, next) => {
  res.locals.cspNonce = crypto.randomBytes(16).toString('base64');
  next();
});

app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: false,
    directives: cspDirectives(),
  },
  // The cross-origin policies don't impact this app and can stay at the
  // helmet defaults; only CSP needed adjustment.
}));
app.use(compression());
// Redacts session cookies and auth headers, and strips request bodies from
// logged errors. See server/logging.js.
app.use(pinoHttp(httpLoggerOptions()));

// Read auth mode once at boot. BYPASS_GOOGLE/BYPASS_PASSWORD env vars are
// read here and never re-read; toggling them requires a server restart.
const authMode = readAuthMode();

app.use(sessionMiddleware());
configurePassport(authMode);
app.use(passport.initialize());
app.use(passport.session());

// Health check — liveness probe for docker/process supervisors.
// Healthy = database up AND every migration on disk applied (see
// server/health.js); the pending list is cached inside createHealthcheck.
app.get('/healthz', healthHandler(createHealthcheck()));

// Auth routes — Google OAuth or bypass-password depending on env.
mountAuthRoutes(app, authMode);

// Mount API: IP limit, same-origin and auth run before any body parser. See
// server/api-mount.js for why the order matters.
mountApi(app, { ai: aiRoutes(), prices: pricesRoutes(), budgets: budgetRoutes() });

// Custom root handler — injects window.__BUNVELOPE_MODE before serving
// index.html. Everything else is plain static.
// Per-deploy version token stamped onto every local asset URL. See
// server/asset-fingerprint.js for why this happens at serve time rather than
// in a build step.
const assetVersion = createAssetVersion({ root: ROOT });

app.get('/', async (_req, res, next) => {
  try {
    const html = await fs.readFile(path.join(ROOT, 'index.html'), 'utf8');
    const mode = { kind: 'cloud', bypassGoogle: authMode.kind === 'bypass' };
    const nonce = res.locals.cspNonce;
    const injection = `<script id="bv-mode" nonce="${nonce}">window.__BUNVELOPE_MODE=${
      JSON.stringify(mode)
    };</script>`;
    const withMode = html.includes('<script id="bv-mode"></script>')
      ? html.replace('<script id="bv-mode"></script>', injection)
      : html.replace('</head>', `  ${injection}\n</head>`);
    // The entry point is `no-cache`, so stamping the token here is what makes
    // a deploy visible: new HTML names new asset URLs, and the browser fetches
    // them instead of reusing what it already holds.
    const version = await assetVersion.refresh();
    res.set('cache-control', 'no-cache');
    res.type('html').send(rewriteHtmlAssets(withMode, version));
  } catch (err) { next(err); }
});

// Everything else static, with a per-deploy token on each URL so assets can be
// cached immutably and a deploy still lands on the next page load. STATIC_MAX_AGE
// is gone: it traded a fixed staleness window for fewer requests, and
// fingerprinting gives both.
app.use(assetRouter({ root: ROOT, version: assetVersion }));

// JSON error handler — never leak stack traces or request bodies.
app.use(errorHandler);

const port = Number(process.env.PORT) || 3000;

async function main() {
  // Operators can run migrations out-of-band (`npm run migrate`, a separate
  // step) and set SKIP_MIGRATIONS=1 to keep boot fast.
  if (process.env.SKIP_MIGRATIONS === '1') {
    console.log('migrations: SKIP_MIGRATIONS=1, skipping boot-time run');
  } else {
    await runMigrations({ info: (m, msg) => console.log(msg, m), log: console.log });
  }
  if (authMode.kind === 'bypass') {
    await ensureBypassUser();
    console.log('auth: BYPASS_GOOGLE active — Google login disabled, password gate enabled');
  }
  const server = app.listen(port, () => {
    console.log(`bunvelope listening on :${port}`);
  });
  // Waits for in-flight requests (up to 10 s) before closing the pool.
  const shutdown = createShutdown({ server, pool });
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('fatal boot error:', err);
  process.exit(1);
});
