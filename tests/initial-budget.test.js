// The wizard's first save must be all-or-nothing: budget-meta.json on disk is
// what makes the next open skip the wizard.
import { describe, it, expect } from 'vitest';
import { writeInitialBudget } from '../js/state/initial-budget.js';
import { loadBudgetData, fileExists } from '../js/data.js';
import { createFakeFolder } from './_fakes/fakeFolder.js';

const bundle = () => ({
  envelopes: [{ id: 'food', name: 'Food', category: 'Basics' }],
  budgetItems: [],
  accounts: [{ id: 'a1', name: 'Main', initialBalance: 100 }],
  transactions: [{ id: 't1', type: 'expense', amount: 5, date: '2026-09-01', account: 'a1' }],
  envelopeTemplates: [],
  meta: { schemaVersion: 8, name: 'New budget', currency: 'EUR' },
});

describe('writeInitialBudget', () => {
  it('a failure part-way leaves no meta, so the wizard runs again', async () => {
    let fail = true;
    const { folder, files } = createFakeFolder({ failClose: name => fail && name === 'transactions.json' });
    await expect(writeInitialBudget(folder, bundle())).rejects.toThrow();
    expect(files.get('budget-meta.json') ?? '').toBe('');
    fail = false;
    // Once the folder is writable again the journal completes the publication
    // as one generation rather than a half-saved budget.
    const loaded = await loadBudgetData({ ...folder });
    expect(loaded.transactions.map(t => t.id)).toEqual(['t1']);
    expect(loaded.meta.name).toBe('New budget');
  });

  it('writes all six files in one publication', async () => {
    const { folder, files } = createFakeFolder();
    await writeInitialBudget(folder, bundle());
    expect(await fileExists(folder, 'budget-meta.json')).toBe(true);
    expect(JSON.parse(files.get('budget-meta.json')).write_seq).toBe(1);
    expect(JSON.parse(files.get('accounts.json'))).toEqual(bundle().accounts);
  });
});
