// tests/storage-adapter.test.js — round-trip + migration checks for both
// adapters. Runs in the default 'node' environment so no browser is needed.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createFakeFolder } from './_fakes/fakeFolder.js';

// Import the adapters directly so we don't depend on runtime mode selection.
import * as fsapi from '../js/storage/fsapi-adapter.js';
import * as api   from '../js/storage/api-adapter.js';

// ── FSAPI adapter ─────────────────────────────────────────────────────────

describe('fsapi-adapter', () => {
  it('reports a folder write as pending until it lands', async () => {
    const { folder } = createFakeFolder();
    await fsapi.flushWrites();
    expect(fsapi.hasPendingWrites()).toBe(false);
    const write = fsapi.saveEnvelopes(folder, [{ id: 'e1', name: 'Food', category: 'Basics' }]);
    expect(fsapi.hasPendingWrites()).toBe(true);
    await write.catch(() => {});
    await fsapi.flushWrites();
    expect(fsapi.hasPendingWrites()).toBe(false);
  });

  it('round-trips a v7 bundle across save + load', async () => {
    const { folder } = createFakeFolder();
    const meta = { schemaVersion: 8, currency: 'EUR', name: 'Test',
      emergency_envelope_id: null, emergency_duration_months: 6,
      emergency_credit_source: 'flagged' };
    await fsapi.saveMeta(folder, meta);
    await fsapi.saveEnvelopes(folder, [{ id: 'e1', name: 'Food', category: 'Basics' }]);
    await fsapi.saveAccounts(folder, [{ id: 'a1', name: 'Main', initialBalance: 100 }]);
    await fsapi.saveTransactions(folder, [
      { id: 't1', type: 'income', date: '2026-04-01', amount: 1000, account: 'a1' },
    ]);
    await fsapi.saveBudgetItems(folder, []);
    await fsapi.saveEnvelopeTemplates(folder, []);
    await fsapi.flushWrites();

    const out = await fsapi.loadBudgetData(folder);
    expect(out.meta.schemaVersion).toBe(8);
    expect(out.meta.emergency_credit_source).toBe('flagged');
    expect(out.envelopes).toHaveLength(1);
    expect(out.accounts[0].name).toBe('Main');
    expect(out.transactions[0].amount).toBe(1000);
  });

  it('round-trips emergency_credit_source: "all"', async () => {
    const { folder } = createFakeFolder();
    const meta = { schemaVersion: 8, currency: 'EUR', name: 'Test',
      emergency_envelope_id: null, emergency_duration_months: 6,
      emergency_credit_source: 'all' };
    await fsapi.saveMeta(folder, meta);
    await fsapi.saveEnvelopes(folder, []);
    await fsapi.saveAccounts(folder, []);
    await fsapi.saveTransactions(folder, []);
    await fsapi.saveBudgetItems(folder, []);
    await fsapi.flushWrites();

    const out = await fsapi.loadBudgetData(folder);
    expect(out.meta.emergency_credit_source).toBe('all');
  });

  it('migrates a v5 bundle through to v7 in one load (additive)', async () => {
    const { folder, files } = createFakeFolder();
    const v5Meta = { schemaVersion: 5, currency: 'EUR', name: 'V5' };
    await fsapi.saveMeta(folder, v5Meta);
    await fsapi.saveEnvelopes(folder, [{ id: 'e1', name: 'Food', category: 'Basics' }]);
    await fsapi.saveAccounts(folder, [{ id: 'a1', name: 'Main', initialBalance: 0 }]);
    await fsapi.saveTransactions(folder, []);
    await fsapi.saveBudgetItems(folder, []);
    await fsapi.flushWrites();

    const out = await fsapi.loadBudgetData(folder);

    expect(out.meta.schemaVersion).toBe(8);
    expect(out.meta.emergency_envelope_id).toBeNull();
    expect(out.meta.emergency_duration_months).toBe(6);
    expect(out.meta.emergency_credit_source).toBe('flagged');
    // The migration must have written meta back to disk at v7 so subsequent
    // loads skip the migration path.
    const persistedMeta = JSON.parse(files.get('budget-meta.json'));
    expect(persistedMeta.schemaVersion).toBe(8);
    expect(persistedMeta.emergency_credit_source).toBe('flagged');
  });

  it('migrates a v6 bundle to v7 by adding emergency_credit_source default', async () => {
    const { folder, files } = createFakeFolder();
    const v6Meta = { schemaVersion: 6, currency: 'EUR', name: 'V6',
      emergency_envelope_id: null, emergency_duration_months: 6 };
    await fsapi.saveMeta(folder, v6Meta);
    await fsapi.saveEnvelopes(folder, []);
    await fsapi.saveAccounts(folder, []);
    await fsapi.saveTransactions(folder, []);
    await fsapi.saveBudgetItems(folder, []);
    await fsapi.flushWrites();

    const out = await fsapi.loadBudgetData(folder);
    expect(out.meta.schemaVersion).toBe(8);
    expect(out.meta.emergency_credit_source).toBe('flagged');
    const persistedMeta = JSON.parse(files.get('budget-meta.json'));
    expect(persistedMeta.schemaVersion).toBe(8);
    expect(persistedMeta.emergency_credit_source).toBe('flagged');
  });
});

