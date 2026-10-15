// @vitest-environment jsdom
// Duplicates sheet: the write flows. Apply is one transaction.resolveDuplicates
// dispatch through the session (the real browser session over the fake state
// in _fakes/pageApp.js): every row but the chosen keeper goes and the
// from_budget key moves onto it. Undo is the session's Undo, which refuses
// once a touched row changed since. "Not a duplicate" writes the pair keys to
// meta (a plain meta write, UI state). Drives the real js/duplicates-sheet.js
// and duplicate-finder; the storage writes (the session's writeBatch, saveMeta
// behind the meta queue) are mocked and asserted on.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../js/app.js', async () => (await import('./_fakes/pageApp.js')).appStub);
vi.mock('../js/data.js', async (importOriginal) => ({
  ...(await importOriginal()),
  saveMeta: vi.fn(async () => {}),
}));

import { saveMeta } from '../js/data.js';
import { openDuplicatesSheet, scanDuplicates } from '../js/duplicates-sheet.js';
import { t } from '../js/ui/i18n.js';
import {
  state, writeBatch, session, FIXED_NOW, resetState, mountHosts, flush,
  sheetIsOpen, topOverlay, toastTexts,
} from './_fakes/pageApp.js';

const sheet = () => topOverlay()?.querySelector('.sheet') ?? null;
const applyBtn = () => [...sheet().querySelectorAll('.btn-accent')][0];
// Group cards are the bordered blocks; each has a tick, a "Not a duplicate" button and a radio per row.
const cards = () => [...sheet().querySelectorAll('div')].filter(d => d.style.borderRadius === '6px' && d.querySelector('input[type="radio"]'));
const tick = (card) => card.querySelector('input[type="checkbox"]');
const radios = (card) => [...card.querySelectorAll('input[type="radio"]')];
// What the session wrote: the transactions file of its last writeBatch.
const written = () => writeBatch.mock.calls.at(-1)?.[1].find(f => f.filename === 'transactions.json')?.data;
// Failure toasts are announced assertively (role=alert).
const alertTexts = () => [...document.querySelectorAll('#toast-host .toast[role="alert"]')].map(el => el.textContent);
const ids = (txs) => txs.map(x => x.id);
const savedMeta = () => saveMeta.mock.calls.at(-1)?.[1];
const click = async (el) => { el.click(); await flush(); };
const choose = async (radio) => {
  radio.checked = true;
  radio.dispatchEvent(new Event('change', { bubbles: true }));
  await flush();
};
const setTick = (cb, on) => { cb.checked = on; cb.dispatchEvent(new Event('change', { bubbles: true })); };

const tx = (id, over) => ({
  id, type: 'expense', date: '2026-09-05', payee: 'Gym', amount: 30, envelope_id: 'fun', account: 'chk', status: 'posted', ...over,
});

let ledger;

beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', (cb) => setTimeout(cb, 0));
  vi.spyOn(console, 'error').mockImplementation(() => {});
  ledger = [
    // One scheduled occurrence posted twice.
    tx('s1', { from_budget: 'gym:2026-09', date: '2026-09-05' }),
    tx('s2', { from_budget: 'gym:2026-09', date: '2026-09-06' }),
    // A hand entry, then the automatic post over it.
    tx('h1', { payee: 'Landlord rent', date: '2026-09-01', amount: 800, envelope_id: 'rent' }),
    tx('p1', { payee: 'Rent', date: '2026-09-02', amount: 800, envelope_id: 'rent', from_budget: 'rent:2026-09' }),
    // Two coffees the same day: as often two real purchases.
    tx('c1', { payee: 'Cafe Nero', date: '2026-09-10', amount: 4.5, envelope_id: 'food' }),
    tx('c2', { payee: 'Cafe Nero', date: '2026-09-10', amount: 4.5, envelope_id: 'food' }),
    tx('lone', { payee: 'Bookshop', date: '2026-09-11', amount: 19, envelope_id: 'fun' }),
  ];
  resetState({ transactions: ledger });
  state.meta = { name: 'Household', duplicateDismissed: [] };
  saveMeta.mockReset();
  saveMeta.mockImplementation(async () => {});
  mountHosts();
});

afterEach(() => { vi.restoreAllMocks(); });

