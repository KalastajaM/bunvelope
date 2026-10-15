// e2e/fsapi-mode.spec.js — static / File System Access API mode, end to end.
//
// The native folder picker cannot be driven headlessly, so e2e/fake-folder.js
// swaps window.showDirectoryPicker for a fake handle backed by a Map in this
// process. The app's real FSAPI adapter does everything after the pick, and the
// specs assert on the files that reach the "folder":
//
//   1. open an existing budget folder → edit → the write lands in
//      transactions.json → reload, reopen the folder → the edit is still there
//   2. open an empty folder → setup wizard → the budget files are created

import { test, expect } from '@playwright/test';
import { preparePage, goTo, addExpense, accountCard, envelopeCard } from './static-helpers.js';
import { installFakeFolder, readBudgetFolder } from './fake-folder.js';

// The example budget is in EUR with Finnish separators: "€ 1 997,70".
const money = (text) => Number(text.replace(/[^0-9,\-−]/g, '').replace(',', '.').replace('−', '-'));

async function openFolder(page) {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Welcome to Bunvelope' })).toBeVisible();
  await page.getByRole('button', { name: 'Open folder…' }).click();
}

// Account cards show one figure in .env-amt; envelope cards several, and the
// one named "In envelope" is the balance.
async function balanceOf(card) {
  await expect(card).toBeVisible();
  const bal = card.locator('.env-fig--balance');
  const fig = (await bal.count()) ? bal.first() : card.locator('.env-amt').first();
  return money((await fig.innerText()).replace(/^[^€]*/, ''));
}

test('FSAPI: open a budget folder, edit it, and the write reaches the folder', async ({ page }) => {
  await preparePage(page);
  const disk = readBudgetFolder('budgets/example-project');
  const fake = await installFakeFolder(page, disk);

  await openFolder(page);
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
  expect(fake.picks()).toBe(1);
  // The folder's data is not shifted to the pinned clock (only guest mode
  // shifts it), so August has rows and is still open: the first open of the
  // month offers to close it. Decline; it is asked once per month.
  await page.getByRole('dialog', { name: 'Close last month?' }).getByRole('button', { name: 'Not now' }).click();

  // The dashboard is built from the folder's files.
  const seedIds = JSON.parse(disk.get('transactions.json')).map(tx => tx.id);
  await goTo(page, 'accounts');
  const checkingBefore = await balanceOf(accountCard(page, 'acct-checking'));
  await goTo(page, 'envelopes');
  const diningBefore = await balanceOf(envelopeCard(page, 'env-dining'));
  expect(checkingBefore).not.toBeNaN();

  // ── Edit: record an expense ───────────────────────────────────────────────
  await addExpense(page, {
    payee: 'E2E Espresso', amount: '12.50', envelope: 'Dining Out', account: 'Current Account',
  });
  await expect(page.getByText('E2E Espresso').first()).toBeVisible();

  // The write reached the fake folder: our transaction, with the positive
  // magnitude the sign convention requires, on the right account and envelope,
  // and none of the folder's existing transactions lost. (Opening the folder
  // may also materialise due scheduled rows, so the total is not asserted.)
  const findWritten = () => JSON.parse(disk.get('transactions.json'))
    .find(tx => tx.payee === 'E2E Espresso');
  await expect.poll(findWritten).toBeTruthy();
  const written = findWritten();
  const onDisk = new Set(JSON.parse(disk.get('transactions.json')).map(tx => tx.id));
  expect(seedIds.filter(id => !onDisk.has(id))).toEqual([]);
  expect(written).toMatchObject({ type: 'expense', amount: 12.5, account: 'acct-checking', envelope_id: 'env-dining' });
  // The stale-write guard bumped the folder's sequence number.
  expect(JSON.parse(disk.get('budget-meta.json')).write_seq).toBeGreaterThan(0);

  await goTo(page, 'accounts');
  expect(await balanceOf(accountCard(page, 'acct-checking'))).toBeCloseTo(checkingBefore - 12.5, 2);
  await goTo(page, 'envelopes');
  expect(await balanceOf(envelopeCard(page, 'env-dining'))).toBeCloseTo(diningBefore - 12.5, 2);

  // ── Reload: the tab forgets the folder handle, the folder keeps the data ──
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Welcome to Bunvelope' })).toBeVisible();
  await page.getByRole('button', { name: 'Open folder…' }).click();
  await expect(envelopeCard(page, 'env-dining')).toBeVisible();
  expect(fake.picks()).toBe(2);
  expect(await balanceOf(envelopeCard(page, 'env-dining'))).toBeCloseTo(diningBefore - 12.5, 2);
  await goTo(page, 'transactions');
  await expect(page.getByText('E2E Espresso').first()).toBeVisible();

  expect(page.__errors).toEqual([]);
});

