import { test, expect } from '@playwright/test';
import { preparePage } from './static-helpers.js';

test('remember a correction, reuse it, and explicitly resolve conflicting rules', async ({ page }, testInfo) => {
  await preparePage(page);
  await page.goto('/');
  await page.getByRole('button', { name: /guest/i }).click();
  await page.getByRole('button', { name: 'Load example budget' }).click();
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
  const ids = await page.evaluate(async () => {
    const { state } = await import('/js/app.js');
    return { account: state.accounts.find(a=>a.id==='acct-checking').id, food:state.envelopes.find(e=>e.name==='Groceries').id, other:state.envelopes.find(e=>e.id==='env-dining').id };
  });
  const active = () => page.locator('[data-sheet-open]').last();
  async function review(csv) {
    await page.evaluate(async () => { const { state } = await import('/js/app.js'); (await import('/js/import/import-sheet.js')).openImportSheet(state); });
    await active().locator('input[type=file]').setInputFiles({name:'rules.csv',mimeType:'text/csv',buffer:Buffer.from(csv)});
    await active().locator('.field').filter({has:page.locator('label').filter({hasText:/^Account$/})}).locator('select').selectOption(ids.account);
    await active().getByRole('button',{name:/^Review/}).click();
    await expect(active().getByRole('button',{name:'Manage rules',exact:true})).toBeVisible();
  }
  const approve = () => active().getByRole('button',{name:/^Import \d/});
  await review('Date,Payee,Amount\n2026-09-10,Test Market,-12.50');
  await active().getByRole('combobox').fill('Groceries');
  await active().getByRole('option',{name:'Groceries',exact:true}).click();
  await active().getByRole('button',{name:'Remember correction'}).click();
  await expect(active().getByLabel('Merchant text',{exact:true})).toHaveValue('Test Market');
  await active().getByLabel('Rule name',{exact:true}).fill('Market groceries');
  await expect(active().getByRole('button',{name:'Save',exact:true})).toBeEnabled();
  await active().locator('.import-rule-preview-list').scrollIntoViewIfNeeded();
  await expect(page.locator('.toast')).toHaveCount(0);
  await page.screenshot({path:testInfo.outputPath('rule-preview.png'),animations:'disabled'});
  await active().getByRole('button',{name:'Save',exact:true}).click();
  await expect(page.locator('[data-sheet-open]')).toHaveCount(1);
  await approve().click();
  await expect(page.locator('[data-sheet-open]')).toHaveCount(0);
  await review('Date,Payee,Amount\n2026-09-11,Test Market,-14\n2026-09-12,Test Market,20');
  await expect(active().locator('select.import-env').first()).toHaveValue(ids.food);
  // The same-name income must not match the expense rule.
  expect(await active().locator('.import-rule-row').nth(1).textContent()).not.toContain('Market groceries');
  await expect(page.locator('.toast')).toHaveCount(0);
  await page.screenshot({path:testInfo.outputPath('normal-review.png'),animations:'disabled'});
  await active().getByRole('button',{name:'Manage rules',exact:true}).click();
  await active().getByRole('button',{name:'Create rule',exact:true}).click();
  await active().getByLabel('Rule name',{exact:true}).fill('Alternate market');
  await active().getByLabel('Merchant text',{exact:true}).fill('Test Market');
  await active().getByRole('combobox',{name:'Envelope',exact:true}).fill('Dining');
  await active().getByRole('option',{name:'Dining Out',exact:true}).click();
  await active().getByRole('button',{name:'Save',exact:true}).click();
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-sheet-open]')).toHaveCount(1);
  await expect(approve()).toBeDisabled();
  await page.screenshot({path:testInfo.outputPath('conflict.png'),animations:'disabled'});
  await page.setViewportSize({width:390,height:844});
  await page.evaluate(()=>document.documentElement.dataset.theme='dark');
  await active().locator('.import-rule-conflict').scrollIntoViewIfNeeded();
  await page.screenshot({path:testInfo.outputPath('conflict-narrow-dark.png'),animations:'disabled'});
  await active().locator('.import-rule-conflict').getByRole('button',{name:'Groceries',exact:true}).click();
  await expect(approve()).toBeEnabled();
  await approve().click();
  await expect(page.locator('[data-sheet-open]')).toHaveCount(0);
  const rows = await page.evaluate(async ()=>(await import('/js/app.js')).state.transactions.filter(t=>t.payee==='Test Market'));
  expect(rows.map(r=>[r.date,r.amount,r.type])).toEqual([['2026-09-10',12.5,'expense'],['2026-09-11',14,'expense'],['2026-09-12',20,'income']]);
  expect(rows[1].envelope_id).toBe(ids.food);
  expect(page.__errors).toEqual([]);
});
