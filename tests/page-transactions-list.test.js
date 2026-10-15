// @vitest-environment jsdom
// Transactions list: the writes its row and bulk actions make. Every one
// (cleared, flagged, delete, bulk flag, set date, change payee, assign
// envelope, merge into a transfer) dispatches through the session (the real
// browser session over the fake state in _fakes/pageApp.js), so these tests
// assert on state.transactions, meta and writeBatch, the storage boundary.
// A delete or merge of a materialised scheduled row also tombstones its
// from_budget key in meta; each bulk action offers an Undo on its toast, and a
// refused write leaves state untouched and the selection kept. Drives the real
// js/pages/transactions.js.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../js/app.js', async () => (await import('./_fakes/pageApp.js')).appStub);

import { render } from '../js/pages/transactions.js';
import { t } from '../js/ui/i18n.js';
import {
  state, writeBatch, FIXED_NOW, resetState, mountHosts, flush, setValue,
  topOverlay, dialogOk, dialogButton, toastTexts,
} from './_fakes/pageApp.js';

const root = () => document.getElementById('app-root');
const rowEl = (id) => root().querySelector(`[data-tx-id="${id}"]`);
const rowIds = () => [...root().querySelectorAll('.tx-row')].map(r => r.dataset.txId);
const select = (...ids) => { for (const id of ids) rowEl(id).querySelector('.tx-row-open').click(); };
const bar = () => root().querySelector('.bulk-actions');
const barBtn = (title) => [...bar().querySelectorAll('button')]
  .find(b => b.title === title || b.textContent === title);
// What the session stamps on a row it changes: the injected clock, not wall time.
const AT = FIXED_NOW.toISOString();
const byId = (id) => state.transactions.find(x => x.id === id);
// Failure toasts are announced assertively (role=alert).
const alertTexts = () => [...document.querySelectorAll('#toast-host .toast[role="alert"]')].map(el => el.textContent);
const toastButton = () => document.querySelector('#toast-host .toast-action');
const sheetInput = () => topOverlay().querySelector('input');
const sheetButton = (label) => [...topOverlay().querySelectorAll('button')].find(b => b.textContent === label);

let ledger;

async function openPage() {
  mountHosts();
  await render(root());
}

async function enterSelectMode() {
  [...root().querySelectorAll('button')]
    .find(b => b.textContent === t('transactions.selectMode')).click();
}

beforeEach(async () => {
  vi.stubGlobal('requestAnimationFrame', (cb) => setTimeout(cb, 0));
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} unobserve() {} });
  // The virtual list renders what fits the scroller; jsdom has no layout.
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get() { return 4000; } });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  ledger = [
    { id: 'x1', type: 'expense', date: '2026-09-10', payee: 'Grocer', amount: 50, envelope_id: 'food', account: 'chk', status: 'posted' },
    { id: 'x2', type: 'expense', date: '2026-09-10', payee: 'Cinema', amount: 20, envelope_id: 'fun', account: 'chk', status: 'posted' },
    { id: 'i2', type: 'income', date: '2026-09-09', payee: 'Refund', amount: 50, envelope_id: null, account: 'sav', status: 'posted' },
    { id: 'b1', type: 'expense', date: '2026-09-08', payee: 'Netflix', amount: 10, envelope_id: 'fun', account: 'chk', status: 'posted', from_budget: 'bp:netflix:2026-09' },
  ];
  resetState({ transactions: ledger });
  await openPage();
});

afterEach(() => {
  delete HTMLElement.prototype.clientHeight;
});

