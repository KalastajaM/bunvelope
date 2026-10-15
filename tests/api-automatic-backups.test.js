import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAutomaticBackup, setEncryptionKey, setEncryptionRequired, writeBatch, flushWrites, hasPendingWrites } from '../js/storage/api-adapter.js';
import { restoreMigrationBackup, loadBudgetData } from '../js/storage/fsapi-adapter.js';
import { encryptJson } from '../js/storage/crypto.js';
import { createFakeFolder } from './_fakes/fakeFolder.js';

const bundle = () => ({ meta: { schemaVersion: 8, name: 'Local Postgres' }, accounts: [],
  transactions: [], envelopes: [], budgetItems: [], envelopeTemplates: [] });
const source = () => ({ kind: 'cloud', budgetId: 'budget-1', version: 1 });
const metadata = () => ({ owner: 'backup-owner', timestamp: Date.UTC(2026, 9, 8) });
const response = body => ({ ok: true, text: async () => JSON.stringify(body) });

afterEach(async () => {
  await flushWrites().catch(() => {});
  setEncryptionKey(null); setEncryptionRequired(false);
  vi.unstubAllGlobals();
});

describe('Postgres budget snapshots to a local folder', () => {
  it('reads after queued saves, writes a verified snapshot and restores the complete bundle', async () => {
    const data = bundle(); const calls = [];
    vi.stubGlobal('fetch', vi.fn(async (url, options) => {
      calls.push(options.method || 'GET');
      if (options.method === 'PUT') {
        data.meta.name = 'Saved before snapshot';
        return response({ version: 2 });
      }
      expect(url).toBe('/api/budgets/budget-1');
      return response({ ...data, version: 9 });
    }));
    const ref = source(); const target = createFakeFolder();
    const save = writeBatch(ref, [{ filename: 'budget-meta.json', data: { ...data.meta, name: 'Saved before snapshot' } }]);
    const backup = createAutomaticBackup(ref, target.folder, metadata());
    expect(hasPendingWrites()).toBe(true);
    const name = await backup; await save;
    expect(calls).toEqual(['PUT', 'GET']);
    // A read must not mask an optimistic-write conflict in the active budget.
    expect(ref.version).toBe(2);
    const restored = createFakeFolder();
    await restoreMigrationBackup(target.subdirs.get(name).folder, restored.folder);
    expect(await loadBudgetData(restored.folder)).toEqual(data);
    expect(hasPendingWrites()).toBe(false);
  });
  it('decrypts unlocked budgets into the explicitly disclosed plaintext backup format', async () => {
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
    setEncryptionRequired(true); setEncryptionKey(key);
    const data = bundle();
    const encrypted = Object.fromEntries(await Promise.all(Object.entries(data).map(async ([k, v]) => [k, await encryptJson(key, v)])));
    vi.stubGlobal('fetch', vi.fn(async () => response({ ...encrypted, version: 1 })));
    const target = createFakeFolder();
    const name = await createAutomaticBackup(source(), target.folder, metadata());
    expect(JSON.parse(target.subdirs.get(name).files.get('budget-meta.json'))).toEqual(data.meta);
  });
  it('refuses locked encrypted budgets, HTTP errors, and invalid schemas before creating a snapshot', async () => {
    for (const body of [{ ...bundle(), meta: { __enc: 1, ct: 'locked', iv: '' } },
      { ...bundle(), meta: { schemaVersion: 99 } }, { ...bundle(), meta: null }]) {
      vi.stubGlobal('fetch', vi.fn(async () => response(body)));
      const target = createFakeFolder();
      await expect(createAutomaticBackup(source(), target.folder, metadata())).rejects.toThrow();
      expect(target.subdirs.size).toBe(0);
    }
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 403, text: async () => '{"error":"not allowed"}' })));
    const target = createFakeFolder();
    await expect(createAutomaticBackup(source(), target.folder, metadata())).rejects.toThrow('not allowed');
    expect(target.subdirs.size).toBe(0);
  });
  it('does not turn an unavailable backup folder into a failed database save', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response({ ...bundle(), version: 2 })));
    const target = createFakeFolder({ permission: 'denied' });
    await expect(createAutomaticBackup(source(), target.folder, metadata())).rejects.toThrow('permission');
    await expect(flushWrites()).resolves.toBeUndefined();
    await writeBatch(source(), [{ filename: 'accounts.json', data: [] }]);
    await expect(flushWrites()).resolves.toBeUndefined();
  });
});
