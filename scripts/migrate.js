#!/usr/bin/env node
// scripts/migrate.js — Run pending Postgres migrations as a one-shot
// process (`npm run migrate`). Use it before starting a server with
// SKIP_MIGRATIONS=1, or to bring a database up to date without booting one.

import 'dotenv/config';
import { pool, runMigrations } from '../server/db.js';

try {
  const { applied } = await runMigrations({
    info: (m, msg) => console.log(msg, m),
    log: console.log,
  });
  if (applied.length) {
    console.log(`migrate: applied ${applied.length} migration(s)`);
  } else {
    console.log('migrate: no pending migrations');
  }
  await pool.end();
  process.exit(0);
} catch (err) {
  console.error('migrate: failed', err);
  await pool.end().catch(() => {});
  process.exit(1);
}