describe('transactions list', () => {
  it('lists the ledger newest first', () => {
    // Same-day rows may tie-break either way.
    expect(rowIds().slice(0, 2).sort()).toEqual(['x1', 'x2']);
    expect(rowIds().slice(2)).toEqual(['i2', 'b1']);
  });

  it('select mode hides the bulk actions until something is selected, then enables them', async () => {
    await enterSelectMode();
    expect(root().querySelector('.tx-bulk-tools').hidden).toBe(true);
    expect(barBtn(t('transactions.selectAll')).hidden).toBe(false);
    expect(barBtn(t('transactions.deleteSelected')).disabled).toBe(true);
    select('x1');
    expect(root().querySelector('.tx-bulk-tools').hidden).toBe(false);
    expect(barBtn(t('transactions.deleteSelected')).disabled).toBe(false);
  });

  it('keeps filters open across a repainting navigation, while closed filters keep their chips', async () => {
    const toggle = root().querySelector('[aria-controls="tx-filters-advanced"]');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    toggle.click();
    const typeSel = root().querySelector('select[aria-label="' + t('transactions.typeAll') + '"]');
    setValue(typeSel, 'income', ['change']);
    await openPage();
    const restored = root().querySelector('[aria-controls="tx-filters-advanced"]');
    expect(restored.getAttribute('aria-expanded')).toBe('true');
    restored.click();
    expect(root().querySelector('.filter-chips').textContent).toContain(t('transactions.typeIncome'));
    expect(rowIds()).toEqual(['i2']);
    setValue(root().querySelector('select[aria-label="' + t('transactions.typeAll') + '"]'), 'all', ['change']);
  });

  it('the select-all toggle selects every visible row, and again clears them', async () => {
    await enterSelectMode();
    barBtn(t('transactions.selectAll')).click();
    expect(root().querySelectorAll('.tx-row.is-selected')).toHaveLength(4);
    barBtn(t('transactions.selectNone')).click();
    expect(root().querySelectorAll('.tx-row.is-selected')).toHaveLength(0);
  });

  it('a filter change drops the selected rows it hides, so a bulk action touches only visible rows', async () => {
    await enterSelectMode();
    barBtn(t('transactions.selectAll')).click();
    expect(bar().parentElement.textContent).toContain(t('transactions.selected')(4));
    const typeSel = [...root().querySelectorAll('select')].find(s => [...s.options].some(o => o.value === 'income'));
    setValue(typeSel, 'income', ['change']);
    await flush();
    expect(rowIds()).toEqual(['i2']);
    expect(bar().parentElement.textContent).toContain(t('transactions.selected')(1));
    // Widening the filter again does not bring the dropped rows back.
    setValue(typeSel, 'all', ['change']);
    await flush();
    expect(root().querySelectorAll('.tx-row.is-selected')).toHaveLength(1);
    barBtn(t('transactions.deleteSelected')).click();
    await flush();
    dialogOk().click();
    await flush();
    expect(state.transactions.map(x => x.id)).toEqual(['x1', 'x2', 'b1']);
    expect(toastTexts()).toContain(t('transactions.deletedSelected')(1));
  });

  it('a type or status filter chip shows the option label, never an i18n key', async () => {
    // The chip once built its key from the value: debt_payment → typeDebt_payment.
    const sels = [...root().querySelectorAll('select')];
    const typeSel = sels.find(s => [...s.options].some(o => o.value === 'debt_payment'));
    const statusSel = sels.find(s => [...s.options].some(o => o.value === 'uncleared'));
    for (const [sel, other] of [[typeSel, statusSel], [statusSel, typeSel]]) {
      setValue(other, 'all', ['change']);
      for (const o of [...sel.options].filter(o => o.value !== 'all')) {
        setValue(sel, o.value, ['change']);
        await flush();
        const chips = [...root().querySelectorAll('.filter-chip')].map(c => c.firstChild.textContent);
        expect(chips).toEqual([o.textContent]);
        expect(o.textContent).not.toMatch(/^transactions\./);
      }
    }
    // The page keeps its filters across renders; leave none set.
    setValue(typeSel, 'all', ['change']);
    setValue(statusSel, 'all', ['change']);
    await flush();
  });
});

describe('row toggles', () => {
  it('the flag dispatches through the session: that row flagged and stamped, nothing else touched', async () => {
    rowEl('x1').querySelector('.tx-flag-btn').click();
    await flush();
    expect(writeBatch).toHaveBeenCalledTimes(1);
    expect(state.transactions).toHaveLength(4);
    const x1 = state.transactions.find(x => x.id === 'x1');
    expect(x1.flagged).toBe(true);
    expect(x1.modified_at).toBe(AT);
    expect(state.transactions.find(x => x.id === 'x2').flagged).toBeUndefined();
  });

  it('flagging a legacy unit-less sell works, and invents no creation time', async () => {
    const sell = { id: 'sell1', type: 'investment_transfer', date: '2026-09-01', payee: 'Broker', amount: 100, account: 'chk', status: 'posted' };
    resetState({ transactions: [...ledger, sell] });
    await openPage();
    rowEl('sell1').querySelector('.tx-flag-btn').click();
    await flush();
    expect(writeBatch).toHaveBeenCalledTimes(1);
    const row = state.transactions.find(x => x.id === 'sell1');
    expect(row).toEqual({ ...sell, flagged: true, modified_at: AT });
    expect(toastTexts()).toEqual([]);
  });

  it('flagging a forecast row dispatches nothing and toasts nothing', async () => {
    const fc = { id: 'fc1', type: 'expense', date: '2026-10-10', payee: 'Rent', amount: 500, account: 'chk', envelope_id: 'fun', status: 'scheduled', is_forecast: true };
    resetState({ transactions: [...ledger, fc] });
    await openPage();
    const btn = rowEl('fc1').querySelector('.tx-flag-btn');
    expect(btn).toBeTruthy();
    btn.click();
    await flush();
    expect(writeBatch).not.toHaveBeenCalled();
    expect(toastTexts()).toEqual([]);
  });

  it('flagging again takes the flag off', async () => {
    rowEl('x1').querySelector('.tx-flag-btn').click();
    await flush();
    rowEl('x1').querySelector('.tx-flag-btn').click();
    await flush();
    expect(state.transactions.find(x => x.id === 'x1').flagged).toBe(false);
  });

  it('the cleared tick sets cleared: true on just that row, and the change log records it', async () => {
    // A real budget's meta always carries its schema version, which the commit checks demand of a meta change.
    state.meta = { schemaVersion: 8 };
    rowEl('x2').querySelector('.tx-cleared-btn').click();
    await flush();
    expect(writeBatch).toHaveBeenCalledTimes(1);
    expect(state.transactions.find(x => x.id === 'x2').cleared).toBe(true);
    expect(state.transactions.find(x => x.id === 'x1').cleared).toBeUndefined();
    expect(state.meta.change_log).toHaveLength(1);
    expect(state.meta.change_log[0]).toMatchObject({ op: 'edit', id: 'x2', fields: ['cleared'] });
  });

  it('a refused cleared write leaves the row as it was and says why', async () => {
    writeBatch.mockRejectedValueOnce(new Error('offline'));
    rowEl('x2').querySelector('.tx-cleared-btn').click();
    await flush();
    expect(state.transactions.find(x => x.id === 'x2').cleared).toBeFalsy();
    expect(toastTexts().some(m => m.includes('offline'))).toBe(true);
  });

  it('a refused flag write leaves the row unflagged and says why', async () => {
    writeBatch.mockRejectedValueOnce(new Error('offline'));
    rowEl('x1').querySelector('.tx-flag-btn').click();
    await flush();
    expect(state.transactions.find(x => x.id === 'x1').flagged).toBeFalsy();
    expect(toastTexts().some(m => m.includes('offline'))).toBe(true);
  });
});

