// js/core/diff.js — what a command changed, row by row. The same diff is the
// dry-run preview, the AI proposal review, and (inverted) the Undo. Undo
// applies the inverse to the CURRENT data and refuses if a row it would touch
// was edited since, so it can never wipe a later change.
//
// A collection's entry is { added, removed, changed } plus, only when the rows
// present on both sides changed their relative order (array order is display
// order), `order: { before, after }`: the collection's full id sequences. An
// entry may carry order alone (a reorder command).

import { ok, fail } from './result.js';

const ARRAY_KINDS = new Set(['accounts', 'envelopes', 'budgetItems', 'envelopeTemplates', 'transactions']);

/** Structural equality for plain JSON data. */
export function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every(k => Object.hasOwn(b, k) && deepEqual(a[k], b[k]));
}

function indexById(rows, kind) {
  const map = new Map();
  rows.forEach((row, index) => {
    if (!row || typeof row.id !== 'string' || !row.id) throw new TypeError(`rowDiff: a ${kind} row has no id`);
    map.set(row.id, { row, index });
  });
  return map;
}

/**
 * @param {Record<string, any>} before
 * @param {Record<string, any>} changes
 */
export function rowDiff(before, changes) {
  /** @type {Record<string, any>} */
  const out = {};
  for (const [kind, next] of Object.entries(changes)) {
    if (kind === 'meta') {
      const prev = before.meta || {};
      const cur = next || {};
      const keys = [...new Set([...Object.keys(prev), ...Object.keys(cur)])];
      const changed = keys
        .filter(key => !deepEqual(prev[key], cur[key]))
        .map(key => ({ key, before: prev[key], after: cur[key] }));
      if (changed.length) out.meta = { changed };
      continue;
    }
    if (!ARRAY_KINDS.has(kind)) throw new TypeError(`rowDiff: unknown collection "${kind}"`);
    const prev = before[kind] || [];
    const prevById = indexById(prev, kind);
    const nextById = indexById(next, kind);

    const retainedIdsPrev = prev.filter(row => nextById.has(row.id)).map(row => row.id);
    const retainedIdsNext = next.filter(row => prevById.has(row.id)).map(row => row.id);
    const order = deepEqual(retainedIdsPrev, retainedIdsNext)
      ? null
      : { before: prev.map(row => row.id), after: next.map(row => row.id) };

    const added = [];
    const removed = [];
    const changed = [];
    next.forEach((row, index) => {
      const old = prevById.get(row.id);
      if (!old) added.push({ row, index });
      else if (old.row !== row && !deepEqual(old.row, row)) changed.push({ id: row.id, before: old.row, after: row });
    });
    prev.forEach((row, index) => {
      if (!nextById.has(row.id)) removed.push({ row, index });
    });
    if (added.length || removed.length || changed.length || order) {
      out[kind] = { added, removed, changed, ...(order ? { order } : {}) };
    }
  }
  return out;
}

/** @param {Record<string, any>} diff */
export function invert(diff) {
  /** @type {Record<string, any>} */
  const out = {};
  for (const [kind, d] of Object.entries(diff)) {
    out[kind] = kind === 'meta'
      ? { changed: d.changed.map(c => ({ key: c.key, before: c.after, after: c.before })) }
      : {
        added: d.removed,
        removed: d.added,
        changed: d.changed.map(c => ({ id: c.id, before: c.after, after: c.before })),
        ...(d.order ? { order: { before: d.order.after, after: d.order.before } } : {}),
      };
  }
  return out;
}

/**
 * `rows` (the diff's adds, removes and edits already applied) rebuilt in
 * `order.after`, keeping each row object; null when the rows are not the ones
 * the diff was computed against. The check: the ids must be exactly
 * `order.after`'s set, and the rows present on both sides of the diff must sit
 * in `order.before`'s relative sequence. Together that is `order.before` with
 * this diff's own adds inserted and removes dropped, so a row another writer
 * added, or a reorder another writer made, is a conflict.
 * @param {any[]} rows
 * @param {{ before: string[], after: string[] }} order
 */
