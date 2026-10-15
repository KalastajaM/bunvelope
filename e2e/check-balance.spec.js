import { test, expect } from '@playwright/test';
import { preparePage, goTo } from './static-helpers.js';

test('statement review hides recorded rows, separates reservations and stages only selected transactions', async ({ page }, testInfo) => {
  await preparePage(page);
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.goto('/');
  await page.getByRole('button', { name: /guest/i }).click();
  await page.getByRole('button', { name: 'Load example budget' }).click();
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
  const setup = await page.evaluate(async () => {
    const { state, session } = await import('/js/app.js');
    const created = await session.dispatch('account.create', { name: 'Statement test', type: 'bank', initialBalance: 100 });
    if (!created.ok) throw new Error(JSON.stringify(created));
    const account = state.accounts.find(a => a.name === 'Statement test');
    for (const [payee, amount, date] of [['Shop', 5, '2026-09-10'], ['Old merchant', 7, '2026-09-11']]) {
      const r = await session.dispatch('transaction.record', { type: 'expense', account: account.id, payee, amount, date });
      if (!r.ok) throw new Error(JSON.stringify(r));
    }
    await session.dispatch('transaction.clear', { ids: state.transactions.filter(tx => tx.account === account.id).map(tx => tx.id) });
    const { openReconcileModal } = await import('/js/reconcile.js');
    openReconcileModal(account.id);
    const { t } = await import('/js/ui/i18n.js');
    return { stage: t('reconcile.stageImport'), add: t('reconcile.addFile'), transactions: structuredClone(state.transactions) };
  });
  const reconciliation = page.locator('.sheet-overlay[data-sheet-open]').first();
  await reconciliation.locator('#reconcile-statement').fill('76');
  await reconciliation.getByRole('button', { name: setup.add, exact: true }).click();
  const importer = page.locator('.sheet-overlay[data-sheet-open]').last();
  await importer.locator('input[type="file"]').setInputFiles({ name: 'statement.csv', mimeType: 'text/csv', buffer: Buffer.from(
    'Date,Text,Amount,Status,Account\n2026-09-10,Shop,-5,Executed,Statement test\n2026-09-11,Bank merchant,-7,Executed,Statement test\n2026-09-12,Missing purchase,-12,Executed,Statement test\n2026-09-12,Reservation,-9,Pending,Statement test') });
  await importer.getByRole('button', { name: setup.stage, exact: true }).click();
  await expect(importer.locator('[data-group="recorded"]')).not.toHaveAttribute('open', '');
  await expect(importer.locator('[data-group="pending"]')).not.toHaveAttribute('open', '');
  await expect(importer.locator('[data-group="review"]')).toContainText('Old merchant');
  await expect(importer.locator('[data-group="review"] input')).not.toBeChecked();
  await expect(importer.locator('[data-group="missing"] input')).toBeChecked();
  await expect(importer.locator('.sheet-body')).not.toContainText('Review only what needs attention.');
  await importer.getByRole('button', { name: 'Help: Import Transactions', exact: true }).click();
  const help = page.locator('.sheet-overlay[data-sheet-open]').last();
  await expect(help).toContainText('Already recorded rows and pending reservations start excluded.');
  await help.getByRole('button', { name: 'Close', exact: true }).click();
  const bankField = importer.getByLabel('Bank balance', { exact: true });
  const balanceBox = await bankField.boundingBox();
  await expect(importer.getByLabel('Balance includes', { exact: true })).toHaveCount(0);
  const dateBox = await importer.getByLabel('Balance date', { exact: true }).boundingBox();
  expect(balanceBox.width).toBeLessThan(210);
  expect(dateBox.width).toBeLessThanOrEqual(192);
  await bankField.fill('-99.999.999,99€');
  expect(await bankField.evaluate(input => {
    const style = getComputedStyle(input);
    const context = document.createElement('canvas').getContext('2d');
    context.font = style.font;
    return context.measureText(input.value).width <= input.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
  })).toBe(true);
  await bankField.fill('76');
  await bankField.blur();
  await importer.locator('[data-group="pending"] summary').click();
  await importer.locator('[data-group="pending"] input').check();
  await expect(importer.locator('.statement-review-balance strong')).toContainText('+9,00');
  await importer.locator('[data-group="pending"] input').uncheck();
  await expect(importer.locator('.statement-review-balance strong')).toContainText('0,00');
  await importer.locator('[data-group="pending"] summary').click();
  await page.screenshot({ path: testInfo.outputPath('statement-review-desktop.png'), animations: 'disabled' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => document.documentElement.dataset.theme = 'dark');
  await page.screenshot({ path: testInfo.outputPath('statement-review-mobile.png'), animations: 'disabled' });
  expect(await importer.locator('.sheet-body').evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  await importer.getByRole('button', { name: 'Continue with selected rows', exact: true }).click();
  await expect(reconciliation.locator('.reconcile-import-source')).toHaveCount(1);
  await expect(reconciliation).toContainText('Missing purchase');
  await expect(reconciliation.locator('#reconcile-statement')).toHaveValue('76');
  await page.screenshot({ path: testInfo.outputPath('statement-reconciliation-mobile.png'), animations: 'disabled' });
  expect(await reconciliation.locator('.sheet-body').evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  expect(await page.evaluate(async () => (await import('/js/app.js')).state.transactions)).toEqual(setup.transactions);
  expect(page.__errors).toEqual([]);
});

test('Check balance explains its dated comparison and cancellation preserves the budget', async ({ page }, testInfo) => {
  await preparePage(page);
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.goto('/');
  await page.getByRole('button', { name: /guest/i }).click();
  await page.getByRole('button', { name: 'Load example budget' }).click();
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
  await page.getByRole('button', { name: 'Expand Accounts', exact: true }).click();
  await goTo(page, 'net-worth');
  const snapshot = () => page.evaluate(async () => {
    const { state } = await import('/js/app.js');
    return { accounts: structuredClone(state.accounts), transactions: structuredClone(state.transactions) };
  });
  const before = await snapshot();
  await page.locator('.forecast-readiness-issues [data-readiness-id="acct-checking"]').click();
  const sheet = page.locator('.sheet-overlay[data-sheet-open]').first();
  await expect(sheet.getByText('Check balance: Current Account', { exact: true })).toBeVisible();
  await expect(sheet.getByLabel('Statement date')).toBeVisible();
  await expect(sheet.getByRole('status')).toHaveText('—');
  await expect(sheet.locator('.sheet-body')).not.toContainText('Enter the date and closing balance');
  await sheet.getByRole('button', { name: 'Help: Check balance: Current Account', exact: true }).click();
  let help = page.locator('.sheet-overlay[data-sheet-open]').last();
  await expect(help).toContainText('Enter the date and closing balance from your statement.');
  await help.getByRole('button', { name: 'Close', exact: true }).click();
  await sheet.getByRole('button', { name: 'Help: Remaining difference', exact: true }).click();
  help = page.locator('.sheet-overlay[data-sheet-open]').last();
  await expect(help).toContainText('Enter your statement balance to see the difference.');
  await help.getByRole('button', { name: 'Close', exact: true }).click();
  const dateBox = await sheet.getByLabel('Statement date', { exact: true }).boundingBox();
  const balanceBox = await sheet.getByLabel('Statement balance', { exact: true }).boundingBox();
  const comparisonBox = await sheet.locator('.reconcile-comparison').boundingBox();
  expect(comparisonBox.x).toBeGreaterThan(dateBox.x + dateBox.width);
  expect(comparisonBox.y).toBe(dateBox.y);
  expect(balanceBox.y).toBeGreaterThan(dateBox.y);
  await expect(sheet.locator('.reconcile-breakdown')).not.toHaveAttribute('open', '');
  await sheet.locator('.reconcile-breakdown summary').focus();
  await page.keyboard.press('Enter');
  await expect(sheet.locator('.reconcile-breakdown')).toHaveAttribute('open', '');
  await sheet.locator('.reconcile-breakdown summary').click();
  await page.evaluate(() => document.documentElement.dataset.theme = 'light');
  await expect(page.locator('.toast')).toHaveCount(0);
  await sheet.getByText('No balance check saved yet', { exact: true }).click();
  await page.screenshot({ path: testInfo.outputPath('check-balance-desktop.png'), animations: 'disabled' });
  await sheet.getByLabel('Statement balance', { exact: true }).fill('1');
  await expect(sheet.getByRole('status')).not.toHaveText('—');
  await expect(sheet).not.toContainText('A difference remains.');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => document.documentElement.dataset.theme = 'dark');
  await page.screenshot({ path: testInfo.outputPath('check-balance-mobile.png'), animations: 'disabled' });
  expect(await sheet.locator('.sheet-body').evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  await sheet.getByRole('button', { name: 'Save check', exact: true }).click();
  const choices = page.locator('.sheet-overlay[data-sheet-open]').last();
  await expect(choices).toHaveClass(/open/);
  await expect(choices.getByRole('button', { name: 'Save with difference', exact: true })).toBeVisible();
  await expect(choices.getByRole('button', { name: 'Add adjustment and save', exact: true })).toBeVisible();
  await expect(choices.getByText(/The adjustment adds a transaction/)).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('check-balance-mobile-choices.png'), animations: 'disabled' });
  expect(await choices.locator('.sheet-body').evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  await choices.getByRole('button', { name: 'Continue checking', exact: true }).click();
  await expect(sheet.getByLabel('Statement balance', { exact: true })).toHaveValue('1');
  expect(await snapshot()).toEqual(before);
  await sheet.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.locator('.sheet-overlay[data-sheet-open]')).toHaveCount(0);
  expect(await snapshot()).toEqual(before);
  expect(page.__errors).toEqual([]);
});

for (const locale of ['fi', 'nl']) {
  test(`Check balance remains readable on mobile in ${locale}`, async ({ page }, testInfo) => {
    await preparePage(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');
    await page.getByRole('button', { name: /guest/i }).click();
    await page.getByRole('button', { name: 'Load example budget' }).click();
    await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
    const labels = await page.evaluate(async lang => {
      const { loadLocale, setLang, t } = await import('/js/ui/i18n.js');
      await loadLocale(lang); setLang(lang);
      const { openReconcileModal } = await import('/js/reconcile.js');
      openReconcileModal('acct-checking');
      return { save: t('reconcile.save'), continue: t('reconcile.continueChecking'), unresolved: t('reconcile.mismatchNo'), adjust: t('reconcile.mismatchYes') };
    }, locale);
    const sheet = page.locator('.sheet-overlay[data-sheet-open]').first();
    await expect(sheet).toHaveClass(/open/);
    await expect(page.locator('.toast')).toHaveCount(0);
    await sheet.locator('#reconcile-statement').fill('1');
    expect(await sheet.locator('.sheet-body').evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`check-balance-${locale}-mobile.png`), animations: 'disabled' });
    await sheet.getByRole('button', { name: labels.save, exact: true }).click();
    const choices = page.locator('.sheet-overlay[data-sheet-open]').last();
    await expect(choices).toHaveClass(/open/);
    for (const label of [labels.continue, labels.unresolved, labels.adjust]) {
      await expect(choices.getByRole('button', { name: label, exact: true })).toBeVisible();
    }
    expect(await choices.locator('.sheet').evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`check-balance-${locale}-choices.png`), animations: 'disabled' });
    await choices.getByRole('button', { name: labels.continue, exact: true }).click();
    expect(page.__errors).toEqual([]);
  });
}


