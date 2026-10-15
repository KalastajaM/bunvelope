import { describe, it, expect } from 'vitest';
import { appendFinancialHistory, initialHistory, compactFinancialHistory, historyPoint } from '../js/core/financial-history.js';
import { comparisonData } from '../js/core/comparison.js';
import { packHistoryMeta, unpackHistoryMeta, chunkId } from '../js/storage/history-chunks.js';
import { encryptJson, decryptJson } from '../js/storage/crypto.js';
import { createFakeFolder } from './_fakes/fakeFolder.js';
import { writeBatch, loadBudgetData, readJson, createAutomaticBackup, restoreMigrationBackup } from '../js/storage/fsapi-adapter.js';
const at = day => new Date(`2026-10-${day}T12:00:00.000Z`);
const budget = () => ({ accounts: [{ id: 'bank', name: 'Bank', type: 'bank', initialBalance: 100 }],
  envelopes: [], transactions: [], budgetItems: [], envelopeTemplates: [], meta: { schemaVersion: 8 } });
const change = (data, n, day = '08') => {
  const next = { ...data, accounts: [{ ...data.accounts[0], initialBalance: n }] };
  next.meta = { ...data.meta, financialHistory: appendFinancialHistory(data, next, at(day)) };
  return next;
};
const reorder = value => Array.isArray(value) ? value.map(reorder)
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).reverse().map(([k, v]) => [k, reorder(v)])) : value;
const split = () => {
  let data = change(budget(), 120, '07');
  const previous = data.meta.financialHistory;
  data.meta = { ...data.meta, financialHistory: { ...initialHistory(data, at('08')), gap: true,
    previous: [{ ...previous, until: '2026-10-07' }] } };
  return data;
};

describe('history continuity and lossless consolidation', () => {
  it('survives recursively reordered JSON keys without a gap or an extra snapshot', () => {
    const data = reorder(change(budget(), 120));
    expect(appendFinancialHistory(data, data, at('09'))).toEqual(data.meta.financialHistory);
    expect(historyPoint(data, '2026-10-08').data.accounts[0].initialBalance).toBe(100);
    expect(change(data, 140, '09').meta.financialHistory.previous).toBeUndefined();
  });
  it('joins verified adjacent segments, preserves every revision, and is idempotent', () => {
    const data = split();
    const after = change(data, 150, '09');
    const compacted = compactFinancialHistory(after.meta.financialHistory);
    expect(compacted.previous).toBeUndefined();
    expect(compacted.entries).toHaveLength(2);
    expect(compactFinancialHistory(compacted)).toBe(compacted);
    expect(historyPoint(after, '2026-10-07').data.accounts[0].initialBalance).toBe(100);
    expect(historyPoint(after, '2026-10-09').data.accounts[0].initialBalance).toBe(120);
    expect(compacted.head).toEqual(comparisonData(after));
  });
  it('preserves unknown days, genuine edits, malformed diffs, and clock reversals', () => {
    for (const edit of [
      h => { h.start = { at: at('10').toISOString(), date: '2026-10-10' }; },
      h => { h.head.accounts[0].initialBalance = 999; },
      h => { h.entries = [{ at: at('08').toISOString(), date: '2026-10-08', diff: { accounts: {} } }]; },
      h => { h.start.at = at('06').toISOString(); },
    ]) {
      const history = structuredClone(split().meta.financialHistory); edit(history);
      expect(compactFinancialHistory(history)).toEqual(history);
    }
  });
});

