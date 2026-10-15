#!/usr/bin/env node
// scripts/backup.mjs — `npm run backup`: write every budget in DATABASE_URL
// to a timestamped JSON file under BACKUP_DIR (default ~/Bunvelope-backups),
// keeping the newest BACKUP_KEEP (default 30) per budget. Read-only against
// the database. Prints a JSON summary on stdout; exits 1 if any budget
// failed. See docs/backups.md for scheduling and restore.

import 'dotenv/config';
import process from 'node:process';
import { createPool, bindDb } from '../server/db.js';
import { createBudgetStore } from '../server/services/budget-store.js';
import { publicError, sslWarning } from '../bin/cli-support.mjs';
import { runBackup, resolveBackupDir, resolveKeep } from './backup-lib.mjs';

const warning = sslWarning(process.env);
if (warning) process.stderr.write(`${warning}\n`);

const pool = createPool();
const db = bindDb(pool);
const store = createBudgetStore(db);

async function getEncryption(userId) {
  if (!userId) return null;
  const { rows } = await db.query(
    `select encryption_enabled, encryption_salt, encryption_verifier
       from users where id = $1`,
    [userId],
  );
  const u = rows[0];
  if (!u) return null;
  return {
    enabled: Boolean(u.encryption_enabled),
    salt: u.encryption_salt ? u.encryption_salt.toString('base64') : null,
    verifier: u.encryption_verifier ?? null,
  };
}

try {
  const summary = await runBackup({
    store,
    getEncryption,
    dir: resolveBackupDir(process.env.BACKUP_DIR),
    keep: resolveKeep(process.env.BACKUP_KEEP),
    now: new Date(),
  });
  process.stdout.write(`${JSON.stringify(summary)}\n`);
  if (!summary.ok) process.exitCode = 1;
} catch (error) {
  process.stderr.write(`${JSON.stringify({ ok: false, ...publicError(error) })}\n`);
  process.exitCode = 1;
} finally {
  await pool.end().catch(() => {});
}
