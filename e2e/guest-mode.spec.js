// e2e/guest-mode.spec.js — the guest golden path, end to end in the real
// browser bundle served statically (no server API, no database):
//
//   Continue as guest → Load example budget → dashboard figure
//   → record an expense → it shows in Transactions, the account and the
//   envelope → fill an envelope from the unallocated pool → reload.
//
// Guest data lives in a module-level Map in the tab (js/storage/guest-adapter.js),
// so the last step asserts what the app promises: a reload starts over at the
// welcome screen and the session's edits are gone.

import { test, expect } from '@playwright/test';
import {
  EXAMPLE, eur, preparePage, goTo, addExpense, envelopeCard, accountCard,
} from './static-helpers.js';

async function loadExampleAsGuest(page) {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /Welcome/ })).toBeVisible();
  await page.getByRole('button', { name: /guest/i }).click();
  await page.getByRole('button', { name: 'Load example budget' }).click();
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
}


// These two ordering tests supply their own complete bill fixture.
async function disableExampleBills(page) {
  await page.evaluate(async () => {
    const { state, session } = await import('/js/app.js');
    for (const item of state.budgetItems.filter(i => i.as_schedule && i.kind === 'expense')) {
      const result = await session.dispatch('budgetItem.update', { id: item.id, fields: { as_schedule: false } });
      if (!result.ok) throw new Error(JSON.stringify(result.error));
    }
  });
}

test('budgeting guides: Help, contextual entry and keyboard handoff from the short tour', async ({ page }) => {
  await preparePage(page);
  await loadExampleAsGuest(page);
  await page.evaluate(async () => {
    const { navigate } = await import('/js/app.js');
    await navigate('settings', { tab: 'help' });
  });
  const budgetSnapshot = () => page.evaluate(async () => {
    const { state } = await import('/js/app.js');
    return JSON.stringify([state.accounts, state.envelopes, state.transactions, state.budgetItems, state.envelopeTemplates]);
  });
  const before = await budgetSnapshot();
  const contentsBox = await page.locator('.budget-guides').boundingBox();
  const referenceBox = await page.locator('.card').filter({ has: page.getByRole('heading', { name: 'Quick reference', exact: true }) }).boundingBox();
  expect(contentsBox.width).toBeLessThanOrEqual(560);
  expect(contentsBox.width).toBe(referenceBox.width);
  const titleBox = await page.locator('.guide-row-title').first().boundingBox();
  const summaryBox = await page.locator('.guide-row-summary').first().boundingBox();
  expect(titleBox.x).toBe(summaryBox.x);
  await page.locator('.guide-list button').nth(2).click();
  const guide = page.locator('[data-sheet-open] .budget-guide');
  await expect(guide.getByRole('heading', { level: 2 })).toHaveText('Build a plan you can fund');
  const chapters = guide.getByLabel('Chapters', { exact: true });
  await expect(chapters).toHaveValue('planning');
  await chapters.focus();
  await chapters.selectOption('stress');
  await expect(guide.getByRole('heading', { level: 2 })).toHaveText('Prepare for uncertainty');
  await expect(chapters).toBeFocused();
  await chapters.selectOption('planning');
  await guide.getByRole('button', { name: 'Next chapter' }).click();
  await expect(chapters).toHaveValue('review');
  await expect(guide.getByRole('heading', { level: 2 })).toBeFocused();
  await expect(guide.getByRole('heading', { level: 2 })).toHaveText('Spend, adjust and review');
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-sheet-open]')).toHaveCount(0);
  expect(await budgetSnapshot()).toBe(before);

  await goTo(page, 'accounts');
  await page.locator('.page-head h1 .info-btn').click();
  await page.locator('[data-sheet-open] .guide-link').click();
  await expect(guide.getByRole('heading', { level: 2 })).toHaveText('Accounts and envelopes');
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-sheet-open]')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-sheet-open]')).toHaveCount(0);

  // Simple mode keeps the learning path, with one extra step explaining Tweaks.
  await page.evaluate(async () => {
    const { savePrefs } = await import('/js/app.js');
    savePrefs({ uiMode: 'simple' });
    const { startTour } = await import('/js/ui/tour.js');
    startTour();
  });
  const steps = ['welcome', 'rail', 'accounts', 'envelopes', 'budget', 'unallocated',
    'transactions', 'dashboard', 'simpleMode', 'finish'];
  for (let i = 0; i < steps.length; i++) {
    const title = await page.evaluate(async key => (await import('/js/ui/i18n.js')).t(`tour.steps.${key}.title`), steps[i]);
    await expect(page.locator('.tour-title')).toHaveText(title);
    await expect(page.locator('.tour-step-lbl')).toHaveText(`Step ${i + 1} of 10`);
    if (i < steps.length - 1) {
      await expect(page.locator('.tour-guides')).toBeHidden();
      await page.locator('.tour-next').click();
    }
  }
  // Step positioning sets focus on the next animation frame. Wait for it
  // before moving focus to the guide link.
  await expect(page.locator('.tour-next')).toBeFocused();
  await page.locator('.tour-guides').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('.tour-popover')).toHaveCount(0);
  await expect(guide.getByRole('heading', { level: 2 })).toHaveText('Accounts and envelopes');
  expect(page.__errors).toEqual([]);
});

test('shared quick reference: contextual help, nested guides and translated balance controls', async ({ page }) => {
  test.setTimeout(90000);
  await preparePage(page);
  await loadExampleAsGuest(page);
  const snapshot = () => page.evaluate(async () => {
    const { state } = await import('/js/app.js');
    return JSON.stringify([state.accounts, state.envelopes, state.transactions, state.budgetItems, state.envelopeTemplates]);
  });
  const before = await snapshot();
  const navigate = (name, params) => page.evaluate(async ({ name, params }) => {
    await (await import('/js/app.js')).navigate(name, params);
  }, { name, params });
  const closeHelp = async () => {
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-sheet-open]')).toHaveCount(0);
    await expect(page.locator('.sheet-overlay')).toHaveCount(0);
  };
  const expected = {};
  const keys = ['envelopes', 'unallocated', 'accountBalances', 'envelopeFigures', 'txTypes', 'reconciling', 'emergencyRunway'];
  await navigate('settings', { tab: 'help' });
  const reference = page.locator('.card').filter({ has: page.getByRole('heading', { name: 'Quick reference', exact: true }) });
  await expect(reference.locator('[data-help-key]')).toHaveCount(keys.length);
  for (const key of keys) {
    await reference.locator(`[data-help-key="${key}"]`).click();
    expected[key] = await page.locator('[data-sheet-open] .sheet-body').innerText();
    await expect(page.locator('[data-sheet-open] .guide-link')).toBeVisible();
    await closeHelp();
  }
  for (const [route, key] of [['accounts', 'envelopes'], ['envelopes', 'envelopes'], ['review', 'envelopeFigures'], ['transactions', 'txTypes'], ['stress', 'emergencyRunway']]) {
    await navigate(route);
    await page.locator(`.page-head [data-help-key="${key}"]`).click();
    expect(await page.locator('[data-sheet-open] .sheet-body').innerText()).toBe(expected[key]);
    await closeHelp();
  }
  await navigate('envelopes');
  const spareHelp = page.locator('.env-fig [data-help-key="envelopeFigures"]').first();
  await spareHelp.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-sheet-open]')).toHaveCount(1);
  expect(await page.locator('[data-sheet-open] .sheet-body').innerText()).toBe(expected.envelopeFigures);
  await closeHelp();
  await expect(spareHelp).toBeFocused();

  for (const [opener, key] of [['fill', 'unallocated'], ['reconcile', 'reconciling']]) {
    await page.evaluate(async opener => {
      if (opener === 'fill') (await import('/js/pages/fill-envelopes.js')).openFillEnvelopes();
      else {
        const { state } = await import('/js/app.js');
        (await import('/js/reconcile.js')).openReconcileModal(state.accounts[0].id);
      }
    }, opener);
    await page.locator(`[data-sheet-open] [data-help-key="${key}"]`).click();
    expect(await page.locator('[data-sheet-open]').last().locator('.sheet-body').innerText()).toBe(expected[key]);
    await page.locator('[data-sheet-open]').last().locator('.guide-link').click();
    await expect(page.locator('[data-sheet-open]')).toHaveCount(3);
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-sheet-open]')).toHaveCount(2);
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-sheet-open]')).toHaveCount(1);
    await closeHelp();
  }
  for (const lang of ['fi', 'nl', 'en']) {
    await page.evaluate(async lang => {
      const i18n = await import('/js/ui/i18n.js');
      await i18n.loadLocale(lang);
      i18n.setLang(lang);
      (await import('/js/ui/lens-control.js')).relabelLensControls();
    }, lang);
    const control = page.locator('.statusbar [data-help-key="accountBalances"]');
    const labels = await page.evaluate(async () => {
      const { t } = await import('/js/ui/i18n.js');
      return { aria: t('help.aria')(t('help.accountBalances.title')), body: t('help.accountBalances.body') };
    });
    await expect(control).toHaveAccessibleName(labels.aria);
    await control.click();
    await expect(page.locator('[data-sheet-open] .sheet-body p').first()).toHaveText(labels.body.split('\n\n')[0]);
    await closeHelp();
  }
  expect(await snapshot()).toBe(before);
  expect(page.__errors).toEqual([]);
});

