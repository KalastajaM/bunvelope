import { packHistoryMeta, unpackHistoryMeta, chunkIds } from './history-chunks.js';
// ── HTTP API data layer ───────────────────────────────────────────────────
// Cloud-mode counterpart to fsapi-adapter.js. The `ref` passed to every
// function is a plain object `{ kind:'cloud', budgetId, version }`, created
// by the cloud budget picker. `version` is mutable — updated on every
// successful write so the next write sends the fresh value.
//
// Schema upgrades run on decrypted JSON in memory and publish through the
// normal encrypted, version-checked batch write.

import { migrateBundle } from './bundle-migrations.js';
import { validateSchema, createBundleBackup } from './fsapi-adapter.js';
import { encryptJson, decryptJson, isEncrypted } from './crypto.js';
import { assertCollection, CURRENT_SCHEMA_VERSION } from './validators.js';

export { CURRENT_SCHEMA_VERSION };
export { validateSchema };

// ── Encryption key (module-level, in-memory only) ────────────────────────
// When set, outgoing blobs are wrapped with AES-GCM before PUT and incoming
// blobs are unwrapped after GET. Cleared on logout. See js/storage/crypto.js.
const historyCaches = new WeakMap();
let encryptionKey = null;
let encryptionKeyId = null;

// Whether this account has encryption switched on. Tracked separately from the
// key because the dangerous state is "switched on, but no key loaded" — that is
// exactly when a write must NOT quietly fall back to plaintext.
let encryptionRequired = false;

export function setEncryptionKey(key, keyId = null) {
  encryptionKey = key || null;
  encryptionKeyId = key ? keyId : null;
}
export function hasEncryptionKey() { return !!encryptionKey; }

/**
 * Declare whether encryption is enabled for this account.
 *
 * Set from the server's config at sign-in. Disable conversion uses an explicit
 * per-batch override while ordinary saves remain encrypted until reload.
 */
export function setEncryptionRequired(required) { encryptionRequired = !!required; }
export function isEncryptionRequired() { return encryptionRequired; }

async function maybeEncrypt(data, key = encryptionKey, required = encryptionRequired, keyId = encryptionKeyId) {
  if (!key) {
    // Fail closed. Returning `data` here writes the user's budget to the
    // server in the clear, silently, for an account that believes it is
    // encrypted — a privacy failure with no symptom.
    if (required) {
      throw new Error(
        'Encryption is enabled for this account but no key is loaded — '
        + 'refusing to write an unencrypted blob.',
      );
    }
    return data;
  }
  const wrapped = await encryptJson(key, data);
  if (keyId) wrapped.kid = keyId;
  return wrapped;
}

async function maybeDecrypt(value) {
  if (!isEncrypted(value)) return value;
  if (!encryptionKey) {
    throw new Error(
      'Encrypted blob received but no key is set — unlock with your passphrase first.',
    );
  }
  return decryptJson(encryptionKey, value);
}

export const adapterName = 'api';

// Same logical filename mapping the FSAPI code uses, for writeBatch() which
// callers still invoke with `{ filename, data }` tuples.
const FILENAME_TO_KIND = {
  'envelopes.json':          'envelopes',
  'budget-items.json':       'budgetItems',
  'transactions.json':       'transactions',
  'accounts.json':           'accounts',
  'envelope-templates.json': 'envelopeTemplates',
  'budget-meta.json':        'meta',
};

export const FILE_ENVELOPES     = 'envelopes.json';
export const FILE_BUDGET_ITEMS  = 'budget-items.json';
export const FILE_TRANSACTIONS  = 'transactions.json';
export const FILE_ACCOUNTS      = 'accounts.json';
export const FILE_META          = 'budget-meta.json';
export const FILE_ENV_TEMPLATES = 'envelope-templates.json';

function assertCloudRef(ref) {
  if (!ref || ref.kind !== 'cloud' || !ref.budgetId) {
    throw new Error('api adapter called without a cloud budget ref');
  }
}