test('FSAPI: an empty folder runs the setup wizard and the budget files are created', async ({ page }) => {
  await preparePage(page);
  const fake = await installFakeFolder(page, new Map());

  await openFolder(page);
  await expect(page.locator('#setup-name')).toBeVisible();
  await page.locator('#setup-name').fill('E2E Folder Budget');
  await page.locator('#setup-next1').click();
  await page.locator('#setup-next2').click(); // no main account (the wizard step is optional)
  // The income step: planned, but with no account not posted on a schedule.
  await expect(page.getByRole('heading', { name: 'Your income' })).toBeVisible();
  await page.locator('#setup-income-amount').fill('3200');
  await page.locator('#setup-income-day').fill('15');
  await page.locator('#setup-next3').click();
  await expect(page.locator('#setup-review-income')).toContainText(/3\s?200,00 a month, on day 15/);
  await page.locator('#setup-finish').click();
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();

  // The wizard wrote a complete budget into the folder.
  for (const name of ['envelopes.json', 'accounts.json', 'transactions.json', 'budget-meta.json']) {
    await expect.poll(() => fake.files.has(name), { message: `${name} written` }).toBe(true);
  }
  expect(JSON.parse(fake.files.get('budget-meta.json'))).toMatchObject({ schemaVersion: 8 });
  await expect.poll(() => fake.files.has('budget-items.json')).toBe(true);
  expect(JSON.parse(fake.files.get('budget-items.json'))).toEqual([expect.objectContaining({
    kind: 'income', default_amount: 3200, payment_day: 15, as_schedule: false, include: true,
  })]);

  // An account with an opening balance goes through the same write path.
  await goTo(page, 'accounts');
  await page.locator('.page-head').getByRole('button', { name: '+ New account', exact: true }).click();
  await page.locator('input[name="name"]').fill('Folder Checking');
  await page.locator('input[name="initialBalance"]').fill('250');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Folder Checking')).toBeVisible();
  await expect.poll(() => JSON.parse(fake.files.get('accounts.json') || '[]')
    .some(a => a.name === 'Folder Checking' && a.initialBalance === 250)).toBe(true);

  expect(page.__errors).toEqual([]);
});