test('guest golden path: example budget, record money, fill an envelope, reload starts over', async ({ page }) => {
  await preparePage(page);
  await loadExampleAsGuest(page);

  // ── Dashboard: the unallocated figure of the example budget ──────────────
  const pool = page.locator('.hero-card').filter({ has: page.getByText('Unallocated · Booked', { exact:true }) });
  await expect(pool.locator('.hero-val')).toContainText(EXAMPLE.unallocated);

  // Baselines before editing.
  await goTo(page, 'accounts');
  await expect(accountCard(page, 'acct-checking')).toContainText(EXAMPLE.checking);
  await goTo(page, 'envelopes');
  await expect(envelopeCard(page, 'env-dining')).toContainText(EXAMPLE.diningOut);

  // ── Record an expense: Dining Out from Current Account ─────────────────
  await addExpense(page, {
    payee: 'E2E Espresso', amount: '12.50', envelope: 'Dining Out', account: 'Current Account',
  });
  await expect(page.getByText('E2E Espresso').first()).toBeVisible();
  // The persistent status bar carries the unallocated figure; an expense
  // assigned to an envelope must not move it.
  await expect(page.locator('#status-unallocated')).toContainText(EXAMPLE.unallocated);

  // The account is 12.50 lower, the envelope is 12.50 lower.
  await goTo(page, 'accounts');
  await expect(accountCard(page, 'acct-checking')).toContainText(eur('15 259,65'));
  await goTo(page, 'envelopes');
  await expect(envelopeCard(page, 'env-dining')).toContainText(eur('566,90'));

  // ── Fill: move 100.00 of the unallocated pool into Groceries ─────────────
  await page.getByRole('button', { name: /^Assign/ }).click();
  const sheet = page.locator('.sheet-overlay.open');
  await expect(sheet.getByText('Fill envelopes')).toBeVisible();
  // Target the named envelope rather than depending on row/input order.
  await expect(sheet.getByText('Groceries').first()).toBeVisible();
  await sheet.locator('input[aria-label="Groceries"]').fill('100');
  await sheet.getByRole('button', { name: 'Fill', exact: true }).click();
  await expect(page.locator('.sheet-overlay.open')).toHaveCount(0);

  await expect(envelopeCard(page, 'env-groceries')).toContainText(eur('1 195,55'));
  // Unallocated fell by exactly what was assigned: 5432.04 − 100.00.
  await expect(page.getByRole('button', { name: /^Assign/ })).toContainText(eur('5 332,04'));

  // ── Reload: guest data is per-tab memory, so the app starts over ─────────
  await page.reload();
  await expect(page.getByRole('heading', { name: /Welcome/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /guest/i })).toBeVisible();
  await expect(page.getByText('E2E Espresso')).toHaveCount(0);

  // A fresh guest session gets the pristine example again, edits gone.
  await page.getByRole('button', { name: /guest/i }).click();
  await page.getByRole('button', { name: 'Load example budget' }).click();
  // The URL still names #/envelopes, so that is where the fresh budget opens.
  await expect(envelopeCard(page, 'env-dining')).toContainText(EXAMPLE.diningOut);
  await expect(envelopeCard(page, 'env-groceries')).toContainText(EXAMPLE.groceries);

  expect(page.__errors).toEqual([]);
});

test('guest mode: Start empty walks the setup wizard into a working budget', async ({ page }) => {
  await preparePage(page);
  await page.goto('/');
  await page.getByRole('button', { name: /guest/i }).click();
  await page.getByRole('button', { name: 'Start empty' }).click();

  await expect(page.locator('#setup-name')).toBeVisible();
  await page.locator('#setup-name').fill('Guest Empty');
  await page.locator('#setup-next1').click();
  await page.locator('#setup-next2').click(); // no main account (the wizard step is optional)
  await page.locator('#setup-skip-income').click(); // no income (optional too)
  await page.locator('#setup-finish').click();
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();

  // A first account with a balance, then an expense against it — in memory.
  await goTo(page, 'accounts');
  await page.locator('.page-head').getByRole('button', { name: '+ New account', exact: true }).click();
  await page.locator('input[name="name"]').fill('Guest Checking');
  await page.locator('input[name="initialBalance"]').fill('250');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Guest Checking')).toBeVisible();

  await goTo(page, 'transactions');
  await page.getByRole('button', { name: 'New transaction' }).first().click();
  await page.locator('input[name="payee"]').fill('Guest Coffee');
  await page.locator('input[name="amount"]').fill('12.50');
  await page.getByRole('button', { name: 'Add & close' }).click();
  await expect(page.getByText('Guest Coffee').first()).toBeVisible();

  await goTo(page, 'accounts');
  await expect(page.getByText(/237[.,]50/).first()).toBeVisible();

  expect(page.__errors).toEqual([]);
});

test('first run: Start empty offers starter envelopes, then simple mode, the tour and the checklist', async ({ page }) => {
  await preparePage(page, { firstRun: true });
  await page.goto('/');
  await page.getByRole('button', { name: /guest/i }).click();
  await page.getByRole('button', { name: 'Start empty' }).click();

  await page.locator('#setup-next1').click();
  await page.locator('#setup-next2').click(); // no main account (the wizard step is optional)
  await page.locator('#setup-skip-income').click(); // no income (optional too)
  // Every starter envelope starts ticked; untick one.
  await expect(page.locator('.setup-starter input[type="checkbox"]:checked')).toHaveCount(8);
  await page.locator('.setup-starter input[value="holidays"]').uncheck();
  await page.locator('#setup-finish').click();
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();

  // A first budget starts the tour, in its simple-mode form.
  await expect(page.locator('.tour-popover')).toBeVisible();
  await expect(page.locator('.tour-step-lbl')).toHaveText('Step 1 of 10');
  await page.locator('.tour-skip').click();
  await expect(page.locator('.tour-popover')).toHaveCount(0);

  // Simple mode: the advanced pages and the balance-view switcher are gone.
  await expect(page.locator('.rail-item[data-page="stress"]')).toBeHidden();
  await expect(page.locator('.rail-item[data-page="reports"]')).toBeHidden();
  await expect(page.locator('#rail .lens-ctl')).toBeHidden();
  await expect(page.locator('.rail-item[data-page="budget-plan"]')).toBeVisible();

  // The checklist: envelopes are done (the starter set), the account is next.
  const checklist = page.locator('.getting-started');
  await expect(checklist.locator('.gs-step[data-step="envelopes"].done')).toHaveCount(1);
  await expect(checklist.locator('.gs-step.next')).toHaveAttribute('data-step', 'account');

  await goTo(page, 'envelopes');
  await expect(page.getByText('Groceries').first()).toBeVisible();
  await expect(page.getByText('Holidays')).toHaveCount(0);

  // Parent activation opens Settings so its Tweaks child is reachable.
  await goTo(page, 'settings');
  // Tweaks switches to full mode; collapsed groups keep their saved state.
  await page.locator('#rail-tweaks').click();
  await page.locator('#tweaks').getByRole('button', { name: 'Full' }).click();
  await page.locator('.rail-item[data-page="budget-plan"]').locator('..').locator('.rail-submenu-toggle').click();
  await expect(page.locator('.rail-item[data-page="stress"]')).toBeVisible();

  // The top layout hides the rail, and with it the rail's Tweaks entry; the
  // top bar's own Tweaks button is the way back.
  await page.locator('#tweaks .tweak-row').filter({ hasText: 'Navigation' }).getByRole('button', { name: 'Top', exact: true }).click();
  await expect(page.locator('#rail')).toBeHidden();
  // The panel is still open from the switch; the button closes and reopens it.
  await page.locator('#topnav-tweaks').click();
  await expect(page.locator('#tweaks')).not.toHaveClass(/\bopen\b/);
  await page.locator('#topnav-tweaks').click();
  await expect(page.locator('#tweaks')).toHaveClass(/\bopen\b/);
  await page.locator('#tweaks').getByRole('button', { name: 'Rail' }).click();
  await expect(page.locator('#rail')).toBeVisible();

  expect(page.__errors).toEqual([]);
});

test('recurring costs: annual billing, reminder save and attention filter', async ({ page }) => {
  await preparePage(page);
  await loadExampleAsGuest(page);
  await page.evaluate(async () => {
    const app = await import('/js/app.js');
    const result = await app.session.dispatch('budgetItem.create', {
      description: 'Annual subscription', default_amount: 120, as_schedule: true,
      account_id: 'acct-checking', payment_day: 15, monthly_schedule: { Nov: true },
    });
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    app.navigate('recurring-costs');
  });
  const card = page.locator('article.recurring-card').filter({ hasText: 'Annual subscription' });
  await expect(card).toContainText(/Monthly equivalent.*10,00/);
  await expect(card).toContainText(/Next planned payment:.*120,00/);
  await card.getByRole('button', { name: 'Category & reminders' }).click();
  await page.getByLabel('Renews on', { exact: true }).fill('2026-12-31');
  await expect(page.getByLabel('Remind me on', { exact: true })).toHaveValue('2026-11-16');
  await page.getByText('Earlier cancellation deadline (optional)', { exact: true }).click();
  await page.getByLabel('Cancel by', { exact: true }).fill('2026-10-01');
  await expect(page.getByLabel('Remind me on', { exact: true })).toHaveValue('2026-08-17');
  await page.getByLabel('Remind me on', { exact: true }).fill('2026-09-15');
  await expect(page.getByLabel('Days before', { exact: true })).toHaveValue('16');
  await page.getByRole('button', { name: 'Ends on', exact: true }).click();
  await expect(page.getByLabel('Ends on', { exact: true })).toHaveValue('2026-12-31');
  await expect(page.locator('.recurring-preview p')).toHaveCount(1);
  await page.getByLabel('Review notes').fill('Compare providers');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('.sheet-overlay')).toHaveCount(0);
  await page.getByRole('combobox', { name: 'Show recurring costs' }).selectOption('attention');
  await expect(card).toContainText('Compare providers');
  await card.getByRole('button', { name: 'Category & reminders' }).click();
  await expect(page.getByLabel('Cancel by', { exact: true })).toHaveValue('2026-10-01');
  await expect(page.getByLabel('Remind me on', { exact: true })).toHaveValue('2026-09-15');
  await expect(page.getByLabel('Days before', { exact: true })).toHaveValue('16');
  await page.getByLabel('Ends on', { exact: true }).fill('');
  await page.getByLabel('Cancel by', { exact: true }).fill('');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('.sheet-overlay')).toHaveCount(0);
  await expect(card).toHaveCount(0);
  expect(page.__errors).toEqual([]);
});

