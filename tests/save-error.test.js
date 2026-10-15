// tests/save-error.test.js — sanity for the 409-detection helper that gates
// the "budget changed elsewhere" dialog. The dialog itself is browser glue
// (openSheet + location.reload) and is exercised manually, not here.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const toasts = vi.hoisted(() => []);
const toastOpts = vi.hoisted(() => []);
vi.mock('../js/ui/toast.js', () => ({ toast: (msg, opts) => { toasts.push(msg); toastOpts.push(opts); } }));
// The reload dialog, recorded instead of rendered; it resolves as "Dismiss".
const dialogs = vi.hoisted(() => []);
vi.mock('../js/ui/dialog.js', () => ({ confirmDialog: async (msg) => { dialogs.push(msg); return false; } }));

import * as saveError from '../js/ui/save-error.js';
import { isVersionConflict, dispatchOrReport, dispatchBatchOrReport, reportDispatchFailure } from '../js/ui/save-error.js';
import { t } from '../js/ui/i18n.js';

describe('isVersionConflict', () => {
  it('returns true for the 409 thrown by api-adapter', () => {
    const err = Object.assign(new Error('version conflict'), {
      status: 409,
      body: { error: 'version conflict', current: 9 },
    });
    expect(isVersionConflict(err)).toBe(true);
  });

  it('returns false for other HTTP failures', () => {
    expect(isVersionConflict(Object.assign(new Error('boom'), { status: 500 }))).toBe(false);
    expect(isVersionConflict(Object.assign(new Error('nope'), { status: 404 }))).toBe(false);
  });

  it('returns false for non-HTTP errors', () => {
    expect(isVersionConflict(new TypeError('Failed to fetch'))).toBe(false);
    expect(isVersionConflict(new Error('plain'))).toBe(false);
  });

  it('handles missing / nullish inputs', () => {
    expect(isVersionConflict(null)).toBe(false);
    expect(isVersionConflict(undefined)).toBe(false);
    expect(isVersionConflict(0)).toBe(false);
  });
});

describe('dispatchOrReport', () => {
  beforeEach(() => { toasts.length = 0; vi.spyOn(console, 'error').mockImplementation(() => {}); });
  const sessionReturning = (r) => ({ dispatch: async () => r });

  it('returns an ok result without a toast', async () => {
    const r = { ok: true, value: { committed: true } };
    expect(await dispatchOrReport(sessionReturning(r), 'transaction.delete', { ids: ['a'] })).toBe(r);
    expect(toasts).toEqual([]);
  });

  it('returns an ok result whose meta write failed, and says so', async () => {
    const r = { ok: true, value: { committed: true, metaFailed: { message: 'disk full' } } };
    expect(await dispatchOrReport(sessionReturning(r), 'transaction.delete', { ids: ['a'] })).toBe(r);
    expect(toasts).toEqual([t('common.metaSaveFailed')('disk full')]);
  });

  it('the meta-failed toast names only the change history: a planned-row delete is atomic since 2c', () => {
    expect(t('common.metaSaveFailed')('disk full')).toBe('Saved. The change history could not be written (disk full).');
  });

  it('returns null and toasts the reason for a refusal or a throw', async () => {
    expect(await dispatchOrReport(sessionReturning({ ok: false, error: { code: 'tx_not_found', params: { id: 'x' } } }), 'transaction.delete', { ids: ['x'] })).toBeNull();
    const throwing = { dispatch: async () => { throw new TypeError('not writable'); } };
    expect(await dispatchOrReport(throwing, 'transaction.delete', { ids: ['x'] })).toBeNull();
    expect(toasts).toHaveLength(2);
    expect(toasts[1]).toBe(t('common.saveFailed')('not writable'));
  });
});

describe('dispatchBatchOrReport', () => {
  beforeEach(() => { toasts.length = 0; vi.spyOn(console, 'error').mockImplementation(() => {}); });
  const steps = [{ name: 'transaction.delete', input: { ids: ['a'] } }];

  it('hands the steps and options to dispatchBatch and returns an ok result', async () => {
    const r = { ok: true, value: { committed: true } };
    const dispatchBatch = vi.fn(async () => r);
    expect(await dispatchBatchOrReport({ dispatchBatch }, steps, { dryRun: true })).toBe(r);
    expect(dispatchBatch).toHaveBeenCalledWith(steps, { dryRun: true });
    expect(toasts).toEqual([]);
  });

  it('reports a meta failure, a refusal and a throw as dispatchOrReport does', async () => {
    const metaFailed = { ok: true, value: { metaFailed: { message: 'disk full' } } };
    expect(await dispatchBatchOrReport({ dispatchBatch: async () => metaFailed }, steps)).toBe(metaFailed);
    expect(await dispatchBatchOrReport({ dispatchBatch: async () => ({ ok: false, error: { code: 'tx_not_found', params: { id: 'x' } } }) }, steps)).toBeNull();
    expect(await dispatchBatchOrReport({ dispatchBatch: async () => { throw new TypeError('not writable'); } }, steps)).toBeNull();
    expect(toasts).toHaveLength(3);
    expect(toasts[0]).toBe(t('common.metaSaveFailed')('disk full'));
    expect(toasts[2]).toBe(t('common.saveFailed')('not writable'));
  });
});

