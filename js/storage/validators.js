// js/storage/validators.js — Runtime schema checks at the storage
// boundary. The load path uses validateBundle() to guard against
// corrupted/hand-edited budget files; the save path uses
// validateCollection() to catch in-memory bugs before they reach disk.
//
// Validators are deliberately strict on shape (types, required ids) and
// permissive on unknown fields — adding a new property to any entity
// must not require a validator change.

import { validateAccountRefs } from '../engine/insights.js';
import { TX_TYPES } from '../engine/tx-amounts.js';

// The bundle schema this build reads and writes. Defined once here, the one
// storage module both the browser adapters and Node (server, CLI) import, so
// a schema bump cannot leave one of them behind.
export const CURRENT_SCHEMA_VERSION = 8;

const MAX_ERRORS = 20;

function isObj(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

// Round-trips Y/M/D through a UTC date: `new Date('2026-02-31')` is not
// invalid, it silently rolls over to 3 March, so a parse-succeeded check let
// impossible dates into storage where every later date comparison misplaced
// them. UTC so the answer cannot depend on the machine's timezone.
function isIsoDate(v) {
  if (typeof v !== 'string') return false;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

// Types whose effect is defined by `amount`: every engine type except fill,
// whose money lives in `lines` and which legitimately has no top-level amount.
// Derived from TX_TYPES so a new type cannot be forgotten here.
const AMOUNT_REQUIRED_TYPES = new Set(TX_TYPES.filter((type) => type !== 'fill'));

function makeCollector() {
  const errors = [];
  const push = (msg) => { if (errors.length < MAX_ERRORS) errors.push(msg); };
  return {
    push,
    result() {
      return {
        ok: errors.length === 0,
        errors,
        truncated: errors.length >= MAX_ERRORS,
      };
    },
  };
}

// §1.3 — nothing in v1 stopped two records sharing an id, and every lookup in
// the app is `find(r => r.id === id)`: first match wins, so a duplicate makes
// one row permanently unreachable while the other answers for both. Editing
// one edits the wrong one; deleting one leaves the other. `runInvariantCheck`
// notices afterwards, but detection after a corrupting write is not
// prevention — this runs on the write path, so a corrupting import is refused.
function checkUniqueIds(value, collection, c) {
  const seen = new Set();
  for (const [i, r] of value.entries()) {
    if (!isObj(r) || typeof r.id !== 'string' || !r.id) continue;
    if (seen.has(r.id)) c.push(`${collection}[${i}] duplicate id "${r.id}"`);
    else seen.add(r.id);
  }
}

export function validateEnvelopes(value) {
  const c = makeCollector();
  if (!Array.isArray(value)) {
    c.push(`envelopes must be an array (got ${typeof value})`);
    return c.result();
  }
  for (const [i, e] of value.entries()) {
    if (!isObj(e)) { c.push(`envelopes[${i}] is not an object`); continue; }
    if (typeof e.id !== 'string' || !e.id) c.push(`envelopes[${i}] missing id`);
    if (typeof e.name !== 'string' || !e.name) c.push(`envelopes[${i}] (${e.id || '?'}) missing name`);
  }
  checkUniqueIds(value, 'envelopes', c);
  return c.result();
}

export function validateAccounts(value) {
  const c = makeCollector();
  if (!Array.isArray(value)) {
    c.push(`accounts must be an array (got ${typeof value})`);
    return c.result();
  }
  for (const [i, a] of value.entries()) {
    if (!isObj(a)) { c.push(`accounts[${i}] is not an object`); continue; }
    if (typeof a.id !== 'string' || !a.id) c.push(`accounts[${i}] missing id`);
    if (typeof a.name !== 'string' || !a.name) c.push(`accounts[${i}] (${a.id || '?'}) missing name`);
    if (a.initialBalance !== undefined && !isFiniteNumber(a.initialBalance)) {
      c.push(`accounts[${i}] (${a.id || '?'}) invalid initialBalance`);
    }
  }
  checkUniqueIds(value, 'accounts', c);
  return c.result();
}

export function validateTransactions(value) {
  const c = makeCollector();
  if (!Array.isArray(value)) {
    c.push(`transactions must be an array (got ${typeof value})`);
    return c.result();
  }
  for (const [i, t] of value.entries()) {
    if (!isObj(t)) { c.push(`transactions[${i}] is not an object`); continue; }
    const label = t.id || `index ${i}`;
    if (typeof t.id !== 'string' || !t.id) c.push(`transactions[${label}] missing id`);
    // Presence only, deliberately not membership in TX_TYPES: saves validate
    // the whole collection, so rejecting one legacy row with an unsupported
    // type would fail every later save and refuse the budget on load.
    // runInvariantCheck reports such rows (`unknownTypes`) and
    // the session's commit checks refuse to write new or changed ones.
    if (typeof t.type !== 'string' || !t.type) c.push(`transactions[${label}] missing type`);
    // A real number only. `Number(x)` used to be the test, which let "12",
    // "", null and true through (all coerce to finite numbers) and so let
    // string amounts reach the engine, where `+` concatenates.
    if (t.amount === undefined) {
      if (AMOUNT_REQUIRED_TYPES.has(t.type)) c.push(`transactions[${label}] missing amount`);
    } else if (!isFiniteNumber(t.amount)) {
      c.push(`transactions[${label}] invalid amount`);
    }
    if (t.date !== undefined && !isIsoDate(t.date)) {
      c.push(`transactions[${label}] invalid date`);
    }
  }
  checkUniqueIds(value, 'transactions', c);
  return c.result();
}

/**
 * Every account reference on every transaction resolves to an account.
 *
 * Cross-collection, so it is not part of validateTransactions (which sees one
 * collection) and not part of validateBundle: the app already tolerates and
 * reports dangling references through runInvariantCheck, and refusing to load
 * a budget that has one would lock its owner out of their own data. Callers
 * on a write path use it to refuse writes that ADD a dangling reference;
 * `tolerate` lists ids that were already dangling before the write, so
 * legacy data never blocks a save. Anything that is not a plain array (an
 * encrypted blob, a missing collection) is skipped: there is nothing to
 * check it against.
 *
 * @param {unknown} transactions
 * @param {unknown} accounts
 * @param {{ tolerate?: Iterable<string> }} [opts]
 */
export function validateTransactionAccountRefs(transactions, accounts, { tolerate = [] } = {}) {
  const c = makeCollector();
  if (!Array.isArray(transactions) || !Array.isArray(accounts)) return c.result();
  const ids = new Set(accounts.filter(isObj).map((a) => a.id));
  for (const id of tolerate) ids.add(id);
  for (const [i, t] of transactions.entries()) {
    if (!isObj(t)) continue;
    for (const problem of validateAccountRefs(t, ids)) {
      c.push(`transactions[${t.id || `index ${i}`}] ${problem.message}`);
    }
  }
  return c.result();
}

/** Account ids referenced by `transactions` that `accounts` does not contain. */
export function danglingAccountIds(transactions, accounts) {
  const out = new Set();
  if (!Array.isArray(transactions) || !Array.isArray(accounts)) return out;
  const ids = new Set(accounts.filter(isObj).map((a) => a.id));
  for (const t of transactions) {
    if (!isObj(t)) continue;
    for (const problem of validateAccountRefs(t, ids)) out.add(problem.params.id);
  }
  return out;
}

export function validateBudgetItems(value) {
  const c = makeCollector();
  if (!Array.isArray(value)) {
    c.push(`budgetItems must be an array (got ${typeof value})`);
    return c.result();
  }
  for (const [i, b] of value.entries()) {
    if (!isObj(b)) { c.push(`budgetItems[${i}] is not an object`); continue; }
    if (typeof b.id !== 'string' || !b.id) c.push(`budgetItems[${i}] missing id`);
  }
  checkUniqueIds(value, 'budgetItems', c);
  return c.result();
}

export function validateEnvelopeTemplates(value) {
  const c = makeCollector();
  if (!Array.isArray(value)) {
    c.push(`envelopeTemplates must be an array (got ${typeof value})`);
    return c.result();
  }
  for (const [i, t] of value.entries()) {
    if (!isObj(t)) { c.push(`envelopeTemplates[${i}] is not an object`); continue; }
    if (typeof t.id !== 'string' || !t.id) c.push(`envelopeTemplates[${i}] missing id`);
    if (t.schedule !== undefined) validateTemplateSchedule(t.schedule, i, c);
  }
  checkUniqueIds(value, 'envelopeTemplates', c);
  return c.result();
}

const SCHEDULE_DAY_TYPES = new Set(['exact', 'next_work_day', 'prev_work_day']);
const MONTH_KEYS = new Set([
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
]);

// A self-scheduled template fires real fills on a calendar, so a malformed
// schedule that reaches the walker moves money on the wrong day — or every day.
function validateTemplateSchedule(s, i, c) {
  const at = `envelopeTemplates[${i}].schedule`;
  if (!isObj(s)) { c.push(`${at} must be an object`); return; }
  if (typeof s.enabled !== 'boolean') c.push(`${at}.enabled must be a boolean`);
  if (!isFiniteNumber(s.payment_day) || s.payment_day < 1 || s.payment_day > 31) {
    c.push(`${at}.payment_day must be a number 1–31 (got ${s.payment_day})`);
  }
  if (s.day_type !== undefined && !SCHEDULE_DAY_TYPES.has(s.day_type)) {
    c.push(`${at}.day_type must be one of exact, next_work_day, prev_work_day (got ${s.day_type})`);
  }
  if (s.since !== undefined && !(typeof s.since === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s.since))) {
    c.push(`${at}.since must be YYYY-MM-DD (got ${s.since})`);
  }
  if (s.until !== undefined && !(typeof s.until === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s.until))) {
    c.push(`${at}.until must be YYYY-MM-DD (got ${s.until})`);
  }
  if (s.source_envelope_id !== undefined && !(typeof s.source_envelope_id === 'string' && s.source_envelope_id)) {
    c.push(`${at}.source_envelope_id must be a non-empty envelope id (got ${s.source_envelope_id})`);
  }
  if (s.source_since !== undefined && !(typeof s.source_since === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s.source_since))) {
    c.push(`${at}.source_since must be YYYY-MM-DD (got ${s.source_since})`);
  }
  if (!isObj(s.months)) {
    c.push(`${at}.months must be an object`);
  } else {
    for (const [k, v] of Object.entries(s.months)) {
      if (!MONTH_KEYS.has(k)) c.push(`${at}.months has unknown key "${k}"`);
      // Booleans only: a template's amounts come from its lines, so there is
      // nothing per-month to override the way a budget item has.
      else if (typeof v !== 'boolean') c.push(`${at}.months.${k} must be a boolean (got ${typeof v})`);
    }
  }
  if (s.skipped !== undefined) {
    if (!Array.isArray(s.skipped)) c.push(`${at}.skipped must be an array`);
    else for (const [j, k] of s.skipped.entries()) {
      if (typeof k !== 'string' || !/^\d{4}-\d{2}$/.test(k)) {
        c.push(`${at}.skipped[${j}] must be YYYY-MM (got ${k})`);
      }
    }
  }
}

