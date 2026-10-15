// The /api middleware order: nothing reads a request body before the caller
// is rate-limited, origin-checked and authenticated. Proven by status codes:
// a malformed or oversized body from an anonymous client must come back 401
// (auth ran first), never 400/413 (a parser ran first).

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import { mountApi, apiIpLimiter, budgetBodyLimit } from '../server/api-mount.js';
import { errorHandler } from '../server/logging.js';

let server; let base;

function echoRouter(name) {
  const r = express.Router();
  r.use((req, res) => res.json({ router: name, bytes: JSON.stringify(req.body ?? null).length }));
  return r;
}

function start(app) {
  return new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
}

function buildApp({ ipMax = 1000, budgetLimit } = {}) {
  const app = express();
  app.use((req, _res, next) => {
    const user = req.get('x-test-user');
    req.isAuthenticated = () => !!user;
    if (user) req.user = { id: user };
    req.session = { mustChangePassword: req.get('x-test-must-change') === '1' };
    next();
  });
  mountApi(app, {
    ai: echoRouter('ai'),
    prices: echoRouter('prices'),
    budgets: echoRouter('budgets'),
    ipLimiter: apiIpLimiter({ max: ipMax }),
    budgetLimit,
  });
  app.use(errorHandler);
  return app;
}

beforeAll(async () => {
  server = await start(buildApp());
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(() => new Promise((resolve) => server.close(resolve)));

const post = (path, body, headers = {}) => fetch(`${base}${path}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  body,
});

describe('mountApi ordering', () => {
  it('prevents caching of financial responses and authentication failures', async () => {
    for (const headers of [{}, { 'x-test-user': 'u1' }]) {
      const res = await fetch(`${base}/api/budgets`, { headers });
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(res.status).toBe(headers['x-test-user'] ? 200 : 401);
    }
  });

  it('accepts a budget batch above the old 10 MiB limit, including history', async () => {
    const body = JSON.stringify({ version: 1, items: [
      { kind: 'budgetItems', data: [{ id: 'expense', stress_category: 'B' }] },
      { kind: 'meta', data: { financialHistory: { fixture: 'x'.repeat(11 * 1024 * 1024) } } },
    ] });
    const res = await fetch(`${base}/api/budgets/test/batch`, {
      method: 'PUT', headers: { 'content-type': 'application/json', 'x-test-user': 'u1' }, body,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ router: 'budgets', bytes: body.length });
  });

  it('retains a configurable budget limit and explains rejected saves', async () => {
    const limited = await start(buildApp({ budgetLimit: budgetBodyLimit({ BUDGET_BODY_LIMIT_MB: '1' }) }));
    try {
      const res = await fetch(`http://127.0.0.1:${limited.address().port}/api/budgets/test/batch`, {
        method: 'PUT', headers: { 'content-type': 'application/json', 'x-test-user': 'u1' },
        body: JSON.stringify({ blob: 'x'.repeat(1024 * 1024) }),
      });
      expect(res.status).toBe(413);
      expect(await res.json()).toEqual({ error: 'Request exceeds the server size limit. No changes were saved.' });
    } finally {
      await new Promise(resolve => limited.close(resolve));
    }
  });

  it('defaults to 64 MiB and refuses invalid configured limits', () => {
    expect(budgetBodyLimit({})).toBe(64 * 1024 * 1024);
    expect(budgetBodyLimit({ BUDGET_BODY_LIMIT_MB: '128' })).toBe(128 * 1024 * 1024);
    for (const value of ['', '0', '-1', '1.5', 'invalid', 'Infinity']) {
      expect(() => budgetBodyLimit({ BUDGET_BODY_LIMIT_MB: value })).toThrow('positive integer');
    }
  });

  it('authenticates before parsing: malformed JSON from an anonymous client is 401', async () => {
    const res = await post('/api/budgets', '{not json');
    expect(res.status).toBe(401);
  });

  it('authenticates before parsing: an oversized anonymous body is 401, not 413', async () => {
    const big = JSON.stringify({ blob: 'x'.repeat(11 * 1024 * 1024) });
    const res = await post('/api/ai/messages', big);
    expect(res.status).toBe(401);
  });

  it('checks origin before anything else reads the body', async () => {
    const res = await post('/api/budgets', '{not json', { origin: 'https://evil.example' });
    expect(res.status).toBe(403);
  });

  it('still parses for a signed-in user, with the per-route limits', async () => {
    const auth = { 'x-test-user': 'u1' };
    expect((await post('/api/budgets', '{not json', auth)).status).toBe(400);
    const mid = JSON.stringify({ blob: 'x'.repeat(300 * 1024) });
    expect((await post('/api/ai/insight', mid, auth)).status).toBe(413);
    const ok = await post('/api/ai/messages', mid, auth);
    expect(ok.status).toBe(200);
    expect((await ok.json()).router).toBe('ai');
    const bud = await post('/api/budgets', JSON.stringify({ a: 1 }), auth);
    expect((await bud.json()).router).toBe('budgets');
  });

  it('rate-limits by IP ahead of authentication', async () => {
    const limited = await start(buildApp({ ipMax: 3 }));
    const url = `http://127.0.0.1:${limited.address().port}/api/budgets`;
    const statuses = [];
    for (let i = 0; i < 5; i++) {
      statuses.push((await fetch(url, { method: 'POST', body: '{}' })).status);
    }
    await new Promise((resolve) => limited.close(resolve));
    expect(statuses).toEqual([401, 401, 401, 429, 429]);
  });
});

describe('forced password rotation', () => {
  const headers = { 'x-test-user': 'u1', 'x-test-must-change': '1' };

  it('refuses the API until the password is rotated', async () => {
    const res = await post('/api/budgets', JSON.stringify({ name: 'x' }), headers);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'password_change_required' });
  });

  it('answers /api/me as signed-out so the client falls back to the login screen', async () => {
    const res = await fetch(`${base}/api/me`, { headers });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'password_change_required' });
  });
});
