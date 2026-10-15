// playwright.config.js — e2e suite for the three storage modes.
//
// Two projects, one per server:
//   cloud   e2e/golden-path + encryption specs against `node server/index.js`.
//           Requires a Postgres the suite can create a scratch database on:
//             E2E_DATABASE_URL (or MIGRATION_TEST_DATABASE_URL) = postgres://…
//           Without it those specs skip. CI reuses the existing postgres
//           service env.
//   static  e2e/guest-mode + e2e/fsapi-mode specs against a plain static file
//           server (e2e/static-server.js), the way the README runs static
//           mode. No database needed.
//
// Run locally:  npx playwright install chromium && npm run test:e2e
//               npx playwright test --project=static   (no database needed)
//
// Hunting a flaky cloud spec: E2E_API_DELAY_MS=250 npx playwright test
// --project=cloud holds every browser-side /api call for that long, which
// makes a wait that only checks the UI (not the save or reload it depends on)
// fail every time instead of once a month. Loop full runs rather than using
// --repeat-each: the server's per-user rate limit (120 requests a minute)
// trips when the two specs run back to back many times over. To run two
// checkouts side by side, give each its own E2E_PORT, E2E_STATIC_PORT and
// E2E_DB_NAME.
//
// Sandboxed environments that cannot reach Playwright's browser CDN can
// point at any Chromium binary instead (e.g. the one shipped inside the
// @sparticuz/chromium npm package):
//   npm i -D @sparticuz/chromium
//   E2E_CHROMIUM_PATH=$(node -e "require('@sparticuz/chromium').executablePath().then(p=>console.log(p))") \
//   E2E_CHROMIUM_ARGS="$(node -e "console.log(require('@sparticuz/chromium').args.join(' '))")" \
//   npm run test:e2e

import { defineConfig } from '@playwright/test';
import { E2E_PASSWORD, E2E_DB_NAME, dbBaseUrl, withDbName } from './e2e/env.js';

const PORT = Number(process.env.E2E_PORT || 4173);
const STATIC_PORT = Number(process.env.E2E_STATIC_PORT || 4174);
const STATIC_SPECS = /((guest|fsapi)-mode|import-rules|forecast-readiness|check-balance)\.spec\.js$/;
const DB_BASE = dbBaseUrl();

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  // Each spec boots the whole client bundle from static files; on a busy
  // machine the default 5s is too tight for the first paint after a reload.
  expect: { timeout: 10_000 },
  // The golden path is one serial journey against one server + database.
  workers: 1,
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  reporter: 'list',
  use: {
    launchOptions: {
      executablePath: process.env.E2E_CHROMIUM_PATH || undefined,
      args: (process.env.E2E_CHROMIUM_ARGS || '').split(' ').filter(Boolean),
    },
  },
  projects: [
    {
      name: 'cloud',
      testIgnore: STATIC_SPECS,
      use: { baseURL: `http://127.0.0.1:${PORT}` },
    },
    {
      name: 'static',
      testMatch: STATIC_SPECS,
      use: { baseURL: `http://127.0.0.1:${STATIC_PORT}` },
    },
  ],
  webServer: [
    {
      command: 'node e2e/static-server.js',
      port: STATIC_PORT,
      reuseExistingServer: false,
      timeout: 60_000,
      env: { ...process.env, E2E_STATIC_PORT: String(STATIC_PORT) },
    },
    ...(DB_BASE
      ? [{
          // The wrapper recreates the scratch DB before booting the server —
          // Playwright starts the webServer before globalSetup would run.
          command: 'node e2e/start-server.js',
          port: PORT,
          reuseExistingServer: false,
          timeout: 60_000,
          env: {
            ...process.env,
            PORT: String(PORT),
            DATABASE_URL: withDbName(DB_BASE, E2E_DB_NAME),
            PGSSL: 'disable',
            SESSION_SECRET: 'e2e-session-secret-0123456789abcdef0123456789',
            BYPASS_GOOGLE: 'true',
            BYPASS_PASSWORD: E2E_PASSWORD,
            NODE_ENV: 'development',
          },
        }]
      : []),
  ],
});