describe('bulk delete', () => {
  beforeEach(async () => { await enterSelectMode(); });

  it('asks first; cancelling writes nothing', async () => {
    select('x1', 'x2');
    barBtn(t('transactions.deleteSelected')).click();
    await flush();
    dialogButton(t('common.cancel')).click();
    await flush();
    expect(writeBatch).not.toHaveBeenCalled();
    expect(state.transactions).toHaveLength(4);
  });

  it('rows in a closed month ask "Edit anyway" first, then the delete confirmation', async () => {
    state.meta = { ...(state.meta || {}), closed_months: ['2026-09'] };
    select('x1', 'x2');
    barBtn(t('transactions.deleteSelected')).click();
    await flush();
    expect(topOverlay().textContent).toContain(t('closedPeriod.confirm')(2, '').split('(')[0]);
    dialogButton(t('common.cancel')).click();
    await flush();
    expect(writeBatch).not.toHaveBeenCalled();

    barBtn(t('transactions.deleteSelected')).click();
    await flush();
    dialogOk().click();
    await flush();
    dialogOk().click();
    await flush();
    expect(state.transactions.map(x => x.id)).toEqual(['i2', 'b1']);
  });

  it('confirming dispatches one delete without the selected rows, and writes no tombstone', async () => {
    select('x1', 'x2');
    barBtn(t('transactions.deleteSelected')).click();
    await flush();
    dialogOk().click();
    await flush();
    expect(writeBatch).toHaveBeenCalledTimes(1);
    expect(state.transactions.map(x => x.id)).toEqual(['i2', 'b1']);
    // No scheduled-origin row: no tombstone.
    expect(state.meta.scheduledTombstones).toBeUndefined();
    expect(toastTexts()).toContain(t('transactions.deletedSelected')(2));
  });

  it('Undo puts the deleted rows back', async () => {
    const before = state.transactions;
    select('x1');
    barBtn(t('transactions.deleteSelected')).click();
    await flush();
    dialogOk().click();
    await flush();
    toastButton().click();
    await flush();
    expect(writeBatch).toHaveBeenCalledTimes(2);
    expect(state.transactions.map(x => x.id).sort()).toEqual(before.map(x => x.id).sort());
    expect(state.transactions.find(x => x.id === 'x1')).toEqual(before.find(x => x.id === 'x1'));
    expect(toastTexts()).toContain(t('common.restored'));
  });

  it('Undo after a budget switch writes nothing', async () => {
    select('x1');
    barBtn(t('transactions.deleteSelected')).click();
    await flush();
    dialogOk().click();
    await flush();
    state.budgetFolder = { name: 'budget-B' };
    state.transactions = [];
    toastButton().click();
    await flush();
    expect(writeBatch).toHaveBeenCalledTimes(1);
    expect(state.transactions).toEqual([]);
    expect(toastTexts().some(m => m.includes(t('coreError.undoBudgetChanged')))).toBe(true);
  });

  it('a refused delete is toasted and the rows stay', async () => {
    writeBatch.mockRejectedValueOnce(new Error('disk full'));
    select('x1');
    barBtn(t('transactions.deleteSelected')).click();
    await flush();
    dialogOk().click();
    await flush();
    expect(state.transactions).toHaveLength(4);
    expect(toastTexts().some(m => m.includes('disk full'))).toBe(true);
    expect(toastTexts()).not.toContain(t('transactions.deletedSelected')(1));
  });

  it('deleting a materialised scheduled row tombstones its key, so it is not re-created', async () => {
    // A real budget's meta always carries its schema version, which the commit checks demand of a meta change.
    state.meta = { schemaVersion: 8 };
    select('b1');
    barBtn(t('transactions.deleteSelected')).click();
    await flush();
    dialogOk().click();
    await flush();
    expect(state.transactions.map(x => x.id)).toEqual(['x1', 'x2', 'i2']);
    expect(state.meta.scheduledTombstones).toEqual(['bp:netflix:2026-09']);

    // Undo lifts the tombstone again.
    toastButton().click();
    await flush();
    expect(state.meta.scheduledTombstones ?? []).not.toContain('bp:netflix:2026-09');
    expect(state.transactions.map(x => x.id).sort()).toEqual(['b1', 'i2', 'x1', 'x2']);
  });
});

