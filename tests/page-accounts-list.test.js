// @vitest-environment jsdom
// Accounts list: the writes its row actions make. Array order IS display
// order, so a reorder (drag, drop, Alt+Arrow, whole-type move) dispatches
// account.reorder with the spliced order; the favourite star dispatches
// account.update, and the view / collapse toggles are the other things this
// page persists. Drives the real js/pages/accounts.js through the real browser
// session; the storage boundary (writeBatch) is the fake that records writes.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../js/app.js', async () => (await import('./_fakes/pageApp.js')).appStub);
import { render } from '../js/pages/accounts.js';
import { t } from '../js/ui/i18n.js';
import {
  state, navigate, updateStatusBar, writeBatch, savePrefs, prefs, resetState, mountHosts, flush, setValue, sheetIsOpen, toastTexts,
} from './_fakes/pageApp.js';

const root = () => document.getElementById('app-root');
const cards = () => [...root().querySelectorAll('[data-acc-id]')];
const card = (id) => root().querySelector(`[data-acc-id="${id}"]`);
const order = () => cards().map(c => c.dataset.accId);
const savedAccounts = () => writeBatch.mock.calls.at(-1)?.[1].find(i => i.filename === 'accounts.json')?.data;
const savedIds = () => savedAccounts()?.map(a => a.id);
const accountWrites = () => writeBatch.mock.calls.filter(c => c[1].some(i => i.filename === 'accounts.json'));
const groupHead = (type) => root().querySelector(`[data-group-type="${type}"] > div`);
const groupToggle = (type) => root().querySelector(`[data-group-type="${type}"] .group-toggle`);

function dragEvent(el, type) {
  const ev = new Event(type, { bubbles: true, cancelable: true });
  ev.dataTransfer = { effectAllowed: '', dropEffect: '' };
  el.dispatchEvent(ev);
  return ev;
}
const drag = (from, onto) => { dragEvent(from, 'dragstart'); dragEvent(onto, 'dragover'); dragEvent(onto, 'drop'); dragEvent(from, 'dragend'); };
const altKey = (el, key) => el.dispatchEvent(new KeyboardEvent('keydown', { key, altKey: true, bubbles: true, cancelable: true }));

async function openPage() {
  mountHosts();
  await render(root());
}

beforeEach(async () => {
  vi.stubGlobal('requestAnimationFrame', (cb) => setTimeout(cb, 0));
  // jsdom has no CSS.escape; the keyboard moves use it to re-focus the card.
  vi.stubGlobal('CSS', { escape: (s) => String(s) });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  resetState({
    transactions: [
      { id: 'x1', type: 'expense', date: '2026-09-02', payee: 'Grocer', amount: 50, envelope_id: 'food', account: 'chk', status: 'posted' },
    ],
  });
  state.accounts = [
    { id: 'chk', name: 'Checking', type: 'bank', initialBalance: 1000 },
    { id: 'sav', name: 'Savings', type: 'savings', initialBalance: 500 },
    { id: 'joint', name: 'Joint', type: 'bank', initialBalance: 10 },
    { id: 'card', name: 'Visa', type: 'credit_card', initialBalance: 0 },
  ];
  await openPage();
});

describe('accounts list', () => {
  it('shows one card per active account, grouped by type in first-appearance order', () => {
    expect(order()).toEqual(['chk', 'joint', 'sav', 'card']);
  });

  it('archived accounts are hidden unless the setting shows them', async () => {
    state.accounts = state.accounts.map(a => (a.id === 'joint' ? { ...a, archived: true } : a));
    await openPage();
    expect(order()).toEqual(['chk', 'sav', 'card']);
    state.meta = { show_archived_accounts: true };
    await openPage();
    expect(order()).toEqual(['chk', 'joint', 'sav', 'card']);
  });

  it('the search box filters the cards without writing anything', async () => {
    setValue(root().querySelector('.search input'), 'vis');
    expect(order()).toEqual(['card']);
    expect(accountWrites()).toHaveLength(0);
  });

  it('the type filter narrows to one type', () => {
    setValue(root().querySelector('.filters select'), 'savings', ['change']);
    expect(order()).toEqual(['sav']);
  });

  it('the New button opens the editor for a new account', () => {
    root().querySelector('.page-head .btn-accent').click();
    expect(sheetIsOpen()).toBe(true);
  });

  it('a card opens its account\'s transactions', () => {
    card('chk').click();
    expect(navigate).toHaveBeenCalledWith('transactions', 'account:chk');
  });

  it('a card\'s edit button opens the editor and does not navigate', () => {
    card('sav').querySelector('button[aria-label="' + t('accounts.editTitle') + '"]').click();
    expect(sheetIsOpen()).toBe(true);
    expect(navigate).not.toHaveBeenCalled();
  });
});