test('recurring costs: categories, hiding and advance reminders in Overview', async ({ page }, testInfo) => {
  await preparePage(page);
  await loadExampleAsGuest(page);
  await page.evaluate(async () => {
    const app = await import('/js/app.js');
    for (const input of [
      { description: 'Streaming annual', default_amount: 120, monthly_schedule: { Nov: true }, recurring_review: { category: 'Streaming', renews_on: '2026-12-31', reminder_days: 30, notes: 'Compare plans' } },
      { description: 'Home insurance', default_amount: 50, recurring_review: { category: 'Insurance' } },
    ]) {
      const r = await app.session.dispatch('budgetItem.create', { ...input, as_schedule: true, account_id: 'acct-checking', payment_day: 15 });
      if (!r.ok) throw new Error(JSON.stringify(r.error));
    }
    app.navigate('recurring-costs');
  });
  const card = page.locator('article.recurring-card').filter({ hasText: 'Streaming annual' });
  await expect(page.getByRole('heading', { name: 'Streaming', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Insurance', exact: true })).toBeVisible();
  const lines = card.locator('.recurring-cost-lines > div');
  await expect(lines).toHaveCount(2);
  expect((await lines.nth(1).boundingBox()).y).toBeGreaterThan((await lines.nth(0).boundingBox()).y);
  await card.getByRole('button', { name: 'Category & reminders' }).click();
  await expect(page.getByLabel('Category', { exact: true })).toHaveValue('Streaming');
  const saveHeight = await page.getByRole('button', { name: 'Save', exact: true }).evaluate(el => el.offsetHeight);
  const cancelHeight = await page.getByRole('button', { name: 'Cancel', exact: true }).evaluate(el => el.offsetHeight);
  expect(saveHeight).toBe(cancelHeight);
  await expect(page.locator('.recurring-preview')).toContainText('Dec 1, 2026');
  await page.getByLabel('Category', { exact: true }).fill('Entertainment');
  await page.getByLabel('Days before', { exact: true }).fill('107');
  await expect(page.locator('.recurring-preview')).toContainText('Sep 15, 2026');
  await page.screenshot({ path: testInfo.outputPath('recurring-editor.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('#rail')).toBeHidden();
  await page.getByLabel('Remind me on', { exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('recurring-editor-mobile.png') });
  expect(await page.locator('.recurring-reminder-timing').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('.sheet-overlay')).toHaveCount(0);
  await page.evaluate(async () => (await import('/js/app.js')).navigate('dashboard'));
  await expect(page.locator('.recurring-reminder-notice')).toContainText('Streaming annual');
  await page.getByRole('button', { name: 'Review recurring costs' }).click();
  await expect(page.getByRole('combobox', { name: 'Show recurring costs' })).toHaveValue('attention');
  await card.getByRole('button', { name: 'Hide', exact: true }).click();
  await expect(card).toHaveCount(0);
  await page.getByRole('combobox', { name: 'Show recurring costs' }).selectOption('hidden');
  await expect(card).toContainText('Compare plans');
  await expect(card.locator('.recurring-reminder')).toHaveCount(0);
  const hidden = await page.evaluate(async () => {
    const { session, state } = await import('/js/app.js');
    const result = session.query('recurring.costs', {}).value;
    return { row: result.items.find(it => it.name === 'Streaming annual'), stored: state.budgetItems.find(it => it.description === 'Streaming annual') };
  });
  expect(hidden.row).toMatchObject({ hidden: true, category: 'Entertainment', annual: 120, attention: false, reminders: [] });
  expect(hidden.stored).toMatchObject({ include: true, as_schedule: true, recurring_review: { reminder_days: 107 } });
  await page.evaluate(async () => (await import('/js/app.js')).navigate('dashboard'));
  await expect(page.getByRole('heading', { name: /^Overview/ })).toBeVisible();
  await expect(page.locator('.overview-top')).toBeVisible();
  await page.locator('.overview-top').screenshot({ path: testInfo.outputPath('overview.png') });
  await expect(page.locator('.recurring-reminder-notice')).toHaveCount(0);
  await page.evaluate(async () => (await import('/js/app.js')).navigate('recurring-costs', { filter: 'hidden' }));
  await card.getByRole('button', { name: 'Unhide', exact: true }).click();
  await expect(card).toHaveCount(0);
  await page.getByRole('combobox', { name: 'Show recurring costs' }).selectOption('current');
  await expect(card.locator('.recurring-reminder.is-due')).toHaveCount(1);
  await page.getByRole('combobox', { name: 'Filter by category' }).selectOption({ label: 'Entertainment' });
  await expect(page.locator('article.recurring-card')).toHaveCount(1);
  await page.getByRole('combobox', { name: 'Filter by category' }).selectOption('all');
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(300);
  await page.screenshot({ path: testInfo.outputPath('recurring-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(300);
  await page.screenshot({ path: testInfo.outputPath('recurring-mobile.png'), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  expect(page.__errors).toEqual([]);
});

test('recurring costs: legacy review dates convert to one linked reminder', async ({ page }, testInfo) => {
  await preparePage(page);
  await loadExampleAsGuest(page);
  await page.evaluate(async () => {
    const app = await import('/js/app.js');
    const result = await app.session.dispatch('budgetItem.create', {
      description: 'Legacy agreement', default_amount: 20, as_schedule: true,
      account_id: 'acct-checking', payment_day: 15,
      recurring_review: { renews_on: '2026-12-31', ends_on: '2027-01-31', review_on: '2026-10-01', notes: 'Keep this' },
    });
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    app.navigate('recurring-costs');
  });
  const card = page.locator('article.recurring-card').filter({ hasText: 'Legacy agreement' });
  await card.getByRole('button', { name: 'Category & reminders' }).click();
  await expect(page.getByLabel('Renews on', { exact: true })).toHaveValue('2026-12-31');
  await expect(page.getByLabel('Remind me on', { exact: true })).toHaveValue('2026-10-01');
  await expect(page.getByLabel('Days before', { exact: true })).toHaveValue('91');
  await page.getByLabel('Remind me on', { exact: true }).fill('2027-01-01');
  expect(await page.getByLabel('Remind me on', { exact: true }).evaluate(el => el.checkValidity())).toBe(false);
  await page.getByLabel('Days before', { exact: true }).fill('91');
  await expect(page.getByLabel('Remind me on', { exact: true })).toHaveValue('2026-10-01');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('.sheet-overlay')).toHaveCount(0);
  await expect(card.locator('.recurring-reminder')).toHaveCount(1);
  const stored = await page.evaluate(async () => (await import('/js/app.js')).state.budgetItems.find(it => it.description === 'Legacy agreement').recurring_review);
  expect(stored).toMatchObject({ linked_reminder: true, renews_on: '2026-12-31', ends_on: null, review_on: null, reminder_days: 91, notes: 'Keep this' });
  await card.getByRole('button', { name: 'Category & reminders' }).click();
  await page.getByLabel('Started on', { exact: true }).fill('2025-01-15');
  await page.locator('.recurring-date-toggle').click();
  await expect(page.getByLabel('Renews on', { exact: true })).toBeDisabled();
  await expect(page.getByLabel('Days before', { exact: true })).toBeDisabled();
  await page.getByLabel('Remind me on', { exact: true }).fill('2026-10-15');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('.sheet-overlay')).toHaveCount(0);
  await expect(card).toContainText('Continuous (until further notice)');
  await expect(card).toContainText('Started on: Jan 15, 2025');
  await expect(card.locator('.recurring-reminder')).toHaveCount(1);
  await expect(card.locator('.recurring-reminder')).toContainText('Oct 15, 2026');
  await card.getByRole('button', { name: 'Category & reminders' }).click();
  await expect(page.getByLabel('Renewal/end date enabled', { exact: true })).not.toBeChecked();
  await expect(page.getByLabel('Started on', { exact: true })).toHaveValue('2025-01-15');
  await expect(page.getByLabel('Remind me on', { exact: true })).toHaveValue('2026-10-15');
  await expect(page.getByLabel('Renews on', { exact: true })).toBeDisabled();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('#rail')).toBeHidden();
  await page.getByLabel('Remind me on', { exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('continuous-editor-mobile.png') });
  await page.locator('.recurring-date-toggle').click();
  await expect(page.getByLabel('Renews on', { exact: true })).toBeEnabled();
  await page.getByLabel('Renews on', { exact: true }).fill('2027-01-31');
  await expect(page.getByLabel('Days before', { exact: true })).toBeEnabled();
  expect(page.__errors).toEqual([]);
});

test('recurring costs: category totals and saved section ordering', async ({ page }, testInfo) => {
  await preparePage(page);
  await loadExampleAsGuest(page);
  await disableExampleBills(page);
  await page.evaluate(async () => {
    const app = await import('/js/app.js');
    for (const [category, amount, hidden] of [['Alpha', 12, false], ['Alpha', 100, true], ['Beta', 24, false], ['Gamma', 36, false]]) {
      const result = await app.session.dispatch('budgetItem.create', {
        description: category + (hidden ? ' hidden' : ' tracked'), default_amount: amount,
        as_schedule: true, account_id: 'acct-checking', payment_day: 15,
        recurring_review: { category, hidden },
      });
      if (!result.ok) throw new Error(JSON.stringify(result.error));
    }
    app.navigate('recurring-costs');
  });
  const group = name => page.locator('.recurring-group').filter({ has: page.getByRole('heading', { name, exact: true }) });
  const headings = page.locator('.recurring-group-title');
  await expect(group('Alpha').locator('.recurring-group-totals')).toContainText(/Monthly:.*12,00/);
  await expect(group('Alpha').locator('.recurring-group-totals')).toContainText(/Next 12 months:.*144,00/);
  await group('Beta').locator('.recurring-group-drag').dragTo(group('Alpha').locator('.recurring-group-header'));
  await expect(headings).toHaveText(['Beta', 'Alpha', 'Gamma']);
  await group('Beta').getByRole('button', { name: 'Move category down: Beta', exact: true }).click();
  await expect(headings).toHaveText(['Alpha', 'Beta', 'Gamma']);
  await group('Gamma').locator('.recurring-group-drag').press('Alt+ArrowUp');
  await expect(headings).toHaveText(['Alpha', 'Gamma', 'Beta']);
  await page.evaluate(async () => (await import('/js/app.js')).navigate('dashboard'));
  await page.evaluate(async () => (await import('/js/app.js')).navigate('recurring-costs'));
  await expect(headings).toHaveText(['Alpha', 'Gamma', 'Beta']);
  await page.getByRole('searchbox', { name: 'Search recurring costs' }).fill('Alpha');
  await expect(headings).toHaveText(['Alpha']);
  await expect(group('Alpha').getByRole('button', { name: 'Move category down: Alpha', exact: true })).toBeDisabled();
  await page.getByRole('searchbox', { name: 'Search recurring costs' }).fill('');
  await page.getByRole('combobox', { name: 'Show recurring costs' }).selectOption('hidden');
  await expect(group('Alpha').locator('.recurring-group-totals')).toContainText(/Monthly:.*12,00/);
  await page.getByRole('combobox', { name: 'Show recurring costs' }).selectOption('current');
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: testInfo.outputPath('category-totals-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('#rail')).toBeHidden();
  await page.screenshot({ path: testInfo.outputPath('category-totals-mobile.png'), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  expect(page.__errors).toEqual([]);
});

test('recurring costs: account and envelope views with earliest renewal sorting', async ({ page }, testInfo) => {
  await preparePage(page);
  await loadExampleAsGuest(page);
  await disableExampleBills(page);
  await page.evaluate(async () => {
    const app = await import('/js/app.js');
    const create = async (command, input) => {
      const result = await app.session.dispatch(command, input);
      if (!result.ok) throw new Error(JSON.stringify(result.error));
      return result.value.value.id;
    };
    const a = await create('account.create', { name: 'Recurring bank A' });
    const b = await create('account.create', { name: 'Recurring bank B' });
    const electric = await create('envelope.create', { name: 'Test electric', category: 'Household' });
    const phone = await create('envelope.create', { name: 'Test phone', category: 'Household' });
    const media = await create('envelope.create', { name: 'Test media', category: 'Leisure' });
    for (const [description, amount, account, envelope, renews_on, continuous, hidden] of [
      ['Later renewal', 30, a, electric, '2027-01-01', false, false],
      ['Earlier renewal', 10, a, phone, '2026-11-01', false, false],
      ['Continuous service', 20, b, media, '2026-10-01', true, false],
      ['Undated service', 5, b, null, null, false, false],
      ['Hidden service', 500, a, phone, '2026-09-01', false, true],
    ]) {
      await create('budgetItem.create', { description, default_amount: amount, account_id: account,
        envelope_id: envelope, as_schedule: true, payment_day: 15,
        recurring_review: { category: 'Services', renews_on, continuous, hidden } });
    }
    app.navigate('recurring-costs');
  });
  const grouping = page.getByRole('combobox', { name: 'Group recurring costs by' });
  const sorting = page.getByRole('combobox', { name: 'Sort recurring costs', exact: true });
  const group = name => page.locator('.recurring-group').filter({ has: page.getByRole('heading', { name, exact: true }) });
  await grouping.selectOption('account');
  await expect(page.locator('.recurring-group-title')).toHaveText(['Recurring bank A', 'Recurring bank B']);
  await expect(group('Recurring bank A').locator('.recurring-group-totals')).toContainText(/Monthly:.*40,00/);
  await sorting.selectOption('renewal');
  await expect(group('Recurring bank A').locator('.tpl-name')).toHaveText(['Earlier renewal', 'Later renewal']);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: testInfo.outputPath('account-view.png'), fullPage: true });
  await group('Recurring bank B').getByRole('button', { name: 'Move group up: Recurring bank B', exact: true }).click();
  await expect(page.locator('.recurring-group-title')).toHaveText(['Recurring bank B', 'Recurring bank A']);
  await grouping.selectOption('envelope');
  await expect(page.locator('.recurring-group-title')).toHaveText(['Test electric', 'Test media', 'Test phone', 'Unallocated']);
  await grouping.selectOption('envelopeCategory');
  await expect(page.locator('.recurring-group-title')).toHaveText(['Household', 'Leisure', 'Unallocated']);
  await expect(group('Household').locator('.recurring-group-totals')).toContainText(/Monthly:.*40,00/);
  await grouping.selectOption('account');
  await expect(page.locator('.recurring-group-title')).toHaveText(['Recurring bank B', 'Recurring bank A']);
  await grouping.selectOption('envelopeCategory');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('#rail')).toBeHidden();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: testInfo.outputPath('envelope-category-mobile.png'), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  await grouping.selectOption('none');
  await expect(page.locator('.recurring-card .tpl-name')).toHaveText(['Earlier renewal', 'Later renewal', 'Continuous service', 'Undated service']);
  await expect(page.locator('.recurring-group-drag')).toHaveCount(0);
  await page.evaluate(async () => (await import('/js/app.js')).navigate('dashboard'));
  await page.evaluate(async () => (await import('/js/app.js')).navigate('recurring-costs'));
  await expect(grouping).toHaveValue('none');
  await expect(sorting).toHaveValue('renewal');
  await expect(page.locator('.recurring-card .tpl-name')).toHaveText(['Earlier renewal', 'Later renewal', 'Continuous service', 'Undated service']);
  await page.getByRole('combobox', { name: 'Show recurring costs' }).selectOption('hidden');
  await expect(page.locator('.recurring-card .tpl-name')).toHaveText(['Hidden service']);
  await expect(page.locator('.recurring-group-totals')).toContainText(/Monthly:.*65,00/);
  expect(page.__errors).toEqual([]);
});

test('recurring costs: discovers manual payments with confirm, dismiss, restore and link', async ({ page }, testInfo) => {
  await preparePage(page);
  await loadExampleAsGuest(page);
  await page.evaluate(async () => {
    const app = await import('/js/app.js');
    for (const [payee, dates] of [
      ['Manual music', ['2026-07-01','2026-08-01','2026-09-01']],
      ['Manual insurance', ['2026-03-01','2026-06-01','2026-09-01']],
      ['Manual membership', ['2025-09-01','2026-09-01']],
    ]) for (const date of dates) {
      const result = await app.session.dispatch('transaction.record', { type: 'expense', date, payee, amount: 20, account: 'acct-checking', envelope: null });
      if (!result.ok) throw new Error(JSON.stringify(result.error));
    }
    app.navigate('recurring-costs');
  });
  const suggestion = name => page.locator('.recurring-suggestion').filter({ has: page.getByRole('heading', { name, exact: true }) });
  await expect(suggestion('Manual music')).toContainText('Monthly');
  await expect(suggestion('Manual insurance')).toContainText('Quarterly');
  await expect(suggestion('Manual membership')).toContainText('Yearly');
  await suggestion('Manual music').getByText('Matching payments (latest 12) (3)', { exact: true }).click();
  await expect(suggestion('Manual music').locator('li')).toHaveCount(3);
  await page.locator('.recurring-discovery').scrollIntoViewIfNeeded();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: testInfo.outputPath('discovery-desktop.png'), fullPage: true, animations: 'disabled' });
  await suggestion('Manual music').getByRole('button', { name: 'Dismiss', exact: true }).click();
  await page.getByText('Dismissed and linked suggestions', { exact: true }).click();
  await suggestion('Manual music').getByRole('button', { name: 'Restore suggestion' }).click();
  await suggestion('Manual music').getByRole('button', { name: 'Add scheduled cost' }).click();
  await expect(page.getByLabel('First future payment')).toHaveValue('2026-10-01');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.locator('.sheet-overlay')).toHaveCount(0);
  await expect(suggestion('Manual music').getByRole('button', { name: 'Add scheduled cost' })).toBeVisible();
  await suggestion('Manual music').getByRole('button', { name: 'Add scheduled cost' }).click();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('.sheet-overlay')).toHaveCount(0);
  await expect(page.locator('.recurring-card').filter({ hasText: 'Manual music' })).toHaveCount(1);
  await suggestion('Manual insurance').getByRole('button', { name: 'Link existing cost' }).click();
  await page.getByLabel('Existing scheduled expense').selectOption({ label: 'Manual music · Current Account' });
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('.sheet-overlay')).toHaveCount(0);
  await page.getByText('Dismissed and linked suggestions', { exact: true }).click();
  await expect(suggestion('Manual insurance')).toContainText('Linked to: Manual music');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('.recurring-discovery').scrollIntoViewIfNeeded();
  await page.locator('.recurring-discovery').evaluate(el => window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - 300));
  await page.screenshot({ path: testInfo.outputPath('discovery-mobile.png'), animations: 'disabled' });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(page.__errors).toEqual([]);
});

test('purchase check: previews are read-only and a funding move plus purchase save together', async ({ page }, testInfo) => {
  await preparePage(page);
  await loadExampleAsGuest(page);
  await page.evaluate(async () => {
    const { state, session, navigate } = await import('/js/app.js');
    for (const name of ['Purchase target', 'Purchase source']) {
      const r = await session.dispatch('envelope.create', { name, category: 'other' });
      if (!r.ok) throw new Error(JSON.stringify(r.error));
    }
    const fill = await session.dispatch('allocation.fill', { lines: [{ envelope: state.envelopes.find(e => e.name === 'Purchase source').id, amount: 100 }], date: '2026-09-15' });
    if (!fill.ok) throw new Error(JSON.stringify(fill.error));
    navigate('dashboard');
  });
  const snapshot = () => page.evaluate(async () => {
    const { state } = await import('/js/app.js');
    return JSON.stringify(state.transactions);
  });
  const before = await snapshot();
  await page.getByRole('button', { name: 'Can I afford this?', exact: true }).click();
  const sheet = page.locator('.purchase-check');
  await sheet.getByRole('spinbutton', { name: 'Amount', exact: true }).fill('50');
  await sheet.getByRole('combobox', { name: 'Spend from envelope', exact: true }).fill('Purchase target');
  await page.getByRole('option', { name: 'Purchase target', exact: true }).click();
  await sheet.getByRole('textbox', { name: 'Payee / description' }).fill('Purchase check test');
  await sheet.getByRole('button', { name: 'Check purchase', exact: true }).click();
  await expect(sheet.locator('.purchase-results h3')).toBeVisible();
  expect(await snapshot()).toBe(before);
  await sheet.getByRole('button', { name: /Preview moving.*Purchase source/ }).click();
  await expect(sheet.getByRole('button', { name: 'Record purchase and funding move', exact: true })).toBeEnabled();
  expect(await snapshot()).toBe(before);
  await page.screenshot({ path: testInfo.outputPath('purchase-funding-preview.png') });
  await sheet.getByRole('button', { name: 'Record purchase and funding move', exact: true }).click();
  await expect(page.locator('.sheet-overlay.open')).toHaveCount(0);
  const rows = JSON.parse(await snapshot());
  expect(rows.length).toBe(JSON.parse(before).length + 2);
  expect(rows.slice(-2).map(r => r.type)).toEqual(['envelope_transfer', 'expense']);
  expect(rows.at(-1)).toMatchObject({ payee: 'Purchase check test', amount: 50, date: '2026-09-15' });
  expect(page.__errors).toEqual([]);
});

test('overview attention: explains risks, routes review actions and stays read-only', async ({ page }, testInfo) => {
  await preparePage(page);
  await loadExampleAsGuest(page);
  const ids = await page.evaluate(async () => {
    const { state, session, navigate } = await import('/js/app.js');
    const account = await session.dispatch('account.create', { name: 'Attention bank', type: 'bank', initialBalance: -25 });
    const goal = await session.dispatch('envelope.create', { name: 'Attention goal', category: 'other', goal_amount: 250, goal_date: '2026-09-16' });
    if (!account.ok || !goal.ok) throw new Error('Could not create attention fixtures');
    navigate('dashboard');
    return { account: state.accounts.find(a => a.name === 'Attention bank').id, goal: state.envelopes.find(e => e.name === 'Attention goal').id };
  });
  const snapshot = () => page.evaluate(async () => {
    const { state } = await import('/js/app.js');
    return JSON.stringify({ accounts: state.accounts, envelopes: state.envelopes, transactions: state.transactions });
  });
  const before = await snapshot();
  await expect(page.locator('.overview-attention-results [data-attention-key]').first()).toBeVisible();
  const more = page.locator('.overview-more-gaps');
  if (await more.count()) await more.locator(':scope > summary').click();
  const cash = page.locator(`[data-attention-key="account:${ids.account}"]`);
  await expect(cash).toBeVisible();
  await cash.getByText('Why is this flagged?', { exact: true }).click();
  await expect(cash).toContainText('Moving money between envelopes does not move cash between accounts.');
  await page.screenshot({ path: testInfo.outputPath('attention-desktop.png'), animations: 'disabled' });
  await page.setViewportSize({ width: 390, height: 844 });
  await cash.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('attention-mobile.png'), animations: 'disabled' });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(await snapshot()).toBe(before);
  await cash.getByRole('button', { name: 'View account activity: Attention bank', exact: true }).click();
  await expect(page.getByRole('heading', { name: /^Transactions/ })).toBeVisible();
  await expect(page.locator('.filter-chip').filter({ hasText: 'Attention bank' })).toBeVisible();
  await page.setViewportSize({ width: 1280, height: 900 });
  await goTo(page, 'dashboard');
  await expect(page.locator('.overview-attention-results [data-attention-key]').first()).toBeVisible();
  if (await more.count()) await more.locator(':scope > summary').click();
  await page.locator(`[data-attention-key="goal:${ids.goal}"]`).getByRole('button').click();
  await expect(page.locator('.sheet')).toBeVisible();
  expect(await snapshot()).toBe(before);
  expect(page.__errors).toEqual([]);
});

