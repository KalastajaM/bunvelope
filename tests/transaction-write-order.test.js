// Transaction writes must land on disk in the order they were issued.
//
// The session (every transaction write the app makes) writes the whole
// transactions.json through writeBatch, and saveTransactions writes it alone.
// If one of them reaches the adapter queue out of call order, an older
// snapshot lands last and silently deletes rows that are still in memory.
// This drives the real FSAPI adapter through the data.js facade, so it holds
// the adapter's own ordering guarantee the session relies on.
import { describe, it, expect } from 'vitest';
import { loadBudgetData, saveTransactions, writeBatch, writeJson, flushWrites } from '../js/data.js';
import { createFakeFolder } from './_fakes/fakeFolder.js';

const tx = id => ({ id, type: 'expense', amount: 1, date: '2026-01-01', account: 'a1' });

function seed(failClose) {
  const fake = createFakeFolder({ failClose });
  for (const name of ['envelopes.json', 'budget-items.json', 'transactions.json',
    'envelope-templates.json']) fake.files.set(name, '[]');
  fake.files.set('accounts.json', JSON.stringify([{ id: 'a1', name: 'Main', initialBalance: 0 }]));
  fake.files.set('budget-meta.json', JSON.stringify({ schemaVersion: 8, write_seq: 1 }));
  return fake;
}

const diskIds = files => JSON.parse(files.get('transactions.json')).map(t => t.id);

describe('transaction write ordering', () => {
  it('a writeBatch issued after chained saveTransactions calls does not get overwritten by them', async () => {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    let slowFirst = true;
    const { folder, files } = seed(async name => {
      if (name === 'transactions.json' && slowFirst) { slowFirst = false; await gate; }
      return false;
    });
    await loadBudgetData(folder);

    const p1 = saveTransactions(folder, [tx('t1')]);
    const p2 = saveTransactions(folder, [tx('t1'), tx('t2')]);
    // A session-style write built from the latest rows.
    const p3 = writeBatch(folder, [{ filename: 'transactions.json', data: [tx('t1'), tx('t2'), tx('t3')] }]);

    release();
    await Promise.all([p1, p2, p3]);
    await flushWrites();
    expect(diskIds(files)).toEqual(['t1', 't2', 't3']);
  });

  it('writeJson reserves its queue slot at call time, before the permission check resolves', async () => {
    const { folder, files } = seed(() => false);
    await loadBudgetData(folder);
    let calls = 0;
    // The first permission query is slow, the second fast: order must still hold.
    folder.queryPermission = async () => {
      calls++;
      if (calls === 1) await new Promise(r => setTimeout(r, 10));
      return 'granted';
    };
    const a = writeJson(folder, 'transactions.json', [tx('old')]);
    const b = writeJson(folder, 'transactions.json', [tx('new')]);
    await Promise.all([a, b]);
    expect(diskIds(files)).toEqual(['new']);
  });
});
