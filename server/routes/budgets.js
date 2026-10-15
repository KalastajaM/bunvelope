import { validCipher } from '../encrypted-payload.js';
// server/routes/budgets.js — per-user budget CRUD + JSONB blob endpoints.

import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { query, withTx } from '../db.js';
import { requireAuth } from '../auth.js';
import { createBudgetStore, MAX_BUDGET_NAME_LEN } from '../services/budget-store.js';

const budgetStore = createBudgetStore({ query, withTx });

function sendStoreError(res, err) {
  const status = err.code === 'not_found' ? 404
    : err.code === 'version_conflict' || err.code === 'encryption_conflict' ? 409
      : err.code === 'bad_arguments' || err.code === 'validation_failed' ? 400
        : null;
  if (!status) return false;
  res.status(status).json({
    error: err.message,
    ...(err.current === undefined ? {} : { current: err.current }),
  });
  return true;
}

// A budget name is a label in a picker, not a document. The cap keeps a
// runaway or hostile client from parking megabytes in a column every list
// query returns. One limit, owned by the store, which also enforces it.
export { MAX_BUDGET_NAME_LEN };
const DEFAULT_MAX_BUDGETS_PER_USER = 50;

// budgets.id is a uuid column; any other string made Postgres throw
// 22P02, which surfaced as a 500 and an error in the logs for what is
// simply a budget that does not exist.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Per-user budget cap from MAX_BUDGETS_PER_USER (positive integer), else 50. */
export function budgetCapFromEnv(env = process.env) {
  const n = Number(env.MAX_BUDGETS_PER_USER);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_MAX_BUDGETS_PER_USER;
}

function readName(body) {
  const name = String(body?.name || '').trim();
  if (!name) return { error: { error: 'name required' } };
  if (name.length > MAX_BUDGET_NAME_LEN) {
    return { error: { error: 'name too long', max: MAX_BUDGET_NAME_LEN } };
  }
  return { name };
}

/**
 * @param {object} [opts]
 * @param {number} [opts.maxBudgetsPerUser]  creation cap; budgets that already
 *   exist beyond it are left alone, only new ones are refused.
 */
