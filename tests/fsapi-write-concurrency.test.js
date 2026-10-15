// §1.1 — two writers on one folder must not clobber each other's ledger.
//
// The guard is a `write_seq` counter in budget-meta.json: the adapter records
// what it loaded, re-reads it immediately before publishing, and refuses when
// another writer moved it. These tests drive the adapter module directly (not
// the facade) because the guard is FSAPI-specific — cloud mode already has
// optimistic concurrency on every PUT.
import { describe, it, expect, beforeEach } from 'vitest';
import {
  writeJson, writeBatch, loadBudgetData,
  rememberLoadedSeq, loadedSeq, forgetLoadedSeq, StaleBudgetError,
  FILE_META, FILE_TRANSACTIONS, CURRENT_SCHEMA_VERSION,
} from '../js/storage/fsapi-adapter.js';
import { createFakeFolder } from './_fakes/fakeFolder.js';

/** Seed a fake folder with a loadable, schema-current budget. */
function seedBudget({ write_seq = 0 } = {}) {
  const fake = createFakeFolder();
  const put = (name, val) => fake.files.set(name, JSON.stringify(val));
  put('envelopes.json', []);
  put('budget-items.json', []);
  put('transactions.json', []);
  put('accounts.json', []);
  put('envelope-templates.json', []);
  put(FILE_META, { schemaVersion: CURRENT_SCHEMA_VERSION, write_seq });
  return fake;
}

const readMeta = files => JSON.parse(files.get(FILE_META));

/** A transaction row that passes validateTransactions. */
const tx = id => ({ id, type: 'expense', amount: 1, date: '2026-01-01' });

describe('fsapi write_seq guard', () => {
  beforeEach(() => { /* WeakMap state is per-handle; fakes are fresh each test */ });

  it('loadBudgetData records the on-disk write_seq', async () => {
    const { folder } = seedBudget({ write_seq: 108 });
    await loadBudgetData(folder);
    expect(loadedSeq(folder)).toBe(108);
  });

  it('a folder that was never loaded is not guarded', async () => {
    const { folder, files } = createFakeFolder();
    await writeJson(folder, 'a.json', { x: 1 });
    expect(JSON.parse(files.get('a.json'))).toEqual({ x: 1 });
    // No meta stamped: unguarded folders are written straight through.
    expect(files.has(FILE_META)).toBe(false);
    expect(loadedSeq(folder)).toBeUndefined();
  });

  it('a successful write bumps write_seq and stamps the writer', async () => {
    const { folder, files } = seedBudget({ write_seq: 108 });
    await loadBudgetData(folder);

    await writeJson(folder, FILE_TRANSACTIONS, [tx('t1')]);

    const meta = readMeta(files);
    expect(meta.write_seq).toBe(109);
    expect(typeof meta.last_writer).toBe('string');
    expect(typeof meta.last_modified).toBe('string');
    expect(meta.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(loadedSeq(folder)).toBe(109);
  });

  it('refuses a write when another writer moved write_seq', async () => {
    const { folder, files } = seedBudget({ write_seq: 108 });
    await loadBudgetData(folder);

    // Another window/program writes the folder behind our back.
    files.set(FILE_META, JSON.stringify({
      schemaVersion: CURRENT_SCHEMA_VERSION, write_seq: 109,
    }));

    await expect(writeJson(folder, FILE_TRANSACTIONS, [tx('t1')]))
      .rejects.toThrow(StaleBudgetError);
    // And nothing was written — the ledger on disk is untouched.
    expect(JSON.parse(files.get(FILE_TRANSACTIONS))).toEqual([]);
    expect(JSON.parse(files.get(FILE_META)).write_seq).toBe(109);
  });

  it('the second of two stale batches is refused, and writes nothing', async () => {
    // The scenario from the plan: tab A saves, then tab B saves against a
    // ledger it loaded before A's write.
    const { folder, files } = seedBudget({ write_seq: 5 });
    await loadBudgetData(folder);          // both "tabs" loaded at seq 5

    // Tab A saves.
    await writeBatch(folder, [{ filename: FILE_TRANSACTIONS, data: [tx('a')] }]);
    expect(readMeta(files).write_seq).toBe(6);

    // Tab B still believes it is at 5.
    rememberLoadedSeq(folder, { write_seq: 5 });
    await expect(writeBatch(folder, [
      { filename: FILE_TRANSACTIONS, data: [tx('b')] },
    ])).rejects.toThrow(/changed by another window/);

    // Tab A's transaction survives; nothing was half-written.
    expect(JSON.parse(files.get(FILE_TRANSACTIONS))).toEqual([tx('a')]);
    expect(readMeta(files).write_seq).toBe(6);
  });

  it('writes meta last, so a mid-batch failure leaves the counter unmoved', async () => {
    const { folder, files } = seedBudget({ write_seq: 3 });
    await loadBudgetData(folder);
    forgetLoadedSeq(folder);
    rememberLoadedSeq(folder, { write_seq: 3 });

    // Make one collection fail.
    const failing = createFakeFolder({ failOn: new Set(['accounts.json']) });
    for (const [k, v] of files) failing.files.set(k, v);
    rememberLoadedSeq(failing.folder, { write_seq: 3 });

    await expect(writeBatch(failing.folder, [
      { filename: FILE_TRANSACTIONS, data: [tx('x')] },
      { filename: 'accounts.json',   data: [] },
    ])).rejects.toThrow(/accounts\.json/);

    expect(JSON.parse(failing.files.get(FILE_META)).write_seq).toBe(3);
  });

  it('a batch that includes meta still gets the counter stamped onto it', async () => {
    const { folder, files } = seedBudget({ write_seq: 1 });
    await loadBudgetData(folder);

    await writeBatch(folder, [
      { filename: FILE_TRANSACTIONS, data: [] },
      { filename: FILE_META, data: { schemaVersion: CURRENT_SCHEMA_VERSION, theme: 'dark' } },
    ]);

    const meta = readMeta(files);
    expect(meta.theme).toBe('dark');
    expect(meta.write_seq).toBe(2);
  });
});