// ── API adapter ──────────────────────────────────────────────────────────

function stubFetch(handler) {
  const calls = [];
  globalThis.fetch = vi.fn(async (url, opts = {}) => {
    calls.push({ url, opts });
    const res = await handler(url, opts);
    const body = res.body ?? '';
    return {
      ok: res.status >= 200 && res.status < 300,
      status: res.status,
      statusText: res.statusText || '',
      text: async () => typeof body === 'string' ? body : JSON.stringify(body),
    };
  });
  return calls;
}

describe('api-adapter', () => {
  beforeEach(() => { globalThis.fetch = undefined; });

  it('loadBudgetData fetches once and maps the bundle shape', async () => {
    stubFetch(async (url) => {
      if (String(url).startsWith('/api/budgets/b1')) {
        return { status: 200, body: {
          version: 3,
          envelopes: [{ id: 'e1', name: 'Food', category: 'Basics' }],
          budgetItems: [],
          transactions: [],
          accounts: [{ id: 'a1', name: 'Main', initialBalance: 0 }],
          envelopeTemplates: [],
          meta: { schemaVersion: 8, name: 'Cloud' },
        } };
      }
      return { status: 404 };
    });
    const ref = { kind: 'cloud', budgetId: 'b1', version: 0 };
    const out = await api.loadBudgetData(ref);
    expect(out.meta.schemaVersion).toBe(8);
    expect(out.envelopes[0].id).toBe('e1');
    expect(ref.version).toBe(3);
  });

  it('upgrades a cloud bundle at a lower schema version', async () => {
    stubFetch(async () => ({
      status: 200,
      body: {
        version: 1,
        envelopes: [{ id: 'e1', name: 'Food', category: 'Basics' }],
        budgetItems: [],
        transactions: [],
        accounts: [{ id: 'a1', name: 'Main', initialBalance: 0 }],
        envelopeTemplates: [],
        meta: { schemaVersion: 5 },
      },
    }));
    const ref = { kind: 'cloud', budgetId: 'b1', version: 0 };
    const out = await api.loadBudgetData(ref);
    expect(out.meta).toMatchObject({ schemaVersion: 8, emergency_duration_months: 6, emergency_credit_source: 'flagged' });
  });

  it('saveEnvelopes PUTs with current version and bumps version on success', async () => {
    const calls = stubFetch(async (url, opts) => {
      if (opts?.method === 'PUT' && String(url).includes('/collections/envelopes')) {
        const body = JSON.parse(opts.body);
        expect(body.version).toBe(7);
        return { status: 200, body: { version: 8 } };
      }
      return { status: 404 };
    });
    const ref = { kind: 'cloud', budgetId: 'b1', version: 7 };
    await api.saveEnvelopes(ref, [{ id: 'e1', name: 'Food', category: 'Basics' }]);
    expect(ref.version).toBe(8);
    expect(calls[0].url).toBe('/api/budgets/b1/collections/envelopes');
  });

  it('409 version conflict surfaces the server message', async () => {
    stubFetch(async () => ({ status: 409, body: { error: 'version conflict', current: 9 } }));
    const ref = { kind: 'cloud', budgetId: 'b1', version: 5 };
    await expect(api.saveEnvelopes(ref, []))
      .rejects.toMatchObject({ status: 409 });
  });

  it('writeBatch maps filenames to kinds and uses /batch', async () => {
    const calls = stubFetch(async (url, opts) => {
      if (opts?.method === 'PUT' && String(url).endsWith('/batch')) {
        const body = JSON.parse(opts.body);
        expect(body.items.map((i) => i.kind))
          .toEqual(['transactions', 'meta']);
        return { status: 200, body: { version: 2 } };
      }
      return { status: 404 };
    });
    const ref = { kind: 'cloud', budgetId: 'b1', version: 1 };
    await api.writeBatch(ref, [
      { filename: 'transactions.json', data: [] },
      { filename: 'budget-meta.json',  data: { schemaVersion: 8 } },
    ]);
    expect(ref.version).toBe(2);
    expect(calls[0].url).toBe('/api/budgets/b1/batch');
  });

  it('encrypts writes and decrypts reads when a key is set', async () => {
    const { deriveKey, randomBytes, isEncrypted } = await import('../js/storage/crypto.js');
    const key = await deriveKey('pw', randomBytes(16));
    api.setEncryptionKey(key);
    try {
      let stored = null;
      stubFetch(async (url, opts) => {
        if (opts?.method === 'PUT' && String(url).includes('/collections/envelopes')) {
          const body = JSON.parse(opts.body);
          stored = body.data;
          return { status: 200, body: { version: 1 } };
        }
        if (String(url).startsWith('/api/budgets/b1') && !opts?.method) {
          return { status: 200, body: {
            version: 1,
            envelopes: stored,
            budgetItems: [], transactions: [], accounts: [],
            envelopeTemplates: [],
            meta: { schemaVersion: 8 },
          } };
        }
        return { status: 404 };
      });
      const ref = { kind: 'cloud', budgetId: 'b1', version: 0 };
      const plaintext = [{ id: 'e1', name: 'Food', category: 'Basics' }];
      await api.saveEnvelopes(ref, plaintext);
      expect(isEncrypted(stored)).toBe(true);

      // Read back — should decrypt transparently.
      const ref2 = { kind: 'cloud', budgetId: 'b1', version: 0 };
      const out = await api.loadBudgetData(ref2);
      expect(out.envelopes).toEqual(plaintext);
    } finally {
      api.setEncryptionKey(null);
    }
  });

  it('rejects decrypting an encrypted blob when no key is set', async () => {
    const { deriveKey, randomBytes, encryptJson } = await import('../js/storage/crypto.js');
    const key = await deriveKey('pw', randomBytes(16));
    const wrapper = await encryptJson(key, [{ id: 'e1', name: 'x', category: 'y' }]);
    stubFetch(async () => ({ status: 200, body: {
      version: 1,
      envelopes: wrapper, budgetItems: [], transactions: [], accounts: [],
      envelopeTemplates: [], meta: { schemaVersion: 8 },
    } }));
    api.setEncryptionKey(null);
    const ref = { kind: 'cloud', budgetId: 'b1', version: 0 };
    await expect(api.loadBudgetData(ref)).rejects.toThrow(/no key is set/);
  });

  it('serialises concurrent saves so versions stay in lockstep', async () => {
    let serverVersion = 0;
    stubFetch(async (_url, opts) => {
      if (opts?.method !== 'PUT') return { status: 404 };
      const body = JSON.parse(opts.body);
      if (body.version !== serverVersion) {
        return { status: 409, body: { error: 'version conflict', current: serverVersion } };
      }
      serverVersion++;
      return { status: 200, body: { version: serverVersion } };
    });
    const ref = { kind: 'cloud', budgetId: 'b1', version: 0 };
    // Fire three saves without awaiting — the adapter must queue them so
    // each sees the previous call's bumped version.
    await Promise.all([
      api.saveEnvelopes(ref, []),
      api.saveAccounts(ref, []),
      api.saveTransactions(ref, []),
    ]);
    expect(ref.version).toBe(3);
  });
});