test('envelope funding: multi-select preview stays read-only and applies combined funding', async ({ page }, testInfo) => {
  await preparePage(page);
  await loadExampleAsGuest(page);
  const ids = await page.evaluate(async () => {
    const { state, session, navigate } = await import('/js/app.js');
    for (const name of ['Funding target', 'Funding source', 'Funding second source']) {
      const result = await session.dispatch('envelope.create', { name, category: 'other' });
      if (!result.ok) throw new Error(JSON.stringify(result.error));
    }
    const target = state.envelopes.find(e => e.name === 'Funding target').id;
    const source = state.envelopes.find(e => e.name === 'Funding source').id;
    const second = state.envelopes.find(e => e.name === 'Funding second source').id;
    const fill = await session.dispatch('allocation.fill', { lines: [{ envelope: source, amount: 100 }, { envelope: second, amount: 100 }], date: '2026-09-15' });
    const bill = await session.dispatch('transaction.record', { type: 'expense', envelope: target, account: 'acct-checking', amount: 50, date: '2026-09-20', scheduled: true, payee: 'Funding test bill' });
    if (!fill.ok || !bill.ok) throw new Error('Could not prepare funding fixture');
    await navigate('dashboard'); return { target, source, second };
  });
  await expect(page.locator('.overview-attention-results [data-attention-key]').first()).toBeVisible();
  const more = page.locator('.overview-more-gaps');
  if (await more.count()) await more.locator(':scope > summary').click();
  await page.getByRole('button', { name: 'Help me fund this: Funding target', exact: true }).click();
  const sheet = page.locator('.envelope-funding');
  const snapshot = () => page.evaluate(async () => {
    const { state, session } = await import('/js/app.js');
    return { rows: JSON.stringify(state.transactions), balances: session.query('balances', { lens: 'booked' }).value.accounts };
  });
  const before = await snapshot();
  await sheet.getByRole('checkbox', { name: 'Funding source', exact: true }).check();
  await sheet.getByRole('checkbox', { name: 'Funding second source', exact: true }).check();
  await expect(sheet.locator('.funding-selection')).toHaveText('2 envelopes selected');
  await sheet.locator('h3').first().scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('funding-selection-desktop.png'), animations: 'disabled' });
  await sheet.getByRole('button', { name: 'Preview funding', exact: true }).click();
  await expect(sheet.getByText('This funding covers the projected reserve gap.', { exact: true })).toBeVisible();
  await expect(sheet.getByRole('button', { name: 'Apply funding', exact: true })).toBeEnabled();
  expect(await snapshot()).toEqual(before);
  await sheet.locator('.funding-effects').scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('funding-desktop.png'), animations: 'disabled' });
  await page.setViewportSize({ width: 390, height: 844 });
  await sheet.locator('.funding-effects').scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('funding-mobile.png'), animations: 'disabled' });
  expect(await sheet.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  await sheet.getByRole('button', { name: 'Apply funding', exact: true }).click();
  await expect(page.locator('.sheet-overlay.open')).toHaveCount(0);
  const after = await snapshot();
  const rows = JSON.parse(after.rows);
  expect(rows.length).toBe(JSON.parse(before.rows).length + 2);
  expect(rows.slice(-2)).toEqual(expect.arrayContaining([ids.source, ids.second].map(id => expect.objectContaining({ type: 'envelope_transfer', amount: 25, from_envelope_id: id, to_envelope_id: ids.target }))));
  expect(after.balances).toEqual(before.balances);
  const remaining = await page.evaluate(async target => {
    const { session } = await import('/js/app.js');
    return session.query('envelope.funding', { envelope: target }).value.gap;
  }, ids.target);
  expect(remaining).toBe(0);
  expect(page.__errors).toEqual([]);
});

