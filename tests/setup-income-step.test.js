// @vitest-environment jsdom
// Setup wizard, income step (BACKLOG 2026-10-05): the main monthly income,
// its payday, the account it is paid into and whether it moves to a working
// day. Finish stores it as an income plan item built by budgetItem.create, so
// the plan and the scheduler (month.start) pick it up. The step is optional.
import { it, expect, vi, beforeEach, describe } from 'vitest';
vi.mock('../js/app.js', async () => (await import('./_fakes/pageApp.js')).appStub);
vi.mock('../js/ai/client.js', () => ({ isCloudMode: () => false, aiInsights: vi.fn() }));
vi.mock('../js/ui/sheet.js', () => ({ openSheet: vi.fn(() => ({ close() {} })) }));
vi.mock('../js/ui/tour.js', () => ({ maybeAutoStartTour: vi.fn() }));
import { state, resetState } from './_fakes/pageApp.js';
import { beginBudgetSession, budgetHeld } from '../js/state/budget-session.js';
import { GUEST_FOLDER, resetGuestMemory, readJson } from '../js/storage/guest-adapter.js';
import { runSetupWizard, readIncome, incomePlanItem } from '../js/setup.js';
import { setLang, t } from '../js/ui/i18n.js';
import { registry } from '../js/core/index.js';
import { runCommand } from '../js/core/pipeline.js';
import { makeCtx } from '../js/core/context.js';
import { checkItem } from '../js/core/entity-fields.js';

const ALL_MONTHS = { Jan: true, Feb: true, Mar: true, Apr: true, May: true, Jun: true, Jul: true, Aug: true, Sep: true, Oct: true, Nov: true, Dec: true };
const $ = (id) => /** @type {any} */ (document.getElementById(id));

beforeEach(() => {
  setLang('en');
  resetState(); resetGuestMemory(); beginBudgetSession();
  state.budgetFolder = GUEST_FOLDER;
  state.meta = null;
  document.body.innerHTML = '<div id="app"></div>';
});

async function toIncomeStep({ account = 'Main account', balance = '1500' } = {}) {
  await runSetupWizard($('app'), GUEST_FOLDER);
  $('setup-next1').click();
  $('setup-acct-name').value = account;
  $('setup-acct-balance').value = balance;
  $('setup-next2').click();
}

async function finish() {
  $('setup-finish').click();
  await vi.waitFor(() => expect(budgetHeld()).toBe(false));
}