async function apiFetch(path, options = {}) {
  const res = await fetch(path, {
    credentials: 'same-origin',
    headers: { 'accept': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  const text = await res.text();
  const body = text ? safeJson(text) : null;
  if (!res.ok) {
    const err = new Error(
      (body && body.error) || `${res.status} ${res.statusText}`
    );
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

function safeJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

// ── Public exports ────────────────────────────────────────────────────────

export async function openBudgetFolder() {
  throw new Error('openBudgetFolder is unavailable in cloud mode');
}

// In cloud mode we don't probe per-file existence — we fetch the whole
// bundle. For the single caller that checks 'budget-meta.json' (to decide
// setup-wizard vs regular-load) we fetch once, cache on the ref, and look
// at meta presence. The cache is consumed on the very next loadBudgetData
// call so there is never a second round-trip in the happy path.
export async function fileExists(ref, filename) {
  assertCloudRef(ref);
  if (filename !== FILE_META) {
    // Other filenames are effectively always "present" server-side — we
    // seed defaults for missing blobs. Return true so callers that guard
    // on existence don't trigger wizard flows.
    return true;
  }
  const bundle = await fetchBundle(ref);
  return Boolean(bundle.meta && typeof bundle.meta === 'object');
}

async function fetchBundle(ref) {
  if (ref.__cache) return ref.__cache;
  const body = await apiFetch(`/api/budgets/${encodeURIComponent(ref.budgetId)}`, { headers: { 'x-bunvelope-history': 'chunks' } });
  ref.version = body.version;
  // Preserve a null meta — a fresh cloud budget has no meta blob yet, and
  // the setup wizard relies on fileExists('budget-meta.json') returning
  // false to run.
  // Decrypt the six blobs concurrently — they're independent, and doing
  // them in sequence serialised six AES-GCM passes (the transactions blob
  // dominates). Mirrors the Promise.all already used on the write path.
  const [envelopes, budgetItems, transactions, accounts, envelopeTemplates, meta] =
    await Promise.all([
      maybeDecrypt(body.envelopes         ?? []),
      maybeDecrypt(body.budgetItems       ?? []),
      maybeDecrypt(body.transactions      ?? []),
      maybeDecrypt(body.accounts          ?? []),
      maybeDecrypt(body.envelopeTemplates ?? []),
      maybeDecrypt(body.meta              ?? null),
    ]);
  const chunks = body.meta?.historyChunks || body.meta?.__historyChunks || [];
  const byId = new Map(chunks.map(c => [c.id, c.data]));
  const { __historyChunks: _chunks, ...cleanMeta } = meta || {};
  const loaded = await unpackHistoryMeta(meta == null ? null : cleanMeta, id => byId.get(id), maybeDecrypt);
  historyCaches.set(ref, { cache: loaded.cache, key: encryptionKey });
  const bundle = { envelopes, budgetItems, transactions, accounts, envelopeTemplates, meta: loaded.meta };
  ref.__cache = bundle;
  return bundle;
}

/**
 * The six collections of a cloud budget, decrypted, as stored: no schema
 * gate, no validation and no invented meta (a fresh budget's meta stays
 * null). Throws when a blob is encrypted and no key is loaded, so callers can
 * never hand ciphertext wrappers to the user as if they were data.
 */
export async function readDecryptedBundle(budgetId) {
  const bundle = await fetchBundle({ kind: 'cloud', budgetId, version: 0 });
  return { ...bundle };
}

export async function readJson(ref, filename) {
  assertCloudRef(ref);
  const bundle = await fetchBundle(ref);
  const kind = FILENAME_TO_KIND[filename];
  if (!kind) return null;
  const v = bundle[kind];
  if (kind === 'meta') return v && typeof v === 'object' ? v : null;
  return Array.isArray(v) ? v : null;
}

export async function writeJson(ref, filename, data) {
  assertCloudRef(ref);
  const kind = FILENAME_TO_KIND[filename];
  if (!kind) throw new Error(`unsupported filename: ${filename}`);
  // Pre-flight schema check; throws on malformed in-memory state before
  // we hit the network.
  assertCollection(kind, data);
  return putCollection(ref, kind, data);
}

async function putCollection(ref, kind, data) {
  assertCloudRef(ref);
  assertCollection(kind, data);
  if (kind === 'meta') return writeBatch(ref, [{ filename: FILE_META, data }]);
  const snapshot = structuredClone(data);
  const key = encryptionKey;
  const required = encryptionRequired;
  const keyId = encryptionKeyId;
  return enqueueWrite(ref, async () => {
    const payload = await maybeEncrypt(snapshot, key, required, keyId);
    try {
      const body = await apiFetch(
        `/api/budgets/${encodeURIComponent(ref.budgetId)}/collections/${kind}`,
        {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ version: ref.version, data: payload }),
        },
      );
      ref.version = body.version;
      // Invalidate the cached bundle — next loadBudgetData re-reads.
      ref.__cache = null;
    } catch (err) {
      // Drop the cache so the next read pulls authoritative state from the
      // server (version conflicts in particular leave us with a stale version).
      ref.__cache = null;
      throw err;
    }
  });
}

// Reserve order before asynchronous preparation. Different refs share a queue,
// but retain their own optimistic versions: a stale loaded snapshot must conflict.
const writeQueues = new Map();
const pendingWrites = new Set();
let writeFailure = null;
function enqueueWrite(ref, task, recordFailure = true) {
  const id = ref.budgetId;
  const chain = (writeQueues.get(id) || Promise.resolve()).catch(() => {}).then(task);
  writeQueues.set(id, chain);
  const tracked = recordFailure ? chain : chain.catch(() => {});
  pendingWrites.add(tracked);
  const cleanup = () => {
    pendingWrites.delete(tracked);
    if (writeQueues.get(id) === chain) writeQueues.delete(id);
  };
  chain.then(cleanup, err => { if (recordFailure) writeFailure = err; cleanup(); });
  return chain;
}

/** True while any write is queued or in flight (see js/state/unload-guard.js). */
export function hasPendingWrites() {
  return pendingWrites.size > 0;
}

export async function flushWrites() {
  // Track each write, not just queue tails whose continuation catches failures.
  // Drain other budgets even when one fails; callers may switch keys afterward.
  let failure = writeFailure;
  while (pendingWrites.size) {
    const results = await Promise.allSettled([...pendingWrites]);
    failure ||= results.find(result => result.status === 'rejected')?.reason;
  }
  failure ||= writeFailure;
  writeFailure = null;
  if (failure) throw failure;
}

export async function writeBatch(ref, items, encryption = null) {
  assertCloudRef(ref);
  for (const { filename, data } of items) {
    const kind = FILENAME_TO_KIND[filename];
    if (!kind) throw new Error(`writeBatch: unsupported filename ${filename}`);
    assertCollection(kind, data);
  }
  const snapshot = structuredClone(items);
  const key = encryption ? encryption.key : encryptionKey;
  const required = encryption ? encryption.required : encryptionRequired;
  const keyId = encryptionKeyId;
  return enqueueWrite(ref, async () => {
    let historyCache;
    const mapped = await Promise.all(snapshot.map(async ({ filename, data }) => {
      const kind = FILENAME_TO_KIND[filename];
      if (kind !== 'meta') return { kind, data: await maybeEncrypt(data, key, required, keyId) };
      const previous = historyCaches.get(ref);
      const packed = await packHistoryMeta(data, previous?.key === key ? previous.cache : null,
        value => maybeEncrypt(value, key, required, keyId));
      historyCache = { cache: packed.cache, key };
      const payload = await maybeEncrypt(packed.meta, key, required, keyId);
      if (key && packed.cache) payload.historyIds = chunkIds(packed.meta.financialHistory);
      return { kind, data: payload, ...(packed.chunks.length ? { historyChunks: packed.chunks } : {}) };
    }));
    try {
      const body = await apiFetch(
        `/api/budgets/${encodeURIComponent(ref.budgetId)}/batch`,
        {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ version: ref.version, items: mapped, decrypting: !!encryption && !key }),
        },
      );
      ref.version = body.version;
      if (historyCache) historyCaches.set(ref, historyCache);
      ref.__cache = null;
    } catch (err) {
      ref.__cache = null;
      throw err;
    }
  });
}

export async function loadBudgetData(ref) {
  assertCloudRef(ref);
  const bundle = await fetchBundle(ref);

  const rawMeta = bundle.meta && typeof bundle.meta === 'object' ? bundle.meta : null;

  // Fresh, empty cloud budget — just-created, no meta yet → caller will
  // run the setup wizard, which writes meta via saveMeta().
  if (rawMeta == null
      && bundle.envelopeTemplates.length === 0
      && bundle.envelopes.length === 0
      && bundle.budgetItems.length === 0
      && bundle.transactions.length === 0
      && bundle.accounts.length === 0) {
    return {
      envelopes: [], budgetItems: [], transactions: [],
      accounts: [], envelopeTemplates: [],
      meta: { schemaVersion: CURRENT_SCHEMA_VERSION },
    };
  }

  const { bundle: out, changed } = migrateBundle(bundle);
  const check = validateSchema(out);
  if (!check.ok) {
    const msg = check.errors.slice(0, 10).join('\n  • ');
    const err = new Error(
      `Budget data failed validation.\n\n  • ${msg}\n\n` +
      `Contact support — the cloud copy may be corrupted.`
    );
    err.validationErrors = check.errors;
    throw err;
  }
  if (changed.length) {
    await writeBatch(ref, changed.map(kind => ({
      filename: Object.keys(FILENAME_TO_KIND).find(f => FILENAME_TO_KIND[f] === kind), data: out[kind],
    })));
  }
  return out;
}

export async function saveTransactions(ref, transactions) {
  await putCollection(ref, 'transactions', transactions);
}
export async function saveAccounts(ref, accounts) {
  await putCollection(ref, 'accounts', accounts);
}
export async function saveEnvelopes(ref, envelopes) {
  await putCollection(ref, 'envelopes', envelopes);
}
export async function saveBudgetItems(ref, items) {
  await putCollection(ref, 'budgetItems', items);
}
export async function saveEnvelopeTemplates(ref, templates) {
  await putCollection(ref, 'envelopeTemplates', templates);
}
export async function saveMeta(ref, meta) {
  await putCollection(ref, 'meta', meta);
}

// ── Cloud-only helpers (used by cloud budget picker, auth screen) ──

export async function listCloudBudgets() {
  return apiFetch('/api/budgets');
}

export async function createCloudBudget(name) {
  return apiFetch('/api/budgets', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  });
}

