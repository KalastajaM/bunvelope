import { unpackHistoryMeta } from '../storage/history-chunks.js';
// js/ui/read-budget-file.js — read a budget the user picked as a file: the
// JSON bundle the cloud picker's Export saves, or the ZIP of six files the
// Settings export saves (owner decision 5, 2026-10-05). Both end as the same
// bundle shape and pass the same validation the JSON import always ran, so a
// ZIP is accepted exactly when the JSON of the same budget would be.

import { looksLikeZip, readZipEntries } from './zip.js';
import { bundleFromExportEntries } from '../state/build-export-entries.js';
import { validateBundle } from '../storage/validators.js';

/** What the file picker accepts for a budget file. */
export const BUDGET_FILE_ACCEPT = '.json,.zip,application/json,application/zip,application/x-zip-compressed';

/**
 * @param {Blob} file
 * @returns {Promise<{ ok: true, bundle: Record<string, any>, format: 'json'|'zip' }
 *   | { ok: false, reason: 'unreadable'|'notBundle', issue?: 'ambiguous', errors: string[], format: 'json'|'zip' }>}
 */
export async function readBudgetFile(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const format = looksLikeZip(bytes) ? 'zip' : 'json';
  let bundle;
  let entries = [];
  if (format === 'zip') {
    try {
      entries = await readZipEntries(bytes);
    } catch (err) {
      return { ok: false, reason: 'unreadable', errors: [err?.message || String(err)], format };
    }
    const fromEntries = bundleFromExportEntries(entries);
    if (!fromEntries.ok) return { ok: false, reason: 'notBundle', issue: fromEntries.issue, errors: fromEntries.errors, format };
    bundle = fromEntries.bundle;
  } else {
    try {
      bundle = JSON.parse(new TextDecoder().decode(bytes));
    } catch (err) {
      return { ok: false, reason: 'unreadable', errors: [err?.message || String(err)], format };
    }
  }
  try {
    const byName = new Map();
    for (const entry of entries) {
      const name = entry.name.split('/').at(-1);
      if (/^\.bunvelope-history-[a-f0-9]{64}\.json$/.test(name)) {
        if (byName.has(name)) throw new Error('Duplicate financial history chunk in archive');
        byName.set(name, entry.data);
      }
    }
    if (bundle?.meta) bundle.meta = (await unpackHistoryMeta(bundle.meta, id => {
      const text = byName.get(`.bunvelope-history-${id}.json`);
      return text ? JSON.parse(text) : null;
    })).meta;
  } catch (err) {
    return { ok: false, reason: 'notBundle', errors: [err.message], format };
  }
  const check = validateBundle(bundle);
  if (!check.ok) return { ok: false, reason: 'notBundle', errors: check.errors, format };
  return { ok: true, bundle, format };
}