describe('income step', () => {
  it('comes after the account step, as step 3 of 4', async () => {
    await toIncomeStep();
    expect($('app').textContent).toContain('Step 3 of 4');
    expect($('app').textContent).toContain(t('setup.incomeTitle'));
    // The account entered in step 2 is the one it is paid into.
    expect($('setup-income-account').disabled).toBe(true);
    expect($('setup-income-account').textContent).toBe('Main account');
    // Finnish pay moves to the working day before a weekend or holiday.
    expect($('setup-income-daytype').value).toBe('prev_work_day');
  });

  it('stores an income plan item paid into the account, and the review lists it', async () => {
    await toIncomeStep();
    $('setup-income-amount').value = '3200';
    $('setup-income-day').value = '15';
    $('setup-next3').click();

    expect($('app').textContent).toContain('Step 4 of 4');
    expect($('setup-review-income').textContent).toMatch(/3\D?200[.,]00 a month, on day 15/);

    await finish();
    const accounts = await readJson(GUEST_FOLDER, 'accounts.json');
    const items = await readJson(GUEST_FOLDER, 'budget-items.json');
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: 'income',
      description: 'Salary',
      default_amount: 3200,
      payment_day: 15,
      monthly_schedule: ALL_MONTHS,
      include: true,
      as_schedule: true,
      account_id: accounts[0].id,
      schedule_day_type: 'prev_work_day',
      as_schedule_since: '2026-09-15',
      envelope_id: null,
    });
    expect(items[0].id).toBe('income-item');
    // It passes the Plan editor's checks against the saved budget.
    expect(checkItem(items[0], { accounts, envelopes: await readJson(GUEST_FOLDER, 'envelopes.json') })).toBeNull();
    expect(state.budgetItems).toEqual(items);
  });

  it('is picked up by the scheduler: month.start posts it on payday, moved to the working day before', async () => {
    await toIncomeStep();
    $('setup-income-amount').value = '3200';
    $('setup-income-day').value = '15';
    $('setup-next3').click();
    await finish();

    const data = {
      meta: await readJson(GUEST_FOLDER, 'budget-meta.json'),
      accounts: await readJson(GUEST_FOLDER, 'accounts.json'),
      envelopes: await readJson(GUEST_FOLDER, 'envelopes.json'),
      budgetItems: await readJson(GUEST_FOLDER, 'budget-items.json'),
      envelopeTemplates: [],
      transactions: [],
    };
    // 15 Nov 2026 is a Sunday: paid on Friday 13 Nov.
    let n = 0;
    const ctx = makeCtx({ now: new Date(2026, 10, 20, 9), newId: () => `n${++n}`, country: 'FI' });
    const r = runCommand(registry, data, 'month.start', {}, ctx);
    expect(r.ok).toBe(true);
    const nov = r.value.changes.transactions.find(tx => tx.from_budget === 'income-item:2026-11');
    expect(nov).toMatchObject({ type: 'income', date: '2026-11-13', amount: 3200, account: data.accounts[0].id });
  });

  it('without an account the income is planned but not posted', async () => {
    await toIncomeStep({ account: '', balance: '' });
    expect($('setup-income-account')).toBeNull();
    expect($('setup-income-daytype')).toBeNull();
    expect($('setup-income-noacct').textContent).toBe(t('setup.incomeNoAccount'));
    $('setup-income-amount').value = '2850,50';
    $('setup-income-day').value = '31';
    $('setup-next3').click();
    await finish();
    const [item] = await readJson(GUEST_FOLDER, 'budget-items.json');
    expect(item).toMatchObject({
      kind: 'income', default_amount: 2850.5, payment_day: 31,
      as_schedule: false, account_id: null, schedule_day_type: 'exact', as_schedule_since: null,
    });
  });

  it('refuses an unreadable amount or payday and stays on the step', async () => {
    await toIncomeStep();
    $('setup-income-amount').value = 'lots';
    $('setup-income-day').value = '15';
    $('setup-next3').click();
    expect($('setup-income-error').textContent).toBe(t('setup.incomeAmountInvalid'));
    expect($('setup-finish')).toBeNull();

    $('setup-income-amount').value = '3200';
    $('setup-income-day').value = '';
    $('setup-next3').click();
    expect($('setup-income-error').textContent).toBe(t('setup.incomeDayInvalid'));
    $('setup-income-day').value = '32';
    $('setup-next3').click();
    expect($('setup-income-error').textContent).toBe(t('setup.incomeDayInvalid'));
    expect($('setup-finish')).toBeNull();
  });

  it('keeps what was entered on Back from the review', async () => {
    await toIncomeStep();
    $('setup-income-amount').value = '3200';
    $('setup-income-day').value = '25';
    $('setup-income-daytype').value = 'next_work_day';
    $('setup-next3').click();
    $('setup-back3').click();
    expect($('setup-income-amount').value).toBe('3200');
    expect($('setup-income-day').value).toBe('25');
    expect($('setup-income-daytype').value).toBe('next_work_day');
  });

  it('Skip leaves the income out, even after something was typed', async () => {
    await toIncomeStep();
    $('setup-income-amount').value = '3200';
    $('setup-income-day').value = '15';
    $('setup-skip-income').click();
    expect($('setup-review-income')).toBeNull();
    await finish();
    expect(await readJson(GUEST_FOLDER, 'budget-items.json')).toEqual([]);
  });
});

describe('readIncome', () => {
  it('is null for a blank amount (the step skipped)', () => {
    expect(readIncome({ amount: '', day: '15', dayType: 'exact' })).toBeNull();
    expect(readIncome({ amount: '   ', day: '', dayType: 'exact' })).toBeNull();
  });
  it('reads the amount as the amount inputs do, and the payday', () => {
    expect(readIncome({ amount: '2 850,50', day: '1', dayType: 'next_work_day' }))
      .toEqual({ amount: 2850.5, day: 1, dayType: 'next_work_day' });
  });
  it('marks a non-positive amount or a day outside 1-31 as unreadable', () => {
    expect(readIncome({ amount: '-100', day: '0', dayType: 'exact' })).toEqual({ amount: null, day: null, dayType: 'exact' });
    expect(readIncome({ amount: '100', day: '1.5', dayType: 'exact' })?.day).toBeNull();
  });
});

describe('incomePlanItem', () => {
  const data = { budgetItems: [{ id: 'income-item' }], accounts: [{ id: 'chk', name: 'Checking', type: 'bank' }], envelopes: [] };
  it('takes the next free id beside the AI-suggested items', () => {
    const item = incomePlanItem({ amount: '100', day: '5', dayType: 'exact' }, data, new Date(2026, 9, 6));
    expect(item?.id).toBe('income-item-2');
    expect(item?.as_schedule_since).toBe('2026-10-06');
  });
  it('throws what budgetItem.create refuses', () => {
    expect(() => incomePlanItem({ amount: 'x', day: '5', dayType: 'exact' }, data, new Date(2026, 9, 6)))
      .toThrow(/default_amount/);
  });
});
