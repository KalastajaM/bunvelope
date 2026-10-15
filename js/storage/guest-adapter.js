// js/storage/guest-adapter.js — in-memory "folder" for the guest / demo
// session. When the user clicks "Continue as guest" on the welcome screen
// we set state.budgetFolder to GUEST_FOLDER; storage/index.js detects the
// __guest flag on every call and routes reads/writes to the Map below
// instead of the real FSAPI/cloud adapter. On page reload the Map is gone.

import { assertCollection, CURRENT_SCHEMA_VERSION } from './validators.js';

export const FILE_ENVELOPES     = 'envelopes.json';
export const FILE_BUDGET_ITEMS  = 'budget-items.json';
export const FILE_TRANSACTIONS  = 'transactions.json';
export const FILE_ACCOUNTS      = 'accounts.json';
export const FILE_META          = 'budget-meta.json';
export const FILE_ENV_TEMPLATES = 'envelope-templates.json';

export { CURRENT_SCHEMA_VERSION };
export const adapterName = 'guest';

export const GUEST_FOLDER = Object.freeze({ __guest: true, name: 'Guest (demo)' });

export function isGuestFolder(handle) {
  return !!(handle && handle.__guest);
}

let memory = new Map();

export function resetGuestMemory() {
  memory.clear();
}

// Stage the entire replacement before dropping the current guest budget.
// Validation or cloning failures leave every old file available.
export function replaceGuestMemory(items) {
  const next = new Map();
  for (const { filename, data } of items) {
    assertCollection(filename, data);
    next.set(filename, clone(data));
  }
  memory = next;
}

function clone(value) {
  return value === undefined ? value : JSON.parse(JSON.stringify(value));
}

export async function fileExists(_handle, filename) {
  return memory.has(filename);
}

export async function readJson(_handle, filename) {
  if (!memory.has(filename)) return null;
  return clone(memory.get(filename));
}

// The save-path guard the other two adapters apply. Guest mode is a demo,
// but it is the mode a new user meets first, and its data can be exported and
// reopened as a real budget — so a write this rejects on disk must not be
// accepted here. Without it the same broken collection was refused in one
// mode and stored in another, which is the difference the storage contract
// suite exists to catch (tests/_fakes/storeContract.js).
export async function writeJson(_handle, filename, data) {
  assertCollection(filename, data);
  memory.set(filename, clone(data));
}

export async function writeBatch(_handle, items) {
  // Validate the whole batch before writing any of it: a batch that fails
  // half way through would leave the collections inconsistent with each
  // other, which is exactly what a batch is for avoiding.
  for (const { filename, data } of items) assertCollection(filename, data);
  for (const { filename, data } of items) {
    memory.set(filename, clone(data));
  }
}

export async function flushWrites() { /* writes are synchronous, nothing to drain */ }
export function hasPendingWrites() { return false; }

// Guest-only loader. The wizard writes a fresh, post-migration bundle into
// memory; we never need to run the v1→v6 migrations here, so we just read
// back what's there and force the current schema version on meta.
export async function loadBudgetData(_handle) {
  const [envelopes, budgetItems, transactions, accounts, meta, envelopeTemplates] = await Promise.all([
    readJson(_handle, FILE_ENVELOPES),
    readJson(_handle, FILE_BUDGET_ITEMS),
    readJson(_handle, FILE_TRANSACTIONS),
    readJson(_handle, FILE_ACCOUNTS),
    readJson(_handle, FILE_META),
    readJson(_handle, FILE_ENV_TEMPLATES),
  ]);
  const rawMeta = (meta && typeof meta === 'object') ? meta : {};
  return {
    envelopes:         Array.isArray(envelopes)         ? envelopes         : [],
    budgetItems:       Array.isArray(budgetItems)       ? budgetItems       : [],
    transactions:      Array.isArray(transactions)      ? transactions      : [],
    accounts:          Array.isArray(accounts)          ? accounts          : [],
    envelopeTemplates: Array.isArray(envelopeTemplates) ? envelopeTemplates : [],
    meta:              { ...rawMeta, schemaVersion: CURRENT_SCHEMA_VERSION },
  };
}

export async function saveEnvelopes(h, v)         { await writeJson(h, FILE_ENVELOPES, v); }
export async function saveBudgetItems(h, v)       { await writeJson(h, FILE_BUDGET_ITEMS, v); }
export async function saveTransactions(h, v)      { await writeJson(h, FILE_TRANSACTIONS, v); }
export async function saveAccounts(h, v)          { await writeJson(h, FILE_ACCOUNTS, v); }
export async function saveMeta(h, v)              { await writeJson(h, FILE_META, v); }
export async function saveEnvelopeTemplates(h, v) { await writeJson(h, FILE_ENV_TEMPLATES, v); }