test('recurring costs: price reviews and variable bill estimates', async ({ page }, testInfo) => {
  await preparePage(page); await loadExampleAsGuest(page);
  await page.evaluate(async () => {
    const app = await import('/js/app.js');
    const create = async (name, input) => { const r = await app.session.dispatch(name,input); if (!r.ok) throw new Error(JSON.stringify(r.error)); return r; };
    await create('budgetItem.create', { description:'Price test', default_amount:10, as_schedule:true, account_id:'acct-checking', payment_day:1 });
    for (const [payee, amounts, dates] of [
      ['Price test',[10,10,12],['2026-07-01','2026-08-01','2026-09-01']],
      ['Variable utility',[40,80,50,70],['2026-06-01','2026-07-01','2026-08-01','2026-09-01']],
    ]) for (let i=0;i<dates.length;i++) await create('transaction.record', { type:'expense', payee, amount:amounts[i], date:dates[i], account:'acct-checking', envelope:null });
    app.navigate('recurring-costs');
  });
  const price = page.locator('.recurring-price-card').filter({ hasText:'Price test' });
  await expect(price).toContainText(/Extra per year if continued:.*24,00/);
  await price.getByRole('button', { name:'Dismiss', exact:true }).click();
  await page.getByText('Dismissed price alerts', { exact:true }).click();
  await price.getByRole('button', { name:'Restore suggestion' }).click();
  await price.getByRole('button', { name:'Edit payment' }).click();
  await expect(page.locator('#bp-f-amount')).toHaveValue('10');
  await page.locator('.sheet-overlay.open').getByRole('button', { name:'Cancel', exact:true }).click();
  const variable = page.locator('.recurring-suggestion').filter({ hasText:'Variable utility' });
  await expect(variable).toContainText(/Estimated yearly cost:.*720,00/);
  await expect(variable).toContainText('Variable payments');
  await variable.getByRole('button', { name:'Add scheduled cost' }).click();
  await expect(page.getByLabel('Amount per scheduled payment')).toHaveValue('60');
  await page.screenshot({path:testInfo.outputPath('variable-estimate-review.png'), animations:'disabled'});
  await page.getByLabel('Amount per scheduled payment').fill('75');
  await page.getByRole('dialog', { name: 'Add scheduled cost', exact: true }).getByRole('button', { name:'Save', exact:true }).click();
  await expect(page.locator('.sheet-overlay')).toHaveCount(0);
  await expect(page.locator('.recurring-card').filter({hasText:'Variable utility'})).toContainText(/Monthly equivalent.*75,00/);
  await page.locator('.recurring-price-reviews').evaluate(el => window.scrollTo(0, el.getBoundingClientRect().top+window.scrollY-240));
  await page.screenshot({path:testInfo.outputPath('price-review-desktop.png'), animations:'disabled'});
  await page.setViewportSize({width:390,height:844});
  await page.locator('.recurring-price-reviews').evaluate(el => window.scrollTo(0, el.getBoundingClientRect().top+window.scrollY-80));
  await page.screenshot({path:testInfo.outputPath('price-review-mobile.png'), animations:'disabled'});
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(page.__errors).toEqual([]);
});

test('AI subscription prefill opens a reviewed Plan draft without saving on navigation', async ({ page }, testInfo) => {
  await preparePage(page); await loadExampleAsGuest(page);
  // Wait for load-time posting and its repaint before opening a navigation draft.
  await expect(page.getByText('Example budget loaded.', { exact: true })).toBeVisible();
  await expect(page.getByText('Example budget loaded.', { exact: true })).toBeHidden();
  const before = await page.evaluate(async () => (await import('/js/app.js')).state.budgetItems.length);
  await page.evaluate(async () => (await import('/js/app.js')).navigate('budget-plan', { prefillScheduled: { payee:'AI annual service', amount:120, frequency:'yearly', envelope_id:null } }));
  await expect(page.locator('#bp-f-description')).toHaveValue('AI annual service');
  await expect(page.locator('#bp-f-amount')).toHaveValue('120');
  expect(await page.evaluate(async () => (await import('/js/app.js')).state.budgetItems.length)).toBe(before);
  await page.locator('#bp-f-account').selectOption('acct-checking');
  await page.screenshot({path:testInfo.outputPath('ai-subscription-draft.png'), animations:'disabled'});
  await page.locator('.sheet-overlay.open').getByRole('button', {name:'Save',exact:true}).click();
  await expect(page.locator('.sheet-overlay')).toHaveCount(0);
  const result = await page.evaluate(async () => {
    const app = await import('/js/app.js'); const item=app.state.budgetItems.find(it=>it.description==='AI annual service');
    return { schedule:item?.as_schedule, months:Object.values(item?.monthly_schedule||{}).filter(Boolean).length, account:item?.account_id };
  });
  expect(result).toEqual({schedule:true, months:1, account:'acct-checking'});
  expect(page.__errors).toEqual([]);
});

