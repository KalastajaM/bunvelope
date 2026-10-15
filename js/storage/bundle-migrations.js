// Shared in-memory schema upgrades. Adapters own backups, encryption and
// atomic publication; this module only transforms JSON and never mutates input.
import { slugify, uniqueId } from '../utils.js';
import { CURRENT_SCHEMA_VERSION } from './validators.js';

const isV3Envelope = E => !!E && typeof E.id === 'string' && !('envelope' in E);

function migrateV2toV3(oldEnvelopes, oldBudgetItems, oldTxs, oldMeta) {
  let envelopes = [];
  let budgetItems = [];
  const envIdTaken = new Set();
  const itemIdTaken = new Set();
  const idByCompositeKey = new Map();

  // Older builds saved this migration file by file with meta last, so a
  // failure could leave v3 envelopes and items under v2 meta. Converting
  // those again renamed every envelope "(unnamed)" under a new id and reset
  // item amounts to 0. Keep them; the reference rewrite below is idempotent.
  const alreadyV3 = oldEnvelopes.length > 0 && oldEnvelopes.every(isV3Envelope);
  if (alreadyV3) {
    envelopes = oldEnvelopes;
    budgetItems = Array.isArray(oldBudgetItems) ? oldBudgetItems : [];
    for (const E of envelopes) {
      idByCompositeKey.set(`${E.category || 'Uncategorised'}: ${E.name}`, E.id);
    }
  }

  for (const E of alreadyV3 ? [] : oldEnvelopes) {
    const cat = (E && E.category) || 'Uncategorised';
    const envName = (E && E.envelope) || '(unnamed)';
    const baseSlug = slugify(`${cat}-${envName}`) || 'envelope';
    const envId = uniqueId(baseSlug, envIdTaken);
    envIdTaken.add(envId);

    const newEnv = { id: envId, name: envName, category: cat };
    if (E.description) newEnv.description = E.description;
    envelopes.push(newEnv);

    const itemId = uniqueId(`item-${baseSlug}`, itemIdTaken);
    itemIdTaken.add(itemId);
    const newItem = {
      id: itemId,
      envelope_id: envId,
      default_amount:               E.default_amount ?? 0,
      extra_buffer:                 E.extra_buffer ?? 0,
      include:                      E.include !== false,
      include_in_emergency_budget:  !!E.include_in_emergency_budget,
      payment_day:                  E.payment_day ?? 0,
      stress_category:              E.stress_category ?? null,
      stress_cut_pct:               E.stress_cut_pct ?? 0,
      monthly_schedule:             E.monthly_schedule ?? {},
    };
    if (E.description) newItem.description = E.description;
    budgetItems.push(newItem);

    idByCompositeKey.set(`${cat}: ${envName}`, envId);
  }

  const resolveKey = k => (k == null || k === '' ? undefined : (idByCompositeKey.get(k) ?? null));

  const rewriteEnvelopeRefs = obj => {
    if (!obj || typeof obj !== 'object') return obj;
    if ('envelope' in obj) {
      const id = resolveKey(obj.envelope);
      if (id !== undefined) obj.envelope_id = id;
      delete obj.envelope;
    }
    if ('from_envelope' in obj) {
      const id = resolveKey(obj.from_envelope);
      if (id !== undefined) obj.from_envelope_id = id;
      delete obj.from_envelope;
    }
    if ('to_envelope' in obj) {
      const id = resolveKey(obj.to_envelope);
      if (id !== undefined) obj.to_envelope_id = id;
      delete obj.to_envelope;
    }
    if (Array.isArray(obj.lines)) {
      obj.lines = obj.lines.map(line => {
        if (!line || typeof line !== 'object') return line;
        const l = { ...line };
        if ('envelope' in l) {
          const id = resolveKey(l.envelope);
          if (id !== undefined) l.envelope_id = id;
          delete l.envelope;
        }
        return l;
      });
    }
    if (obj.type === 'adjustment' && obj.target === 'envelope'
        && typeof obj.target_id === 'string' && obj.target_id.includes(': ')) {
      const id = resolveKey(obj.target_id);
      if (id !== undefined) obj.target_id = id;
    }
    return obj;
  };

  const transactions = oldTxs.map(tx => rewriteEnvelopeRefs({ ...tx }));
  const newMeta = { ...(oldMeta || {}), schemaVersion: 3 };

  return { envelopes, budgetItems, transactions, meta: newMeta };
}

function migrateV3toV4(oldEnvelopes, oldAccounts, oldMeta) {
  const envelopes = (oldEnvelopes || []).map(e => ({ archived: false, ...e }));
  const accounts  = (oldAccounts  || []).map(a => ({ archived: false, ...a }));
  const newMeta = { ...(oldMeta || {}), schemaVersion: 4 };

  return { envelopes, accounts, meta: newMeta };
}


/** Upgrade supported legacy JSON; fail before writing a newer/invalid version. */
export function migrateBundle(input) {
  if (!input || !['envelopes', 'transactions', 'accounts'].every(k => Array.isArray(input[k]))) {
    throw new Error('Bundle failed validation: envelopes, transactions and accounts must be arrays');
  }
  if (input.meta != null && (typeof input.meta !== 'object' || Array.isArray(input.meta))) {
    throw new Error('Bundle failed validation: meta must be an object');
  }
  const raw = input?.meta?.schemaVersion;
  const version = raw ?? 1;
  if (!Number.isInteger(version) || version < 1) throw new Error('Invalid budget schema version');
  if (version > CURRENT_SCHEMA_VERSION) throw new Error(`Budget was saved by a newer version (schema v${version}). This build supports up to v${CURRENT_SCHEMA_VERSION}.`);
  let bundle = { ...input, envelopeTemplates: input.envelopeTemplates ?? [] };
  const changed = new Set();
  if (version < 3) {
    bundle = { ...bundle, ...migrateV2toV3(bundle.envelopes ?? [], bundle.budgetItems ?? [], bundle.transactions ?? [], bundle.meta) };
    changed.add('envelopes').add('budgetItems').add('transactions');
  }
  if (version < 4) {
    bundle = { ...bundle, ...migrateV3toV4(bundle.envelopes, bundle.accounts, bundle.meta) };
    changed.add('envelopes').add('accounts');
  }
  let meta = bundle.meta;
  if (version < 6) meta = { ...meta,
    emergency_envelope_id: meta?.emergency_envelope_id ?? null,
    emergency_duration_months: meta?.emergency_duration_months ?? 6 };
  if (version < 7) meta = { ...meta, emergency_credit_source: meta?.emergency_credit_source ?? 'flagged' };
  if (version < CURRENT_SCHEMA_VERSION) {
    meta = { ...meta, schemaVersion: CURRENT_SCHEMA_VERSION };
    changed.add('meta');
  }
  return { bundle: { ...bundle, meta }, changed: [...changed] };
}
