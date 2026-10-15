// @vitest-environment jsdom
// Repair-links sheet: the write flow. Each ticked proposal stamps its
// from_budget key on the payment that settled the bill, as one per-row
// transaction.setFields command through the session (the real browser session
// over the fake state in _fakes/pageApp.js); nothing else in the ledger is
// touched. A refused write leaves state as it was. Drives the real
// js/repair-links.js against the real engine; the session's writeBatch is the
// storage boundary and what it receives is asserted.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../js/app.js', async () => (await import('./_fakes/pageApp.js')).appStub);

import { openRepairLinksSheet, scanUnlinkedPayments } from '../js/repair-links.js';
import { t } from '../js/ui/i18n.js';
import {
  state, writeBatch, session, FIXED_NOW, resetState, mountHosts, flush,
  sheetIsOpen, topOverlay, toastTexts,
} from './_fakes/pageApp.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const every = () => Object.fromEntries(MONTHS.map(m => [m, true]));

const sheet = () => topOverlay()?.querySelector('.sheet') ?? null;
const button = (label) => [...sheet().querySelectorAll('button')].find(b => b.textContent === label);
const boxes = () => [...sheet().querySelectorAll('label > input[type="checkbox"]')];
const proposalBoxes = () => boxes().filter(b => b.style.marginTop === '2px');
const selectAll = () => boxes().find(b => !proposalBoxes().includes(b));
// What the session wrote: the transactions file of its last writeBatch.
const written = () => writeBatch.mock.calls.at(-1)?.[1].find(f => f.filename === 'transactions.json')?.data;
// What the session stamps on a row it changes: its injected clock, not wall time.
const AT = FIXED_NOW.toISOString();
// Failure toasts are announced assertively (role=alert).
const alertTexts = () => [...document.querySelectorAll('#toast-host .toast[role="alert"]')].map(el => el.textContent);
const click = async (el) => { el.click(); await flush(); };

const bill = (id, envelope_id, amount, day) => ({
  id, kind: 'expense', envelope_id, description: id === 'rent' ? 'Rent' : 'Internet',
  default_amount: -amount, extra_buffer: 0, include: true, monthly_schedule: every(),
  as_schedule: true, account_id: 'chk', payment_day: day, schedule_day_type: 'exact', as_schedule_since: '2026-09-01',
});

let rentPay, netPay, unrelated;

beforeEach(() => {
  // Deliberately differ from the session clock: discovery must use FIXED_NOW.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 8, 28, 12, 0, 0));
  vi.stubGlobal('requestAnimationFrame', (cb) => setTimeout(cb, 0));
  vi.spyOn(console, 'error').mockImplementation(() => {});
  rentPay = { id: 'p-rent', type: 'expense', date: '2026-09-01', payee: 'Landlord', amount: 800, envelope_id: 'rent', account: 'chk', status: 'posted' };
  netPay = { id: 'p-net', type: 'expense', date: '2026-09-11', payee: 'Telco', amount: 25, envelope_id: 'fun', account: 'chk', status: 'posted' };
  unrelated = { id: 'p-other', type: 'expense', date: '2026-09-10', payee: 'Cafe', amount: 4.5, envelope_id: 'food', account: 'chk', status: 'posted' };
  resetState({ transactions: [rentPay, netPay, unrelated] });
  state.budgetItems = [bill('rent', 'rent', 800, 1), bill('net', 'fun', 25, 10)];
  mountHosts();
});

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('repair links: proposals', () => {
  it('lists each unlinked payment beside its bill, oldest due first, all ticked', async () => {
    openRepairLinksSheet();
    await flush();
    expect(sheet().textContent).toContain(t('repairLinks.found')(2));
    expect(proposalBoxes()).toHaveLength(2);
    expect(proposalBoxes().every(b => b.checked)).toBe(true);
    expect(selectAll().checked).toBe(true);
    const text = sheet().textContent;
    expect(text.indexOf('Rent')).toBeLessThan(text.indexOf('Internet'));
    expect(text).toContain('Landlord');
    expect(text).toContain('Telco');
    // Opening the sheet writes nothing.
    expect(writeBatch).not.toHaveBeenCalled();
  });

  it('scoped to an envelope, only that envelope\'s bill is offered', async () => {
    openRepairLinksSheet({ envelopeId: 'fun' });
    await flush();
    expect(proposalBoxes()).toHaveLength(1);
    await click(button(t('repairLinks.apply')));
    expect(written().find(x => x.id === 'p-net').from_budget).toBe('net:2026-09');
    expect(written().find(x => x.id === 'p-rent').from_budget).toBeUndefined();
  });

  it('with nothing to link it says so and offers no apply button', async () => {
    state.transactions = [unrelated];
    openRepairLinksSheet();
    await flush();
    expect(sheet().textContent).toContain(t('repairLinks.none'));
    expect(button(t('repairLinks.apply'))).toBeUndefined();
    await click(button(t('common.close')));
    expect(sheetIsOpen()).toBe(false);
    expect(writeBatch).not.toHaveBeenCalled();
  });

  it('a payment that could settle two bills is left alone', async () => {
    // A second Rent-sized bill in the same envelope makes the pairing ambiguous.
    state.budgetItems = [bill('rent', 'rent', 800, 1), bill('rent2', 'rent', 800, 2)];
    state.transactions = [rentPay];
    openRepairLinksSheet();
    await flush();
    expect(sheet().textContent).toContain(t('repairLinks.none'));
  });
});

