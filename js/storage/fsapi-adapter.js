// ── File System Access API data layer ─────────────────────────────────────
// Verbatim port of the original js/data.js body. The public exports are the
// adapter surface consumed via js/storage/index.js.

import { packHistoryMeta, unpackHistoryMeta, chunkIds } from './history-chunks.js';
import { migrateBundle } from './bundle-migrations.js';
import { assertCollection, validateBundle, CURRENT_SCHEMA_VERSION } from './validators.js';

export const FILE_ENVELOPES     = 'envelopes.json';
export const FILE_BUDGET_ITEMS  = 'budget-items.json';
export const FILE_TRANSACTIONS  = 'transactions.json';
export const FILE_ACCOUNTS      = 'accounts.json';
export const FILE_META          = 'budget-meta.json';
export const FILE_ENV_TEMPLATES = 'envelope-templates.json';
export const FILE_PUBLISH_JOURNAL = '.bunvelope-publish.json';
const historyCaches = new WeakMap();
const historyFilename = id => `.bunvelope-history-${id}.json`;
async function hydrateMeta(folder, meta) {
  const loaded = await unpackHistoryMeta(meta, id => readRawJson(folder, historyFilename(id)));
  historyCaches.set(folder, loaded.cache);
  return loaded.meta;
}
const BUDGET_FILES = [FILE_ENVELOPES, FILE_BUDGET_ITEMS, FILE_TRANSACTIONS,
  FILE_ACCOUNTS, FILE_ENV_TEMPLATES, FILE_META];


/**
 * Prompt the user to select a budget folder.
 * @returns {Promise<FileSystemDirectoryHandle>}
 */
export async function openBudgetFolder() {
  if (!('showDirectoryPicker' in window)) {
    throw new Error('File System Access API is not supported in this browser. Use Chrome or Edge.');
  }
  return await window.showDirectoryPicker({ mode: 'readwrite' });
}

/**
 * Check if a file exists in the folder.
 * @param {FileSystemDirectoryHandle} folderHandle
 * @param {string} filename
 * @returns {Promise<boolean>}
 */
