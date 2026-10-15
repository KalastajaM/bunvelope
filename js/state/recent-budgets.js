// js/state/recent-budgets.js — IndexedDB-backed list of recently opened
// budget folders. FileSystemDirectoryHandle is structured-cloneable but
// NOT JSON-serialisable, so localStorage can't hold it — IDB can.

const DB_NAME = 'bunvelope';
const LEGACY_DB_NAME = 'buvelope';
const DB_VERSION = 1;
const STORE = 'recent-budgets';
// Store up to 20 entries; the UI decides how many rows to show at once.
const MAX_ENTRIES = 20;

function rawOpen(name) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// One-shot migration: if the legacy 'buvelope' DB has entries and the new
// 'bunvelope' DB is empty, copy them over and delete the legacy DB. Runs
// at most once per page load — subsequent opens go straight to rawOpen.
let migrated = false;
async function migrateLegacy() {
  if (migrated) return;
  migrated = true;
  try {
    const newDb = await rawOpen(DB_NAME);
    const newCount = await new Promise((resolve) => {
      const tx = newDb.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).count();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(-1);
    });
    newDb.close();
    if (newCount !== 0) return;

    const legacyDb = await rawOpen(LEGACY_DB_NAME);
    const legacyEntries = await new Promise((resolve) => {
      const tx = legacyDb.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => resolve([]);
    });
    legacyDb.close();
    if (legacyEntries.length === 0) {
      indexedDB.deleteDatabase(LEGACY_DB_NAME);
      return;
    }

    const db = await rawOpen(DB_NAME);
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      for (const e of legacyEntries) store.put(e);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
    db.close();
    indexedDB.deleteDatabase(LEGACY_DB_NAME);
  } catch (err) {
    console.warn('recent-budgets legacy migration failed:', err);
  }
}

async function openDb() {
  await migrateLegacy();
  return rawOpen(DB_NAME);
}

async function withStore(mode, fn) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const store = tx.objectStore(STORE);
      let result;
      Promise.resolve(fn(store)).then((r) => { result = r; }, reject);
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

function getAllRaw(store) {
  return new Promise((resolve, reject) => {
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

export async function listRecentBudgets() {
  try {
    const all = await withStore('readonly', (s) => getAllRaw(s));
    return all
      .filter((r) => r && r.handle)
      .sort((a, b) => (b.lastOpenedAt || 0) - (a.lastOpenedAt || 0))
      .slice(0, MAX_ENTRIES);
  } catch (err) {
    console.warn('listRecentBudgets failed:', err);
    return [];
  }
}

export async function recordRecentBudget(handle) {
  if (!handle) return;
  try {
    // IDB transactions auto-commit when they have no active requests.
    // isSameEntry() is NOT an IDB operation, so awaiting it inside a tx
    // closes the tx and makes the following put() fail silently. Split
    // into: (1) readonly load, (2) async isSameEntry comparisons, (3)
    // readwrite tx with only IDB ops.
    const all = await withStore('readonly', (s) => getAllRaw(s));

    let match = null;
    for (const entry of all) {
      if (!entry || !entry.handle) continue;
      try {
        if (await entry.handle.isSameEntry(handle)) { match = entry; break; }
      } catch {
        // handle may be invalid (folder deleted) — ignore
      }
    }

    const now = Date.now();
    if (match) {
      match.lastOpenedAt = now;
      match.name = handle.name;
      await withStore('readwrite', (s) => { s.put(match); });
      return;
    }

    const newEntry = {
      id: crypto?.randomUUID?.() || String(now) + Math.random().toString(36).slice(2),
      name: handle.name,
      handle,
      lastOpenedAt: now,
    };
    const combined = [...all, newEntry];
    const toDelete = combined.length > MAX_ENTRIES
      ? combined
          .slice()
          .sort((a, b) => (a.lastOpenedAt || 0) - (b.lastOpenedAt || 0))
          .slice(0, combined.length - MAX_ENTRIES)
          .map((e) => e.id)
          .filter((id) => id !== newEntry.id)
      : [];

    await withStore('readwrite', (s) => {
      s.put(newEntry);
      for (const id of toDelete) s.delete(id);
    });
  } catch (err) {
    console.warn('recordRecentBudget failed:', err);
  }
}

export async function removeRecentBudget(id) {
  try {
    await withStore('readwrite', (store) => store.delete(id));
  } catch (err) {
    console.warn('removeRecentBudget failed:', err);
  }
}
