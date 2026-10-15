// tests/server-budgets-routes.test.js — integration tests for the cloud
// budget CRUD + blob routes against a real Postgres: ownership (IDOR),
// optimistic-concurrency 409s, batch writes, input validation.
//
// Gated like migrations.test.js: set ROUTES_TEST_DATABASE_URL (or reuse
// MIGRATION_TEST_DATABASE_URL) to enable. The suite creates and migrates
// its own scratch database (<name>_routes) so it never races the
// migrations suite, which wipes tables in the shared database.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const BASE_URL = process.env.ROUTES_TEST_DATABASE_URL
  || process.env.MIGRATION_TEST_DATABASE_URL;
const describeIf = BASE_URL ? describe : describe.skip;

const ROUTES_DB = 'bunvelope_routes_test';

function withDbName(url, dbName) {
  const u = new URL(url);
  u.pathname = `/${dbName}`;
  return u.toString();
}

describeIf('budget routes (live Postgres)', () => {
  let server;
  let base;            // http://127.0.0.1:<port>/api
  let pool;            // pool from server/db.js, for cleanup
  let userA, userB;

  // Auth stub: the route layer trusts req.isAuthenticated()/req.user, which
  // Passport normally populates from the session. Tests select the acting
  // user per request via the x-test-user header; no header → anonymous.
  const usersByKey = {};

  async function api(method, path, { user, body, prefix = '' } = {}) {
    const res = await fetch(`${base}${prefix}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(user ? { 'x-test-user': user } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  }

  beforeAll(async () => {
    // 1. Scratch database, recreated from the admin connection.
    const pgMod = await import('pg');
    const { Client } = pgMod.default;
    const admin = new Client({ connectionString: BASE_URL });
    await admin.connect();
    await admin.query(`drop database if exists ${ROUTES_DB} with (force)`);
    await admin.query(`create database ${ROUTES_DB}`);
    await admin.end();

    // 2. Point server/db.js at it BEFORE importing any server module —
    //    the pool is created at import time from DATABASE_URL.
    process.env.DATABASE_URL = withDbName(BASE_URL, ROUTES_DB);
    process.env.PGSSL = 'disable';
    const db = await import('../server/db.js');
    pool = db.pool;
    await db.runMigrations({ log: () => {} });

    // 3. Seed two users.
    const seed = async (email) => {
      const { rows } = await db.query(
        `insert into users (email, google_sub, name)
         values ($1, $2, $3) returning id, email, name`,
        [email, `sub-${email}`, email.split('@')[0]],
      );
      return rows[0];
    };
    userA = await seed('alice@example.com');
    userB = await seed('bob@example.com');
    usersByKey.alice = userA;
    usersByKey.bob = userB;
    usersByKey.carol = await seed('carol@example.com');
    usersByKey.dave = await seed('dave@example.com');
    // Dave predates the cap: three budgets against a cap of two.
    for (const name of ['d1', 'd2', 'd3']) {
      await db.query('insert into budgets (user_id, name) values ($1, $2)', [usersByKey.dave.id, name]);
    }

    // 4. Express app: JSON body + auth stub + the real router.
    const { default: express } = await import('express');
    const { budgetRoutes } = await import('../server/routes/budgets.js');
    const app = express();
    app.use(express.json({ limit: '10mb' }));
    app.use((req, _res, next) => {
      const u = usersByKey[req.get('x-test-user')];
      req.isAuthenticated = () => !!u;
      if (u) req.user = u;
      next();
    });
    app.use('/api-capped', budgetRoutes({ maxBudgetsPerUser: 2 }));
    app.use('/api', budgetRoutes());
    app.use((err, _req, res, _next) => {
      res.status(err.status || 500).json({ error: err.message || 'internal' });
    });

    await new Promise((resolve) => {
      server = app.listen(0, '127.0.0.1', resolve);
    });
    base = `http://127.0.0.1:${server.address().port}/api`;
  }, 60_000);

  afterAll(async () => {
    if (server) await new Promise((r) => server.close(r));
    if (pool) await pool.end();
  });

  it('rejects anonymous requests with 401', async () => {
    const res = await api('GET', '/budgets');
    expect(res.status).toBe(401);
  });

  let budgetId;
  let version;

  it('creates a budget and lists it for the owner only', async () => {
    const created = await api('POST', '/budgets', { user: 'alice', body: { name: 'Family' } });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ name: 'Family', version: 0 });
    budgetId = created.body.id;
    version = created.body.version;

    const mine = await api('GET', '/budgets', { user: 'alice' });
    expect(mine.body.map((b) => b.id)).toContain(budgetId);

    const theirs = await api('GET', '/budgets', { user: 'bob' });
    expect(theirs.body).toEqual([]);
  });

  it('denies cross-user access to a budget (IDOR)', async () => {
    expect((await api('GET', `/budgets/${budgetId}`, { user: 'bob' })).status).toBe(404);
    expect((await api('PATCH', `/budgets/${budgetId}`, { user: 'bob', body: { name: 'pwn' } })).status).toBe(404);
    expect((await api('PUT', `/budgets/${budgetId}/collections/transactions`, {
      user: 'bob', body: { version: 0, data: [] },
    })).status).toBe(404);
    expect((await api('DELETE', `/budgets/${budgetId}`, { user: 'bob' })).status).toBe(404);
  });

  it('returns the empty-bundle defaults for a fresh budget', async () => {
    const res = await api('GET', `/budgets/${budgetId}`, { user: 'alice' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      envelopes: [], transactions: [], accounts: [],
      budgetItems: [], envelopeTemplates: [], meta: null, version: 0,
    });
  });

  it('upserts a collection with optimistic concurrency and bumps the version', async () => {
    const txs = [{ id: 't1', type: 'expense', amount: 12.5, date: '2026-01-15' }];
    const put = await api('PUT', `/budgets/${budgetId}/collections/transactions`, {
      user: 'alice', body: { version, data: txs },
    });
    expect(put.status).toBe(200);
    expect(put.body.version).toBe(version + 1);
    version = put.body.version;

    const got = await api('GET', `/budgets/${budgetId}`, { user: 'alice' });
    expect(got.body.transactions).toEqual(txs);
    expect(got.body.version).toBe(version);
  });

  it('rejects a stale version with 409 and reports the current version', async () => {
    const res = await api('PUT', `/budgets/${budgetId}/collections/transactions`, {
      user: 'alice', body: { version: version - 1, data: [] },
    });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: 'version conflict', current: version });
  });

  it('serializes concurrent writes: one wins, one gets 409', async () => {
    const mk = () => api('PUT', `/budgets/${budgetId}/collections/envelopes`, {
      user: 'alice', body: { version, data: [{ id: 'e1', name: 'Food' }] },
    });
    const [a, b] = await Promise.all([mk(), mk()]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 409]);
    version = (a.status === 200 ? a : b).body.version;
  });

  it('validates kind, version and data on writes', async () => {
    expect((await api('PUT', `/budgets/${budgetId}/collections/nonsense`, {
      user: 'alice', body: { version, data: [] },
    })).status).toBe(400);
    expect((await api('PUT', `/budgets/${budgetId}/collections/transactions`, {
      user: 'alice', body: { data: [] },
    })).status).toBe(400);
    expect((await api('PUT', `/budgets/${budgetId}/collections/transactions`, {
      user: 'alice', body: { version },
    })).status).toBe(400);
  });

  it('writes multiple collections atomically via batch with one version bump', async () => {
    const res = await api('PUT', `/budgets/${budgetId}/batch`, {
      user: 'alice',
      body: {
        version,
        items: [
          { kind: 'accounts', data: [{ id: 'a1', name: 'Checking', type: 'bank' }] },
          { kind: 'meta', data: { schemaVersion: 8, name: 'Family', currency: 'EUR' } },
        ],
      },
    });
    expect(res.status).toBe(200);
    expect(res.body.version).toBe(version + 1);
    version = res.body.version;

    const got = await api('GET', `/budgets/${budgetId}`, { user: 'alice' });
    expect(got.body.accounts).toEqual([{ id: 'a1', name: 'Checking', type: 'bank' }]);
    expect(got.body.meta).toEqual({ schemaVersion: 8, name: 'Family', currency: 'EUR' });
  });

  it('rejects a batch containing an unknown kind without writing anything', async () => {
    const res = await api('PUT', `/budgets/${budgetId}/batch`, {
      user: 'alice',
      body: { version, items: [{ kind: 'accounts', data: [] }, { kind: 'evil', data: [] }] },
    });
    expect(res.status).toBe(400);
    // Nothing changed.
    const got = await api('GET', `/budgets/${budgetId}`, { user: 'alice' });
    expect(got.body.version).toBe(version);
    expect(got.body.accounts).toEqual([{ id: 'a1', name: 'Checking', type: 'bank' }]);
  });

  it('refuses invalid collection data without advancing the version', async () => {
    const res = await api('PUT', `/budgets/${budgetId}/collections/accounts`, {
      user: 'alice', body: { version, data: [{ id: 'bad', name: 'bad', initialBalance: 'invalid' }] },
    });
    expect(res.status).toBe(400);
    const got = await api('GET', `/budgets/${budgetId}`, { user: 'alice' });
    expect(got.body.version).toBe(version);
    expect(got.body.accounts[0].id).toBe('a1');
  });

  it('rejects repeated batch kinds before any write', async () => {
    const res = await api('PUT', `/budgets/${budgetId}/batch`, {
      user: 'alice', body: { version, items: [
        { kind: 'accounts', data: [] }, { kind: 'accounts', data: [] },
      ] },
    });
    expect(res.status).toBe(400);
  });

  it('rejects forged encryption wrappers before saving', async () => {
    const res = await api('PUT', `/budgets/${budgetId}/collections/accounts`, {
      user: 'alice', body: { version, data: { __enc: 1, iv: 'bad', ct: 'bad' } },
    });
    expect(res.status).toBe(400);
  });

  it('compares encryption configuration before replacing it', async () => {
    const { deriveKey, buildVerifier, bytesToBase64, randomBytes } = await import('../js/storage/crypto.js');
    const before = (await api('GET', '/user/encryption', { user: 'bob' })).body;
    const salt = randomBytes(16);
    const key = await deriveKey('synthetic-passphrase', salt);
    const next = { enabled: true, salt: bytesToBase64(salt), verifier: await buildVerifier(key) };
    expect((await api('POST', '/user/encryption', { user: 'bob', body: { ...next, expected: before } })).status).toBe(200);
    expect((await api('POST', '/user/encryption', { user: 'bob', body: { enabled: false, expected: before } })).status).toBe(409);
    expect((await api('GET', '/user/encryption', { user: 'bob' })).body).toEqual({ ...next, incomplete: false });
  });

  it('rotates only the key wrapper and rejects stale encryption writers', async () => {
    const crypto = await import('../js/storage/crypto.js');
    const { preparePassphraseChange, unlockDataKey } = await import('../js/storage/encryption-config.js');
    const before = (await api('GET', '/user/encryption', { user: 'bob' })).body;
    const key = await unlockDataKey(before, 'synthetic-passphrase');
    const created = await api('POST', '/budgets', { user: 'bob', body: { name: 'Encrypted' } });
    const path = `/budgets/${created.body.id}`;
    const ciphertext = await crypto.encryptJson(key, [{ id: 'a', name: 'Savings', initialBalance: 123.45 }]);
    ciphertext.kid = before.salt;
    expect((await api('PUT', path + '/collections/accounts', { user: 'bob', body: { version: 0, data: ciphertext } })).status).toBe(200);
    const original = (await api('GET', path, { user: 'bob' })).body;
    const next = await preparePassphraseChange(before, 'synthetic-passphrase', 'replacement-passphrase');
    expect((await api('POST', '/user/encryption', { user: 'bob', body: { ...next, expected: before } })).status).toBe(200);
    const stored = (await api('GET', path, { user: 'bob' })).body;
    expect(stored).toEqual(original);
    const reopened = await unlockDataKey((await api('GET', '/user/encryption', { user: 'bob' })).body, 'replacement-passphrase');
    expect(await crypto.decryptJson(reopened, stored.accounts)).toEqual([{ id: 'a', name: 'Savings', initialBalance: 123.45 }]);
    expect((await api('PUT', path + '/collections/accounts', {
      user: 'bob', body: { version: 1, data: [] },
    })).status).toBe(409);
    // Disabling while ciphertext remains must not discard the only key config.
    expect((await api('POST', '/user/encryption', { user: 'bob', body: { enabled: false, expected: next } })).status).toBe(409);
    const wrong = { ...ciphertext, kid: 'stale-key' };
    expect((await api('PUT', path + '/collections/accounts', { user: 'bob', body: { version: 1, data: wrong } })).status).toBe(409);
    expect((await api('GET', path, { user: 'bob' })).body).toEqual(stored);
  });

  it('keeps the budget row locked until its blob snapshot has been read', async () => {
    const blocker = await pool.connect();
    const contender = await pool.connect();
    let pending;
    try {
      await blocker.query('begin');
      await blocker.query('lock table budget_blobs in access exclusive mode');
      pending = api('GET', `/budgets/${budgetId}`, { user: 'alice' });
      // The reader has read its version and is now waiting to read its blobs.
      let waiting = false;
      for (let i = 0; i < 100; i++) {
        const r = await contender.query("select 1 from pg_stat_activity where query like 'select kind, data from budget_blobs%' and wait_event_type = 'Lock'");
        if (r.rows.length) { waiting = true; break; }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
      await contender.query("set lock_timeout = '100ms'");
      await expect(contender.query('select version from budgets where id = $1 for update', [budgetId])).rejects.toMatchObject({ code: '55P03' });
      await blocker.query('commit');
      const got = await pending;
      expect(got.body.version).toBe(version);
      expect(got.body.accounts[0].id).toBe('a1');
    } finally {
      await blocker.query('rollback');
      if (pending) await pending;
      await contender.query('reset lock_timeout');
      blocker.release(); contender.release();
    }
  });

  it('renames and deletes the budget for the owner', async () => {
    const renamed = await api('PATCH', `/budgets/${budgetId}`, { user: 'alice', body: { name: 'Household' } });
    expect(renamed.status).toBe(200);
    expect(renamed.body.name).toBe('Household');

    expect((await api('DELETE', `/budgets/${budgetId}`, { user: 'alice' })).status).toBe(204);
    expect((await api('GET', `/budgets/${budgetId}`, { user: 'alice' })).status).toBe(404);
  });
  it('404s a malformed budget id instead of surfacing a Postgres error', async () => {
    for (const [method, path] of [
      ['GET', '/budgets/not-a-uuid'],
      ['PATCH', '/budgets/1'],
      ['DELETE', '/budgets/abc'],
      ['PUT', '/budgets/xyz/collections/envelopes'],
      ['PUT', '/budgets/xyz/batch'],
    ]) {
      const body = method === 'GET' ? undefined : { name: 'x', version: 0, data: [], items: [] };
      const res = await api(method, path, { user: 'alice', body });
      expect(res.status, `${method} ${path}`).toBe(404);
      expect(res.body).toEqual({ error: 'not found' });
    }
  });

  it('caps budget name length on create and rename', async () => {
    const long = 'n'.repeat(201);
    const created = await api('POST', '/budgets', { user: 'carol', body: { name: long } });
    expect(created.status).toBe(400);
    expect(created.body).toEqual({ error: 'name too long', max: 200 });
    const ok = await api('POST', '/budgets', { user: 'carol', body: { name: 'n'.repeat(200) } });
    expect(ok.status).toBe(201);
    const renamed = await api('PATCH', `/budgets/${ok.body.id}`, { user: 'carol', body: { name: long } });
    expect(renamed.status).toBe(400);
    await api('DELETE', `/budgets/${ok.body.id}`, { user: 'carol' });
  });

  it('caps the number of budgets a user can create', async () => {
    const make = (name) => api('POST', '/budgets', { user: 'carol', body: { name }, prefix: '-capped' });
    expect((await make('c1')).status).toBe(201);
    expect((await make('c2')).status).toBe(201);
    const third = await make('c3');
    expect(third.status).toBe(403);
    expect(third.body).toEqual({ error: 'budget limit reached', max: 2 });
  });

  it('leaves budgets that predate the cap usable', async () => {
    const list = await api('GET', '/budgets', { user: 'dave', prefix: '-capped' });
    expect(list.body.map((b) => b.name).sort()).toEqual(['d1', 'd2', 'd3']);
    const refused = await api('POST', '/budgets', { user: 'dave', body: { name: 'd4' }, prefix: '-capped' });
    expect(refused.status).toBe(403);
    const renamed = await api('PATCH', `/budgets/${list.body[0].id}`, {
      user: 'dave', body: { name: 'd1b' }, prefix: '-capped',
    });
    expect(renamed.status).toBe(200);
  });

  // Display preferences follow the user across devices (ux-review U13).
  it('starts a user with empty prefs and merges patches key by key', async () => {
    expect((await api('GET', '/user/prefs', { user: 'carol' })).body).toEqual({ prefs: {} });

    const first = await api('PATCH', '/user/prefs', {
      user: 'carol', body: { prefs: { lang: 'fi', lens: 'booked', tourSeen: true } },
    });
    expect(first.status).toBe(200);
    // A second device changing a different key does not undo the first.
    const second = await api('PATCH', '/user/prefs', {
      user: 'carol', body: { prefs: { density: 'compact', envGroupsCollapsed: ['Daily'] } },
    });
    expect(second.body.prefs).toEqual({
      lang: 'fi', lens: 'booked', tourSeen: true, density: 'compact', envGroupsCollapsed: ['Daily'],
    });
    expect((await api('GET', '/user/prefs', { user: 'carol' })).body.prefs.lang).toBe('fi');
  });

  it('removes a pref patched to null and keeps prefs per user', async () => {
    const res = await api('PATCH', '/user/prefs', { user: 'carol', body: { prefs: { density: null } } });
    expect(res.body.prefs).not.toHaveProperty('density');
    expect((await api('GET', '/user/prefs', { user: 'dave' })).body).toEqual({ prefs: {} });
    expect((await api('GET', '/user/prefs')).status).toBe(401);
  });

  it('rejects malformed prefs and a patch that would exceed the size cap', async () => {
    const bad = [
      [1, 2],
      { 'bad key': true },
      { nested: { a: 1 } },
      { list: [1, 2] },
      { long: 'x'.repeat(201) },
    ];
    for (const prefs of bad) {
      expect((await api('PATCH', '/user/prefs', { user: 'carol', body: { prefs } })).status).toBe(400);
    }
    // 40 keys × 200-char strings is ~8.5 KB: each value is valid, the total is not.
    const big = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`k${i}`, 'x'.repeat(200)]));
    expect((await api('PATCH', '/user/prefs', { user: 'carol', body: { prefs: big } })).status).toBe(413);
    expect((await api('GET', '/user/prefs', { user: 'carol' })).body.prefs.lang).toBe('fi');
  });

  it('reads the cap from MAX_BUDGETS_PER_USER, defaulting to 50', async () => {
    const { budgetCapFromEnv } = await import('../server/routes/budgets.js');
    expect(budgetCapFromEnv({})).toBe(50);
    expect(budgetCapFromEnv({ MAX_BUDGETS_PER_USER: '3' })).toBe(3);
    expect(budgetCapFromEnv({ MAX_BUDGETS_PER_USER: 'nope' })).toBe(50);
    expect(budgetCapFromEnv({ MAX_BUDGETS_PER_USER: '0' })).toBe(50);
  });
});