export async function renameCloudBudget(id, name) {
  return apiFetch(`/api/budgets/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  });
}

export async function deleteCloudBudget(id) {
  return apiFetch(`/api/budgets/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export async function getEncryptionConfig() {
  return apiFetch('/api/user/encryption');
}

export async function putEncryptionConfig(cfg, expected) {
  return apiFetch('/api/user/encryption', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...cfg, expected }),
  });
}

/** The signed-in user's display preferences: `{ prefs: {...} }`. */
export async function getUserPrefs() {
  return apiFetch('/api/user/prefs');
}

/** Merge a partial prefs object into the user's; a null value removes a key. */
export async function patchUserPrefs(patch) {
  return apiFetch('/api/user/prefs', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prefs: patch }),
  });
}

export async function getCurrentUser() {
  try { return await apiFetch('/api/me'); }
  catch (err) {
    if (err.status === 401) return null;
    throw err;
  }
}

export async function logout() {
  return apiFetch('/auth/logout', { method: 'POST' });
}

/** Read after queued saves, without changing the active ref's optimistic version.
 * Holding the API queue through the disk copy also keeps the unload guard active.
 */
export function createAutomaticBackup(ref, destination, metadata) {
  assertCloudRef(ref);
  return enqueueWrite(ref, async () => {
    const bundle = await readDecryptedBundle(ref.budgetId);
    return createBundleBackup(bundle, destination, metadata);
  }, false);
}
