import { describe, it, expect } from 'vitest';
import { loadBudgetData, writeBatch, writeJson, readJson, loadedSeq } from '../js/storage/fsapi-adapter.js';
import { computeAccountBalances, computeEnvelopeBalances } from '../js/engine.js';
import { createFakeFolder } from './_fakes/fakeFolder.js';

const JOURNAL = '.bunvelope-publish.json';
const names = ['transactions.json', 'accounts.json', 'envelopes.json', 'budget-items.json', 'envelope-templates.json', 'budget-meta.json'];
const intended = {
  'transactions.json': [{ id: 't', type: 'income', amount: 43.21, date: '2026-09-01', account: 'new' },
    { id: 'f', type: 'fill', amount: 12.34, date: '2026-09-01', envelope: 'food' }],
  'accounts.json': [{ id: 'new', name: 'New', initialBalance: 100 }],
  'envelopes.json': [{ id: 'food', name: 'Food' }],
  'budget-items.json': [{ id: 'b', name: 'Food', amount: 12.34 }],
  'envelope-templates.json': [{ id: 'template', name: 'Monthly', lines: [] }],
  'budget-meta.json': { schemaVersion: 8, write_seq: 3, name: 'Test' },
};
function setup(failClose = () => false) {
  const fake = createFakeFolder({ failClose });
  for (const name of names) fake.files.set(name, JSON.stringify(name === 'budget-meta.json' ? intended[name] : []));
  return fake;
}
const items = () => names.map(filename => ({ filename, data: structuredClone(intended[filename]) }));
const reopen = folder => ({ ...folder });

function assertComplete(bundle) {
  expect(bundle.transactions).toEqual(intended['transactions.json']);
  expect(bundle.accounts).toEqual(intended['accounts.json']);
  expect(bundle.envelopes).toEqual(intended['envelopes.json']);
  expect(bundle.budgetItems).toEqual(intended['budget-items.json']);
  expect(bundle.envelopeTemplates).toEqual(intended['envelope-templates.json']);
  const opts = { asOf: new Date('2026-09-15T12:00:00Z'), onlyPosted: true };
  expect(computeAccountBalances(bundle.accounts, bundle.transactions, opts))
    .toEqual(computeAccountBalances(intended['accounts.json'], intended['transactions.json'], opts));
  expect(computeEnvelopeBalances(bundle.transactions, opts))
    .toEqual(computeEnvelopeBalances(intended['transactions.json'], opts));
}

