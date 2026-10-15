// @vitest-environment jsdom
// Cloud picker, Export: the downloaded file is named bunvelope-<name>-<day>,
// where the day is the app clock's local date (not the UTC date, which just
// after local midnight east of UTC is still the day before). Run under
// `npm run test:tz`.
import { describe, it, expect, vi } from 'vitest';

vi.mock('../js/app.js', () => ({ state: { meta: null, budgetFolder: null }, now: () => new Date(2026, 8, 16, 0, 30) }));
vi.mock('../js/ui/sheet.js', () => ({ openSheet: ({ content }) => { document.body.append(content); return { close() {} }; } }));
vi.mock('../js/ui/toast.js', () => ({ toast: vi.fn() }));
vi.mock('../js/ui/dialog.js', () => ({ alertDialog: vi.fn(), confirmDialog: vi.fn(async () => true), promptDialog: vi.fn() }));
vi.mock('../js/state/load-budget.js', () => ({ loadBudgetIntoState: vi.fn() }));
vi.mock('../js/storage/api-adapter.js', async (importOriginal) => ({
  ...(await importOriginal()),
  listCloudBudgets: vi.fn(async () => [{ id: 'b1', name: 'Family Home', version: 1 }]),
}));
vi.mock('../js/storage/transfer.js', async (importOriginal) => ({
  ...(await importOriginal()),
  exportBudgetAsBundle: vi.fn(async () => ({ format: 'bundle' })),
}));
vi.mock('../js/ui/download.js', async (importOriginal) => ({ ...(await importOriginal()), downloadBudgetZip: vi.fn() }));

import { renderCloudPickerInto } from '../js/ui/cloud-budget-picker.js';
import { downloadBudgetZip, sanitiseFilename } from '../js/ui/download.js';
import { t } from '../js/ui/i18n.js';

const flush = () => new Promise(r => setTimeout(r, 0));

describe('cloud picker export', () => {
  it('downloads bunvelope-<name>-<local day>.zip', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    renderCloudPickerInto(host);
    await flush();
    const exportBtn = [...host.querySelectorAll('button')].find(b => b.textContent === t('cloudPicker.export'));
    exportBtn.click();
    await flush();
    expect(downloadBudgetZip).toHaveBeenCalledWith(`bunvelope-${sanitiseFilename('Family Home')}-2026-09-16.zip`, { format: 'bundle' });
  });
});