describe('bulk flag', () => {
  beforeEach(async () => { await enterSelectMode(); });

  it('flags every selected row when any is unflagged, and only those rows', async () => {
    state.transactions = state.transactions.map(x => (x.id === 'x1' ? { ...x, flagged: true } : x));
    select('x1', 'x2');
    barBtn(t('transactions.bulkFlagAll')).click();
    await flush();
    expect(writeBatch).toHaveBeenCalledTimes(1);
    expect(byId('x1').flagged).toBe(true);
    expect(byId('x2').flagged).toBe(true);
    expect(byId('i2').flagged).toBeUndefined();
    // Stamped by the session's clock, and only the row whose value changed.
    expect(byId('x2').modified_at).toBe(AT);
    expect(byId('x1').modified_at).toBeUndefined();
    expect(toastTexts()).toContain(t('transactions.bulkFlagged')(2));
  });

  it('clears the flag when every selected row is already flagged', async () => {
    state.transactions = state.transactions.map(x => (x.id === 'x1' || x.id === 'x2' ? { ...x, flagged: true } : x));
    await openPage();
    await enterSelectMode();
    select('x1', 'x2');
    barBtn(t('transactions.bulkUnflagAll')).click();
    await flush();
    expect(byId('x1').flagged).toBe(false);
    expect(byId('x2').flagged).toBe(false);
    expect(toastTexts()).toContain(t('transactions.bulkUnflagged')(2));
  });

  it('Undo restores the previous flags', async () => {
    const before = state.transactions;
    select('x1', 'x2');
    barBtn(t('transactions.bulkFlagAll')).click();
    await flush();
    toastButton().click();
    await flush();
    expect(writeBatch).toHaveBeenCalledTimes(2);
    expect(state.transactions).toEqual(before);
    expect(toastTexts()).toContain(t('common.restored'));
  });

  it('a refused write leaves the rows alone, shows the failure and keeps the selection', async () => {
    writeBatch.mockRejectedValueOnce(new Error('disk full'));
    select('x1', 'x2');
    barBtn(t('transactions.bulkFlagAll')).click();
    await flush();
    expect(state.transactions).toHaveLength(4);
    expect(byId('x1').flagged).toBeUndefined();
    // The bulk flag keeps its own failure wording, announced assertively.
    expect(alertTexts().some(m => m.includes(t('editTx.saveFailed')))).toBe(true);
    expect(toastTexts()).not.toContain(t('transactions.bulkFlagged')(2));
    expect(root().querySelectorAll('.tx-row.is-selected')).toHaveLength(2);
  });
});