describe('one ladder: silent outcomes and a custom toast key', () => {
  beforeEach(() => { toasts.length = 0; dialogs.length = 0; vi.spyOn(console, 'error').mockImplementation(() => {}); });
  const refused = (code) => ({ dispatch: async () => ({ ok: false, error: { code, params: {} } }) });

  it.each(['budget_switched', 'no_budget'])('%s says nothing: the change belonged to a budget no longer open', async (code) => {
    expect(await dispatchOrReport(refused(code), 'investment.setPrice', {})).toBeNull();
    expect(await dispatchBatchOrReport({ dispatchBatch: refused(code).dispatch }, [])).toBeNull();
    reportDispatchFailure({ code, params: {} });
    expect(toasts).toEqual([]);
    expect(dialogs).toEqual([]);
  });

  it('budget_loading says why, whatever the caller\'s own wording: the write was refused while the budget loads', async () => {
    reportDispatchFailure({ code: 'budget_loading', params: {} });
    expect(await dispatchOrReport(refused('budget_loading'), 'month.close', {}, undefined, { failKey: 'review.closeFailed' })).toBeNull();
    expect(toasts).toEqual([t('coreError.budgetLoading'), t('coreError.budgetLoading')]);
    expect(t('coreError.budgetLoading')).toBe('Not saved: the budget is still loading or being set up');
    expect(dialogs).toEqual([]);
  });

  it('a custom toast key replaces the generic save-failed toast for a refusal and a throw', async () => {
    const report = { failKey: 'review.closeFailed' };
    expect(await dispatchOrReport(refused('bad_input'), 'month.close', { month: '2026-09' }, undefined, report)).toBeNull();
    const throwing = { dispatch: async () => { throw new Error('boom'); } };
    expect(await dispatchOrReport(throwing, 'month.close', { month: '2026-09' }, undefined, report)).toBeNull();
    expect(toasts).toEqual([t('review.closeFailed'), t('review.closeFailed')]);
  });

  it('a custom toast key is assertive only when the caller asks for it', async () => {
    toastOpts.length = 0;
    const throwing = { dispatch: async () => { throw new Error('boom'); } };
    await dispatchOrReport(throwing, 'x', {}, undefined, { failKey: 'review.closeFailed' });
    await dispatchOrReport(refused('bad_input'), 'x', {}, undefined, { failKey: 'review.closeFailed' });
    expect(toastOpts).toEqual([undefined, undefined]);
    toastOpts.length = 0;
    const report = { failKey: 'review.closeFailed', assertive: true };
    await dispatchOrReport(throwing, 'x', {}, undefined, report);
    await dispatchOrReport(refused('bad_input'), 'x', {}, undefined, report);
    expect(toastOpts).toEqual([{ assertive: true }, { assertive: true }]);
  });

  it('with a custom toast key a version conflict still opens the reload dialog, and a switch stays silent', async () => {
    const report = { failKey: 'review.closeFailed' };
    expect(await dispatchOrReport(refused('version_conflict'), 'month.close', {}, undefined, report)).toBeNull();
    expect(await dispatchOrReport(refused('budget_switched'), 'month.close', {}, undefined, report)).toBeNull();
    expect(dialogs).toEqual([t('saveError.versionConflictBody')]);
    expect(toasts).toEqual([]);
  });

  it('logAs logs a refusal under its label, as a throw; without it a refusal is not logged', async () => {
    console.error.mockClear();
    await dispatchOrReport(refused('bad_input'), 'x', {});
    expect(console.error).not.toHaveBeenCalled();
    const report = { failKey: 'review.closeFailed', logAs: 'month close failed' };
    await dispatchOrReport(refused('bad_input'), 'x', {}, undefined, report);
    expect(console.error).toHaveBeenCalledWith('month close failed:', { code: 'bad_input', params: {} });
    const err = new Error('boom');
    await dispatchOrReport({ dispatch: async () => { throw err; } }, 'x', {}, undefined, report);
    expect(console.error).toHaveBeenLastCalledWith('month close failed:', err);
  });

  it('SHARED_REPORT_CODES names the refusals the shared reporter keeps whatever the failKey', () => {
    expect([...saveError.SHARED_REPORT_CODES].sort()).toEqual(['budget_loading', 'budget_switched', 'no_budget', 'version_conflict']);
  });

  it('dispatches with the caller\'s own arguments only', async () => {
    const dispatch = vi.fn(async () => ({ ok: true, value: {} }));
    await dispatchOrReport({ dispatch }, 'month.reopen', { month: '2026-09' }, undefined, { failKey: 'review.closeFailed' });
    expect(dispatch).toHaveBeenCalledWith('month.reopen', { month: '2026-09' }, undefined);
  });

  it('dispatchOrToast is gone: dispatchOrReport is the one ladder', () => {
    expect('dispatchOrToast' in saveError).toBe(false);
  });
});


it('reports a held metadata write with the localized loading refusal', async () => {
  const { BudgetLoadingError } = await import('../js/state/meta-queue.js');
  toasts.length = 0;
  saveError.reportSaveError(new BudgetLoadingError(), 'metadata');
  reportDispatchFailure({ code: 'budget_loading' });
  expect(toasts).toHaveLength(2);
  expect(toasts[0]).toBe(toasts[1]);
});

it('says Save failed once for a session write failure', () => {
  toasts.length = 0;
  reportDispatchFailure({ code: 'write_failed', params: { message: 'disk full' } });
  expect(toasts).toEqual([t('common.saveFailed')('disk full')]);
});
