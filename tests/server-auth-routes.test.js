// tests/server-auth-routes.test.js — live-Postgres integration for the
// bypass-mode auth endpoints: login (env bootstrap + scrypt hash paths),
// forced rotation policy, password change, logout, session wiring into the
// /api router, and the same-origin guard.
//
// Gated like the other DB suites: set ROUTES_TEST_DATABASE_URL (or reuse
// MIGRATION_TEST_DATABASE_URL). Creates its own scratch database so it
// never races the migrations or budgets-routes suites.
//
// The Google OAuth flow lives in tests/server-oauth-callback.test.js (against
// a fake Google); this file covers the bypass mode.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const BASE_URL = process.env.ROUTES_TEST_DATABASE_URL
  || process.env.MIGRATION_TEST_DATABASE_URL;
const describeIf = BASE_URL ? describe : describe.skip;

const AUTH_DB = 'bunvelope_auth_test';
// Deliberately shorter than BYPASS_PASSWORD_MIN_LEN (16) to exercise the
// forced-rotation path.
const BOOT_PW = 'short-boot-pw';
const STRONG_PW = 'a-much-longer-rotated-password';

function withDbName(url, dbName) {
  const u = new URL(url);
  u.pathname = `/${dbName}`;
  return u.toString();
}

describeIf('auth routes (bypass mode, live Postgres)', () => {
  let server;
  let origin;          // http://127.0.0.1:<port>
  let pool;
  let cookie = null;   // current session cookie ("bv.sid=...")

  async function req(method, path, { body, withCookie = true, headers = {} } = {}) {
    const res = await fetch(`${origin}${path}`, {
      method,
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(withCookie && cookie ? { cookie } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'manual',
    });
    const setCookies = res.headers.getSetCookie?.() || [];
    const sid = setCookies.find((c) => c.startsWith('bv.sid='));
    const text = await res.text();
    return {
      status: res.status,
      body: text ? JSON.parse(text) : null,
      setSid: sid ? sid.split(';')[0] : null,
    };
  }

  beforeAll(async () => {
    const pgMod = await import('pg');
    const { Client } = pgMod.default;
    const admin = new Client({ connectionString: BASE_URL });
    await admin.connect();
    await admin.query(`drop database if exists ${AUTH_DB} with (force)`);
    await admin.query(`create database ${AUTH_DB}`);
    await admin.end();

    // Environment must be in place before any server module is imported:
    // db.js builds its pool and auth.js reads mode/secret at call time.
    process.env.DATABASE_URL = withDbName(BASE_URL, AUTH_DB);
    process.env.PGSSL = 'disable';
    process.env.SESSION_SECRET = 'integration-test-secret-0123456789abcdef';
    process.env.BYPASS_GOOGLE = 'true';
    process.env.BYPASS_PASSWORD = BOOT_PW;
    delete process.env.NODE_ENV; // secure-cookie flag off → works over http

    const db = await import('../server/db.js');
    pool = db.pool;
    await db.runMigrations({ log: () => {} });

    // Assemble the app exactly as server/index.js does for the auth + api
    // surface (helmet/static/logging omitted — not under test).
    const { default: express } = await import('express');
    const { default: passport } = await import('passport');
    const auth = await import('../server/auth.js');
    const { budgetRoutes } = await import('../server/routes/budgets.js');

    const mode = auth.readAuthMode();
    expect(mode.kind).toBe('bypass');

    const app = express();
    app.use(auth.sessionMiddleware());
    auth.configurePassport(mode);
    app.use(passport.initialize());
    app.use(passport.session());
    auth.mountAuthRoutes(app, mode);
    const { mountApi } = await import('../server/api-mount.js');
    mountApi(app, {
      ai: express.Router(), prices: express.Router(), budgets: budgetRoutes(),
    });
    app.use((err, _req, res, _next) => {
      res.status(err.status || 500).json({ error: err.message || 'internal' });
    });

    await new Promise((resolve) => {
      server = app.listen(0, '127.0.0.1', resolve);
    });
    origin = `http://127.0.0.1:${server.address().port}`;
  }, 60_000);

  afterAll(async () => {
    if (server) await new Promise((r) => server.close(r));
    if (pool) await pool.end();
  });

  it('rejects API requests without a session', async () => {
    const res = await req('GET', '/api/me');
    expect(res.status).toBe(401);
  });

  it('rejects a wrong password without establishing a session', async () => {
    const res = await req('POST', '/auth/password', { body: { password: 'nope' } });
    expect(res.status).toBe(401);
    expect(res.setSid).toBe(null);
  });

  it('logs in with the env bootstrap password and flags forced rotation', async () => {
    const res = await req('POST', '/auth/password', { body: { password: BOOT_PW } });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, mustChangePassword: true });
    // The session is created at login, not before (saveUninitialized:false),
    // so a fresh sid here means no pre-auth session id is carried over.
    expect(res.setSid).toMatch(/^bv\.sid=/);
    cookie = res.setSid;
  });

  it('refuses the API to a bootstrap-password session until it rotates', async () => {
    const me = await req('GET', '/api/me');
    expect(me.status).toBe(401);
    expect(me.body).toEqual({ error: 'password_change_required' });
    const list = await req('GET', '/api/budgets');
    expect(list.status).toBe(403);
    expect(list.body).toEqual({ error: 'password_change_required' });
  });

  it('validates the change-password flow', async () => {
    const anon = await req('POST', '/auth/password/change', {
      withCookie: false, body: { current: BOOT_PW, new: STRONG_PW },
    });
    expect(anon.status).toBe(401);

    const wrong = await req('POST', '/auth/password/change', {
      body: { current: 'nope', new: STRONG_PW },
    });
    expect(wrong.status).toBe(401);

    const short = await req('POST', '/auth/password/change', {
      body: { current: BOOT_PW, new: 'tiny' },
    });
    expect(short.status).toBe(400);
    expect(short.body).toMatchObject({ error: 'password_too_short', min: 16 });

    const good = await req('POST', '/auth/password/change', {
      body: { current: BOOT_PW, new: STRONG_PW },
    });
    expect(good.status).toBe(200);
  });

  it('lifts the gate on the same session once the password is rotated', async () => {
    const res = await req('GET', '/api/me');
    expect(res.status).toBe(200);
    expect(res.body.email).toBe('bypass@local');
  });

  it('enforces same-origin on state-changing /api requests', async () => {
    const evil = await req('POST', '/api/budgets', {
      body: { name: 'pwn' },
      headers: { origin: 'https://evil.example' },
    });
    expect(evil.status).toBe(403);

    const ok = await req('POST', '/api/budgets', {
      body: { name: 'Mine' },
      headers: { origin },
    });
    expect(ok.status).toBe(201);
  });

  it('consults the stored hash after rotation, not the env var', async () => {
    const oldPw = await req('POST', '/auth/password', {
      withCookie: false, body: { password: BOOT_PW },
    });
    expect(oldPw.status).toBe(401);

    const newPw = await req('POST', '/auth/password', {
      withCookie: false, body: { password: STRONG_PW },
    });
    expect(newPw.status).toBe(200);
    expect(newPw.body).toMatchObject({ ok: true, mustChangePassword: false });
    cookie = newPw.setSid;
  });

  it('logout refuses a cross-origin request and keeps the session', async () => {
    const out = await req('POST', '/auth/logout', {
      headers: { origin: 'https://evil.example' },
    });
    expect(out.status).toBe(403);

    const after = await req('GET', '/api/me');
    expect(after.status).toBe(200);
  });

  it('logout destroys the session', async () => {
    const out = await req('POST', '/auth/logout');
    expect(out.status).toBe(200);
    expect(out.body).toEqual({ ok: true });

    const after = await req('GET', '/api/me');
    expect(after.status).toBe(401);
  });
});
