// @vitest-environment jsdom
// Cloud picker, Import from file: the Settings ZIP export imports as a new
// budget like the JSON bundle does, and a ZIP that is not a budget is refused
// with the same validation message (owner decision 5, 2026-10-05).
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../js/app.js', () => ({ state: { meta: null, budgetFolder: null }, now: () => new Date(2026, 9, 5, 12) }));
vi.mock('../js/ui/sheet.js', () => ({ openSheet: ({ content }) => { document.body.append(content); return { close() {} }; } }));
vi.mock('../js/ui/toast.js', () => ({ toast: vi.fn() }));
vi.mock('../js/ui/dialog.js', () => ({ alertDialog: vi.fn(async () => {}), confirmDialog: vi.fn(async () => false), promptDialog: vi.fn(async () => 'Restored') }));
vi.mock('../js/state/load-budget.js', () => ({ loadBudgetIntoState: vi.fn() }));
vi.mock('../js/storage/api-adapter.js', async (importOriginal) => ({
  ...(await importOriginal()),
  listCloudBudgets: vi.fn(async () => []),
}));
vi.mock('../js/storage/transfer.js', async (importOriginal) => ({
  ...(await importOriginal()),
  importBundleAsNewBudget: vi.fn(async (_bundle, name) => ({ id: 'new', name, version: 1 })),
}));

import { renderCloudPickerInto } from '../js/ui/cloud-budget-picker.js';
import { importBundleAsNewBudget } from '../js/storage/transfer.js';
import { alertDialog, confirmDialog } from '../js/ui/dialog.js';
import { makeZipBlob } from '../js/ui/zip.js';
import { buildExportEntries } from '../js/state/build-export-entries.js';
import { t } from '../js/ui/i18n.js';

const flush = () => new Promise(r => setTimeout(r, 0));
const st = {
  envelopes: [{ id: 'e1', name: 'Food' }], budgetItems: [], envelopeTemplates: [],
  transactions: [{ id: 't1', type: 'income', date: '2026-04-01', amount: 10, account: 'a1' }],
  accounts: [{ id: 'a1', name: 'Main', type: 'bank', initialBalance: 0 }],
  meta: { name: 'Family', schemaVersion: 8 },
};

async function importFile(file) {
  const host = document.createElement('div');
  document.body.append(host);
  renderCloudPickerInto(host);
  await flush();
  const click = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function () {
    Object.defineProperty(this, 'files', { value: [file], configurable: true });
    this.dispatchEvent(new Event('change'));
  });
  const btn = [...host.querySelectorAll('button')].find(b => b.textContent === t('cloudPicker.importFile'));
  btn.click();
  for (let i = 0; i < 5; i++) await flush();
  click.mockRestore();
  return btn;
}

beforeEach(() => {
  importBundleAsNewBudget.mockClear();
  alertDialog.mockClear();
  confirmDialog.mockReset().mockResolvedValue(false);
  document.body.replaceChildren();
});

describe('cloud picker import', () => {
  it('opens another file selection only when retry is chosen', async () => {
    confirmDialog.mockResolvedValueOnce(true);
    await importFile(new File(['{}'], 'invalid.json', { type: 'application/json' }));
    expect(confirmDialog).toHaveBeenCalledTimes(2);
    expect(importBundleAsNewBudget).not.toHaveBeenCalled();
  });
  it('imports the Settings ZIP export as a new budget', async () => {
    const zip = makeZipBlob(buildExportEntries(st));
    await importFile(new File([zip], 'bunvelope-family.zip', { type: 'application/zip' }));
    expect(alertDialog).not.toHaveBeenCalled();
    expect(importBundleAsNewBudget).toHaveBeenCalledTimes(1);
    const [bundle, name] = importBundleAsNewBudget.mock.calls[0];
    expect(name).toBe('Restored');
    expect(bundle.transactions).toEqual(st.transactions);
    expect(bundle.accounts).toEqual(st.accounts);
  });

  it('still imports the JSON bundle', async () => {
    await importFile(new File([JSON.stringify(st)], 'family.json', { type: 'application/json' }));
    expect(importBundleAsNewBudget.mock.calls[0][0].meta.name).toBe('Family');
  });

  it('refuses an incomplete ZIP, offers recovery, and creates nothing', async () => {
    const zip = makeZipBlob(buildExportEntries(st).filter(e => e.name !== 'transactions.json'));
    await importFile(new File([zip], 'partial.zip', { type: 'application/zip' }));
    expect(importBundleAsNewBudget).not.toHaveBeenCalled();
    expect(confirmDialog.mock.calls[0][0]).toContain(t('budgetImport.invalid'));
    expect(confirmDialog.mock.calls[0][1].okLabel).toBe(t('budgetImport.retry'));
    expect(confirmDialog).toHaveBeenCalledTimes(1);
  });
});
