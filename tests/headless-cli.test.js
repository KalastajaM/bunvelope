import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const BASE_URL = process.env.ROUTES_TEST_DATABASE_URL
  || process.env.MIGRATION_TEST_DATABASE_URL;
const ADMIN_URL = process.env.BUDGET_TEST_ADMIN_URL || BASE_URL;
const describeIf = BASE_URL ? describe : describe.skip;
const DB_NAME = 'bunvelope_headless_cli_test';

function withDbName(url, name) {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
}

describeIf('headless CLI (live Postgres)', () => {
  let db;
  let pool;
  let budgetId;
  let databaseUrl;
  let work;
  let otherBudgetId;
  let cliUserId;

  function cli(args, env = {}) {
    return spawnSync(process.execPath, ['bin/bunvelope.mjs', ...args], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: { ...process.env, DATABASE_URL: databaseUrl, PGSSL: 'disable', ...env },
    });
  }

  beforeAll(async () => {
    const pgMod = await import('pg');
    const { Client } = pgMod.default;
    const admin = new Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query(`drop database if exists ${DB_NAME} with (force)`);
    const owner = new URL(BASE_URL).username;
    if (!/^[a-z_][a-z0-9_]*$/i.test(owner)) throw new Error('unsafe test database owner');
    await admin.query(`create database ${DB_NAME} owner ${owner}`);
    await admin.end();

    databaseUrl = withDbName(BASE_URL, DB_NAME);
    process.env.DATABASE_URL = databaseUrl;
    process.env.PGSSL = 'disable';
    db = await import('../server/db.js');
    pool = db.pool;
    await db.runMigrations({ log: () => {} });
    const userId = (await db.query(
      `insert into users (email, google_sub, name)
       values ('cli@example.com', 'cli-sub', 'CLI') returning id`,
    )).rows[0].id;
    budgetId = (await db.query(
      `insert into budgets (user_id, name, version)
       values ($1, 'CLI Family', 8) returning id`, [userId],
    )).rows[0].id;
    const otherId = (await db.query(
      `insert into users (email, google_sub, name)
       values ('other@example.com', 'other-sub', 'Other') returning id`,
    )).rows[0].id;
    otherBudgetId = (await db.query(
      `insert into budgets (user_id, name) values ($1, 'Other household') returning id`, [otherId],
    )).rows[0].id;
    cliUserId = userId;
    const blobs = {
      envelopes: [], budget_items: [], transactions: [],
      accounts: [{ id: 'bank', name: 'Bank', type: 'bank' }],
      envelope_templates: [], meta: { schemaVersion: 8, currency: 'EUR' },
    };
    for (const [kind, data] of Object.entries(blobs)) {
      await db.query(
        'insert into budget_blobs (budget_id, kind, data) values ($1, $2, $3::jsonb)',
        [budgetId, kind, JSON.stringify(data)],
      );
    }
    work = mkdtempSync(join(tmpdir(), 'bunvelope-cli-test-'));
  }, 60_000);

  afterAll(async () => {
    if (pool) await pool.end();
    if (work) rmSync(work, { recursive: true, force: true });
  });

  it('reads a complete versioned bundle as one JSON document', () => {
    const result = cli(['budget', 'read', '--id', budgetId]);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toMatchObject({
      protocol_version: 1,
      budget: {
        id: budgetId, name: 'CLI Family', version: 8,
        schema_version: 7, encrypted: false,
      },
      bundle: {
        envelopes: [], budgetItems: [], transactions: [],
        accounts: [{ id: 'bank', name: 'Bank', type: 'bank' }],
        envelopeTemplates: [], meta: { schemaVersion: 8, currency: 'EUR' },
      },
    });
  });

  it('applies a validated file atomically and reports the new version', () => {
    const input = join(work, 'apply.json');
    writeFileSync(input, JSON.stringify({
      protocol_version: 1,
      expected_version: 8,
      items: [{
        kind: 'accounts',
        data: [{ id: 'bank', name: 'Main bank', type: 'bank' }],
      }],
    }));
    chmodSync(input, 0o600);
    const result = cli([
      'budget', 'apply', '--id', budgetId,
      '--expected-version', '8', '--input', input,
    ]);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual({
      protocol_version: 1, version: 9, changed_kinds: ['accounts'],
    });
    const reread = cli(['budget', 'read', '--id', budgetId]);
    expect(JSON.parse(reread.stdout).bundle.accounts[0].name).toBe('Main bank');
  });

  it('reports stale versions with a stable JSON error and no secret', () => {
    const input = join(work, 'stale.json');
    writeFileSync(input, JSON.stringify({
      protocol_version: 1,
      expected_version: 8,
      items: [{ kind: 'accounts', data: [] }],
    }));
    chmodSync(input, 0o600);
    const result = cli([
      'budget', 'apply', '--id', budgetId,
      '--expected-version', '8', '--input', input,
    ]);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(JSON.parse(result.stderr)).toMatchObject({
      protocol_version: 1,
      error: { code: 'version_conflict', current: 9 },
    });
    // Only meaningful when the URL carries a password: with local trust auth
    // there is none, and every string contains ''.
    const password = new URL(databaseUrl).password;
    if (password) expect(result.stderr).not.toContain(password);
  });

  it('rejects malformed arguments through the JSON error contract', () => {
    const result = cli(['budget', 'read']);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(JSON.parse(result.stderr)).toMatchObject({
      protocol_version: 1, error: { code: 'bad_arguments' },
    });
  });

  it('lists every budget with its owner email, or one owner with --user', () => {
    const all = JSON.parse(cli(['budgets', 'list']).stdout).budgets;
    expect(all.map((b) => [b.id, b.owner_email]).sort()).toEqual([
      [budgetId, 'cli@example.com'], [otherBudgetId, 'other@example.com'],
    ].sort());

    const byEmail = cli(['budgets', 'list', '--user', 'CLI@example.com']);
    expect(byEmail.status).toBe(0);
    expect(JSON.parse(byEmail.stdout).budgets.map((b) => b.id)).toEqual([budgetId]);

    const byId = JSON.parse(cli(['budgets', 'list', '--user', cliUserId]).stdout);
    expect(byId.budgets.map((b) => b.id)).toEqual([budgetId]);

    const nobody = cli(['budgets', 'list', '--user', 'nobody@example.com']);
    expect(nobody.status).not.toBe(0);
    expect(JSON.parse(nobody.stderr).error.code).toBe('not_found');
  });

  it('scopes read to --user when given', () => {
    const denied = cli(['budget', 'read', '--id', otherBudgetId, '--user', 'cli@example.com']);
    expect(denied.status).not.toBe(0);
    expect(JSON.parse(denied.stderr).error.code).toBe('not_found');
  });

  it('refuses an apply that points a transaction at a missing account', () => {
    const current = JSON.parse(cli(['budget', 'read', '--id', budgetId]).stdout).budget.version;
    const input = join(work, 'dangling.json');
    writeFileSync(input, JSON.stringify({
      protocol_version: 1,
      expected_version: current,
      items: [{ kind: 'transactions', data: [
        { id: 'x1', type: 'expense', amount: 5, date: '2026-01-02', account: 'nope' },
      ] }],
    }));
    chmodSync(input, 0o600);
    const result = cli(['budget', 'apply', '--id', budgetId,
      '--expected-version', String(current), '--input', input]);
    expect(result.status).not.toBe(0);
    expect(JSON.parse(result.stderr).error).toMatchObject({ code: 'validation_failed' });
    expect(JSON.parse(result.stderr).error.message).toMatch(/nope/);
  });

  it('reports a malformed id as not found rather than an internal error', () => {
    const result = cli(['budget', 'probe', '--id', 'not-a-uuid']);
    expect(JSON.parse(result.stderr).error.code).toBe('not_found');
  });

  it('warns on stderr when certificate verification is turned off', () => {
    const result = cli(['budgets', 'list'], { PGSSL: 'no-verify' });
    expect(result.stderr).toContain('PGSSL=no-verify');
  });
});
