// @vitest-environment jsdom
// Cloud picker, Delete: two steps. The first offers to export the budget
// first (and comes back after the export); the second asks for the budget's
// name typed out, and only a match deletes.
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../js/app.js', () => ({ state: { meta: null, budgetFolder: null }, now: () => new Date(2026, 8, 16, 12, 0) }));
vi.mock('../js/ui/sheet.js', () => ({ openSheet: ({ content }) => { document.body.append(content); return { close() {} }; } }));
vi.mock('../js/ui/toast.js', () => ({ toast: vi.fn() }));
vi.mock('../js/ui/dialog.js', () => ({ alertDialog: vi.fn(async () => {}), confirmDialog: vi.fn(), promptDialog: vi.fn() }));
vi.mock('../js/state/load-budget.js', () => ({ loadBudgetIntoState: vi.fn() }));
vi.mock('../js/storage/api-adapter.js', async (importOriginal) => ({
  ...(await importOriginal()),
  deleteCloudBudget: vi.fn(async () => {}),
}));
vi.mock('../js/storage/transfer.js', async (importOriginal) => ({
  ...(await importOriginal()),
  exportBudgetAsBundle: vi.fn(async () => ({ format: 'bundle' })),
}));
vi.mock('../js/ui/download.js', async (importOriginal) => ({ ...(await importOriginal()), downloadBudgetZip: vi.fn() }));

import { confirmDelete } from '../js/ui/cloud-budget-picker.js';
import { alertDialog, confirmDialog, promptDialog } from '../js/ui/dialog.js';
import { deleteCloudBudget } from '../js/storage/api-adapter.js';
import { downloadBudgetZip } from '../js/ui/download.js';
import { t } from '../js/ui/i18n.js';

const B = { id: 'b1', name: 'Family Home', version: 1 };

beforeEach(() => {
  vi.clearAllMocks();
});

describe('deleting a cloud budget', () => {
  it('offers Export first in the first step, then deletes after the typed name matches', async () => {
    confirmDialog.mockResolvedValueOnce(null).mockResolvedValueOnce(true);
    promptDialog.mockResolvedValueOnce(' Family Home ');
    const done = vi.fn();
    await confirmDelete(B, done);
    const opts = confirmDialog.mock.calls[0][1];
    expect(opts.dismissLabel).toBe(t('cloudPicker.deleteExportFirst'));
    expect(opts.danger).toBe(true);
    expect(downloadBudgetZip).toHaveBeenCalledTimes(1);
    expect(confirmDialog).toHaveBeenCalledTimes(2);
    expect(promptDialog.mock.calls[0][0]).toBe(t('cloudPicker.deleteTypeName')('Family Home'));
    expect(deleteCloudBudget).toHaveBeenCalledWith('b1');
    expect(done).toHaveBeenCalled();
  });

  it('a name that does not match deletes nothing and says so', async () => {
    confirmDialog.mockResolvedValueOnce(true);
    promptDialog.mockResolvedValueOnce('Family');
    await confirmDelete(B, vi.fn());
    expect(deleteCloudBudget).not.toHaveBeenCalled();
    expect(alertDialog.mock.calls[0][0]).toBe(t('cloudPicker.deleteNameMismatch'));
  });

  it('Cancel at either step deletes nothing', async () => {
    confirmDialog.mockResolvedValueOnce(false);
    await confirmDelete(B, vi.fn());
    expect(promptDialog).not.toHaveBeenCalled();
    confirmDialog.mockResolvedValueOnce(true);
    promptDialog.mockResolvedValueOnce(null);
    await confirmDelete(B, vi.fn());
    expect(deleteCloudBudget).not.toHaveBeenCalled();
  });
});
