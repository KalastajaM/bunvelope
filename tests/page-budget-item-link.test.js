// @vitest-environment jsdom
// Fill %: the "Budget item" picker on an expense (add and edit sheets) and the
// health sheet's Budget items block.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../js/app.js', async () => (await import('./_fakes/pageApp.js')).appStub);

import { openAddTx } from '../js/pages/add-tx.js';
import { openEditTx } from '../js/pages/edit-tx.js';
import { itemFundingSection, itemFundingSummary } from '../js/ui/item-funding-view.js';
import { computeItemFunding } from '../js/engine.js';
import { rebuildPayeeIndex } from '../js/state/payee-index.js';
import { t } from '../js/ui/i18n.js';
import { state, resetState, mountHosts, flush, setValue, FIXED_NOW } from './_fakes/pageApp.js';

const ALL = { Jan: true, Feb: true, Mar: true, Apr: true, May: true, Jun: true, Jul: true, Aug: true, Sep: true, Oct: true, Nov: true, Dec: true };
const items = [
  { id: 'evenli', envelope_id: 'fun', description: 'Evenli', kind: 'expense', default_amount: -50, monthly_schedule: ALL, payment_day: 20, include: true, funding_style: 'bill' },
  { id: 'misc', envelope_id: 'fun', description: 'Misc charging', kind: 'expense', default_amount: -75, monthly_schedule: ALL, payment_day: 1, include: true, funding_style: 'spending' },
  { id: 'groc', envelope_id: 'food', description: 'Groceries', kind: 'expense', default_amount: -400, monthly_schedule: ALL, payment_day: 1, include: true },
];

const form = () => document.querySelector('#sheet-host form');
const input = (name) => form().querySelector(`input[name="${name}"]`);
const itemField = () => form().querySelector('.budget-item-field');
const itemSelect = () => itemField().querySelector('select');
const envSelect = () => form().querySelector('.split-env');
// Both the add page and the edit page write through the session and leave the ledger in state.
const written = () => state.transactions;

beforeEach(() => {
  resetState();
  state.budgetItems = items;
  mountHosts();
  vi.stubGlobal('requestAnimationFrame', (cb) => setTimeout(cb, 0));
});

describe('add an expense', () => {
  beforeEach(() => openAddTx());
  const save = async () => {
    [...document.querySelectorAll('.sheet-header .sheet-footer-actions-end button')][1].click();
    await flush();
  };

  it('shows the picker only for an envelope with two or more items', () => {
    expect(itemField().hidden).toBe(true);
    setValue(envSelect(), 'food');
    expect(itemField().hidden).toBe(true);
    setValue(envSelect(), 'fun');
    expect(itemField().hidden).toBe(false);
    expect([...itemSelect().options].map(o => o.textContent)).toEqual([t('itemLink.automatic'), 'Evenli', 'Misc charging']);
  });

  it('saves the picked item, and Automatic saves no link', async () => {
    setValue(input('amount'), '62');
    setValue(input('date'), '2026-09-10');
    setValue(envSelect(), 'fun');
    setValue(itemSelect(), 'evenli');
    await save();
    expect(written().at(-1)).toMatchObject({ envelope_id: 'fun', budget_item_id: 'evenli' });
  });

  it('opens contextual help without losing the selected item or the draft', async () => {
    setValue(envSelect(), 'fun');
    setValue(itemSelect(), 'evenli');
    setValue(input('amount'), '62');
    itemField().querySelector('.info-btn').click();
    const help = [...document.querySelectorAll('.sheet-overlay')].at(-1);
    expect(help.textContent).toContain(t('itemLink.hint'));
    [...help.querySelectorAll('button')].find(b => b.textContent === t('common.close')).click();
    expect(itemSelect().value).toBe('evenli');
    expect(input('amount').value).toBe('62');
    await save();
    expect(written().at(-1)).toMatchObject({ amount: 62, budget_item_id: 'evenli' });
  });

  it('Automatic stores nothing', async () => {
    setValue(input('amount'), '12');
    setValue(input('date'), '2026-09-10');
    setValue(envSelect(), 'fun');
    await save();
    expect(written().at(-1).budget_item_id).toBeUndefined();
  });

  it('changing the envelope drops the pick', () => {
    setValue(envSelect(), 'fun');
    setValue(itemSelect(), 'misc');
    setValue(envSelect(), 'rent');
    setValue(envSelect(), 'fun');
    expect(itemSelect().value).toBe('');
  });
});

describe('payee memory', () => {
  it('fills the item the payee was last linked to', () => {
    state.transactions = [{ id: 'p', type: 'expense', date: '2026-09-01', payee: 'Evenli Oy', amount: 50, envelope_id: 'fun', account: 'chk', status: 'posted', budget_item_id: 'evenli' }];
    rebuildPayeeIndex(state);
    openAddTx();
    setValue(input('payee'), 'Evenli Oy', ['input']);
    expect(envSelect().value).toBe('fun');
    expect(itemSelect().value).toBe('evenli');
  });
});

