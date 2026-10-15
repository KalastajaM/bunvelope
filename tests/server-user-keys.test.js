// tests/server-user-keys.test.js — live-PG CRUD for the per-user BYOK
// Anthropic keys (server/ai/user-keys.js): save → status → load round-trip
// with the master key set, shape validation, and deletion. The encryption
// primitives themselves are covered by server-ai-secrets.test.js.
//
// Env-gated like the other DB suites; creates its own scratch database.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const BASE_URL = process.env.ROUTES_TEST_DATABASE_URL
  || process.env.MIGRATION_TEST_DATABASE_URL;
const describeIf = BASE_URL ? describe : describe.skip;

const KEYS_DB = 'bunvelope_keys_test';
const TEST_KEY = 'sk-ant-test-0123456789abcdef';

function withDbName(url, dbName) {
  const u = new URL(url);
  u.pathname = `/${dbName}`;
  return u.toString();
}

describeIf('user-keys BYOK storage (live Postgres)', () => {
  let pool;
  let userKeys;
  let userId;

  beforeAll(async () => {
    const pgMod = await import('pg');
    const { Client } = pgMod.default;
    const admin = new Client({ connectionString: BASE_URL });
    await admin.connect();
    await admin.query(`drop database if exists ${KEYS_DB} with (force)`);
    await admin.query(`create database ${KEYS_DB}`);
    await admin.end();

    process.env.DATABASE_URL = withDbName(BASE_URL, KEYS_DB);
    process.env.PGSSL = 'disable';
    // 32-byte master key so keys are stored encrypted (AES-256-GCM path).
    process.env.BUNVELOPE_SECRETS_KEY = Buffer.alloc(32, 7).toString('base64');

    const db = await import('../server/db.js');
    pool = db.pool;
    await db.runMigrations({ log: () => {} });

    const { rows } = await db.query(
      `insert into users (email, google_sub, name)
       values ('keys@example.com', 'sub-keys', 'Keys') returning id`,
    );
    userId = rows[0].id;

    userKeys = await import('../server/ai/user-keys.js');
  }, 60_000);

  afterAll(async () => {
    if (pool) await pool.end();
  });

  it('reports no key for a fresh user', async () => {
    expect(await userKeys.loadUserApiKey(userId)).toBe(null);
    expect(await userKeys.getUserApiKeyStatus(userId)).toEqual({
      hasKey: false, alg: null, preview: null, setAt: null,
    });
  });

  it('rejects malformed keys before touching the database', async () => {
    await expect(userKeys.saveUserApiKey(userId, 'not-a-key')).rejects.toMatchObject({ status: 400 });
    await expect(userKeys.saveUserApiKey(userId, 'sk-ant-x')).rejects.toMatchObject({ status: 400 });
    expect(await userKeys.loadUserApiKey(userId)).toBe(null);
  });

  it('saves encrypted, exposes only a preview, and round-trips on load', async () => {
    const status = await userKeys.saveUserApiKey(userId, `  ${TEST_KEY}  `); // trims
    expect(status.hasKey).toBe(true);
    expect(status.alg).toBe('aes-256-gcm');
    expect(status.preview).not.toContain(TEST_KEY); // never the full key
    expect(TEST_KEY.endsWith(status.preview.slice(-4))).toBe(true);
    expect(status.setAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    // The ciphertext at rest must not contain the plaintext.
    const db = await import('../server/db.js');
    const { rows } = await db.query(
      'select ai_api_key_ct from users where id = $1', [userId],
    );
    expect(rows[0].ai_api_key_ct.toString('utf8')).not.toContain(TEST_KEY);

    expect(await userKeys.loadUserApiKey(userId)).toBe(TEST_KEY);
  });

  it('deletes the key completely', async () => {
    await userKeys.deleteUserApiKey(userId);
    expect(await userKeys.loadUserApiKey(userId)).toBe(null);
    expect((await userKeys.getUserApiKeyStatus(userId)).hasKey).toBe(false);
  });
});
