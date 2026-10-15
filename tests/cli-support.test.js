import { describe, it, expect } from 'vitest';
import { publicError, sslWarning, validateReadable } from '../bin/cli-support.mjs';
import { BudgetStoreError } from '../server/services/budget-store.js';
import { CURRENT_SCHEMA_VERSION } from '../js/storage/validators.js';
import * as fsapi from '../js/storage/fsapi-adapter.js';
import * as api from '../js/storage/api-adapter.js';
import * as guest from '../js/storage/guest-adapter.js';

describe('headless CLI support', () => {
  it('names the opt-out when the database certificate fails verification', () => {
    const out = publicError(Object.assign(new Error('self-signed certificate in certificate chain'), {
      code: 'SELF_SIGNED_CERT_IN_CHAIN',
    }));
    expect(out.error.code).toBe('tls_verification_failed');
    expect(out.error.message).toContain('PGSSL=no-verify');
    expect(out.error.message).toContain('SELF_SIGNED_CERT_IN_CHAIN');
  });

  it('keeps the existing error contract for store and connection errors', () => {
    expect(publicError(new BudgetStoreError('version_conflict', 'version conflict', { current: 3 })))
      .toEqual({ protocol_version: 1, error: { code: 'version_conflict', message: 'version conflict', current: 3 } });
    expect(publicError({ code: 'ECONNREFUSED' }).error.code).toBe('connection_failed');
    expect(publicError(new Error('postgres://u:secret@host/db')).error)
      .toEqual({ code: 'internal_error', message: 'internal error' });
  });

  it('warns only when verification is explicitly turned off', () => {
    expect(sslWarning({ PGSSL: 'no-verify' })).toMatch(/not verified/);
    expect(sslWarning({})).toBeNull();
    expect(sslWarning({ PGSSL: 'disable' })).toBeNull();
  });

  it('reads the schema this build writes, and refuses any other', () => {
    const at = (schemaVersion) => ({ bundle: { meta: { schemaVersion }, transactions: [] } });
    expect(validateReadable(at(CURRENT_SCHEMA_VERSION)))
      .toEqual({ encrypted: false, schemaVersion: CURRENT_SCHEMA_VERSION });
    for (const version of [CURRENT_SCHEMA_VERSION - 1, CURRENT_SCHEMA_VERSION + 1, undefined]) {
      expect(() => validateReadable(at(version))).toThrow(
        expect.objectContaining({ code: 'unsupported_schema' }),
      );
    }
  });

  it('refuses an encrypted budget before looking at its schema', () => {
    const bundle = { meta: { schemaVersion: CURRENT_SCHEMA_VERSION }, transactions: { __enc: 1 } };
    expect(() => validateReadable({ bundle }))
      .toThrow(expect.objectContaining({ code: 'encrypted_budget' }));
  });

  it('shares one schema version with every storage adapter', () => {
    expect([fsapi, api, guest].map((adapter) => adapter.CURRENT_SCHEMA_VERSION))
      .toEqual([CURRENT_SCHEMA_VERSION, CURRENT_SCHEMA_VERSION, CURRENT_SCHEMA_VERSION]);
  });
});
