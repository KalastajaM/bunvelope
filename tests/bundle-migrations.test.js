import { it, expect, vi, afterEach } from 'vitest';
import { migrateBundle } from '../js/storage/bundle-migrations.js';
import { loadBudgetData, setEncryptionKey, setEncryptionRequired } from '../js/storage/api-adapter.js';
import { importBundleAsNewBudget } from '../js/storage/transfer.js';
import { encryptJson, decryptJson, isEncrypted } from '../js/storage/crypto.js';

const legacy = () => ({
  envelopes: [{ envelope: 'Food', category: 'Basics', default_amount: 100 }],
  transactions: [{ id: 't1', type: 'expense', amount: 20, date: '2020-01-01', envelope: 'Basics: Food' }],
  accounts: [{ id: 'a', name: 'Bank', initialBalance: 100 }], budgetItems: [], envelopeTemplates: [],
  meta: { schemaVersion: 2, name: 'Legacy' },
});
afterEach(() => { vi.unstubAllGlobals(); setEncryptionKey(null); setEncryptionRequired(false); });
const response = (body, status = 200) => ({ ok: status < 400, status, text: async () => JSON.stringify(body) });
it('upgrades without mutating source data, preserves identities on retry, and rejects malformed/future data', () => {
  const input = legacy();
  const before = structuredClone(input);
  const { bundle, changed } = migrateBundle(input);
  expect(input).toEqual(before);
  expect(bundle.meta.schemaVersion).toBe(8);
  expect(bundle.envelopes[0]).toMatchObject({ id: 'basics-food', name: 'Food', archived: false });
  expect(bundle.transactions[0].envelope_id).toBe('basics-food');
  expect(changed.at(-1)).toBe('meta');
  expect(migrateBundle(bundle)).toEqual({ bundle, changed: [] });
  expect(() => migrateBundle({ ...input, meta: { schemaVersion: 99 } })).toThrow('newer version');
  expect(() => migrateBundle({ ...input, accounts: {} })).toThrow('validation');
});
it('decrypts a legacy cloud budget, then encrypts every upgraded collection in one version-checked batch', async () => {
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  const input = legacy();
  const encrypted = Object.fromEntries(await Promise.all(Object.entries(input).map(async ([k, v]) => [k, await encryptJson(key, v)])));
  const writes = [];
  vi.stubGlobal('fetch', vi.fn(async (_url, opts = {}) => {
    if (opts.method !== 'PUT') return response({ ...encrypted, version: 4 });
    writes.push(JSON.parse(opts.body));
    return response({ version: 5 });
  }));
  setEncryptionKey(key); setEncryptionRequired(true);
  const ref = { kind: 'cloud', budgetId: 'b', version: 0 };
  const out = await loadBudgetData(ref);
  expect(out.meta.schemaVersion).toBe(8);
  expect(ref.version).toBe(5);
  expect(writes).toHaveLength(1);
  expect(writes[0].version).toBe(4);
  expect(writes[0].items.at(-1).kind).toBe('meta');
  for (const item of writes[0].items) {
    expect(isEncrypted(item.data)).toBe(true);
    expect(await decryptJson(key, item.data)).toEqual(out[item.kind]);
  }
});
it('a failed cloud migration returns no upgraded budget and can retry from the original copy', async () => {
  let fail = true;
  vi.stubGlobal('fetch', vi.fn(async (_url, opts = {}) => opts.method === 'PUT'
    ? fail ? response({ error: 'version conflict' }, 409) : response({ version: 5 })
    : response({ ...legacy(), version: 4 })));
  const ref = { kind: 'cloud', budgetId: 'b', version: 0 };
  await expect(loadBudgetData(ref)).rejects.toMatchObject({ status: 409 });
  fail = false;
  expect((await loadBudgetData(ref)).envelopes[0].id).toBe('basics-food');
});
it('migrates an imported bundle before creating a cloud budget', async () => {
  const calls = [];
  vi.stubGlobal('fetch', vi.fn(async (url, opts = {}) => {
    calls.push({ url, body: JSON.parse(opts.body) });
    return response(opts.method === 'POST' ? { id: 'new', name: 'Copy', version: 0 } : { version: 1 });
  }));
  const input = legacy();
  await importBundleAsNewBudget(input, 'Copy');
  expect(calls).toHaveLength(2);
  const meta = calls[1].body.items.find(i => i.kind === 'meta').data;
  expect(meta).toMatchObject({ schemaVersion: 8, name: 'Copy' });
  expect(input.meta.schemaVersion).toBe(2);
});
