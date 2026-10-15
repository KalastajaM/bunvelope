// @vitest-environment jsdom
// Payee-merge sheet: the write flows. A merge dispatches one payee.merge: the
// ticked payees' transactions, the investment rule, the aliases and the
// unhide of a hidden target are one commit (the session's writeBatch). Hide /
// Show again and Forget dispatch payee.hide / unhide / unalias; Ignore /
// Restore stay a plain meta write (saveMeta behind the meta queue). Drives
// the real js/payee-merge-sheet.js and the real browser session; writeBatch
// and saveMeta are mocked and asserted on.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../js/app.js', async () => (await import('./_fakes/pageApp.js')).appStub);
vi.mock('../js/data.js', async (importOriginal) => ({
  ...(await importOriginal()),
  saveMeta: vi.fn(async () => {}),
}));

import { saveMeta } from '../js/data.js';
import { openPayeeMergeSheet, countPayeeGroups } from '../js/payee-merge-sheet.js';
import { t } from '../js/ui/i18n.js';
import {
  state, session, writeBatch, resetState, mountHosts, flush, setValue,
  topOverlay, dialogOk, dialogButton, toastTexts,
} from './_fakes/pageApp.js';

const sheet = () => document.querySelector('#sheet-host .sheet');
const cardWith = (text) => [...sheet().querySelectorAll('.card')].find(c => c.textContent.includes(text));
const members = (card) => [...card.querySelectorAll('input[type="checkbox"]')];
const target = (card) => card.querySelector('input.form-input');
const mergeBtn = (card) => card.querySelector('.btn-accent');
const inCard = (card, label) => [...card.querySelectorAll('button')].find(b => b.textContent === label);
const sheetButton = (label) => [...sheet().querySelectorAll('button')].find(b => b.textContent === label);
const searchBox = () => sheet().querySelector('input.form-input:not([data-memory-key])');
const lastBatch = () => writeBatch.mock.calls.at(-1)?.[1];
const written = () => lastBatch()?.find(f => f.filename === 'transactions.json')?.data;
// A merge, hide and forget write meta inside the session's batch; Ignore goes
// through saveMeta.
const batchMeta = () => lastBatch()?.find(f => f.filename === 'budget-meta.json').data;
const savedMeta = () => saveMeta.mock.calls.at(-1)?.[1];
const click = async (el) => { el.click(); await flush(); };
const untick = async (cb) => { cb.checked = false; cb.dispatchEvent(new Event('change', { bubbles: true })); await flush(); };
const tick = async (cb) => { cb.checked = true; cb.dispatchEvent(new Event('change', { bubbles: true })); await flush(); };
const payeesOf = (txs) => txs.map(x => x.payee);

const tx = (id, payee, date, over) => ({
  id, type: 'expense', date, payee, amount: 10, envelope_id: 'food', account: 'chk', status: 'posted', ...over,
});

// A commit validates the whole meta, so the fixture carries a schemaVersion.
const META = { schemaVersion: 8, name: 'Household' };

let ledger;
let dispatch;

beforeEach(async () => {
  dispatch = vi.spyOn(session, 'dispatch');
  dispatch.mockClear();
  vi.stubGlobal('requestAnimationFrame', (cb) => setTimeout(cb, 0));
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  ledger = [
    // Exact group "lidl": three "Lidl" rows and two "LIDL 1234".
    tx('l1', 'Lidl', '2026-09-01'), tx('l2', 'Lidl', '2026-09-03'), tx('l3', 'Lidl', '2026-09-05'),
    tx('l4', 'LIDL 1234', '2026-09-02'), tx('l5', 'LIDL 1234', '2026-09-04'),
    // Exact group "k market".
    tx('k1', 'K-Market', '2026-09-06'), tx('k2', 'K-Market', '2026-09-07'), tx('k3', 'K Market', '2026-09-08'),
    // A possible duplicate the exact rule misses (card-processor prefix).
    tx('s1', 'PAYPAL *Steam', '2026-09-09'), tx('s2', 'PAYPAL *Steam', '2026-09-10'), tx('s3', 'Steam', '2026-09-11'),
    tx('b1', 'Bookshop', '2026-09-12'),
  ];
  resetState({ transactions: ledger });
  state.meta = { ...META };
  saveMeta.mockReset();
  saveMeta.mockImplementation(async () => {});
  writeBatch.mockReset();
  writeBatch.mockImplementation(async () => {});
  mountHosts();
});

