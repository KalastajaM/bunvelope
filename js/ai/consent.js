// js/ai/consent.js — first-use consent + meta persistence for AI features.
// `meta.ai` shape:
//   { enabled, consentVersion, perFeature: {...}, model?, dismissedSubs?: [] }

import { state } from '../app.js';
import { updateMeta } from '../state/meta-writes.js';
import { confirmDialog } from '../ui/dialog.js';
import { t } from '../ui/i18n.js';
import { setConsentGate } from './transport.js';
import { currentBudgetSession, budgetHeld } from '../state/budget-session.js';

// Bumped to 2 on 2026-08-23. The agent's read tools send transaction notes,
// which version 1 explicitly promised were stripped, and static mode talks to
// Anthropic directly rather than through our server. Both changes make the
// old disclosure false, so anyone who consented to it is asked again.
export const CONSENT_VERSION = 2;

export function defaultPerFeatureFlags() {
  return {
    monthlyBriefing: true,
    anomaly: true,
    envelopeHealth: true,
    subscription: true,
    whatif: true,
    reconcile: true,
    onboarding: true,
    search: true,
    portfolioInsight: true,
  };
}

export function hasFreshConsent() {
  const ai = state.meta?.ai;
  return !!(ai && ai.enabled && ai.consentVersion === CONSENT_VERSION);
}

// ── Enforcement at first use ────────────────────────────────────────────
// hasFreshConsent() was only consulted when AI was switched on (setup
// wizard, Settings toggle). A user who agreed to v1 kept `enabled: true`
// and every surface kept sending, including transaction notes v1 promised
// were stripped. The transport now asks this before every request: fresh
// consent passes; enabled-but-stale consent shows the current disclosure
// once and proceeds only on acceptance; anything else sends nothing.

let pendingPrompt = null;
let declinedThisSession = false;

/**
 * May AI requests leave the browser right now? Prompts for the current
 * disclosure when the user consented to an older one. Concurrent callers
 * (several dashboard cards) share one dialog. A decline holds for the rest
 * of the session so the dialog does not return on every card, and is not
 * persisted: the next session asks again rather than silently switching
 * the feature off.
 *
 * @returns {Promise<boolean>}
 */
export async function requireFreshConsent() {
  if (hasFreshConsent()) return true;
  if (!state.meta?.ai?.enabled || declinedThisSession) return false;
  if (!pendingPrompt) {
    pendingPrompt = ensureAiConsent()
      .then((ok) => {
        if (!ok) declinedThisSession = true;
        return ok;
      })
      .finally(() => { pendingPrompt = null; });
  }
  return pendingPrompt;
}

/** The transport's gate: true, or a localized error the caller can show. */
export async function assertFreshConsent() {
  if (await requireFreshConsent()) return true;
  const err = new Error(t('ai.consent.required'));
  err.code = 'consent_required';
  throw err;
}

/** Test hook: forget a session decline. */
export function _resetConsentSessionForTest() {
  declinedThisSession = false;
  pendingPrompt = null;
}

setConsentGate(assertFreshConsent);

function isCloudMode() {
  return !!(typeof window !== 'undefined'
    && window.__BUNVELOPE_MODE
    && window.__BUNVELOPE_MODE.kind === 'cloud');
}

export async function ensureAiConsent({ setup = false } = {}) {
  const session = currentBudgetSession();
  const folder = state.budgetFolder;
  // Only the wizard can accept consent in memory while its budget is held.
  if (budgetHeld() && !setup) return false;
  if (setup && !budgetHeld()) return false;
  if (hasFreshConsent()) return true;
  // Where the data goes differs by mode, and the difference is exactly what a
  // consent dialog exists to state. Cloud relays through our server; static
  // talks to Anthropic straight from the browser with a key kept here.
  const body = isCloudMode() ? t('ai.consent.body') : t('ai.consent.bodyLocal');
  const ok = await confirmDialog(body, {
    title: t('ai.consent.title'),
    okLabel: t('ai.consent.accept'),
    cancelLabel: t('ai.consent.decline'),
  });
  if (!ok) return false;
  if (currentBudgetSession() !== session || state.budgetFolder !== folder) return false;
  if (setup) {
    if (!budgetHeld()) return false;
    state.meta = withAiEnabled(state.meta || {});
  } else {
    if (budgetHeld()) return false;
    await enableAi();
    if (currentBudgetSession() !== session || state.budgetFolder !== folder || budgetHeld()) return false;
  }
  return true;
}

// Every writer below goes through the shared meta-write queue
// (js/state/meta-writes.js): each patch runs against the meta the previous
// write produced, and `state.meta` moves only once the write lands. Writing
// `state.meta` first and saving it on the side let a concurrent Settings
// autosave or investment write drop this change.

// Setup keeps this patch in memory; normal consent uses the meta queue.
function withAiEnabled(meta) {
  const prevAi = meta.ai || {};
  return {
    ...meta,
    ai: {
      ...prevAi,
      enabled: true,
      consentVersion: CONSENT_VERSION,
      perFeature: prevAi.perFeature || defaultPerFeatureFlags(),
    },
  };
}

export async function enableAi() {
  await updateMeta(state, withAiEnabled);
}

export async function disableAi() {
  await updateMeta(state, (meta) => (
    meta.ai ? { ...meta, ai: { ...meta.ai, enabled: false } } : { ...meta }
  ));
}