export function budgetRoutes({ maxBudgetsPerUser = budgetCapFromEnv() } = {}) {
  const r = Router();

  r.use(requireAuth);

  r.param('id', (_req, res, next, id) => {
    if (!UUID_RE.test(String(id))) return res.status(404).json({ error: 'not found' });
    next();
  });

  // Per-user cross-cut limiter for /api/* budget routes. Sized for
  // heavy-edit minutes (~30 writes + ~10 reads) with ~4× headroom.
  // Keyed by user id (set by requireAuth above) so concurrent users
  // don't share a bucket.
  r.use(rateLimit({
    windowMs: 60_000,
    max: 120,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => `bg:${req.user?.id || req.ip}`,
  }));

  r.get('/me', (req, res) => {
    res.json({ id: req.user.id, email: req.user.email, name: req.user.name });
  });

  // Display preferences (language, layout, Balance View, tour seen, view
  // choices), stored per user so they follow them across devices. The client
  // owns their meaning; the server only keeps them well-formed and small.
  r.get('/user/prefs', async (req, res, next) => {
    try {
      const { rows } = await query('select prefs from users where id = $1', [req.user.id]);
      res.json({ prefs: rows[0]?.prefs || {} });
    } catch (err) { next(err); }
  });

  // PATCH merges, key by key, so two devices changing different settings do
  // not overwrite each other. A null value removes the key.
  r.patch('/user/prefs', async (req, res, next) => {
    try {
      const patch = validPrefsPatch(req.body?.prefs);
      if (!patch) return res.status(400).json({ error: 'invalid prefs' });
      const removed = Object.keys(patch).filter(k => patch[k] === null);
      const set = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== null));
      const { rows } = await query(
        `update users set prefs = (prefs || $2::jsonb) - $3::text[]
           where id = $1 and octet_length(((prefs || $2::jsonb) - $3::text[])::text) <= $4
           returning prefs`,
        [req.user.id, JSON.stringify(set), removed, PREFS_MAX_BYTES],
      );
      if (!rows[0]) return res.status(413).json({ error: 'prefs too large' });
      res.json({ prefs: rows[0].prefs });
    } catch (err) { next(err); }
  });

  // Client-side encryption config. Server stores salt + verifier only; the
  // passphrase and derived key never leave the browser.
  r.get('/user/encryption', async (req, res, next) => {
    try {
      const { rows } = await query(
        `select encryption_enabled, encryption_salt, encryption_verifier,
           exists(select 1 from budget_blobs b join budgets bg on bg.id = b.budget_id
             where bg.user_id = users.id and b.data->>'__enc' is distinct from '1') as incomplete
           from users where id = $1`,
        [req.user.id],
      );
      const u = rows[0] || {};
      res.json({
        enabled: !!u.encryption_enabled,
        incomplete: !!u.encryption_enabled && !!u.incomplete,
        salt: u.encryption_salt ? u.encryption_salt.toString('base64') : null,
        verifier: u.encryption_verifier || null,
      });
    } catch (err) { next(err); }
  });

  r.post('/user/encryption', async (req, res, next) => {
    try {
      const enabled = !!req.body?.enabled;
      let salt = null;
      let verifier = null;
      if (enabled) {
        const saltB64 = req.body?.salt;
        verifier = req.body?.verifier;
        if (typeof saltB64 !== 'string' || !saltB64) {
          return res.status(400).json({ error: 'salt required when enabling' });
        }
        if (!verifier || verifier.__enc !== 1) {
          return res.status(400).json({ error: 'verifier required when enabling' });
        }
        salt = Buffer.from(saltB64, 'base64');
        if (salt.length < 8) {
          return res.status(400).json({ error: 'salt too short' });
        }
      }
      const expected = req.body?.expected;
      if (!expected || typeof expected.enabled !== 'boolean') {
        return res.status(409).json({ error: 'reload encryption configuration before changing it' });
      }
      if (enabled && !validVerifier(verifier)) {
        return res.status(400).json({ error: 'invalid encryption verifier' });
      }
      const result = await withTx(async (c) => {
        const { rows } = await c.query(
          `select encryption_enabled, encryption_salt, encryption_verifier from users
           where id = $1 for update`, [req.user.id],
        );
        const current = rows[0];
        if (!current) return 404;
        // Let Postgres compare JSON structurally (object key order is immaterial).
        const { rows: matching } = await c.query(
          `select id from users where id = $1 and encryption_enabled = $2
           and encryption_salt is not distinct from $3
           and encryption_verifier is not distinct from $4::jsonb`,
          [req.user.id, expected.enabled,
            expected.salt ? Buffer.from(expected.salt, 'base64') : null,
            expected.verifier ? JSON.stringify(expected.verifier) : null],
        );
        if (!matching.length) return 409;
        if (!enabled) {
          const { rows: encrypted } = await c.query(
            `select 1 from budget_blobs b join budgets bg on bg.id = b.budget_id
             where bg.user_id = $1 and b.data->>'__enc' = '1' limit 1`, [req.user.id],
          );
          if (encrypted.length) return 409;
        } else if (current.encryption_enabled && !verifier.wrappedKey) {
          // Legacy clients must not rewrite budgets then change the lone key slot.
          return 409;
        }
        await c.query(
          `update users set encryption_enabled = $1, encryption_salt = $2,
           encryption_verifier = $3 where id = $4`,
          [enabled, salt, verifier, req.user.id],
        );
        return 200;
      });
      if (result !== 200) return res.status(result).json({ error: 'encryption configuration conflict; reload before retrying' });
      res.json({ ok: true });
    } catch (err) { next(err); }
  });

  r.get('/budgets', async (req, res, next) => {
    try {
      const rows = await budgetStore.listBudgets({ userId: req.user.id });
      res.json(rows.map(({ user_id: _userId, owner_email: _owner, ...row }) => row));
    } catch (err) { next(err); }
  });

  r.post('/budgets', async (req, res, next) => {
    try {
      const { name, error } = readName(req.body);
      if (error) return res.status(400).json(error);
      // Fresh budget has no blobs — the client's setup wizard writes meta
      // (and seeds envelopes/accounts) on first open. The store owns the
      // lock-count-insert, shared with the restore command.
      const out = await budgetStore.createBudget({
        userId: req.user.id, name, maxPerUser: maxBudgetsPerUser,
      });
      res.status(201).json(out);
    } catch (err) {
      if (err?.code === 'budget_limit') {
        return res.status(403).json({ error: 'budget limit reached', max: maxBudgetsPerUser });
      }
      if (sendStoreError(res, err)) return;
      next(err);
    }
  });

  r.patch('/budgets/:id', async (req, res, next) => {
    try {
      const { name, error } = readName(req.body);
      if (error) return res.status(400).json(error);
      const { rowCount, rows } = await query(
        `update budgets set name = $1
         where id = $2 and user_id = $3
         returning id, name, version, last_opened_at`,
        [name, req.params.id, req.user.id],
      );
      if (!rowCount) return res.status(404).json({ error: 'not found' });
      res.json(rows[0]);
    } catch (err) { next(err); }
  });

  r.delete('/budgets/:id', async (req, res, next) => {
    try {
      const { rowCount } = await query(
        'delete from budgets where id = $1 and user_id = $2',
        [req.params.id, req.user.id],
      );
      if (!rowCount) return res.status(404).json({ error: 'not found' });
      res.status(204).end();
    } catch (err) { next(err); }
  });

  r.get('/budgets/:id', async (req, res, next) => {
    try {
      const result = await budgetStore.readBudget({
        budgetId: req.params.id, userId: req.user.id, touchLastOpened: true, rawHistory: req.get('x-bunvelope-history') === 'chunks',
      });
      res.json({ ...result.bundle, version: result.version });
    } catch (err) { if (!sendStoreError(res, err)) next(err); }
  });

  // Single-collection upsert with optimistic concurrency.
  r.put('/budgets/:id/collections/:kind', async (req, res, next) => {
    try {
      const result = await budgetStore.applyBudget({
        budgetId: req.params.id,
        userId: req.user.id,
        expectedVersion: Number(req.body?.version),
        items: [{ kind: req.params.kind, data: req.body?.data, ...(req.body?.historyChunks ? { historyChunks: req.body.historyChunks } : {}) }],
      });
      res.json({ version: result.version });
    } catch (err) { if (!sendStoreError(res, err)) next(err); }
  });

  // Batch: multiple collections in one transaction. Mirrors writeBatch().
  r.put('/budgets/:id/batch', async (req, res, next) => {
    try {
      const result = await budgetStore.applyBudget({
        budgetId: req.params.id,
        userId: req.user.id,
        expectedVersion: Number(req.body?.version),
        items: req.body?.items,
        decrypting: req.body?.decrypting === true,
      });
      res.json({ version: result.version });
    } catch (err) { if (!sendStoreError(res, err)) next(err); }
  });

  return r;
}


