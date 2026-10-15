import { backupPreferences } from './backup-preferences.js';

export const BACKUP_INTERVAL = 60 * 60 * 1000;
const RETRY_INTERVAL = 5 * 60 * 1000;

/** Keep the newest 24 hourly, 30 daily and 12 monthly buckets (UTC).
 * The union preserves old recovery points even after long periods offline.
 */
export function retainedSnapshots(snapshots) {
  const keep = new Set();
  const sorted = [...snapshots].sort((a, b) => b.timestamp - a.timestamp);
  for (const [length, count] of [[13, 24], [10, 30], [7, 12]]) {
    const buckets = new Set();
    for (const item of sorted) {
      const key = new Date(item.timestamp).toISOString().slice(0, length);
      if (!buckets.has(key) && buckets.size < count) {
        buckets.add(key);
        keep.add(item.name);
      }
    }
  }
  return keep;
}

async function prune(destination, owner) {
  const snapshots = [];
  for await (const [name, handle] of destination.entries()) {
    if (handle.kind !== 'directory' || !/^snapshot-/.test(name)) continue;
    try {
      const file = await handle.getFileHandle('migration-backup.json');
      const manifest = JSON.parse(await (await file.getFile()).text());
      if (manifest.version === 1 && manifest.kind === 'automatic' && manifest.owner === owner &&
          Number.isFinite(manifest.timestamp) && manifest.timestamp > 0) {
        snapshots.push({ name, timestamp: manifest.timestamp, handle });
      }
    } catch { /* Never prune incomplete or unrecognised backups. */ }
  }
  const keep = retainedSnapshots(snapshots);
  for (const item of snapshots) {
    if (keep.has(item.name)) continue;
    // Do not recursively delete: preserve any folder with user-added content.
    const names = ['envelopes.json', 'budget-items.json', 'transactions.json', 'accounts.json',
      'envelope-templates.json', 'budget-meta.json', 'migration-backup.json'];
    const entries = [];
    for await (const [name, handle] of item.handle.entries()) entries.push([name, handle]);
    if (entries.some(([name, handle]) => !names.includes(name) || handle.kind !== 'file')) continue;
    for (const [name] of entries) await item.handle.removeEntry(name);
    await destination.removeEntry(item.name);
  }
}

/** One controller per app realm. All operations bind to the source at call time.
 * Dependencies make clocks, folder failures and persistence testable.
 */
export function createBackupController({ snapshot, preferences = backupPreferences, clock = Date.now,
  changed = () => {}, cleanup = prune }) {
  const entries = new WeakMap();
  const loading = new WeakMap();
  const running = new WeakMap();
  const attempts = new WeakMap();
  const errors = new WeakMap();
  async function read(source) {
    if (!loading.has(source)) loading.set(source, (async () => {
      const all = await preferences();
      let match;
      for (const entry of all) {
        try {
          const same = source.kind === 'cloud'
            ? entry.source.kind === 'cloud' && entry.source.budgetId === source.budgetId
            : entry.source.kind !== 'cloud' && await entry.source.isSameEntry(source);
          if (same) { match = entry; break; }
        } catch { /* A different, deleted folder must not block this budget. */ }
      }
      if (match) entries.set(source, match);
      else entries.delete(source);
      if (!match?.enabled) errors.delete(source);
    })());
    try { await loading.get(source); }
    finally { loading.delete(source); }
    return entries.get(source);
  }
  const locked = (source, task) => globalThis.navigator?.locks?.request
    ? navigator.locks.request(`bunvelope:backups:${source.kind === 'cloud' ? source.budgetId : source.name || 'budget'}`, task)
    : task();
  function status(source) {
    const entry = entries.get(source);
    return { enabled: !!entry?.enabled, destination: entry?.destination?.name,
      lastSuccess: entry?.lastSuccess || null, busy: running.has(source),
      overdue: !!entry?.enabled && (!entry.lastSuccess || clock() - entry.lastSuccess > 2 * BACKUP_INTERVAL),
      error: errors.get(source) || null };
  }
  async function configure(source, destination) {
    if (running.has(source)) await running.get(source);
    await locked(source, async () => {
      await read(source);
      if (source.kind !== 'cloud' && (await source.isSameEntry(destination) || await source.resolve(destination) !== null ||
          await destination.resolve(source) !== null)) {
        throw new Error('Choose a backup folder separate from the budget folder (not a parent or subfolder).');
      }
      // Persist identity only: refs can carry decrypted caches and mutable versions.
      const savedSource = source.kind === 'cloud' ? { kind: 'cloud', budgetId: source.budgetId } : source;
      const entry = { id: entries.get(source)?.id || crypto.randomUUID(), source: savedSource, destination,
        enabled: true, lastSuccess: null };
      await preferences(entry);
      entries.set(source, entry);
      errors.delete(source);
      changed();
    });
    return run(source, true);
  }
  async function disable(source) {
    if (running.has(source)) await running.get(source);
    return locked(source, async () => {
      await read(source);
      const entry = entries.get(source);
      if (entry) {
        const next = { ...entry, enabled: false };
        await preferences(next);
        entries.set(source, next);
        errors.delete(source);
        changed();
      }
    });
  }
  async function run(source, force = false) {
    if (running.has(source)) return running.get(source);
    const task = locked(source, async () => {
      try {
        // Re-read inside the cross-tab lock: another window may have disabled
        // backups, changed destination, or already completed this hour's copy.
        const entry = await read(source);
        if (!entry?.enabled) return;
        const timestamp = clock();
        if (!force && ((!errors.has(source) && entry.lastSuccess && timestamp - entry.lastSuccess < BACKUP_INTERVAL) ||
            (attempts.has(source) && timestamp - attempts.get(source) < RETRY_INTERVAL))) return;
        attempts.set(source, timestamp);
        await snapshot(source, entry.destination, { owner: entry.id, timestamp });
        const next = { ...entry, lastSuccess: timestamp };
        await preferences(next);
        entries.set(source, next);
        errors.delete(source);
        // Retention only runs AFTER a new snapshot was written and verified.
        await cleanup(entry.destination, entry.id);
      } catch (error) {
        errors.set(source, error.message || String(error));
      }
    });
    running.set(source, task);
    changed();
    try { await task; }
    finally { running.delete(source); changed(); }
  }
  async function tick(source) {
    if (!source || source.__guest) return;
    try { await run(source); }
    catch (error) { errors.set(source, error.message || String(error)); changed(); }
  }
  return { read, status, configure, disable, run, tick };
}