export async function setPerFeatureFlag(name, on) {
  await updateMeta(state, (meta) => {
    const ai = meta.ai || {};
    const perFeature = { ...(ai.perFeature || defaultPerFeatureFlags()) };
    perFeature[name] = !!on;
    return { ...meta, ai: { ...ai, perFeature } };
  });
}

export async function setAiModel(model) {
  await updateMeta(state, (meta) => {
    const next = { ...(meta.ai || {}) };
    if (model) next.model = model; else delete next.model;
    return { ...meta, ai: next };
  });
}

export async function dismissSubscription(payee) {
  if (!payee) return;
  const key = String(payee);
  await dismissItem('subscription', key, key);
}

// ── Generic dismissal store ─────────────────────────────────────────────
// `meta.ai.dismissed[feature][stableKey] = { dismissedAt, label? }`. Each
// AI card computes a stable key for the row (envelope_id, payee, hash, …)
// and persists the user's "hide this" choice so it survives refreshes.
// The legacy `dismissedSubs: string[]` is mirrored for back-compat.

function readDismissed(meta) {
  const ai = meta?.ai || {};
  // A copy: the normaliser below adds a key, and this is also called on the
  // live `state.meta` by readers, which must not change it in place.
  const dismissed = (ai.dismissed && typeof ai.dismissed === 'object') ? { ...ai.dismissed } : {};
  // One-time normaliser: copy any legacy dismissedSubs entries into the map.
  const legacy = Array.isArray(ai.dismissedSubs) ? ai.dismissedSubs : [];
  if (legacy.length) {
    const sub = { ...(dismissed.subscription || {}) };
    let added = false;
    for (const payee of legacy) {
      const k = String(payee || '');
      if (!k) continue;
      if (!sub[k]) { sub[k] = { dismissedAt: null, label: k }; added = true; }
    }
    if (added) dismissed.subscription = sub;
  }
  return dismissed;
}

export async function dismissItem(feature, key, label) {
  if (!feature || !key) return;
  const stableKey = String(key);
  const dismissedAt = new Date().toISOString();
  await updateMeta(state, (meta) => {
    const ai = meta.ai || {};
    const dismissed = readDismissed(meta);
    const featMap = { ...(dismissed[feature] || {}) };
    featMap[stableKey] = {
      dismissedAt,
      label: label != null ? String(label) : stableKey,
    };
    const nextDismissed = { ...dismissed, [feature]: featMap };
    // Mirror subscription dismissals into the legacy array so older code
    // paths (and any hypothetical un-upgraded clients) still see them.
    const nextSubs = Array.isArray(ai.dismissedSubs) ? [...ai.dismissedSubs] : [];
    if (feature === 'subscription' && !nextSubs.includes(stableKey)) {
      nextSubs.push(stableKey);
    }
    return { ...meta, ai: { ...ai, dismissed: nextDismissed, dismissedSubs: nextSubs } };
  });
}

export async function restoreItem(feature, key) {
  if (!feature || !key) return;
  const stableKey = String(key);
  if (!(stableKey in (readDismissed(state.meta)[feature] || {}))) return;
  await updateMeta(state, (meta) => {
    const ai = meta.ai || {};
    const dismissed = readDismissed(meta);
    const featMap = { ...(dismissed[feature] || {}) };
    // Re-checked here: an earlier queued write may already have removed it.
    if (!(stableKey in featMap)) return meta;
    delete featMap[stableKey];
    const nextDismissed = { ...dismissed, [feature]: featMap };
    let nextSubs = Array.isArray(ai.dismissedSubs) ? ai.dismissedSubs.slice() : [];
    if (feature === 'subscription') {
      nextSubs = nextSubs.filter((p) => String(p) !== stableKey);
    }
    return { ...meta, ai: { ...ai, dismissed: nextDismissed, dismissedSubs: nextSubs } };
  });
}

export async function clearDismissedFeature(feature) {
  if (!feature) return;
  if (!readDismissed(state.meta)[feature]) return;
  await updateMeta(state, (meta) => {
    const ai = meta.ai || {};
    const dismissed = readDismissed(meta);
    if (!dismissed[feature]) return meta;
    const nextDismissed = { ...dismissed };
    delete nextDismissed[feature];
    const nextSubs = (feature === 'subscription')
      ? []
      : (Array.isArray(ai.dismissedSubs) ? ai.dismissedSubs.slice() : []);
    return { ...meta, ai: { ...ai, dismissed: nextDismissed, dismissedSubs: nextSubs } };
  });
}

export function listDismissed(feature) {
  const dismissed = readDismissed(state.meta);
  const out = [];
  const features = feature ? [feature] : Object.keys(dismissed);
  for (const f of features) {
    const map = dismissed[f] || {};
    for (const [key, entry] of Object.entries(map)) {
      out.push({
        feature: f,
        key,
        label: entry?.label || key,
        dismissedAt: entry?.dismissedAt || null,
      });
    }
  }
  out.sort((a, b) => (b.dismissedAt || '').localeCompare(a.dismissedAt || ''));
  return out;
}

export function isDismissed(feature, key) {
  if (!feature || !key) return false;
  const dismissed = readDismissed(state.meta);
  return !!dismissed[feature]?.[String(key)];
}