describe('duplicates sheet: what is offered', () => {
  it('lists the surest groups first; only machine-certain ones are ticked', async () => {
    openDuplicatesSheet();
    await flush();
    expect(sheet().textContent).toContain(t('duplicates.found')(3));
    expect(cards()).toHaveLength(3);
    expect(cards().map(c => c.textContent.includes(t('duplicates.kind.sameKey')) ? 'sameKey'
      : c.textContent.includes(t('duplicates.kind.postedOverHand')) ? 'postedOverHand' : 'plain'))
      .toEqual(['sameKey', 'postedOverHand', 'plain']);
    expect(cards().map(c => tick(c).checked)).toEqual([true, true, false]);
    // The default keeper: earliest of two keyed rows; the hand entry over the post.
    expect(radios(cards()[0]).map(r => r.checked)).toEqual([true, false]);
    expect(radios(cards()[1]).map(r => r.checked)).toEqual([true, false]);
    expect(applyBtn().textContent).toBe(t('duplicates.apply')(2));
    expect(writeBatch).not.toHaveBeenCalled();
    expect(saveMeta).not.toHaveBeenCalled();
  });

  it('pairs already dismissed in meta are not offered', async () => {
    state.meta = { duplicateDismissed: ['c1|c2'] };
    openDuplicatesSheet();
    await flush();
    expect(cards()).toHaveLength(2);
  });

  it('with no duplicates it says so and hides the apply button', async () => {
    state.transactions = [ledger[6]];
    openDuplicatesSheet();
    await flush();
    expect(sheet().textContent).toContain(t('duplicates.none'));
    expect(applyBtn().hidden).toBe(true);
  });
});

describe('duplicates sheet: apply', () => {
  it('removes the copies and moves the key onto the kept hand entry, in one dispatch', async () => {
    const onAfterChange = vi.fn();
    const dispatch = vi.spyOn(session, 'dispatch');
    openDuplicatesSheet({ onAfterChange });
    await flush();
    await click(applyBtn());

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0].slice(0, 2)).toEqual(['transaction.resolveDuplicates', {
      groups: [{ keep: 's1', drop: ['s2'] }, { keep: 'h1', drop: ['p1'] }],
    }]);
    expect(writeBatch).toHaveBeenCalledTimes(1);
    expect(writeBatch.mock.calls[0][0]).toBe(state.budgetFolder);
    // Only the ledger is written: the key lives on in the keeper, so no tombstone.
    expect(writeBatch.mock.calls[0][1].map(f => f.filename)).toEqual(['transactions.json', 'budget-meta.json']);
    // s2 (copy of s1) and p1 (the post over h1) are gone; the coffees are untouched.
    expect(ids(written())).toEqual(['s1', 'h1', 'c1', 'c2', 'lone']);
    expect(state.transactions).toBe(written());
    // s1 already carries its key; h1 takes the post's key, so the bill stays settled.
    expect(written()[0]).toBe(ledger[0]);
    expect(written()[1]).toEqual({ ...ledger[2], from_budget: 'rent:2026-09', modified_at: FIXED_NOW.toISOString() });
    expect(toastTexts()).toContain(t('duplicates.applied')(2));
    expect(onAfterChange).toHaveBeenCalledTimes(1);
    expect(sheetIsOpen()).toBe(false);
  });

  it('the Keep choice decides which row survives, and ticks its group', async () => {
    openDuplicatesSheet();
    await flush();
    // Plain group: keep the second coffee. Choosing a keeper ticks the group.
    await choose(radios(cards()[2])[1]);
    expect(tick(cards()[2]).checked).toBe(true);
    expect(applyBtn().textContent).toBe(t('duplicates.apply')(3));
    // sameKey group: keep the later row.
    await choose(radios(cards()[0])[1]);
    await click(applyBtn());
    expect(ids(written())).toEqual(['s2', 'h1', 'c2', 'lone']);
  });

  it('an unticked group is left alone', async () => {
    openDuplicatesSheet();
    await flush();
    setTick(tick(cards()[0]), false);
    expect(applyBtn().textContent).toBe(t('duplicates.apply')(1));
    await click(applyBtn());
    expect(ids(written())).toEqual(['s1', 's2', 'h1', 'c1', 'c2', 'lone']);
  });

  it('nothing ticked disables the button and clicking writes nothing', async () => {
    openDuplicatesSheet();
    await flush();
    setTick(tick(cards()[0]), false);
    setTick(tick(cards()[1]), false);
    expect(applyBtn().textContent).toBe(t('duplicates.apply')(0));
    expect(applyBtn().disabled).toBe(true);
    await click(applyBtn());
    expect(writeBatch).not.toHaveBeenCalled();
  });

  it('a second click while the write is in flight does not dispatch twice', async () => {
    let release;
    writeBatch.mockImplementationOnce(() => new Promise(res => { release = res; }));
    const dispatch = vi.spyOn(session, 'dispatch');
    openDuplicatesSheet();
    await flush();
    const apply = applyBtn();
    apply.click();
    apply.click();
    await flush();
    expect(apply.disabled).toBe(true);
    release();
    await flush();
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(toastTexts().filter(m => m.startsWith(t('duplicates.applied')(2)))).toHaveLength(1);
  });
});

