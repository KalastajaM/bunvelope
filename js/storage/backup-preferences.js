// Device-local capabilities: never put folder handles into a budget/export.
export async function backupPreferences(value) {
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open('bunvelope-backups', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('budgets', { keyPath: 'id' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction('budgets', value ? 'readwrite' : 'readonly');
      const store = tx.objectStore('budgets');
      const request = value ? store.put(value) : store.getAll();
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = tx.onabort = () => reject(tx.error || request.error);
    });
  } finally { db.close(); }
}
