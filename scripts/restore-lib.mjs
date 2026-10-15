// scripts/restore-lib.mjs — the testable half of `npm run restore`.
//
// Restores one `npm run backup` file (see backup-lib.mjs for the format) as
// a NEW budget for the backup's owner (default), or over an existing budget
// with --into. Without --yes it is a dry run: it resolves the target, runs
// every check a write would, prints the plan and writes nothing.
//
// Encrypted backups are written back as the ciphertext they are, never
// decrypted. That only works into an account whose encryption key is the
// one the blobs were written with (the blob `kid`). The store's
// lockEncryptionConfig refuses anything else on write; this checks the same
// rule up front so a dry run says so, and so an as-new restore does not
// create an empty budget and then fail to fill it.

import os from 'node:os';
import path from 'node:path';
import { BudgetStoreError, KIND_TO_DB, MAX_BUDGET_NAME_LEN, assertBlob } from '../server/services/budget-store.js';
import { publicError } from '../bin/cli-support.mjs';
import { BACKUP_FORMAT, BACKUP_FORMAT_VERSION, expandHome } from './backup-lib.mjs';

const USAGE = 'usage: npm run restore -- --file <backup.json> '
  + '[--into <budget-id> [--allow-other-owner] | --owner <email>] [--name <name>] [--yes]';
const VALUE_OPTIONS = new Set(['file', 'into', 'owner', 'name']);
const FLAG_OPTIONS = new Map([['yes', 'yes'], ['allow-other-owner', 'allowOtherOwner']]);
const KINDS = Object.keys(KIND_TO_DB);

function usageError(message) {
  return new BudgetStoreError('bad_arguments', `${message}; ${USAGE}`);
}

/**
 * @param {string[]} argv  the arguments after the script name
 * @returns {{ file: string, into?: string, owner?: string, name?: string,
 *   yes: boolean, allowOtherOwner: boolean }}
 */
export function parseRestoreArgs(argv) {
  const out = { yes: false, allowOtherOwner: false };
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) throw usageError(`unexpected argument ${arg}`);
    const name = arg.slice(2);
    if (!VALUE_OPTIONS.has(name) && !FLAG_OPTIONS.has(name)) {
      throw usageError(`unknown option --${name}`);
    }
    if (seen.has(name)) throw usageError(`duplicate option --${name}`);
    seen.add(name);
    if (FLAG_OPTIONS.has(name)) {
      out[FLAG_OPTIONS.get(name)] = true;
      continue;
    }
    // An empty value is refused, not treated as absent: `--into ""` from a
    // script with an unset variable must not become a new-budget restore.
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--') || !value.trim()) {
      throw usageError(`--${name} requires a value`);
    }
    out[name] = value;
    index += 1;
  }
  if (!out.file) throw usageError('--file is required');
  if (out.into && (out.owner !== undefined || out.name !== undefined)) {
    throw usageError('--into restores over an existing budget and takes neither --owner nor --name');
  }
  if (out.allowOtherOwner && !out.into) {
    throw usageError('--allow-other-owner only applies with --into');
  }
  return out;
}

/**
 * The backup file's absolute path. npm runs scripts from the repo root, so
 * a relative path is resolved against the directory npm was invoked from
 * (INIT_CWD), passed in as `cwd`; a leading `~/` is the home directory.
 */
export function resolveBackupFile(file, { cwd = process.cwd(), home = os.homedir() } = {}) {
  return path.resolve(cwd, expandHome(String(file).trim(), home));
}

/**
 * The JSON document printed for a failed run: publicError's shape. A failed
 * restore leaves nothing behind to report: a new budget is created and
 * written in one transaction (store.createBudget with items).
 */
export function restoreErrorOutput(error) {
  return { ok: false, ...publicError(error) };
}

function notABackup(message) {
  return new BudgetStoreError('not_a_backup', `not a Bunvelope backup file: ${message}`);
}

/**
 * Parse and check a backup file's text.
 *
 * @param {string} text
 * @returns {{ bundle: object, meta: object, encrypted: boolean, keyIds: Set<string|null>,
 *   warnings: string[] }}
 *   `bundle` holds only the collections present (null/absent ones left out).
 */
