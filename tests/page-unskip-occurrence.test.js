// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
vi.mock('../js/app.js', async () => (await import('./_fakes/pageApp.js')).appStub);
import { openBudgetItemEditor } from '../js/pages/budget-plan-editor.js';
import { requestCloseTopSheet } from '../js/ui/sheet.js';
import { setItemFields, flushItems } from '../js/ui/plan-item-live.js';
import { beginBudgetSession } from '../js/state/budget-session.js';
import { state, session, writeBatch, runDueScheduled, resetState, mountHosts, flush, setValue } from './_fakes/pageApp.js';
const top = () => [...document.querySelectorAll('[data-sheet-open]')].at(-1);
const restore = month => top().querySelector(`.skipped-occurrences button[data-month="${month}"]`);
let host, rerender;
const open = () => openBudgetItemEditor(host, 0, { rerenderTable: rerender });
beforeEach(() => {
  beginBudgetSession(); resetState(); mountHosts();
  vi.stubGlobal('requestAnimationFrame', cb => setTimeout(cb, 0));
  state.budgetItems = [{ id: 'bill', kind: 'expense', envelope_id: 'food', description: 'Bill', default_amount: -20,
    include: true, extra_buffer: 0, monthly_schedule: { Sep: true, Oct: true }, payment_day: 5,
    as_schedule: true, account_id: 'chk', as_schedule_since: '2026-01-01', schedule_day_type: 'exact',
    skipped_occurrences: ['2026-09', '2026-10'] }];
  host = document.getElementById('app-root'); rerender = vi.fn();
});
afterEach(async () => { await flushItems(); vi.restoreAllMocks(); });

describe('restore skipped occurrences', () => {
  it('flushes live edits, restores only the selected month once, and preserves form edits without posting', async () => {
    open();
    const description = top().querySelector('#bp-f-description');
    expect(description).toBeTruthy(); setValue(description, 'Unsaved title');
    setItemFields('bill', { extra_buffer: 7 });
    const dispatch = vi.spyOn(session, 'dispatch');
    const btn = restore('2026-09'); btn.click(); btn.click(); await flushItems(); await flush();
    expect(dispatch.mock.calls.filter(c => c[0] === 'budgetItem.unskipOccurrence')).toHaveLength(1);
    expect(state.budgetItems[0]).toMatchObject({ description: 'Bill', extra_buffer: 7, skipped_occurrences: ['2026-10'] });
    expect(description.value).toBe('Unsaved title');
    expect(restore('2026-09')).toBeNull();
    expect(state.transactions).toEqual([]);
    expect(runDueScheduled).not.toHaveBeenCalled();
    const closing = requestCloseTopSheet(); await flush();
    top().querySelector('.btn-accent').click(); await closing;
    await new Promise(resolve => setTimeout(resolve, 250));
    open(); expect(restore('2026-09')).toBeNull(); expect(restore('2026-10')).toBeTruthy();
  });
  it('keeps the month on write failure and allows retry', async () => {
    open(); writeBatch.mockRejectedValueOnce(new Error('offline'));
    restore('2026-09').click(); await flush();
    expect(state.budgetItems[0].skipped_occurrences).toContain('2026-09');
    expect(restore('2026-09').disabled).toBe(false);
    restore('2026-09').click(); await flush();
    expect(state.budgetItems[0].skipped_occurrences).not.toContain('2026-09');
  });
  it('does not restore through an editor belonging to the previous budget', async () => {
    open(); beginBudgetSession(); restore('2026-09').click(); await flush();
    expect(writeBatch).not.toHaveBeenCalled();
  });
  it('rechecks the budget after waiting for queued edits', async () => {
    open(); let release;
    writeBatch.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    setItemFields('bill', { extra_buffer: 8 }); restore('2026-09').click();
    await new Promise(resolve => setTimeout(resolve, 0));
    beginBudgetSession(); release(); await flush();
    expect(state.budgetItems[0].skipped_occurrences).toContain('2026-09');
    expect(writeBatch).toHaveBeenCalledTimes(1);
  });
});
