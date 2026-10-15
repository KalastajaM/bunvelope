import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import passport from 'passport';
import { configurePassport } from '../server/auth.js';

vi.mock('../server/db.js', () => ({ pool: {}, query: vi.fn(async () => ({ rows: [{ id: 'user-1' }] })) }));

// Keep the installed strategy and session store real; replace only upstream I/O.
let strategy;
function authenticate(session, query = {}) {
  const attempt = Object.create(strategy);
  return new Promise((resolve, reject) => {
    attempt.redirect = (url) => resolve({ redirect: url });
    attempt.success = (user) => resolve({ user });
    attempt.fail = (info) => resolve({ failed: info });
    attempt.error = reject;
    attempt.authenticate({ session, query, headers: { host: 'localhost' }, connection: {} }, {});
  });
}
async function start(session) {
  const result = await authenticate(session);
  return new URL(result.redirect).searchParams.get('state');
}
beforeEach(() => {
  vi.stubEnv('GOOGLE_CLIENT_ID', 'test-client');
  vi.stubEnv('GOOGLE_CLIENT_SECRET', 'test-secret');
  vi.stubEnv('OAUTH_CALLBACK_URL', 'https://localhost/auth/google/callback');
  configurePassport();
  strategy = passport._strategy('google');
  strategy._oauth2.getOAuthAccessToken = (_code, _params, done) => done(null, 'access', 'refresh', {});
  strategy.userProfile = (_token, done) => done(null, { id: 'google-1', emails: [{ value: 'test@example.com' }] });
});
afterEach(() => vi.unstubAllEnvs());

describe('Google OAuth session binding', () => {
  it('rejects a callback with no state', async () => {
    expect(await authenticate({}, { code: 'code' })).toHaveProperty('failed');
  });
  it('rejects incorrect state', async () => {
    const session = {};
    await start(session);
    expect(await authenticate(session, { code: 'code', state: 'wrong' })).toHaveProperty('failed');
  });
  it('rejects state from another session', async () => {
    const state = await start({});
    expect(await authenticate({}, { code: 'code', state })).toHaveProperty('failed');
  });
  it('accepts the initiating session once and rejects replay', async () => {
    const session = {};
    const state = await start(session);
    expect(state).toBeTypeOf('string');
    expect(state.length).toBeGreaterThan(16);
    expect(await authenticate(session, { code: 'code', state })).toEqual({ user: { id: 'user-1' } });
    expect(await authenticate(session, { code: 'code', state })).toHaveProperty('failed');
  });
});
