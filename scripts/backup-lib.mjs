// scripts/backup-lib.mjs — the testable half of `npm run backup`.
//
// The only backups used to be budget_blob_backups, in the same Postgres as
// the data, and `DELETE /budgets/:id` cascades to them: one bad delete or one
// lost database volume took the backups with it. This writes each budget to a
// file outside the database instead.
//
// Encryption is client-side (the key comes from the user's passphrase), so
// the server holds ciphertext for an encrypted budget and so does this
// backup: it writes exactly what the store returns, never decrypts. The
// account's encryption salt and verifier are recorded alongside, because the
// key cannot be re-derived from the passphrase without the salt.
//
// File layout: <dir>/<budget id>/bunvelope-<name>-<UTC stamp>.json. The body
// is the budget bundle itself (envelopes, budgetItems, transactions,
// accounts, envelopeTemplates, meta) plus a `_backup` block, so a plaintext
// backup can be imported as-is through the app's "Import file".

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

export const BACKUP_FORMAT = 'bunvelope-backup';
export const BACKUP_FORMAT_VERSION = 1;
export const DEFAULT_KEEP = 30;

const FILE_RE = /^bunvelope-.*-(\d{8}T\d{6}Z)\.json$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A leading `~` or `~/` → the home directory; anything else unchanged. */
export function expandHome(raw, home = os.homedir()) {
  if (raw === '~') return home;
  if (raw.startsWith('~/')) return path.join(home, raw.slice(2));
  return raw;
}

/** `~/x` → absolute; the default is outside the repo on purpose. */
export function resolveBackupDir(value, home = os.homedir()) {
  const raw = String(value || '').trim() || '~/Bunvelope-backups';
  return path.resolve(expandHome(raw, home));
}

/** BACKUP_KEEP as a positive integer, or the default. */
export function resolveKeep(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_KEEP;
}

/** 2026-09-24T08:31:15.123Z → 20260924T083115Z (sorts chronologically). */
export function stampOf(date) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

function slug(name) {
  const s = String(name || '').normalize('NFKD').replace(/\p{M}+/gu, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return s || 'budget';
}

function isEncrypted(bundle) {
  return Object.values(bundle || {}).some((value) => value?.__enc === 1);
}

async function writeAtomic(file, text) {
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, text, { mode: 0o600 });
  await fs.rename(tmp, file);
}

/** Delete all but the newest `keep` backup files in one budget's folder. */
async function prune(folder, keep) {
  const names = (await fs.readdir(folder)).filter((n) => FILE_RE.test(n));
  names.sort((a, b) => FILE_RE.exec(b)[1].localeCompare(FILE_RE.exec(a)[1]) || b.localeCompare(a));
  const doomed = names.slice(keep);
  for (const name of doomed) await fs.unlink(path.join(folder, name));
  return doomed.length;
}

/**
 * Back up every budget the store lists.
 *
 * @param {object} opts
 * @param {{ listBudgets: Function, readBudget: Function }} opts.store  createBudgetStore's shape
 * @param {(userId: string) => Promise<object|null>} [opts.getEncryption]
 *   the owner's { enabled, salt, verifier }, recorded for encrypted budgets
 * @param {string} opts.dir   absolute backup directory
 * @param {number} opts.keep  newest files kept per budget
 * @param {Date} opts.now     the run's timestamp
 * @returns {Promise<{ ok: boolean, dir: string, keep: number, created_at: string,
 *   budgets: object[], errors: object[] }>}
 */
export async function runBackup({ store, getEncryption, dir, keep, now }) {
  const createdAt = now.toISOString();
  const stamp = stampOf(now);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const budgets = [];
  const errors = [];
  const listed = await store.listBudgets();
  for (const entry of listed) {
    try {
      if (!UUID_RE.test(String(entry.id))) throw new Error('unexpected budget id');
      const result = await store.readBudget({ budgetId: entry.id, touchLastOpened: false });
      const encrypted = isEncrypted(result.bundle);
      const encryption = encrypted && getEncryption
        ? await getEncryption(result.userId ?? entry.user_id) : null;
      const doc = {
        ...result.bundle,
        _backup: {
          format: BACKUP_FORMAT,
          format_version: BACKUP_FORMAT_VERSION,
          created_at: createdAt,
          budget: {
            id: result.budgetId,
            name: result.budgetName,
            version: result.version,
            owner_email: entry.owner_email ?? null,
            created_at: result.createdAt ?? entry.created_at ?? null,
          },
          encrypted,
          ...(encrypted ? { encryption } : {}),
        },
      };
      const folder = path.join(dir, String(entry.id));
      await fs.mkdir(folder, { recursive: true, mode: 0o700 });
      const file = path.join(folder, `bunvelope-${slug(result.budgetName)}-${stamp}.json`);
      const text = `${JSON.stringify(doc)}\n`;
      await writeAtomic(file, text);
      const pruned = await prune(folder, keep);
      budgets.push({
        id: entry.id,
        name: result.budgetName,
        version: result.version,
        encrypted,
        file,
        bytes: Buffer.byteLength(text),
        pruned,
      });
    } catch (error) {
      errors.push({
        id: entry.id,
        code: error?.code || 'backup_failed',
        message: error?.code ? String(error.message) : 'backup failed',
      });
    }
  }
  return { ok: errors.length === 0, dir, keep, created_at: createdAt, budgets, errors };
}
