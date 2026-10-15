// tests/server-oauth-callback.test.js — the Google OAuth start + callback
// routes, end to end, without contacting Google.
//
// What is real: the Express app wiring (session middleware on Postgres,
// passport, mountAuthRoutes), the passport-google-oauth20 strategy including
// its state handling, code exchange and profile parsing, googleVerify and the
// users upsert, and the production errorHandler.
//
// What is faked: Google itself. The strategy's token endpoint and userinfo
// URL are repointed at a small local HTTP server, so the strategy runs its
// real requests and parsing against canned responses. Nothing here touches
// the network beyond 127.0.0.1. (tests/server-oauth-state.test.js covers the
// state check at the strategy level with no DB; this file covers what the
// routes do with the outcome.)
//
// Gated like the other DB suites: set ROUTES_TEST_DATABASE_URL (or reuse
// MIGRATION_TEST_DATABASE_URL). Creates its own scratch database.

import http from 'node:http';
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

// authLimiter allows 30 requests a minute per IP and every request here comes
// from 127.0.0.1, so the suite would trip it partway through. Rate limiting is
// not under test; make it a pass-through for this file only.
vi.mock('express-rate-limit', () => ({
  default: () => (_req, _res, next) => next(),
}));

const BASE_URL = process.env.ROUTES_TEST_DATABASE_URL
  || process.env.MIGRATION_TEST_DATABASE_URL;
const describeIf = BASE_URL ? describe : describe.skip;

const OAUTH_DB = 'bunvelope_oauth_callback_test';

function withDbName(url, dbName) {
  const u = new URL(url);
  u.pathname = `/${dbName}`;
  return u.toString();
}

