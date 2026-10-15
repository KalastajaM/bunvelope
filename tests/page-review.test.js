// @vitest-environment jsdom
// Month review: the consolidate popover's write (a `consolidation` fill that
// moves an envelope's surplus back to unallocated, dispatched as
// allocation.consolidate) and the close / reopen month meta write. Drives the
// real js/pages/review.js; the fake session's writeBatch and saveMeta (the
// storage writes) are mocked and asserted on.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../js/app.js', async () => (await import('./_fakes/pageApp.js')).appStub);
vi.mock('../js/data.js', async (importOriginal) => ({
  ...(await importOriginal()),
  saveMeta: vi.fn(async () => {}),
}));

import { saveMeta } from '../js/data.js';
import { render } from '../js/pages/review.js';
import { t, fmtMonthLang, fmtDateLang } from '../js/ui/i18n.js';
import {
  state, writeBatch, session, updateStatusBar, resetState, mountHosts, flush, setValue, dialogOk, dialogButton, toastTexts,
} from './_fakes/pageApp.js';

const root = () => document.getElementById('app-root');
const consolidateBtn = (envId) => root().querySelector(`button[data-consolidate-id="${envId}"]`);
const pop = () => document.querySelector('.review-consolidate-pop');
const popInput = () => pop().querySelector('input');
const popButton = (label) => [...pop().querySelectorAll('button')].find(b => b.textContent === label);
const batch = () => writeBatch.mock.calls.at(-1)?.[1];
const batchMeta = () => batch().find(f => f.filename === 'budget-meta.json').data;
const written = () => batch().find(f => f.filename === 'transactions.json').data;
let dispatch;
const consolidationFill = () => state.transactions.find(tx => tx.source === 'consolidation');

async function openPage() {
  mountHosts();
  await render(root());
}

async function consolidate(envId, amount) {
  consolidateBtn(envId).click();
  if (amount !== undefined) setValue(popInput(), String(amount), ['input']);
  popButton(t('review.consolidate')).click();
  await flush();
}

beforeEach(async () => {
  vi.stubGlobal('requestAnimationFrame', (cb) => setTimeout(cb, 0));
  // jsdom has none; the sticky-header offset only needs it to exist.
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} unobserve() {} });
  resetState({
    transactions: [
      // Food holds 300 and Fun 120, neither has a plan: all of it is surplus.
      { id: 'i1', type: 'income', date: '2026-09-01', payee: 'Job', amount: 300, envelope_id: 'food', account: 'chk', status: 'posted' },
      { id: 'i2', type: 'income', date: '2026-09-02', payee: 'Gift', amount: 120, envelope_id: 'fun', account: 'chk', status: 'posted' },
    ],
  });
  document.querySelectorAll('.review-consolidate-pop').forEach(el => el.remove());
  writeBatch.mockReset();
  writeBatch.mockImplementation(async () => {});
  updateStatusBar.mockClear();
  saveMeta.mockReset();
  saveMeta.mockImplementation(async () => {});
  dispatch = vi.spyOn(session, 'dispatch');
  dispatch.mockClear();
  await openPage();
});

