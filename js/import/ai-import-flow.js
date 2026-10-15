import { createImportRuleReview, importRuleApprovalError } from './rule-review.js';
// js/import/ai-import-flow.js — the AI half of the import sheet: read a
// document, categorize the rows, and hand the result to the shared review UI.
//
// Split out of import-sheet.js deliberately. That file already carries the
// CSV column-mapping flow, and the two only meet at one point: a list of
// `{date, payee, amount}` rows. Keeping them apart means neither has to know
// how the other produced them. Both record what is approved through
// recordImportRows below.

import { t } from '../ui/i18n.js';
import { matchCsvRows } from './csv-parse-generic.js';
import { getPayeeAliases } from '../core/payee-fields.js';
import { rowsNeedingCategorization, buildImportProposal } from './build-proposal.js';
import { categorizeRows } from '../ai/categorize.js';
import { parseFileWithAi } from './ai-parse.js';
import { renderProposalReview } from '../ui/proposal-review.js';
import { proposalToRecordSteps } from '../ai/proposal.js';
import { describeError } from '../core/errors.js';
import { showVersionConflictDialog, reportMetaFailure } from '../ui/save-error.js';

/**
 * Record imported rows through the session as one transaction.import, for the
 * import flows, which report a failure inline rather than in a toast: a
 * refusal is thrown as an Error carrying the described reason (and the
 * refusal's `code`), for the caller's catch to show (a version conflict also
 * opens the reload dialog first). A
 * budget switch, or no budget open, says nothing and returns null: the rows
 * belonged to a budget that is no longer open. That includes a switch after
 * the write landed (`published` false, as the loader checks): the rows are on
 * that budget's disk, but nothing here may toast or repaint for it.
 *
 * @param {{ dispatch: (name: string, input: Record<string, any>) => Promise<any> }} session
 * @param {object[]} rows  transaction.record inputs
 * @returns {Promise<object[]|null>} the recorded rows ([] for none), or null
 */