describe('bulk set date', () => {
  beforeEach(async () => { await enterSelectMode(); });

  const pickDate = async (value) => {
    barBtn(t('transactions.bulkSetDate')).click();
    setValue(sheetInput(), value);
    sheetButton(t('transactions.bulkSetDateApply')).click();
    await flush();
  };

  it('shows a picker, confirms, then rewrites just the selected dates', async () => {
    select('x1', 'i2');
    await pickDate('2026-09-12');
    // The picker is gone; the confirmation names the count and date.
    expect(topOverlay().textContent).toContain(t('transactions.bulkDateConfirm')(2, '2026-09-12'));
    dialogOk().click();
    await flush();
    expect(writeBatch).toHaveBeenCalledTimes(1);
    expect(byId('x1').date).toBe('2026-09-12');
    expect(byId('i2').date).toBe('2026-09-12');
    expect(byId('x1').modified_at).toBe(AT);
    expect(byId('x2').date).toBe('2026-09-10');
    expect(byId('x2').modified_at).toBeUndefined();
    expect(state.transactions).toHaveLength(4);
    expect(toastTexts()).toContain(t('transactions.bulkDateDone')(2));
  });

  it('Undo puts the old dates back', async () => {
    const before = state.transactions;
    select('x1', 'i2');
    await pickDate('2026-09-12');
    dialogOk().click();
    await flush();
    toastButton().click();
    await flush();
    expect(writeBatch).toHaveBeenCalledTimes(2);
    expect(state.transactions).toEqual(before);
    expect(toastTexts()).toContain(t('common.restored'));
  });

  it('a date the rows already have commits nothing, so the toast carries no Undo', async () => {
    select('x1');
    await pickDate('2026-09-10');
    dialogOk().click();
    await flush();
    expect(writeBatch).not.toHaveBeenCalled();
    expect(toastTexts()).toContain(t('transactions.bulkDateDone')(1));
    expect(toastButton()).toBeNull();
  });

  it('a refused write leaves the dates alone and keeps the selection', async () => {
    writeBatch.mockRejectedValueOnce(new Error('disk full'));
    select('x1');
    await pickDate('2026-09-12');
    dialogOk().click();
    await flush();
    expect(byId('x1').date).toBe('2026-09-10');
    expect(toastTexts().some(m => m.includes('disk full'))).toBe(true);
    expect(toastTexts()).not.toContain(t('transactions.bulkDateDone')(1));
    expect(root().querySelectorAll('.tx-row.is-selected')).toHaveLength(1);
  });

  it('declining the confirmation writes nothing', async () => {
    select('x1');
    await pickDate('2026-09-12');
    dialogButton(t('common.cancel')).click();
    await flush();
    expect(writeBatch).not.toHaveBeenCalled();
  });

  it('applying without a date does nothing', async () => {
    select('x1');
    barBtn(t('transactions.bulkSetDate')).click();
    sheetButton(t('transactions.bulkSetDateApply')).click();
    await flush();
    expect(writeBatch).not.toHaveBeenCalled();
  });
});

describe('bulk change payee', () => {
  beforeEach(async () => { await enterSelectMode(); });

  const applyPayee = async (value) => {
    barBtn(t('transactions.bulkChangePayee')).click();
    setValue(sheetInput(), value);
    sheetButton(t('transactions.bulkChangePayeeApply')).click();
    await flush();
  };

  it('renames the payee of just the selected rows, trimmed', async () => {
    select('x1', 'x2');
    await applyPayee('  Corner shop ');
    expect(writeBatch).toHaveBeenCalledTimes(1);
    expect(byId('x1').payee).toBe('Corner shop');
    expect(byId('x2').payee).toBe('Corner shop');
    expect(byId('x1').modified_at).toBe(AT);
    expect(byId('i2').payee).toBe('Refund');
    expect(byId('i2').modified_at).toBeUndefined();
    expect(toastTexts()).toContain(t('transactions.bulkChangePayeeToast')(2));
  });

  it('Undo restores the old payees', async () => {
    const before = state.transactions;
    select('x1', 'x2');
    await applyPayee('Corner shop');
    toastButton().click();
    await flush();
    expect(writeBatch).toHaveBeenCalledTimes(2);
    expect(state.transactions).toEqual(before);
    expect(toastTexts()).toContain(t('common.restored'));
  });

  it('a refused write leaves the payees alone and keeps the selection', async () => {
    writeBatch.mockRejectedValueOnce(new Error('disk full'));
    select('x1');
    await applyPayee('Corner shop');
    expect(byId('x1').payee).toBe('Grocer');
    expect(alertTexts().some(m => m.includes(t('editTx.saveFailed')))).toBe(true);
    expect(toastTexts()).not.toContain(t('transactions.bulkChangePayeeToast')(1));
    expect(root().querySelectorAll('.tx-row.is-selected')).toHaveLength(1);
  });

  it('a refused write leaves the sheet open with the typed name, so it can be retried', async () => {
    writeBatch.mockRejectedValueOnce(new Error('disk full'));
    select('x1');
    await applyPayee('Corner shop');
    expect(sheetInput().value).toBe('Corner shop');
    sheetButton(t('transactions.bulkChangePayeeApply')).click();
    await flush();
    expect(byId('x1').payee).toBe('Corner shop');
    expect(toastTexts()).toContain(t('transactions.bulkChangePayeeToast')(1));
  });

  it('a name the rows already have commits nothing, so the toast carries no Undo', async () => {
    select('x1');
    await applyPayee('Grocer');
    expect(writeBatch).not.toHaveBeenCalled();
    expect(toastTexts()).toContain(t('transactions.bulkChangePayeeToast')(1));
    expect(toastButton()).toBeNull();
  });

  it('an empty name writes nothing', async () => {
    select('x1');
    barBtn(t('transactions.bulkChangePayee')).click();
    sheetButton(t('transactions.bulkChangePayeeApply')).click();
    await flush();
    expect(writeBatch).not.toHaveBeenCalled();
  });
});

