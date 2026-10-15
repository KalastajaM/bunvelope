// server/auth.js — Google OAuth via Passport + express-session.
// Sessions are stored in Postgres (connect-pg-simple) so they survive
// deploys / container restarts. Cookies are httpOnly, secure (in prod),
// and SameSite=Lax — same-origin only, so this doubles as CSRF defence
// for state-changing API routes (paired with origin check below).

import session from 'express-session';
import ConnectPgSimpleFactory from 'connect-pg-simple';
import passport from 'passport';
import { Strategy as GoogleStrategy } from 'passport-google-oauth20';
import rateLimit from 'express-rate-limit';
import express from 'express';
import { timingSafeEqual, scrypt as scryptCb, randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import { pool, query } from './db.js';

const ConnectPgSimple = ConnectPgSimpleFactory(session);

const scrypt = promisify(scryptCb);

// Minimum length policy for the bypass-mode shared password. Enforced at
// password-change time; not at boot — operators can ship a short bootstrap
// value, and users will be prompted to rotate it on first login.
export const BYPASS_PASSWORD_MIN_LEN = 16;

/**
 * Read auth-mode env vars once at boot. Returns either the standard OAuth
 * mode or the bypass mode (Google disabled, single shared user gated by
 * BYPASS_PASSWORD). Throws only if BYPASS_GOOGLE is on without any password
 * — a short password just warns, and users are forced to rotate it on
 * first login so operators are never locked out by tightening the policy.
 */
export function readAuthMode() {
  const bypass = String(process.env.BYPASS_GOOGLE || '').toLowerCase() === 'true';
  if (!bypass) return { kind: 'oauth' };
  const pw = process.env.BYPASS_PASSWORD;
  if (!pw) {
    throw new Error('BYPASS_GOOGLE=true requires BYPASS_PASSWORD to be set');
  }
  if (pw.length < BYPASS_PASSWORD_MIN_LEN) {
    console.warn(
      `auth: BYPASS_PASSWORD is shorter than ${BYPASS_PASSWORD_MIN_LEN} chars; `
      + 'users will be forced to change it on first login.',
    );
  }
  return { kind: 'bypass', bypassPassword: pw };
}

export function sessionMiddleware() {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error('SESSION_SECRET must be set to a random 32+ char string');
  }
  return session({
    // pruneSessionInterval is seconds; hourly is plenty for expired-row
    // cleanup and keeps the background DELETE off the 15-minute default.
    store: new ConnectPgSimple({ pool, tableName: 'session', pruneSessionInterval: 3600 }),
    name: 'bv.sid',
    secret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
    },
  });
}

/**
 * ALLOWED_EMAILS → a Set of lower-cased addresses, or null when unset/empty.
 * Null means "anyone with a Google account", which is the historical
 * behaviour and stays the default so an upgrade cannot lock the owner out.
 */
export function parseAllowedEmails(raw) {
  if (typeof raw !== 'string') return null;
  const list = raw.split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
  return list.length ? new Set(list) : null;
}

export function isEmailAllowed(email, allowed) {
  if (!allowed) return true;
  return typeof email === 'string' && allowed.has(email.trim().toLowerCase());
}

// Set by configurePassport in OAuth mode. Also consulted when a session is
// deserialised, so tightening the list ends existing sessions of accounts
// that are no longer on it instead of letting them run out their 30 days.
let activeAllowlist = null;

passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser(async (id, done) => {
  try {
    const { rows } = await query(
      'select id, email, name from users where id = $1',
      [id],
    );
    const user = rows[0] || null;
    if (user && !isEmailAllowed(user.email, activeAllowlist)) return done(null, false);
    done(null, user);
  } catch (err) {
    done(err);
  }
});

/**
 * Passport verify callback for Google. An account outside `allowed` is
 * refused before the upsert, so a stranger does not even get a users row.
 */
export function googleVerify({ query: q = query, allowed = null } = {}) {
  return async (_accessToken, _refreshToken, profile, done) => {
    try {
      const sub = profile.id;
      const email = profile.emails?.[0]?.value?.toLowerCase() || null;
      const name = profile.displayName || null;
      if (!email) return done(new Error('Google account had no email'));
      if (!isEmailAllowed(email, allowed)) {
        return done(null, false, { message: 'email_not_allowed' });
      }
      // Upsert by google_sub; keep email/name in sync.
      const { rows } = await q(
        `insert into users (google_sub, email, name)
         values ($1, $2, $3)
         on conflict (google_sub) do update
           set email = excluded.email, name = excluded.name
         returning id, email, name`,
        [sub, email, name],
      );
      done(null, rows[0]);
    } catch (err) {
      done(err);
    }
  };
}

