// tests/import-export.test.js — verifies the cloud-mode transfer helpers.
// `fetch` is stubbed globally; we assert the sequence of HTTP calls and
// the shape of the uploaded/downloaded payloads.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  importBundleAsNewBudget,
  exportBudgetAsBundle,
} from '../js/storage/transfer.js';

function v7Bundle() {
  return {
    envelopes:         [{ id: 'e1', name: 'Food', category: 'Basics' }],
    budgetItems:       [{ id: 'i1', envelope_id: 'e1' }],
    transactions:      [
      { id: 't1', type: 'income',  date: '2026-04-01', amount: 1000, account: 'a1' },
      { id: 't2', type: 'expense', date: '2026-04-02', amount: 25,   account: 'a1' },
    ],
    accounts:          [{ id: 'a1', name: 'Main', initialBalance: 0 }],
    envelopeTemplates: [],
    meta: { schemaVersion: 8, name: 'Old name', currency: 'EUR' },
  };
}

function stubFetch(handler) {
  const calls = [];
  globalThis.fetch = vi.fn(async (url, opts = {}) => {
    calls.push({ url: String(url), opts });
    const res = await handler(String(url), opts);
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

describe('importBundleAsNewBudget', () => {
  beforeEach(() => { globalThis.fetch = undefined; });

  it('POSTs /api/budgets then PUTs all 6 kinds via /batch at version 0, with meta.name overridden', async () => {
    const calls = stubFetch(async (url, opts) => {
      if (opts?.method === 'POST' && url === '/api/budgets') {
        return { status: 201, body: { id: 'new-id', name: 'Cloud copy', version: 0 } };
      }
      if (opts?.method === 'PUT' && url === '/api/budgets/new-id/batch') {
        return { status: 200, body: { version: 1 } };
      }
      return { status: 404 };
    });

    const out = await importBundleAsNewBudget(v7Bundle(), 'Cloud copy');

    expect(out).toEqual({ id: 'new-id', name: 'Cloud copy', version: 1 });

    // One POST + one PUT, in that order.
    expect(calls[0].url).toBe('/api/budgets');
    expect(calls[0].opts.method).toBe('POST');
    expect(JSON.parse(calls[0].opts.body)).toEqual({ name: 'Cloud copy' });

    expect(calls[1].url).toBe('/api/budgets/new-id/batch');
    expect(calls[1].opts.method).toBe('PUT');
    const batchBody = JSON.parse(calls[1].opts.body);
    expect(batchBody.version).toBe(0);
    const kinds = batchBody.items.map((i) => i.kind).sort();
    expect(kinds).toEqual([
      'accounts', 'budgetItems', 'envelopeTemplates',
      'envelopes', 'meta', 'transactions',
    ].sort());
    const metaItem = batchBody.items.find((i) => i.kind === 'meta');
    expect(metaItem.data.name).toBe('Cloud copy');
    expect(metaItem.data.schemaVersion).toBe(8);
  });

  // §3.1 — a budget exported by one person and imported by another carried
  // the FIRST person's AI consent into the second person's account, and the
  // app treated it as theirs. Stripped on this side as well as on export,
  // because either can be reached without the other: a hand-copied folder
  // never goes through buildExportEntries, and this is the side that decides
  // what the app believes.
  it('never imports the exporting user’s AI consent', async () => {
    const calls = stubFetch(async (url, opts) => {
      if (opts?.method === 'POST' && url === '/api/budgets') {
        return { status: 201, body: { id: 'new-id', name: 'Cloud copy', version: 0 } };
      }
      if (opts?.method === 'PUT' && url === '/api/budgets/new-id/batch') {
        return { status: 200, body: { version: 1 } };
      }
      return { status: 404 };
    });

    const bundle = v7Bundle();
    bundle.meta.ai = {
      enabled: true, consentVersion: 3, dismissed: true,
      perFeature: { chat: true }, dismissedSubs: ['insights'],
    };
    await importBundleAsNewBudget(bundle, 'Cloud copy');

    const batchBody = JSON.parse(calls[1].opts.body);
    const metaItem = batchBody.items.find((i) => i.kind === 'meta');
    expect(metaItem.data.ai).toBeUndefined();
    // Everything else in meta still arrives.
    expect(metaItem.data.currency).toBe('EUR');
    expect(metaItem.data.name).toBe('Cloud copy');
    expect(metaItem.data.schemaVersion).toBe(8);
  });

  it('rejects a bundle at wrong schema version with a clear schema error', async () => {
    stubFetch(async () => ({ status: 200, body: {} }));
    const bundle = v7Bundle();
    bundle.meta.schemaVersion = 99;
    await expect(importBundleAsNewBudget(bundle, 'Whatever'))
      .rejects.toThrow(/schema v99/);
  });

  it('rejects an empty/invalid bundle with a validation error', async () => {
    stubFetch(async () => ({ status: 200, body: {} }));
    await expect(importBundleAsNewBudget({}, 'Whatever'))
      .rejects.toThrow(/validation/i);
  });

  it('rejects a blank name before touching the server', async () => {
    const calls = stubFetch(async () => ({ status: 200, body: {} }));
    await expect(importBundleAsNewBudget(v7Bundle(), '   '))
      .rejects.toThrow(/name/i);
    expect(calls).toHaveLength(0);
  });
});

describe('exportBudgetAsBundle', () => {
  beforeEach(() => { globalThis.fetch = undefined; });

  it('GETs /api/budgets/:id and strips the version field', async () => {
    const calls = stubFetch(async (url, opts) => {
      if ((!opts?.method || opts.method === 'GET') && url === '/api/budgets/b1') {
        return { status: 200, body: {
          version: 7,
          envelopes: [{ id: 'e1', name: 'Food', category: 'Basics' }],
          budgetItems: [],
          transactions: [],
          accounts: [],
          envelopeTemplates: [],
          meta: { schemaVersion: 6, name: 'Real' },
        } };
      }
      return { status: 404 };
    });

    const bundle = await exportBudgetAsBundle('b1');

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('/api/budgets/b1');
    expect(bundle).not.toHaveProperty('version');
    expect(bundle.meta).toEqual({ schemaVersion: 6, name: 'Real' });
    expect(bundle.envelopes[0].id).toBe('e1');
  });

  it('surfaces the server error on non-2xx', async () => {
    stubFetch(async () => ({ status: 404, body: { error: 'not found' } }));
    await expect(exportBudgetAsBundle('nope')).rejects.toThrow(/not found/);
  });

  it('decrypts an encrypted budget, so the backup can be re-imported', async () => {
    const { deriveKey, randomBytes, encryptJson } = await import('../js/storage/crypto.js');
    const api = await import('../js/storage/api-adapter.js');
    const key = await deriveKey('pw', randomBytes(16));
    const plain = v7Bundle();
    const enc = {};
    for (const k of ['envelopes', 'budgetItems', 'transactions', 'accounts', 'envelopeTemplates', 'meta']) {
      enc[k] = await encryptJson(key, plain[k]);
    }
    stubFetch(async (url) => (url === '/api/budgets/b1'
      ? { status: 200, body: { version: 3, ...enc } }
      : { status: 404 }));
    api.setEncryptionKey(key);
    try {
      const bundle = await exportBudgetAsBundle('b1');
      expect(bundle).not.toHaveProperty('version');
      expect(bundle).toEqual(plain);
    } finally {
      api.setEncryptionKey(null);
    }
  });

  it('refuses to export ciphertext when no key is loaded', async () => {
    const { deriveKey, randomBytes, encryptJson } = await import('../js/storage/crypto.js');
    const key = await deriveKey('pw', randomBytes(16));
    stubFetch(async () => ({ status: 200, body: {
      version: 1, envelopes: await encryptJson(key, []), budgetItems: [], transactions: [],
      accounts: [], envelopeTemplates: [], meta: { schemaVersion: 8 },
    } }));
    await expect(exportBudgetAsBundle('b1')).rejects.toThrow(/no key/);
  });
});
