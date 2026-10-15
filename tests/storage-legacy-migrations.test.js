// tests/storage-legacy-migrations.test.js — the destructive v2→v3 and v3→v4
// FSAPI on-disk migrations. These run exactly once per budget folder and
// rewrite the user's files in place, so the transform AND the safety backup
// are pinned. (v5+ migrations are covered by storage-adapter.test.js.)

import { describe, it, expect } from 'vitest';
import { createFakeFolder } from './_fakes/fakeFolder.js';
import { loadBudgetData } from '../js/storage/fsapi-adapter.js';

function seed(files, name, data) {
  files.set(name, JSON.stringify(data));
}

describe('FSAPI v2→v3 migration', () => {
  async function runV2Fixture() {
    const { folder, files, subdirs } = createFakeFolder();
    // v2 shape: envelope rows carry the budget config inline, and
    // transactions reference envelopes by "Category: Name" strings.
    seed(files, 'envelopes.json', [
      {
        category: 'Food', envelope: 'Groceries',
        default_amount: 200, include: true,
        monthly_schedule: { Jan: true }, payment_day: 5,
      },
      { category: 'Home', envelope: 'Rent', default_amount: 900 },
    ]);
    seed(files, 'transactions.json', [
      { id: 't1', type: 'expense', amount: 12.5, date: '2024-01-10', envelope: 'Food: Groceries' },
      {
        id: 't2', type: 'fill', date: '2024-01-01',
        lines: [{ envelope: 'Food: Groceries', amount: 50, mode: 'add' }],
      },
      { id: 't3', type: 'envelope_transfer', amount: 10, date: '2024-01-12', from_envelope: 'Food: Groceries', to_envelope: 'Home: Rent' },
      { id: 't4', type: 'adjustment', target: 'envelope', target_id: 'Food: Groceries', amount: -3, date: '2024-01-13' },
    ]);
    seed(files, 'budget-meta.json', { name: 'Legacy', schemaVersion: 2 });
    const bundle = await loadBudgetData(folder);
    return { bundle, files, subdirs };
  }

  it('splits envelope rows into envelopes + budget items with stable ids', async () => {
    const { bundle } = await runV2Fixture();
    expect(bundle.envelopes.map(e => ({ id: e.id, name: e.name, category: e.category }))).toEqual([
      { id: 'food-groceries', name: 'Groceries', category: 'Food' },
      { id: 'home-rent', name: 'Rent', category: 'Home' },
    ]);
    const item = bundle.budgetItems.find(b => b.envelope_id === 'food-groceries');
    expect(item).toMatchObject({ default_amount: 200, payment_day: 5, include: true });
    expect(item.monthly_schedule).toEqual({ Jan: true });
  });

  it('rewrites every envelope reference shape in transactions', async () => {
    const { bundle } = await runV2Fixture();
    const byId = Object.fromEntries(bundle.transactions.map(t => [t.id, t]));
    expect(byId.t1.envelope_id).toBe('food-groceries');
    expect(byId.t1.envelope).toBeUndefined();
    expect(byId.t2.lines[0].envelope_id).toBe('food-groceries');
    expect(byId.t2.lines[0].envelope).toBeUndefined();
    expect(byId.t3.from_envelope_id).toBe('food-groceries');
    expect(byId.t3.to_envelope_id).toBe('home-rent');
    expect(byId.t4.target_id).toBe('food-groceries');
  });

  it('writes a backup of the original files before transforming', async () => {
    const { subdirs } = await runV2Fixture();
    const backupName = [...subdirs.keys()].find(k => k.startsWith('backup-v2-'));
    expect(backupName).toBeTruthy();
    const backup = subdirs.get(backupName);
    const oldEnvelopes = JSON.parse(backup.files.get('envelopes.json'));
    expect(oldEnvelopes[0]).toMatchObject({ category: 'Food', envelope: 'Groceries' });
    expect(backup.files.has('transactions.json')).toBe(true);
  });

  it('lands on the current schema version on disk', async () => {
    const { bundle, files } = await runV2Fixture();
    expect(bundle.meta.schemaVersion).toBe(8);
    expect(JSON.parse(files.get('budget-meta.json')).schemaVersion).toBe(8);
    // The v3→v4 step also ran: archived flags exist.
    expect(bundle.envelopes.every(e => e.archived === false)).toBe(true);
  });
});