describe('edit an expense', () => {
  const tx = { id: 'e', type: 'expense', date: '2026-09-10', payee: 'Charger', amount: 20, envelope_id: 'fun', account: 'chk', status: 'posted', budget_item_id: 'misc' };
  const save = async () => {
    [...document.querySelectorAll('#sheet-host .sheet button')].find(b => b.textContent === t('addTx.save')).click();
    await flush();
  };

  it('shows the stored link and keeps it on save', async () => {
    state.transactions = [tx];
    openEditTx(tx);
    expect(itemSelect().value).toBe('misc');
    setValue(input('amount'), '21');
    await save();
    expect(written()[0]).toMatchObject({ amount: 21, budget_item_id: 'misc' });
  });

  it('moving it to another envelope drops the link', async () => {
    state.transactions = [tx];
    openEditTx(tx);
    setValue(envSelect(), 'food');
    await save();
    expect(written()[0].envelope_id).toBe('food');
    expect(written()[0].budget_item_id).toBeUndefined();
  });
});

describe('health sheet block', () => {
  const funding = (balance, daily = null) => computeItemFunding({
    envelopeId: 'fun', budgetItems: items, transactions: [], balance, today: FIXED_NOW, daily,
  });
  // Evenli is paid on the 20th; misc spending then takes the envelope to −25.
  const dips = [
    { date: '2026-09-15', balance: 100 },
    { date: '2026-09-20', balance: 50 },
    { date: '2026-09-30', balance: -25 },
  ];

  it('one row per item, bill first, with the projection\'s status', () => {
    const el = itemFundingSection(funding(100, dips));
    const rows = [...el.querySelectorAll('.item-funding-row')];
    expect(rows.map(r => r.dataset.itemId)).toEqual(['evenli', 'misc']);
    expect(rows[0].textContent).toContain(t('itemFunding.funded'));
    expect(rows[1].textContent).toContain(t('itemFunding.short')('$25.00').split('$')[0]);
    expect(rows[1].querySelector('.env-meter').classList.contains('is-tight')).toBe(true);
    expect(el.textContent).toContain(t('itemFunding.shortfall')('').trim());
  });

  it('never says "needs X now"; a partly saved bill says where the rest comes from', () => {
    const partly = itemFundingSection(funding(30, [{ date: '2026-09-15', balance: 30 }, { date: '2026-09-20', balance: 0 }]));
    const evenli = partly.querySelector('[data-item-id="evenli"]').textContent;
    expect(evenli).toContain(t('itemFunding.restFromFills'));
    expect(evenli).toContain(t('itemFunding.onTrack'));

    const short = itemFundingSection(funding(30, [{ date: '2026-09-15', balance: 30 }, { date: '2026-09-20', balance: -20 }]));
    expect(short.querySelector('[data-item-id="evenli"]').textContent).toContain(t('itemFunding.shortByThen')('$20.00').split('$')[0]);
  });

  it('the card line counts items on track', () => {
    expect(itemFundingSummary(funding(125))).toEqual({ text: t('itemFunding.cardLine')(2, 2), problem: false });
    expect(itemFundingSummary(funding(100, dips))).toEqual({ text: t('itemFunding.cardLine')(1, 2), problem: true });
    expect(itemFundingSummary(null)).toBeNull();
  });
});

describe('a split expense: each line names its own item', () => {
  const linePicks = () => [...form().querySelectorAll('.budget-item-line')];
  const envSelects = () => [...form().querySelectorAll('.split-env')];
  const amounts = () => [...form().querySelectorAll('.split-amt')];

  it('add: shows a picker under a line whose envelope has two or more items, and saves its pick', async () => {
    openAddTx();
    setValue(input('amount'), '100');
    setValue(input('date'), '2026-09-10');
    setValue(envSelects()[0], 'food');
    // Leaving the first line at 60 adds a line for the remaining 40.
    setValue(amounts()[0], '60');
    setValue(envSelects()[1], 'fun');
    // The single-envelope picker gives way to one per line.
    expect(itemField().hidden).toBe(true);
    expect(linePicks().map(p => p.hidden)).toEqual([true, false]);
    setValue(linePicks()[1].querySelector('select'), 'evenli');
    [...document.querySelectorAll('.sheet-header .sheet-footer-actions-end button')][1].click();
    await flush();
    expect(written().at(-1).envelope_splits).toEqual([
      { envelope_id: 'food', amount: 60 },
      { envelope_id: 'fun', amount: 40, budget_item_id: 'evenli' },
    ]);
  });

  it('edit: shows each line’s stored link and keeps it on save', async () => {
    const tx = {
      id: 's', type: 'expense', date: '2026-09-10', payee: 'Mixed', amount: 100, envelope_id: null, account: 'chk', status: 'posted',
      envelope_splits: [{ envelope_id: 'food', amount: 60 }, { envelope_id: 'fun', amount: 40, budget_item_id: 'misc' }],
    };
    state.transactions = [tx];
    openEditTx(tx);
    expect(linePicks()[1].querySelector('select').value).toBe('misc');
    setValue(input('payee'), 'Mixed shop');
    [...document.querySelectorAll('#sheet-host .sheet button')].find(b => b.textContent === t('addTx.save')).click();
    await flush();
    expect(written()[0].envelope_splits[1]).toEqual({ envelope_id: 'fun', amount: 40, budget_item_id: 'misc' });
  });
});
