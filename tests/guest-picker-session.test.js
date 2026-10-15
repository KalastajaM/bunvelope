// @vitest-environment jsdom
// Guest picker, Load example: the guest budget reuses one folder object, so
// only the budget session tells its old contents from the new. The example
// replaces guest memory while the old budget is still in `state`; the session
// must already have moved on by then, so a command still queued for the old
// budget is refused instead of writing the old rows into the example.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const seen = vi.hoisted(() => ({ atReset: null, before: null, heldAtReset: null }));

vi.mock('../js/app.js', () => ({ state: { meta: null, budgetFolder: null }, now: () => new Date(2026, 9, 2) }));
vi.mock('../js/ui/sheet.js', () => ({
  openSheet: ({ content }) => { document.body.append(content); return { close() {} }; },
}));
vi.mock('../js/ui/toast.js', () => ({ toast: vi.fn() }));
vi.mock('../js/ui/dialog.js', () => ({ alertDialog: vi.fn(), confirmDialog: vi.fn(async () => true) }));
vi.mock('../js/state/load-budget.js', () => ({ loadBudgetIntoState: vi.fn(async () => ({ loaded: true })) }));
vi.mock('../js/storage/guest-adapter.js', async () => {
  const { currentBudgetSession, budgetHeld } = await import('../js/state/budget-session.js');
  return {
    GUEST_FOLDER: { name: 'guest' },
    resetGuestMemory: vi.fn(),
    replaceGuestMemory: vi.fn(() => { seen.atReset = currentBudgetSession(); seen.heldAtReset = budgetHeld(); }),
    monthsToShift: () => 0,
    shiftBudgetFiles: (files) => files,
  };
});

import { openGuestBudgetPicker } from '../js/ui/guest-budget-picker.js';
import { replaceGuestMemory } from '../js/storage/guest-adapter.js';
import { alertDialog } from '../js/ui/dialog.js';
import { state } from '../js/app.js';
import { loadBudgetIntoState } from '../js/state/load-budget.js';
import { currentBudgetSession, beginBudgetSession, budgetHeld } from '../js/state/budget-session.js';
import { t } from '../js/ui/i18n.js';

beforeEach(() => {
  beginBudgetSession();
  vi.clearAllMocks();
  seen.atReset = null;
  document.body.innerHTML = '';
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => [] })));
});

describe('guest picker, Load example', () => {
  it('starts a new budget session before it replaces guest memory', async () => {
    openGuestBudgetPicker();
    seen.before = currentBudgetSession();
    const btn = [...document.querySelectorAll('button')].find(b => b.textContent === t('guestPicker.loadExample'));
    btn.click();
    await vi.waitFor(() => expect(seen.atReset).not.toBeNull());
    expect(seen.atReset).toBeGreaterThan(seen.before);
    // And holds it: no new command writes the old rows into the example
    // either, until the load that follows publishes it.
    expect(seen.heldAtReset).toBe(true);
  });
});


it('releases the hold and retains displayed state when replacement fails', async () => {
  const oldMeta = { name: 'Old budget' };
  state.meta = oldMeta;
  replaceGuestMemory.mockImplementationOnce(() => { throw new Error('Invalid example'); });
  openGuestBudgetPicker();
  [...document.querySelectorAll('button')].find(b => b.textContent === t('guestPicker.loadExample')).click();
  await vi.waitFor(() => expect(alertDialog).toHaveBeenCalled());
  expect(state.meta).toBe(oldMeta);
  expect(budgetHeld()).toBe(false);
  expect(loadBudgetIntoState).not.toHaveBeenCalled();
});

describe('guest picker, Open an export (owner decision 5, 2026-10-05)', () => {
  it('opens the Settings ZIP into guest memory, without the exporter\'s AI consent', async () => {
    const { makeZipBlob } = await import('../js/ui/zip.js');
    const entries = [
      { name: 'envelopes.json', data: '[]' },
      { name: 'budget-items.json', data: '[]' },
      { name: 'transactions.json', data: JSON.stringify([{ id: 't1', type: 'income', date: '2026-04-01', amount: 10, account: 'a1' }]) },
      { name: 'accounts.json', data: JSON.stringify([{ id: 'a1', name: 'Main', type: 'bank', initialBalance: 0 }]) },
      { name: 'envelope-templates.json', data: '[]' },
      { name: 'budget-meta.json', data: JSON.stringify({ name: 'Family', schemaVersion: 8, ai: { enabled: true } }) },
    ];
    const file = new File([makeZipBlob(entries)], 'family.zip', { type: 'application/zip' });
    const click = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function () {
      Object.defineProperty(this, 'files', { value: [file], configurable: true });
      this.dispatchEvent(new Event('change'));
    });
    openGuestBudgetPicker();
    [...document.querySelectorAll('button')].find(b => b.textContent === t('guestPicker.openFile')).click();
    await vi.waitFor(() => expect(loadBudgetIntoState).toHaveBeenCalled());
    click.mockRestore();
    const items = replaceGuestMemory.mock.calls[0][0];
    const byFile = Object.fromEntries(items.map(i => [i.filename, i.data]));
    expect(byFile['transactions.json']).toHaveLength(1);
    expect(byFile['budget-meta.json'].name).toBe('Family');
    expect(byFile['budget-meta.json'].ai).toBeUndefined();
    expect(alertDialog).not.toHaveBeenCalled();
  });
});