function validVerifier(value) {
  return validCipher(value) && (!Object.hasOwn(value, 'wrappedKey') || validCipher(value.wrappedKey));
}

// Preferences are small display settings. The cap keeps a runaway client
// from turning the users row into a blob store.
const PREFS_MAX_BYTES = 8192;
const PREFS_KEY_RE = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;
const PREFS_MAX_KEYS = 40;
const PREFS_MAX_STRING = 200;
const PREFS_MAX_LIST = 200;

function validPrefValue(v) {
  if (v === null || typeof v === 'boolean') return true;
  if (typeof v === 'number') return Number.isFinite(v);
  if (typeof v === 'string') return v.length <= PREFS_MAX_STRING;
  if (Array.isArray(v)) {
    return v.length <= PREFS_MAX_LIST
      && v.every(x => typeof x === 'string' && x.length <= PREFS_MAX_STRING);
  }
  return false;
}

/**
 * A prefs patch is a flat object of known-shaped values: booleans, finite
 * numbers, short strings, short lists of short strings, or null (remove).
 * Returns the patch, or null when anything in it is off.
 */
function validPrefsPatch(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const entries = Object.entries(value);
  if (entries.length > PREFS_MAX_KEYS) return null;
  for (const [k, v] of entries) {
    if (!PREFS_KEY_RE.test(k) || !validPrefValue(v)) return null;
  }
  return value;
}