export function readBackupDoc(text) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    throw notABackup('not JSON');
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw notABackup('not a JSON object');
  const meta = doc._backup;
  if (!meta || typeof meta !== 'object') throw notABackup('no _backup block');
  if (meta.format !== BACKUP_FORMAT) throw notABackup(`format is not ${BACKUP_FORMAT}`);
  if (meta.format_version !== BACKUP_FORMAT_VERSION) {
    throw new BudgetStoreError(
      'unsupported_format_version',
      `backup format_version ${meta.format_version} is not supported (expected ${BACKUP_FORMAT_VERSION})`,
    );
  }
  const bundle = {};
  const keyIds = new Set();
  for (const kind of KINDS) {
    const data = doc[kind];
    if (data === undefined || data === null) continue;
    try {
      assertBlob(kind, data);
    } catch (error) {
      throw new BudgetStoreError('validation_failed', `${kind}: ${error.message}`);
    }
    if (data?.__enc === 1) keyIds.add(data.kid ?? null);
    bundle[kind] = data;
  }
  if (!Object.keys(bundle).length) {
    throw new BudgetStoreError('empty_backup', 'the backup holds no collections');
  }
  const unknown = Object.keys(doc).filter((key) => key !== '_backup' && !KINDS.includes(key));
  const warnings = unknown.length ? [`unknown top-level keys ignored: ${unknown.join(', ')}`] : [];
  return { bundle, meta, encrypted: keyIds.size > 0, keyIds, warnings };
}

function countOf(data) {
  if (data?.__enc === 1) return 'encrypted';
  if (Array.isArray(data)) return data.length;
  return 'present';
}

function defaultName(meta, now) {
  const suffix = ` (restored ${now.toISOString().slice(0, 10)})`;
  const base = String(meta?.budget?.name || '').trim() || 'Budget';
  return `${base.slice(0, MAX_BUDGET_NAME_LEN - suffix.length).trimEnd()}${suffix}`;
}

function checkName(name) {
  const clean = String(name ?? '').trim();
  if (!clean) throw new BudgetStoreError('bad_arguments', '--name must not be empty');
  if (clean.length > MAX_BUDGET_NAME_LEN) {
    throw new BudgetStoreError('bad_arguments', `--name is longer than ${MAX_BUDGET_NAME_LEN} characters`);
  }
  return clean;
}

function keyMismatch(message) {
  return new BudgetStoreError(
    'encryption_key_mismatch',
    `${message}; restore it into the account it came from, with its encryption settings unchanged`,
  );
}

/**
 * The store's lockEncryptionConfig rule, checked before writing and for
 * every backup: each ciphertext blob needs encryption on with its key id,
 * and with encryption on no blob may be plaintext. A backup can mix the
 * two (incomplete encryption: readBudget fills a missing blob with a
 * plaintext []), so every present blob is checked, not the backup's flag.
 */
function checkEncryption(doc, encryption) {
  const enabled = Boolean(encryption?.enabled);
  const keyId = encryption?.keyId ?? null;
  const entries = Object.entries(doc.bundle);
  const cipher = entries.filter(([, data]) => data?.__enc === 1);
  const plaintext = entries.filter(([, data]) => data?.__enc !== 1).map(([kind]) => kind);
  if (cipher.length) {
    const noKid = cipher.filter(([, data]) => data.kid === undefined || data.kid === null);
    if (noKid.length) {
      throw keyMismatch(`encrypted blob has no key id; cannot verify it matches this account (${noKid.map(([k]) => k).join(', ')})`);
    }
    if (!enabled) throw keyMismatch('the backup is encrypted but the target account has encryption turned off');
    if (cipher.some(([, data]) => data.kid !== keyId)) {
      throw keyMismatch('the backup is encrypted with a different key than the target account uses');
    }
  }
  if (enabled && plaintext.length) {
    throw new BudgetStoreError(
      'encryption_conflict',
      cipher.length
        ? `the target account has encryption turned on and the backup mixes ciphertext with plaintext collections (${plaintext.join(', ')}); the store refuses plaintext into an encrypted account`
        : "the target account has encryption turned on and the backup is plaintext; use the app's Import file, which encrypts as it saves",
    );
  }
  return cipher.length ? { key_id_match: true } : null;
}