test('reconciliation import keeps the entered target and excludes unchecked Spotify', async ({ page }, testInfo) => {
  await preparePage(page);
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.goto('/');
  await page.getByRole('button', { name: /guest/i }).click();
  await page.getByRole('button', { name: 'Load example budget' }).click();
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
  const labels = await page.evaluate(async () => {
    const { state, session } = await import('/js/app.js');
    await session.dispatch('account.create', { name: 'Card regression', type: 'bank', initialBalance: -193.62 });
    const account = state.accounts.find(a => a.name === 'Card regression');
    await session.dispatch('transaction.record', { type: 'expense', account: account.id, payee: 'Spotify', amount: 21.98, date: '2026-09-15' });
    (await import('/js/reconcile.js')).openReconcileModal(account.id);
    const { t } = await import('/js/ui/i18n.js');
    return { stage: t('reconcile.stageImport'), add: t('reconcile.addFile'), account: account.id };
  });
  const reconciliation = page.locator('.sheet-overlay[data-sheet-open]').first();
  await reconciliation.locator('#reconcile-statement').fill('-416.53');
  await reconciliation.getByRole('button', { name: labels.add, exact: true }).click();
  const importer = page.locator('.sheet-overlay[data-sheet-open]').last();
  await importer.locator('input[type="file"]').setInputFiles({ name: 'reservations.csv', mimeType: 'text/csv', buffer: Buffer.from(
    'Date,Text,Amount,Status,Account\n' + [7.40, 83.82, 61.94, 69.75].map(amount => `2026-09-15,Reservation,-${amount},Pending,Card regression`).join('\n')) });
  await importer.getByRole('button', { name: labels.stage, exact: true }).click();
  await importer.locator('[data-group="pending"] summary').click();
  await importer.locator('[data-group="pending"]').getByRole('button', { name: 'Include all in this group', exact: true }).click();
  await expect(importer.locator('.statement-review-balance strong')).toHaveText('Remaining difference: € 0,00');
  await page.screenshot({ path: testInfo.outputPath('fixed-target-import.png'), animations: 'disabled' });
  await importer.getByRole('button', { name: 'Continue with selected rows', exact: true }).click();
  const reservations = reconciliation.locator('tr').filter({ hasText: 'Reservation' }).locator('.rec-check');
  for (const checkbox of await reservations.all()) {
    await checkbox.check();
    await expect(reconciliation.locator('#reconcile-statement')).toHaveValue('-416.53');
  }
  await expect(reconciliation.getByRole('status')).toHaveText('€ 0,00');
  await reservations.first().uncheck();
  await expect(reconciliation.locator('#reconcile-statement')).toHaveValue('-416.53');
  await expect(reconciliation.getByRole('status')).not.toHaveText('€ 0,00');
  await reservations.first().check();
  await page.screenshot({ path: testInfo.outputPath('fixed-target-reconciliation.png'), animations: 'disabled' });
  await reconciliation.getByRole('button', { name: 'Save check', exact: true }).click();
  await expect(page.locator('.sheet-overlay[data-sheet-open]')).toHaveCount(0);
  const saved = await page.evaluate(async id => {
    const { state } = await import('/js/app.js');
    return { account: state.accounts.find(a => a.id === id), transactions: state.transactions.filter(tx => tx.account === id || tx.target_id === id) };
  }, labels.account);
  expect(saved.account.lastReconciledBalance).toBe(-416.53);
  expect(saved.transactions.filter(tx => tx.payee === 'Reservation')).toHaveLength(4);
  expect(saved.transactions.find(tx => tx.payee === 'Spotify').cleared).toBeFalsy();
  expect(saved.transactions.some(tx => tx.type === 'adjustment')).toBe(false);
  expect(page.__errors).toEqual([]);
});
