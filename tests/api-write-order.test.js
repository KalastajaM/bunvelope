import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '../js/storage/api-adapter.js';
const envelope = name => [{ id: 'e', name }];
let requests;
let counter = 0;
const ref = () => ({ kind: 'cloud', budgetId: `queue-${++counter}`, version: 0 });
const response = version => ({ ok: true, text: async () => JSON.stringify({ version }) });
beforeEach(() => {
  requests = [];
  api.setEncryptionKey(null); api.setEncryptionRequired(false);
  vi.stubGlobal('fetch', vi.fn(async (url, opts) => {
    const body = JSON.parse(opts.body);
    requests.push({ url, body });
    return response(body.version + 1);
  }));
});
afterEach(() => vi.unstubAllGlobals());
describe('cloud publication contract', () => {
  it('publishes an older batch before a later ordinary save', async () => {
    const budget = ref();
    await Promise.all([
      api.writeBatch(budget, [{ filename: 'envelopes.json', data: envelope('old') }]),
      api.saveEnvelopes(budget, envelope('new')),
    ]);
    expect(requests.map(r => (r.body.items?.[0].data ?? r.body.data)[0].name)).toEqual(['old', 'new']);
  });
  it('snapshots inputs before callers can mutate a queued save', async () => {
    const input = envelope('saved');
    const pending = api.saveEnvelopes(ref(), input);
    input[0].name = 'mutated';
    await pending;
    expect(requests[0].body.data[0].name).toBe('saved');
  });
  it('flush waits until pending requests finish', async () => {
    let release;
    vi.stubGlobal('fetch', () => new Promise(resolve => { release = () => resolve(response(1)); }));
    const pending = api.saveEnvelopes(ref(), envelope('saved'));
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    let flushed = false;
    const flush = api.flushWrites().then(() => { flushed = true; });
    await Promise.resolve(); await Promise.resolve();
    expect(flushed).toBe(false);
    release(); await pending; await flush;
    expect(flushed).toBe(true);
  });
  it('reports a save as pending until it lands, and not after a failure either', async () => {
    let release;
    vi.stubGlobal('fetch', () => new Promise(resolve => { release = () => resolve(response(1)); }));
    expect(api.hasPendingWrites()).toBe(false);
    const pending = api.saveEnvelopes(ref(), envelope('saved'));
    expect(api.hasPendingWrites()).toBe(true);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    release(); await pending;
    expect(api.hasPendingWrites()).toBe(false);
    vi.stubGlobal('fetch', async () => ({ ok: false, status: 500, text: async () => '{}' }));
    await expect(api.saveEnvelopes(ref(), envelope('x'))).rejects.toBeTruthy();
    expect(api.hasPendingWrites()).toBe(false);
    await api.flushWrites().catch(() => {});
  });
  it('ordinary saves reject invalid accounts before the network', async () => {
    await expect(api.saveAccounts(ref(), [{ id: 'a', name: 'bad', initialBalance: 'invalid' }])).rejects.toThrow(/Invalid accounts/);
    expect(requests).toEqual([]);
  });
  it('serializes distinct references to the same budget without upgrading stale versions', async () => {
    const a = ref(); const b = { ...a }; let active = 0; let maxActive = 0;
    vi.stubGlobal('fetch', async (_url, opts) => {
      active++; maxActive = Math.max(maxActive, active);
      await new Promise(resolve => setTimeout(resolve, 10)); active--;
      requests.push(JSON.parse(opts.body));
      return response(1);
    });
    await Promise.all([api.saveEnvelopes(a, envelope('a')), api.saveEnvelopes(b, envelope('b'))]);
    expect(maxActive).toBe(1);
    expect(requests.map(r => r.version)).toEqual([0, 0]);
  });
  it('flush reports a failed predecessor even when the next queued save succeeds', async () => {
    let call = 0;
    vi.stubGlobal('fetch', async () => ++call === 1
      ? { ok: false, status: 500, text: async () => JSON.stringify({ error: 'failed predecessor' }) }
      : response(1));
    const budget = ref();
    const failed = api.saveAccounts(budget, []).catch(() => {});
    const successful = api.saveEnvelopes(budget, []);
    await expect(api.flushWrites()).rejects.toThrow('failed predecessor');
    await failed; await successful;
  });
  it('flush drains independent writes before reporting a failure', async () => {
    let release;
    let calls = 0;
    vi.stubGlobal('fetch', async () => ++calls === 1
      ? { ok: false, status: 500, text: async () => JSON.stringify({ error: 'failed budget' }) }
      : new Promise(resolve => { release = () => resolve(response(1)); }));
    const failed = api.saveAccounts(ref(), []).catch(() => {});
    const delayed = api.saveAccounts(ref(), []);
    let flushed = false;
    const barrier = api.flushWrites().catch(err => { flushed = true; return err; });
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    await failed;
    expect(flushed).toBe(false);
    release(); await delayed;
    expect((await barrier).message).toBe('failed budget');
  });

  it.each([false, true])('appends only new history chunks and retains retry safety (encrypted=%s)', async encrypted => {
    const { appendFinancialHistory } = await import('../js/core/financial-history.js');
    const { decryptJson } = await import('../js/storage/crypto.js');
    const key = encrypted ? await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']) : null;
    api.setEncryptionKey(key, encrypted ? 'test-key' : null); api.setEncryptionRequired(encrypted);
    const budgetRef = ref();
    const before = { accounts: [{ id: 'bank', name: 'Bank', type: 'bank', initialBalance: 1 }],
      transactions: [], envelopes: [], budgetItems: [], envelopeTemplates: [], meta: { schemaVersion: 8 } };
    const data = { ...before, accounts: [{ ...before.accounts[0], initialBalance: 2 }] };
    data.meta = { ...data.meta, financialHistory: appendFinancialHistory(before, data, new Date('2026-10-08T12:00:00Z')) };
    await api.writeBatch(budgetRef, [{ filename: 'budget-meta.json', data: data.meta }]);
    expect(requests[0].body.items[0].historyChunks).toHaveLength(2);
    const next = { ...data, accounts: [{ ...data.accounts[0], initialBalance: 3 }] };
    next.meta = { ...data.meta, financialHistory: appendFinancialHistory(data, next, new Date('2026-10-08T13:00:00Z')) };
    const goodFetch = globalThis.fetch;
    vi.stubGlobal('fetch', async () => ({ ok: false, status: 503, text: async () => '{"error":"retry"}' }));
    await expect(api.writeBatch(budgetRef, [{ filename: 'budget-meta.json', data: next.meta }])).rejects.toThrow('retry');
    await api.flushWrites().catch(() => {});
    vi.stubGlobal('fetch', goodFetch);
    await api.writeBatch(budgetRef, [{ filename: 'budget-meta.json', data: next.meta }]);
    const item = requests[1].body.items[0];
    expect(item.historyChunks).toHaveLength(1);
    const chunk = encrypted ? await decryptJson(key, item.historyChunks[0].data) : item.historyChunks[0].data;
    expect(chunk.entries).toHaveLength(1);
    expect(chunk).not.toHaveProperty('baseline');
    expect(item.data.__enc === 1).toBe(encrypted);
    api.setEncryptionKey(null); api.setEncryptionRequired(false);
  });

});
