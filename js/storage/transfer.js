// js/storage/transfer.js — cloud-mode-only helpers for moving data between
// a user's machine and the cloud database.
//
//   importBundleAsNewBudget(bundle, name)
//       → POST /api/budgets (creates empty), then PUT .../batch with all
//         6 collections at version 0. Always creates a new budget — never
//         overwrites.
//
//   exportBudgetAsBundle(budgetId)
//       → GET /api/budgets/:id through the API adapter, returns the
//         decrypted bundle without `version` (server-side concurrency
//         state, not user data).

import {
  createCloudBudget,
  writeBatch as apiWriteBatch,
  readDecryptedBundle,
  CURRENT_SCHEMA_VERSION,
} from './api-adapter.js';
import { migrateBundle } from './bundle-migrations.js';
import { validateSchema } from './fsapi-adapter.js';

const KINDS_IN_ORDER = [
  { kind: 'envelopes',         filename: 'envelopes.json' },
  { kind: 'budgetItems',       filename: 'budget-items.json' },
  { kind: 'transactions',      filename: 'transactions.json' },
  { kind: 'accounts',          filename: 'accounts.json' },
  { kind: 'envelopeTemplates', filename: 'envelope-templates.json' },
  { kind: 'meta',              filename: 'budget-meta.json' },
];

/**
 * Upload an in-memory bundle as a brand-new cloud budget.
 *
 * @param {object} bundle — supported legacy versions are upgraded before validation or upload.
 *                          Shape: { envelopes, budgetItems, transactions,
 *                                   accounts, envelopeTemplates, meta }.
 * @param {string} name   — user-entered display name for the new cloud
 *                          budget. Also written into bundle.meta.name.
 * @returns {Promise<{ id: string, name: string, version: number }>}
 */
export async function importBundleAsNewBudget(bundle, name) {
  const cleanName = String(name || '').trim();
  if (!cleanName) throw new Error('A budget name is required.');

  bundle = migrateBundle(bundle).bundle;
  assertBundle(bundle);

  const created = await createCloudBudget(cleanName);
  const ref = {
    kind: 'cloud',
    budgetId: created.id,
    version: created.version ?? 0,
    name: created.name,
  };

  // §3.1 — never carry the exporting user's AI consent into this account.
  // Stripped here as well as in buildExportEntries because either can be
  // reached without the other: a hand-copied folder never passes through the
  // export path, and this is the side that decides what the app believes.
  // Consent then re-prompts on first use in the importing session, which is
  // the correct behaviour.
  const { ai: _dropped, ...restMeta } = bundle.meta || {};
  const meta = {
    ...restMeta,
    name: cleanName,
    schemaVersion: CURRENT_SCHEMA_VERSION,
  };

  const items = KINDS_IN_ORDER.map(({ kind, filename }) => {
    if (kind === 'meta') return { filename, data: meta };
    const val = bundle[kind];
    return { filename, data: Array.isArray(val) ? val : [] };
  });

  await apiWriteBatch(ref, items);
  return { id: ref.budgetId, name: ref.name, version: ref.version };
}

/**
 * Download a cloud budget's bundle: the six collections, decrypted, without
 * the concurrency `version` field (server-side state, meaningless off-server).
 *
 * Reads through the API adapter, as duplicateBudget does. The raw server
 * response of an encrypted budget is a set of `{__enc, iv, ct}` wrappers, and
 * a backup of those without the key cannot be re-imported. With encryption
 * on and no key loaded this throws rather than export ciphertext.
 */
export async function exportBudgetAsBundle(budgetId) {
  return readDecryptedBundle(budgetId);
}

function assertBundle(bundle) {
  const check = validateSchema(bundle);
  if (!check.ok) {
    const msg = check.errors.slice(0, 3).join('\n  • ');
    throw new Error(`Bundle failed validation:\n  • ${msg}`);
  }
  const v = bundle?.meta?.schemaVersion;
  if (v == null || v < CURRENT_SCHEMA_VERSION) {
    throw new Error(
      `This export is at schema v${v ?? '?'}. ` +
      `Open it locally first to upgrade, then re-export.`
    );
  }
  if (v > CURRENT_SCHEMA_VERSION) {
    throw new Error(
      `This export is at schema v${v}, but this version of the app only supports up to v${CURRENT_SCHEMA_VERSION}. ` +
      `Update the app and try again.`
    );
  }
}