async function open(opts) {
  openPayeeMergeSheet(opts);
  await flush();
}

describe('payee merge: what is offered', () => {
  it('lists exact groups (biggest first) and the looser one, with the busiest spelling as the target', async () => {
    await open();
    const cards = [...sheet().querySelectorAll('.card')];
    expect(cards).toHaveLength(3);
    expect(cards[0].textContent).toContain('LIDL 1234');
    expect(cards[1].textContent).toContain('K Market');
    expect(cards[2].textContent).toContain('PAYPAL *Steam');
    expect(target(cards[0]).value).toBe('Lidl');
    // A card-processor prefix never wins the default name.
    expect(target(cards[2]).value).toBe('Steam');
    // Exact groups start fully ticked; the looser one starts unticked and needs two.
    expect(members(cards[0]).every(c => c.checked)).toBe(true);
    expect(members(cards[2]).some(c => c.checked)).toBe(false);
    expect(mergeBtn(cards[0]).disabled).toBe(false);
    expect(mergeBtn(cards[2]).disabled).toBe(true);
    await tick(members(cards[2])[0]);
    expect(mergeBtn(cards[2]).disabled).toBe(true);
    await tick(members(cards[2])[1]);
    expect(mergeBtn(cards[2]).disabled).toBe(false);
    expect(writeBatch).not.toHaveBeenCalled();
    expect(saveMeta).not.toHaveBeenCalled();
  });

  it('countPayeeGroups counts exact groups, leaving out ignored and hidden ones', () => {
    expect(countPayeeGroups()).toBe(2);
    state.meta = { payeeMergeIgnored: { lidl: ['lidl', 'lidl 1234'] } };
    expect(countPayeeGroups()).toBe(1);
    state.meta = { payeeMergeIgnored: { lidl: ['lidl', 'lidl 1234'] }, payeeHidden: ['k market'] };
    expect(countPayeeGroups()).toBe(0);
  });
});

