// js/core/payee-fields.js — the pure payee helpers the payee commands share:
// which rows a merge may rewrite, how aliases, hidden payees and symbol rules
// change. Pure: no state, no DOM. js/state/payee-merge.js, payee-aliases.js,
// payee-index.js and investments.js re-export these for their callers.

/** Folded key of a payee name: trimmed, lowercase. */
export const payeeKey = s => String(s || '').trim().toLowerCase();

/**
 * Rows that only move money between envelopes: fills ("Fill envelopes",
 * "Start of Month"), envelope transfers and envelope-side adjustments
 * ("Rollover: sweep to unallocated"). Their "payee" is a label the app wrote,
 * not somewhere money went, and suggesting it for a new expense is noise.
 */
export function isEnvelopeInternal(tx) {
  return tx.type === 'fill' || tx.type === 'envelope_transfer'
    || (tx.type === 'adjustment' && tx.target === 'envelope');
}

/**
 * Rewrite every row whose trimmed lowercase payee is in `fromKeys` (and is not
 * already the target) to `toPayee`, stamped `modified_at`. Envelope-internal
 * rows are skipped. Returns the same array when nothing changes.
 * @param {any[]} transactions
 * @param {Set<string>} fromKeys
 * @param {string} toPayee
 * @param {string} stamp
 */
export function mergePayees(transactions, fromKeys, toPayee, stamp) {
  const target = String(toPayee || '').trim();
  let changed = 0;
  if (!target) return { transactions, changed };
  const next = transactions.map(tx => {
    if (isEnvelopeInternal(tx)) return tx;
    const raw = (tx.payee || '').trim();
    if (!raw || !fromKeys.has(raw.toLowerCase()) || raw === target) return tx;
    changed += 1;
    return { ...tx, payee: target, modified_at: stamp };
  });
  return { transactions: changed ? next : transactions, changed };
}

/**
 * Investment payee rules after a merge: the first rule found among the
 * from-keys moves to the target key (unless the target has one), and the
 * from-keys are deleted.
 * @param {Record<string, string>} rules
 * @param {Iterable<string>} fromKeys
 * @param {string} toPayee
 */
export function mergePayeeRules(rules, fromKeys, toPayee) {
  const targetKey = String(toPayee || '').trim().toLowerCase();
  const out = { ...rules };
  let carried = out[targetKey] || '';
  for (const k of fromKeys) {
    if (k === targetKey) continue;
    if (!carried && out[k]) carried = out[k];
    delete out[k];
  }
  if (carried) out[targetKey] = carried;
  return out;
}

/** `{ [lowercasedOld]: keptName }`, dropping anything malformed. */
export function getPayeeAliases(meta) {
  const raw = meta?.payeeAliases;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  /** @type {Record<string, string>} */
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === 'string' && v.trim() && k) out[k] = v.trim();
  }
  return out;
}

/**
 * Record `fromNames` (the EXACT spellings merged away, not folded keys) as
 * aliases of `toPayee`. Aliases that pointed at a merged-away spelling now
 * point at the kept name; a merged-away spelling that is already spelled
 * exactly like the kept name is dropped (nothing to alias). The "already the
 * kept name" check is by exact string, not folded key: merging "lidl" into
 * "Lidl" differs only in case, so it still needs an alias, or a future
 * "lidl" row would arrive unrenamed.
 * @param {Record<string, string>} aliases
 * @param {Iterable<string>} fromNames
 * @param {string} toPayee
 */
export function addPayeeAliases(aliases, fromNames, toPayee) {
  const target = String(toPayee || '').trim();
  const targetKey = payeeKey(target);
  /** @type {Map<string, string>} folded key -> exact spelling merged away */
  const from = new Map();
  for (const name of fromNames) {
    const n = String(name || '').trim();
    const k = payeeKey(n);
    if (k) from.set(k, n);
  }
  /** @type {Record<string, string>} */
  const out = {};
  for (const [k, v] of Object.entries(aliases)) {
    if (k === targetKey) continue;
    out[k] = from.has(payeeKey(v)) ? target : v;
  }
  for (const [k, name] of from) {
    if (!k || name === target) continue;
    out[k] = target;
  }
  return out;
}

export function removePayeeAlias(aliases, fromKey) {
  const out = { ...aliases };
  delete out[payeeKey(fromKey)];
  return out;
}

/** Lowercased hidden payees. */
export function getHiddenPayees(meta) {
  const raw = meta?.payeeHidden;
  return new Set(Array.isArray(raw) ? raw.filter(x => typeof x === 'string' && x) : []);
}

/** @returns {string[]} sorted, unique, lowercased */
export function setPayeeHidden(list, payee, hidden) {
  const set = new Set((list || []).map(payeeKey));
  const k = payeeKey(payee);
  if (hidden) set.add(k); else set.delete(k);
  set.delete('');
  return [...set].sort();
}

/** Same single lookup used when new transactions are committed. */
export function resolvePayeeAlias(payee, aliases) {
  return aliases?.[payeeKey(payee)] || payee;
}
