// @vitest-environment jsdom
// Settings → Clean-up → "Expenses that are really transfers" (owner decision
// 7, 2026-10-05): the sheet lists transactions.transferPairs and merges one
// pair per click through transaction.mergeTransfer on the real browser
// session over the fake state; Undo is the session's Undo.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../js/app.js', async () => (await import('./_fakes/pageApp.js')).appStub);
vi.mock('../js/data.js', async (importOriginal) => ({
  ...(await importOriginal()),
  saveMeta: vi.fn(async () => {}),
}));

import { saveMeta } from '../js/data.js';
import { openTransferPairsSheet, scanTransferPairs, setLookback, sinceFor } from '../js/transfer-pairs-sheet.js';
import { t } from '../js/ui/i18n.js';
import { state, writeBatch, session, resetState, mountHosts, flush, topOverlay, toastTexts } from './_fakes/pageApp.js';

const sheet = () => topOverlay()?.querySelector('.sheet') ?? null;
const cards = () => [...sheet().querySelectorAll('.transfer-pair')];
const mergeBtn = (card) => [...card.querySelectorAll('button')].find(b => b.textContent === t('transferPairs.merge'));
const click = async (el) => { el.click(); await flush(); };
const btn = (root, label) => [...root.querySelectorAll('button')].find(b => b.textContent === label);
const savedMeta = () => saveMeta.mock.calls.at(-1)?.[1];

const tx = (id, type, account, amount, date, payee, over = {}) => ({
  id, type, account, amount, date, payee, status: 'posted', envelope_id: type === 'expense' ? 'food' : null, ...over,
});

let ledger;
beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', (cb) => setTimeout(cb, 0));
  vi.spyOn(console, 'error').mockImplementation(() => {});
  ledger = [
    // Savings moved to checking, booked as an expense and an income.
    tx('x1', 'expense', 'sav', 300, '2026-09-02', 'Move to checking', { note: 'for rent' }),
    tx('i1', 'income', 'chk', 300, '2026-09-02', 'Move to checking'),
    // A shop and its refund: not a transfer.
    tx('x2', 'expense', 'chk', 20, '2026-09-05', 'Prisma'),
    tx('i2', 'income', 'sav', 20, '2026-09-05', 'Prisma return'),
  ];
  resetState({ transactions: ledger });
  state.meta = { name: 'Household' };
  saveMeta.mockReset();
  saveMeta.mockImplementation(async () => {});
  setLookback('12m');
  mountHosts();
});

afterEach(() => { vi.restoreAllMocks(); });

describe('transfer pairs sheet', () => {
  it('lists each pair with its route, amount and both legs, and writes nothing on open', async () => {
    expect(scanTransferPairs().map(p => p.id)).toEqual(['i1|x1']);
    openTransferPairsSheet();
    await flush();
    expect(sheet().textContent).toContain(t('transferPairs.found')(1));
    expect(cards()).toHaveLength(1);
    const text = cards()[0].textContent;
    expect(text).toContain('Savings → Checking');
    expect(text).toContain(t('transferPairs.expenseLeg'));
    expect(text).toContain('for rent');
    expect(writeBatch).not.toHaveBeenCalled();
  });

  it('merges a pair into one transfer, then offers Undo', async () => {
    const onAfterChange = vi.fn();
    const dispatch = vi.spyOn(session, 'dispatch');
    openTransferPairsSheet({ onAfterChange });
    await flush();
    await click(mergeBtn(cards()[0]));
    expect(dispatch.mock.calls[0].slice(0, 2)).toEqual(['transaction.mergeTransfer', { incomeId: 'i1', expenseId: 'x1' }]);
    const transfer = state.transactions.find(x => x.type === 'account_transfer');
    expect(transfer).toMatchObject({ from_account: 'sav', to_account: 'chk', amount: 300, date: '2026-09-02', note: 'for rent' });
    expect(state.transactions.some(x => x.id === 'x1' || x.id === 'i1')).toBe(false);
    expect(toastTexts()).toContain(t('transferPairs.merged')('Savings', 'Checking'));
    expect(onAfterChange).toHaveBeenCalledTimes(1);
    // The sheet stays open and now has nothing left.
    expect(sheet().textContent).toContain(t('transferPairs.none'));

    document.querySelector('#toast-host .toast-action').click();
    await flush();
    expect(state.transactions.map(x => x.id).sort()).toEqual(['i1', 'i2', 'x1', 'x2']);
    expect(cards()).toHaveLength(1);
  });

  it('with nothing to merge it says so', async () => {
    state.transactions = ledger.slice(2);
    openTransferPairsSheet();
    await flush();
    expect(sheet().textContent).toContain(t('transferPairs.none'));
    expect(cards()).toHaveLength(0);
  });
});

