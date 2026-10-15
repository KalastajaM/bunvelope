// e2e/env.js — shared constants between playwright.config.js and the specs.

// 16+ characters so the bypass login doesn't trigger the forced-rotation
// flow (BYPASS_PASSWORD_MIN_LEN).
export const E2E_PASSWORD = 'e2e-golden-path-password';

// Overridable so two checkouts can run the suite side by side (with distinct
// E2E_PORT / E2E_STATIC_PORT) without dropping each other's database.
export const E2E_DB_NAME = process.env.E2E_DB_NAME || 'bunvelope_e2e';

export function dbBaseUrl() {
  return process.env.E2E_DATABASE_URL || process.env.MIGRATION_TEST_DATABASE_URL || '';
}

export function withDbName(url, dbName) {
  const u = new URL(url);
  u.pathname = `/${dbName}`;
  return u.toString();
}