function applyOrder(rows, order) {
  const ids = rows.map(r => r?.id);
  const afterSet = new Set(order.after);
  const beforeSet = new Set(order.before);
  if (ids.length !== order.after.length || new Set(ids).size !== ids.length || !ids.every(id => afterSet.has(id))) return null;
  const retainedNow = ids.filter(id => beforeSet.has(id));
  const retainedBefore = order.before.filter(id => afterSet.has(id));
  if (!deepEqual(retainedNow, retainedBefore)) return null;
  const byId = new Map(rows.map(r => [r.id, r]));
  return order.after.map(id => byId.get(id));
}

/**
 * @param {Record<string, any>} data
 * @param {Record<string, any>} diff
 */
export function applyDiff(data, diff) {
  /** @type {Record<string, any>} */
  const changes = {};
  for (const [kind, d] of Object.entries(diff)) {
    if (kind === 'meta') {
      const meta = { ...(data.meta || {}) };
      for (const c of d.changed) {
        if (!deepEqual(meta[c.key], c.before)) return fail('diff_conflict', { kind: 'meta', id: c.key });
        if (c.after === undefined) delete meta[c.key];
        else meta[c.key] = c.after;
      }
      changes.meta = meta;
      continue;
    }
    const rows = [...(data[kind] || [])];
    for (const { row } of d.removed) {
      const i = rows.findIndex(r => r?.id === row.id);
      if (i < 0 || !deepEqual(rows[i], row)) return fail('diff_conflict', { kind, id: row.id });
      rows.splice(i, 1);
    }
    for (const c of d.changed) {
      const i = rows.findIndex(r => r?.id === c.id);
      if (i < 0 || !deepEqual(rows[i], c.before)) return fail('diff_conflict', { kind, id: c.id });
      rows[i] = c.after;
    }
    for (const { row, index } of [...d.added].sort((a, b) => a.index - b.index)) {
      if (rows.some(r => r?.id === row.id)) return fail('diff_conflict', { kind, id: row.id });
      rows.splice(Math.min(index, rows.length), 0, row);
    }
    if (d.order) {
      const reordered = applyOrder(rows, d.order);
      if (!reordered) return fail('diff_conflict', { kind, id: null });
      changes[kind] = reordered;
      continue;
    }
    changes[kind] = rows;
  }
  return ok(changes);
}

const isPrimitiveArray = (a) => Array.isArray(a) && a.every(x => x === null || typeof x !== 'object');

/**
 * Whether a meta change merges by element rather than replacing the key: both
 * sides are arrays of primitives. A missing side reads as [], so removing the
 * last element (after is undefined) still merges by element rather than
 * discarding a concurrent add.
 * @param {{ before: any, after: any }} change
 */
export const mergesByElement = ({ before, after }) => isPrimitiveArray(before ?? []) && isPrimitiveArray(after ?? []);

// Primitive-array meta keys the app keeps sorted: reopened_months
// (reopenMonthPatch, js/core/closed-periods.js) and payeeHidden (setPayeeHidden,
// js/core/payee-fields.js). An element merge keeps them sorted too.
const SORTED_META_KEYS = new Set(['reopened_months', 'payeeHidden']);

/**
 * Apply a meta diff onto `meta` (which may have moved on since the diff was
 * computed). A key that still holds the diff's `before` gets the command's
 * `after` exactly: its order, or its deletion. Only a primitive-array key that
 * moved merges by element, so a concurrent writer's additions survive (sorted
 * again for a key the app keeps sorted); every other key is set (or deleted)
 * wholesale.
 * @param {Record<string, any>} meta
 * @param {{ changed: { key: string, before: any, after: any }[] }} metaDiff
 */
export function mergeMetaChanges(meta, metaDiff) {
  /** @type {Record<string, any>} */
  const out = { ...(meta || {}) };
  for (const { key, before, after } of metaDiff?.changed || []) {
    if (mergesByElement({ before, after }) && !deepEqual(out[key], before)) {
      const prev = new Set(before ?? []);
      const next = new Set(after ?? []);
      const removed = new Set([...prev].filter(x => !next.has(x)));
      const current = Array.isArray(out[key]) ? out[key].filter(x => !removed.has(x)) : [];
      for (const x of after ?? []) if (!prev.has(x) && !current.includes(x)) current.push(x);
      if (after === undefined && !current.length) delete out[key];
      else out[key] = SORTED_META_KEYS.has(key) ? current.sort() : current;
    } else if (after === undefined) {
      delete out[key];
    } else {
      out[key] = after;
    }
  }
  return out;
}
