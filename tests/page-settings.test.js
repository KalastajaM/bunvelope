// @vitest-environment jsdom
// Settings, Budget tab: every field saves on change, and what it hands to
// saveMeta is the whole meta with just that field changed (writes go through
// the shared updateMeta queue). Also the maintenance cards' buttons, which
// open the repair-links, duplicate-finder and payee-merge sheets. Drives the
// real js/pages/settings.js; saveMeta and the three sheet openers are mocked
// and asserted on.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../js/app.js', async () => (await import('./_fakes/pageApp.js')).appStub);
vi.mock('../js/data.js', async (importOriginal) => ({
  ...(await importOriginal()),
  saveMeta: vi.fn(async () => {}),
}));
// The Clean-up tab (#243) also runs each card's check when it opens.
vi.mock('../js/repair-links.js', () => ({ openRepairLinksSheet: vi.fn(), scanUnlinkedPayments: vi.fn(() => []) }));
vi.mock('../js/duplicates-sheet.js', () => ({ openDuplicatesSheet: vi.fn(), scanDuplicates: vi.fn(() => []) }));
vi.mock('../js/payee-merge-sheet.js', () => ({ openPayeeMergeSheet: vi.fn(), countPayeeGroups: vi.fn(() => 0) }));
vi.mock('../js/ui/download.js', async (importOriginal) => ({ ...(await importOriginal()), downloadBlob: vi.fn() }));

import { saveMeta } from '../js/data.js';
import { downloadBlob } from '../js/ui/download.js';
import { openRepairLinksSheet } from '../js/repair-links.js';
import { openDuplicatesSheet } from '../js/duplicates-sheet.js';
import { openPayeeMergeSheet } from '../js/payee-merge-sheet.js';
import { render } from '../js/pages/settings.js';
import { t } from '../js/ui/i18n.js';
import {
  appStub, state, session, writeBatch, updateStatusBar, resetState, mountHosts, flush, setValue, dialogOk, dialogButton, topOverlay, toastTexts,
} from './_fakes/pageApp.js';

const root = () => document.getElementById('app-root');
const el = (id) => root().querySelector(`#${id}`);
const savedMeta = () => saveMeta.mock.calls.at(-1)?.[1];
// The budget-meaning fields dispatch settings.update / month.clearReopen: the
// session writes meta inside its own batch, not through saveMeta.
const batchMeta = () => writeBatch.mock.calls.at(-1)?.[1].find(f => f.filename === 'budget-meta.json').data;
const statusOf = (input) => (input.closest('.field') || input.closest('.settings-toggle')).querySelector('.field-status')?.textContent;
const change = async (input, value) => { setValue(input, value, ['change']); await flush(); };
const toggle = async (input, on) => { input.checked = on; input.dispatchEvent(new Event('change', { bubbles: true })); await flush(); };
// The next dispatch answers with a version conflict, as a 409 from the server would.
const conflictOnce = () => dispatch.mockResolvedValueOnce({ ok: false, error: { code: 'version_conflict', params: {} } });
// The reload dialog is open; dismiss it so the next test can open its own.
async function expectConflictDialogAndDismiss() {
  expect(topOverlay()?.textContent).toContain(t('saveError.versionConflictBody'));
  dialogButton(t('saveError.dismiss')).click();
  await flush();
}

async function openPage() {
  mountHosts();
  await render(root());
}

let dispatch;

beforeEach(async () => {
  dispatch = vi.spyOn(session, 'dispatch');
  dispatch.mockClear();
  vi.stubGlobal('requestAnimationFrame', (cb) => setTimeout(cb, 0));
  vi.spyOn(console, 'error').mockImplementation(() => {});
  resetState();
  state.meta = { schemaVersion: 8, name: 'Household', currency: 'EUR', country: 'FI', scheduledTombstones: ['keep-me'] };
  saveMeta.mockReset();
  saveMeta.mockImplementation(async () => {});
  writeBatch.mockReset();
  writeBatch.mockImplementation(async () => {});
  for (const fn of [openRepairLinksSheet, openDuplicatesSheet, openPayeeMergeSheet]) fn.mockClear();
  updateStatusBar.mockClear();
  await openPage();
});