describe('consolidate', () => {
  it('offers the button on the current month only', async () => {
    expect(consolidateBtn('food')).toBeTruthy();
    const picker = root().querySelector('#month-picker');
    setValue(picker, '2026-10', ['change']);
    expect(root().querySelector('button[data-consolidate-id]')).toBeNull();
  });

  it('pre-fills the surplus as a negative amount and writes it as a posted consolidation fill', async () => {
    consolidateBtn('food').click();
    expect(pop()).toBeTruthy();
    expect(Number(popInput().value)).toBe(-300);

    popButton(t('review.consolidate')).click();
    await flush();

    expect(writeBatch).toHaveBeenCalledTimes(1);
    expect(writeBatch.mock.calls[0][0]).toBe(state.budgetFolder);
    expect(batch().map(i => i.filename)).toEqual(['transactions.json', 'budget-meta.json']);
    expect(written()).toHaveLength(3);
    expect(dispatch).toHaveBeenCalledWith('allocation.consolidate', {
      lines: [{ envelope: 'food', amount: -300 }], payee: t('review.consolidationNote'),
    }, undefined);
    const fill = consolidationFill();
    expect(fill).toMatchObject({
      type: 'fill', date: '2026-09-15', status: 'posted', source: 'consolidation',
      lines: [{ envelope_id: 'food', amount: -300, mode: 'add' }],
    });
    expect(fill.id).toBeTruthy();
    // Not optimistic: state carries what the session published after the write.
    expect(state.transactions).toEqual(written());
    expect(updateStatusBar).toHaveBeenCalled();
    expect(toastTexts()).toContain(t('review.consolidated'));
    expect(pop()).toBeNull();
  });

  it('writes the amount as typed', async () => {
    await consolidate('food', -120.5);
    expect(consolidationFill().lines).toEqual([{ envelope_id: 'food', amount: -120.5, mode: 'add' }]);
  });

  it('a second envelope joins today\'s fill instead of adding another one', async () => {
    await consolidate('food');
    await consolidate('fun');
    const fills = state.transactions.filter(tx => tx.source === 'consolidation');
    expect(fills).toHaveLength(1);
    expect(fills[0].lines).toEqual([
      { envelope_id: 'food', amount: -300, mode: 'add' },
      { envelope_id: 'fun', amount: -120, mode: 'add' },
    ]);
    expect(writeBatch).toHaveBeenCalledTimes(2);
  });

  it('consolidating the same envelope again replaces its line, never stacks it', async () => {
    await consolidate('food', -100);
    await consolidate('food', -40);
    const fill = consolidationFill();
    expect(fill.lines).toEqual([{ envelope_id: 'food', amount: -40, mode: 'add' }]);
  });

  it('a zero amount writes nothing', async () => {
    consolidateBtn('food').click();
    setValue(popInput(), '0', ['input']);
    popButton(t('review.consolidate')).click();
    await flush();
    expect(writeBatch).not.toHaveBeenCalled();
    expect(consolidationFill()).toBeUndefined();
    expect(pop()).toBeNull();
  });

  it('cancel writes nothing', async () => {
    consolidateBtn('food').click();
    popButton(t('review.cancel')).click();
    await flush();
    expect(writeBatch).not.toHaveBeenCalled();
    expect(state.transactions).toHaveLength(2);
    expect(pop()).toBeNull();
  });

  it('a failed write leaves the ledger as it was, says so and offers the button again', async () => {
    const before = state.transactions;
    writeBatch.mockImplementationOnce(async () => { throw new Error('offline'); });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await consolidate('food');
    expect(state.transactions).toBe(before);
    expect(consolidationFill()).toBeUndefined();
    expect(toastTexts().some(m => m.includes('offline'))).toBe(true);
    expect(toastTexts()).not.toContain(t('review.consolidated'));
    expect(consolidateBtn('food').disabled).toBe(false);
    expect(consolidateBtn('food').hasAttribute('aria-busy')).toBe(false);
  });

  it('shows the button busy while the write is in flight and repaints on success', async () => {
    let finish;
    writeBatch.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const before = state.transactions;
    const btn = consolidateBtn('food');
    btn.click();
    popButton(t('review.consolidate')).click();
    await flush();
    // Nothing is published until the write lands; the button says it is working.
    expect(state.transactions).toBe(before);
    expect(btn.disabled).toBe(true);
    expect(btn.getAttribute('aria-busy')).toBe('true');
    expect(toastTexts()).not.toContain(t('review.consolidated'));
    finish();
    await flush();
    expect(consolidationFill()).toBeTruthy();
    expect(toastTexts()).toContain(t('review.consolidated'));
    // Repainted from the new ledger: Food has no surplus left, so no button.
    expect(consolidateBtn('food')).toBeNull();
  });
});

// Only a month that has ended can be closed: today is 15 Sep 2026 (the fake
// clock), so these close August, the month just ended.
const showMonth = (m) => setValue(root().querySelector('#month-picker'), m, ['change']);