describe('reorder', () => {
  it('dropping a card on another of its type dispatches the spliced order', async () => {
    drag(card('joint'), card('chk'));
    await flush();
    expect(savedIds()).toEqual(['joint', 'chk', 'sav', 'card']);
    expect(state.accounts.map(a => a.id)).toEqual(['joint', 'chk', 'sav', 'card']);
    expect(order()).toEqual(['joint', 'chk', 'sav', 'card']);
    expect(accountWrites()).toHaveLength(1);
    expect(writeBatch.mock.calls[0][0]).toBe(state.budgetFolder);
    expect(updateStatusBar).toHaveBeenCalled();
  });

  it('repaints at once, before the dispatch settles', async () => {
    let release;
    writeBatch.mockImplementationOnce(() => new Promise(r => { release = r; }));
    drag(card('joint'), card('chk'));
    await flush();
    expect(order()).toEqual(['joint', 'chk', 'sav', 'card']);
    expect(state.accounts.map(a => a.id)).toEqual(['chk', 'sav', 'joint', 'card']);
    release();
    await flush();
    expect(state.accounts.map(a => a.id)).toEqual(['joint', 'chk', 'sav', 'card']);
  });

  it('a second move while one is pending is computed from the page-local order and lands after it', async () => {
    let release;
    writeBatch.mockImplementationOnce(() => new Promise(r => { release = r; }));
    drag(card('joint'), card('chk'));                    // joint, chk, sav, card
    altKey(groupToggle('credit_card'), 'ArrowUp');       // card group above the savings group
    await flush();
    expect(order()).toEqual(['joint', 'chk', 'card', 'sav']);
    expect(accountWrites()).toHaveLength(1);             // only the first has reached storage; the second waits
    release();
    await flush();
    expect(accountWrites()).toHaveLength(2);
    expect(savedIds()).toEqual(['joint', 'chk', 'card', 'sav']);
    expect(state.accounts.map(a => a.id)).toEqual(['joint', 'chk', 'card', 'sav']);
  });

  it('dropping onto a card of another type is ignored', async () => {
    drag(card('chk'), card('sav'));
    await flush();
    expect(accountWrites()).toHaveLength(0);
  });

  it('dropping a card on itself is ignored', async () => {
    drag(card('chk'), card('chk'));
    await flush();
    expect(accountWrites()).toHaveLength(0);
  });

  it('Alt+ArrowDown moves the focused card past its neighbour', async () => {
    altKey(card('chk'), 'ArrowDown');
    await flush();
    // The displayed neighbour is joint (index 2 in the array), so chk lands there.
    expect(savedIds()).toEqual(['sav', 'joint', 'chk', 'card']);
  });

  it('Alt+ArrowUp on the first card of a group writes nothing', async () => {
    altKey(card('chk'), 'ArrowUp');
    await flush();
    expect(accountWrites()).toHaveLength(0);
  });

  it('dragging a type header before another moves the whole group, keeping inner order', async () => {
    dragEvent(groupHead('credit_card'), 'dragstart');
    dragEvent(groupHead('bank'), 'dragover');
    dragEvent(groupHead('bank'), 'drop');
    dragEvent(groupHead('credit_card'), 'dragend');
    await flush();
    expect(savedIds()).toEqual(['card', 'chk', 'sav', 'joint']);
  });

  it('Alt+ArrowDown on a type toggle moves the group below the next one', async () => {
    altKey(groupToggle('bank'), 'ArrowDown');
    await flush();
    expect(savedIds()).toEqual(['sav', 'chk', 'joint', 'card']);
  });

  it('a failed reorder is reported, leaves state.accounts alone and repaints the old order', async () => {
    const before = state.accounts;
    writeBatch.mockImplementationOnce(async () => { throw new Error('offline'); });
    altKey(card('chk'), 'ArrowDown');
    await flush();
    expect(toastTexts().some(x => x.includes('offline'))).toBe(true);
    expect(state.accounts).toBe(before);
    expect(order()).toEqual(['chk', 'joint', 'sav', 'card']);
  });

  it('a failed reorder with a favourite pending behind it: the page ends showing state, not the rejected order', async () => {
    let fail;
    writeBatch.mockImplementationOnce(() => new Promise((_, rej) => { fail = rej; }));
    altKey(card('chk'), 'ArrowDown');                    // reorder A, held in storage
    await flush();
    card('sav').querySelector('.env-fav').click();       // favourite B, queued behind A
    await flush();
    fail(new Error('offline'));
    await flush();
    expect(toastTexts().some(x => x.includes('offline'))).toBe(true);
    expect(state.accounts.map(a => a.id)).toEqual(['chk', 'sav', 'joint', 'card']);
    expect(state.accounts.find(a => a.id === 'sav').favorite).toBe(true);
    expect(order()).toEqual(['chk', 'joint', 'sav', 'card']);
    expect(card('sav').querySelector('.env-fav').classList.contains('is-on')).toBe(true);
  });

  it('after a budget switch a failed dispatch does not repaint over the other budget', async () => {
    let fail;
    writeBatch.mockImplementationOnce(() => new Promise((_, rej) => { fail = rej; }));
    altKey(card('chk'), 'ArrowDown');
    await flush();
    const painted = root().innerHTML;
    state.budgetFolder = { name: 'budget-B' };
    state.accounts = [{ id: 'b-only', name: 'B account', type: 'bank', initialBalance: 0 }];
    fail(new Error('offline'));
    await flush();
    expect(root().innerHTML).toBe(painted);
  });

  it('the old and the new array logic agree: order handed to account.reorder is a full permutation, archived included', async () => {
    state.accounts = state.accounts.map(a => (a.id === 'sav' ? { ...a, archived: true } : a));
    await openPage();
    drag(card('joint'), card('chk'));
    await flush();
    expect(savedIds()).toEqual(['joint', 'chk', 'sav', 'card']);
    expect(savedAccounts().find(a => a.id === 'sav').archived).toBe(true);
  });
});

