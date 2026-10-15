// ALLOWED_EMAILS: who may sign in with Google. Unset keeps today's open
// behaviour (so the owner is never locked out by an upgrade) but says so
// loudly at boot.

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  parseAllowedEmails, isEmailAllowed, googleVerify, configurePassport,
} from '../server/auth.js';

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.ALLOWED_EMAILS;
});

function verifyWith(allowed, email) {
  const query = vi.fn(async (_sql, params) => ({
    rows: [{ id: 'u1', email: params[1], name: params[2] }],
  }));
  const verify = googleVerify({ query, allowed });
  return new Promise((resolve) => {
    verify('at', 'rt', { id: 'sub-1', emails: [{ value: email }], displayName: 'X' },
      (err, user, info) => resolve({ err, user, info, query }));
  });
}

describe('ALLOWED_EMAILS', () => {
  it('parses a comma-separated, case-insensitive list', () => {
    const set = parseAllowedEmails(' Owner@Example.com, ,partner@example.com ');
    expect([...set].sort()).toEqual(['owner@example.com', 'partner@example.com']);
    expect(parseAllowedEmails(undefined)).toBeNull();
    expect(parseAllowedEmails('  ,  ')).toBeNull();
  });

  it('matches case-insensitively and allows everyone when unset', () => {
    const set = parseAllowedEmails('owner@example.com');
    expect(isEmailAllowed('OWNER@example.com', set)).toBe(true);
    expect(isEmailAllowed('stranger@example.com', set)).toBe(false);
    expect(isEmailAllowed('anyone@example.com', null)).toBe(true);
    expect(isEmailAllowed(null, set)).toBe(false);
  });

  it('refuses a Google account outside the list without creating a user', async () => {
    const { err, user, info, query } = await verifyWith(
      parseAllowedEmails('owner@example.com'), 'stranger@example.com',
    );
    expect(err).toBeNull();
    expect(user).toBe(false);
    expect(info).toEqual({ message: 'email_not_allowed' });
    expect(query).not.toHaveBeenCalled();
  });

  it('signs in a listed account', async () => {
    const { user, query } = await verifyWith(parseAllowedEmails('owner@example.com'), 'Owner@Example.com');
    expect(user).toMatchObject({ email: 'owner@example.com' });
    expect(query).toHaveBeenCalledOnce();
  });

  it('keeps signup open when unset, and warns at boot', async () => {
    const { user } = await verifyWith(null, 'anyone@example.com');
    expect(user).toMatchObject({ email: 'anyone@example.com' });

    process.env.GOOGLE_CLIENT_ID = 'id';
    process.env.GOOGLE_CLIENT_SECRET = 'secret';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    configurePassport({ kind: 'oauth' });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('ALLOWED_EMAILS'));

    warn.mockClear();
    process.env.ALLOWED_EMAILS = 'owner@example.com';
    configurePassport({ kind: 'oauth' });
    expect(warn).not.toHaveBeenCalled();
  });
});