/**
 * Plan (dry run) or perform one restore.
 *
 * @param {object} opts
 * @param {object} opts.store  createBudgetStore's shape
 * @param {(email: string) => Promise<{ id: string }|null>} opts.getUserByEmail
 * @param {(userId: string) => Promise<{ enabled: boolean, keyId: string|null }|null>} opts.getEncryption
 * @param {ReturnType<typeof readBackupDoc>} opts.doc
 * @param {string} [opts.into]   existing budget id to overwrite
 * @param {boolean} [opts.allowOtherOwner]  let --into overwrite a budget
 *   whose owner is not the backup's owner
 * @param {string} [opts.owner]  owner email for a new budget (default: the backup's)
 * @param {string} [opts.name]   name for a new budget
 * @param {boolean} opts.yes     false = dry run, writes nothing
 * @param {Date} opts.now
 * @param {number} opts.maxPerUser  per-user budget cap
 */
export async function runRestore({
  store, getUserByEmail, getEncryption, doc, into, owner, name, yes, now, maxPerUser,
  allowOtherOwner = false,
}) {
  const items = KINDS.filter((kind) => kind in doc.bundle)
    .map((kind) => ({ kind, data: doc.bundle[kind] }));
  const collections = Object.fromEntries(items.map(({ kind, data }) => [kind, countOf(data)]));
  const backup = {
    id: doc.meta.budget?.id ?? null,
    name: doc.meta.budget?.name ?? null,
    version: doc.meta.budget?.version ?? null,
    created_at: doc.meta.created_at ?? null,
    owner_email: doc.meta.budget?.owner_email ?? null,
  };

  let userId;
  let ownerInfo;
  let target;
  if (into) {
    const probe = await store.probeBudget({ budgetId: into });
    userId = probe.user_id;
    const listed = await store.listBudgets({ userId });
    const targetEmail = listed.find((b) => b.id === probe.id)?.owner_email ?? null;
    const backupEmail = String(backup.owner_email ?? '').trim().toLowerCase();
    if (!allowOtherOwner && (!backupEmail || backupEmail !== String(targetEmail ?? '').toLowerCase())) {
      throw new BudgetStoreError(
        'owner_mismatch',
        `budget ${probe.id} belongs to ${targetEmail ?? 'an unknown owner'} but the backup `
          + `${backupEmail ? `belongs to ${backup.owner_email}` : 'names no owner'}; `
          + 'pass --allow-other-owner to overwrite it anyway',
      );
    }
    ownerInfo = { email: targetEmail };
    target = { id: probe.id, name: probe.name, version: probe.version };
  } else {
    const email = String(owner ?? doc.meta.budget?.owner_email ?? '').trim();
    if (!email) {
      throw new BudgetStoreError('bad_arguments', 'the backup names no owner; pass --owner <email>');
    }
    const user = await getUserByEmail(email);
    if (!user) throw new BudgetStoreError('owner_not_found', `no user with email ${email}`);
    userId = user.id;
    const newName = name === undefined ? defaultName(doc.meta, now) : checkName(name);
    const count = (await store.listBudgets({ userId })).length;
    if (count >= maxPerUser) {
      throw new BudgetStoreError('budget_limit', `budget limit reached (max ${maxPerUser})`, { max: maxPerUser });
    }
    ownerInfo = { email, budgets: count, max_budgets: maxPerUser };
    target = { id: null, name: newName, version: null };
  }

  const encryption = checkEncryption(doc, await getEncryption(userId));
  const summary = {
    ok: true,
    dry_run: !yes,
    mode: into ? 'into' : 'new',
    target,
    owner: ownerInfo,
    encrypted: doc.encrypted,
    ...(encryption ? { encryption } : {}),
    collections,
    backup,
    warnings: doc.warnings ?? [],
  };
  if (!yes) return summary;

  if (!into) {
    // Created and written in one transaction: a write that fails (a refused
    // blob, a lost connection) leaves no empty budget behind.
    const created = await store.createBudget({
      userId, name: target.name, maxPerUser, items, decrypting: false,
    });
    return {
      ...summary,
      target: { id: created.id, name: created.name, version: created.version },
      changed_kinds: created.changedKinds,
    };
  }
  // checkAccountRefs off: a backup is the app's own data, which may carry
  // legacy references the app's invariant badge already reports.
  const result = await store.applyBudget({
    budgetId: target.id, userId, expectedVersion: target.version, items,
    decrypting: false, checkAccountRefs: false,
  });
  return {
    ...summary,
    target: { ...target, version: result.version },
    changed_kinds: result.changedKinds,
  };
}