describe('FSAPI v2→v3 migration — interrupted', () => {
  const v2Envelopes = [{ category: 'Food', envelope: 'Groceries', default_amount: 200 }];
  const v2Txs = [{ id: 't1', type: 'expense', amount: 12.5, date: '2024-01-10', envelope: 'Food: Groceries' }];

  it('a failed migration write does not leave a half-migrated folder that migrates twice', async () => {
    let fail = true;
    const { folder, files } = createFakeFolder({ failClose: name => fail && name === 'transactions.json' });
    seed(files, 'envelopes.json', v2Envelopes);
    seed(files, 'transactions.json', v2Txs);
    seed(files, 'budget-meta.json', { name: 'Legacy', schemaVersion: 2 });
    await expect(loadBudgetData(folder)).rejects.toThrow();
    fail = false;
    const bundle = await loadBudgetData({ ...folder });
    expect(bundle.envelopes.map(e => [e.id, e.name])).toEqual([['food-groceries', 'Groceries']]);
    expect(bundle.budgetItems[0]).toMatchObject({ envelope_id: 'food-groceries', default_amount: 200 });
    expect(bundle.transactions[0].envelope_id).toBe('food-groceries');
    expect(JSON.parse(files.get('budget-meta.json')).schemaVersion).toBe(8);
  });

  it('keeps envelopes and items an older build already converted, and still rewrites v2 transactions', async () => {
    // What an older build left behind when its separate migration saves
    // failed before meta: v3 envelopes and items, v2 meta and transactions.
    const { folder, files } = createFakeFolder();
    seed(files, 'envelopes.json', [{ id: 'food-groceries', name: 'Groceries', category: 'Food' }]);
    seed(files, 'budget-items.json', [{ id: 'item-food-groceries', envelope_id: 'food-groceries', default_amount: 200 }]);
    seed(files, 'transactions.json', v2Txs);
    seed(files, 'budget-meta.json', { name: 'Legacy', schemaVersion: 2 });
    const bundle = await loadBudgetData(folder);
    expect(bundle.envelopes.map(e => [e.id, e.name])).toEqual([['food-groceries', 'Groceries']]);
    expect(bundle.budgetItems).toHaveLength(1);
    expect(bundle.budgetItems[0]).toMatchObject({ id: 'item-food-groceries', default_amount: 200 });
    expect(bundle.transactions[0].envelope_id).toBe('food-groceries');
    expect(bundle.transactions[0].envelope).toBeUndefined();
  });

  it('publishes the whole migration as one write', async () => {
    const { folder, files } = createFakeFolder();
    seed(files, 'envelopes.json', v2Envelopes);
    seed(files, 'transactions.json', v2Txs);
    seed(files, 'budget-meta.json', { name: 'Legacy', schemaVersion: 2 });
    await loadBudgetData(folder);
    expect(JSON.parse(files.get('budget-meta.json')).write_seq).toBe(1);
  });
});

describe('FSAPI v3→v4 migration', () => {
  async function runV3Fixture() {
    const { folder, files, subdirs } = createFakeFolder();
    seed(files, 'envelopes.json', [{ id: 'food', name: 'Food', category: 'food' }]);
    seed(files, 'accounts.json', [{ id: 'a1', name: 'Checking', type: 'bank' }]);
    seed(files, 'budget-items.json', []);
    seed(files, 'transactions.json', []);
    seed(files, 'budget-meta.json', { name: 'V3', schemaVersion: 3 });
    const bundle = await loadBudgetData(folder);
    return { bundle, files, subdirs };
  }

  it('adds archived flags to envelopes and accounts, preserving existing fields', async () => {
    const { bundle } = await runV3Fixture();
    expect(bundle.envelopes[0]).toMatchObject({ id: 'food', name: 'Food', archived: false });
    expect(bundle.accounts[0]).toMatchObject({ id: 'a1', name: 'Checking', type: 'bank', archived: false });
  });

  it('does not overwrite an explicit archived value', async () => {
    const { folder, files } = createFakeFolder();
    seed(files, 'envelopes.json', [{ id: 'old', name: 'Old', archived: true }]);
    seed(files, 'accounts.json', []);
    seed(files, 'budget-items.json', []);
    seed(files, 'transactions.json', []);
    seed(files, 'budget-meta.json', { schemaVersion: 3 });
    const bundle = await loadBudgetData(folder);
    expect(bundle.envelopes[0].archived).toBe(true);
  });

  it('writes a v3 backup and bumps the schema version', async () => {
    const { bundle, subdirs } = await runV3Fixture();
    const backupName = [...subdirs.keys()].find(k => k.startsWith('backup-v3-'));
    expect(backupName).toBeTruthy();
    expect(JSON.parse(subdirs.get(backupName).files.get('accounts.json'))[0].archived).toBeUndefined();
    expect(bundle.meta.schemaVersion).toBe(8);
  });
});