describe('bulk assign envelope', () => {
  const assign = async (value) => {
    const sel = bar().querySelector('select');
    sel.value = value;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    await flush();
  };
  beforeEach(async () => { await enterSelectMode(); });

  it('confirms, then sets the envelope on the selected expenses only', async () => {
    select('x1', 'i2');
    await assign('rent');
    dialogOk().click();
    await flush();
    expect(writeBatch).toHaveBeenCalledTimes(1);
    expect(byId('x1').envelope_id).toBe('rent');
    expect(byId('x1').modified_at).toBe(AT);
    // An income row in the selection is left alone.
    expect(byId('i2').envelope_id).toBeNull();
    expect(byId('i2').modified_at).toBeUndefined();
    expect(byId('x2').envelope_id).toBe('fun');
    expect(toastTexts()).toContain(t('transactions.assignedToast')(1, 'Rent'));
  });

  it('"No envelope" stores the explicit __none__ marker', async () => {
    select('x2');
    await assign('__none__');
    dialogOk().click();
    await flush();
    expect(byId('x2').envelope_id).toBe('__none__');
  });

  it('drops the budget-item link and the splits, which would otherwise still govern the row', async () => {
    state.transactions = state.transactions.map(x => (x.id === 'x1'
      ? { ...x, budget_item_id: 'item-1', envelope_splits: [{ envelope_id: 'food', amount: 30 }, { envelope_id: 'fun', amount: 20 }] }
      : x));
    await openPage();
    await enterSelectMode();
    select('x1');
    await assign('rent');
    dialogOk().click();
    await flush();
    const row = byId('x1');
    expect(row.envelope_id).toBe('rent');
    expect(row).not.toHaveProperty('budget_item_id');
    expect(row).not.toHaveProperty('envelope_splits');
  });

  it('Undo restores the old envelopes, link and splits', async () => {
    state.transactions = state.transactions.map(x => (x.id === 'x1' ? { ...x, budget_item_id: 'item-1' } : x));
    await openPage();
    await enterSelectMode();
    const before = state.transactions;
    select('x1');
    await assign('rent');
    dialogOk().click();
    await flush();
    toastButton().click();
    await flush();
    expect(writeBatch).toHaveBeenCalledTimes(2);
    expect(state.transactions).toEqual(before);
    expect(toastTexts()).toContain(t('common.restored'));
  });

  it('a refused write leaves the envelopes alone and keeps the selection', async () => {
    writeBatch.mockRejectedValueOnce(new Error('disk full'));
    select('x1');
    await assign('rent');
    dialogOk().click();
    await flush();
    expect(byId('x1').envelope_id).toBe('food');
    expect(toastTexts().some(m => m.includes('disk full'))).toBe(true);
    expect(toastTexts()).not.toContain(t('transactions.assignedToast')(1, 'Rent'));
    expect(root().querySelectorAll('.tx-row.is-selected')).toHaveLength(1);
  });

  it('cancelling the confirmation writes nothing', async () => {
    select('x1');
    await assign('rent');
    dialogButton(t('common.cancel')).click();
    await flush();
    expect(writeBatch).not.toHaveBeenCalled();
  });

  it('with no expense selected the control is disabled and nothing is written', async () => {
    select('i2');
    expect(bar().querySelector('select').disabled).toBe(true);
    expect(writeBatch).not.toHaveBeenCalled();
  });
});