describeIf('Google OAuth callback (fake Google, live Postgres)', () => {
  let appServer;
  let googleServer;
  let origin;          // the app, http://127.0.0.1:<port>
  let pool;
  let passport;
  let auth;

  // Canned Google. `accounts` maps an authorization code to the profile the
  // userinfo endpoint returns for it; anything else is an invalid_grant.
  const google = {
    accounts: new Map(),
    tokenRequests: [],
    userinfoAuth: [],
    userinfoFails: false,
  };

  function fakeGoogle(req, res) {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const send = (status, body) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (req.method === 'POST' && req.url === '/token') {
        const form = new URLSearchParams(Buffer.concat(chunks).toString());
        google.tokenRequests.push(Object.fromEntries(form));
        const code = form.get('code');
        if (!google.accounts.has(code)) {
          return send(400, {
            error: 'invalid_grant',
            error_description: 'GOOGLE-SIDE-SECRET-DETAIL bad code',
          });
        }
        return send(200, { access_token: `at-${code}`, token_type: 'Bearer', expires_in: 3600 });
      }
      const url = new URL(req.url, 'http://fake-google');
      if (req.method === 'GET' && url.pathname === '/userinfo') {
        // The strategy sends the token as ?access_token= (or a Bearer header).
        const token = url.searchParams.get('access_token')
          || String(req.headers.authorization || '').replace(/^Bearer /, '');
        google.userinfoAuth.push(token);
        if (google.userinfoFails) return send(401, { error: 'invalid_token' });
        const code = token.replace(/^at-/, '');
        const profile = google.accounts.get(code);
        return profile ? send(200, profile) : send(401, { error: 'invalid_token' });
      }
      return send(404, { error: 'not_found' });
    });
  }

  /** (Re)register the Google strategy from env, then aim it at fake Google. */
  function configure({ allowed } = {}) {
    if (allowed === undefined) delete process.env.ALLOWED_EMAILS;
    else process.env.ALLOWED_EMAILS = allowed;
    auth.configurePassport({ kind: 'oauth' });
    const strategy = passport._strategy('google');
    const googleOrigin = `http://127.0.0.1:${googleServer.address().port}`;
    strategy._oauth2._baseSite = googleOrigin;
    strategy._oauth2._accessTokenUrl = '/token';
    strategy._userProfileURL = `${googleOrigin}/userinfo`;
  }

  /** Minimal cookie jar: one client's view of the bv.sid session cookie. */
  function client() {
    let cookie = null;
    return {
      get cookie() { return cookie; },
      async get(path) {
        const res = await fetch(`${origin}${path}`, {
          redirect: 'manual',
          headers: cookie ? { cookie } : {},
        });
        const setSid = (res.headers.getSetCookie?.() || [])
          .find((c) => c.startsWith('bv.sid='));
        if (setSid) cookie = setSid.split(';')[0];
        const text = await res.text();
        let body = null;
        try { body = text ? JSON.parse(text) : null; } catch { body = text; }
        return {
          status: res.status,
          location: res.headers.get('location'),
          setSid: setSid || null,
          body,
          text,
        };
      },
    };
  }

  /** Begin the flow and return { client, state } as the browser would. */
  async function startFlow() {
    const c = client();
    const res = await c.get('/auth/google');
    expect(res.status).toBe(302);
    const redirect = new URL(res.location);
    return { c, redirect, state: redirect.searchParams.get('state') };
  }

  const callbackPath = (code, state) => {
    const q = new URLSearchParams();
    if (code !== undefined) q.set('code', code);
    if (state !== undefined) q.set('state', state);
    return `/auth/google/callback?${q}`;
  };

  const userRows = async () => (await pool.query(
    'select id, google_sub, email, name from users order by email',
  )).rows;

  beforeAll(async () => {
    const { default: pg } = await import('pg');
    const admin = new pg.Client({ connectionString: BASE_URL });
    await admin.connect();
    await admin.query(`drop database if exists ${OAUTH_DB} with (force)`);
    await admin.query(`create database ${OAUTH_DB}`);
    await admin.end();

    process.env.DATABASE_URL = withDbName(BASE_URL, OAUTH_DB);
    process.env.PGSSL = 'disable';
    process.env.SESSION_SECRET = 'integration-test-secret-0123456789abcdef';
    process.env.GOOGLE_CLIENT_ID = 'test-client-id';
    process.env.GOOGLE_CLIENT_SECRET = 'test-client-secret';
    delete process.env.BYPASS_GOOGLE;
    delete process.env.NODE_ENV; // secure-cookie flag off, so it works over http
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const db = await import('../server/db.js');
    pool = db.pool;
    await db.runMigrations({ log: () => {} });

    const { default: express } = await import('express');
    ({ default: passport } = await import('passport'));
    auth = await import('../server/auth.js');
    const { budgetRoutes } = await import('../server/routes/budgets.js');
    const { mountApi } = await import('../server/api-mount.js');
    const { errorHandler } = await import('../server/logging.js');

    googleServer = http.createServer(fakeGoogle);
    await new Promise((r) => googleServer.listen(0, '127.0.0.1', r));

    const app = express();
    app.use(auth.sessionMiddleware());
    app.use(passport.initialize());
    app.use(passport.session());
    auth.mountAuthRoutes(app, { kind: 'oauth' });
    mountApi(app, {
      ai: express.Router(), prices: express.Router(), budgets: budgetRoutes(),
    });
    app.use(errorHandler); // the production JSON handler, as in server/index.js
    await new Promise((r) => { appServer = app.listen(0, '127.0.0.1', r); });
    origin = `http://127.0.0.1:${appServer.address().port}`;
    process.env.OAUTH_CALLBACK_URL = `${origin}/auth/google/callback`;
  }, 60_000);

  afterAll(async () => {
    vi.restoreAllMocks();
    // close() waits for idle keep-alive sockets; drop them so teardown cannot hang.
    appServer?.closeAllConnections?.();
    if (appServer) await new Promise((r) => appServer.close(r));
    googleServer?.closeAllConnections?.();
    if (googleServer) await new Promise((r) => googleServer.close(r));
    if (pool) await pool.end();
  });

  beforeEach(async () => {
    google.accounts.clear();
    google.tokenRequests.length = 0;
    google.userinfoAuth.length = 0;
    google.userinfoFails = false;
    await pool.query('delete from users');
    configure();
  });

  it('starts the flow: redirects to Google with a state bound to a new session', async () => {
    const { c, redirect, state } = await startFlow();
    expect(redirect.origin + redirect.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(redirect.searchParams.get('response_type')).toBe('code');
    expect(redirect.searchParams.get('client_id')).toBe('test-client-id');
    expect(redirect.searchParams.get('redirect_uri')).toBe(`${origin}/auth/google/callback`);
    expect(redirect.searchParams.get('scope').split(' ')).toEqual(['openid', 'email', 'profile']);
    expect(state).toMatch(/.{16,}/);
    // The state lives in the server-side session the cookie points at.
    expect(c.cookie).toMatch(/^bv\.sid=/);
    // Nobody is signed in yet, and no user was created.
    expect((await c.get('/api/me')).status).toBe(401);
    expect(await userRows()).toEqual([]);
  });

  it('a valid callback creates the user, signs the session in and redirects home', async () => {
    google.accounts.set('good-code', {
      sub: 'google-sub-1', email: 'Alice@Example.com', name: 'Alice A', email_verified: true,
    });
    const { c, state } = await startFlow();
    const before = c.cookie;

    const cb = await c.get(callbackPath('good-code', state));
    expect(cb.status).toBe(302);
    expect(cb.location).toBe('/');
    // Login regenerates the session id: the pre-auth cookie must not survive.
    expect(cb.setSid).toMatch(/^bv\.sid=/);
    expect(c.cookie).not.toBe(before);

    // The strategy exchanged the code with our client credentials and
    // callback URL, then asked userinfo with the resulting token.
    expect(google.tokenRequests).toHaveLength(1);
    expect(google.tokenRequests[0]).toMatchObject({
      grant_type: 'authorization_code',
      code: 'good-code',
      client_id: 'test-client-id',
      client_secret: 'test-client-secret',
      redirect_uri: `${origin}/auth/google/callback`,
    });
    expect(google.userinfoAuth).toEqual(['at-good-code']);

    const rows = await userRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      google_sub: 'google-sub-1', email: 'alice@example.com', name: 'Alice A',
    });

    const me = await c.get('/api/me');
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({ id: rows[0].id, email: 'alice@example.com' });
  });

  it('signing in again matches the existing user instead of duplicating it', async () => {
    google.accounts.set('code-1', { sub: 'google-sub-1', email: 'alice@example.com', name: 'Alice A' });
    const first = await startFlow();
    await first.c.get(callbackPath('code-1', first.state));
    const [created] = await userRows();

    // Same Google account (same sub), new display name and address.
    google.accounts.set('code-2', { sub: 'google-sub-1', email: 'alice.new@example.com', name: 'Alice B' });
    const second = await startFlow();
    const cb = await second.c.get(callbackPath('code-2', second.state));
    expect(cb.location).toBe('/');

    const rows = await userRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: created.id, google_sub: 'google-sub-1', email: 'alice.new@example.com', name: 'Alice B',
    });
    expect((await second.c.get('/api/me')).body).toMatchObject({ id: created.id });
  });

  describe('state', () => {
    beforeEach(() => {
      google.accounts.set('good-code', { sub: 'google-sub-1', email: 'alice@example.com', name: 'Alice A' });
    });

    async function expectRefused(c, res) {
      expect(res.status).toBe(302);
      expect(res.location).toBe('/?auth=failed');
      expect(await userRows()).toEqual([]);
      expect((await c.get('/api/me')).status).toBe(401);
      // A refused state is caught before Google is asked anything.
      expect(google.tokenRequests).toEqual([]);
    }

    it('refuses a callback with no state', async () => {
      const { c } = await startFlow();
      await expectRefused(c, await c.get(callbackPath('good-code')));
    });

    it('refuses a callback whose state does not match the session', async () => {
      const { c } = await startFlow();
      await expectRefused(c, await c.get(callbackPath('good-code', 'not-the-state')));
    });

    it('refuses a callback carrying a state from another browser session (login CSRF)', async () => {
      const victim = await startFlow();
      const attacker = client(); // no session at all
      await expectRefused(attacker, await attacker.get(callbackPath('good-code', victim.state)));
    });

    it('refuses a callback with no session cookie even with a plausible state', async () => {
      const { state } = await startFlow();
      const stranger = client();
      await expectRefused(stranger, await stranger.get(callbackPath('good-code', state)));
    });

    it('accepts a state once: a replayed callback does not sign in again', async () => {
      const { c, state } = await startFlow();
      const ok = await c.get(callbackPath('good-code', state));
      expect(ok.location).toBe('/');

      const stolen = await fetch(`${origin}${callbackPath('good-code', state)}`, {
        redirect: 'manual', headers: { cookie: c.cookie },
      });
      // The signed-in session no longer holds the state, so this is refused
      // rather than logging anyone in a second time.
      expect(stolen.status).toBe(302);
      expect(stolen.headers.get('location')).toBe('/?auth=failed');
      expect(google.tokenRequests).toHaveLength(1);
    });
  });

  describe('Google-side failures', () => {
    // Back to the login screen with its "sign-in failed" note, like every
    // other refusal, with nothing from Google or the strategy in the
    // response, and no session.
    async function expectCleanFailure(c, res) {
      expect(res.status).toBe(302);
      expect(res.location).toBe('/?auth=failed');
      expect(res.text || '').not.toMatch(/GOOGLE-SIDE-SECRET-DETAIL|invalid_grant|invalid_token|test-client-secret|at-|stack| at /i);
      // (A cookie may be re-issued here for the pre-auth session; what matters
      // is that it is not signed in, checked via /api/me below.)
      expect(await userRows()).toEqual([]);
      expect((await c.get('/api/me')).status).toBe(401);
    }

    it('a rejected code exchange creates no user or session and leaks nothing', async () => {
      const { c, state } = await startFlow();
      await expectCleanFailure(c, await c.get(callbackPath('code-google-rejects', state)));
      expect(google.tokenRequests).toHaveLength(1);
    });

    it('a failing userinfo lookup creates no user or session and leaks nothing', async () => {
      google.accounts.set('good-code', { sub: 'google-sub-1', email: 'alice@example.com', name: 'Alice A' });
      google.userinfoFails = true;
      const { c, state } = await startFlow();
      await expectCleanFailure(c, await c.get(callbackPath('good-code', state)));
      expect(google.userinfoAuth).toEqual(['at-good-code']);
    });

    it('a Google account without an email is refused before any user row exists', async () => {
      google.accounts.set('good-code', { sub: 'google-sub-1', name: 'No Mail' });
      const { c, state } = await startFlow();
      await expectCleanFailure(c, await c.get(callbackPath('good-code', state)));
    });

    it('the user denying consent (error=access_denied) is sent back to the login page', async () => {
      const { c, state } = await startFlow();
      const res = await c.get(`/auth/google/callback?error=access_denied&state=${state}`);
      expect(res.status).toBe(302);
      expect(res.location).toBe('/?auth=failed');
      expect(google.tokenRequests).toEqual([]);
      expect(await userRows()).toEqual([]);
      expect((await c.get('/api/me')).status).toBe(401);
    });

    it('a different Google account claiming an already registered email cannot take that user over', async () => {
      google.accounts.set('owner-code', { sub: 'owner-sub', email: 'owner@example.com', name: 'Owner' });
      const owner = await startFlow();
      await owner.c.get(callbackPath('owner-code', owner.state));
      const [ownerRow] = await userRows();

      // Different sub, same address: the upsert is keyed by sub and email is
      // unique, so this must fail rather than merge into or overwrite the owner.
      google.accounts.set('imposter-code', { sub: 'imposter-sub', email: 'owner@example.com', name: 'Imposter' });
      const imposter = await startFlow();
      const res = await imposter.c.get(callbackPath('imposter-code', imposter.state));
      expect(res.status).toBe(302);
      expect(res.location).toBe('/?auth=failed');
      expect((await imposter.c.get('/api/me')).status).toBe(401);
      expect(await userRows()).toEqual([expect.objectContaining({
        id: ownerRow.id, google_sub: 'owner-sub', name: 'Owner',
      })]);
    });
  });

  describe('ALLOWED_EMAILS', () => {
    beforeEach(() => {
      configure({ allowed: 'owner@example.com, Partner@Example.com' });
      google.accounts.set('owner-code', { sub: 'owner-sub', email: 'OWNER@example.com', name: 'Owner' });
      google.accounts.set('partner-code', { sub: 'partner-sub', email: 'partner@example.com', name: 'Partner' });
      google.accounts.set('stranger-code', { sub: 'stranger-sub', email: 'stranger@example.com', name: 'Stranger' });
    });

    it('lets a listed address in, matching case-insensitively', async () => {
      const { c, state } = await startFlow();
      const cb = await c.get(callbackPath('owner-code', state));
      expect(cb.location).toBe('/');
      expect((await c.get('/api/me')).body).toMatchObject({ email: 'owner@example.com' });
    });

    it('refuses an unlisted address: back to login, no session and no users row', async () => {
      const { c, state } = await startFlow();
      const cb = await c.get(callbackPath('stranger-code', state));
      expect(cb.status).toBe(302);
      expect(cb.location).toBe('/?auth=failed');
      // Google was asked (the address is only known after the exchange)...
      expect(google.userinfoAuth).toEqual(['at-stranger-code']);
      // ...but the stranger leaves nothing behind.
      expect(await userRows()).toEqual([]);
      expect((await c.get('/api/me')).status).toBe(401);
    });

    it('ends the session of an account removed from the list when the list tightens', async () => {
      const partner = await startFlow();
      await partner.c.get(callbackPath('partner-code', partner.state));
      const owner = await startFlow();
      await owner.c.get(callbackPath('owner-code', owner.state));
      expect((await partner.c.get('/api/me')).status).toBe(200);

      // Simulates a restart with a narrower ALLOWED_EMAILS: existing 30-day
      // sessions are re-checked on every request.
      configure({ allowed: 'owner@example.com' });
      expect((await partner.c.get('/api/me')).status).toBe(401);
      expect((await owner.c.get('/api/me')).status).toBe(200);
    });
  });
});