describe('immutable history chunks', () => {
  it('writes one baseline, then only new revisions, even after a storage reload', async () => {
    const first = change(budget(), 120);
    const packed = await packHistoryMeta(first.meta);
    const chunks = new Map(packed.chunks.map(c => [c.id, reorder(c.data)]));
    const loaded = await unpackHistoryMeta(reorder(packed.meta), id => chunks.get(id));
    expect(loaded.meta.financialHistory).toEqual(first.meta.financialHistory);
    const next = change({ ...first, meta: loaded.meta }, 130, '09');
    const update = await packHistoryMeta(next.meta, loaded.cache);
    expect(update.chunks).toHaveLength(1);
    expect(update.chunks[0].data.entries).toHaveLength(1);
    expect(update.chunks[0].data).not.toHaveProperty('baseline');
    update.chunks.forEach(c => chunks.set(c.id, c.data));
    expect((await unpackHistoryMeta(update.meta, id => chunks.get(id))).meta).toEqual(next.meta);
    expect((await packHistoryMeta(next.meta, update.cache)).chunks).toEqual([]);
  });
  it('keeps encrypted baselines and diffs opaque and validates checksums before decoding', async () => {
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
    const data = change(budget(), 120);
    const packed = await packHistoryMeta(data.meta, null, v => encryptJson(key, v));
    expect(packed.chunks.every(c => c.data.__enc === 1)).toBe(true);
    const chunks = new Map(packed.chunks.map(c => [c.id, c.data]));
    expect((await unpackHistoryMeta(packed.meta, id => chunks.get(id), v => decryptJson(key, v))).meta).toEqual(data.meta);
    await expect(unpackHistoryMeta(packed.meta, () => null)).rejects.toThrow(/Missing or damaged/);
    await expect(unpackHistoryMeta(packed.meta, () => ({ broken: true }))).rejects.toThrow(/Missing or damaged/);
    expect(await chunkId({ a: 1, b: { c: 2, d: 3 } })).toBe(await chunkId({ b: { d: 3, c: 2 }, a: 1 }));
  });
  it('does not serialize a changed head as if it matched a cached prefix', async () => {
    const data = change(budget(), 120);
    const packed = await packHistoryMeta(data.meta);
    const broken = structuredClone(data.meta);
    broken.financialHistory.head.accounts[0].initialBalance = 999;
    const result = await packHistoryMeta(broken, packed.cache);
    expect(result.cache).toBeNull();
    expect(result.meta).toEqual(broken);
  });
});

const filenames = { accounts: 'accounts.json', envelopes: 'envelopes.json', transactions: 'transactions.json',
  budgetItems: 'budget-items.json', envelopeTemplates: 'envelope-templates.json', meta: 'budget-meta.json' };
describe('folder history storage', () => {
  it('keeps metadata small and reloads complete history after incremental saves', async () => {
    const { folder, files } = createFakeFolder();
    const first = change(budget(), 120);
    await writeBatch(folder, Object.entries(first).map(([kind, data]) => ({ filename: filenames[kind], data })));
    const physical = JSON.parse(files.get('budget-meta.json'));
    expect(physical.financialHistory.storage).toBe('history-chunks-v1');
    expect(physical.financialHistory.head).toBeUndefined();
    const before = new Map([...files].filter(([name]) => name.startsWith('.bunvelope-history-')));
    const loaded = await loadBudgetData(folder);
    expect(loaded.meta.financialHistory).toEqual(first.meta.financialHistory);
    const orphan = `.bunvelope-history-${'a'.repeat(64)}.json`;
    files.set(orphan, '{}');
    const next = change(loaded, 140, '09');
    await writeBatch(folder, [{ filename: 'accounts.json', data: next.accounts }, { filename: 'budget-meta.json', data: next.meta }]);
    expect(files.has(orphan)).toBe(false);
    for (const [name, text] of before) expect(files.get(name)).toBe(text);
    expect([...files.keys()].filter(n => n.startsWith('.bunvelope-history-')).length).toBe(before.size + 1);
    expect((await readJson(folder, 'budget-meta.json')).financialHistory).toEqual(next.meta.financialHistory);
    expect((await loadBudgetData(folder)).meta.financialHistory.entries).toHaveLength(2);
  });
  it('fails closed when a referenced sidecar is missing', async () => {
    const { folder, files } = createFakeFolder();
    const data = change(budget(), 120);
    await writeBatch(folder, Object.entries(data).map(([kind, data]) => ({ filename: filenames[kind], data })));
    files.delete([...files.keys()].find(n => n.startsWith('.bunvelope-history-')));
    await expect(loadBudgetData(folder)).rejects.toThrow(/Missing or damaged/);
  });
  it('makes automatic backups independent of the live sidecar files', async () => {
    const source = createFakeFolder(), destination = createFakeFolder(), restored = createFakeFolder();
    const data = change(budget(), 120);
    await writeBatch(source.folder, Object.entries(data).map(([kind, data]) => ({ filename: filenames[kind], data })));
    const name = await createAutomaticBackup(source.folder, destination.folder, { owner: 'history-test', timestamp: at('09').getTime() });
    const backup = destination.subdirs.get(name);
    expect(JSON.parse(backup.files.get('budget-meta.json')).financialHistory.version).toBe(1);
    source.files.clear();
    await restoreMigrationBackup(backup.folder, restored.folder);
    expect((await loadBudgetData(restored.folder)).meta.financialHistory).toEqual(data.meta.financialHistory);
  });

});
