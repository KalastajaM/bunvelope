// e2e/start-server.js — webServer entry point for Playwright. Recreates the
// scratch database, then boots the real server (which runs its own
// migrations). DB prep lives here rather than in globalSetup because
// Playwright launches the webServer before globalSetup runs.

import pg from 'pg';
import { dbBaseUrl, E2E_DB_NAME } from './env.js';

const base = dbBaseUrl();
if (!base) {
  console.error('e2e: set E2E_DATABASE_URL or MIGRATION_TEST_DATABASE_URL');
  process.exit(1);
}

const { Client } = pg;
const admin = new Client({ connectionString: base });
await admin.connect();
await admin.query(`drop database if exists ${E2E_DB_NAME} with (force)`);
await admin.query(`create database ${E2E_DB_NAME}`);
await admin.end();

await import('../server/index.js');