export async function fileExists(folderHandle, filename) {
  try {
    await folderHandle.getFileHandle(filename);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read and parse a JSON file from the budget folder.
 * Returns null if the file does not exist.
 */
async function readRawJson(folderHandle, filename, allowEmptyCreation = false) {
  try {
    const fileHandle = await folderHandle.getFileHandle(filename);
    const file = await fileHandle.getFile();
    const text = await file.text();
    if (allowEmptyCreation && text === '') return null;
    return JSON.parse(text);
  } catch (err) {
    if (err.name === 'NotFoundError') return null;
    throw err;
  }
}

async function ensureWritePermission(folderHandle) {
  if (!folderHandle || typeof folderHandle.queryPermission !== 'function') return;
  const opts = { mode: 'readwrite' };
  const state = await folderHandle.queryPermission(opts);
  if (state === 'granted') return;
  const requested = await folderHandle.requestPermission(opts);
  if (requested !== 'granted') {
    throw new Error('Write permission to the budget folder was denied. Click Save again to re-authorize.');
  }
}

let _globalWriteChain = Promise.resolve();
let _pendingWrites = 0;

function enqueueWrite(task) {
  const next = _globalWriteChain.catch(() => {}).then(task);
  _globalWriteChain = next;
  _pendingWrites++;
  const done = () => { _pendingWrites--; };
  next.then(done, done);
  return next;
}

/** True while any write is queued or in flight (see js/state/unload-guard.js). */
export function hasPendingWrites() {
  return _pendingWrites > 0;
}

async function doWrite(folderHandle, filename, data) {
  return doWriteText(folderHandle, filename, JSON.stringify(data));
}

async function doWriteText(folderHandle, filename, text) {
  try {
    const fileHandle = await folderHandle.getFileHandle(filename, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(text);
    await writable.close();
  } catch (err) {
    // Tag the failure so batch callers can name the file without tracking it.
    err.bvFilename = filename;
    throw err;
  }
}

// ── Cross-writer concurrency guard ────────────────────────────────────────
// Every write here truncates and rewrites a whole collection, so two writers
// on one folder (two tabs, or the web app and the Budget project's scripts)
// silently clobber each other's entire ledger. `_globalWriteChain` above is a
// module-level promise: it serialises writes inside ONE JavaScript realm and
// does nothing across realms.
//
// budget-meta.json already carries a monotonic `write_seq` (the Budget
// project maintains it). We record the value we loaded, re-read it inside the
// critical section immediately before publishing, and refuse the write when it
// moved. That converts silent total data loss into a named error.
//
// `navigator.locks` narrows the window further: it is a real cross-tab mutex,
// so two tabs in one browser profile cannot interleave the read-compare-write
// at all. It does NOT close the hole against a foreign process — the File
// System Access API offers no atomic compare-and-swap — so the sequence check
// is the load-bearing half and the lock is the optimisation.

/** write_seq observed at load time, per folder handle. */
const _loadedSeqByFolder = new WeakMap();

/** Identifies this realm in `budget-meta.json.last_writer`. */
const WRITER_ID = `bunvelope-web-${Math.random().toString(36).slice(2, 10)}`;

export class StaleBudgetError extends Error {
  constructor(expected, found) {
    super(
      'This budget was changed by another window or program since it was ' +
      'loaded here. Nothing was saved — reload the budget before saving, or ' +
      'your changes and theirs will overwrite each other. ' +
      `(expected write_seq ${expected}, found ${found})`
    );
    this.name = 'StaleBudgetError';
    this.expectedSeq = expected;
    this.foundSeq = found;
  }
}

function seqOf(meta) {
  return meta && typeof meta.write_seq === 'number' && isFinite(meta.write_seq)
    ? meta.write_seq
    : 0;
}

/**
 * Record the `write_seq` this session loaded. Called from `loadBudgetData`.
 * A folder with no recorded seq has no stale-load comparison, but standard
 * budget files still use durable journal publication, including fresh folders.
 */
export function rememberLoadedSeq(folderHandle, meta) {
  if (!folderHandle) return;
  _loadedSeqByFolder.set(folderHandle, seqOf(meta));
}

export function loadedSeq(folderHandle) {
  return folderHandle ? _loadedSeqByFolder.get(folderHandle) : undefined;
}

export function forgetLoadedSeq(folderHandle) {
  if (folderHandle) _loadedSeqByFolder.delete(folderHandle);
}

async function withFolderLock(folderHandle, task) {
  const locks = globalThis.navigator?.locks;
  if (!locks || typeof locks.request !== 'function') return task();
  return locks.request(`bunvelope:budget:${folderHandle?.name || 'default'}`, task);
}

/** A pending publication must be recovered, never silently overwritten. */
export class BudgetRecoveryError extends Error {
  constructor(detail) {
    super(`Budget publication recovery stopped: ${detail}. Preserve the folder and its recovery journal before resolving the conflict.`);
    this.name = 'BudgetRecoveryError';
  }
}

const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);

async function readSnapshot(folderHandle, journal = null) {
  const values = await Promise.all(BUDGET_FILES.map(name => readRawJson(folderHandle, name,
    // FSAPI creates an empty destination before the first writable closes.
    // Only a validated journal proving this file was missing permits this.
    journal !== null && journal.before[name] === null && journal.after[name] !== null,
  )));
  return Object.fromEntries(BUDGET_FILES.map((name, i) => [name, values[i]]));
}

/** Raw file text, or null when the file does not exist. */
async function readRawText(folderHandle, filename) {
  try {
    const fileHandle = await folderHandle.getFileHandle(filename);
    const file = await fileHandle.getFile();
    return await file.text();
  } catch (err) {
    if (err.name === 'NotFoundError') return null;
    throw err;
  }
}

async function readTexts(folderHandle) {
  const texts = await Promise.all(BUDGET_FILES.map(name => readRawText(folderHandle, name)));
  return Object.fromEntries(BUDGET_FILES.map((name, i) => [name, texts[i]]));
}

const FINGERPRINT_RE = /^sha256:[0-9a-f]{64}$/;

/** SHA-256 of a file's exact text; null for a missing file. */
async function fingerprint(text) {
  if (text === null) return null;
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return `sha256:${Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('')}`;
}

function assertJournalValue(name, value) {
  // Older schema snapshots remain recoverable before migrations run.
  if (value !== null && (name === FILE_META
    ? typeof value !== 'object' || Array.isArray(value)
    : !Array.isArray(value))) {
    throw new BudgetRecoveryError(`invalid recovery journal collection ${name}`);
  }
}

/** Version 1 (older builds): complete before and after snapshots. */
function validateJournalV1(journal) {
  if (!journal.before || !journal.after) throw new BudgetRecoveryError('invalid recovery journal');
  for (const snapshot of [journal.before, journal.after]) {
    if (Object.keys(snapshot).length !== BUDGET_FILES.length ||
        !BUDGET_FILES.every(name => Object.hasOwn(snapshot, name))) {
      throw new BudgetRecoveryError('invalid recovery journal filenames');
    }
    for (const name of BUDGET_FILES) assertJournalValue(name, snapshot[name]);
  }
  if (!journal.after[FILE_META] ||
      seqOf(journal.after[FILE_META]) !== seqOf(journal.before[FILE_META]) + 1) {
    throw new BudgetRecoveryError('invalid recovery journal sequence');
  }
}

/**
 * Version 2: `before` fingerprints all six files, `after` holds the complete
 * intended content of the changed collections plus meta, `before_seq` is the
 * write_seq the publication started from.
 */
function validateJournalV2(journal) {
  const { before, after } = journal;
  if (!before || typeof before !== 'object' || !after || typeof after !== 'object' ||
      Array.isArray(before) || Array.isArray(after)) {
    throw new BudgetRecoveryError('invalid recovery journal');
  }
  if (Object.keys(before).length !== BUDGET_FILES.length ||
      !BUDGET_FILES.every(name => Object.hasOwn(before, name)) ||
      !Object.keys(after).every(name => BUDGET_FILES.includes(name))) {
    throw new BudgetRecoveryError('invalid recovery journal filenames');
  }
  for (const name of BUDGET_FILES) {
    const fp = before[name];
    if (fp !== null && (typeof fp !== 'string' || !FINGERPRINT_RE.test(fp))) {
      throw new BudgetRecoveryError(`invalid recovery journal fingerprint ${name}`);
    }
  }
  for (const [name, value] of Object.entries(after)) {
    if (value === null) throw new BudgetRecoveryError(`invalid recovery journal collection ${name}`);
    assertJournalValue(name, value);
  }
  if (!after[FILE_META] || typeof journal.before_seq !== 'number' || !isFinite(journal.before_seq) ||
      seqOf(after[FILE_META]) !== journal.before_seq + 1) {
    throw new BudgetRecoveryError('invalid recovery journal sequence');
  }
}

async function recoverJournalV1(folderHandle, journal) {
  validateJournalV1(journal);
  const current = await readSnapshot(folderHandle, journal);
  // Validate ALL files before the first recovery write, including collections
  // this publication did not change. A foreign writer may not bump write_seq.
  for (const name of BUDGET_FILES) {
    if (!sameJson(current[name], journal.before[name]) && !sameJson(current[name], journal.after[name])) {
      throw new BudgetRecoveryError(`${name} was changed outside this publication`);
    }
  }
  await ensureWritePermission(folderHandle);
  for (const name of BUDGET_FILES) {
    if (!sameJson(current[name], journal.after[name])) {
      await doWrite(folderHandle, name, journal.after[name]);
    }
  }
}

function textMatches(text, value) {
  if (text === null || text === '') return false;
  try { return sameJson(JSON.parse(text), value); } catch { return false; }
}

async function recoverJournalV2(folderHandle, journal) {
  validateJournalV2(journal);
  const texts = await readTexts(folderHandle);
  const pending = [];
  // Validate ALL files before the first recovery write. An unchanged
  // collection must still carry its fingerprinted content: a foreign writer
  // may not bump write_seq.
  for (const name of BUDGET_FILES) {
    const text = texts[name];
    const changed = Object.hasOwn(journal.after, name);
    if (changed && textMatches(text, journal.after[name])) continue;
    const atBefore = await fingerprint(text) === journal.before[name]
      // FSAPI creates an empty destination before the first writable closes;
      // only a journal proving this file was missing and was being written
      // permits reading that as "still missing".
      || (changed && text === '' && journal.before[name] === null);
    if (!atBefore) throw new BudgetRecoveryError(`${name} was changed outside this publication`);
    if (changed) pending.push(name);
  }
  if (pending.length === 0) return;
  await ensureWritePermission(folderHandle);
  // Collections first in journal order; metadata closes last.
  for (const name of Object.keys(journal.after)) {
    if (name !== FILE_META && pending.includes(name)) await doWrite(folderHandle, name, journal.after[name]);
  }
  if (pending.includes(FILE_META)) await doWrite(folderHandle, FILE_META, journal.after[FILE_META]);
}

async function recoverPublish(folderHandle) {
  let text;
  try {
    text = await readRawText(folderHandle, FILE_PUBLISH_JOURNAL);
  } catch (err) {
    throw new BudgetRecoveryError(`cannot read recovery journal (${err.message})`);
  }
  if (text === null) return;
  if (text === '') {
    // Zero bytes means the journal's first close never completed: FSAPI
    // creates the file empty and only replaces it when a writable closes. The
    // publisher writes no budget file until that close succeeds, so nothing
    // was published and the folder is idle. Refusing here locked the folder
    // for good. Clearing is best effort; an empty journal stays idle anyway.
    try { await doWrite(folderHandle, FILE_PUBLISH_JOURNAL, null); } catch { /* retried next time */ }
    return;
  }
  let journal;
  try {
    journal = JSON.parse(text);
  } catch (err) {
    throw new BudgetRecoveryError(`cannot read recovery journal (${err.message})`);
  }
  if (journal === null) return;
  if (typeof journal !== 'object' || Array.isArray(journal)) {
    throw new BudgetRecoveryError('invalid recovery journal');
  }
  if (journal.version === 1) await recoverJournalV1(folderHandle, journal);
  else if (journal.version === 2) await recoverJournalV2(folderHandle, journal);
  else throw new BudgetRecoveryError('invalid recovery journal');
  // Null is an idle journal. Failure to clear is harmless: all files already
  // equal the intended generation, and the next recovery retries this close.
  await doWrite(folderHandle, FILE_PUBLISH_JOURNAL, null);
}

/** Standard file reads also recover; internal operations use readRawJson. */
export async function readJson(folderHandle, filename) {
  if (!BUDGET_FILES.includes(filename)) return readRawJson(folderHandle, filename);
  return enqueueWrite(() => withFolderLock(folderHandle, async () => {
    await recoverPublish(folderHandle);
    const value = await readRawJson(folderHandle, filename);
    return filename === FILE_META ? hydrateMeta(folderHandle, value) : value;
  }));
}

/**
 * Journal the publication before changing any of the six files.
 *
 * The journal holds the intended content of the collections this save
 * changes (to roll forward) and a SHA-256 fingerprint of every one of the six
 * files as they were (to prove, before recovering, that nothing else touched
 * the folder). Copying every collection twice cost ~5 MB of journal and a
 * whole-budget deep clone per edit at 20k transactions.
 */
async function publish(folderHandle, items) {
  await recoverPublish(folderHandle);
  if (items.some(item => item.filename === FILE_PUBLISH_JOURNAL)) {
    throw new Error('The recovery journal is reserved for budget publication');
  }
  if (!items.some(item => BUDGET_FILES.includes(item.filename))) {
    for (const { filename, data } of items) await doWrite(folderHandle, filename, data);
    return;
  }
  if (items.some(item => !BUDGET_FILES.includes(item.filename)) ||
      new Set(items.map(item => item.filename)).size !== items.length) {
    throw new Error('Budget publications require unique standard budget filenames');
  }
  const expected = _loadedSeqByFolder.get(folderHandle);
  const texts = await readTexts(folderHandle);
  const onDisk = texts[FILE_META] === null ? null : JSON.parse(texts[FILE_META]);
  const found = seqOf(onDisk);
  if (expected !== undefined && found !== expected) throw new StaleBudgetError(expected, found);
  const metaItem = items.find(i => i.filename === FILE_META);
  const baseMeta = metaItem ? metaItem.data : (onDisk || {});
  const packed = metaItem ? await packHistoryMeta(baseMeta, historyCaches.get(folderHandle)) : { meta: baseMeta, chunks: [], cache: historyCaches.get(folderHandle) };
  for (const chunk of packed.chunks) await doWrite(folderHandle, historyFilename(chunk.id), chunk.data);
  const stamped = {
    ...(packed.meta && typeof packed.meta === 'object' ? packed.meta : {}),
    write_seq: found + 1,
    last_writer: WRITER_ID,
    last_modified: new Date().toISOString(),
  };
  // writeJson/writeBatch already cloned the items, so no caller can mutate
  // them now. Serialize each once: the same text goes into the journal and
  // into the file, so the journaled generation is exactly what is written.
  const order = [...items.map(i => i.filename).filter(name => name !== FILE_META), FILE_META];
  const afterText = Object.fromEntries(items
    .filter(i => i.filename !== FILE_META)
    .map(i => [i.filename, JSON.stringify(i.data)]));
  afterText[FILE_META] = JSON.stringify(stamped);
  const before = Object.fromEntries(await Promise.all(
    BUDGET_FILES.map(async name => [name, await fingerprint(texts[name])])));
  const journalText = `{"version":2,"before":${JSON.stringify(before)},"before_seq":${found},` +
    `"after":{${order.map(name => `${JSON.stringify(name)}:${afterText[name]}`).join(',')}}}`;
  await doWriteText(folderHandle, FILE_PUBLISH_JOURNAL, journalText);
  // Keep requested collection ordering; metadata is always the commit marker.
  for (const name of order) await doWriteText(folderHandle, name, afterText[name]);
  await doWrite(folderHandle, FILE_PUBLISH_JOURNAL, null);
  if (metaItem) metaItem.data = { ...baseMeta, write_seq: stamped.write_seq, last_writer: stamped.last_writer, last_modified: stamped.last_modified };
  historyCaches.set(folderHandle, packed.cache);
  _loadedSeqByFolder.set(folderHandle, found + 1);
  // All snapshots are self-contained and the recovery journal is now idle.
  // A failed close may have left unreferenced chunks; cleanup is best effort
  // and can never turn a successfully committed save into a reported failure.
  if (metaItem && folderHandle.removeEntry && folderHandle.values) {
    const keep = new Set(chunkIds(stamped.financialHistory).map(historyFilename));
    try {
      for await (const entry of folderHandle.values()) {
        const name = typeof entry === 'string' ? entry : entry.name;
        if (/^\.bunvelope-history-[a-f0-9]{64}\.json$/.test(name) && !keep.has(name)) {
          try { await folderHandle.removeEntry(name); } catch { /* Retry on a later save. */ }
        }
      }
    } catch { /* A directory scan is not part of the commit. */ }
  }
}

export function flushWrites() {
  return _globalWriteChain.catch(() => {});
}

/**
 * Start the permission check now, while any user activation is still live,
 * but settle it inside the queued task. Awaiting it before enqueueing let a
 * later call overtake an earlier one whose permission query resolved slower,
 * so an older whole-collection snapshot could land last.
 */
function startPermissionCheck(folderHandle) {
  const permission = ensureWritePermission(folderHandle);
  // Observed by the queued task; this only avoids an unhandled-rejection
  // report while the task waits its turn.
  permission.catch(() => {});
  return permission;
}

// Both writers below reserve their queue slot synchronously, at call time:
// disk order must equal call order, because every write replaces a whole
// collection with the caller's in-memory snapshot.
export async function writeJson(folderHandle, filename, data) {
  data = structuredClone(data);
  // Pre-flight schema check; throws if the in-memory shape would corrupt
  // the on-disk file. Unknown filenames (backups, exports) pass through.
  assertCollection(filename, data);
  const permission = startPermissionCheck(folderHandle);
  return enqueueWrite(() => permission.then(() => withFolderLock(folderHandle, async () => {
    try {
      await publish(folderHandle, [{ filename, data }]);
    } catch (err) {
      if (err instanceof StaleBudgetError || err instanceof BudgetRecoveryError) throw err;
      throw new Error(`Could not save ${filename}: ${err.message || err.name || 'unknown error'}`);
    }
  })));
}

export async function writeBatch(folderHandle, items) {
  items = structuredClone(items);
  for (const { filename, data } of items) assertCollection(filename, data);
  const permission = startPermissionCheck(folderHandle);
  return enqueueWrite(() => permission.then(() => withFolderLock(folderHandle, async () => {
    // publish() writes items in order (meta last). Wrap each failure with the
    // filename the way this function always has; a stale-version refusal is
    // its own error and passes through unwrapped.
    try {
      await publish(folderHandle, items);
    } catch (err) {
      if (err instanceof StaleBudgetError || err instanceof BudgetRecoveryError) throw err;
      const where = err.bvFilename || 'the budget folder';
      throw new Error(`writeBatch failed on ${where}: ${err.message || err.name || 'unknown error'}`);
    }
  })));
}

export { CURRENT_SCHEMA_VERSION };

const BACKUP_MANIFEST = 'migration-backup.json';
const RESTORE_MARKER = '.bunvelope-restore.json';

async function createMigrationBackup(folder, version) {
  const texts = await readTexts(folder);
  if (texts[FILE_META]) {
    texts[FILE_META] = JSON.stringify(await hydrateMeta(folder, JSON.parse(texts[FILE_META])));
  }
  const name = `backup-v${version}-${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomUUID()}`;
  const backup = await folder.getDirectoryHandle(name, { create: true });
  await writeVerifiedBackup(backup, texts, { schemaVersion: version });
}

async function writeVerifiedBackup(backup, texts, metadata) {
  const hashes = {};
  for (const filename of BUDGET_FILES) {
    const text = texts[filename];
    hashes[filename] = await fingerprint(text);
    if (text !== null) {
      await doWriteText(backup, filename, text);
      if (await readRawText(backup, filename) !== text) throw new Error('Backup verification failed');
    }
  }
  // Written last: incomplete snapshots are never accepted for restoration.
  await doWrite(backup, BACKUP_MANIFEST, { ...metadata, version: 1, files: hashes });
  await readMigrationBackup(backup);
}

async function readMigrationBackup(backup) {
  const manifest = await readRawJson(backup, BACKUP_MANIFEST);
  if (manifest?.version !== 1 || !manifest.files ||
      Object.keys(manifest.files).length !== BUDGET_FILES.length) throw new Error('Invalid migration backup');
  const texts = await readTexts(backup);
  for (const name of BUDGET_FILES) {
    if (!Object.hasOwn(manifest.files, name) || await fingerprint(texts[name]) !== manifest.files[name]) {
      throw new Error(`Backup verification failed: ${name}`);
    }
  }
  return texts;
}

/** A complete, validated generation, serialized with saves and cross-tab writers.
 * Background work only queries permissions: it never opens a permission prompt.
 */
export function createAutomaticBackup(source, destination, { owner, timestamp }) {
  return enqueueWrite(() => withFolderLock(source, async () => {
    for (const handle of [source, destination]) {
      if (await handle.queryPermission({ mode: handle === source ? 'read' : 'readwrite' }) !== 'granted') {
        throw new Error('Backup folder permission is required. Select the folder again.');
      }
    }
    if (await readRawJson(source, RESTORE_MARKER) !== null) throw new Error('Finish budget restoration before backing up.');
    const journal = await readRawJson(source, FILE_PUBLISH_JOURNAL);
    if (journal !== null) throw new Error('Finish budget recovery before backing up.');
    const texts = await readTexts(source);
    const keys = ['envelopes', 'budgetItems', 'transactions', 'accounts', 'envelopeTemplates', 'meta'];
    const bundle = Object.fromEntries(BUDGET_FILES.map((name, i) => [keys[i],
      texts[name] === null ? undefined : JSON.parse(texts[name])]));
    bundle.meta = await hydrateMeta(source, bundle.meta);
    const check = validateBundle(bundle);
    if (!check.ok || bundle.meta.schemaVersion !== CURRENT_SCHEMA_VERSION) {
      throw new Error('Backup refused: budget files are missing, invalid or use an unsupported schema.');
    }
    // A second read also detects most foreign-process edits (FSAPI has no OS lock).
    const again = await readTexts(source);
    if (!sameJson(texts, again) || await readRawJson(source, FILE_PUBLISH_JOURNAL) !== null) {
      throw new Error('Budget changed during backup. Retry after other writers finish.');
    }
    // Backups are self-contained: never leave references to source sidecars.
    texts[FILE_META] = JSON.stringify(bundle.meta);
    return writeAutomaticSnapshot(destination, texts, { owner, timestamp });
  }));
}

async function writeAutomaticSnapshot(destination, texts, { owner, timestamp }) {
  const name = `snapshot-${new Date(timestamp).toISOString().replace(/[:.]/g, '-')}-${crypto.randomUUID()}`;
  const backup = await destination.getDirectoryHandle(name, { create: true });
  await writeVerifiedBackup(backup, texts, {
    schemaVersion: CURRENT_SCHEMA_VERSION, kind: 'automatic', owner, timestamp,
  });
  return name;
}

/** Write an authoritative API snapshot to a user-selected local folder. */
export function createBundleBackup(bundle, destination, metadata) {
  bundle = structuredClone(bundle);
  return enqueueWrite(async () => {
    if (await destination.queryPermission({ mode: 'readwrite' }) !== 'granted') {
      throw new Error('Backup folder permission is required. Select the folder again.');
    }
    const check = validateBundle(bundle);
    if (!check.ok || bundle.meta.schemaVersion !== CURRENT_SCHEMA_VERSION) {
      throw new Error('Backup refused: budget files are missing, invalid or use an unsupported schema.');
    }
    const keys = ['envelopes', 'budgetItems', 'transactions', 'accounts', 'envelopeTemplates', 'meta'];
    const texts = Object.fromEntries(BUDGET_FILES.map((name, i) => [name,
      bundle[keys[i]] === undefined ? null : JSON.stringify(bundle[keys[i]])]));
    return writeAutomaticSnapshot(destination, texts, metadata);
  });
}

/** Restore into a NEW empty folder. Never overwrite a budget or the backup. */
export function restoreMigrationBackup(backup, destination) {
  return enqueueWrite(() => withFolderLock(destination, async () => {
    const texts = await readMigrationBackup(backup);
    for await (const entry of destination.values()) { // includes unrelated files/subfolders
      throw new Error(`Choose an empty destination folder (${entry.name || entry})`);
    }
    await ensureWritePermission(destination);
    await doWrite(destination, RESTORE_MARKER, { incomplete: true });
    for (const name of BUDGET_FILES) {
      if (texts[name] !== null) {
        await doWriteText(destination, name, texts[name]);
        if (await readRawText(destination, name) !== texts[name]) throw new Error(`Restore verification failed: ${name}`);
      }
    }
    await doWrite(destination, RESTORE_MARKER, null);
  }));
}

// Bundle-level validator used on the load path. Delegates to the shared
// per-collection validators in ./validators.js.
export function validateSchema(bundle) {
  return validateBundle(bundle);
}

export async function loadBudgetData(folderHandle) {
  // Read one complete generation under the same lock used by publishers.
  // Release it before migrations, which enqueue their own publications.
  const snapshot = await enqueueWrite(() => withFolderLock(folderHandle, async () => {
    const restore = await readRawText(folderHandle, RESTORE_MARKER);
    if (restore !== null && restore !== 'null') throw new Error('Incomplete backup restoration. Restore again into a new empty folder.');
    await recoverPublish(folderHandle);
    const snapshot = await readSnapshot(folderHandle);
    snapshot[FILE_META] = await hydrateMeta(folderHandle, snapshot[FILE_META]);
    const meta = snapshot[FILE_META];
    const version = meta && typeof meta.schemaVersion === 'number' ? meta.schemaVersion : (meta ? 1 : null);
    if (version !== null && version < CURRENT_SCHEMA_VERSION) {
      await ensureWritePermission(folderHandle);
      await createMigrationBackup(folderHandle, version);
    }
    return snapshot;
  }));
  const envelopes = snapshot[FILE_ENVELOPES];
  const budgetItems = snapshot[FILE_BUDGET_ITEMS];
  const transactions = snapshot[FILE_TRANSACTIONS];
  const accounts = snapshot[FILE_ACCOUNTS];
  const meta = snapshot[FILE_META];
  const envelopeTemplatesRaw = snapshot[FILE_ENV_TEMPLATES];

  const rawMeta = meta && typeof meta === 'object' ? meta : null;

  // Arm the cross-writer guard before any migration below writes. From here
  // on every write through this adapter re-checks `write_seq` against what we
  // just read and refuses if another writer moved it.
  rememberLoadedSeq(folderHandle, rawMeta);

  const onDiskVer = rawMeta && typeof rawMeta.schemaVersion === 'number'
    ? rawMeta.schemaVersion
    : (rawMeta ? 1 : null);

  if (onDiskVer != null && onDiskVer > CURRENT_SCHEMA_VERSION) {
    throw new Error(
      `Budget was saved by a newer version (schema v${onDiskVer}). ` +
      `This build supports up to v${CURRENT_SCHEMA_VERSION}.`
    );
  }

  if (onDiskVer == null && !Array.isArray(envelopes) && !Array.isArray(transactions)
      && !Array.isArray(accounts) && !Array.isArray(budgetItems)) {
    return {
      envelopes:         [],
      budgetItems:       [],
      transactions:      [],
      accounts:          [],
      envelopeTemplates: [],
      meta:              { schemaVersion: CURRENT_SCHEMA_VERSION },
    };
  }

  const { bundle, changed } = migrateBundle({
    envelopes: Array.isArray(envelopes) ? envelopes : [],
    budgetItems: Array.isArray(budgetItems) ? budgetItems : [],
    transactions: Array.isArray(transactions) ? transactions : [],
    accounts: Array.isArray(accounts) ? accounts : [],
    envelopeTemplates: Array.isArray(envelopeTemplatesRaw) ? envelopeTemplatesRaw : [],
    meta: rawMeta || { schemaVersion: CURRENT_SCHEMA_VERSION },
  });

  const check = validateSchema(bundle);
  if (!check.ok) {
    const msg = check.errors.slice(0, 10).join('\n  • ');
    const more = check.truncated ? '\n  (more issues omitted)' : '';
    const err = new Error(
      `Budget data failed validation. The folder may be corrupted or hand-edited.\n\n` +
      `  • ${msg}${more}\n\n` +
      `Fix the JSON files in the backup folder or pick a different budget folder.`
    );
    err.validationErrors = check.errors;
    throw err;
  }

  if (onDiskVer != null && onDiskVer < CURRENT_SCHEMA_VERSION) {
    const files = { envelopes: FILE_ENVELOPES, budgetItems: FILE_BUDGET_ITEMS,
      transactions: FILE_TRANSACTIONS, accounts: FILE_ACCOUNTS, envelopeTemplates: FILE_ENV_TEMPLATES, meta: FILE_META };
    await writeBatch(folderHandle, changed.map(kind => ({ filename: files[kind], data: bundle[kind] })));
  }

  return bundle;
}

export async function saveTransactions(folderHandle, transactions) {
  await writeJson(folderHandle, FILE_TRANSACTIONS, transactions);
}
export async function saveAccounts(folderHandle, accounts) {
  await writeJson(folderHandle, FILE_ACCOUNTS, accounts);
}
export async function saveEnvelopes(folderHandle, envelopes) {
  await writeJson(folderHandle, FILE_ENVELOPES, envelopes);
}
export async function saveBudgetItems(folderHandle, budgetItems) {
  await writeJson(folderHandle, FILE_BUDGET_ITEMS, budgetItems);
}
export async function saveEnvelopeTemplates(folderHandle, templates) {
  await writeJson(folderHandle, FILE_ENV_TEMPLATES, templates);
}
export async function saveMeta(folderHandle, meta) {
  await writeJson(folderHandle, FILE_META, meta);
}

// Name of the adapter — used by storage/index.js for diagnostics/tests.
export const adapterName = 'fsapi';