describe('merge into a transfer', () => {
  beforeEach(async () => { await enterSelectMode(); });

  it('is only enabled for an income and an expense of equal size on different accounts', () => {
    const merge = () => barBtn(t('transactions.mergeTransfer'));
    select('x1');
    expect(merge().disabled).toBe(true);
    select('x2'); // two expenses
    expect(merge().disabled).toBe(true);
    select('x2', 'i2'); // deselect x2, add the 50 refund on savings
    expect(merge().disabled).toBe(false);
  });

  it('a mismatched amount stays disabled', () => {
    select('x2', 'i2'); // 20 vs 50
    expect(barBtn(t('transactions.mergeTransfer')).disabled).toBe(true);
  });

  it('replaces the pair with one account_transfer, appended last, after confirming', async () => {
    select('x1', 'i2');
    barBtn(t('transactions.mergeTransfer')).click();
    await flush();
    dialogOk().click();
    await flush();
    expect(writeBatch).toHaveBeenCalledTimes(1);
    expect(state.transactions).toHaveLength(3);
    expect(state.transactions.map(x => x.id)).not.toContain('x1');
    expect(state.transactions.map(x => x.id)).not.toContain('i2');
    const transfer = state.transactions.at(-1);
    expect(transfer).toMatchObject({
      type: 'account_transfer', from_account: 'chk', to_account: 'sav', amount: 50,
      date: '2026-09-09', payee: 'Refund', created_at: AT, modified_at: AT,
    });
    expect(transfer.id).toBeTruthy();
    expect(toastTexts()).toContain(t('transactions.merged'));
  });

  it('merging away a plan-linked leg tombstones its key, so it is not re-created', async () => {
    // A real budget's meta always carries its schema version, which the commit checks demand of a meta change.
    state.meta = { schemaVersion: 8 };
    state.transactions = state.transactions.map(x => (x.id === 'x1' ? { ...x, from_budget: 'bp:grocer:2026-09' } : x));
    await openPage();
    await enterSelectMode();
    select('x1', 'i2');
    barBtn(t('transactions.mergeTransfer')).click();
    await flush();
    dialogOk().click();
    await flush();
    expect(state.meta.scheduledTombstones).toEqual(['bp:grocer:2026-09']);
  });

  it('with no payee on either leg the transfer takes the translated fallback', async () => {
    state.transactions = state.transactions.map(x => (x.id === 'x1' || x.id === 'i2' ? { ...x, payee: '' } : x));
    await openPage();
    await enterSelectMode();
    select('x1', 'i2');
    barBtn(t('transactions.mergeTransfer')).click();
    await flush();
    dialogOk().click();
    await flush();
    expect(state.transactions.at(-1).payee).toBe(t('transactions.accountTransferPayee'));
  });

  it('Undo brings the two legs back and removes the transfer', async () => {
    const before = state.transactions;
    select('x1', 'i2');
    barBtn(t('transactions.mergeTransfer')).click();
    await flush();
    dialogOk().click();
    await flush();
    toastButton().click();
    await flush();
    expect(writeBatch).toHaveBeenCalledTimes(2);
    expect(state.transactions).toEqual(before);
    expect(toastTexts()).toContain(t('common.restored'));
  });

  it('Undo also takes back the tombstone of a plan-linked leg', async () => {
    state.meta = { schemaVersion: 8 };
    state.transactions = state.transactions.map(x => (x.id === 'x1' ? { ...x, from_budget: 'bp:grocer:2026-09' } : x));
    await openPage();
    await enterSelectMode();
    const before = state.transactions;
    select('x1', 'i2');
    barBtn(t('transactions.mergeTransfer')).click();
    await flush();
    dialogOk().click();
    await flush();
    expect(state.meta.scheduledTombstones).toEqual(['bp:grocer:2026-09']);
    toastButton().click();
    await flush();
    expect(state.meta.scheduledTombstones ?? []).not.toContain('bp:grocer:2026-09');
    expect(state.transactions).toEqual(before);
    expect(toastTexts()).toContain(t('common.restored'));
  });

  it('a refused write leaves the pair alone and keeps the selection', async () => {
    writeBatch.mockRejectedValueOnce(new Error('disk full'));
    select('x1', 'i2');
    barBtn(t('transactions.mergeTransfer')).click();
    await flush();
    dialogOk().click();
    await flush();
    expect(state.transactions).toHaveLength(4);
    expect(alertTexts().some(m => m.includes(t('editTx.saveFailed')))).toBe(true);
    expect(toastTexts()).not.toContain(t('transactions.merged'));
    expect(root().querySelectorAll('.tx-row.is-selected')).toHaveLength(2);
  });

  it('cancelling the confirmation writes nothing', async () => {
    select('x1', 'i2');
    barBtn(t('transactions.mergeTransfer')).click();
    await flush();
    dialogButton(t('common.cancel')).click();
    await flush();
    expect(writeBatch).not.toHaveBeenCalled();
  });
});

describe('opening scroll position', () => {
  const scroller = () => [...root().querySelectorAll('div')].find(d => d.style.overflowY === 'auto');
  const openAccount = async () => {
    state.pendingFilter = 'account:chk';
    await openPage();
    await flush();
  };

  beforeEach(async () => {
    // A future scheduled row sits above today, so opening at today scrolls.
    ledger.unshift({ id: 'f1', type: 'expense', date: '2027-07-17', payee: 'Later', amount: 5, envelope_id: 'fun', account: 'chk', status: 'scheduled' });
    resetState({ transactions: ledger });
  });

  it("an account's transactions open at today, past the future rows", async () => {
    await openAccount();
    expect(scroller().scrollTop).toBeGreaterThan(0);
  });

  it('a cancelled edit does not leave its scroll position for the next visit', async () => {
    await openAccount();
    const atToday = scroller().scrollTop;
    scroller().scrollTop = 0; // scrolled up to the future rows
    rowEl('f1').querySelector('.tx-row-open').click();
    await vi.waitFor(() => expect(topOverlay()).toBeTruthy());
    sheetButton(t('addTx.cancel')).click();
    await flush();
    await openAccount();
    expect(scroller().scrollTop).toBe(atToday);
  });
});