test('FSAPI: configure, remember and restore verified automatic backups', async ({ page }) => {
  await preparePage(page);
  const disk = [...readBudgetFolder('budgets/example-project')];
  await page.addInitScript(({ disk }) => {
    let source;
    window.showDirectoryPicker = async ({ id } = {}) => {
      const root = await navigator.storage.getDirectory();
      if (id === 'bunvelope-backups') return root.getDirectoryHandle('backup-destination', { create: true });
      if (!source) {
        source = await root.getDirectoryHandle('source-budget', { create: true });
        try { await source.getFileHandle('budget-meta.json'); }
        catch {
          for (const [name, text] of disk) {
            const writer = await (await source.getFileHandle(name, { create: true })).createWritable();
            await writer.write(text); await writer.close();
          }
        }
      }
      return source;
    };
  }, { disk });
  await openFolder(page);
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
  await page.getByRole('dialog', { name: 'Close last month?' }).getByRole('button', { name: 'Not now' }).click();
  await goTo(page, 'settings');
  await page.locator('[data-tab="security"]').click();
  await page.getByRole('button', { name: 'Choose backup folder…' }).click();
  await expect(page.locator('#automatic-backup-status')).toContainText('Last verified copy:');
  await expect(page.locator('#automatic-backup-status')).not.toContainText('Never');
  await expect(page.locator('#automatic-backup-status')).not.toContainText('attention');
  await page.locator('#automatic-backups').screenshot({ path: 'test-results/automatic-backups.png' });
  await page.screenshot({ path: 'test-results/automatic-backups-settings.png', fullPage: true });
  const result = await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const source = await root.getDirectoryHandle('source-budget');
    const target = await root.getDirectoryHandle('backup-destination');
    const copies = [];
    for await (const handle of target.values()) copies.push(handle);
    const restored = await root.getDirectoryHandle('restored-budget', { create: true });
    const { restoreMigrationBackup, loadBudgetData } = await import('/js/data.js');
    await restoreMigrationBackup(copies[0], restored);
    const restoredData = await loadBudgetData(restored);
    const current = JSON.parse(await (await (await source.getFileHandle('transactions.json')).getFile()).text());
    return { copies: copies.length, restored: restoredData.transactions, current };
  });
  expect(result.copies).toBe(1);
  expect(result.restored).toEqual(result.current);
  await page.reload();
  await page.getByRole('button', { name: 'Open folder…' }).click();
  await goTo(page, 'settings');
  await page.locator('[data-tab="security"]').click();
  await expect(page.locator('#automatic-backup-status')).toContainText('backup-destination');
  await expect(page.getByRole('button', { name: 'Back up now', exact: true })).toBeEnabled();
  // Losing the destination must surface a warning and retain the last success.
  const beforeFailure = await page.locator('#automatic-backup-status').textContent();
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    await root.removeEntry('backup-destination', { recursive: true });
  });
  await page.getByRole('button', { name: 'Back up now', exact: true }).click();
  await expect(page.locator('#automatic-backup-status')).toContainText('needs attention');
  await expect(page.locator('#automatic-backup-status')).toContainText(beforeFailure);
  await expect(page.locator('#status-backups')).toBeVisible();
  await goTo(page, 'accounts');
  await page.locator('#status-backups').click();
  await expect(page.locator('#automatic-backups')).toBeVisible();
  await page.getByRole('button', { name: 'Turn off backups' }).click();
  await expect(page.locator('#automatic-backup-status')).toContainText('are off');
  expect(page.__errors).toEqual([]);
});

// Run the cloud client against an intercepted authenticated API. Disk handles
// and IndexedDB are real Chromium APIs; this test needs no Postgres installation.
test('Postgres-mode client: show, enable, remember and restore folder backups', async ({ page }) => {
  await preparePage(page);
  const id = '11111111-1111-4111-8111-111111111111';
  const data = { accounts: [], envelopes: [], transactions: [], budgetItems: [], envelopeTemplates: [],
    meta: { schemaVersion: 8, name: 'Local Postgres', last_opened_month: '2026-09',
      last_rollover_month: '2026-08', closed_months: ['2026-08'] } };
  let version = 1;
  await page.route('**/api/**', async route => {
    const pathname = new URL(route.request().url()).pathname;
    let json;
    if (pathname === '/api/me') json = { id: 'owner', display_name: 'Owner' };
    else if (pathname === '/api/user/encryption') json = { enabled: false };
    else if (pathname === '/api/user/prefs') json = { prefs: { tourSeen: true, lang: 'en' } };
    else if (pathname === '/api/ai/key') json = { hasKey: false };
    else if (pathname === '/api/budgets') json = [{ id, name: 'Local Postgres', version, last_opened_at: '2026-09-15' }];
    else if (pathname === `/api/budgets/${id}`) json = { ...data, version };
    else if (pathname === `/api/budgets/${id}/batch`) {
      for (const item of route.request().postDataJSON().items) data[item.kind] = item.data;
      json = { version: ++version };
    } else return route.fulfill({ status: 404, json: { error: 'unexpected test API route' } });
    return route.fulfill({ json });
  });
  await page.addInitScript(() => {
    window.__BUNVELOPE_MODE = { kind: 'cloud' };
    window.showDirectoryPicker = async ({ id, mode } = {}) => {
      const root = await navigator.storage.getDirectory();
      const backups = await root.getDirectoryHandle('postgres-backups', { create: true });
      if (id === 'bunvelope-backups') return backups;
      if (mode === 'read') {
        for await (const handle of backups.values()) return handle;
      }
      return root.getDirectoryHandle('postgres-restored', { create: true });
    };
  });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
  await goTo(page, 'settings');
  await page.locator('[data-tab="security"]').click();
  await expect(page.getByRole('heading', { name: 'Automatic backups' })).toBeVisible();
  await page.getByRole('button', { name: 'Choose backup folder…' }).click();
  await expect(page.getByText('These folder backups contain your financial data without encryption', { exact: false })).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('#automatic-backup-status')).toContainText('are off');
  await page.getByRole('button', { name: 'Choose backup folder…' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'OK', exact: true }).click();
  await expect(page.locator('#automatic-backup-status')).toContainText('Last verified copy:');
  await expect(page.getByRole('button', { name: 'Back up now', exact: true })).toBeEnabled();
  await expect(page.locator('#automatic-backup-status')).not.toContainText('Never');
  await page.locator('#automatic-backups').screenshot({ path: 'test-results/postgres-automatic-backups.png' });
  const beforeRestore = structuredClone(data);
  await page.getByRole('button', { name: 'Select backup…', exact: true }).click();
  await page.getByRole('button', { name: 'Restore to empty folder…', exact: true }).click();
  await expect(page.locator('#settings-data-status')).toContainText('Restored and verified');
  const restored = await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const folder = await root.getDirectoryHandle('postgres-restored');
    const { loadBudgetData } = await import('/js/storage/fsapi-adapter.js');
    return loadBudgetData(folder);
  });
  expect(restored).toEqual(beforeRestore);
  expect(data).toEqual(beforeRestore);
  await page.reload();
  // The saved #settings route is restored after the asynchronous budget load.
  // Waiting only for the rail lets a click race the startup navigation.
  await expect(page.getByRole('heading', { name: /^Settings/ })).toBeVisible();
  await page.locator('[data-tab="security"]').click();
  await expect(page.locator('#automatic-backup-status')).toContainText('postgres-backups');
  await expect(page.getByRole('button', { name: 'Back up now', exact: true })).toBeEnabled();
  // Unsupported browsers explain the limitation instead of hiding the option.
  await page.evaluate(() => { delete window.showDirectoryPicker; });
  await page.locator('[data-tab="budget"]').click();
  await page.locator('[data-tab="security"]').click();
  await expect(page.getByRole('heading', { name: 'Automatic backups' })).toBeVisible();
  await expect(page.getByText('This browser does not support choosing a writable backup folder.', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Choose backup folder…' })).toBeDisabled();
  expect(page.__errors).toEqual([]);
});