test('number changes: automatically records edits and compares from a chosen date', async ({ page }, testInfo) => {
  await preparePage(page);
  await loadExampleAsGuest(page);
  await page.getByRole('button', { name: 'Why did this number change?', exact: true }).click();
  const sheet = page.locator('.number-changes');
  await expect(sheet.locator('.number-changes-totals')).toBeVisible();
  await expect(sheet.getByLabel('Compare from date')).toHaveValue('2026-09-15');
  await expect(sheet.getByText('Save comparison point', { exact: true })).toHaveCount(0);
  await page.evaluate(async () => {
    const { session } = await import('/js/app.js');
    const r = await session.dispatch('transaction.record', { type: 'expense', amount: 25, date: '2026-09-01', account: 'acct-checking', envelope: 'env-dining', payee: 'Date history coffee' });
    if (!r.ok) throw new Error(JSON.stringify(r.error));
  });
  await expect(sheet.locator('.number-changes-step')).toContainText('Date history coffee');
  const before = await page.evaluate(async () => { const { state } = await import('/js/app.js'); return JSON.stringify(state.transactions); });
  await sheet.getByLabel('Compare from date').fill('2026-09-01');
  await expect(sheet).toContainText('History does not cover this date.');
  await sheet.getByLabel('Compare from date').fill('2026-09-15');
  await expect(sheet.locator('.number-changes-totals')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('date-comparison-desktop.png'), animations: 'disabled' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: testInfo.outputPath('date-comparison-mobile.png'), animations: 'disabled' });
  expect(await sheet.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  expect(await page.evaluate(async () => { const { state } = await import('/js/app.js'); return JSON.stringify(state.transactions); })).toBe(before);
  await page.locator('.sheet').getByRole('button', { name: 'Close', exact: true }).click();
  await page.evaluate(async () => { const { openChangeLogSheet } = await import('/js/change-log-sheet.js'); openChangeLogSheet(); });
  const log = page.getByRole('dialog', { name: 'Change log', exact: true });
  await expect(log).toContainText('Date history coffee');
  await log.locator('details > summary').first().click();
  await expect(log.getByText(/Added · Date history coffee/)).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('financial-history-mobile.png'), animations: 'disabled' });
  expect(await log.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.screenshot({ path: testInfo.outputPath('financial-history-desktop.png'), animations: 'disabled' });
  expect(page.__errors).toEqual([]);
});

test('editor validation: keyboard errors stay beside fields and corrected drafts save', async ({ page }) => {
  await preparePage(page);
  await loadExampleAsGuest(page);
  const dialog = () => page.getByRole('dialog').last();

  await goTo(page, 'accounts');
  await page.getByRole('button', { name: /New account/i }).click();
  const name = dialog().locator('input[name="name"]');
  await name.press('Enter');
  await expect(name).toHaveAttribute('aria-invalid', 'true');
  await expect(name).toBeFocused();
  await expect(dialog().locator('.has-error .field-hint')).toHaveText('This field is required.');
  await name.fill('UX validation account');
  const balance = dialog().locator('input[name="initialBalance"]');
  await balance.fill('12oops');
  await balance.press('Enter');
  await expect(balance).toHaveAttribute('aria-invalid', 'true');
  await balance.fill('25');
  await balance.press('Enter');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /UX validation account/ })).toBeVisible();

  await goTo(page, 'envelopes');
  await page.getByRole('button', { name: /New envelope/i }).click();
  await dialog().locator('input[name="name"]').press('Enter');
  await expect(dialog().locator('input[name="name"]')).toHaveAttribute('aria-invalid', 'true');
  await dialog().locator('input[name="name"]').fill('UX validation envelope');
  await dialog().locator('input[name="name"]').press('Enter');
  await expect(page.getByRole('dialog')).toHaveCount(0);

  await goTo(page, 'transactions');
  await page.getByRole('button', { name: /New transaction/ }).first().click();
  await expect(dialog().getByRole('button', { name: 'Add & close', exact: true })).toBeEnabled();
  await dialog().locator('input[name="payee"]').press('Enter');
  await expect(dialog().locator('input[name="amount"]')).toBeFocused();
  await expect(dialog().locator('input[name="amount"]')).toHaveAttribute('aria-invalid', 'true');
  await dialog().locator('input[name="payee"]').fill('UX keyboard expense');
  await dialog().locator('input[name="amount"]').fill('12oops');
  await dialog().locator('input[name="amount"]').press('Enter');
  await expect(dialog().locator('input[name="amount"]')).toHaveAttribute('aria-invalid', 'true');
  await dialog().locator('input[name="amount"]').fill('4.25');
  await dialog().getByRole('combobox', { name: 'Type to find an envelope' }).first().fill('Dining Out');
  await dialog().getByRole('option', { name: /^Dining Out/ }).click();
  await dialog().locator('input[name="payee"]').press('Enter');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByText('UX keyboard expense', { exact: true })).toBeVisible();

  await goTo(page, 'budget-plan');
  await page.getByRole('button', { name: /Add budget item/i }).click();
  await dialog().getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog().locator('#bp-f-envelope-search')).toHaveAttribute('aria-invalid', 'true');
  await expect(dialog().locator('#bp-f-envelope-search')).toBeFocused();
  await dialog().locator('#bp-f-envelope-search').fill('Dining Out');
  await dialog().getByRole('option', { name: /^Dining Out/ }).click();
  await dialog().locator('#bp-f-amount').fill('15');
  await dialog().locator('#bp-f-amount').press('Enter');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(page.__errors).toEqual([]);
});