describe('duplicates sheet: Not a duplicate', () => {
  it('writes the pair keys to meta, keeping the rest, and drops the group', async () => {
    const onAfterChange = vi.fn();
    openDuplicatesSheet({ onAfterChange });
    await flush();
    await click(cards()[0].querySelector('button')); // first card: sameKey s1|s2
    expect(saveMeta).toHaveBeenCalledTimes(1);
    expect(saveMeta.mock.calls[0][0]).toBe(state.budgetFolder);
    expect(savedMeta()).toEqual({ name: 'Household', duplicateDismissed: ['s1|s2'] });
    expect(state.meta).toBe(savedMeta());
    expect(cards()).toHaveLength(2);
    expect(applyBtn().textContent).toBe(t('duplicates.apply')(1));
    expect(onAfterChange).toHaveBeenCalledTimes(1);
    // Transactions are never touched by a dismissal.
    expect(writeBatch).not.toHaveBeenCalled();
  });

  it('dismissals accumulate, sorted, and the last one empties the sheet', async () => {
    openDuplicatesSheet();
    await flush();
    for (let n = 0; n < 3; n++) {
      await click(cards()[0].querySelector('button'));
    }
    expect(savedMeta().duplicateDismissed).toEqual(['c1|c2', 'h1|p1', 's1|s2']);
    expect(sheet().textContent).toContain(t('duplicates.none'));
    expect(applyBtn().hidden).toBe(true);
  });

  it('a failed write keeps the group and the old meta, and reports the error', async () => {
    saveMeta.mockRejectedValueOnce(new Error('offline'));
    const before = state.meta;
    const onAfterChange = vi.fn();
    openDuplicatesSheet({ onAfterChange });
    await flush();
    const btn = cards()[0].querySelector('button');
    await click(btn);
    expect(state.meta).toBe(before);
    expect(cards()).toHaveLength(3);
    expect(btn.disabled).toBe(false);
    expect(onAfterChange).not.toHaveBeenCalled();
    expect(toastTexts()).toContain(t('common.saveFailed')('offline'));
  });
});

