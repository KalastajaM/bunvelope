// tests/migrations.test.js — runs all server/migrations against a live
// Postgres to prove idempotency and ordering. Skipped by default; set
// MIGRATION_TEST_DATABASE_URL to a throwaway DB to enable locally.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(__dirname, '..', 'server', 'migrations');

const DB_URL = process.env.MIGRATION_TEST_DATABASE_URL;
const describeIf = DB_URL ? describe : describe.skip;

describeIf('migrations run cleanly and are idempotent', () => {
  it('applies all migrations once, then a second pass is a no-op', async () => {
    const pgMod = await import('pg');
    const { Pool } = pgMod.default;
    const pool = new Pool({ connectionString: DB_URL });
    // Clean slate.
    await pool.query(`
      drop table if exists schema_migrations cascade;
      drop table if exists budget_blob_backups cascade;
      drop table if exists budget_blobs cascade;
      drop table if exists budgets cascade;
      drop table if exists users cascade;
      drop table if exists "session" cascade;
    `);

    // db.js builds its pool from DATABASE_URL at import time — point it at
    // the same throwaway DB before the import, like the other DB suites do.
    // Without this the suite only passed when the caller happened to export
    // DATABASE_URL too.
    process.env.DATABASE_URL = DB_URL;
    process.env.PGSSL = process.env.PGSSL || 'disable';
    const { runMigrations } = await import('../server/db.js');
    await runMigrations({ log: () => {} });

    const files = (await fs.readdir(MIGRATIONS_DIR))
      .filter((f) => f.endsWith('.sql'))
      .sort();
    const first = await pool.query('select filename from schema_migrations order by filename');
    expect(first.rows.map((r) => r.filename)).toEqual(files);

    // Second run — should apply nothing.
    await runMigrations({ log: () => {} });
    const second = await pool.query('select filename from schema_migrations order by filename');
    expect(second.rows.map((r) => r.filename)).toEqual(files);

    await pool.end();
  });
});
