// server/api-mount.js — the /api/* middleware chain, in one place so its
// ORDER can be tested. server/index.js boots a database on import and
// cannot be mounted in a test.
//
// The order is the point. Body parsers buffer and JSON.parse the whole
// request synchronously. When they ran ahead of
// authentication, an anonymous client could loop 12 MB POSTs and hold the
// event loop without ever presenting a session, and every rate limiter sat
// behind requireAuth where it could not see that traffic. Now a request is
// rate-limited by IP, origin-checked and authenticated before a single body
// byte is read; only a signed-in user reaches a large parser.

import express from 'express';
import rateLimit from 'express-rate-limit';
import { requireAuth, requireSameOrigin, requirePasswordRotated } from './auth.js';

/**
 * Per-IP ceiling across all of /api, counted before authentication. Generous
 * on purpose: a household behind one NAT shares it, and the per-user limiters
 * inside each router remain the real budget for signed-in traffic. This one
 * only has to stop a single anonymous source from flooding.
 */
export function apiIpLimiter({ windowMs = 60_000, max = 600 } = {}) {
  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => `ip:${req.ip}`,
  });
}

export function budgetBodyLimit(env = process.env) {
  const mb = Number(env.BUDGET_BODY_LIMIT_MB ?? 64);
  if (!Number.isSafeInteger(mb) || mb < 1 || !Number.isSafeInteger(mb * 1024 * 1024)) {
    throw new TypeError('BUDGET_BODY_LIMIT_MB must be a positive integer in MiB');
  }
  return mb * 1024 * 1024;
}

/**
 * Mount the API surface on `app`.
 *
 * @param {import('express').Express} app
 * @param {object} opts
 * @param {import('express').RequestHandler} opts.ai       aiRoutes()
 * @param {import('express').RequestHandler} opts.prices   pricesRoutes()
 * @param {import('express').RequestHandler} opts.budgets  budgetRoutes()
 * @param {import('express').RequestHandler} [opts.ipLimiter]
 * @param {number} [opts.budgetLimit] Budget request limit in bytes.
 */
export function mountApi(app, { ai, prices, budgets, ipLimiter = apiIpLimiter(), budgetLimit = budgetBodyLimit() }) {
  // Financial data and auth failures must not survive in browser/proxy caches.
  app.use('/api', (_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  app.use('/api', ipLimiter, requireSameOrigin, requireAuth, requirePasswordRotated);

  // /api/ai/messages carries receipt images and statement PDFs as base64, so
  // it is parsed first with its own larger limit; the tight 256 KB default
  // still governs every other AI endpoint (express.json skips a body that
  // has already been parsed).
  app.use('/api/ai/messages', express.json({ limit: '12mb' }));
  app.use('/api/ai', express.json({ limit: '256kb' }), ai);
  app.use('/api/price-fetch', express.json({ limit: '4kb' }), prices);
  // A small edit also saves meta.financialHistory, including its current
  // calculation snapshot and revisions. Encrypted blobs add base64 overhead.
  app.use('/api', express.json({ limit: budgetLimit }), budgets);
}