describe('payee merge: merging', () => {
  it('renames the merged-away rows and remembers their spelling', async () => {
    await open();
    const card = cardWith('LIDL 1234');
    await click(mergeBtn(card));
    // A confirmation names the number of rows the merge rewrites (the two
    // "LIDL 1234"; the three "Lidl" already read so), from a dry run, and the
    // kept name.
    expect(topOverlay().textContent).toContain(t('payeeMerge.confirm')(2, 'Lidl'));
    expect(writeBatch).not.toHaveBeenCalled();
    const input = { from: ['lidl', 'lidl 1234'], fromNames: ['Lidl', 'LIDL 1234'], to: 'Lidl' };
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0]).toEqual(['payee.merge', input, { dryRun: true }]);
    dialogOk().click();
    await flush();

    // One command, one commit: rows and aliases in the same batch.
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(dispatch.mock.calls[1].slice(0, 2)).toEqual(['payee.merge', input]);
    expect(dispatch.mock.calls[1][2]).toBeUndefined();
    expect(writeBatch).toHaveBeenCalledTimes(1);
    expect(writeBatch.mock.calls[0][0]).toBe(state.budgetFolder);
    expect(saveMeta).not.toHaveBeenCalled();
    expect(payeesOf(written())).toEqual([
      'Lidl', 'Lidl', 'Lidl', 'Lidl', 'Lidl',
      'K-Market', 'K-Market', 'K Market', 'PAYPAL *Steam', 'PAYPAL *Steam', 'Steam', 'Bookshop',
    ]);
    // Only the renamed rows carry a new modified_at; the rest are the same objects.
    expect(written()[3]).toMatchObject({ id: 'l4', payee: 'Lidl' });
    expect(written()[3].modified_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(written()[0]).toEqual(ledger[0]);
    expect(written()[11]).toEqual(ledger[11]);
    // "Lidl" is already the kept spelling, so only "LIDL 1234" becomes an alias.
    expect(batchMeta().payeeAliases).toEqual({ 'lidl 1234': 'Lidl' });
    expect(batchMeta().name).toBe('Household');
    expect(state.transactions).toEqual(written());
    expect(state.meta.payeeAliases).toEqual({ 'lidl 1234': 'Lidl' });
    expect(toastTexts()).toContain(t('payeeMerge.done')(2, 'Lidl'));
    // The merged group is gone from the list.
    expect(cardWith('LIDL 1234')).toBeUndefined();
  });

  it('the done toast offers Undo, which restores the rows and the aliases and brings the group back', async () => {
    await open();
    setValue(target(cardWith('K Market')), 'K-Market', ['input']);
    await click(mergeBtn(cardWith('K Market')));
    dialogOk().click();
    await flush();
    expect(state.meta.payeeAliases).toEqual({ 'k market': 'K-Market' });
    expect(cardWith('K Market')).toBeUndefined();

    const undoBtn = [...document.querySelectorAll('#toast-host .toast-action')].find(b => b.textContent === t('common.undo'));
    expect(undoBtn).toBeTruthy();
    undoBtn.click();
    await flush();

    expect(writeBatch).toHaveBeenCalledTimes(2);
    expect(payeesOf(state.transactions)).toEqual(payeesOf(ledger));
    expect(state.meta.payeeAliases ?? {}).toEqual({});
    expect(state.meta.name).toBe('Household');
    expect(toastTexts()).toContain(t('common.restored'));
    // The sheet repaints from the restored rows: the group is offered again.
    expect(cardWith('K Market')).toBeTruthy();
  });

  it('a typed name renames every ticked payee to it, including the busiest', async () => {
    await open();
    const card = cardWith('LIDL 1234');
    setValue(target(card), 'Lidl Finland', ['input']);
    await click(mergeBtn(card));
    dialogOk().click();
    await flush();
    expect(payeesOf(written()).slice(0, 5)).toEqual(Array(5).fill('Lidl Finland'));
    expect(batchMeta().payeeAliases).toEqual({ lidl: 'Lidl Finland', 'lidl 1234': 'Lidl Finland' });
    expect(toastTexts()).toContain(t('payeeMerge.done')(5, 'Lidl Finland'));
  });

  it('only the ticked members are renamed', async () => {
    await open();
    const card = cardWith('LIDL 1234');
    // Members are busiest first: "Lidl" (3), then "LIDL 1234" (2). Untick "Lidl".
    await untick(members(card)[0]);
    setValue(target(card), 'Lidl Oy', ['input']);
    await click(mergeBtn(card));
    expect(topOverlay().textContent).toContain(t('payeeMerge.confirm')(2, 'Lidl Oy'));
    dialogOk().click();
    await flush();
    expect(payeesOf(written()).slice(0, 5)).toEqual(['Lidl', 'Lidl', 'Lidl', 'Lidl Oy', 'Lidl Oy']);
    expect(batchMeta().payeeAliases).toEqual({ 'lidl 1234': 'Lidl Oy' });
  });

  it('declining the confirmation writes nothing', async () => {
    await open();
    await click(mergeBtn(cardWith('LIDL 1234')));
    dialogButton(t('common.cancel')).click();
    await flush();
    expect(writeBatch).not.toHaveBeenCalled();
    expect(saveMeta).not.toHaveBeenCalled();
    expect(cardWith('LIDL 1234')).toBeTruthy();
  });

  it('a blank name does nothing, not even a confirmation', async () => {
    await open();
    const card = cardWith('LIDL 1234');
    setValue(target(card), '   ', ['input']);
    await click(mergeBtn(card));
    expect(topOverlay()).toBe(document.querySelector('#sheet-host .sheet-overlay[data-sheet-open]'));
    expect(writeBatch).not.toHaveBeenCalled();
  });

  it('merging into the name it already has says there is nothing to change', async () => {
    await open();
    const card = cardWith('K Market');
    // "K-Market" rows already read that; "K Market" is the only one that would change,
    // so untick it and merge the rest into the same name.
    await untick(members(card)[1]);
    await click(mergeBtn(card));
    // The dry run finds nothing to rewrite: no confirmation, nothing written.
    expect(topOverlay()).toBe(document.querySelector('#sheet-host .sheet-overlay[data-sheet-open]'));
    expect(writeBatch).not.toHaveBeenCalled();
    expect(toastTexts()).toContain(t('payeeMerge.nothing'));
  });

  it('a failed write changes nothing: not the rows, not the aliases', async () => {
    const beforeTxs = state.transactions;
    const beforeMeta = state.meta;
    writeBatch.mockImplementationOnce(async () => { throw new Error('disk full'); });
    await open();
    const card = cardWith('LIDL 1234');
    await click(mergeBtn(card));
    dialogOk().click();
    await flush();

    expect(state.transactions).toBe(beforeTxs);
    expect(state.meta).toBe(beforeMeta);
    expect(toastTexts().some(x => x.includes('disk full'))).toBe(true);
    expect(toastTexts()).not.toContain(t('payeeMerge.done')(2, 'Lidl'));
    expect(cardWith('LIDL 1234')).toBeTruthy();
    // The button is usable again: a retry goes through.
    await click(mergeBtn(cardWith('LIDL 1234')));
    dialogOk().click();
    await flush();
    expect(writeBatch).toHaveBeenCalledTimes(2);
    expect(batchMeta().payeeAliases).toEqual({ 'lidl 1234': 'Lidl' });
    expect(state.meta.payeeAliases).toEqual({ 'lidl 1234': 'Lidl' });
  });

  it('a version conflict shows the reload dialog rather than the toast', async () => {
    writeBatch.mockImplementationOnce(async () => { throw Object.assign(new Error('conflict'), { status: 409 }); });
    await open();
    await click(mergeBtn(cardWith('LIDL 1234')));
    dialogOk().click();
    await flush();
    expect(document.querySelector('#sheet-host').textContent).toContain(t('saveError.versionConflictTitle'));
    expect(state.meta.payeeAliases).toBeUndefined();
  });

  it('under strict-ledger a merge touching past posted rows is refused and changes nothing', async () => {
    state.meta = { ...META, policies: ['strict-ledger'] };
    const beforeTxs = state.transactions;
    await open();
    await click(mergeBtn(cardWith('LIDL 1234')));
    // The dry run is refused already, so no confirmation is offered.
    expect(topOverlay()).toBe(document.querySelector('#sheet-host .sheet-overlay[data-sheet-open]'));
    expect(writeBatch).not.toHaveBeenCalled();
    expect(state.transactions).toBe(beforeTxs);
    expect(toastTexts().some(x => x.includes(t('common.saveFailed')('').trim()))).toBe(true);
    expect(toastTexts()).not.toContain(t('payeeMerge.done')(2, 'Lidl'));
  });

  it('carries an investment symbol rule over to the kept name, in the same commit', async () => {
    state.meta = { ...META, investments: { payeeRules: { 'lidl 1234': 'VWCE' } } };
    await open();
    await click(mergeBtn(cardWith('LIDL 1234')));
    dialogOk().click();
    await flush();
    expect(writeBatch).toHaveBeenCalledTimes(1);
    expect(saveMeta).not.toHaveBeenCalled();
    expect(batchMeta().investments.payeeRules).toEqual({ lidl: 'VWCE' });
    expect(batchMeta().payeeAliases).toEqual({ 'lidl 1234': 'Lidl' });
  });

  it('merging into a hidden payee unhides it in the same commit', async () => {
    state.meta = { ...META, payeeHidden: ['bookshop', 'zed'] };
    await open();
    const card = cardWith('LIDL 1234');
    setValue(target(card), 'Bookshop', ['input']);
    await click(mergeBtn(card));
    dialogOk().click();
    await flush();
    expect(writeBatch).toHaveBeenCalledTimes(1);
    expect(batchMeta().payeeHidden).toEqual(['zed']);
  });

  it('a looser group merges only once two members are ticked', async () => {
    await open();
    const card = cardWith('PAYPAL *Steam');
    for (const cb of members(card)) await tick(cb);
    await click(mergeBtn(card));
    dialogOk().click();
    await flush();
    expect(payeesOf(written()).slice(8, 11)).toEqual(['Steam', 'Steam', 'Steam']);
    expect(batchMeta().payeeAliases).toEqual({ 'paypal *steam': 'Steam' });
  });
});

