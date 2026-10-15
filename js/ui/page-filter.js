// js/ui/page-filter.js — a page's saved exclusions (Reports: envelopes and
// payees; Net worth: accounts), per page and per budget, so the demo and a
// real budget never share them. Stored in localStorage, which may be missing,
// full or blocked, and whose contents are untrusted: every id is checked
// against what exists now. The key follows the Transactions page's per-folder
// convention. Pure apart from the injectable storage and an in-memory copy
// of each saved selection, which keeps Apply working for this session when
// storage is missing, blocked or full.

const PREFIX = 'bv.pageFilter.';

/** @type {Map<string, Record<string, string[]>>} key → last saved selection */
const memory = new Map();

function defaultStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** @param {string} page  @param {string | undefined | null} budgetName */
export function pageFilterKey(page, budgetName) {
  return `${PREFIX}${page}.${budgetName || '_default'}`;
}

/**
 * The budget-scoping key for a page filter: a cloud budget's id (stable
 * across a rename), otherwise its folder/guest name.
 * @param {{ kind?: string, budgetId?: string, name?: string } | null | undefined} folder
 * @returns {string | undefined}
 */
export function budgetKeyOf(folder) {
  if (folder && folder.kind === 'cloud' && folder.budgetId) return `cloud:${folder.budgetId}`;
  return folder?.name;
}

/**
 * @param {any} raw  parsed JSON
 * @param {Record<string, Set<string>>} allowed  section → ids that exist now
 * @returns {Record<string, string[]>}  one array per allowed section
 */
export function sanitizeExclusions(raw, allowed) {
  /** @type {Record<string, string[]>} */
  const out = {};
  for (const [section, ok] of Object.entries(allowed)) {
    const list = raw && typeof raw === 'object' && Array.isArray(raw[section]) ? raw[section] : [];
    out[section] = [...new Set(list.filter(id => typeof id === 'string' && ok.has(id)))];
  }
  return out;
}

/** @param {Record<string, string[]>} sel */
export function exclusionCount(sel) {
  return Object.values(sel).reduce((n, ids) => n + ids.length, 0);
}

/**
 * The saved selection for a page and budget, validated against `allowed`.
 * This session's own last save wins over storage, so a save that storage
 * refused (full or blocked) is not undone by the older stored copy. With
 * `opts.prune`, ids that no longer exist are also dropped from storage, so
 * an excluded payee that was merged away does not come back into force,
 * unseen, if that spelling ever reappears; pass it only once the budget's
 * data has loaded, or everything would be pruned.
 * @param {{ prune?: boolean }} [opts]
 */
export function loadPageFilter(page, budgetName, allowed, storage = defaultStorage(), opts = {}) {
  const key = pageFilterKey(page, budgetName);
  let raw = memory.has(key) ? memory.get(key) : null;
  if (raw == null && storage) {
    try {
      raw = JSON.parse(storage.getItem(key) || 'null');
    } catch {
      raw = null;
    }
  }
  const sel = sanitizeExclusions(raw, allowed);
  if (opts.prune && raw && typeof raw === 'object') {
    const stored = Object.keys(allowed)
      .reduce((n, section) => n + (Array.isArray(raw[section]) ? raw[section].length : 0), 0);
    if (stored > exclusionCount(sel)) savePageFilter(page, budgetName, sel, storage);
  }
  return sel;
}

export function savePageFilter(page, budgetName, sel, storage = defaultStorage()) {
  const key = pageFilterKey(page, budgetName);
  memory.set(key, Object.fromEntries(Object.entries(sel).map(([k, ids]) => [k, [...ids]])));
  if (!storage) return;
  try {
    if (exclusionCount(sel)) storage.setItem(key, JSON.stringify(sel));
    else storage.removeItem(key);
  } catch {
    // Full or blocked: the in-memory copy keeps the filter for this session.
  }
}
