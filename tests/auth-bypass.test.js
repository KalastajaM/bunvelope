// tests/auth-bypass.test.js — scrypt-based bypass-password helpers.
// The login + change-password endpoints aren't exercised here (no test DB
// harness); the helpers below are the security-sensitive bits and worth
// pinning so a stray refactor doesn't silently make verify always-true or
// always-false.

import { describe, it, expect } from 'vitest';
import { hashBypassPassword, verifyBypassPassword } from '../server/auth.js';

describe('bypass password hash helpers', () => {
  it('round-trips a hashed password', async () => {
    const pw = 'correct-horse-battery-staple-XYZ';
    const hash = await hashBypassPassword(pw);
    expect(hash.startsWith('scrypt:')).toBe(true);
    expect(await verifyBypassPassword(pw, hash)).toBe(true);
  });

  it('rejects a wrong password', async () => {
    const hash = await hashBypassPassword('the-real-password-1234');
    expect(await verifyBypassPassword('wrong-guess', hash)).toBe(false);
  });

  it('returns false (no throw) on a malformed encoded string', async () => {
    expect(await verifyBypassPassword('any', 'not-a-scrypt-hash')).toBe(false);
    expect(await verifyBypassPassword('any', 'scrypt:bogus')).toBe(false);
    expect(await verifyBypassPassword('any', 'scrypt:abc:8:1:salt:hash')).toBe(false);
  });

  it('returns false (no throw) on null / non-string encoded input', async () => {
    expect(await verifyBypassPassword('any', null)).toBe(false);
    expect(await verifyBypassPassword('any', undefined)).toBe(false);
    expect(await verifyBypassPassword('any', 42)).toBe(false);
    expect(await verifyBypassPassword('any', '')).toBe(false);
  });

  it('handles non-ASCII passwords correctly', async () => {
    const pw = 'pässwörd-ünïcödé-ok-16+';
    const hash = await hashBypassPassword(pw);
    expect(await verifyBypassPassword(pw, hash)).toBe(true);
    expect(await verifyBypassPassword('pässwörd-ünïcödé-ok-16', hash)).toBe(false);
  });

  it('rejects out-of-range scrypt cost params instead of running scrypt', async () => {
    const pw = 'bounded-params-please-1234';
    const hash = await hashBypassPassword(pw);
    expect(await verifyBypassPassword(pw, hash)).toBe(true);
    // Poison the N field with an absurd cost factor (a hostile/garbled row):
    // verify must reject it up front rather than spending CPU/memory on it.
    const [, , r, p, salt, h] = hash.split(':');
    const poisoned = ['scrypt', String(2 ** 30), r, p, salt, h].join(':');
    expect(await verifyBypassPassword(pw, poisoned)).toBe(false);
  });
});