export async function recordImportRows(session, rows, { expectedImportContext, expectedStatement } = {}) {
  if (!rows.length) return [];
  const r = await session.dispatch('transaction.import', { rows, ...(expectedImportContext !== undefined ? { expectedImportContext } : {}), ...(expectedStatement ? { expectedStatement } : {}) });
  if (r.ok) {
    if (r.value.published !== true) return null;
    reportMetaFailure(r);
    return r.value.value.rows;
  }
  if (r.error.code === 'budget_switched' || r.error.code === 'no_budget') return null;
  if (r.error.code === 'version_conflict') showVersionConflictDialog();
  throw Object.assign(new Error(describeError(r.error, t)), { code: r.error.code });
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/**
 * A progress panel with a named stage. Reading a statement takes ten or
 * twenty seconds; a sheet that simply freezes for that long reads as broken,
 * and "working…" does not tell the user whether it is nearly done.
 *
 * @param {HTMLElement} host
 * @param {() => void} onCancel
 */
export function renderImportProgress(host, onCancel, setHeaderActions = null) {
  host.replaceChildren();

  const panel = el('div', 'import-progress');
  const spinner = el('div', 'import-progress-spinner');
  panel.append(spinner);

  const stage = el('div', 'import-progress-stage', t('txImport.ai.stageReading'));
  panel.append(stage);

  const detail = el('div', 'import-progress-detail', '');
  panel.append(detail);

  const bar = el('div', 'import-progress-bar');
  const fill = el('div', 'import-progress-fill');
  bar.append(fill);
  bar.style.visibility = 'hidden';
  panel.append(bar);

  if (onCancel) {
    const cancel = el('button', 'btn btn-ghost', t('txImport.cancel'));
    cancel.type = 'button';
    if (!setHeaderActions) cancel.style.marginTop = '18px';
    cancel.addEventListener('click', onCancel);
    if (setHeaderActions) setHeaderActions(cancel);
    else panel.append(cancel);
  }

  host.append(panel);

  return {
    setStage(text, detailText) {
      stage.textContent = text;
      detail.textContent = detailText || '';
    },
    setProgress(done, total) {
      if (!total || total <= 0) { bar.style.visibility = 'hidden'; return; }
      bar.style.visibility = 'visible';
      fill.style.width = `${Math.round((done / total) * 100)}%`;
      detail.textContent = t('txImport.ai.rowsDone')
        ? t('txImport.ai.rowsDone')(done, total)
        : `${done} / ${total}`;
    },
  };
}

/**
 * Read a picked document into importer rows, showing progress.
 *
 * @param {object} opts
 * @param {() => Date} opts.clock
 * @param {File} opts.file
 * @param {HTMLElement} opts.host
 * @param {object} opts.state
 * @param {AbortSignal=} opts.signal
 * @param {() => void=} opts.onCancel
 */
export async function readDocument({ file, host, state, clock, signal, onCancel, setHeaderActions }) {
  const progress = renderImportProgress(host, onCancel, setHeaderActions);
  progress.setStage(t('txImport.ai.stageReading'), file.name);
  const result = await parseFileWithAi(file, { state, clock, signal });
  return result;
}

/**
 * Categorize rows and render the review.
 *
 * @param {object} opts
 * @param {HTMLElement} opts.host
 * @param {object} opts.state
 * @param {Array} opts.rows                {date, payee, amount}
 * @param {string|null} opts.accountId
 * @param {number|null=} opts.declaredTotal
 * @param {string=} opts.source
 * @param {number=} opts.skipped
 * @param {() => Date} opts.clock  the app's `now`, for the categorizer's prompt
 * @param {AbortSignal=} opts.signal
 * @param {(rows: Array, proposal: object) => Promise<void>} opts.onApprove
 *   receives the approved rows as transaction.record inputs; a throw shows
 *   its message in the review and re-enables it
 * @param {() => void} opts.onBack
 * @param {() => void=} opts.onCancel
 */
export async function runAiImportPhase({
  host, state, rows, accountId, declaredTotal = null,
  source = 'csv', skipped = 0, clock, signal, onApprove, onBack, onCancel, setHeaderActions, importSession,
}) {
  const progress = renderImportProgress(host, onCancel, setHeaderActions);

  const matched = matchCsvRows(rows, state.transactions || [], { accountId: accountId || null, aliases: getPayeeAliases(state.meta) })
    .map(r => r.csvRow.importReviewed ? { ...r, matchType: 'none', match: null } : r);
  const needing = rowsNeedingCategorization(matched);

  let categorized = [];
  if (needing.length) {
    progress.setStage(t('txImport.ai.stageCategorizing'));
    progress.setProgress(0, needing.length);
    categorized = await categorizeRows(needing, {
      state,
      clock,
      signal,
      onProgress: (done, total) => progress.setProgress(done, total),
    });
  }

  const proposal = buildImportProposal({
    matched, needing, categorized, state,
    defaultAccountId: accountId || null,
    declaredTotal, source, skipped,
  });

  renderReview({ host, state, proposal, onApprove, onBack, onCancel, setHeaderActions, importSession });
  return proposal;
}

/**
 * Render the review with the sheet's own footer controls folded in.
 */
export function renderReview({ host, state, proposal, onApprove, onBack, onCancel, setHeaderActions, importSession }) {
  host.replaceChildren();

  const status = el('div', 'import-review-status', '');

  let rendered;
  const sync = () => {
    if (!review) return;
    const views = new Map(review.draft.view().map(r=>[r.key,r]));
    for (const row of proposal.rows) {
      const v = views.get(row.importSource.key);
      row.payee = v.values.payee;
      row.envelope_id = v.values.envelope;
    }
    review.controls.refresh(); rendered?.refreshRows();
  };
  const review = importSession && proposal.rows.every(r=>r.importSource) ? createImportRuleReview({state,session:importSession,
    rows:proposal.rows.map(r=>({...r.importSource,type:r.type,excluded:!!r.duplicateOf || !!r.excluded})),
    baselines:Object.fromEntries(proposal.rows.map(r=>[r.importSource.key,{payee:r.payee,envelope:r.envelope_id}])),onChanged:sync,
  }) : null;
  sync();
  const importReview = review ? {
    onFieldEdit:(key,field,value)=>{ review.draft.edit(key,field,value); sync(); },
    onExcluded:(key,value)=>{ review.draft.setExcluded(key,value); sync(); },
    renderRow:key=>review.controls.renderRow(key),
    canApprove:()=>review.draft.summary().unresolved===0,
  } : null;
  rendered = renderProposalReview({
    proposal,
    state,
    importReview,
    onDiscard: () => (onBack ? onBack() : onCancel && onCancel()),
    onApprove: async (edited) => {
      const buttons = [...root.querySelectorAll('button'), ...actions.querySelectorAll('button')];
      buttons.forEach((b) => { b.disabled = true; });
      status.textContent = t('txImport.importing');
      status.classList.remove('import-review-status--error');
      try {
        const approval = review?.approval();
        if (approval && !approval.ok) { sync(); throw new Error(importRuleApprovalError(approval.reason)); }
        const approved = approval ? { ...edited, rows: edited.rows.map(row => {
          const fields = approval.fieldsByKey[row.importSource.key];
          return fields ? { ...row, payee:fields.payee, envelope_id:fields.envelope } : row;
        }) } : edited;
        const rows = proposalToRecordSteps(approved, state).map((s) => s.input);
        await onApprove(rows, edited, approval?.context);
      } catch (err) {
        if (err.code === 'import_review_changed' && review) { review.draft.refresh(state); sync(); }
        status.textContent = `${t('txImport.importError')}: ${err.message}`;
        status.classList.add('import-review-status--error');
        buttons.forEach((b) => { b.disabled = false; });
        rendered.refreshFooter();
      }
    },
  });

  const { root } = rendered;
  if (review) host.append(review.controls.root);
  host.append(root);

  const actions = root.querySelector('.proposal-actions');
  if (actions && onBack) {
    const back = el('button', 'btn btn-ghost', t('txImport.back'));
    back.type = 'button';
    actions.prepend(back);
    back.addEventListener('click', onBack);
  }
  if (actions) {
    actions.prepend(status);
    if (setHeaderActions) {
      actions.dataset.sheetActions = '';
      setHeaderActions(actions);
    }
  }
}
