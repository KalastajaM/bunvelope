// server/db.js — Postgres pool + boot-time migration runner.

import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const { Pool } = pg;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

// Pool sizing — pg's defaults (max 10, no connect timeout) are kept but
// made operator-tunable: a Postgres caps total connections, and the server,
// the CLI and the backup script share that budget. The connect timeout
// surfaces pool/server saturation as an error instead of an indefinite hang.
const poolInt = (env, name, dflt) => {
  const n = Number(env[name]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : dflt;
};

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/**
 * True for a database on this machine: localhost, a loopback address, a
 * unix-socket directory, or no host at all (libpq's default is the local
 * socket). Only these get plaintext by default.
 *
 * @param {string|null|undefined} host
 * @returns {boolean}
 */
export function isLocalDbHost(host) {
  if (typeof host !== 'string' || !host) return true;
  if (host.startsWith('/')) return true;
  return LOCAL_HOSTS.has(host.toLowerCase());
}

/**
 * The host pg will connect to for this connection string, following
 * pg-connection-string's rules: a leading `/` is a socket path, a `host=`
 * query parameter overrides the URL host, `socket:` URLs carry the path, and
 * an empty host (`postgres:///db`, `postgres://u@/db`) is ''. Returns null
 * when the string cannot be parsed at all.
 *
 * @param {string|null|undefined} connectionString
 * @returns {string|null}
 */
export function dbHostOf(connectionString) {
  const s = typeof connectionString === 'string' ? connectionString.trim() : '';
  if (!s) return '';
  if (s.startsWith('/')) return s.split(' ')[0];
  let url;
  let emptyHost = false;
  try {
    url = new URL(s);
  } catch {
    try {
      url = new URL(s.replace('@/', '@___DUMMY___/'));
      emptyHost = true;
    } catch {
      return null;
    }
  }
  const hostParam = url.searchParams.get('host');
  if (hostParam) return hostParam;
  if (url.protocol === 'socket:') return decodeURI(url.pathname);
  if (emptyHost) return '';
  try {
    return decodeURIComponent(url.hostname);
  } catch {
    return null;
  }
}

/**
 * The `ssl` option for a pg Pool. One rule for the server, the CLI and the
 * backup script:
 *
 * 1. An explicit `sslmode=` in the URL wins (returns undefined: pg parses it,
 *    and URL parameters win over the config object anyway).
 * 2. PGSSL: `disable` (no TLS), `verify` (TLS, certificate checked),
 *    `no-verify` (TLS, certificate not checked; the CLI warns on stderr).
 * 3. Otherwise the host decides. A local database (isLocalDbHost; an empty
 *    URL host falls back to PGHOST) gets no TLS, since a local Postgres
 *    usually has none. Any other host gets TLS with the certificate
 *    verified, so a remote database is secure by default. An unparseable
 *    URL counts as remote: a typo may fail closed, never silently plaintext.
 *
 * @param {string|undefined} connectionString
 * @param {Record<string, string|undefined>} [env]
 * @returns {false | undefined | { rejectUnauthorized: boolean }}
 */
export function buildSslConfig(connectionString, env = process.env) {
  if (/[?&]sslmode=/i.test(connectionString || '')) return undefined;
  const setting = String(env.PGSSL || '').trim().toLowerCase();
  if (setting === 'disable') return false;
  if (setting === 'verify') return { rejectUnauthorized: true };
  if (setting === 'no-verify') return { rejectUnauthorized: false };
  let host = dbHostOf(connectionString);
  if (host === null) return { rejectUnauthorized: true };
  if (host === '') host = env.PGHOST || '';
  return isLocalDbHost(host) ? false : { rejectUnauthorized: true };
}

const CERT_ERROR_CODES = new Set([
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'CERT_UNTRUSTED',
  'CERT_SIGNATURE_FAILURE',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

/** True for a TLS certificate-verification failure from pg/Node. */
export function isCertificateError(err) {
  return CERT_ERROR_CODES.has(err?.code) || CERT_ERROR_CODES.has(err?.cause?.code);
}

/**
 * Build a pool. `server/index.js` and the tests use the module-level `pool`
 * below; the headless CLI and the backup script build their own.
 *
 * @param {{ env?: Record<string, string|undefined> }} [opts]
 */
export function createPool({ env = process.env } = {}) {
  return new Pool({
    connectionString: env.DATABASE_URL,
    max: poolInt(env, 'PGPOOL_MAX', 10),
    idleTimeoutMillis: poolInt(env, 'PGPOOL_IDLE_TIMEOUT_MS', 30_000),
    connectionTimeoutMillis: poolInt(env, 'PGPOOL_CONNECT_TIMEOUT_MS', 10_000),
    ssl: buildSslConfig(env.DATABASE_URL, env),
  });
}

/** `query` and `withTx` bound to a pool, in the shape createBudgetStore takes. */
export function bindDb(p) {
  return {
    query: (text, params) => p.query(text, params),
    async withTx(fn) {
      const client = await p.connect();
      try {
        await client.query('begin');
        const out = await fn(client);
        await client.query('commit');
        return out;
      } catch (err) {
        await client.query('rollback');
        throw err;
      } finally {
        client.release();
      }
    },
  };
}

export const pool = createPool();
const bound = bindDb(pool);

export async function query(text, params) {
  return bound.query(text, params);
}

export async function withTx(fn) {
  return bound.withTx(fn);
}

// Project-wide advisory lock id. Serializes concurrent runMigrations()
// callers (e.g. two containers starting during a rolling deploy). The
// constant is arbitrary but must be stable; changing it invalidates
// existing locks held by running processes.
const MIGRATION_LOCK_ID = 0x42756E76; // 'Bunv'

// Every helper below takes the queryable it runs on (the pool, or one
// checked-out client) so that the locked section of runMigrations keeps all
// of its work on the session that holds the advisory lock.

async function ensureMigrationsTable(db) {
  await db.query(`
    create table if not exists schema_migrations (
      filename text primary key,
      applied_at timestamptz not null default now()
    )
  `);
}

async function migrationFilesOnDisk() {
  return (await fs.readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
}

async function listPending(db) {
  const files = await migrationFilesOnDisk();
  const applied = await db.query('select filename from schema_migrations');
  const appliedSet = new Set(applied.rows.map((r) => r.filename));
  return files.filter((f) => !appliedSet.has(f));
}

// Fast pre-check used at boot: if there's nothing to apply, return
// without acquiring the advisory lock. Rolling deploys hit this path
// the moment the first replica finishes; subsequent replicas don't
// block on each other.
export async function pendingMigrations({ pool: p = pool } = {}) {
  await ensureMigrationsTable(p);
  return listPending(p);
}

/**
 * Apply pending migrations under a project-wide advisory lock.
 *
 * pg_advisory_lock is held by the SESSION that took it. The lock and the
 * unlock used to be two separate pool.query calls, which a pool may serve
 * from two different connections: the unlock then runs on a session that
 * holds nothing, and the real lock stays with an idle pooled connection
 * until it is recycled, blocking the next replica's migration run. One
 * checked-out client now takes the lock, runs every locked step, releases
 * the lock, and is itself released in `finally`.
 *
 * @param {object} [logger]
 * @param {{ pool?: { query: Function, connect: Function } }} [opts]  tests inject a pool
 */
export async function runMigrations(logger = console, { pool: p = pool } = {}) {
  await ensureMigrationsTable(p);
  // Fast path: nothing to do, skip the lock entirely. Still verify
  // fingerprints — that's our defence-in-depth check past CI's git diff,
  // and it's cheap (file SHA + one indexed lookup per applied migration).
  const initialPending = await listPending(p);
  if (!initialPending.length) {
    await verifyMigrationFingerprints(logger, { db: p });
    return { applied: [] };
  }

  const client = await p.connect();
  try {
    await client.query('select pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);
    try {
      return await applyPendingLocked(client, logger);
    } finally {
      await client.query('select pg_advisory_unlock($1)', [MIGRATION_LOCK_ID])
        .catch(() => {});
    }
  } finally {
    client.release();
  }
}

async function applyPendingLocked(client, logger) {
  // Re-check under the lock — another replica may have applied them
  // while we were waiting.
  const pending = await listPending(client);
  if (!pending.length) {
    await verifyMigrationFingerprints(logger, { db: client });
    return { applied: [] };
  }

  // Snapshot existing budget_blobs before applying any new migration so
  // a bad migration can be recovered from budget_blob_backups. Skipped
  // on the very first deploy (table doesn't exist yet).
  await snapshotBlobsIfPossible(client, logger);

  const applied = [];
  for (const f of pending) {
    const sql = await fs.readFile(path.join(MIGRATIONS_DIR, f), 'utf8');
    const sha = sha256(sql);
    logger.info?.({ migration: f }, 'applying migration') ??
      logger.log?.(`applying migration ${f}`);
    await client.query('begin');
    try {
      await client.query(sql);
      // Insert with SHA when the column exists (post-0006 boot), else
      // fall back to filename-only for the bootstrap path. We must
      // check the column up front: catching 42703 from a failed insert
      // doesn't work because Postgres aborts the whole transaction on
      // the first error, so any fallback query in the same tx fails
      // with 25P02 (current_transaction_is_aborted).
      const cols = await client.query(`
        select 1 from information_schema.columns
         where table_name = 'schema_migrations'
           and column_name = 'content_sha256'
      `);
      if (cols.rows.length) {
        await client.query(
          'insert into schema_migrations(filename, content_sha256) values ($1, $2)',
          [f, sha],
        );
      } else {
        await client.query(
          'insert into schema_migrations(filename) values ($1)',
          [f],
        );
      }
      await client.query('commit');
    } catch (err) {
      await client.query('rollback').catch(() => {});
      throw err;
    }
    applied.push(f);
  }
  // Backfill SHAs for rows applied before the column existed, then
  // verify the full set against disk. Both run under the lock so
  // concurrent replicas don't race.
  await backfillFingerprints(client, logger);
  await verifyMigrationFingerprints(logger, { db: client });
  return { applied };
}

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

// Walk schema_migrations, compute SHA for each filename on disk, fill in
// any null content_sha256 rows. One-time after migration 0006 lands.
async function backfillFingerprints(db, logger) {
  const cols = await db.query(`
    select 1 from information_schema.columns
     where table_name = 'schema_migrations'
       and column_name = 'content_sha256'
  `);
  if (!cols.rows.length) return; // 0006 hasn't applied yet
  const { rows } = await db.query(
    'select filename from schema_migrations where content_sha256 is null',
  );
  if (!rows.length) return;
  for (const row of rows) {
    try {
      const sql = await fs.readFile(path.join(MIGRATIONS_DIR, row.filename), 'utf8');
      await db.query(
        'update schema_migrations set content_sha256 = $1 where filename = $2',
        [sha256(sql), row.filename],
      );
    } catch (err) {
      // Missing file is itself a problem worth flagging, but leave the
      // SHA null so verifyMigrationFingerprints surfaces it next boot.
      logger.warn?.({ migration: row.filename, err: err.message },
        'migration file missing during fingerprint backfill') ??
        logger.log?.(`migration file missing: ${row.filename}`);
    }
  }
}

// Cross-check stored SHAs against the on-disk files. Loud warning on
// mismatch or missing file — never throws (we don't want to brick boot
// over a verification check). Returns an array of `{ filename, problem }`
// for tests/CLI to inspect.
export async function verifyMigrationFingerprints(logger = console, { db = pool } = {}) {
  const cols = await db.query(`
    select 1 from information_schema.columns
     where table_name = 'schema_migrations'
       and column_name = 'content_sha256'
  `);
  if (!cols.rows.length) return [];
  const { rows } = await db.query(
    'select filename, content_sha256 from schema_migrations order by filename',
  );
  const problems = [];
  for (const row of rows) {
    if (!row.content_sha256) continue; // backfill is best-effort
    let sql;
    try {
      sql = await fs.readFile(path.join(MIGRATIONS_DIR, row.filename), 'utf8');
    } catch {
      problems.push({ filename: row.filename, problem: 'missing_on_disk' });
      continue;
    }
    if (sha256(sql) !== row.content_sha256) {
      problems.push({ filename: row.filename, problem: 'sha_mismatch' });
    }
  }
  if (problems.length) {
    logger.warn?.({ problems }, 'migration fingerprint mismatch') ??
      logger.log?.(
        `migration fingerprint mismatch: ${problems
          .map((p) => `${p.filename} (${p.problem})`)
          .join(', ')}`,
      );
  }
  return problems;
}

async function snapshotBlobsIfPossible(db, logger) {
  const { rows } = await db.query(`
    select 1 from information_schema.tables
     where table_schema = 'public'
       and table_name in ('budget_blobs', 'budget_blob_backups')
  `);
  if (rows.length < 2) return; // one or both tables missing — nothing to snapshot
  const { rowCount } = await db.query(`
    insert into budget_blob_backups (budget_id, kind, data, version)
    select bb.budget_id, bb.kind, bb.data, coalesce(b.version, 0)
      from budget_blobs bb
      left join budgets b on b.id = bb.budget_id
  `);
  if (rowCount > 0) {
    logger.log?.(`snapshot: ${rowCount} blob row(s) backed up before pending migrations`);
  }
}

/**
 * Health probe that also reports migrations on disk but not applied.
 *
 * `select 1` alone called a replica healthy while it served code written for
 * a schema the database does not have yet (SKIP_MIGRATIONS=1 with a failed
 * pre-deploy step, or a migration that threw after boot logging moved on).
 * The pending list is cached: once everything is applied it stays applied
 * for the life of the process (the files on disk do not change under a
 * running server), and while something is pending it is re-read at most
 * once per `ttlMs`, so a probe every few seconds costs one `select 1`.
 *
 * @param {{ pool?: { query: Function }, ttlMs?: number, now?: () => number,
 *           listFiles?: () => Promise<string[]> }} [opts]
 * @returns {() => Promise<{ db: boolean, pendingMigrations: string[] }>}
 */
export function createHealthcheck({
  pool: p = pool, ttlMs = 30_000, now = () => Date.now(), listFiles = migrationFilesOnDisk,
} = {}) {
  let pending = null;
  let checkedAt = -Infinity;
  return async function check() {
    const { rows } = await p.query('select 1 as ok');
    const db = rows[0]?.ok === 1;
    const stale = pending === null || (pending.length > 0 && now() - checkedAt >= ttlMs);
    if (stale) {
      const files = await listFiles();
      let applied;
      try {
        applied = new Set((await p.query('select filename from schema_migrations')).rows
          .map((r) => r.filename));
      } catch {
        applied = new Set(); // no schema_migrations table yet: everything is pending
      }
      pending = files.filter((f) => !applied.has(f));
      checkedAt = now();
    }
    return { db, pendingMigrations: [...pending] };
  };
}
