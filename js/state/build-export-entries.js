// js/state/build-export-entries.js — pure helper that turns an in-memory
// app state into the six { name, data } entries used by the ZIP export.
// No DOM / storage imports — safe to call from tests directly.

import { CURRENT_SCHEMA_VERSION } from '../storage/validators.js';
import { compactFinancialHistory } from '../core/financial-history.js';

export function buildExportEntries(st) {
  const asJson = (v) => JSON.stringify(v ?? []);
  // §3.1 — `meta.ai` holds AI consent: whether AI is enabled, which features
  // were consented to, the consent version, and per-feature dismissals. That
  // is per-user runtime state, not part of a budget. Spreading the whole meta
  // object carried the EXPORTER's consent into whoever imported the budget,
  // and the consent-version gate that would otherwise re-prompt them was
  // satisfied by someone else's answer. Consent is not a preference: an app
  // that believes it has permission it was never given is a different
  // category of wrong from an app with the wrong theme.
  //
  // Stripped on import as well (js/storage/transfer.js) — a folder copied by
  // hand never passes through here, and the import side is the one that
  // decides what the app believes.
  const { ai: _dropped, ...restMeta } = st?.meta || {};
  const meta = {
    ...restMeta,
    ...(restMeta.financialHistory ? { financialHistory: compactFinancialHistory(restMeta.financialHistory) } : {}),
    schemaVersion: (st?.meta?.schemaVersion ?? CURRENT_SCHEMA_VERSION),
  };
  return [
    { name: 'envelopes.json',          data: asJson(st?.envelopes) },
    { name: 'budget-items.json',       data: asJson(st?.budgetItems) },
    { name: 'transactions.json',       data: asJson(st?.transactions) },
    { name: 'accounts.json',           data: asJson(st?.accounts) },
    { name: 'envelope-templates.json', data: asJson(st?.envelopeTemplates) },
    { name: 'budget-meta.json',        data: JSON.stringify(meta) },
  ];
}

// The inverse, for the budget picker's ZIP import: the six files of an export
// back into a bundle. Matched by file name wherever they sit in the archive
// (one re-made from the unzipped folder puts them under it); anything else is
// ignored. A file missing from the archive is left out of the bundle, so the
// bundle validator names it, as it does for a JSON bundle.
const FILE_KINDS = {
  'envelopes.json': 'envelopes',
  'budget-items.json': 'budgetItems',
  'transactions.json': 'transactions',
  'accounts.json': 'accounts',
  'envelope-templates.json': 'envelopeTemplates',
  'budget-meta.json': 'meta',
};

/**
 * @param {Array<{ name: string, data: string }>} entries
 * @returns {{ ok: true, bundle: Record<string, any> } | { ok: false, errors: string[], issue?: 'ambiguous' }}
 */
export function bundleFromExportEntries(entries) {
  /** @type {Record<string, any>} */
  const bundle = {};
  const errors = [];
  const seen = new Map();
  const jsonFiles = [];
  for (const { name, data } of entries || []) {
    const base = String(name).split('/').pop() || '';
    if (String(name).startsWith('__MACOSX/') || base.startsWith('._')) continue; // macOS archiver litter
    const kind = FILE_KINDS[base.toLowerCase()];
    if (!kind) {
      if (base.toLowerCase().endsWith('.json')) jsonFiles.push({ name, data });
      continue;
    }
    if (seen.has(kind)) { errors.push(`${base} appears twice (${seen.get(kind)}, ${name})`); continue; }
    seen.set(kind, name);
    try {
      bundle[kind] = JSON.parse(data);
    } catch (err) {
      errors.push(`${base} is not valid JSON (${err?.message || err})`);
    }
  }
  if (!seen.size && jsonFiles.length === 1) {
    try { return { ok: true, bundle: JSON.parse(jsonFiles[0].data) }; }
    catch { return { ok: false, errors: ['the bundled JSON is not valid JSON'] }; }
  }
  // Never guess which budget to open when an archive contains alternatives.
  const containsBundle = jsonFiles.some(({ data }) => {
    try {
      const value = JSON.parse(data);
      return value && typeof value === 'object' && ['accounts', 'envelopes', 'transactions'].some(key => key in value);
    } catch { return false; }
  });
  if ((!seen.size && jsonFiles.length > 1) || (seen.size && containsBundle)) {
    return { ok: false, issue: 'ambiguous', errors: ['the archive contains more than one possible budget'] };
  }
  if (!seen.size) errors.push('no budget files found (expected one bundle JSON or budget-meta.json, transactions.json, …)');
  return errors.length ? { ok: false, errors } : { ok: true, bundle };
}