test('FSAPI: storage sizes and compressed export preserve the complete budget', async ({ page }) => {
  await preparePage(page);
  const disk = readBudgetFolder('budgets/example-project');
  await installFakeFolder(page, disk);
  await openFolder(page);
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
  const close = page.getByRole('dialog', { name: 'Close last month?' });
  await expect(close).toBeVisible();
  await close.getByRole('button', { name: 'Not now' }).click();
  // The fictional example intentionally ships without private history.
  // Initialise a fresh baseline explicitly so this test exercises export hydration.
  await page.evaluate(async () => {
    const { session } = await import('/js/app.js');
    const result = await session.dispatch('history.initialize', {});
    if (!result.ok) throw new Error(JSON.stringify(result.error));
  });
  await goTo(page, 'settings');
  await page.locator('.content-tab[data-tab="security"]').click();
  const usage = page.locator('#settings-storage-size');
  await expect(usage).toContainText('Financial history');
  await expect(usage).toContainText('Recorded revisions');
  await expect(page.locator('#settings-compact-history')).toBeVisible();
  await page.screenshot({ path: '/tmp/bunvelope-storage-settings.png', fullPage: true });
  const downloadPromise = page.waitForEvent('download');
  await page.locator('#settings-export-zip').click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/\.zip$/);
  const { readFile } = await import('node:fs/promises');
  const { readBudgetFile } = await import('../js/ui/read-budget-file.js');
  const bytes = await readFile(await download.path());
  const imported = await readBudgetFile(new Blob([bytes]));
  expect(imported.ok).toBe(true);
  expect(imported.bundle.meta.schemaVersion).toBe(8);
  expect(imported.bundle.meta.financialHistory.version).toBe(1);
  expect(imported.bundle.meta.financialHistory.storage).toBeUndefined();
  expect(imported.bundle.transactions).toEqual(JSON.parse(disk.get('transactions.json')));
  expect(bytes.length).toBeLessThan(Buffer.byteLength(JSON.stringify(imported.bundle)));
});
