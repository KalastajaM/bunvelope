// js/core/tombstones.js — the scheduled-tombstone rule shared by the commands
// that remove rows: a removed row that came from a plan occurrence leaves its
// from_budget key in meta, so the next open does not re-create it (see
// js/state/scheduled-tombstones.js).

/**
 * The meta change for removing these rows, or null when no key is new.
 * @param {{ meta?: Record<string, any> }} data
 * @param {Array<Record<string, any>>} removed  the rows being removed
 * @returns {{ meta: Record<string, any>, added: string[] } | null}
 */
export function tombstoneRemoval(data, removed) {
  const existing = Array.isArray(data.meta?.scheduledTombstones) ? data.meta.scheduledTombstones : [];
  const known = new Set(existing);
  /** @type {string[]} */
  const added = [];
  for (const row of removed) {
    const key = row.from_budget;
    if (typeof key === 'string' && key && !known.has(key)) { known.add(key); added.push(key); }
  }
  if (!added.length) return null;
  return { meta: { ...data.meta, scheduledTombstones: [...existing, ...added] }, added };
}