describe('duplicates sheet: undo', () => {
  const undo = async () => { document.querySelector('#toast-host .toast-action').click(); await flush(); };

  it('Undo, through the session, brings the removed rows back where they were and restores the row that took a key', async () => {
    const onAfterChange = vi.fn();
    openDuplicatesSheet({ onAfterChange });
    await flush();
    await click(applyBtn());
    expect(writeBatch).toHaveBeenCalledTimes(1);
    const undoSpy = vi.spyOn(session, 'undo');
    await undo();

    expect(undoSpy).toHaveBeenCalledTimes(1);
    expect(writeBatch).toHaveBeenCalledTimes(2);
    expect(writeBatch.mock.calls[1][0]).toBe(state.budgetFolder);
    // The session puts the removed rows back at their original index.
    expect(ids(written())).toEqual(['s1', 's2', 'h1', 'p1', 'c1', 'c2', 'lone']);
    // The hand entry is exactly the row it was: no key, no modified_at.
    expect(written().find(x => x.id === 'h1')).toEqual(ledger[2]);
    expect(written().find(x => x.id === 'p1')).toEqual(ledger[3]);
    expect(written().find(x => x.id === 's2')).toEqual(ledger[1]);
    expect(state.transactions).toBe(written());
    expect(onAfterChange).toHaveBeenCalledTimes(2);
  });

  it('an edit made after the cleanup makes the undo refuse, and keeps the edit', async () => {
    const onAfterChange = vi.fn();
    openDuplicatesSheet({ onAfterChange });
    await flush();
    await click(applyBtn());
    // The user edits the kept hand entry (through the session) before undoing.
    const edited = await session.dispatch('transaction.amend', { id: 'h1', note: 'edited' });
    expect(edited.ok).toBe(true);
    const writes = writeBatch.mock.calls.length;
    await undo();

    // Nothing is written; the edit and the cleanup both stand.
    expect(writeBatch).toHaveBeenCalledTimes(writes);
    const h1 = state.transactions.find(x => x.id === 'h1');
    expect(h1.note).toBe('edited');
    expect(h1.from_budget).toBe('rent:2026-09');
    expect(ids(state.transactions)).not.toContain('p1');
    expect(toastTexts()).toContain(t('coreError.undoStale'));
    expect(onAfterChange).toHaveBeenCalledTimes(1);
  });

  it('Undo after a budget switch writes nothing', async () => {
    openDuplicatesSheet();
    await flush();
    await click(applyBtn());
    state.budgetFolder = { name: 'budget-B' };
    state.transactions = [];
    await undo();
    expect(writeBatch).toHaveBeenCalledTimes(1);
    expect(state.transactions).toEqual([]);
    expect(toastTexts()).toContain(t('coreError.undoBudgetChanged'));
  });

  it('a failed undo write reports the error and leaves the cleanup in place', async () => {
    openDuplicatesSheet();
    await flush();
    await click(applyBtn());
    const after = state.transactions;
    writeBatch.mockRejectedValueOnce(new Error('nope'));
    await undo();
    expect(alertTexts()).toContain(t('duplicates.applyFailed'));
    expect(console.error).toHaveBeenCalledWith('duplicates undo failed:', expect.objectContaining({ code: 'write_failed' }));
    expect(state.transactions).toBe(after);
  });

  it('an undo refused by a version conflict shows the reload dialog, not the toast, and leaves the cleanup in place', async () => {
    openDuplicatesSheet();
    await flush();
    await click(applyBtn());
    const after = state.transactions;
    writeBatch.mockRejectedValueOnce(Object.assign(new Error('conflict'), { status: 409 }));
    await undo();
    expect(document.querySelector('#sheet-host').textContent).toContain(t('saveError.versionConflictTitle'));
    expect(alertTexts()).not.toContain(t('duplicates.applyFailed'));
    expect(state.transactions).toBe(after);
    // Dismiss it: the dialog is a singleton, and an open one swallows the next.
    [...document.querySelectorAll('#sheet-host button')].find(x => x.textContent === t('saveError.dismiss')).click();
    await flush();
  });
});

describe('duplicates sheet: a refused write', () => {
  it('leaves state untouched, keeps the sheet open and allows a retry', async () => {
    const before = state.transactions;
    const onAfterChange = vi.fn();
    writeBatch.mockRejectedValueOnce(new Error('disk full'));

    openDuplicatesSheet({ onAfterChange });
    await flush();
    await click(applyBtn());
    // Nothing was published: the session writes first.
    expect(state.transactions).toBe(before);
    expect(alertTexts()).toContain(t('duplicates.applyFailed'));
    expect(console.error).toHaveBeenCalledWith('duplicates cleanup failed:', expect.objectContaining({ code: 'write_failed' }));
    expect(toastTexts().some(m => m.startsWith(t('duplicates.applied')(2)))).toBe(false);
    expect(sheetIsOpen()).toBe(true);
    expect(applyBtn().disabled).toBe(false);
    expect(onAfterChange).not.toHaveBeenCalled();

    await click(applyBtn());
    expect(writeBatch).toHaveBeenCalledTimes(2);
    expect(ids(state.transactions)).toEqual(['s1', 'h1', 'c1', 'c2', 'lone']);
    expect(sheetIsOpen()).toBe(false);
    expect(onAfterChange).toHaveBeenCalledTimes(1);
  });

  it('a version conflict shows the reload dialog rather than the toast', async () => {
    const before = state.transactions;
    writeBatch.mockRejectedValueOnce(Object.assign(new Error('conflict'), { status: 409 }));
    openDuplicatesSheet();
    await flush();
    await click(applyBtn());
    expect(state.transactions).toBe(before);
    expect(document.querySelector('#sheet-host').textContent).toContain(t('saveError.versionConflictTitle'));
    expect(toastTexts()).not.toContain(t('duplicates.applyFailed'));
    expect(applyBtn().disabled).toBe(false);
  });
});

it('reads the same candidate set through the session query as other surfaces', () => {
  const query = vi.spyOn(session, 'query');
  const candidates = scanDuplicates();
  expect(query).toHaveBeenCalledWith('transactions.duplicates', {});
  expect(candidates).toEqual(session.query('transactions.duplicates', {}).value.groups);
  expect(writeBatch).not.toHaveBeenCalled();
});