describe('payee merge: search and the merge basket', () => {
  it('a single searched payee can be renamed; results start unticked', async () => {
    await open();
    setValue(searchBox(), 'k market', ['input']);
    await flush();
    const card = cardWith('K Market');
    expect(members(card).some(c => c.checked)).toBe(false);
    expect(mergeBtn(card).disabled).toBe(true);
    // Members are busiest first: "K-Market" (2), "K Market" (1).
    await tick(members(card)[1]);
    expect(mergeBtn(card).disabled).toBe(false);
    setValue(target(card), 'K-Market', ['input']);
    await click(mergeBtn(card));
    dialogOk().click();
    await flush();
    expect(written().find(x => x.id === 'k3').payee).toBe('K-Market');
    expect(written().find(x => x.id === 'k1')).toEqual(ledger[5]);
    expect(batchMeta().payeeAliases).toEqual({ 'k market': 'K-Market' });
  });

  it('spellings collected in the basket across searches merge in one go, and the basket empties', async () => {
    await open();
    setValue(searchBox(), 'steam', ['input']);
    await flush();
    let card = cardWith('PAYPAL *Steam');
    await tick(members(card)[0]);
    await click(sheetButton(t('payeeMerge.addToBasket')));
    setValue(searchBox(), 'bookshop', ['input']);
    await flush();
    card = cardWith('Bookshop');
    await tick(members(card)[0]);
    await click(sheetButton(t('payeeMerge.addToBasket')));
    setValue(searchBox(), '', ['input']);
    await flush();

    const basket = cardWith(t('payeeMerge.basketHint'));
    expect(basket.textContent).toContain('PAYPAL *Steam');
    expect(basket.textContent).toContain('Bookshop');
    setValue(target(basket), 'Shopping', ['input']);
    await click(mergeBtn(basket));
    expect(topOverlay().textContent).toContain(t('payeeMerge.confirm')(3, 'Shopping'));
    dialogOk().click();
    await flush();
    expect(payeesOf(written()).filter(p => p === 'Shopping')).toHaveLength(3);
    expect(cardWith(t('payeeMerge.basketHint'))).toBeUndefined();
  });
});

