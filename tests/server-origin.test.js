import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import { requireSameOrigin, mountAuthRoutes } from '../server/auth.js';
import { errorHandler } from '../server/logging.js';

let server; let base;
beforeAll(async () => {
  const app = express();
  // Only loopback is a trusted reverse proxy in this test.
  app.set('trust proxy', 'loopback');
  app.post('/write', requireSameOrigin, (_req, res) => res.sendStatus(204));
  mountAuthRoutes(app, { kind: 'bypass', bypassPassword: 'test-password' });
  app.use(errorHandler);
  server = await new Promise(resolve => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(() => new Promise(resolve => server.close(resolve)));
const post = (path, headers = {}, body = '') => fetch(base + path, { method: 'POST', headers, body });

describe('origin enforcement', () => {
  it('accepts the exact origin and non-browser callers without Origin', async () => {
    expect((await post('/write', { origin: base })).status).toBe(204);
    expect((await post('/write')).status).toBe(204);
  });

  it('rejects a different scheme, port, host, and malformed origin', async () => {
    for (const origin of [base.replace('http:', 'https:'), 'http://127.0.0.1:1',
      'https://evil.example', 'null', base + '/path', base + '?query',
      base.replace('://', '://user@')]) {
      expect([400, 403]).toContain((await post('/write', { origin })).status);
    }
  });

  it('uses the trusted proxy protocol for TLS termination', async () => {
    const origin = base.replace('http:', 'https:');
    expect((await post('/write', { origin, 'x-forwarded-proto': 'https' })).status).toBe(204);
    expect((await post('/write', { origin: base, 'x-forwarded-proto': 'https' })).status).toBe(403);
  });

  it('refuses browser cross-site metadata when Origin is absent', async () => {
    expect((await post('/write', { 'sec-fetch-site': 'cross-site' })).status).toBe(403);
  });

  it.each(['/auth/password', '/auth/password/change', '/auth/logout'])(
    'checks origin before parsing or handling %s', async path => {
      const res = await post(path, { origin: 'https://evil.example',
        'content-type': 'application/json' }, '{malformed');
      expect(res.status).toBe(403);
      expect(res.headers.get('cache-control')).toBe('no-store');
    },
  );

  it('authenticates password changes before parsing', async () => {
    const res = await post('/auth/password/change', {
      'content-type': 'application/json', origin: base,
    }, '{malformed');
    expect(res.status).toBe(401);
  });
});