export function configurePassport(mode = { kind: 'oauth' }) {
  // Bypass mode skips Google strategy registration entirely. The shared
  // bypass user is logged in directly by the /auth/password handler.
  activeAllowlist = null;
  if (mode.kind === 'bypass') return;

  const clientID = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const callbackURL = process.env.OAUTH_CALLBACK_URL
    || '/auth/google/callback';
  if (!clientID || !clientSecret) {
    throw new Error('GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set');
  }
  const allowed = parseAllowedEmails(process.env.ALLOWED_EMAILS);
  if (!allowed) {
    console.warn(
      'auth: ALLOWED_EMAILS is not set; any Google account can sign up. '
      + 'Set it to a comma-separated list of addresses to restrict sign-in.',
    );
  }
  activeAllowlist = allowed;
  passport.use(new GoogleStrategy(
    { clientID, clientSecret, callbackURL, state: true },
    googleVerify({ allowed }),
  ));
}

// Synthetic identity used when BYPASS_GOOGLE is on. The unique `google_sub`
// value satisfies the existing not-null/unique constraints on the users
// table without a schema migration.
const BYPASS_GOOGLE_SUB = 'bypass:local';
const BYPASS_EMAIL      = 'bypass@local';
const BYPASS_NAME       = 'Bypass user';

export async function ensureBypassUser() {
  const { rows } = await query(
    `insert into users (google_sub, email, name)
     values ($1, $2, $3)
     on conflict (google_sub) do update set email = excluded.email
     returning id, email, name`,
    [BYPASS_GOOGLE_SUB, BYPASS_EMAIL, BYPASS_NAME],
  );
  return rows[0];
}

export function requireAuth(req, res, next) {
  if (req.isAuthenticated?.() && req.user) return next();
  res.status(401).json({ error: 'unauthorized' });
}

// Bypass mode: a session opened with the short env-var bootstrap password is
// good for exactly one thing, rotating it. The login response already told
// the client to rotate, but that was advisory: the cookie it set authorised
// the whole API, so any client that ignored the flag (or a script) kept a
// full session on a password the operator was warned is too weak. Mounted
// after requireAuth on /api; /auth/password/change and /auth/logout live
// outside /api and stay reachable.
//
// /api/me answers 401 rather than 403: the client's boot treats 401 from
// /api/me as "signed out" and shows the login form, and logging in again
// with the bootstrap value leads straight back to the rotation screen. A 403
// there would be an unexplained boot error instead.
export function requirePasswordRotated(req, res, next) {
  if (!req.session?.mustChangePassword) return next();
  const status = req.path === '/me' ? 401 : 403;
  res.status(status).json({ error: 'password_change_required' });
}

// Same-origin enforcement for state-changing API requests. Blocks forged
// requests from other origins even if the session cookie leaks.
export function requireSameOrigin(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD') return next();
  const origin = req.get('origin');
  // Non-browser clients may omit Origin. A browser explicitly reporting a
  // cross-site request must still be refused when Origin is absent.
  if (!origin) {
    if (req.get('sec-fetch-site') === 'cross-site') {
      return res.status(403).json({ error: 'cross-origin request blocked' });
    }
    return next();
  }
  const host = req.get('host');
  try {
    const u = new URL(origin);
    const expected = new URL(`${req.protocol}://${host}`);
    if (!['http:', 'https:'].includes(u.protocol) || u.origin !== expected.origin
      || u.username || u.password || u.pathname !== '/' || u.search || u.hash) {
      return res.status(403).json({ error: 'cross-origin request blocked' });
    }
  } catch {
    return res.status(400).json({ error: 'bad origin' });
  }
  next();
}

export const authLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
});