describe('payee merge: ignore and restore', () => {
  it('Ignore stores the group under its key with its sorted members and drops it', async () => {
    await open();
    await click(inCard(cardWith('LIDL 1234'), t('payeeMerge.ignore')));
    expect(saveMeta).toHaveBeenCalledTimes(1);
    expect(savedMeta()).toEqual({ ...META, payeeMergeIgnored: { lidl: ['lidl', 'lidl 1234'] } });
    expect(state.meta).toBe(savedMeta());
    expect(toastTexts()).toContain(t('payeeMerge.ignoredToast'));
    expect(cardWith('LIDL 1234')).toBeUndefined();
    expect(writeBatch).not.toHaveBeenCalled();
  });

  it('Restore removes it again, and the group comes back', async () => {
    state.meta = { ...META, payeeMergeIgnored: { lidl: ['lidl', 'lidl 1234'], other: ['x'] } };
    await open();
    expect(cardWith('LIDL 1234')).toBeUndefined();
    await click(sheetButton(t('payeeMerge.showIgnored')(1)));
    await click(inCard(cardWith('LIDL 1234'), t('payeeMerge.restore')));
    expect(savedMeta().payeeMergeIgnored).toEqual({ other: ['x'] });
    expect(toastTexts()).toContain(t('payeeMerge.restoredToast'));
    expect(cardWith('LIDL 1234')).toBeTruthy();
  });

  it('a looser group is restored by every key it was stored under', async () => {
    // Stored under an older first-member key than the group's current one.
    state.meta = { payeeMergeIgnored: { 'loose:paypal *steam': ['paypal *steam', 'steam'], 'loose:older': ['paypal *steam', 'steam', 'gone'] } };
    await open();
    expect(cardWith('PAYPAL *Steam')).toBeUndefined();
    await click(sheetButton(t('payeeMerge.showIgnored')(1)));
    await click(inCard(cardWith('PAYPAL *Steam'), t('payeeMerge.restore')));
    expect(savedMeta().payeeMergeIgnored).toEqual({});
    expect(cardWith('PAYPAL *Steam')).toBeTruthy();
  });

  it('a failed Ignore keeps the group and the old meta and reports the error', async () => {
    saveMeta.mockRejectedValueOnce(new Error('offline'));
    const before = state.meta;
    await open();
    await click(inCard(cardWith('LIDL 1234'), t('payeeMerge.ignore')));
    expect(state.meta).toBe(before);
    expect(cardWith('LIDL 1234')).toBeTruthy();
    expect(toastTexts()).toContain(t('common.saveFailed')('offline'));
  });
});