describe('repair links: applying', () => {
  it('apply stamps from_budget on each chosen payment, through one command, and touches nothing else', async () => {
    const onAfterChange = vi.fn();
    const before = state.transactions;
    const dispatch = vi.spyOn(session, 'dispatch');
    openRepairLinksSheet({ onAfterChange });
    await flush();
    await click(button(t('repairLinks.apply')));

    // One command means the ledger is checked once, not once per repair.
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0].slice(0, 2)).toEqual(['transaction.setFields', { rows: [
      { id: 'p-rent', fromBudget: 'rent:2026-09' },
      { id: 'p-net', fromBudget: 'net:2026-09' },
    ] }]);
    expect(writeBatch).toHaveBeenCalledTimes(1);
    expect(writeBatch.mock.calls[0][0]).toBe(state.budgetFolder);
    // The key is stamped with the session's clock; nothing else changes.
    expect(written()).toEqual([
      { ...rentPay, from_budget: 'rent:2026-09', modified_at: AT },
      { ...netPay, from_budget: 'net:2026-09', modified_at: AT },
      unrelated,
    ]);
    expect(written()[2]).toBe(unrelated);
    expect(state.transactions).toBe(written());
    // The old array is not mutated in place.
    expect(before[0].from_budget).toBeUndefined();
    expect(toastTexts()).toContain(t('repairLinks.applied')(2));
    expect(onAfterChange).toHaveBeenCalledTimes(1);
    expect(sheetIsOpen()).toBe(false);
  });

  it('an unticked proposal is not linked', async () => {
    openRepairLinksSheet();
    await flush();
    // Untick Rent (the first row).
    proposalBoxes()[0].checked = false;
    proposalBoxes()[0].dispatchEvent(new Event('change', { bubbles: true }));
    expect(selectAll().checked).toBe(false);
    await click(button(t('repairLinks.apply')));
    expect(written().find(x => x.id === 'p-rent').from_budget).toBeUndefined();
    expect(written().find(x => x.id === 'p-net').from_budget).toBe('net:2026-09');
    expect(toastTexts()).toContain(t('repairLinks.applied')(1));
  });

  it('select-all toggles every row; none selected writes nothing and keeps the sheet', async () => {
    const onAfterChange = vi.fn();
    openRepairLinksSheet({ onAfterChange });
    await flush();
    selectAll().checked = false;
    selectAll().dispatchEvent(new Event('change', { bubbles: true }));
    expect(proposalBoxes().every(b => !b.checked)).toBe(true);
    await click(button(t('repairLinks.apply')));
    expect(writeBatch).not.toHaveBeenCalled();
    expect(toastTexts()).toContain(t('repairLinks.noneSelected'));
    expect(sheetIsOpen()).toBe(true);
    expect(onAfterChange).not.toHaveBeenCalled();

    // And ticking the master again re-selects all.
    selectAll().checked = true;
    selectAll().dispatchEvent(new Event('change', { bubbles: true }));
    expect(proposalBoxes().every(b => b.checked)).toBe(true);
  });

  it('a second click while the write is in flight does not dispatch twice', async () => {
    let release;
    writeBatch.mockImplementationOnce(() => new Promise(res => { release = res; }));
    const dispatch = vi.spyOn(session, 'dispatch');
    openRepairLinksSheet();
    await flush();
    const apply = button(t('repairLinks.apply'));
    apply.click();
    apply.click();
    await flush();
    expect(apply.disabled).toBe(true);
    release();
    await flush();
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(writeBatch).toHaveBeenCalledTimes(1);
    expect(toastTexts().filter(m => m === t('repairLinks.applied')(2))).toHaveLength(1);
  });
});

describe('repair links: a refused write', () => {
  it('leaves state untouched, says so, keeps the sheet open and lets the user retry', async () => {
    const before = state.transactions;
    const onAfterChange = vi.fn();
    writeBatch.mockRejectedValueOnce(new Error('disk full'));

    openRepairLinksSheet({ onAfterChange });
    await flush();
    const apply = button(t('repairLinks.apply'));
    await click(apply);

    // Nothing was published: the session writes first.
    expect(state.transactions).toBe(before);
    expect(state.transactions.every(tx => tx.from_budget === undefined)).toBe(true);
    expect(alertTexts()).toContain(t('repairLinks.applyFailed'));
    expect(toastTexts()).not.toContain(t('repairLinks.applied')(2));
    // The refusal is logged, as every failed write always was.
    expect(console.error).toHaveBeenCalledWith('repair-links save failed:', expect.objectContaining({ code: 'write_failed' }));
    expect(onAfterChange).not.toHaveBeenCalled();
    expect(sheetIsOpen()).toBe(true);
    expect(apply.disabled).toBe(false);

    // Retry succeeds.
    await click(apply);
    expect(writeBatch).toHaveBeenCalledTimes(2);
    expect(state.transactions.filter(tx => tx.from_budget)).toHaveLength(2);
    expect(onAfterChange).toHaveBeenCalledTimes(1);
    expect(sheetIsOpen()).toBe(false);
  });

  it('a version conflict shows the reload dialog instead of the toast, and leaves state untouched', async () => {
    const before = state.transactions;
    writeBatch.mockRejectedValueOnce(Object.assign(new Error('conflict'), { status: 409 }));
    openRepairLinksSheet();
    await flush();
    const apply = button(t('repairLinks.apply'));
    await click(apply);
    expect(state.transactions).toBe(before);
    expect(document.querySelector('#sheet-host').textContent).toContain(t('saveError.versionConflictTitle'));
    expect(toastTexts()).not.toContain(t('repairLinks.applyFailed'));
    expect(apply.disabled).toBe(false);
  });
});

it('reads the same candidate set through the session query as other surfaces', () => {
  const query = vi.spyOn(session, 'query');
  const candidates = scanUnlinkedPayments();
  expect(query).toHaveBeenCalledWith('transactions.unlinked', {});
  expect(candidates).toEqual(session.query('transactions.unlinked', {}).value.proposals);
  expect(writeBatch).not.toHaveBeenCalled();
});