describe('close and reopen a month', () => {
  const closeBtn = () => root().querySelector('#review-close-month');

  it('the current month cannot be closed yet: the button is disabled and says when', () => {
    expect(closeBtn().disabled).toBe(true);
    expect(closeBtn().title).toBe(t('review.closeNotYet')(fmtMonthLang('2026-09')));
    closeBtn().click();
    expect(dispatch).not.toHaveBeenCalledWith('month.close', expect.anything(), undefined);
  });

  it('a future month has no close button', () => {
    showMonth('2026-11');
    expect(closeBtn()).toBeNull();
  });

  it('a closed current month can still be reopened', async () => {
    state.meta = { schemaVersion: 8, closed_months: ['2026-09'] };
    await openPage();
    expect(closeBtn().disabled).toBe(false);
    expect(closeBtn().textContent).toBe(t('review.reopenMonth'));
  });

  it('a past month is read-only: no consolidate, a note with its last day, the close button enabled', () => {
    showMonth('2026-08');
    expect(root().querySelector('button[data-consolidate-id]')).toBeNull();
    expect(root().querySelector('.review-past-note').textContent).toBe(t('review.pastReadOnly')(fmtDateLang('2026-08-31')));
    expect(closeBtn().disabled).toBe(false);
    expect(closeBtn().textContent).toBe(t('review.closeMonth'));
  });

  it('the view chip follows the month: today for the current month, the last day for a past one', () => {
    const chip = () => root().querySelector('#review-view-chip');
    expect(chip().textContent).toBe(`${t('lens.today')} · ${t('workspace.reviewBasis')}`);
    showMonth('2026-08');
    expect(chip().textContent).toBe(`${t('lens.monthEnd')} · ${t('lens.chipMonthEnd')(fmtDateLang('2026-08-31'))}`);
    expect(chip().classList.contains('view-chip--today')).toBe(false);
    showMonth('2026-09');
    expect(chip().textContent).toBe(`${t('lens.today')} · ${t('workspace.reviewBasis')}`);
    expect(root().querySelectorAll('.view-chip')).toHaveLength(1);
  });

  it('asks first; cancelling writes nothing', async () => {
    showMonth('2026-08');
    closeBtn().click();
    await flush();
    dialogButton(t('addTx.cancel')).click();
    await flush();
    expect(dispatch).not.toHaveBeenCalledWith('month.close', expect.anything());
    expect(writeBatch).not.toHaveBeenCalled();
    expect(state.meta.closed_months).toBeUndefined();
  });

  it('closing adds the month to meta.closed_months, keeping the rest of meta', async () => {
    state.meta = { schemaVersion: 8, country: 'FI', closed_months: ['2026-07'] };
    await openPage();
    showMonth('2026-08');
    closeBtn().click();
    await flush();
    dialogOk().click();
    await flush();
    expect(dispatch).toHaveBeenCalledWith('month.close', { month: '2026-08' }, undefined);
    expect(writeBatch).toHaveBeenCalledTimes(1);
    expect(writeBatch.mock.calls[0][0]).toBe(state.budgetFolder);
    expect(batchMeta()).toEqual({ financialHistory: expect.any(Object), schemaVersion: 8, country: 'FI', closed_months: ['2026-07', '2026-08'] });
    expect(saveMeta).not.toHaveBeenCalled();
    expect(state.meta.closed_months).toEqual(['2026-07', '2026-08']);
    // The page repaints as closed: the same button now reopens.
    expect(closeBtn().textContent).toBe(t('review.reopenMonth'));
  });

  it('reopening removes just that month', async () => {
    state.meta = { schemaVersion: 8, closed_months: ['2026-08', '2026-09'] };
    await openPage();
    expect(closeBtn().textContent).toBe(t('review.reopenMonth'));
    closeBtn().click();
    await flush();
    dialogOk().click();
    await flush();
    expect(dispatch).toHaveBeenCalledWith('month.reopen', { month: '2026-09' }, undefined);
    expect(batchMeta().closed_months).toEqual(['2026-08']);
  });

  it('a failed save leaves meta as it was and toasts', async () => {
    writeBatch.mockImplementationOnce(async () => { throw new Error('offline'); });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    showMonth('2026-08');
    closeBtn().click();
    await flush();
    dialogOk().click();
    await flush();
    expect(state.meta.closed_months).toBeUndefined();
    expect(toastTexts()).toContain(t('review.closeFailed'));
  });

  it('a stale decision (the month is no longer closed) is refused with the same message', async () => {
    state.meta = { schemaVersion: 8, closed_months: ['2026-09'] };
    await openPage();
    expect(closeBtn().textContent).toBe(t('review.reopenMonth'));
    closeBtn().click();
    await flush();
    // Another tab reopens it between the render and the click's dispatch.
    state.meta = { schemaVersion: 8 };
    dialogOk().click();
    await flush();
    expect(writeBatch).not.toHaveBeenCalled();
    expect(toastTexts()).toContain(t('review.closeFailed'));
  });
});

describe('closed automatically', () => {
  const closeBtn = () => root().querySelector('#review-close-month');

  it('closing a month by hand drops a stale reopen exception for it', async () => {
    state.meta = { schemaVersion: 8, auto_close_after_months: 1, reopened_months: ['2026-07'] };
    await openPage();
    showMonth('2026-07');
    expect(closeBtn().textContent).toBe(t('review.closeMonth'));
    closeBtn().click();
    await flush();
    dialogOk().click();
    await flush();
    expect(batchMeta()).toEqual({ financialHistory: expect.any(Object), schemaVersion: 8, auto_close_after_months: 1, closed_months: ['2026-07'], reopened_months: [] });
    expect(root().querySelector('.review-closed-badge').textContent).toContain(t('review.closedBadge'));
  });
});

afterEach(() => vi.restoreAllMocks());