export function validateMeta(value) {
  const c = makeCollector();
  if (!isObj(value)) {
    c.push('meta must be an object');
    return c.result();
  }
  if (!isFiniteNumber(value.schemaVersion)) {
    c.push(`meta.schemaVersion must be a number (got ${typeof value.schemaVersion})`);
  }
  return c.result();
}

const BY_KEY = {
  envelopes: validateEnvelopes,
  accounts: validateAccounts,
  transactions: validateTransactions,
  budgetItems: validateBudgetItems,
  envelopeTemplates: validateEnvelopeTemplates,
  meta: validateMeta,
};

// Filename-keyed lookup so storage adapters can validate by on-disk
// file id without re-importing the FILE_* constants here.
const BY_FILENAME = {
  'envelopes.json': validateEnvelopes,
  'accounts.json': validateAccounts,
  'transactions.json': validateTransactions,
  'budget-items.json': validateBudgetItems,
  'envelope-templates.json': validateEnvelopeTemplates,
  'budget-meta.json': validateMeta,
};

export function validateCollection(key, value) {
  const fn = BY_KEY[key] || BY_FILENAME[key];
  if (!fn) return { ok: true, errors: [], truncated: false };
  return fn(value);
}

export function validateBundle(bundle) {
  const c = makeCollector();
  if (bundle?.meta?.financialHistory?.storage === 'history-chunks-v1') {
    c.push('Budget history is stored separately. Open the complete folder or import a self-contained export.');
  }
  if (!isObj(bundle)) {
    c.push('bundle must be an object');
    return c.result();
  }
  for (const key of Object.keys(BY_KEY)) {
    if (bundle[key] === undefined) {
      // envelopeTemplates is optional in older schemas; everything else is required.
      if (key === 'envelopeTemplates') continue;
      c.push(`${key} missing`);
      continue;
    }
    const r = BY_KEY[key](bundle[key]);
    for (const e of r.errors) c.push(e);
  }
  return c.result();
}

// assertCollection — used on the write path. Throws an Error with a
// `.validationErrors` array attached so callers can surface specifics.
export function assertCollection(key, value) {
  const r = validateCollection(key, value);
  if (r.ok) return;
  const sample = r.errors.slice(0, 5).join('; ');
  const more = r.truncated ? ' (more issues omitted)' : '';
  /** @type {Error & { validationErrors?: string[] }} */
  const err = new Error(`Invalid ${key} write: ${sample}${more}`);
  err.validationErrors = r.errors;
  throw err;
}