describe('payee merge: hide and remembered spellings', () => {
  it('Hide writes the folded payee to meta and takes it out of the suggestions', async () => {
    await open();
    const card = cardWith('K Market');
    // "K Market" is the second row.
    const row = [...card.querySelectorAll('button')].filter(b => b.textContent === t('payeeMerge.hide'))[1];
    await click(row);
    expect(batchMeta()).toEqual({ ...META, financialHistory: expect.any(Object), payeeHidden: ['k market'] });
    expect(state.meta.payeeHidden).toEqual(['k market']);
    expect(saveMeta).not.toHaveBeenCalled();
    expect(toastTexts()).toContain(t('payeeMerge.hiddenToast'));
    // A group of one is no group.
    expect(cardWith('K Market')).toBeUndefined();
    // Transactions are never touched by hiding.
    expect(written()).toBeUndefined();
  });

  it('Show again removes it from the hidden list', async () => {
    state.meta = { ...META, payeeHidden: ['k market', 'zed'] };
    await open();
    await click(sheetButton(`▸ ${t('payeeMerge.hiddenToggle')(2)}`));
    const row = [...sheet().querySelectorAll('button')].find(b => b.getAttribute('aria-label') === `${t('payeeMerge.unhide')} — K Market`);
    await click(row);
    expect(batchMeta().payeeHidden).toEqual(['zed']);
    expect(toastTexts()).toContain(t('payeeMerge.unhiddenToast'));
    expect(cardWith('K Market')).toBeTruthy();
  });

  it('Forget drops one remembered spelling and keeps the others', async () => {
    state.meta = { ...META, payeeAliases: { 'lidl 1234': 'Lidl', spotfy: 'Spotify' } };
    await open();
    await click(sheetButton(`▸ ${t('payeeMerge.aliasesToggle')(2)}`));
    const forget = [...sheet().querySelectorAll('button')].find(b => b.getAttribute('aria-label') === `${t('payeeMerge.forget')} — lidl 1234 → Lidl`);
    await click(forget);
    expect(batchMeta().payeeAliases).toEqual({ spotfy: 'Spotify' });
    expect(toastTexts()).toContain(t('payeeMerge.forgotToast'));
  });

  it('closing the sheet calls onClose', async () => {
    const onClose = vi.fn();
    await open({ onClose });
    await click(sheetButton(t('common.close')));
    await new Promise(r => setTimeout(r, 400));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