describe('transfer pairs sheet: Not a transfer', () => {
  it('dismisses a pair into meta, drops it from the list and the count, and restores it', async () => {
    const onAfterChange = vi.fn();
    openTransferPairsSheet({ onAfterChange });
    await flush();
    await click(btn(cards()[0], t('transferPairs.notTransfer')));
    expect(savedMeta()).toEqual({ name: 'Household', transferPairDismissed: ['i1|x1'] });
    expect(state.meta).toBe(savedMeta());
    expect(scanTransferPairs()).toEqual([]);
    expect(cards()).toHaveLength(0);
    expect(sheet().textContent).toContain(t('transferPairs.none'));
    expect(onAfterChange).toHaveBeenCalledTimes(1);
    expect(writeBatch).not.toHaveBeenCalled();

    // Show dismissed (1) lists it with Restore.
    await click(btn(sheet(), t('transferPairs.showDismissed')(1)));
    const dismissed = sheet().querySelector('.transfer-pair--dismissed');
    expect(dismissed.dataset.pair).toBe('i1|x1');
    await click(btn(dismissed, t('transferPairs.restore')));
    expect(savedMeta()).toEqual({ name: 'Household', transferPairDismissed: [] });
    expect(scanTransferPairs().map(p => p.id)).toEqual(['i1|x1']);
    expect(cards().map(c => c.dataset.pair)).toEqual(['i1|x1']);
    expect(sheet().querySelector('.transfer-pairs-show-dismissed')).toBeNull();
  });

  it('a pair already dismissed in meta is not listed or counted', async () => {
    state.meta = { name: 'Household', transferPairDismissed: ['i1|x1'] };
    expect(scanTransferPairs()).toEqual([]);
    openTransferPairsSheet();
    await flush();
    expect(cards()).toHaveLength(0);
    expect(btn(sheet(), t('transferPairs.showDismissed')(1))).toBeTruthy();
  });
});

describe('transfer pairs sheet: lookback', () => {
  // FIXED_NOW is 15 Sep 2026: a pair from March 2025 is outside 12 months.
  const old = () => [
    tx('x9', 'expense', 'sav', 75, '2025-03-10', 'Old move'),
    tx('i9', 'income', 'chk', 75, '2025-03-10', 'Old move'),
  ];

  it('maps 12 months, 2 years and all to the query\'s since', () => {
    const today = new Date(2026, 8, 15, 12);
    expect(sinceFor('12m', today)).toBeUndefined();
    expect(sinceFor('2y', today)).toBe('2024-09-15');
    expect(sinceFor('all', today)).toBe('1900-01-01');
  });

  it('widening it finds older pairs, and the Clean-up count follows it', async () => {
    state.transactions = [...ledger, ...old()];
    const onAfterChange = vi.fn();
    openTransferPairsSheet({ onAfterChange });
    await flush();
    expect(cards().map(c => c.dataset.pair)).toEqual(['i1|x1']);
    const seg = sheet().querySelector('.transfer-pairs-lookback');
    expect(seg.querySelector('[data-lookback="12m"]').getAttribute('aria-pressed')).toBe('true');
    await click(seg.querySelector('[data-lookback="2y"]'));
    expect(cards().map(c => c.dataset.pair)).toEqual(['i1|x1', 'i9|x9']);
    expect(sheet().querySelector('[data-lookback="2y"]').getAttribute('aria-pressed')).toBe('true');
    expect(scanTransferPairs()).toHaveLength(2);
    expect(onAfterChange).toHaveBeenCalledTimes(1);
    await click(sheet().querySelector('[data-lookback="12m"]'));
    expect(cards()).toHaveLength(1);
  });
});
