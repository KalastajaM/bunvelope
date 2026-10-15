// Real operator commands, filesystem and Postgres; generated data only.
// Each run owns a uniquely named scratch database and drops only that database.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { createPool, bindDb, runMigrations } from '../server/db.js';
import { createBudgetStore } from '../server/services/budget-store.js';
import { initialHistory } from '../js/core/financial-history.js';
import { deriveKey, encryptJson, decryptJson, buildVerifier } from '../js/storage/crypto.js';

const base = process.env.MIGRATION_TEST_DATABASE_URL;
const run = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));
const name = `bv_restore_${randomUUID().replaceAll('-', '')}`;
const bundle = () => ({
  accounts: [{ id: 'bank', name: 'Bank', type: 'bank', initialBalance: 1000 }],
  envelopes: [{ id: 'food', name: 'Food', category: 'living' }],
  transactions: [{ id: 'tx1', type: 'expense', date: '2026-10-01', amount: 25,
    account: 'bank', envelope_id: 'food', status: 'posted', payee: 'Synthetic restore fixture' }],
  budgetItems: [], envelopeTemplates: [], meta: { schemaVersion: 8, currency: 'EUR' },
});

describe.skipIf(!base)('backup and restore commands (live Postgres)', () => {
  let admin; let pool; let store; let directory; let env; let key;
  let plain; let encrypted; let plainId; let encryptedId; let files;
  let created = false;

  async function command(script, args = [], succeeds = true) {
    let result;
    try {
      result = await run(process.execPath, [script, ...args], { cwd: root, env, timeout: 20000 });
    } catch (error) {
      if (succeeds) throw error;
      expect(error.code).toBe(1);
      return JSON.parse(error.stdout);
    }
    expect(succeeds).toBe(true);
    return JSON.parse(result.stdout);
  }
  const count = async () => Number((await pool.query('select count(*) as n from budgets')).rows[0].n);

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: base });
    await admin.connect();
    await admin.query(`create database ${name}`);
    created = true;
    const url = new URL(base); url.pathname = `/${name}`;
    directory = await mkdtemp(path.join(tmpdir(), 'bv-restore-drill-'));
    env = { ...process.env, DATABASE_URL: url.href, PGSSL: 'disable', BACKUP_DIR: directory };
    pool = createPool({ env });
    await runMigrations({ log() {}, info() {}, warn() {} }, { pool });
    store = createBudgetStore(bindDb(pool));
    const users = [];
    for (const email of ['plain@example.test', 'encrypted@example.test']) {
      users.push((await pool.query('insert into users (email, google_sub, name) values ($1, $1, $1) returning id', [email])).rows[0].id);
    }
    plain = bundle();
    plain.meta.financialHistory = initialHistory(plain, new Date('2026-10-08T12:00:00Z'));
    plainId = (await store.createBudget({ userId: users[0], name: 'Plain fixture', maxPerUser: 50,
      items: Object.entries(plain).map(([kind, data]) => ({ kind, data })) })).id;
    const salt = Buffer.alloc(16, 7);
    key = await deriveKey('disposable test passphrase', salt);
    const verifier = await buildVerifier(key);
    await pool.query('update users set encryption_enabled = true, encryption_salt = $1, encryption_verifier = $2 where id = $3', [salt, verifier, users[1]]);
    encrypted = Object.fromEntries(await Promise.all(Object.entries(plain).map(async ([kind, data]) =>
      [kind, { ...await encryptJson(key, data), kid: salt.toString('base64') }])));
    encryptedId = (await store.createBudget({ userId: users[1], name: 'Encrypted fixture', maxPerUser: 50,
      items: Object.entries(encrypted).map(([kind, data]) => ({ kind, data })) })).id;
    const beforeBackup = await pool.query('select id, version, last_opened_at from budgets order by id');
    const backup = await command('scripts/backup.mjs');
    expect(backup.ok).toBe(true);
    expect(backup.budgets).toHaveLength(2);
    files = Object.fromEntries(backup.budgets.map(b => [b.id, b.file]));
    expect((await pool.query('select id, version, last_opened_at from budgets order by id')).rows).toEqual(beforeBackup.rows);
  }, 60000);

  afterAll(async () => {
    if (pool) await pool.end();
    if (created) await admin.query(`drop database ${name}`);
    if (admin) await admin.end();
    if (directory) await rm(directory, { recursive: true });
  });

  it('dry-runs without writing, then restores all plaintext collections and history into a new budget', async () => {
    const before = await count();
    const preview = await command('scripts/restore.mjs', ['--file', files[plainId]]);
    expect(preview).toMatchObject({ ok: true, dry_run: true });
    expect(await count()).toBe(before);
    const restored = await command('scripts/restore.mjs', ['--file', files[plainId], '--yes']);
    expect(restored).toMatchObject({ ok: true, dry_run: false, mode: 'new' });
    expect((await store.readBudget({ budgetId: restored.target.id })).bundle).toEqual(plain);
    expect((await store.readBudget({ budgetId: plainId })).bundle).toEqual(plain);
  });

  it('preserves ciphertext and encryption metadata, and decrypts the restored budget correctly', async () => {
    const text = await readFile(files[encryptedId], 'utf8');
    expect(text).not.toContain('Synthetic restore fixture');
    const doc = JSON.parse(text);
    expect(doc._backup.encryption).toMatchObject({ enabled: true, salt: Buffer.alloc(16, 7).toString('base64') });
    const restored = await command('scripts/restore.mjs', ['--file', files[encryptedId], '--yes']);
    const result = (await store.readBudget({ budgetId: restored.target.id })).bundle;
    expect(result).toEqual(encrypted);
    for (const [kind, value] of Object.entries(result)) expect(await decryptJson(key, value)).toEqual(plain[kind]);
  });

  it('refuses cross-owner overwrites, incompatible encryption, and corrupted JSON without creating budgets', async () => {
    const before = await count();
    const other = await command('scripts/restore.mjs', ['--file', files[plainId], '--into', encryptedId, '--yes'], false);
    expect(other.error.code).toBe('owner_mismatch');
    const incompatible = await command('scripts/restore.mjs', ['--file', files[encryptedId], '--owner', 'plain@example.test', '--yes'], false);
    expect(incompatible.error.code).toBe('encryption_key_mismatch');
    const broken = path.join(directory, 'broken.json');
    await writeFile(broken, '{truncated');
    const invalid = await command('scripts/restore.mjs', ['--file', broken, '--yes'], false);
    expect(invalid.error.code).toBe('not_a_backup');
    expect(await count()).toBe(before);
    expect((await store.readBudget({ budgetId: encryptedId })).bundle).toEqual(encrypted);
  });
});
