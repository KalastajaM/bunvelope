// A malformed JSON body must never reach the logs. body-parser attaches the
// raw body to the error it raises, and pino's serializer copies it.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Writable } from 'node:stream';
import express from 'express';
import pinoHttp from 'pino-http';
import { httpLoggerOptions, errorHandler } from '../server/logging.js';

const SECRET = 'Payee-Dr-Hansson-Clinic-4471';
let server; let base; const lines = [];

beforeAll(async () => {
  const sink = new Writable({
    write(chunk, _enc, cb) { lines.push(chunk.toString()); cb(); },
  });
  const app = express();
  app.use(pinoHttp(httpLoggerOptions(), sink));
  app.use(express.json({ limit: '1mb' }));
  app.post('/api/x', (_req, res) => res.json({ ok: true }));
  app.get('/auth/google/callback', (_req, res) => res.sendStatus(204));
  app.get('/boom', (_req, _res, next) => {
    const err = new Error('boom');
    err.body = { payee: SECRET };
    next(err);
  });
  app.use(errorHandler);
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(() => new Promise((resolve) => server.close(resolve)));

describe('request logging', () => {
  it('does not log the raw body of an unparseable request', async () => {
    const body = `{"transactions":[{"payee":"${SECRET}"}], oops`;
    const res = await fetch(`${base}/api/x`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body,
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'internal error' });
    await new Promise((r) => setTimeout(r, 20));
    const log = lines.join('');
    expect(log).toContain('request failed');
    expect(log).toContain('request body could not be parsed');
    expect(log).not.toContain(SECRET);
    expect(log).not.toContain('"body"');
  });

  it('drops a body attached to any other error as well', async () => {
    lines.length = 0;
    const res = await fetch(`${base}/boom`);
    expect(res.status).toBe(500);
    await new Promise((r) => setTimeout(r, 20));
    const log = lines.join('');
    expect(log).toContain('boom');
    expect(log).not.toContain(SECRET);
  });

  it('does not retain OAuth codes, state, or referring query strings', async () => {
    lines.length = 0;
    const response = await fetch(`${base}/auth/google/callback?code=secret-code&state=secret-state`, {
      headers: { referer: 'https://example.test/?token=secret-referrer' },
    });
    expect(response.status).toBe(204);
    await new Promise(r => setTimeout(r, 20));
    const log = lines.join('');
    expect(log).toContain('/auth/google/callback');
    for (const secret of ['secret-code', 'secret-state', 'secret-referrer']) {
      expect(log).not.toContain(secret);
    }
  });

  it('keeps redacting the session cookie', async () => {
    lines.length = 0;
    await fetch(`${base}/api/x`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: 'bv.sid=s%3Asecret-session' },
      body: '{}',
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(lines.join('')).not.toContain('secret-session');
  });
});