test('investment coverage repairs the exact trade and boundary price without losing the period', async ({ page }, testInfo) => {
  await preparePage(page);
  await loadExampleAsGuest(page);
  // Seed legacy incomplete history: no acquisition data is invented by the UI.
  await page.evaluate(async () => {
    const { state, navigate } = await import('/js/app.js');
    state.accounts.push({ id: 'ux-broker', name: 'UX Broker', type: 'investment', initialBalance: 0 });
    state.transactions.push({ id: 'ux-trade', type: 'investment_transfer', direction: 'buy', from_account: 'acct-checking', to_account: 'ux-broker', date: '2025-12-01', symbol: 'UXTEST', envelope_id: 'env-groceries', units: null, amount: 100, posted: true, payee: 'Test acquisition' });
    state.meta.investments = { prices: { UXTEST: { price: 12, asOf: '2026-09-15' } } };
    await navigate('investments');
  });
  await page.getByRole('tab', { name: 'Performance', exact: true }).click();
  const card = page.locator('.investment-performance');
  const filters = card.locator('form').first();
  await filters.locator('input').first().fill('2026-02-01');
  await filters.locator('select').selectOption('ux-broker');
  await filters.getByRole('button', { name: 'Show performance' }).click();
  await expect(card).toContainText('Enter the traded units.');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await card.screenshot({ path: testInfo.outputPath('coverage-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await card.locator('.performance-coverage-group').screenshot({ path: testInfo.outputPath('coverage-mobile.png') });
  expect(await card.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await card.getByRole('button', { name: 'Open transaction', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.locator('input[name="payee"]')).toHaveValue('Test acquisition');
  await dialog.locator('input[name="units"]').fill('10');
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(filters.locator('input').first()).toHaveValue('2026-02-01');
  await expect(filters.locator('select')).toHaveValue('ux-broker');
  await expect(card).not.toContainText('Enter the traded units.');
  await card.getByRole('button', { name: 'Record a dated price', exact: true }).click();
  const prices = card.locator('form').nth(1);
  await expect(prices.locator('input').nth(0)).toHaveValue('UXTEST');
  await expect(prices.locator('input').nth(1)).toHaveValue('2026-01-31');
  await expect(prices.locator('input').nth(2)).toBeFocused();
  await prices.locator('input').nth(2).fill('10');
  await prices.getByRole('button', { name: 'Save price' }).click();
  await expect(card).toContainText('20%');
  await expect(card).not.toContainText('History is incomplete');
  expect(await page.evaluate(async () => (await import('/js/app.js')).state.meta.investments.prices.UXTEST)).toEqual({ price: 12, asOf: '2026-09-15' });
  await page.evaluate(async () => {
    const { state, navigate } = await import('/js/app.js');
    state.transactions.push({ id: 'ux-sale', type: 'investment_transfer', direction: 'sell', from_account: 'ux-broker', to_account: 'acct-checking', date: '2025-12-03', symbol: 'UXTEST', envelope_id: 'env-groceries', units: 12, amount: 120, posted: true });
    await navigate('investments');
  });
  await card.getByRole('button', { name: 'Review acquisition history', exact: true }).click();
  const history = page.getByRole('dialog');
  await history.locator('summary').click();
  const correction = history.locator('form');
  await correction.locator('input').nth(0).fill('2025-12-02');
  await correction.locator('input').nth(1).fill('5');
  await correction.locator('input').nth(2).fill('50');
  await history.screenshot({ path: testInfo.outputPath('acquisition-history.png') });
  await correction.getByRole('button', { name: 'Save correction', exact: true }).click();
  await expect(card).not.toContainText('History is incomplete');
  await expect(card).toContainText('20%');
  await history.getByRole('button', { name: 'Close', exact: true }).click();

  expect(page.__errors).toEqual([]);
});

test('content tabs share keyboard behavior and keep mobile selection visible', async ({ page }, testInfo) => {
  await preparePage(page);
  await loadExampleAsGuest(page);
  await goTo(page, 'settings');
  const settings = page.getByRole('tablist', { name: 'Settings', exact: true });
  await settings.getByRole('tab').first().focus();
  await page.keyboard.press('ArrowRight');
  await expect(settings.getByRole('tab', { selected: true })).toBeFocused();
  await expect(page.getByRole('tabpanel', { name: 'Clean-up', exact: true })).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('tabpanel', { name: 'Clean-up', exact: true })).toBeFocused();
  await page.setViewportSize({ width: 390, height: 844 });
  await settings.getByRole('tab', { selected: true }).focus();
  await page.keyboard.press('End');
  const security = settings.getByRole('tab', { name: 'Data & Security', exact: true });
  await expect(security).toBeFocused();
  await expect(security).toHaveAttribute('aria-selected', 'true');
  expect(await security.evaluate(el => {
    const r = el.getBoundingClientRect(), p = el.parentElement.getBoundingClientRect();
    return r.left >= p.left - 1 && r.right <= p.right + 1;
  })).toBe(true);
  expect(await security.evaluate(el => {
    const r = el.getBoundingClientRect();
    return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
  })).toBe(true);
  await settings.screenshot({ path: testInfo.outputPath('settings-tabs-mobile.png') });
  await page.keyboard.press('Home');
  await expect(settings.getByRole('tab').first()).toBeFocused();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await settings.screenshot({ path: testInfo.outputPath('settings-tabs-desktop.png') });
  await goTo(page, 'investments');
  const investments = page.getByRole('tablist', { name: 'Investments', exact: true });
  await investments.getByRole('tab').first().focus();
  await page.keyboard.press('ArrowLeft');
  await expect(investments.getByRole('tab', { name: 'Tax', exact: true })).toBeFocused();
  await expect(page.getByRole('tabpanel', { name: 'Tax', exact: true })).toBeVisible();
  await page.keyboard.press('Home');
  await investments.screenshot({ path: testInfo.outputPath('investment-tabs-desktop.png') });
  await page.evaluate(() => document.documentElement.dataset.theme = 'dark');
  await investments.screenshot({ path: testInfo.outputPath('investment-tabs-dark.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.keyboard.press('End');
  await investments.screenshot({ path: testInfo.outputPath('investment-tabs-mobile.png') });
  expect(await investments.evaluate(el => el.scrollWidth > el.clientWidth)).toBe(true);
  expect(page.__errors).toEqual([]);
});

test('financial typography preserves values and aligns long-name account cards', async ({ page }) => {
  await preparePage(page);
  await loadExampleAsGuest(page);
  await page.evaluate(async () => {
    const { state } = await import('/js/app.js');
    state.accounts = state.accounts.concat(
      { id: 'ux-long', name: 'International household savings and planned renovation reserve with a deliberately long name', code: 'LONG', type: 'bank', initialBalance: -123456789.12, favorite: true, notes: 'Synthetic layout fixture' },
      { id: 'ux-short', name: 'Short name', code: 'SHORT', type: 'bank', initialBalance: 98765432.10, favorite: true },
    );
  });
  const before = await page.evaluate(async () => { const { state } = await import('/js/app.js'); return JSON.stringify([state.accounts, state.transactions]); });
  await page.mouse.move(0, 0);
  for (const width of [1440, 1024]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const theme of ['light', 'dark']) {
      await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
      for (const route of ['dashboard', 'detailed-insights', 'accounts', 'investments', 'recurring-costs', 'reports']) {
        await page.evaluate(async route => (await import('/js/app.js')).navigate(route), route);
        const amounts = page.locator('.money-hero, .money-summary').filter({ visible: true });
        await expect(amounts.first()).toBeVisible();
        expect(await amounts.evaluateAll(nodes => nodes.every(el => {
          const style = getComputedStyle(el);
          return el.scrollWidth <= el.clientWidth + 1 && style.fontFamily.includes('Geist') && style.fontVariantNumeric.includes('tabular-nums');
        })), `${route} ${width} ${theme}: amounts fit`).toBe(true);
        if (route === 'accounts') {
          await expect(page.locator('[data-acc-id="ux-long"] .money-summary')).toContainText('−123');
          const rows = await page.locator('.account-grid > .account-card').evaluateAll(cards => cards.map(card => ({
            top: card.getBoundingClientRect().top,
            amount: card.querySelector('.env-amt').getBoundingClientRect().top,
          })));
          for (const card of rows) {
            for (const peer of rows.filter(p => Math.abs(p.top - card.top) < 1)) expect(Math.abs(peer.amount - card.amount)).toBeLessThan(1);
          }
          const long = page.locator('[data-acc-id="ux-long"] .env-name');
          expect(await long.evaluate(el => el.scrollHeight <= el.clientHeight + 1 && el.scrollWidth <= el.clientWidth + 1)).toBe(true);
        }
      }
    }
  }
  // Currency placement and grouping remain the canonical formatter's decision.
  await page.evaluate(async () => {
    const { setFormatDefaults, setCurrencyAfterAmount } = await import('/js/utils.js');
    setFormatDefaults({ currency: 'EUR', locale: 'nl-NL' }); setCurrencyAfterAmount(true);
    await (await import('/js/app.js')).navigate('accounts');
  });
  await expect(page.locator('[data-acc-id="ux-long"] .money-summary')).toHaveText('−123.456.789,12 €');
  expect(await page.evaluate(async () => { const { state } = await import('/js/app.js'); return JSON.stringify([state.accounts, state.transactions]); })).toBe(before);
  expect(page.__errors).toEqual([]);
});

test('translated planning and full Review detail fit narrow viewports', async ({ page }) => {
  await preparePage(page);
  await loadExampleAsGuest(page);
  for (const lang of ['en', 'fi', 'nl']) {
    const labels = await page.evaluate(async lang => {
      const i18n = await import('/js/ui/i18n.js');
      await i18n.loadLocale(lang);
      (await import('/js/app.js')).savePrefs({ lang });
      (await import('/js/ui/shell.js')).relabelShell();
      return Object.fromEntries(['nav.budget', 'budgetPlan.title', 'budgetPlan.addItem', 'budgetPlan.addTitle', 'review.colProjectedEnd', 'review.colMinReq'].map(k => [k, i18n.t(k)]));
    }, lang);
    for (const width of [1440, 1024, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.evaluate(async () => (await import('/js/app.js')).navigate('budget-plan'));
      await expect(page.getByRole('heading', { name: labels['budgetPlan.title'] })).toBeVisible();
      expect(labels['nav.budget']).toBe(labels['budgetPlan.title']);
      await expect(page.getByRole('button', { name: labels['budgetPlan.addItem'], exact: true })).toBeVisible();
      await page.evaluate(async () => (await import('/js/app.js')).navigate('review'));
      const detail = page.locator('details').filter({ has: page.locator('#review-table-wrap') });
      await detail.locator(':scope > summary').click();
      const table = page.locator('#review-table-wrap');
      await expect(table).toBeVisible();
      await expect(table.locator('thead')).toContainText(labels['review.colProjectedEnd']);
      await expect(table.locator('thead')).toContainText(labels['review.colMinReq']);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `${lang} ${width}: no page overflow`).toBe(true);
      expect(await table.locator('th').evaluateAll(nodes => nodes.every(n => n.scrollWidth <= n.clientWidth + 1))).toBe(true);
      if (width === 390) {
        expect(await table.evaluate(el => { el.scrollLeft = el.scrollWidth; return el.scrollLeft; })).toBeGreaterThan(0);
        const lastHeader = table.locator('th').last();
        expect(await lastHeader.evaluate(el => el.getBoundingClientRect().right <= window.innerWidth)).toBe(true);
      }
    }
  }
  expect(page.__errors).toEqual([]);
});

test('forecast scale switches by keyboard without changing its table', async ({ page }) => {
  await preparePage(page);
  await loadExampleAsGuest(page);
  await page.evaluate(async () => (await import('/js/app.js')).navigate('net-worth'));
  const charts = page.locator('.bv-chart').filter({ has: page.getByRole('button', { name: 'Fit changes', exact: true }) });
  await expect(charts).toHaveCount(2);
  for (const chart of await charts.all()) {
    await expect(chart.getByRole('button', { name: 'Fit changes', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(chart.locator('.bv-chart-change')).toContainText('Change:');
    await chart.getByRole('button', { name: 'Table', exact: true }).click();
    const before = await chart.locator('table').innerText();
    const zero = chart.getByRole('button', { name: 'Start at zero', exact: true });
    await zero.focus(); await page.keyboard.press('Enter');
    await expect(zero).toBeFocused();
    await expect(zero).toHaveAttribute('aria-pressed', 'true');
    expect(await chart.locator('table').innerText()).toBe(before);
    await expect(chart.locator('.bv-chart-change')).toContainText('Start at zero');
    await chart.getByRole('button', { name: 'Chart', exact: true }).click();
    await page.setViewportSize({ width: 390, height: 900 });
    const fit = chart.getByRole('button', { name: 'Fit changes', exact: true });
    await fit.focus(); await page.keyboard.press('Space');
    await expect(fit).toHaveAttribute('aria-pressed', 'true');
    expect(await chart.locator('.bv-chart-scale').evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  }
  const simulation = page.locator('.bv-chart').filter({ has: page.getByRole('button', { name: 'Stacked', exact: true }) });
  await simulation.getByRole('button', { name: 'Stacked', exact: true }).click();
  await expect(simulation.locator('.bv-chart-change')).toContainText('Start at zero');
  expect(page.__errors).toEqual([]);
});

test('advanced mode: an empty budget works with every optional view disabled', async ({ page }) => {
  await preparePage(page);
  await page.addInitScript(() => localStorage.setItem('bv-prefs-v1', JSON.stringify({ tourSeen: true, uiMode: 'advanced', uiFeatures: [] })));
  await page.goto('/');
  await page.getByRole('button', { name: /guest/i }).click();
  await page.getByRole('button', { name: 'Start empty' }).click();

  await expect(page.locator('#setup-name')).toBeVisible();
  await page.locator('#setup-name').fill('Guest Empty');
  await page.locator('#setup-next1').click();
  await page.locator('#setup-next2').click(); // no main account (the wizard step is optional)
  await page.locator('#setup-skip-income').click(); // no income (optional too)
  await page.locator('#setup-finish').click();
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();

  // A first account with a balance, then an expense against it — in memory.
  await goTo(page, 'accounts');
  await page.locator('.page-head').getByRole('button', { name: '+ New account', exact: true }).click();
  await page.locator('input[name="name"]').fill('Guest Checking');
  await page.locator('input[name="initialBalance"]').fill('250');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Guest Checking')).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'New account', exact: true })).toHaveCount(0);

  await goTo(page, 'envelopes');
  await page.locator('#env-new').click();
  await page.getByRole('dialog', { name: 'New envelope', exact: true }).locator('input[name="name"]').fill('Everyday');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByRole('button', { name: /^Assign/ }).click();
  await page.locator('.sheet-overlay.open input[aria-label="Everyday"]').fill('50');
  await page.locator('.sheet-overlay.open').getByRole('button', { name: 'Fill', exact: true }).click();
  await expect(page.locator('.sheet-overlay.open')).toHaveCount(0);

  await goTo(page, 'budget-plan');
  await page.locator('#bp-add').click();
  await page.locator('.sheet-overlay.open').getByRole('combobox', { name: 'Type to find an envelope' }).fill('Everyday');
  await page.getByRole('option', { name: 'Everyday', exact: true }).click();
  await page.locator('#bp-f-description').fill('Coffee budget');
  await page.locator('#bp-f-amount').fill('20');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('.sheet-overlay.open')).toHaveCount(0);
  await expect(page.getByText('Coffee budget').first()).toBeVisible();

  await goTo(page, 'transactions');
  await page.getByRole('button', { name: 'New transaction' }).first().click();
  await page.locator('input[name="payee"]').fill('Guest Coffee');
  await page.locator('input[name="amount"]').fill('12.50');
  await page.getByRole('button', { name: 'Add & close' }).click();
  await expect(page.getByText('Guest Coffee').first()).toBeVisible();

  await goTo(page, 'accounts');
  await expect(page.getByText(/237[.,]50/).first()).toBeVisible();

  await goTo(page, 'settings');
  await page.locator('#rail-tweaks').click();
  await expect(page.locator('#feature-templates')).not.toBeChecked();
  await expect(page.locator('#feature-reports')).not.toBeChecked();
  await page.locator('label[for="feature-flow"]').click();
  await expect(page.locator('#feature-reports')).toBeChecked();
  await expect(page.locator('#feature-reports')).toBeDisabled();
  await page.locator('label[for="feature-flow"]').click();
  await expect(page.locator('#feature-reports')).toBeEnabled();
  await page.locator('#tweaks').evaluate(el => { el.scrollTop = 0; });
  await page.locator('#tweaks').screenshot({ path: '/tmp/advanced-mode.png' });
  expect(page.__errors).toEqual([]);
});


test('net worth: aligned controls, live drafts, grouped accounts and explicit saves', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 1000 });
  await preparePage(page);
  await loadExampleAsGuest(page);
  await page.evaluate(async () => { const { navigate } = await import('/js/app.js'); await navigate('net-worth'); });
  const chart = page.locator('.net-worth-projection-chart');
  const centeredWith = async (a, b) => {
    const left = await a.boundingBox(), right = await b.boundingBox();
    expect(Math.abs(left.y + left.height / 2 - right.y - right.height / 2)).toBeLessThan(1);
  };
  await centeredWith(page.locator('.net-worth-whatif-row'), page.locator('.net-worth-source'));
  await centeredWith(page.locator('.net-worth-horizons'), chart.locator('.bv-chart-scale'));
  await centeredWith(chart.locator('.bv-chart-change'), page.locator('.net-worth-bulk-actions'));
  const growth = page.getByRole('textbox', { name: 'Expected yearly growth for Current Account, in percent', exact: true });
  const saved = () => page.evaluate(async () => {
    const { state } = await import('/js/app.js');
    return state.accounts.find(a => a.name === 'Current Account').expectedGrowth ?? null;
  });
  const original = await saved();
  const initialSummary = await chart.locator('.bv-chart-change').textContent();
  const saveAll = page.getByRole('button', { name: 'Save all', exact: true });
  const resetAll = page.getByRole('button', { name: 'Reset all', exact: true });
  await expect(saveAll).toBeDisabled();
  await growth.fill('3');
  await growth.pressSequentially('.5');
  await expect(growth).toHaveValue('3.5');
  await expect(growth).toBeFocused();
  expect(await saved()).toBe(original);
  expect(await chart.locator('.bv-chart-change').textContent()).not.toBe(initialSummary);
  await expect(saveAll).toBeEnabled();
  await saveAll.click();
  await expect(growth).toBeEnabled();
  expect(await saved()).toBe(original);
  expect(await page.evaluate(async () => {
    const { state } = await import('/js/app.js');
    const id = state.accounts.find(a => a.name === 'Current Account').id;
    return state.meta.netWorthSimulations.at(-1).accounts.find(a => a.id === id).expectedGrowth;
  })).toBe(3.5);
  await expect(saveAll).toBeDisabled();
  await growth.fill('5');
  const bank = page.locator('[data-account-type="bank"]');
  await bank.click();
  await expect(bank).toHaveAttribute('aria-expanded', 'false');
  await expect(bank).toContainText('1 unsaved');
  await expect(growth).toBeHidden();
  await resetAll.click();
  await bank.click();
  await expect(growth).toHaveValue('3,5');
  await expect(saveAll).toBeDisabled();
  const config = page.getByLabel('Simulation', { exact: true });
  const originalConfig = await config.inputValue();
  await page.getByRole('button', { name: 'Duplicate', exact: true }).click();
  await page.locator('.sheet').last().locator('input').fill('Optimistic');
  await page.locator('.sheet').last().getByRole('button', { name: 'Save', exact: true }).click();
  await expect(config).toBeEnabled();
  const duplicateId = await config.inputValue();
  expect(duplicateId).not.toBe(originalConfig);
  await page.getByRole('button', { name: 'Rename', exact: true }).click();
  await page.locator('.sheet').last().locator('input').fill('Retirement');
  await page.locator('.sheet').last().getByRole('button', { name: 'Save', exact: true }).click();
  await expect(config.locator('option:checked')).toHaveText('Retirement');
  await page.getByRole('button', { name: 'Use budget & account settings', exact: true }).click();
  await expect(growth).toHaveValue('');
  await expect(saveAll).toBeEnabled();
  await resetAll.click();
  await expect(growth).toHaveValue('3,5');
  await config.selectOption('');
  await expect(growth).toHaveValue('');
  await expect(saveAll).toBeDisabled();
  await config.selectOption(duplicateId);
  await expect(growth).toHaveValue('3,5');
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await page.locator('.sheet').last().getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(config).toHaveValue('');
  await expect(config.locator(`option[value="${duplicateId}"]`)).toHaveCount(0);
  await config.selectOption(originalConfig);
  await expect(growth).toHaveValue('3,5');
  const card = page.locator('section.card').filter({ has: page.locator('.net-worth-config-row') });
  await card.evaluate(el => window.scrollTo(0, window.scrollY + el.getBoundingClientRect().top - 140));
  await page.screenshot({ path: '/tmp/simulations-desktop.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(500); // Allow the responsive sidebar transition to finish before the screenshot.
  await card.evaluate(el => window.scrollTo(0, window.scrollY + el.getBoundingClientRect().top - 140));
  await page.screenshot({ path: '/tmp/simulations-mobile.png' });
  const wrap = page.locator('.net-worth-table-wrap');
  expect(await wrap.evaluate(el => el.scrollWidth > el.clientWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(page.__errors).toEqual([]);
});


test('daily summaries remember details and align envelope figures across widths', async ({ page }) => {
  await preparePage(page);
  await loadExampleAsGuest(page);
  const breakdown = page.locator('.overview-pool-breakdown');
  await expect(breakdown).not.toHaveAttribute('open');
  await breakdown.locator('summary').focus();
  await page.keyboard.press('Enter');
  await expect(breakdown).toHaveAttribute('open', '');
  await goTo(page, 'envelopes');
  await page.locator('.env-details-toggle').focus();
  await page.keyboard.press('Space');
  await expect(page.locator('.env-details-toggle')).toHaveAttribute('aria-pressed', 'true');
  await goTo(page, 'dashboard');
  await expect(breakdown).toHaveAttribute('open', '');
  await expect(page.locator('.overview-forecast-details')).not.toHaveAttribute('open');
  await goTo(page, 'envelopes');
  await expect(page.locator('.env-details-toggle')).toHaveAttribute('aria-pressed', 'true');
  await page.locator('.env-details-toggle').click();
  await page.evaluate(async () => {
    const { state } = await import('/js/app.js');
    state.envelopes = state.envelopes.map((env, i) => i ? env : { ...env, name: 'Household savings and planned renovation reserve with a deliberately long name' });
  });
  await page.mouse.move(0, 0);
  for (const width of [1440, 1024, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.evaluate(async () => (await import('/js/app.js')).navigate('envelopes'));
    const cards = page.locator('.env-grid > .env');
    await expect(cards.first()).toBeVisible();
    const rows = await cards.evaluateAll(nodes => nodes.map(card => ({
      top: card.getBoundingClientRect().top,
      amount: card.querySelector('.env-amt').getBoundingClientRect().top,
      fits: [...card.querySelectorAll('.money-summary,.env-name')].every(el => el.scrollWidth <= el.clientWidth + 1),
    })));
    for (const card of rows) {
      expect(card.fits, `names and amounts fit at ${width}`).toBe(true);
      for (const peer of rows.filter(p => Math.abs(p.top - card.top) < 1)) expect(Math.abs(peer.amount - card.amount)).toBeLessThan(1);
    }
  }
  expect(page.__errors).toEqual([]);
});

test('Transactions keeps filters optional and bulk tools contextual', async ({ page }) => {
  await preparePage(page);
  await loadExampleAsGuest(page);
  await goTo(page, 'transactions');
  const filters = page.locator('[aria-controls="tx-filters-advanced"]');
  await expect(filters).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('.filter-chips')).toBeHidden();
  await filters.focus();
  await page.keyboard.press('Enter');
  await page.getByRole('combobox', { name: 'All types', exact: true }).selectOption('expense');
  await filters.click();
  await expect(page.locator('.filter-chips')).toContainText('Expense');
  await expect(page.locator('#tx-filters-advanced')).toBeHidden();
  await page.locator('.tx-select-mode').focus();
  await page.keyboard.press('Space');
  await expect(page.locator('.tx-bulk-tools')).toBeHidden();
  await page.getByRole('button', { name: 'Select all', exact: true }).click();
  await expect(page.locator('.tx-bulk-tools')).toBeVisible();
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  }
  await page.getByRole('button', { name: 'Select none', exact: true }).click();
  await expect(page.locator('.tx-bulk-tools')).toBeHidden();
  await page.locator('.tx-select-mode').click();
  await expect(page.locator('.tx-selection-bar')).toBeHidden();
  await expect(page.locator('.filter-chips')).toContainText('Expense');
});

test('transaction notes are optional, keyboard accessible and preserved on save', async ({ page }) => {
  await preparePage(page);
  await loadExampleAsGuest(page);
  await goTo(page, 'transactions');
  await page.getByRole('button', { name: 'New transaction' }).first().click();
  const editor = page.locator('.tx-editor');
  const notes = editor.locator('.tx-note');
  await expect(editor.getByRole('textbox', { name: 'Note', exact: true })).toBeHidden();
  await notes.locator('summary').focus();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Tab');
  await expect(editor.getByRole('textbox', { name: 'Note', exact: true })).toBeFocused();
  await editor.getByRole('textbox', { name: 'Note', exact: true }).fill('Receipt retained');
  await notes.locator('summary').click();
  await editor.locator('input[name="payee"]').fill('Note audit');
  await editor.locator('input[name="amount"]').fill('12');
  await editor.getByRole('combobox', { name: 'Type to find an envelope' }).first().fill('Groceries');
  await editor.getByRole('option', { name: 'Groceries' }).first().click();
  await page.getByRole('button', { name: 'Add & close' }).click();
  await expect(editor).toHaveCount(0);
  await page.evaluate(async () => {
    const { state } = await import('/js/app.js');
    (await import('/js/pages/edit-tx.js')).openEditTx(state.transactions.find(tx => tx.payee === 'Note audit'));
  });
  await expect(editor.getByRole('textbox', { name: 'Note', exact: true })).toBeVisible();
  await expect(editor.getByRole('textbox', { name: 'Note', exact: true })).toHaveValue('Receipt retained');
  await notes.locator('summary').click();
  await editor.locator('input[name="amount"]').fill('13');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(editor).toHaveCount(0);
  expect(await page.evaluate(async () => {
    const { state } = await import('/js/app.js');
    return state.transactions.find(tx => tx.payee === 'Note audit').note;
  })).toBe('Receipt retained');
  expect(page.__errors).toEqual([]);
});