describe('durable local publication recovery', () => {
  it.each(names)('recovers a fresh handle after close fails on %s', async failed => {
    let fail = true;
    const { folder, files } = setup(name => fail && name === failed);
    await loadBudgetData(folder);
    await expect(writeBatch(folder, items())).rejects.toThrow(failed);
    fail = false;
    const fresh = reopen(folder);
    assertComplete(await loadBudgetData(fresh));
    expect(loadedSeq(fresh)).toBe(4);
    expect(JSON.parse(files.get(JOURNAL))).toBeNull();
  });

  it('recovers then refuses a stale retry instead of accepting mixed generations', async () => {
    let fail = true;
    const { folder } = setup(name => fail && name === 'accounts.json');
    await loadBudgetData(folder);
    await expect(writeBatch(folder, items())).rejects.toThrow('accounts.json');
    fail = false;
    await expect(writeJson(folder, 'transactions.json', [])).rejects.toThrow(/changed by another window/);
    assertComplete(await loadBudgetData(folder));
  });

  it('journal creation failure leaves every budget file unchanged', async () => {
    const { folder, files } = setup(name => name === JOURNAL);
    await loadBudgetData(folder);
    const before = new Map(files);
    await expect(writeBatch(folder, items())).rejects.toThrow(JOURNAL);
    for (const name of names) expect(files.get(name)).toBe(before.get(name));
  });

  it('journal cleanup failure is safely recoverable after metadata commits', async () => {
    let fail = true;
    const { folder } = setup((name, content) => fail && name === JOURNAL && content === 'null');
    await loadBudgetData(folder);
    await expect(writeBatch(folder, items())).rejects.toThrow(JOURNAL);
    fail = false;
    assertComplete(await loadBudgetData(reopen(folder)));
  });

  it.each(['accounts.json', 'budget-items.json', 'budget-meta.json'])('preserves a foreign change in %s while recovery is pending', async foreign => {
    let fail = true;
    const { folder, files } = setup(name => fail && name === 'accounts.json');
    await loadBudgetData(folder);
    await expect(writeBatch(folder, items())).rejects.toThrow();
    fail = false;
    files.set(foreign, JSON.stringify(foreign === 'budget-meta.json' ? { schemaVersion: 8, write_seq: 99 } : [{ id: 'foreign', name: 'Foreign' }]));
    const before = new Map(files);
    await expect(loadBudgetData(reopen(folder))).rejects.toThrow(/recovery|publication/i);
    expect(files).toEqual(before);
  });
  it('a direct collection reader completes recovery before returning data', async () => {
    let fail = true;
    const { folder } = setup(name => fail && name === 'accounts.json');
    await loadBudgetData(folder);
    await expect(writeBatch(folder, items())).rejects.toThrow();
    fail = false;
    expect(await readJson(reopen(folder), 'accounts.json')).toEqual(intended['accounts.json']);
    assertComplete(await loadBudgetData(reopen(folder)));
  });

  it('journals a first save before a folder has ever been loaded', async () => {
    let fail = true;
    const { folder } = createFakeFolder({ failClose: name => fail && name === 'accounts.json' });
    await expect(writeBatch(folder, items())).rejects.toThrow();
    fail = false;
    assertComplete(await loadBudgetData(reopen(folder)));
  });

  it('refuses reads while recovery still cannot close a required file', async () => {
    const { folder } = setup(name => name === 'accounts.json');
    await loadBudgetData(folder);
    await expect(writeBatch(folder, items())).rejects.toThrow();
    await expect(loadBudgetData(reopen(folder))).rejects.toThrow('accounts.json');
    await expect(readJson(folder, 'transactions.json')).rejects.toThrow('accounts.json');
  });

  it.each([
    { version: 2, before: {}, after: {} },
    { version: 1, before: { '../other.json': [] }, after: {} },
    { version: 1, before: intended, after: { ...intended, 'accounts.json': {} } },
  ])('rejects a malformed journal without changing files', async journal => {
    const { folder, files } = setup();
    files.set(JOURNAL, JSON.stringify(journal));
    const before = new Map(files);
    await expect(loadBudgetData(folder)).rejects.toThrow(/recovery/);
    expect(files).toEqual(before);
  });

  it('serializes readers behind a publication in progress', async () => {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    let entered;
    const started = new Promise(resolve => { entered = resolve; });
    const { folder } = setup(async name => {
      if (name === 'accounts.json') { entered(); await gate; }
      return false;
    });
    await loadBudgetData(folder);
    const saving = writeBatch(folder, items());
    await started;
    let readFinished = false;
    const reading = loadBudgetData(reopen(folder)).then(bundle => { readFinished = true; return bundle; });
    await Promise.resolve();
    expect(readFinished).toBe(false);
    release();
    await saving;
    assertComplete(await reading);
  });

  it.each(names)('recovers an empty newly created %s after its first close fails', async failed => {
    let fail = true;
    const { folder, files } = createFakeFolder({ failClose: name => fail && name === failed });
    await expect(writeBatch(folder, items())).rejects.toThrow(failed);
    expect(files.get(failed)).toBe('');
    fail = false;
    assertComplete(await loadBudgetData(reopen(folder)));
  });

  it.each(['', '{broken'])('preserves malformed existing files during recovery (%s)', async malformed => {
    let fail = true;
    const { folder, files } = setup(name => fail && name === 'accounts.json');
    await loadBudgetData(folder);
    await expect(writeBatch(folder, items())).rejects.toThrow();
    fail = false;
    files.set('accounts.json', malformed);
    const before = new Map(files);
    await expect(loadBudgetData(reopen(folder))).rejects.toThrow();
    expect(files).toEqual(before);
  });

  it('publishes the journaled metadata when caller mutates it during journal close', async () => {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    let entered;
    const started = new Promise(resolve => { entered = resolve; });
    let failCleanup = true;
    const { folder, files } = setup(async (name, content) => {
      if (name === JOURNAL && content !== 'null') { entered(); await gate; }
      return failCleanup && name === JOURNAL && content === 'null';
    });
    await loadBudgetData(folder);
    const batch = items();
    batch.find(item => item.filename === 'budget-meta.json').data.labels = ['original'];
    const saving = writeBatch(folder, batch);
    const rejected = expect(saving).rejects.toThrow(JOURNAL);
    await started;
    batch.find(item => item.filename === 'budget-meta.json').data.labels.push('late mutation');
    release();
    await rejected;
    expect(JSON.parse(files.get('budget-meta.json')).labels).toEqual(['original']);
    failCleanup = false;
    const reloaded = await loadBudgetData(reopen(folder));
    expect(reloaded.meta.labels).toEqual(['original']);
    assertComplete(reloaded);
  });

  it.each(['batch', 'single'])('snapshots %s input before permission waits', async mode => {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const { folder, files } = setup();
    await loadBudgetData(folder);
    folder.queryPermission = async () => { await gate; return 'granted'; };
    const meta = { schemaVersion: 8, labels: ['original'] };
    const saving = mode === 'batch'
      ? writeBatch(folder, [{ filename: 'budget-meta.json', data: meta }])
      : writeJson(folder, 'budget-meta.json', meta);
    meta.labels.push('late mutation');
    release();
    await saving;
    expect(JSON.parse(files.get('budget-meta.json')).labels).toEqual(['original']);
  });

  it('an empty journal left by a failed first journal close is idle, and is cleared', async () => {
    let fail = true;
    const { folder, files } = setup(name => fail && name === JOURNAL);
    await loadBudgetData(folder);
    await expect(writeBatch(folder, items())).rejects.toThrow(JOURNAL);
    expect(files.get(JOURNAL)).toBe('');
    fail = false;
    const before = new Map(files);
    const bundle = await loadBudgetData(reopen(folder));
    expect(bundle.transactions).toEqual([]);
    for (const name of names) expect(files.get(name)).toBe(before.get(name));
    expect(JSON.parse(files.get(JOURNAL))).toBeNull();
    // And the folder accepts saves again.
    await writeBatch(folder, items());
    assertComplete(await loadBudgetData(reopen(folder)));
  });

  it('journals only the collections a save changes, plus fingerprints of the rest', async () => {
    const journals = [];
    const { folder, files } = setup((name, content) => {
      if (name === JOURNAL && content !== 'null') journals.push(JSON.parse(content));
      return false;
    });
    files.set('accounts.json', JSON.stringify(intended['accounts.json']));
    await loadBudgetData(folder);
    await writeJson(folder, 'transactions.json', intended['transactions.json']);
    expect(journals).toHaveLength(1);
    const [journal] = journals;
    expect(Object.keys(journal.after).sort()).toEqual(['budget-meta.json', 'transactions.json']);
    expect(Object.keys(journal.before).sort()).toEqual([...names].sort());
    // Unchanged collections are fingerprinted, not copied.
    expect(JSON.stringify(journal)).not.toContain('"New"');
  });

  it('recovers a two-collection batch and still detects a foreign change to an unchanged collection', async () => {
    const pair = () => items().filter(i => ['transactions.json', 'accounts.json'].includes(i.filename));
    let fail = true;
    const { folder, files } = setup(name => fail && name === 'accounts.json');
    await loadBudgetData(folder);
    await expect(writeBatch(folder, pair())).rejects.toThrow('accounts.json');
    fail = false;
    const recovered = await loadBudgetData(reopen(folder));
    expect(recovered.transactions).toEqual(intended['transactions.json']);
    expect(recovered.accounts).toEqual(intended['accounts.json']);
    expect(recovered.envelopes).toEqual([]);

    fail = true;
    await expect(writeBatch(reopen(folder), pair())).rejects.toThrow();
    fail = false;
    files.set('envelopes.json', JSON.stringify([{ id: 'foreign', name: 'Foreign' }]));
    const before = new Map(files);
    await expect(loadBudgetData(reopen(folder))).rejects.toThrow(/envelopes\.json was changed outside/);
    expect(files).toEqual(before);
  });

  it('still recovers a version 1 journal written by an older build', async () => {
    const { folder, files } = setup();
    const before = Object.fromEntries(names.map(n => [n, JSON.parse(files.get(n))]));
    const after = { ...intended, 'budget-meta.json': { ...intended['budget-meta.json'], write_seq: 4 } };
    files.set(JOURNAL, JSON.stringify({ version: 1, before, after }));
    files.set('transactions.json', JSON.stringify(after['transactions.json'])); // half-published
    assertComplete(await loadBudgetData(folder));
    expect(JSON.parse(files.get(JOURNAL))).toBeNull();
  });

  it('does not treat an empty unrelated missing file as a publication destination', async () => {
    let fail = true;
    const { folder, files } = setup(name => fail && name === 'accounts.json');
    files.delete('budget-items.json');
    await loadBudgetData(folder);
    await expect(writeBatch(folder, items().filter(item => item.filename !== 'budget-items.json'))).rejects.toThrow();
    fail = false;
    files.set('budget-items.json', '');
    const before = new Map(files);
    await expect(loadBudgetData(reopen(folder))).rejects.toThrow();
    expect(files).toEqual(before);
  });

});