it('select all includes matches beyond the default CLI page', async () => {
  state.transactions = Array.from({ length: 75 }, (_, i) => ({ ...ledger[0], id: `many-${i}` }));
  state.pendingFilter = { search: '' };
  await render(root());
  await enterSelectMode();
  barBtn(t('transactions.selectAll')).click();
  expect(root().textContent).toContain(t('transactions.selected')(75));
});

// ── UX 2026-10-05 ───────────────────────────────────────────────────────────

describe('bulk cleared (UX 2026-10-05)', () => {
  beforeEach(async () => { await enterSelectMode(); });

  it('marks every selected uncleared row cleared, with Undo', async () => {
    state.transactions = state.transactions.map(x => (x.id === 'x1' ? { ...x, cleared: true } : x));
    await openPage();
    await enterSelectMode();
    select('x1', 'x2');
    barBtn(t('transactions.bulkMarkCleared')).click();
    await flush();
    expect(writeBatch).toHaveBeenCalledTimes(1);
    expect(byId('x1').cleared).toBe(true);
    expect(byId('x2').cleared).toBe(true);
    expect(byId('i2').cleared).toBeUndefined();
    // Only the row that changed is counted.
    expect(toastTexts()).toContain(t('transactions.bulkCleared')(1));
    toastButton().click();
    await flush();
    expect(byId('x2').cleared).toBeUndefined();
  });

  it('marks them uncleared when every selected row already is cleared', async () => {
    state.transactions = state.transactions.map(x => (x.id === 'x1' || x.id === 'x2' ? { ...x, cleared: true } : x));
    await openPage();
    await enterSelectMode();
    select('x1', 'x2');
    barBtn(t('transactions.bulkMarkUncleared')).click();
    await flush();
    expect(byId('x1').cleared).toBe(false);
    expect(byId('x2').cleared).toBe(false);
    expect(toastTexts()).toContain(t('transactions.bulkUncleared')(2));
  });

  it('un-clearing a reconciled row asks first, and Cancel writes nothing', async () => {
    state.accounts = state.accounts.map(a => (a.id === 'chk' ? { ...a, lastReconciledAt: '2026-09-12T10:00:00Z' } : a));
    state.transactions = state.transactions.map(x => (x.id === 'x1' ? { ...x, cleared: true } : x));
    await openPage();
    await enterSelectMode();
    select('x1');
    barBtn(t('transactions.bulkMarkUncleared')).click();
    await flush();
    expect(topOverlay().textContent).toContain(t('reconciledRow.title'));
    dialogButton(t('common.cancel')).click();
    await flush();
    expect(writeBatch).not.toHaveBeenCalled();
    expect(byId('x1').cleared).toBe(true);
  });

  it('is disabled for a selection with no account side (a fill)', async () => {
    state.transactions = [...state.transactions,
      { id: 'f1', type: 'fill', date: '2026-09-07', amount: 30, lines: [{ envelope_id: 'food', mode: 'add', amount: 30 }], status: 'posted' }];
    await openPage();
    await enterSelectMode();
    select('f1');
    expect(barBtn(t('transactions.bulkMarkCleared')).disabled).toBe(true);
  });
});

describe('bulk delete wording (UX 2026-10-05)', () => {
  it('the confirm offers Undo instead of saying "permanently"', async () => {
    await enterSelectMode();
    select('x1');
    barBtn(t('transactions.deleteSelected')).click();
    await flush();
    expect(topOverlay().textContent).toContain(t('transactions.deleteSelectedConfirm')(1));
    expect(t('transactions.deleteSelectedConfirm')(1)).not.toMatch(/permanent/i);
  });
});

describe('scroll on a new search (UX 2026-10-05)', () => {
  it('a new search starts at the top; a repaint with the same filters keeps the place', async () => {
    const scroller = root().querySelector('.tx-row').closest('[style*="overflow-y"]');
    // jsdom has no layout, so the offset is a plain value here.
    let top = 0;
    Object.defineProperty(scroller, 'scrollTop', { configurable: true, get: () => top, set: (v) => { top = v; } });
    const search = root().querySelector('.search-count').previousElementSibling;
    // A toggle repaints with the same filters: the place is kept.
    top = 500;
    await enterSelectMode();
    await flush();
    expect(top).toBe(500);
    // A new search is a new question.
    setValue(search, 'Grocer', ['input']);
    await new Promise(r => setTimeout(r, 200));
    await flush();
    expect(rowIds()).toEqual(['x1']);
    expect(top).toBe(0);
  });
});
