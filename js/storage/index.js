// ── Storage adapter facade ────────────────────────────────────────────────
// Picks the cloud (HTTP) or local (FSAPI) base adapter once at module load
// based on `window.__BUNVELOPE_MODE`. The server injects
// `window.__BUNVELOPE_MODE = { kind: 'cloud' }` into index.html; when absent
// we default to FSAPI so static/local dev keeps working unchanged.
//
// On top of the base adapter we layer the in-memory "guest" adapter: if the
// folder handle passed to any per-handle function has `__guest === true`
// we dispatch to guest-adapter.js instead. This keeps guest mode a
// data-layer concern — page code continues to call saveEnvelopes/etc
// against state.budgetFolder without caring about the mode.

import * as guest from './guest-adapter.js';

const mode = (typeof window !== 'undefined' && window.__BUNVELOPE_MODE) || null;
const isCloud = mode?.kind === 'cloud';

const baseAdapter = await (isCloud
  ? import('./api-adapter.js')
  : import('./fsapi-adapter.js'));

function route(handle) {
  return guest.isGuestFolder(handle) ? guest : baseAdapter;
}

export const adapterName = baseAdapter.adapterName;
export const CURRENT_SCHEMA_VERSION = baseAdapter.CURRENT_SCHEMA_VERSION;

export const FILE_ENVELOPES     = baseAdapter.FILE_ENVELOPES;
export const FILE_BUDGET_ITEMS  = baseAdapter.FILE_BUDGET_ITEMS;
export const FILE_TRANSACTIONS  = baseAdapter.FILE_TRANSACTIONS;
export const FILE_ACCOUNTS      = baseAdapter.FILE_ACCOUNTS;
export const FILE_META          = baseAdapter.FILE_META;
export const FILE_ENV_TEMPLATES = baseAdapter.FILE_ENV_TEMPLATES;

export const validateSchema   = baseAdapter.validateSchema;
export const openBudgetFolder = baseAdapter.openBudgetFolder;

export const fileExists            = (h, f)      => route(h).fileExists(h, f);
export const readJson              = (h, f)      => route(h).readJson(h, f);
export const writeJson             = (h, f, d)   => route(h).writeJson(h, f, d);
export const writeBatch            = (h, items)  => route(h).writeBatch(h, items);
export const loadBudgetData        = (h)         => route(h).loadBudgetData(h);
export const saveTransactions      = (h, v)      => route(h).saveTransactions(h, v);
export const saveAccounts          = (h, v)      => route(h).saveAccounts(h, v);
export const saveEnvelopes         = (h, v)      => route(h).saveEnvelopes(h, v);
export const saveBudgetItems       = (h, v)      => route(h).saveBudgetItems(h, v);
export const saveEnvelopeTemplates = (h, v)      => route(h).saveEnvelopeTemplates(h, v);
export const saveMeta              = (h, v)      => route(h).saveMeta(h, v);

export function flushWrites() { return baseAdapter.flushWrites(); }
/** A write the page would lose if it closed now; see js/state/unload-guard.js. */
let restorePending = 0;
export function hasPendingWrites() { return restorePending > 0 || (baseAdapter.hasPendingWrites?.() ?? false); }

export function isCloudMode() { return isCloud; }
export function getMode() { return mode; }

export { GUEST_FOLDER, isGuestFolder, resetGuestMemory } from './guest-adapter.js';

export async function restoreMigrationBackup(backup, destination) {
  restorePending++;
  try {
    const local = isCloud ? await import('./fsapi-adapter.js') : baseAdapter;
    return await local.restoreMigrationBackup(backup, destination);
  } finally { restorePending--; }
}

export function createAutomaticBackup(source, destination, metadata) {
  if (guest.isGuestFolder(source)) throw new Error('Automatic backups require a saved budget');
  return baseAdapter.createAutomaticBackup(source, destination, metadata);
}