describe('autosaved budget fields', () => {
  it('opens on the Budget tab with the saved values', () => {
    expect(el('settings-name').value).toBe('Household');
    expect(el('settings-currency').value).toBe('EUR');
    expect(el('settings-country').value).toBe('FI');
    expect(el('settings-emergency-duration').value).toBe('6');
    expect(saveMeta).not.toHaveBeenCalled();
  });

  it('a renamed budget writes the trimmed name and leaves the rest of meta intact', async () => {
    await change(el('settings-name'), '  Family budget ');
    expect(saveMeta).toHaveBeenCalledTimes(1);
    expect(saveMeta.mock.calls[0][0]).toBe(state.budgetFolder);
    expect(savedMeta()).toEqual({
      schemaVersion: 8, name: 'Family budget', currency: 'EUR', country: 'FI', scheduledTombstones: ['keep-me'],
    });
    expect(state.meta).toBe(savedMeta());
    expect(statusOf(el('settings-name'))).toBe(t('settings.budget.saved'));
  });

  it('an emptied name keeps the current one rather than saving a blank', async () => {
    await change(el('settings-name'), '   ');
    expect(savedMeta().name).toBe('Household');
  });

  it('the country is written as chosen', async () => {
    await change(el('settings-country'), 'SE');
    expect(dispatch).toHaveBeenLastCalledWith('settings.update', { fields: { country: 'SE' } });
    expect(batchMeta().country).toBe('SE');
    expect(batchMeta().name).toBe('Household');
    expect(saveMeta).not.toHaveBeenCalled();
  });

  it('a number format is stored as chosen, and Automatic removes the key', async () => {
    await change(el('settings-locale'), 'de-DE');
    expect(dispatch).toHaveBeenLastCalledWith('settings.update', { fields: { locale: 'de-DE' } });
    expect(batchMeta().locale).toBe('de-DE');
    expect(updateStatusBar).toHaveBeenCalled();

    await change(el('settings-locale'), '');
    expect(dispatch).toHaveBeenLastCalledWith('settings.update', { fields: { locale: null } });
    expect(batchMeta()).not.toHaveProperty('locale');
  });

  it('offers each number format by its example, independent of the interface language', () => {
    const options = [...el('settings-locale').options];
    expect(options.map(o => o.value)).toEqual(['', 'fi-FI', 'de-DE', 'en-US', 'de-CH']);
    expect(options.find(o => o.value === 'en-US').textContent).toBe('1,234.56');
    expect(options.find(o => o.value === 'de-DE').textContent).toBe('1.234,56');
  });

  it('the emergency envelope is stored by id, and "none" as null', async () => {
    await change(el('settings-emergency-envelope'), 'rent');
    expect(dispatch).toHaveBeenLastCalledWith('settings.update', { fields: { emergency_envelope_id: 'rent' } });
    expect(batchMeta().emergency_envelope_id).toBe('rent');
    await change(el('settings-emergency-envelope'), '');
    expect(dispatch).toHaveBeenLastCalledWith('settings.update', { fields: { emergency_envelope_id: null } });
    expect(batchMeta().emergency_envelope_id).toBeNull();
  });

  it('the emergency duration is stored as a whole number of months', async () => {
    await change(el('settings-emergency-duration'), '9');
    expect(dispatch).toHaveBeenLastCalledWith('settings.update', { fields: { emergency_duration_months: 9 } });
    expect(batchMeta().emergency_duration_months).toBe(9);
  });

  it('an out-of-range duration is rejected: nothing written, field put back, error shown', async () => {
    await change(el('settings-emergency-duration'), '0');
    expect(dispatch).not.toHaveBeenCalled();
    expect(writeBatch).not.toHaveBeenCalled();
    expect(el('settings-emergency-duration').value).toBe('6');
    expect(statusOf(el('settings-emergency-duration'))).toContain(t('settings.emergency.durationInvalid'));
    expect(state.meta.emergency_duration_months).toBeUndefined();

    await change(el('settings-emergency-duration'), '121');
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('the credit source stores all or flagged', async () => {
    await change(el('settings-emergency-credit-source'), 'all');
    expect(dispatch).toHaveBeenLastCalledWith('settings.update', { fields: { emergency_credit_source: 'all' } });
    expect(batchMeta().emergency_credit_source).toBe('all');
    await change(el('settings-emergency-credit-source'), 'flagged');
    expect(batchMeta().emergency_credit_source).toBe('flagged');
  });

  it('the show-archived switches write their own key only', async () => {
    await toggle(el('settings-show-archived-envelopes'), true);
    expect(savedMeta().show_archived_envelopes).toBe(true);
    expect(savedMeta()).not.toHaveProperty('show_archived_accounts');
    await toggle(el('settings-show-archived-accounts'), true);
    expect(savedMeta()).toMatchObject({ show_archived_envelopes: true, show_archived_accounts: true });
    await toggle(el('settings-show-archived-envelopes'), false);
    expect(savedMeta().show_archived_envelopes).toBe(false);
  });

  it('a failed write puts the field back to what is saved and shows the error', async () => {
    writeBatch.mockImplementationOnce(async () => { throw new Error('offline'); });
    const before = state.meta;
    await change(el('settings-country'), 'DE');
    expect(state.meta).toBe(before);
    expect(el('settings-country').value).toBe('FI');
    expect(statusOf(el('settings-country'))).toContain(t('settings.budget.error')('').trim());
    expect(statusOf(el('settings-country'))).toContain('offline');
  });

  it('a version conflict opens the reload dialog and puts the field back, with no inline error', async () => {
    conflictOnce();
    await change(el('settings-country'), 'DE');
    expect(el('settings-country').value).toBe('FI');
    expect(statusOf(el('settings-country'))).toBe('');
    await expectConflictDialogAndDismiss();
  });

  it('two quick edits both land, the second on top of the first', async () => {
    setValue(el('settings-country'), 'SE', ['change']);
    setValue(el('settings-emergency-credit-source'), 'all', ['change']);
    await flush();
    expect(writeBatch).toHaveBeenCalledTimes(2);
    expect(batchMeta()).toMatchObject({ country: 'SE', emergency_credit_source: 'all' });
  });
});

describe('currency change', () => {
  it('asks first; cancelling puts the select back and writes nothing', async () => {
    setValue(el('settings-currency'), 'USD', ['change']);
    await flush();
    dialogButton(t('settings.budget.cancel')).click();
    await flush();
    expect(dispatch).not.toHaveBeenCalled();
    expect(el('settings-currency').value).toBe('EUR');
  });

  it('confirming writes the new currency and refreshes the status bar', async () => {
    setValue(el('settings-currency'), 'USD', ['change']);
    await flush();
    dialogOk().click();
    await flush();
    expect(dispatch).toHaveBeenLastCalledWith('settings.update', { fields: { currency: 'USD' } });
    expect(batchMeta().currency).toBe('USD');
    expect(batchMeta().name).toBe('Household');
    expect(state.meta.currency).toBe('USD');
    expect(updateStatusBar).toHaveBeenCalled();
  });

  it('a version conflict opens the reload dialog and puts the select back', async () => {
    setValue(el('settings-currency'), 'USD', ['change']);
    await flush();
    conflictOnce();
    dialogOk().click();
    await flush();
    expect(el('settings-currency').value).toBe('EUR');
    expect(statusOf(el('settings-currency'))).toBe('');
    await expectConflictDialogAndDismiss();
  });

  it('a failed write puts the select back', async () => {
    writeBatch.mockImplementationOnce(async () => { throw new Error('offline'); });
    setValue(el('settings-currency'), 'USD', ['change']);
    await flush();
    dialogOk().click();
    await flush();
    expect(el('settings-currency').value).toBe('EUR');
    expect(state.meta.currency).toBe('EUR');
  });
});

// The maintenance cards live on the Clean-up tab since #243.
describe('maintenance cards', () => {
  const cardButton = (titleKey) => [...root().querySelectorAll('.card')]
    .find(c => c.querySelector('h3')?.textContent === t(titleKey)).querySelector('button');

  beforeEach(async () => {
    root().querySelector('.content-tab[data-tab="cleanup"]').click();
    await flush();
  });
  afterEach(async () => {
    // Leave the module's remembered tab as the other tests expect it.
    root().querySelector('.content-tab[data-tab="budget"]')?.click();
    await flush();
  });

  it('the repair-links card opens its sheet, and writes nothing itself', () => {
    cardButton('repairLinks.settingsTitle').click();
    expect(openRepairLinksSheet).toHaveBeenCalledTimes(1);
    expect(saveMeta).not.toHaveBeenCalled();
  });

  it('the duplicate-finder card opens its sheet', () => {
    cardButton('duplicates.settingsTitle').click();
    expect(openDuplicatesSheet).toHaveBeenCalledTimes(1);
  });

  it('the payee-tidy card opens its sheet', () => {
    cardButton('payeeMerge.settingsTitle').click();
    expect(openPayeeMergeSheet).toHaveBeenCalledTimes(1);
  });
});

describe('tabs', () => {
  it('switching tab re-renders without writing anything', async () => {
    root().querySelector('.content-tab[data-tab="help"]').click();
    await flush();
    expect(root().querySelector('.content-tab.is-active').dataset.tab).toBe('help');
    expect(el('settings-name')).toBeNull();
    // Leave the module's remembered tab as we found it.
    root().querySelector('.content-tab[data-tab="budget"]').click();
    await flush();
    expect(el('settings-name')).toBeTruthy();
    expect(saveMeta).not.toHaveBeenCalled();
  });
});

describe('data export', () => {
  // Run under `npm run test:tz`: at 00:30 local east of UTC the UTC date is
  // still the day before.
  it("names the zip after the app clock's local day, not the UTC day", async () => {
    const spy = vi.spyOn(appStub, 'now').mockImplementation(() => new Date(2026, 8, 16, 0, 30));
    try {
      root().querySelector('.content-tab[data-tab="security"]').click();
      await flush();
      el('settings-export-zip').click();
      await vi.waitFor(() => expect(downloadBlob).toHaveBeenCalledWith('bunvelope-Household-2026-09-16.zip', expect.anything()));
    } finally {
      spy.mockRestore();
      root().querySelector('.content-tab[data-tab="budget"]').click();
      await flush();
    }
  });
});

describe('closing months automatically', () => {
  it('saves the chosen number of months; Off removes the key', async () => {
    expect(el('settings-auto-close').value).toBe('0');
    await change(el('settings-auto-close'), '3');
    expect(dispatch).toHaveBeenLastCalledWith('settings.update', { fields: { auto_close_after_months: 3 } });
    expect(batchMeta()).toEqual({
      financialHistory: expect.any(Object),
      schemaVersion: 8, name: 'Household', currency: 'EUR', country: 'FI', scheduledTombstones: ['keep-me'], auto_close_after_months: 3,
    });
    await change(el('settings-auto-close'), '0');
    expect(dispatch).toHaveBeenLastCalledWith('settings.update', { fields: { auto_close_after_months: null } });
    expect('auto_close_after_months' in batchMeta()).toBe(false);
  });

  it('lists reopened months, each with a way to close it again', async () => {
    state.meta = { ...state.meta, auto_close_after_months: 1, reopened_months: ['2026-06', '2026-07'] };
    await openPage();
    const buttons = () => [...el('settings-reopened-months').querySelectorAll('button')];
    expect(buttons().map(b => b.dataset.month)).toEqual(['2026-06', '2026-07']);
    buttons()[0].click();
    await flush();
    expect(dispatch).toHaveBeenLastCalledWith('month.clearReopen', { month: '2026-06' });
    expect(batchMeta().reopened_months).toEqual(['2026-07']);
    // Dropping the exception does not close the month by hand.
    expect(batchMeta().closed_months).toBeUndefined();
    expect(buttons().map(b => b.dataset.month)).toEqual(['2026-07']);
  });

  it('a version conflict on "close again" opens the reload dialog, not a toast', async () => {
    state.meta = { ...state.meta, auto_close_after_months: 1, reopened_months: ['2026-06'] };
    await openPage();
    conflictOnce();
    el('settings-reopened-months').querySelector('button').click();
    await flush();
    expect(toastTexts()).toEqual([]);
    expect(el('settings-reopened-months').querySelector('button').disabled).toBe(false);
    await expectConflictDialogAndDismiss();
  });

  it('no list while the automatic rule is off', async () => {
    state.meta = { ...state.meta, reopened_months: ['2026-06'] };
    await openPage();
    expect(el('settings-reopened-months').children).toHaveLength(0);
  });
});