// ── Example-budget date shift ──────────────────────────────────────────────
//
// The shipped example budget is a fixed snapshot, so it ages: months after it
// was recorded the demo opens on a current month with no spending, an Age of
// Money of "—" and a gap of materialised scheduled rows. Guest mode shifts
// the whole dataset by whole months on load so its latest real transaction
// lands in the current month. Whole months (not days) keep every row on the
// same day of the month and every month-keyed idempotency key (`from_budget`
// segments like `income-salary:2026-05`) in step with the row it belongs to;
// were the two to drift, the scheduler would re-post rows that exist.

const DATE_RE = /^(\d{4})-(\d{2})(?:-(\d{2}))?(T.*)?$/;

function daysInMonth(year, month1) {
  return new Date(Date.UTC(year, month1, 0)).getUTCDate();
}

/**
 * Shift an ISO date (`YYYY-MM-DD`, optionally with a `T…` time suffix) or a
 * month key (`YYYY-MM`) by `months`, clamping the day to the target month.
 * Anything else is returned unchanged.
 *
 * @param {string} value
 * @param {number} months
 * @returns {string}
 */
export function shiftIsoDate(value, months) {
  if (typeof value !== 'string' || !months) return value;
  const m = DATE_RE.exec(value);
  if (!m) return value;
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (month < 1 || month > 12) return value;
  if (m[4] && m[3] === undefined) return value; // "YYYY-MMT…" is not a date
  const idx = year * 12 + (month - 1) + months;
  const ny = Math.floor(idx / 12);
  const nm = idx - ny * 12 + 1;
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  let out = `${pad(ny, 4)}-${pad(nm)}`;
  if (m[3] !== undefined) {
    const day = Math.min(Number(m[3]), daysInMonth(ny, nm));
    out += `-${pad(day)}`;
  }
  return out + (m[4] || '');
}

/**
 * Whole months between the latest non-scheduled transaction's month and
 * `today`'s month (0 when there is nothing dated).
 *
 * @param {Array<{date?: string, status?: string}>} transactions
 * @param {Date} today
 * @returns {number}
 */
export function monthsToShift(transactions, today) {
  let latest = null;
  for (const tx of transactions || []) {
    if (!tx || tx.status === 'scheduled' || typeof tx.date !== 'string') continue;
    const m = DATE_RE.exec(tx.date);
    if (!m) continue;
    const key = Number(m[1]) * 12 + (Number(m[2]) - 1);
    if (latest === null || key > latest) latest = key;
  }
  if (latest === null) return 0;
  return today.getFullYear() * 12 + today.getMonth() - latest;
}

function shiftValue(value, months, key) {
  if (typeof value === 'string') {
    // Ids are opaque even when they happen to contain a date.
    if (key === 'id' || (typeof key === 'string' && key.endsWith('_id'))) return value;
    if (key === 'from_budget') {
      return value.split(':').map((part) => shiftIsoDate(part, months)).join(':');
    }
    return shiftIsoDate(value, months);
  }
  if (Array.isArray(value)) return value.map((v) => shiftValue(v, months, null));
  if (value && typeof value === 'object') {
    const out = {};
    // Seasonal amounts and annual bills must travel with their dated rows.
    // Leaving Jan..Dec fixed makes post-due recreate historical occurrences
    // in the wrong months after the example snapshot is shifted.
    const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const calendar = key === 'monthly_schedule' || key === 'months';
    for (const [k, v] of Object.entries(value)) {
      const index = calendar ? monthNames.indexOf(k) : -1;
      const shiftedKey = index < 0 ? shiftIsoDate(k, months) : monthNames[((index + months) % 12 + 12) % 12];
      out[shiftedKey] = shiftValue(v, months, k);
    }
    return out;
  }
  return value;
}

/**
 * Shift every date in a set of budget files by `months`. Pure: returns new
 * `{ filename, data }` entries and leaves the input untouched.
 *
 * @param {Array<{filename: string, data: any}>} files
 * @param {number} months
 * @returns {Array<{filename: string, data: any}>}
 */
export function shiftBudgetFiles(files, months) {
  if (!months) return files;
  return files.map(({ filename, data }) => ({ filename, data: shiftValue(data, months, null) }));
}