describe('favourite, view and collapse', () => {
  it('the star writes favorite: true on just that account, and again to clear it', async () => {
    card('sav').querySelector('.env-fav').click();
    await flush();
    const first = savedAccounts();
    expect(first.filter(a => a.favorite).map(a => a.id)).toEqual(['sav']);
    expect(first.map(a => a.id)).toEqual(['chk', 'sav', 'joint', 'card']);

    card('sav').querySelector('.env-fav').click();
    await flush();
    expect(savedAccounts().find(a => a.id === 'sav').favorite).toBe(false);
  });

  it('the star changes only favorite: stored investment tiers, a stray group and legacy keys stay', async () => {
    const fund = { id: 'fund', name: 'Fund', type: 'investment', initialBalance: 0, interestTiers: [{ rate: 2 }], interestPayout: 'monthly', interestFirstMonth: '2024-01' };
    const stray = { id: 'stray', name: 'Stray', type: 'bank', initialBalance: 0, group: 'Property', spending: true };
    state.accounts = [...state.accounts, fund, stray];
    await openPage();
    card('fund').querySelector('.env-fav').click();
    await flush();
    expect(savedAccounts().find(a => a.id === 'fund')).toEqual({ ...fund, favorite: true });
    card('stray').querySelector('.env-fav').click();
    await flush();
    expect(savedAccounts().find(a => a.id === 'stray')).toEqual({ ...stray, favorite: true });
    expect(state.accounts.find(a => a.id === 'fund')).toEqual({ ...fund, favorite: true });
  });

  it('a failed favourite is reported and the star goes back', async () => {
    const before = state.accounts;
    writeBatch.mockImplementationOnce(async () => { throw new Error('offline'); });
    card('sav').querySelector('.env-fav').click();
    await flush();
    expect(toastTexts().some(x => x.includes('offline'))).toBe(true);
    expect(state.accounts).toBe(before);
    expect(state.accounts.find(a => a.id === 'sav').favorite).toBeUndefined();
    expect(card('sav').querySelector('.env-fav').classList.contains('is-on')).toBe(false);
  });

  it('the list toggle is a pref, not an account write', async () => {
    root().querySelectorAll('.view-toggle-btn')[1].click();
    await flush();
    expect(savePrefs).toHaveBeenCalledWith({ acctView: 'list' });
    expect(accountWrites()).toHaveLength(0);
    expect(root().querySelector('.env-list')).toBeTruthy();
  });

  it('the list view has an edit button that opens the editor', async () => {
    prefs.acctView = 'list';
    await openPage();
    root().querySelector('.account-list-row .env-list-actions button').click();
    expect(sheetIsOpen()).toBe(true);
    expect(navigate).not.toHaveBeenCalled();
  });

  it('collapsing a group stores it in prefs', () => {
    groupToggle('savings').click();
    expect(savePrefs).toHaveBeenCalledWith({ acctGroupsCollapsed: ['savings'] });
    expect(accountWrites()).toHaveLength(0);
  });
});

describe('the list layout\'s revalue button', () => {
  it('an asset opens the value dialog in its asset wording, as the card layout does', async () => {
    state.accounts = [...state.accounts, { id: 'house', name: 'House', type: 'asset', initialBalance: 200000 }];
    prefs.acctView = 'list';
    await openPage();
    const btn = card('house').querySelector(`button[aria-label="${t('assetValue.btnTooltip')}"]`);
    expect(btn).toBeTruthy();
    btn.click();
    await flush();
    const sheetEl = document.querySelector('#sheet-host .sheet');
    expect(document.getElementById('invval-new')).toBeTruthy();
    expect(sheetEl.textContent).toContain(t('assetValue.intro'));
    expect(document.getElementById('reconcile-statement')).toBeNull();
  });

  it('a bank account still opens the reconcile sheet', async () => {
    prefs.acctView = 'list';
    await openPage();
    card('chk').querySelector(`button[aria-label="${t('reconcile.btnTooltip')}"]`).click();
    await flush();
    expect(document.getElementById('invval-new')).toBeNull();
    expect(document.getElementById('reconcile-statement')).toBeTruthy();
  });
});
