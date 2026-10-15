// js/ui/save-error.js — shared handling for cloud-save version conflicts.
//
// The cloud backend uses optimistic concurrency: every write sends the local
// `version` of the budget, and the server returns HTTP 409 if its version is
// ahead (because another browser tab or device wrote in the meantime). Once
// a 409 happens, `state.budgetFolder.version` is stale and every subsequent
// save in the same session keeps failing until the page reloads — see the
// comment in `js/storage/api-adapter.js` near the putCollection catch.
//
// The user-facing "Save failed: version conflict" toast doesn't explain any
// of that. This helper detects the 409 and replaces it with a dialog that
// offers a Reload button so the user can recover.
//
// Callers wrap their existing save-error handling:
//   catch (err) {
//     if (isVersionConflict(err)) { showVersionConflictDialog(); return; }
//     toast(`Save failed: ${err.message}`);
//   }

import { confirmDialog } from './dialog.js';
import { t } from './i18n.js';
import { toast } from './toast.js';
import { StaleBudgetError, BudgetLoadingError } from '../state/meta-queue.js';
import { describeError } from '../core/errors.js';

export function isVersionConflict(err) {
  return !!err && err.status === 409;
}

let dialogOpen = false;

export async function showVersionConflictDialog() {
  if (dialogOpen) return;
  dialogOpen = true;
  try {
    const choice = await confirmDialog(t('saveError.versionConflictBody'), {
      title: t('saveError.versionConflictTitle'),
      okLabel: t('saveError.reload'),
      cancelLabel: t('saveError.dismiss'),
    });
    if (choice) location.reload();
  } finally {
    dialogOpen = false;
  }
}

/**
 * The user-visible half of a failed write through the shared meta queue
 * (js/state/meta-writes.js). A StaleBudgetError means the user switched
 * budgets before the write ran: the change belonged to a budget that is no
 * longer open, so there is nothing to tell them. A version conflict gets the
 * reload dialog; anything else a toast, so a failed save is never only a line
 * in the console.
 *
 * @param {unknown} err
 * @param {string} context  console label naming the write that failed
 */
export function reportSaveError(err, context) {
  if (err instanceof StaleBudgetError) return;
  if (err instanceof BudgetLoadingError) { reportDispatchFailure(err); return; }
  console.error(`${context}:`, err);
  if (isVersionConflict(err)) { showVersionConflictDialog(); return; }
  const msg = err instanceof Error ? err.message : String(err);
  toast(t('common.saveFailed')(msg), { assertive: true });
}

// Refusals that say nothing: the change belonged to a budget that is no longer
// open (or none is), as the old meta writers were silent on a StaleBudgetError.
const SILENT_CODES = new Set(['budget_switched', 'no_budget']);

/**
 * Refusals reportDispatchFailure handles itself whatever the caller's own
 * wording: the reload dialog for a version conflict, silence for a budget
 * switch (or no budget), and its own text for a write refused while the budget
 * loads (budget_loading). A caller with its own failure text sends these here.
 */
export const SHARED_REPORT_CODES = new Set([...SILENT_CODES, 'version_conflict', 'budget_loading']);

/**
 * Tell the user a session command did not go through: a version conflict gets
 * the reload dialog, a budget switch (or no budget) nothing, any other refusal
 * a toast naming the reason.
 * @param {{ code: string, params?: Record<string, any> }} error
 */
export function reportDispatchFailure(error) {
  if (SILENT_CODES.has(error.code)) return;
  if (error.code === 'version_conflict') { showVersionConflictDialog(); return; }
  // Its text already says it was not saved, and why.
  if (['budget_loading', 'write_failed'].includes(error.code)) { toast(describeError(error, t), { assertive: true }); return; }
  toast(t('common.saveFailed')(describeError(error, t)), { assertive: true });
}

/**
 * How a dispatch helper reports a failure.
 * @typedef {object} ReportOptions
 * @property {string} [failKey]  an i18n key whose text replaces the generic
 *   save-failed toast, for callers whose own wording for "that did not work"
 *   is clearer. A version conflict still gets the reload dialog and a budget
 *   switch still says nothing.
 * @property {boolean} [assertive]  announce the failKey toast assertively
 *   (as the generic save-failed toast is). Only meaningful with `failKey`.
 * @property {string} [logAs]  a console label: a refusal is logged under it
 *   too (`console.error(label + ':', error)`), not only a throw.
 */

/**
 * Dispatch one command through the browser session. Returns the ok result, or
 * null after telling the user why not (a refusal, or a throw such as a write
 * the browser session does not allow). An ok result whose best-effort
 * change-log append failed (`metaFailed`: the rows saved, the change-log
 * entry did not) is still returned, after a toast saying so.
 * @param {{ dispatch: (name: string, input: Record<string, any>, opts?: { dryRun?: boolean }) => Promise<any> }} session
 * @param {string} name
 * @param {Record<string, any>} input
 * @param {{ dryRun?: boolean }} [opts]
 * @param {ReportOptions} [report]
 */
export function dispatchOrReport(session, name, input, opts, report) {
  return runOrReport(() => session.dispatch(name, input, opts), report);
}

/**
 * dispatchOrReport for a batch: the steps run in order as one change
 * (session.dispatchBatch), reported the same way.
 * @param {{ dispatchBatch: (steps: { name: string, input: Record<string, any> }[], opts?: { dryRun?: boolean }) => Promise<any> }} session
 * @param {{ name: string, input: Record<string, any> }[]} steps
 * @param {{ dryRun?: boolean }} [opts]
 * @param {ReportOptions} [report]
 */
export function dispatchBatchOrReport(session, steps, opts, report) {
  return runOrReport(() => session.dispatchBatch(steps, opts), report);
}

/**
 * The one reporting ladder behind the dispatch helpers.
 * @param {() => Promise<any>} run
 * @param {ReportOptions} [report]
 */
async function runOrReport(run, { failKey, assertive, logAs } = {}) {
  let r;
  try {
    r = await run();
  } catch (err) {
    if (logAs) console.error(`${logAs}:`, err);
    else console.error(err);
    if (failKey) toast(t(failKey), assertive ? { assertive: true } : undefined);
    else toast(t('common.saveFailed')(err?.message || err), { assertive: true });
    return null;
  }
  if (!r.ok) {
    if (logAs) console.error(`${logAs}:`, r.error);
    const custom = failKey && !SHARED_REPORT_CODES.has(r.error.code);
    if (custom) toast(t(failKey), assertive ? { assertive: true } : undefined);
    else reportDispatchFailure(r.error);
    return null;
  }
  reportMetaFailure(r);
  return r;
}

/**
 * Toast when an ok session result's best-effort change-log append failed
 * (`metaFailed`: the rows saved, the change-log entry did not). A meta-primary
 * command never sets it: its meta lands with the rows or not at all. For
 * callers that dispatch directly instead of through dispatchOrReport.
 * @param {{ ok: boolean, value?: { metaFailed?: { message: string } } }} r
 */
export function reportMetaFailure(r) {
  if (r?.ok && r.value?.metaFailed) toast(t('common.metaSaveFailed')(r.value.metaFailed.message), { assertive: true });
}
