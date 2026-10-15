#!/usr/bin/env node
// scripts/restore.mjs — `npm run restore -- --file <backup.json>`: restore
// one `npm run backup` file as a new budget for its owner (default) or over
// an existing budget (--into <budget-id>). A dry run unless --yes. Prints
// one JSON document on stdout; exits 1 on any refusal or error. Never prints
// blob contents. See docs/backups.md.

import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import process from 'node:process';
import { createPool, bindDb } from '../server/db.js';
import { createBudgetStore, BudgetStoreError } from '../server/services/budget-store.js';
import { budgetCapFromEnv } from '../server/routes/budgets.js';
import { sslWarning } from '../bin/cli-support.mjs';
import {
  parseRestoreArgs, readBackupDoc, runRestore, resolveBackupFile, restoreErrorOutput,
} from './restore-lib.mjs';

let pool = null;

async function main() {
  const args = parseRestoreArgs(process.argv.slice(2));
  // npm runs scripts from the repo root; INIT_CWD is where it was invoked.
  const file = resolveBackupFile(args.file, { cwd: process.env.INIT_CWD || process.cwd() });
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    throw new BudgetStoreError('bad_arguments', `cannot read --file ${file}`);
  }
  const doc = readBackupDoc(text);

  const warning = sslWarning(process.env);
  if (warning) process.stderr.write(`${warning}\n`);
  pool = createPool();
  const db = bindDb(pool);
  const store = createBudgetStore(db);

  async function getUserByEmail(email) {
    const { rows } = await db.query(
      'select id from users where lower(email) = $1', [String(email).trim().toLowerCase()],
    );
    return rows[0] ?? null;
  }

  // The key-id rule of lockEncryptionConfig in budget-store.js.
  async function getEncryption(userId) {
    const { rows } = await db.query(
      `select encryption_enabled, encryption_salt, encryption_verifier
         from users where id = $1`,
      [userId],
    );
    const u = rows[0];
    if (!u) return null;
    return {
      enabled: Boolean(u.encryption_enabled),
      keyId: u.encryption_verifier?.keyId || u.encryption_salt?.toString('base64') || null,
    };
  }

  return runRestore({
    store,
    getUserByEmail,
    getEncryption,
    doc,
    into: args.into,
    allowOtherOwner: args.allowOtherOwner,
    owner: args.owner,
    name: args.name,
    yes: args.yes,
    now: new Date(),
    maxPerUser: budgetCapFromEnv(process.env),
  });
}

try {
  const summary = await main();
  process.stdout.write(`${JSON.stringify(summary)}\n`);
} catch (error) {
  process.stdout.write(`${JSON.stringify(restoreErrorOutput(error))}\n`);
  process.exitCode = 1;
} finally {
  if (pool) await pool.end().catch(() => {});
}