export function mountAuthRoutes(app, mode = { kind: 'oauth' }) {
  app.use('/auth', (_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  if (mode.kind === 'oauth') {
    app.get('/auth/google', authLimiter, passport.authenticate('google', {
      scope: ['openid', 'email', 'profile'],
    }));

    // Custom callback so EVERY failure lands on the login screen with its
    // "sign-in failed" note, not only the refusals passport reports as a
    // missing user. A Google-side error (rejected code, userinfo failure, an
    // account with no email) or a second Google account claiming a
    // registered email used to reach the error handler as a bare JSON 500.
    // The reason is logged; nothing about it goes to the browser.
    app.get('/auth/google/callback',
      authLimiter,
      (req, res, next) => {
        passport.authenticate('google', (err, user) => {
          const failed = (why) => {
            if (why) req.log?.warn?.({ err: why.message || String(why) }, 'google sign-in failed');
            return res.redirect('/?auth=failed');
          };
          if (err) return failed(err);
          if (!user) return failed(null);
          // req.logIn regenerates the session id before storing the user,
          // exactly as the default callback did.
          return req.logIn(user, (loginErr) => (loginErr ? failed(loginErr) : res.redirect('/')));
        })(req, res, next);
      },
    );
  } else if (mode.kind === 'bypass') {
    // Single-shared-user password gate. Body is parsed locally so the
    // /api JSON parser doesn't have to apply to /auth/* routes.
    //
    // Compare priority: DB hash if set on the bypass user row, else the
    // env-var bootstrap value. When the env-var path was used and the
    // value is shorter than BYPASS_PASSWORD_MIN_LEN we return
    // mustChangePassword=true so the client forces a rotation before the
    // budget picker renders.
    app.post('/auth/password',
      authLimiter,
      requireSameOrigin,
      express.json({ limit: '1kb' }),
      async (req, res, next) => {
        try {
          const submitted = String(req.body?.password ?? '');
          const user = await ensureBypassUser();
          const { rows } = await query(
            'select bypass_password_hash from users where id = $1',
            [user.id],
          );
          const storedHash = rows[0]?.bypass_password_hash;

          let ok = false;
          let mustChangePassword = false;
          if (storedHash) {
            ok = await verifyBypassPassword(submitted, storedHash);
          } else {
            const a = Buffer.from(submitted);
            const b = Buffer.from(mode.bypassPassword);
            ok = a.length === b.length && timingSafeEqual(a, b);
            if (ok && mode.bypassPassword.length < BYPASS_PASSWORD_MIN_LEN) {
              mustChangePassword = true;
            }
          }
          if (!ok) return res.status(401).json({ error: 'invalid password' });
          req.login(user, (err) => {
            if (err) return next(err);
            // Set after login: passport regenerates the session inside
            // req.login, which would drop a flag set before it.
            if (mustChangePassword) req.session.mustChangePassword = true;
            res.json({ ok: true, mustChangePassword });
          });
        } catch (err) { next(err); }
      },
    );

    // Authenticated change-password endpoint. Verifies the current password
    // through the same hash-or-env-var path, enforces the policy floor on
    // the new value, and persists a fresh scrypt hash. Once the column is
    // populated the env var is no longer consulted.
    app.post('/auth/password/change',
      authLimiter,
      requireSameOrigin,
      requireAuth,
      express.json({ limit: '1kb' }),
      async (req, res, next) => {
        try {
          if (mode.kind !== 'bypass') {
            return res.status(400).json({ error: 'not_bypass_mode' });
          }
          const current = String(req.body?.current ?? '');
          const proposed = String(req.body?.new ?? '');
          if (proposed.length < BYPASS_PASSWORD_MIN_LEN) {
            return res.status(400).json({
              error: 'password_too_short',
              min: BYPASS_PASSWORD_MIN_LEN,
            });
          }
          const { rows } = await query(
            'select bypass_password_hash from users where id = $1',
            [req.user.id],
          );
          const storedHash = rows[0]?.bypass_password_hash;
          let ok;
          if (storedHash) {
            ok = await verifyBypassPassword(current, storedHash);
          } else {
            const a = Buffer.from(current);
            const b = Buffer.from(mode.bypassPassword);
            ok = a.length === b.length && timingSafeEqual(a, b);
          }
          if (!ok) return res.status(401).json({ error: 'invalid_current_password' });

          const newHash = await hashBypassPassword(proposed);
          await query(
            'update users set bypass_password_hash = $1 where id = $2',
            [newHash, req.user.id],
          );
          if (req.session) delete req.session.mustChangePassword;
          res.json({ ok: true });
        } catch (err) { next(err); }
      },
    );
  }

  app.post('/auth/logout', authLimiter, requireSameOrigin, (req, res, next) => {
    req.logout((err) => {
      if (err) return next(err);
      req.session.destroy(() => res.json({ ok: true }));
    });
  });
}

// scrypt parameters — chosen for ~50ms hash on modest hardware. N is the
// CPU/memory cost factor (2^14 = 16384), r is the block-size factor, p is
// parallelism, dkLen is the derived-key length in bytes.
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_LEN = 64;

// Encode hash + parameters in a single colon-delimited string so we can
// upgrade params later without breaking existing rows. Format:
//   scrypt:<N>:<r>:<p>:<saltB64>:<hashB64>
export async function hashBypassPassword(pw) {
  const salt = randomBytes(16);
  const buf = await scrypt(pw, salt, SCRYPT_LEN, {
    N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P,
  });
  return [
    'scrypt',
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    salt.toString('base64'),
    buf.toString('base64'),
  ].join(':');
}

export async function verifyBypassPassword(pw, encoded) {
  if (typeof encoded !== 'string') return false;
  const parts = encoded.split(':');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, nStr, rStr, pStr, saltB64, hashB64] = parts;
  const N = Number(nStr);
  const r = Number(rStr);
  const p = Number(pStr);
  if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p)) return false;
  // Reject implausible scrypt cost params (e.g. a poisoned hash row) before
  // calling scrypt — stops an attacker-controlled N from spiking CPU/memory.
  // Bounds sit well above the SCRYPT_* params used at write time, with headroom
  // for future upgrades; Node's maxmem guard backstops anything that slips past.
  if (N < 2 || N > 2 ** 20 || r < 1 || r > 64 || p < 1 || p > 16) return false;
  let salt;
  let expected;
  try {
    salt = Buffer.from(saltB64, 'base64');
    expected = Buffer.from(hashB64, 'base64');
  } catch {
    return false;
  }
  if (expected.length === 0) return false;
  let got;
  try {
    got = await scrypt(pw, salt, expected.length, { N, r, p });
  } catch {
    return false;
  }
  return got.length === expected.length && timingSafeEqual(got, expected);
}
