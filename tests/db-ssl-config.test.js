// TLS settings for the pg pool. One rule for the server and the headless
// CLI: an explicit `sslmode=` in the URL wins, then PGSSL, then the host
// decides, a local database gets no TLS and anything else gets TLS with the
// certificate verified.

import { describe, it, expect } from 'vitest';
import { buildSslConfig, isLocalDbHost, dbHostOf, isCertificateError } from '../server/db.js';

const REMOTE = 'postgres://u:p@db.example.com:5432/bunvelope';
const LOCAL = 'postgres://u:p@localhost:5432/bunvelope';
const VERIFY = { rejectUnauthorized: true };
const NO_VERIFY = { rejectUnauthorized: false };

describe('buildSslConfig', () => {
  it('uses no TLS for a local database with nothing configured', () => {
    for (const url of [
      LOCAL,
      'postgres://u@127.0.0.1/x',
      'postgres://u@[::1]:5432/x',
      'postgres://u@LOCALHOST/x',
      'postgres:///bunvelope',
      'postgres://u@%2Fvar%2Frun%2Fpostgresql/bunvelope',
      'postgres://u@/bunvelope?host=/tmp',
      undefined,
      '',
    ]) {
      expect(buildSslConfig(url, {}), String(url)).toBe(false);
    }
  });

  it('verifies the certificate for any other host by default', () => {
    expect(buildSslConfig(REMOTE, {})).toEqual(VERIFY);
    expect(buildSslConfig('postgres://u@10.0.0.5/x', {})).toEqual(VERIFY);
    // a name that merely contains "localhost" is not local
    expect(buildSslConfig('postgres://u@localhost.example.com/x', {})).toEqual(VERIFY);
  });

  it('lets a host= query parameter override the URL host, as pg does', () => {
    expect(buildSslConfig('postgres://u@localhost/x?host=db.example.com', {})).toEqual(VERIFY);
    expect(buildSslConfig('postgres://u@db.example.com/x?host=/var/run/postgresql', {})).toBe(false);
  });

  it('falls back to PGHOST when the URL names no host', () => {
    expect(buildSslConfig(undefined, { PGHOST: 'db.example.com' })).toEqual(VERIFY);
    expect(buildSslConfig('postgres:///x', { PGHOST: 'localhost' })).toBe(false);
  });

  it('honours PGSSL for both local and remote hosts', () => {
    expect(buildSslConfig(REMOTE, { PGSSL: 'disable' })).toBe(false);
    expect(buildSslConfig(REMOTE, { PGSSL: 'no-verify' })).toEqual(NO_VERIFY);
    expect(buildSslConfig(REMOTE, { PGSSL: ' Verify ' })).toEqual(VERIFY);
    expect(buildSslConfig(LOCAL, { PGSSL: 'verify' })).toEqual(VERIFY);
    expect(buildSslConfig(LOCAL, { PGSSL: 'no-verify' })).toEqual(NO_VERIFY);
  });

  it('lets an explicit sslmode in the URL win over PGSSL and the host rule', () => {
    expect(buildSslConfig(`${REMOTE}?sslmode=verify-full`, {})).toBeUndefined();
    expect(buildSslConfig(`${REMOTE}?sslmode=require`, { PGSSL: 'disable' })).toBeUndefined();
    expect(buildSslConfig(`${LOCAL}?sslmode=require`, {})).toBeUndefined();
  });

  it('fails safe to verified TLS for an unparseable URL rather than to plaintext', () => {
    expect(buildSslConfig('not a url', {})).toEqual(VERIFY);
  });

  it('ignores an unknown PGSSL value and applies the host rule', () => {
    expect(buildSslConfig(REMOTE, { PGSSL: 'maybe' })).toEqual(VERIFY);
    expect(buildSslConfig(LOCAL, { PGSSL: '' })).toBe(false);
  });
});

describe('helpers', () => {
  it('classifies hosts', () => {
    expect(isLocalDbHost('localhost')).toBe(true);
    expect(isLocalDbHost('127.0.0.1')).toBe(true);
    expect(isLocalDbHost('::1')).toBe(true);
    expect(isLocalDbHost('/var/run/postgresql')).toBe(true);
    expect(isLocalDbHost('')).toBe(true);
    expect(isLocalDbHost(null)).toBe(true);
    expect(isLocalDbHost('db.internal')).toBe(false);
    expect(isLocalDbHost('db.example.com')).toBe(false);
  });

  it('extracts the host pg will connect to', () => {
    expect(dbHostOf(REMOTE)).toBe('db.example.com');
    expect(dbHostOf('postgres://u@%2Ftmp/x')).toBe('/tmp');
    expect(dbHostOf('postgres://u@x/y?host=/sock')).toBe('/sock');
    expect(dbHostOf('not a url')).toBe(null);
  });

  it('recognises certificate failures', () => {
    expect(isCertificateError({ code: 'SELF_SIGNED_CERT_IN_CHAIN' })).toBe(true);
    expect(isCertificateError({ code: 'ERR_TLS_CERT_ALTNAME_INVALID' })).toBe(true);
    expect(isCertificateError({ code: 'ECONNREFUSED' })).toBe(false);
    expect(isCertificateError(null)).toBe(false);
  });
});
