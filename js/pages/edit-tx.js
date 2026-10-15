import { transactionNote } from '../ui/transaction-note.js';
import { setupFormValidation, markRequired, fieldError } from '../ui/form-validation.js';
import { describeError } from '../core/errors.js';
import { openTransactionReversal } from '../ui/transaction-reversal.js';
import { currentBudgetSession } from '../state/budget-session.js';
// js/pages/edit-tx.js
import { state, navigate, session, activeLensInput, now as appNow } from '../app.js';
import { openSheet, setSheetTitle } from '../ui/sheet.js';
import { txTypePicker } from '../ui/tx-type-picker.js';
import { trackDirty } from '../ui/dirty-guard.js';
import { guardSubmit } from '../ui/submit-guard.js';
import { attachFieldHint, setFieldHint } from '../ui/field-hint.js';
import { needsNoEnvelopeNote, noEnvelopeNote } from '../ui/unassigned.js';
import { rebalanceSplitLines, markAutoFilled } from '../ui/split-remainder.js';
import { confirmDialog, alertDialog } from '../ui/dialog.js';
import { toast } from '../ui/toast.js';
import { undoAction } from '../ui/undo-action.js';
import { reportDispatchFailure, dispatchOrReport as dispatchOrReportVia } from '../ui/save-error.js';
import { t, trEnv, fmtMonthLang, fmtDateLang } from '../ui/i18n.js';
import { infoButton } from '../ui/info-button.js';
import { allPayees, findPayeeEntry } from '../state/payee-index.js';
import { appendEnvelopeOptions, envelopeOptionsHtml } from '../ui/envelope-options.js';
import { enhanceSelectWithSearch } from '../ui/select-combobox.js';
import { escHtml, fmt, fmtNum, validateAmount, filterArchivedForSelect } from '../utils.js';
import { validateFromBudgetLink, repointFromBudgetMonth, txAbsAmount, isKnownTxType } from '../engine.js';
import { ask } from '../ui/query.js';
import { normalisePayeeKey, listKnownSymbolsWithNames } from '../state/investments.js';
import { askPayeeBackfill, savePayeeRule } from '../ui/payee-rule-backfill.js';
import { closedMonthsIn } from '../state/closed-periods.js';
import { confirmClosedEdit } from '../ui/closed-period-guard.js';
import { confirmReconciledEdit, reconciledOn } from '../ui/reconciled-guard.js';
import { budgetItemField } from '../ui/budget-item-field.js';
import { enableFormulaInput, enablePercentageInput, looksLikeFormula, looksLikePercentage, parseAmountInput } from '../ui/amount-input.js';

/**
 * Settle which scheduled occurrence a row about to be saved actually pays.
 *
 * `from_budget` is written once and never revisited, while the date beside it
 * stays editable — this sheet is the only place both move. A row re-dated far
 * from the occurrence it names is then invisible everywhere: the forecast
 * dedups the month the key claims, and skips the row when looking for the
 * payment that settled anything BECAUSE it carries a key, so the bill it
 * really pays is forecast on top of it and counted twice.
 *
 * Asking rather than correcting, because the data cannot tell the two readings
 * apart and only the person saving knows which is true: "this is the October
 * bill, I typed the date I will actually pay" and "I am paying the August bill
 * late, in October" produce byte-identical rows.
 *
 * Fires whenever the saved row would be stale, not only when the date changed
 * in this edit — which makes opening and saving an already-broken row the way
 * to repair one.
 *
 * Returns the key to persist; never aborts the save, because a wrong link is
 * worth less than a lost edit.
 */
async function resolveScheduledLink(candidate, ownId) {
  const key = typeof candidate?.from_budget === 'string' ? candidate.from_budget : '';
  if (!key) return key;
  const problems = validateFromBudgetLink(candidate);
  if (!problems.length) return key;

  const { month } = problems[0].params;
  const newMonth = String(candidate.date).slice(0, 7);
  const target = repointFromBudgetMonth(key, newMonth);
  if (!target || target === key) return key;

  // One occurrence, one transaction: relinking onto a month another row
  // already claims would trade a stale link for a duplicate one, which breaks
  // the four mechanisms that trust the key to be unique.
  const taken = (state.transactions || []).some(
    x => x && x.id !== ownId && x.from_budget === target,
  );
  if (taken) {
    await alertDialog(t('editTx.staleLinkTakenBody')(month, newMonth), {
      title: t('editTx.staleLinkTitle'),
    });
    return key;
  }

  const relink = await confirmDialog(t('editTx.staleLinkBody')(candidate.date, month, newMonth), {
    title: t('editTx.staleLinkTitle'),
    okLabel: t('editTx.staleLinkRelink')(newMonth),
    cancelLabel: t('editTx.staleLinkKeep')(month),
  });
  return relink ? target : key;
}

/** One command through the session; the ok result, or null after telling the user why not. */
const dispatchOrReport = (name, input, opts) => dispatchOrReportVia(session, name, input, opts);

const EDITABLE_TYPES = new Set(['expense', 'income', 'account_transfer', 'investment_transfer']);
const ADJUSTMENT_TYPE = 'adjustment';
const ENVELOPE_TRANSFER_TYPE = 'envelope_transfer';
const UNALLOCATED_SENTINEL = '__unallocated__';

function summaryLine(label, value) {
  const row = document.createElement('div');
  row.style.cssText = 'display:flex;justify-content:space-between;gap:12px;padding:4px 0;';
  const l = document.createElement('span'); l.className = 'muted'; l.textContent = label;
  const v = document.createElement('span'); v.textContent = value;
  row.append(l, v);
  return row;
}

/** A Date as local YYYY-MM-DD. */
function ymdLocal(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

let _fieldSeq = 0;
function field(name, label, value = '', type = 'text', { optional = false } = {}) {
  const wrap = document.createElement('div'); wrap.className = 'field';
  const id = `edittx-f-${++_fieldSeq}`;
  const lbl = document.createElement('label'); lbl.textContent = label; lbl.htmlFor = id;
  const input = document.createElement('input');
  input.type = type; input.name = name; input.value = value ?? ''; input.id = id;
  if (type === 'number') input.inputMode = 'decimal';
  wrap.append(lbl, input);
  if (!optional && (type === 'number' || type === 'date')) {
    markRequired(input);
    attachFieldHint(wrap, input);
    input.addEventListener('input', () => updateFieldHint(wrap, type));
    input.addEventListener('blur', () => updateFieldHint(wrap, type, /*forceShow*/true));
  }
  return wrap;
}

function updateFieldHint(wrap, type, forceShow = false) {
  const input = wrap.querySelector('input');
  if (!input) return;
  let msg = '';
  if (type === 'number') {
    const raw = input.value;
    if (raw !== '' || forceShow) {
      const n = validateAmount(parseAmountInput(raw, { strict: true }));
      if (n === null || (input.dataset.signed !== 'true' && !(n > 0))) msg = t('common.amountInvalid');
    }
  } else if (type === 'date') {
    if (!input.value && forceShow) msg = t('common.dateRequired');
  }
  setFieldHint(wrap, msg);
}

function selectField(label, options, value) {
  const wrap = document.createElement('div'); wrap.className = 'field';
  const lbl = document.createElement('label'); lbl.textContent = label;
  const sel = document.createElement('select');
  options.forEach(([v, text]) => {
    const o = document.createElement('option'); o.value = v; o.textContent = text;
    if (v === value) o.selected = true;
    sel.append(o);
  });
  wrap.append(lbl, sel);
  return { wrap, sel };
}

export function openEditTx(tx, opts = {}) {
  const generation = currentBudgetSession();
  const folder = state.budgetFolder;
  const isCurrent = () => currentBudgetSession() === generation && state.budgetFolder === folder;
  const onAfterChange = typeof opts.onAfterChange === 'function' ? opts.onAfterChange : null;
  const editable = EDITABLE_TYPES.has(tx.type);
  const isAdjustment = tx.type === ADJUSTMENT_TYPE;
  const isEnvTransfer = tx.type === ENVELOPE_TRANSFER_TYPE;
  const isForecast = !!tx.is_forecast;
  // A loan payment's principal, or money lent out. A forecast row of one is a
  // leg of a planned instalment, which posts on its day (or is skipped).
  const isDebtPayment = tx.type === 'debt_payment' && !isForecast;
  const canEdit = editable || isAdjustment || isEnvTransfer || isDebtPayment;
  const form = document.createElement('form');
  form.className = 'tx-editor';
  setupFormValidation(form, { required: false });

  // Soft lock: a row in a closed month (closed on Review, or by Settings →
  // "Close months automatically") says so up front; saving or deleting it
  // asks before going ahead (confirmClosedEdit). This is also where a past
  // month is reopened: the Review page only shows this month onwards.
  const lockedMonth = isForecast ? null : closedMonthsIn(state.meta, [tx.date], appNow())[0] || null;
  if (lockedMonth) {
    const lockNote = document.createElement('div');
    lockNote.className = 'muted closed-month-note';
    lockNote.style.cssText = 'margin:0 0 10px;font-size:12px;display:flex;align-items:center;gap:8px;flex-wrap:wrap;';
    const text = document.createElement('span');
    text.textContent = `🔒 ${t('closedPeriod.sheetNote')}`;
    const reopenBtn = document.createElement('button');
    reopenBtn.type = 'button';
    reopenBtn.className = 'btn btn-ghost btn-sm';
    reopenBtn.textContent = t('closedPeriod.reopen')(fmtMonthLang(lockedMonth));
    reopenBtn.addEventListener('click', async () => {
      const ok = await confirmDialog(t('review.reopenConfirm')(fmtMonthLang(lockedMonth)), {
        title: t('review.reopenMonth'),
        okLabel: t('review.reopenMonth'),
        cancelLabel: t('common.cancel'),
      });
      if (!ok) return;
      const r = await dispatchOrReportVia(session, 'month.reopen', { month: lockedMonth }, undefined, { failKey: 'review.closeFailed' });
      if (!r) return;
      lockNote.remove();
      toast(t('closedPeriod.reopened')(fmtMonthLang(lockedMonth)));
    });
    lockNote.append(text, reopenBtn);
    form.append(lockNote);
  }

  // Same soft lock for a row a bank reconciliation vouched for: say so up
  // front; a save that moves the reconciled balance asks first.
  const reconciledDate = isForecast ? null : reconciledOn(tx);
  if (reconciledDate) {
    const recNote = document.createElement('div');
    recNote.className = 'muted closed-month-note';
    recNote.style.cssText = 'margin:0 0 10px;font-size:12px;';
    recNote.textContent = `🔒 ${t('reconciledRow.sheetNote')(fmtDateLang(reconciledDate))}`;
    form.append(recNote);
  }

  // A stored scheduled row (a one-off entered ahead, or one a reconcile
  // ticked before it was posted) stays out of the Today view until posted.
  // Say so; "Post now" below posts it (transaction.post).
  const storedScheduled = !isForecast && tx.status === 'scheduled';
  if (storedScheduled) {
    const schedNote = document.createElement('div');
    schedNote.className = 'muted closed-month-note';
    schedNote.style.cssText = 'margin:0 0 10px;font-size:12px;';
    schedNote.textContent = t(tx.cleared ? 'editTx.scheduledClearedNote' : 'editTx.scheduledNote');
    form.append(schedNote);
  }

  /** @type {{ el: HTMLElement, setActive: (v: string) => void } | null} */
  let typePicker = null;
  let interestOfSel = null;
  let typeSel, envSel, acctSel, fromAcctSel, toAcctSel, incomeEnvSel, invEnvSel, invFeeInput, invDirection,
      invUnitsInput, invPriceInput, invSymbolInput;
  let payeeEl, amountEl, dateEl, noteEl;
  let splitRows, splitCount, addSplitRow, updateSplits, envWrap, itemPick;
  let adjTargetSel, adjAmountEl, adjNoteEl, adjDateEl;
  let etFromSel, etToSel, etAmountEl, etPayeeEl, etDateEl, etNoteEl;
  let dpFromSel, dpToSel, dpEnvSel, dpAmountEl, dpPayeeEl, dpDateEl, dpNoteEl;
  const lentOut = tx.type === 'debt_payment'
    && state.accounts.find(a => a.id === tx.to_account)?.type === 'loan_given';

  // Archived accounts/envelopes are hidden from the dropdowns unless the
  // matching Settings toggle is on — but anything this transaction already
  // references is always kept so it stays selectable and isn't lost on save.
  const showArchivedAccts = !!(state.meta && state.meta.show_archived_accounts);
  const showArchivedEnv   = !!(state.meta && state.meta.show_archived_envelopes);
  const keepAcctIds = [tx.account, tx.from_account, tx.to_account].filter(Boolean);
  const keepEnvIds = [
    tx.envelope_id, tx.from_envelope_id, tx.to_envelope_id,
    ...(Array.isArray(tx.envelope_splits) ? tx.envelope_splits.map(s => s && s.envelope_id) : []),
  ].filter(Boolean);
  // The picker labels' balances follow the active lens, archived rows
  // included (a row may reference one). A failed query leaves the amounts off
  // rather than showing another figure.
  const balances = ask('balances', { ...activeLensInput(), includeArchived: true });
  const acctBalMap = new Map((balances?.accounts ?? []).map(a => [a.id, a.balance]));
  const envBalMap = new Map((balances?.envelopes ?? []).map(e => [e.id, e.balance]));
  const withBalance = (name, map, id) => (balances ? `${name} — ${fmt(map.get(id) ?? 0)}` : name);
  const envLabel = (e) => `${withBalance(trEnv(e), envBalMap, e.id)}${e.archived ? ' · ' + t('addTx.archivedSuffix') : ''}`;

  if (editable) {
    const typeFieldWrap = document.createElement('div'); typeFieldWrap.className = 'field';
    const typeLbl = document.createElement('label'); typeLbl.textContent = t('editTx.type');
    const typeSelEl = document.createElement('select');
    typeSelEl.style.display = 'none';
    const EDIT_TYPES = [
      ['expense', t('editTx.typeExpense')],
      ['income',  t('editTx.typeIncome')],
      ['account_transfer', t('editTx.typeTransfer')],
      ['investment_transfer', t('editTx.typeInvestment')],
    ];
    EDIT_TYPES.forEach(([v, label]) => {
      const o = document.createElement('option'); o.value = v; o.textContent = label;
      if (v === tx.type) o.selected = true;
      typeSelEl.append(o);
    });
    // Icon row, as on the add sheet; the title names the type.
    typePicker = txTypePicker(EDIT_TYPES, typeSelEl.value, (v) => {
      typeSelEl.value = v;
      typeSelEl.dispatchEvent(new Event('change'));
    });
    typeFieldWrap.append(typeSelEl, typePicker.el);
    typeSel = typeSelEl;
    form.append(typeFieldWrap);

    payeeEl = field('payee', t('addTx.payee'), tx.payee || '', 'text');
    amountEl = field('amount', t('addTx.amount'), txAbsAmount(tx), 'number');
    amountEl.querySelector('input').step = '0.01';
    enableFormulaInput(amountEl.querySelector('input'));
    // Posting a forecast occurrence early records it as paid today (owner
    // decision 2026-10-05); one already due keeps its own date.
    const occurrenceDate = (tx.date || '').slice(0, 10);
    const todayIso = ymdLocal(appNow());
    dateEl = field('date', t('addTx.date'), isForecast && occurrenceDate > todayIso ? todayIso : occurrenceDate, 'date');
    noteEl = field('note', t('editTx.note'), tx.note || '', 'text');

    const row = document.createElement('div'); row.className = 'field-row';
    row.append(amountEl, dateEl);
    form.append(payeeEl, row);

    envWrap = document.createElement('div'); envWrap.className = 'field';
    const envLbl = document.createElement('label'); envLbl.textContent = t('addTx.envelope');
    splitRows = document.createElement('div');
    splitRows.className = 'split-list';
    const splitFooter = document.createElement('div');
    splitFooter.className = 'split-footer';
    const addSplitBtn = document.createElement('button');
    addSplitBtn.type = 'button';
    addSplitBtn.className = 'btn btn-ghost btn-sm split-add';
    addSplitBtn.textContent = '+ ' + t('addTx.addSplit');
    addSplitBtn.addEventListener('click', () => {
      const total = parseAmountInput(amountEl.querySelector('input').value) || 0;
      let sum = 0;
      splitRows.querySelectorAll('.split-amt').forEach(i => { sum += parseAmountInput(i.value) || 0; });
      const remaining = total - sum;
      addSplitRow('', remaining > 0.005 ? remaining.toFixed(2) : '');
      if (remaining > 0.005) markAutoFilled(lastSplitAmt());
      updateSplits();
    });
    const remainingEl = document.createElement('div');
    remainingEl.className = 'split-remaining';
    splitFooter.append(addSplitBtn, remainingEl);
    const envNote = noEnvelopeNote();
    itemPick = budgetItemField({ initial: tx.budget_item_id || null });
    envWrap.append(envLbl, splitRows, splitFooter, itemPick.el, envNote.el);
    // Same gentle, non-blocking note as Add transaction.
    const syncEnvNote = () => envNote.sync(needsNoEnvelopeNote({
      type: typeSel.value,
      amount: parseAmountInput(amountEl.querySelector('input').value),
      envelopeValues: [...splitRows.querySelectorAll('.split-env')].map(s => s.value),
    }));
    form.addEventListener('input', syncEnvNote);
    form.addEventListener('change', syncEnvNote);
    queueMicrotask(syncEnvNote);

    function buildEnvOptionsHtml(selectedId) {
      const parts = [`<option value="">${t('addTx.pickEnvelope')}</option>`,
                     `<option value="__none__" ${selectedId === '__none__' ? 'selected' : ''}>${escHtml(t('addTx.noEnvelopeOption'))}</option>`];
      const sorted = filterArchivedForSelect(state.envelopes, showArchivedEnv, selectedId ? [...keepEnvIds, selectedId] : keepEnvIds)
        .sort((a, b) => Number(!!a.archived) - Number(!!b.archived));
      parts.push(envelopeOptionsHtml(sorted, envLabel, selectedId));
      return parts.join('');
    }

    addSplitRow = function(envelopeId = '', amountValue = '', itemId = null) {
      const row = document.createElement('div');
      row.className = 'split-row';
      // A split line can name the plan item it pays (shown only with two or
      // more lines, under the line).
      const linePick = budgetItemField({ compact: true, initial: itemId });
      row._itemPick = linePick;
      const sel = document.createElement('select');
      sel.className = 'split-env';
      sel.innerHTML = buildEnvOptionsHtml(envelopeId);
      const inp = document.createElement('input');
      inp.type = 'number'; inp.step = '0.01';
      inp.className = 'split-amt'; inp.placeholder = t('addTx.splitAmountPh');
      if (amountValue !== '' && amountValue != null) inp.value = amountValue;
      enableFormulaInput(inp);
      enablePercentageInput(inp, () => {
        const total = parseAmountInput(amountEl.querySelector('input').value) || 0;
        let otherSum = 0;
        splitRows.querySelectorAll('.split-row .split-amt').forEach(i => {
          if (i !== inp) otherSum += parseAmountInput(i.value) || 0;
        });
        return Math.max(0, total - otherSum);
      });
      const rm = document.createElement('button');
      rm.type = 'button'; rm.className = 'btn btn-ghost split-rm';
      rm.textContent = '×';
      rm.addEventListener('click', () => { row.remove(); linePick.el.remove(); updateSplits(); });
      row.append(sel, inp, rm);
      splitRows.append(row, linePick.el);
      // After the select is in the row: the combobox wrapper takes its place.
      enhanceSelectWithSearch(sel, { placeholder: t('addTx.envelopeSearchPh'), noMatch: t('addTx.envelopeNoMatch') });
      sel.addEventListener('change', updateSplits);
      inp.addEventListener('input', () => {
        // Skip the over-cap clamp while the user is still typing a formula or
        // a percentage — we only know the real value after evaluation on
        // blur/Enter.
        if (looksLikeFormula(inp.value) || looksLikePercentage(inp.value)) {
          updateSplits({ calledFromSplitAmt: true });
          return;
        }
        // Cap the line at what the others leave, and put the rest of the
        // total into the empty (or form-filled) line, so the split still adds up.
        rebalanceSplitLines(splitRows, inp, parseAmountInput(amountEl.querySelector('input').value) || 0);
        updateSplits({ calledFromSplitAmt: true });
      });
      inp.addEventListener('change', () => {
        // Auto-add a row pre-filled with the remaining balance when the user
        // blurs out of an already-filled split row and the splits still don't
        // cover the transaction total. The "last row has a value" guard
        // prevents an infinite cascade of empty rows.
        const total = parseAmountInput(amountEl.querySelector('input').value) || 0;
        if (total <= 0) return;
        const allRows = [...splitRows.querySelectorAll('.split-row')];
        const lastRow = allRows[allRows.length - 1];
        if (!lastRow) return;
        const lastAmt = parseAmountInput(lastRow.querySelector('.split-amt').value) || 0;
        if (lastAmt <= 0) return;
        let sum = 0;
        allRows.forEach(r => { sum += parseAmountInput(r.querySelector('.split-amt').value) || 0; });
        const remaining = total - sum;
        if (remaining > 0.005) {
          addSplitRow('', remaining.toFixed(2));
          markAutoFilled(lastSplitAmt());
          updateSplits();
        }
      });
    };

    splitCount = () => splitRows.querySelectorAll('.split-row').length;
    function lastSplitAmt() { return [...splitRows.querySelectorAll('.split-row .split-amt')].at(-1); }

    updateSplits = function({ calledFromSplitAmt = false } = {}) {
      const count = splitCount();
      itemPick.refresh(count === 1 ? splitRows.querySelector('.split-env')?.value : null);
      splitRows.querySelectorAll('.split-row').forEach(r => r._itemPick?.refresh(count > 1 ? r.querySelector('.split-env')?.value : null));
      splitRows.querySelectorAll('.split-row .split-rm').forEach(b => {
        b.style.visibility = count > 1 ? 'visible' : 'hidden';
      });
      const total = parseAmountInput(amountEl.querySelector('input').value) || 0;
      if (count <= 1) {
        remainingEl.textContent = '';
        remainingEl.classList.remove('is-balanced', 'is-off');
        const single = splitRows.querySelector('.split-row .split-amt');
        if (single && total > 0 && !calledFromSplitAmt) { single.value = total.toFixed(2); markAutoFilled(single); }
      } else {
        let sum = 0;
        splitRows.querySelectorAll('.split-amt').forEach(i => { sum += parseAmountInput(i.value) || 0; });
        const remaining = total - sum;
        const balanced = Math.abs(remaining) < 0.01;
        remainingEl.textContent = t('addTx.remaining')(fmt(remaining));
        remainingEl.classList.toggle('is-balanced', balanced);
        remainingEl.classList.toggle('is-off', !balanced);
      }
    };

    amountEl.querySelector('input').addEventListener('input', updateSplits);

    if (Array.isArray(tx.envelope_splits) && tx.envelope_splits.length) {
      // Preserve sign on existing splits — a negative line is a credit/correction.
      for (const s of tx.envelope_splits) addSplitRow(s.envelope_id || '', (Number(s.amount) || 0).toFixed(2), s.budget_item_id || null);
    } else {
      addSplitRow(tx.envelope_id || '', txAbsAmount(tx).toFixed(2));
      // One line holding the whole amount: the form's figure, so splitting
      // off a second line takes from it.
      markAutoFilled(lastSplitAmt());
    }
    updateSplits();

    // Keep envSel binding for the payee-autofill code below — points to the
    // first split row's envelope select when present.
    envSel = splitRows.querySelector('.split-env');

    // Sort: active first, archived last; archived items get a label suffix so
    // existing transactions referencing archived accounts/envelopes stay
    // editable and the user can also re-pick an archived item if needed.
    const archivedSuffixStr = ' · ' + t('addTx.archivedSuffix');
    // Asset accounts are revalued, never paid from or to; one already on the
    // row stays pickable so the row still displays what it holds.
    const sortedAccounts  = filterArchivedForSelect(state.accounts, showArchivedAccts, keepAcctIds)
      .filter(a => a.type !== 'asset' || keepAcctIds.includes(a.id))
      .sort((a, b) => Number(!!a.archived) - Number(!!b.archived));
    const sortedEnvelopes = filterArchivedForSelect(state.envelopes, showArchivedEnv, keepEnvIds)
      .sort((a, b) => Number(!!a.archived) - Number(!!b.archived));

    const acctWrap = document.createElement('div'); acctWrap.className = 'field';
    const acctLbl = document.createElement('label'); acctLbl.textContent = t('addTx.account');
    acctSel = document.createElement('select');
    // A loan is paid to, not spent from: left out unless the row is on one.
    sortedAccounts.filter(a => (a.type !== 'loan' && a.type !== 'loan_given') || a.id === tx.account).forEach(a => {
      const o = document.createElement('option');
      o.value = a.id;
      o.textContent = a.name + (a.archived ? archivedSuffixStr : '');
      if (a.id === tx.account) o.selected = true;
      acctSel.append(o);
    });
    acctWrap.append(acctLbl, acctSel);

    // Income-only: optional envelope to credit
    const incomeEnvWrap = document.createElement('div'); incomeEnvWrap.className = 'field';
    const incomeEnvLbl = document.createElement('label'); incomeEnvLbl.textContent = t('addTx.incomeEnvelope');
    incomeEnvSel = document.createElement('select');
    const incomeNoneOpt = document.createElement('option');
    incomeNoneOpt.value = ''; incomeNoneOpt.textContent = t('addTx.incomeEnvelopeNone');
    incomeEnvSel.append(incomeNoneOpt);
    const incomeEnvSelected = (tx.type === 'income' && tx.envelope_id) ? tx.envelope_id : '';
    appendEnvelopeOptions(incomeEnvSel, sortedEnvelopes, envLabel, incomeEnvSelected);
    incomeEnvWrap.append(incomeEnvLbl, incomeEnvSel);
    enhanceSelectWithSearch(incomeEnvSel, { placeholder: t('addTx.envelopeSearchPh'), noMatch: t('addTx.envelopeNoMatch') });

    // Income-only: the loan given this income is interest on (interest_of),
    // so its terms count it as interest received. Offered when the budget
    // has a loan given, so interest booked as plain income can be linked.
    const interestWrap = document.createElement('div'); interestWrap.className = 'field';
    const loansGiven = (state.accounts || [])
      .filter(a => a && a.type === 'loan_given' && (!a.archived || a.id === tx.interest_of));
    if (loansGiven.length) {
      interestOfSel = document.createElement('select');
      interestOfSel.id = `etx-interest-of-${tx.id}`;
      const none = document.createElement('option');
      none.value = ''; none.textContent = t('editTx.interestOfNone');
      interestOfSel.append(none);
      for (const a of loansGiven) {
        const o = document.createElement('option');
        o.value = a.id;
        o.textContent = a.name + (a.archived ? archivedSuffixStr : '');
        if (a.id === tx.interest_of) o.selected = true;
        interestOfSel.append(o);
      }
      const lbl = document.createElement('label'); lbl.textContent = t('editTx.interestOf');
      lbl.htmlFor = interestOfSel.id;
      const hint = document.createElement('div');
      hint.className = 'field-hint field-hint--info';
      hint.textContent = t('editTx.interestOfHint');
      interestWrap.append(lbl, interestOfSel, hint);
    }

    const acctLabel    = (a) => `${withBalance(a.name, acctBalMap, a.id)}${a.archived ? archivedSuffixStr : ''}`;
    const fromWrap = selectField(
      t('editTx.fromAccount'),
      sortedAccounts.map(a => [a.id, acctLabel(a)]),
      tx.from_account,
    );
    fromAcctSel = fromWrap.sel;
    const toWrap = selectField(
      t('editTx.toAccount'),
      sortedAccounts.map(a => [a.id, acctLabel(a)]),
      tx.to_account,
    );
    toAcctSel = toWrap.sel;

    const acctTransferRow = document.createElement('div'); acctTransferRow.className = 'field-row';
    acctTransferRow.append(fromWrap.wrap, toWrap.wrap);

    // Investment_transfer reuses fromAcctSel/toAcctSel for accounts and adds
    // a direction toggle, an envelope picker (single, no splits) and a fee
    // input.
    invDirection = tx.direction === 'sell' ? 'sell'
                 : tx.direction === 'dividend' ? 'dividend'
                 : 'buy';
    const invDirWrap = document.createElement('div'); invDirWrap.className = 'field';
    const invDirLbl = document.createElement('label'); invDirLbl.textContent = t('addTx.investmentDirection');
    const invDirBtns = document.createElement('div'); invDirBtns.className = 'tx-type-btns';
    [
      ['buy',      t('addTx.investmentBuy')],
      ['sell',     t('addTx.investmentSell')],
      ['dividend', t('addTx.investmentDividend')],
    ].forEach(([v, label]) => {
      const btn = document.createElement('button');
      btn.type = 'button'; btn.className = 'tx-type-btn'; btn.dataset.value = v;
      btn.textContent = label;
      if (v === invDirection) btn.classList.add('is-active');
      btn.addEventListener('click', () => {
        invDirection = v;
        invDirBtns.querySelectorAll('.tx-type-btn').forEach(b => b.classList.toggle('is-active', b.dataset.value === v));
        recomputeInvFields('direction');
        applyVisibility();
      });
      invDirBtns.append(btn);
    });
    invDirWrap.append(invDirLbl, invDirBtns);

    const invEnvWrap = document.createElement('div'); invEnvWrap.className = 'field';
    const invEnvLbl = document.createElement('label'); invEnvLbl.textContent = t('addTx.envelope');
    invEnvSel = document.createElement('select');
    // eslint-disable-next-line no-restricted-syntax -- values are escHtml-wrapped
    invEnvSel.innerHTML = `<option value="">${t('addTx.pickEnvelope')}</option>`;
    appendEnvelopeOptions(invEnvSel, sortedEnvelopes, envLabel, tx.envelope_id || '');
    invEnvWrap.append(invEnvLbl, invEnvSel);
    enhanceSelectWithSearch(invEnvSel, { placeholder: t('addTx.envelopeSearchPh'), noMatch: t('addTx.envelopeNoMatch') });

    const invFeeWrap = field('fee', t('addTx.fee'),
      tx.type === 'investment_transfer' && Number.isFinite(Number(tx.fee)) && Math.abs(Number(tx.fee)) > 0
        ? Math.abs(Number(tx.fee)).toFixed(2)
        : '',
      'number', { optional: true });
    invFeeInput = invFeeWrap.querySelector('input');
    invFeeInput.step = '0.01';
    invFeeInput.min = '0';
    invFeeInput.placeholder = fmtNum(0, { decimals: 2 });
    enableFormulaInput(invFeeInput);
    const invFeeLabel = invFeeWrap.querySelector('label');
    if (invFeeLabel) invFeeLabel.append(infoButton('investmentFees'));

    const fmtUnit = (v) => {
      if (!Number.isFinite(Number(v)) || Math.abs(Number(v)) <= 0) return '';
      // Trim trailing zeros to keep small ints clean (3 instead of 3.0000)
      return String(Math.abs(Number(v)));
    };
    const invSymbolWrap = field('symbol', t('addTx.symbol'),
      tx.type === 'investment_transfer' && typeof tx.symbol === 'string' ? tx.symbol : '',
      'text', { optional: true });
    invSymbolInput = invSymbolWrap.querySelector('input');
    invSymbolInput.placeholder = t('addTx.symbolPh');
    invSymbolInput.maxLength = 20;
    invSymbolInput.autocomplete = 'off';
    {
      const dl = document.createElement('datalist');
      dl.id = 'inv-symbols-datalist-edit';
      for (const { sym, name } of listKnownSymbolsWithNames(state)) {
        const o = document.createElement('option');
        o.value = sym;
        if (name) o.label = `${sym} — ${name}`;
        dl.append(o);
      }
      invSymbolWrap.append(dl);
      invSymbolInput.setAttribute('list', dl.id);
    }
    const invUnitsWrap = field('units', t('addTx.units'),
      tx.type === 'investment_transfer' ? fmtUnit(tx.units) : '',
      'number', { optional: true });
    invUnitsInput = invUnitsWrap.querySelector('input');
    invUnitsInput.step = '0.000001';
    invUnitsInput.min = '0';
    invUnitsInput.placeholder = t('addTx.unitsPh');
    enableFormulaInput(invUnitsInput, { decimals: 6 });

    const invPriceWrap = field('price', t('addTx.pricePerUnit'),
      tx.type === 'investment_transfer' ? fmtUnit(tx.pricePerUnit) : '',
      'number', { optional: true });
    invPriceInput = invPriceWrap.querySelector('input');
    invPriceInput.step = '0.00001';
    invPriceInput.min = '0';
    invPriceInput.placeholder = fmtNum(0, { decimals: 2 });
    enableFormulaInput(invPriceInput, { decimals: 5 });

    let isRecomputingInv = false;
    function setAmtHint(msg) {
      const hint = amountEl.querySelector('.field-hint');
      if (!hint) return;
      hint.textContent = msg || '';
      amountEl.classList.toggle('has-error', !!msg);
    }
    function recomputeInvFields(editedField) {
      if (isRecomputingInv) return;
      if (typeSel.value !== 'investment_transfer') return;
      const amtInput = amountEl.querySelector('input');
      const aRaw = amtInput.value.trim();
      const uRaw = invUnitsInput.value.trim();
      const pRaw = invPriceInput.value.trim();
      const fRaw = invFeeInput.value.trim();
      const a = parseAmountInput(aRaw);
      const u = parseAmountInput(uRaw);
      const p = parseAmountInput(pRaw);
      const f = parseAmountInput(fRaw);
      const aFilled = aRaw !== '' && Number.isFinite(a) && a > 0;
      const uFilled = uRaw !== '' && Number.isFinite(u) && u > 0;
      const pFilled = pRaw !== '' && Number.isFinite(p) && p > 0;
      const fFilled = fRaw !== '' && Number.isFinite(f) && f >= 0;

      setAmtHint('');

      const filled = [aFilled, uFilled, pFilled, fFilled].filter(Boolean).length;
      if (filled <= 2) return;

      const setAmt = (v) => {
        amtInput.value = (Math.round(v * 100) / 100).toFixed(2);
        amtInput.dispatchEvent(new Event('input', { bubbles: true }));
      };
      const setU = (v) => { invUnitsInput.value = (Math.round(v * 1000000) / 1000000).toString(); };
      const setP = (v) => { invPriceInput.value = (Math.round(v * 100000) / 100000).toString(); };
      const setF = (v) => { invFeeInput.value = (Math.round(v * 100) / 100).toFixed(2); };

      // Sign convention for the cash-side amount:
      //   buy:  amount = units*price + fee  (total cash paid, fee included)
      //   sell: amount = units*price - fee  (net cash received, fee deducted)
      // Matches the engine's investment_transfer delta logic.
      const feeSign = invDirection === 'sell' ? -1 : 1;
      isRecomputingInv = true;
      try {
        if (filled === 3) {
          if (!aFilled) {
            setAmt(u * p + feeSign * f);
          } else if (!uFilled) {
            const newU = (a - feeSign * f) / p;
            if (newU > 0) setU(newU);
          } else if (!pFilled) {
            const newP = (a - feeSign * f) / u;
            if (newP > 0) setP(newP);
          } else if (!fFilled) {
            const newF = feeSign * (a - u * p);
            if (newF >= 0) setF(newF);
            else setAmtHint(t('addTx.amountMismatch'));
          }
          return;
        }
        const expected = u * p + feeSign * f;
        if (Math.abs(a - expected) <= 0.005) return;
        if (editedField === 'amount') {
          const newU = (a - feeSign * f) / p;
          if (newU > 0) setU(newU);
          else setAmtHint(t('addTx.amountMismatch'));
        } else {
          setAmt(expected);
        }
      } finally {
        isRecomputingInv = false;
      }
    }
    amountEl.querySelector('input').addEventListener('input', () => recomputeInvFields('amount'));
    invUnitsInput.addEventListener('input', () => recomputeInvFields('units'));
    invPriceInput.addEventListener('input', () => recomputeInvFields('price'));
    invFeeInput.addEventListener('input', () => recomputeInvFields('fee'));

    // Investment-only rows. The amount/date row above stays as-is (no fee
    // squeezed in); when investment is the active type, we DOM-reorder so it
    // shows up between the accounts row and the units/price/fee row.
    const invDirEnvRow = document.createElement('div'); invDirEnvRow.className = 'field-row';
    invDirEnvRow.append(invDirWrap, invEnvWrap);

    // Symbol/ISIN sits next to the payee on a 2fr/1fr row so payee — which
    // tends to be a long fund name — gets the larger share.
    const payeeRow = document.createElement('div');
    payeeRow.className = 'field-row';
    payeeRow.style.gridTemplateColumns = '2fr 1fr';
    payeeEl.parentElement.insertBefore(payeeRow, payeeEl);
    payeeRow.append(payeeEl, invSymbolWrap);

    const invSymbolRow = document.createElement('div'); invSymbolRow.className = 'field-row';
    invSymbolRow.style.gridTemplateColumns = '1fr 1fr';
    invSymbolRow.append(invUnitsWrap, invPriceWrap);

    const invUnitsFeeRow = document.createElement('div'); invUnitsFeeRow.className = 'field-row';
    invUnitsFeeRow.append(invFeeWrap);

    form.append(envWrap, acctWrap, incomeEnvWrap, interestWrap, acctTransferRow, invDirEnvRow, invSymbolRow, invUnitsFeeRow);

    // Re-arrange the rows immediately after `payeeEl` based on the active tx
    // type. Investment uses a custom order: direction+envelope, accounts,
    // amount+date, units+price+fee. Other types keep the standard order.
    function reorderForType(ty) {
      const seq = ty === 'investment_transfer'
        ? [invDirEnvRow, acctTransferRow, row, invSymbolRow, invUnitsFeeRow]
        : [row, envWrap, acctWrap, incomeEnvWrap, interestWrap, acctTransferRow, invDirEnvRow, invSymbolRow, invUnitsFeeRow];
      let prev = payeeRow;
      for (const el of seq) {
        if (!el || !el.parentElement) continue;
        if (prev.nextSibling !== el) {
          prev.parentElement.insertBefore(el, prev.nextSibling);
        }
        prev = el;
      }
    }

    const applyVisibility = () => {
      const ty = typeSel.value;
      typePicker.setActive(ty);
      setSheetTitle(form, t('editTx.editTitle')[ty] || t('editTx.title'));
      envWrap.style.display = ty === 'expense' ? '' : 'none';
      const isTransfer = (ty === 'account_transfer' || ty === 'investment_transfer');
      acctWrap.style.display = isTransfer ? 'none' : '';
      incomeEnvWrap.style.display = ty === 'income' ? '' : 'none';
      interestWrap.style.display = ty === 'income' && interestOfSel ? '' : 'none';
      acctTransferRow.style.display = isTransfer ? '' : 'none';
      const isDividend = ty === 'investment_transfer' && invDirection === 'dividend';
      invDirEnvRow.style.display = ty === 'investment_transfer' ? '' : 'none';
      // Units / price / fee don't apply to dividends — they're cash income
      // tied to a holding, not a unit-priced trade.
      invSymbolRow.style.display = (ty === 'investment_transfer' && !isDividend) ? '' : 'none';
      invUnitsFeeRow.style.display = (ty === 'investment_transfer' && !isDividend) ? '' : 'none';
      // Symbol/ISIN field rides on the payee row — collapse the row to a
      // single column when there's no symbol child to show.
      const showSym = ty === 'investment_transfer';
      invSymbolWrap.style.display = showSym ? '' : 'none';
      payeeRow.style.gridTemplateColumns = showSym ? '2fr 1fr' : '1fr';
      reorderForType(ty);
    };
    applyVisibility();
    let prevType = typeSel.value;
    typeSel.addEventListener('change', () => {
      const ty = typeSel.value;
      if (ty === 'account_transfer' && (prevType === 'expense' || prevType === 'income') && acctSel.value) {
        trySetSelect(fromAcctSel, acctSel.value);
        trySetSelect(toAcctSel, acctSel.value);
      }
      if (ty === 'investment_transfer') {
        if ((prevType === 'expense' || prevType === 'income') && acctSel.value) {
          trySetSelect(fromAcctSel, acctSel.value);
          trySetSelect(toAcctSel, acctSel.value);
        }
      }
      prevType = ty;
      applyVisibility();
    });

    const datalist = document.createElement('datalist');
    datalist.id = 'payee-suggestions-edit';
    for (const payee of allPayees(state)) {
      const o = document.createElement('option');
      o.value = payee;
      datalist.append(o);
    }
    const payeeInput = payeeEl.querySelector('input');
    payeeInput.setAttribute('list', 'payee-suggestions-edit');
    payeeInput.setAttribute('autocomplete', 'off');
    form.append(datalist);
    form.append(transactionNote(noteEl));

    // Helper: set select only if option exists (handles deleted envelopes/accounts)
    function trySetSelect(sel, value) {
      if (!value) return;
      if ([...sel.options].some(o => o.value === value)) sel.value = value;
    }

    payeeInput.addEventListener('input', () => {
      const entry = findPayeeEntry(state, payeeInput.value);
      if (!entry) return;
      const match = entry.lastTx;
      if (EDITABLE_TYPES.has(match.type)) {
        typeSel.value = match.type;
        applyVisibility();
      }
      if (match.type === 'account_transfer') return;
      // A split row has no single envelope; fall back to the payee's last one.
      const envId = match.envelope_id || entry.lastEnvelopeId || '';
      if (match.type === 'income') {
        trySetSelect(incomeEnvSel, envId);
      } else {
        trySetSelect(envSel, envId);
        if (splitCount() === 1) itemPick.refresh(envSel?.value, entry.lastBudgetItemId);
      }
      trySetSelect(acctSel, match.account);
    });
  } else if (isAdjustment) {
    const targetType = tx.target || 'envelope';
    const archivedLbl = ' · ' + t('addTx.archivedSuffix');
    const items = targetType === 'account'
      ? filterArchivedForSelect(state.accounts, showArchivedAccts, [tx.target_id])
          .sort((a, b) => Number(!!a.archived) - Number(!!b.archived))
          .map(a => [a.id, a.name + (a.archived ? archivedLbl : '')])
      : filterArchivedForSelect(state.envelopes, showArchivedEnv, [tx.target_id])
          .sort((a, b) => Number(!!a.archived) - Number(!!b.archived))
          .map(e => [e.id, envLabel(e)]);
    const targetLabel = targetType === 'account' ? t('addTx.account') : t('addTx.envelope');
    const targetWrap = selectField(targetLabel, items, tx.target_id);
    adjTargetSel = targetWrap.sel;

    adjAmountEl = field('amount', t('editTx.adjustmentAmount'), (validateAmount(tx.amount) ?? 0).toFixed(2), 'number');
    adjAmountEl.querySelector('input').step = '0.01';
    adjAmountEl.querySelector('input').dataset.signed = 'true';
    enableFormulaInput(adjAmountEl.querySelector('input'));
    adjDateEl = field('date', t('addTx.date'), (tx.date || '').slice(0, 10), 'date');
    adjNoteEl = field('note', t('editTx.note'), tx.note || '', 'text');

    const row = document.createElement('div'); row.className = 'field-row';
    row.append(adjAmountEl, adjDateEl);
    form.append(targetWrap.wrap, row, transactionNote(adjNoteEl));

    const hint = document.createElement('p');
    hint.className = 'muted'; hint.style.cssText = 'margin:4px 0 0;font-size:12px;';
    hint.textContent = t('editTx.adjustmentHint');
    form.append(hint);
  } else if (isEnvTransfer) {
    const fromVal = tx.from_envelope_id || UNALLOCATED_SENTINEL;
    const toVal   = tx.to_envelope_id   || UNALLOCATED_SENTINEL;
    const envOpts = () => {
      const list = [[UNALLOCATED_SENTINEL, t('addTx.unallocated')]];
      const sorted = filterArchivedForSelect(state.envelopes, showArchivedEnv, keepEnvIds)
        .sort((a, b) => Number(!!a.archived) - Number(!!b.archived));
      for (const e of sorted) {
        list.push([e.id, envLabel(e)]);
      }
      return list;
    };
    const fromWrap = selectField(t('addTx.fromEnvelope'), envOpts(), fromVal);
    etFromSel = fromWrap.sel;
    enhanceSelectWithSearch(etFromSel, { placeholder: t('addTx.envelopeSearchPh'), noMatch: t('addTx.envelopeNoMatch') });
    const toWrap = selectField(t('addTx.toEnvelope'), envOpts(), toVal);
    etToSel = toWrap.sel;
    enhanceSelectWithSearch(etToSel, { placeholder: t('addTx.envelopeSearchPh'), noMatch: t('addTx.envelopeNoMatch') });

    etPayeeEl  = field('payee', t('addTx.payee'), tx.payee || '', 'text');
    etAmountEl = field('amount', t('addTx.amount'), txAbsAmount(tx).toFixed(2), 'number');
    etAmountEl.querySelector('input').step = '0.01';
    enableFormulaInput(etAmountEl.querySelector('input'));
    etDateEl = field('date', t('addTx.date'), (tx.date || '').slice(0, 10), 'date');
    etNoteEl = field('note', t('editTx.note'), tx.note || '', 'text');

    const row = document.createElement('div'); row.className = 'field-row';
    row.append(etAmountEl, etDateEl);
    const envTransferRow = document.createElement('div'); envTransferRow.className = 'field-row';
    envTransferRow.append(fromWrap.wrap, toWrap.wrap);
    form.append(envTransferRow, etPayeeEl, row, transactionNote(etNoteEl));
  } else if (isDebtPayment) {
    // The same accounts Add transaction offers: paid from an everyday account,
    // into a loan (or, for money lent out, a loan-given account). Asset
    // accounts are revalued, never paid from or into.
    const acctOpts = (keep) => filterArchivedForSelect(state.accounts, showArchivedAccts, [keep])
      .filter(a => a.type !== 'asset')
      .sort((a, b) => Number(!!a.archived) - Number(!!b.archived));
    const archivedLbl = (a) => (a.archived ? ' · ' + t('addTx.archivedSuffix') : '');
    const loanType = lentOut ? 'loan_given' : 'loan';
    const fromWrap = selectField(t('editTx.fromAccount'),
      acctOpts(tx.from_account).filter(a => (a.type !== 'loan' && a.type !== 'loan_given') || a.id === tx.from_account)
        .map(a => [a.id, a.name + archivedLbl(a)]),
      tx.from_account);
    dpFromSel = fromWrap.sel;
    const toWrap = selectField(lentOut ? t('addTx.lentAccount') : t('addTx.loanAccount'),
      acctOpts(tx.to_account).filter(a => a.type === loanType || a.id === tx.to_account)
        .map(a => [a.id, a.name + archivedLbl(a)]),
      tx.to_account);
    dpToSel = toWrap.sel;

    const envSorted = filterArchivedForSelect(state.envelopes, showArchivedEnv, keepEnvIds)
      .sort((a, b) => Number(!!a.archived) - Number(!!b.archived));
    const envWrapEl = document.createElement('div'); envWrapEl.className = 'field';
    const envLbl = document.createElement('label'); envLbl.textContent = t('addTx.envelope');
    dpEnvSel = document.createElement('select');
    const envNone = document.createElement('option');
    envNone.value = ''; envNone.textContent = t('addTx.pickEnvelope');
    dpEnvSel.append(envNone);
    appendEnvelopeOptions(dpEnvSel, envSorted, envLabel);
    dpEnvSel.value = tx.envelope_id || '';
    envWrapEl.append(envLbl, dpEnvSel);
    enhanceSelectWithSearch(dpEnvSel, { placeholder: t('addTx.envelopeSearchPh'), noMatch: t('addTx.envelopeNoMatch') });

    dpPayeeEl  = field('payee', t('addTx.payee'), tx.payee || '', 'text');
    dpAmountEl = field('amount', lentOut ? t('addTx.amount') : t('editTx.principalAmount'), txAbsAmount(tx).toFixed(2), 'number');
    dpAmountEl.querySelector('input').step = '0.01';
    enableFormulaInput(dpAmountEl.querySelector('input'));
    dpDateEl = field('date', t('addTx.date'), (tx.date || '').slice(0, 10), 'date');
    dpNoteEl = field('note', t('editTx.note'), tx.note || '', 'text');

    const acctRow = document.createElement('div'); acctRow.className = 'field-row';
    acctRow.append(fromWrap.wrap, toWrap.wrap);
    const row = document.createElement('div'); row.className = 'field-row';
    row.append(dpAmountEl, dpDateEl);
    form.append(acctRow, envWrapEl, dpPayeeEl, row, transactionNote(dpNoteEl));
    if (!lentOut) {
      const hint = document.createElement('p');
      hint.className = 'muted'; hint.style.cssText = 'margin:4px 0 0;font-size:12px;';
      hint.textContent = t('editTx.principalHint');
      form.append(hint);
    }
  } else {
    const note = document.createElement('p');
    note.className = 'muted';
    note.style.cssText = 'margin:4px 0 16px;font-size:13px;';
    note.textContent = t('editTx.readonlyNote');
    // An unknown type can be repaired below, so "cannot be edited" would mislead.
    if (isForecast || isKnownTxType(tx.type)) form.append(note);

    const card = document.createElement('div');
    card.style.cssText = 'background:var(--bg-sunken);padding:12px 14px;border-radius:8px;font-size:13px;';

    if (tx.type === 'fill') {
      const title = document.createElement('div');
      title.style.cssText = 'font-weight:600;margin-bottom:6px;';
      title.textContent = t('editTx.fillSummaryTitle');
      card.append(title);
      card.append(summaryLine(t('addTx.date'), (tx.date || '').slice(0, 10)));
      if (tx.payee) card.append(summaryLine(t('addTx.payee'), tx.payee));
      const lines = Array.isArray(tx.lines) ? tx.lines : [];
      let total = 0;
      for (const ln of lines) total += Math.abs(Number(ln.amount) || 0);
      card.append(summaryLine(t('editTx.fillTotal'), fmt(total)));
      if (lines.length) {
        const listTitle = document.createElement('div');
        listTitle.className = 'muted';
        listTitle.style.cssText = 'margin-top:10px;margin-bottom:4px;font-size:12px;';
        listTitle.textContent = t('editTx.fillLines');
        card.append(listTitle);
        for (const ln of lines) {
          const env = state.envelopes.find(e => e.id === ln.envelope_id);
          const name = env ? trEnv(env) : '(deleted)';
          const mode = ln.mode === 'set' ? ` (${t('editTx.fillModeSet')})` : '';
          card.append(summaryLine(name + mode, fmt(Math.abs(Number(ln.amount) || 0))));
        }
      }
    } else if (tx.type === 'debt_payment') {
      const title = document.createElement('div');
      title.style.cssText = 'font-weight:600;margin-bottom:6px;';
      const from = state.accounts.find(a => a.id === tx.from_account);
      const to   = state.accounts.find(a => a.id === tx.to_account);
      title.textContent = to?.type === 'loan_given' ? t('editTx.lentSummaryTitle') : t('editTx.debtSummaryTitle');
      card.append(title);
      card.append(summaryLine(t('addTx.date'), (tx.date || '').slice(0, 10)));
      card.append(summaryLine(t('editTx.fromAccount'), from ? from.name : '(deleted)'));
      card.append(summaryLine(t('editTx.toAccount'), to ? to.name : '(deleted)'));
      card.append(summaryLine(t('addTx.amount'), fmt(txAbsAmount(tx))));
      if (tx.note) card.append(summaryLine(t('editTx.note'), tx.note));
    } else {
      const pre = document.createElement('pre');
      pre.style.cssText = 'font-family:var(--font-mono);font-size:12px;white-space:pre-wrap;margin:0;';
      pre.textContent = JSON.stringify(tx, null, 2);
      card.append(pre);
    }

    form.append(card);

    // A type the app does not know moves no money anywhere (runInvariantCheck
    // `unknownTypes`). Repair it in place: pick the type it should have been,
    // and the row reopens as that type's form, filled from what it holds;
    // saving changes its type (transaction.amend).
    if (!isForecast && !isKnownTxType(tx.type)) {
      const repair = document.createElement('div');
      repair.className = 'field';
      repair.style.marginTop = '14px';
      const lbl = document.createElement('label');
      lbl.textContent = t('editTx.repairAs');
      const hint = document.createElement('p');
      hint.className = 'muted';
      hint.style.cssText = 'margin:0 0 8px;font-size:12px;';
      hint.textContent = t('editTx.repairAsHint');
      const picker = txTypePicker([
        ['expense', t('editTx.typeExpense')],
        ['income', t('editTx.typeIncome')],
        ['account_transfer', t('editTx.typeTransfer')],
        ['investment_transfer', t('editTx.typeInvestment')],
      ], null, (type) => {
        close();
        openEditTx({ ...tx, type, amount: txAbsAmount(tx) }, opts);
      });
      repair.append(lbl, hint, picker.el);
      form.append(repair);
    }
  }

  function requiredFields() {
    if (isAdjustment) markRequired(adjTargetSel);
    else if (isEnvTransfer) [etFromSel, etToSel].forEach(control => markRequired(control));
    else if (isDebtPayment) [dpFromSel, dpToSel].forEach(control => markRequired(control));
    else if (editable) {
      const ty = typeSel.value;
      markRequired(acctSel, ty === 'expense' || ty === 'income');
      [fromAcctSel, toAcctSel].forEach(control => markRequired(control, ty === 'account_transfer' || ty === 'investment_transfer'));
      markRequired(invEnvSel, ty === 'investment_transfer' && invDirection !== 'dividend');
      markRequired(invSymbolInput, ty === 'investment_transfer' && invDirection === 'dividend');
      markRequired(invUnitsInput, ty === 'investment_transfer' && invDirection === 'sell');
    }
  }
  requiredFields();
  form.addEventListener('change', requiredFields);
  form.addEventListener('click', requiredFields);

  // ── Footer actions ───────────────────────────────────────────────────────
  // Under the form, as add-tx and the plan editor have them (ux-review U16):
  // the row's own actions (skip or delete, post now, reverse) on the left,
  // Cancel and the primary action on the right.
  let deleteBtn = null;
  let skipBtn = null;
  let postBtn = null;
  let saveBtn = null;
  const startActions = [];
  const endActions = [];

  if (isForecast) {
    skipBtn = document.createElement('button');
    skipBtn.type = 'button';
    skipBtn.className = 'btn btn-ghost';
    skipBtn.textContent = t('transactions.skipOccurrence');
    startActions.push(skipBtn);
  } else {
    deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'btn btn-ghost';
    deleteBtn.style.color = 'var(--danger)';
    deleteBtn.textContent = t('editTx.delete');
    startActions.push(deleteBtn);
  }

  let postStoredBtn = null;
  if (storedScheduled) {
    postStoredBtn = document.createElement('button');
    postStoredBtn.type = 'button';
    postStoredBtn.className = 'btn btn-ghost';
    postStoredBtn.textContent = t('transactions.postNow');
    startActions.push(postStoredBtn);
  }

  if (!isForecast) {
    const reverse = document.createElement('button');
    reverse.type = 'button'; reverse.className = 'btn btn-ghost';
    reverse.textContent = t('reversal.title');
    reverse.addEventListener('click', guardSubmit(async () => {
      if (!isCurrent() || !(await tracker.confirmClose()) || !isCurrent()) return;
      openTransactionReversal(tx, { isCurrent, onCommitted: async () => {
        close(); onAfterChange?.();
        await navigate(state.currentPage);
        if (!isCurrent()) return;
        const original = state.transactions.find(row => row.id === tx.id);
        if (original) openEditTx(original, opts);
      } });
    }));
    startActions.push(reverse);
    const links = document.createElement('div');
    links.className = 'reversal-links';
    for (const [id, key] of [[tx.reverses, 'reversal.original'], [tx.reversed_by, 'reversal.counterpart']]) {
      if (!id) continue;
      const link = document.createElement('button');
      link.type = 'button'; link.className = 'btn btn-ghost btn-sm'; link.textContent = t(key);
      link.addEventListener('click', guardSubmit(async () => {
        if (!isCurrent() || !(await tracker.confirmClose()) || !isCurrent()) return;
        const related = state.transactions.find(row => row.id === id);
        if (related) { close(); openEditTx(related, opts); }
      }));
      links.append(link);
    }
    form.append(links);
  }

  const cancel = document.createElement('button');
  cancel.type = 'button'; cancel.className = 'btn btn-ghost';
  cancel.textContent = t('addTx.cancel');
  endActions.push(cancel);

  if (isForecast && editable) {
    postBtn = document.createElement('button');
    postBtn.type = 'button';
    postBtn.className = 'btn btn-accent';
    postBtn.textContent = t('transactions.postNow');
    postBtn.addEventListener('click', () => form.requestSubmit());
    endActions.push(postBtn);
  } else if (canEdit) {
    saveBtn = document.createElement('button');
    saveBtn.type = 'submit'; saveBtn.className = 'btn btn-accent';
    saveBtn.textContent = t('addTx.save');
    endActions.push(saveBtn);
  }

  const footer = document.createElement('div');
  footer.dataset.sheetActions = '';
  footer.className = 'sheet-footer-actions';
  const footerStart = document.createElement('div');
  footerStart.className = 'sheet-footer-actions-start';
  footerStart.append(...startActions);
  const footerEnd = document.createElement('div');
  footerEnd.className = 'sheet-footer-actions-end';
  footerEnd.append(...endActions);
  footer.append(footerStart, footerEnd);
  form.append(footer);

  // Any dismissal with unsaved edits (Escape or Cancel) asks before
  // discarding; completion paths (save, delete) close directly.
  const tracker = trackDirty(form);
  const { close, requestClose } = openSheet({
    title: (editable && t('editTx.editTitle')[tx.type])
      || (isDebtPayment && t(lentOut ? 'editTx.lentSummaryTitle' : 'editTx.debtSummaryTitle'))
      || t('editTx.title'),
    content: form,
    confirmClose: tracker.confirmClose,
  });
  cancel.addEventListener('click', requestClose);

  if (deleteBtn) {
    deleteBtn.addEventListener('click', async () => {
      if (!(await confirmClosedEdit([tx.date]))) return;
      if (!(await confirmReconciledEdit([tx], []))) return;
      const ok = await confirmDialog(t('editTx.deleteConfirm'), { title: t('editTx.delete'), danger: true, okLabel: t('editTx.delete') });
      if (!ok) return;
      deleteBtn.disabled = true;
      // The command writes the tombstone of a plan-linked row itself, and its
      // undo token takes the tombstone back with the row.
      const r = await dispatchOrReport('transaction.delete', { ids: [tx.id] });
      if (!r) { deleteBtn.disabled = false; return; }
      close();
      toast(t('editTx.deleted'), {
        action: {
          label: t('common.undo'),
          onAction: async () => {
            let u;
            try {
              u = await session.undo(r.value.undo);
            } catch (err) {
              console.error(err);
              toast(`${t('editTx.saveFailed')}: ${err?.message || err}`, { assertive: true });
              return;
            }
            if (u.ok) { toast(t('common.restored')); navigate(state.currentPage); return; }
            if (u.error.code === 'undo_stale') { toast(describeError(u.error, t)); return; }
            reportDispatchFailure(u.error);
          },
        },
      });
      onAfterChange?.();
      navigate(state.currentPage);
    });
  }

  if (postStoredBtn) {
    postStoredBtn.addEventListener('click', async () => {
      // A row scheduled for a later day posts as of today: it happened now.
      const todayIso = ymdLocal(appNow());
      const date = (tx.date || '').slice(0, 10) > todayIso ? todayIso : undefined;
      if (!(await confirmClosedEdit([tx.date, date || tx.date]))) return;
      postStoredBtn.disabled = true;
      const r = await dispatchOrReport('transaction.post', date ? { id: tx.id, date } : { id: tx.id });
      if (!r) { postStoredBtn.disabled = false; return; }
      close();
      toast(t('editTx.posted'));
      onAfterChange?.();
      navigate(state.currentPage);
    });
  }

  if (skipBtn) {
    skipBtn.addEventListener('click', async () => {
      const monthKey = tx.forecast_month_key;
      const itemId = tx.forecast_budget_item_id;
      const monthLabel = fmtMonthLang(monthKey);
      const msg = t('transactions.skipConfirm')
        .replace('{month}', monthLabel)
        .replace('{description}', tx.payee || '');
      const ok = await confirmDialog(msg, { title: t('transactions.skipOccurrence') });
      if (!ok) return;
      const item = (state.budgetItems || []).find(b => b.id === itemId);
      if (!item) { close(); return; }
      // An already-skipped month is a no-op (the command would refuse it).
      const skipped = Array.isArray(item.skipped_occurrences) ? item.skipped_occurrences : [];
      let r = null;
      if (!skipped.includes(monthKey)) {
        r = await dispatchOrReport('budgetItem.skipOccurrence', { id: itemId, month: monthKey });
        if (!r) return;
      }
      close();
      navigate(state.currentPage);
      // Undo restores the occurrence (the plan item editor can too, under
      // Skipped occurrences).
      toast(t('transactions.skipped')(tx.payee || item.description || '', monthLabel), r?.value?.undo
        ? { action: undoAction(r.value.undo, null, () => navigate(state.currentPage)) }
        : undefined);
    });
  }

  // What every successful save does: say so, close, refresh.
  const finishSave = () => {
    toast(t('editTx.saved'));
    close();
    onAfterChange?.();
    navigate(state.currentPage);
  };

  if (isAdjustment) {
    form.addEventListener('submit', guardSubmit(async (e) => {
      e.preventDefault();
      const amount = validateAmount(parseAmountInput(adjAmountEl.querySelector('input').value, { strict: true }));
      const date = adjDateEl.querySelector('input').value;
      const note = adjNoteEl.querySelector('input').value.trim();
      const targetId = adjTargetSel.value;
      if (amount === null) { fieldError(adjAmountEl.querySelector('input'), t('common.amountInvalid'), true); return; }
      if (!date) { fieldError(adjDateEl.querySelector('input'), t('common.dateRequired'), true); return; }
      if (!targetId) { fieldError(adjTargetSel, t('common.fieldRequired'), true); return; }
      if (!(await confirmClosedEdit([tx.date, date]))) return;
      // The amount keeps its sign: an adjustment is the one signed row.
      const input = { id: tx.id, amount, date, note: note || null, targetId };
      const dry = await dispatchOrReport('transaction.amend', input, { dryRun: true });
      if (!dry) return;
      if (!(await confirmReconciledEdit([tx], [dry.value.value]))) return;
      if (!(await dispatchOrReport('transaction.amend', input))) return;
      finishSave();
    }));
    return;
  }

  if (isEnvTransfer) {
    form.addEventListener('submit', guardSubmit(async (e) => {
      e.preventDefault();
      const amount = validateAmount(parseAmountInput(etAmountEl.querySelector('input').value, { strict: true }));
      const date = etDateEl.querySelector('input').value;
      const payee = etPayeeEl.querySelector('input').value.trim();
      if (!(amount > 0)) { fieldError(etAmountEl.querySelector('input'), t('common.amountInvalid'), true); return; }
      if (!date) { fieldError(etDateEl.querySelector('input'), t('common.dateRequired'), true); return; }
      if (etFromSel.value === etToSel.value) {
        fieldError(etToSel, t('editTx.envTransferSameError'), true);
        return;
      }
      if (!(await confirmClosedEdit([tx.date, date]))) return;
      const fromId = etFromSel.value === UNALLOCATED_SENTINEL ? null : etFromSel.value;
      const toId   = etToSel.value   === UNALLOCATED_SENTINEL ? null : etToSel.value;
      const noteVal = etNoteEl ? (etNoteEl.querySelector('input').value.trim() || null) : (tx.note || null);
      // The command invents no text: a blank payee keeps the old one, or the default.
      const input = {
        id: tx.id, amount, date,
        payee: payee || tx.payee || t('addTx.payeeEnvelopeTransfer'),
        fromEnvelope: fromId, toEnvelope: toId, note: noteVal,
      };
      if (!(await dispatchOrReport('transaction.amend', input))) return;
      finishSave();
    }));
    return;
  }

  if (isDebtPayment) {
    form.addEventListener('submit', guardSubmit(async (e) => {
      e.preventDefault();
      const amount = validateAmount(parseAmountInput(dpAmountEl.querySelector('input').value, { strict: true }));
      const date = dpDateEl.querySelector('input').value;
      if (!(amount > 0)) { fieldError(dpAmountEl.querySelector('input'), t('common.amountInvalid'), true); return; }
      if (!date) { fieldError(dpDateEl.querySelector('input'), t('common.dateRequired'), true); return; }
      if (dpFromSel.value === dpToSel.value) { fieldError(dpToSel, t('editTx.accountsSameError'), true); return; }
      if (!(await confirmClosedEdit([tx.date, date]))) return;
      const input = {
        id: tx.id, amount, date,
        payee: dpPayeeEl.querySelector('input').value.trim() || tx.payee || '',
        fromAccount: dpFromSel.value, toAccount: dpToSel.value,
        envelope: dpEnvSel.value || null,
        note: dpNoteEl.querySelector('input').value.trim() || null,
      };
      const dry = await dispatchOrReport('transaction.amend', input, { dryRun: true });
      if (!dry) return;
      if (!(await confirmReconciledEdit([tx], [dry.value.value]))) return;
      // An instalment the plan posted keeps its occurrence key; re-dated into
      // another month, the user says which month it pays.
      const link = await resolveScheduledLink(dry.value.value, tx.id);
      if (link) input.fromBudget = link;
      else if (Object.hasOwn(tx, 'from_budget')) input.fromBudget = null;
      if (!(await dispatchOrReport('transaction.amend', input))) return;
      finishSave();
    }));
    return;
  }

  if (!editable) return;

  form.addEventListener('submit', guardSubmit(async (e) => {
    e.preventDefault();
    const ty = typeSel.value;
    const payee  = payeeEl.querySelector('input').value.trim();
    const amount = validateAmount(parseAmountInput(amountEl.querySelector('input').value, { strict: true }));
    const date   = dateEl.querySelector('input').value;
    if (!(amount > 0)) { fieldError(amountEl.querySelector('input'), t('common.amountInvalid'), true); return; }
    if (!date) { fieldError(dateEl.querySelector('input'), t('common.dateRequired'), true); return; }

    if (isForecast) {
      // Posting an occurrence records a new row that names the plan item and
      // month it settles; the forecast row itself is never stored.
      const fromBudget = `${tx.forecast_budget_item_id}:${tx.forecast_month_key}`;
      /** @type {Record<string, any>} */
      const input = { type: ty, amount, date, payee, fromBudget, ...(tx.note ? { note: tx.note } : {}) };
      if (ty === 'expense') {
        const rows = [...splitRows.querySelectorAll('.split-row')];
        const sel = rows[0] ? rows[0].querySelector('.split-env') : null;
        input.envelope = (sel && sel.value && sel.value !== '__none__') ? sel.value : (tx.envelope_id ?? null);
        input.account = (acctSel && acctSel.value) || tx.account;
      } else if (ty === 'income') {
        input.envelope = incomeEnvSel ? (incomeEnvSel.value || null) : null;
        input.account = (acctSel && acctSel.value) || tx.account;
        if (interestOfSel?.value) input.interestOf = interestOfSel.value;
      } else if (ty === 'account_transfer') {
        input.fromAccount = (fromAcctSel && fromAcctSel.value) || tx.from_account;
        input.toAccount = (toAcctSel && toAcctSel.value) || tx.to_account;
        if (input.fromAccount === input.toAccount) { fieldError(toAcctSel, t('editTx.accountsSameError'), true); return; }
      } else {
        // ty === 'investment_transfer' here: the engine does forecast these
        // (a recurring buy/dividend plan item), but posting one from this
        // sheet is out of scope for now. Bail out rather than write a
        // half-built row.
        return;
      }
      if (!(await confirmClosedEdit([date]))) return;
      // Paid early (dated before the occurrence's month) keeps its key with no
      // relink question: the key is the month the payment belongs to.
      if (date >= `${tx.forecast_month_key}-01`) {
        input.fromBudget = await resolveScheduledLink({ from_budget: fromBudget, date }, null);
      }
      if (!(await dispatchOrReport('transaction.record', input))) return;
      finishSave();
      return;
    }

    // The fields this edit asks the command to set. A type change is the
    // command's to handle: it drops the fields of the old type.
    const noteVal = noteEl ? (noteEl.querySelector('input').value.trim() || null) : (tx.note || null);
    /** @type {Record<string, any>} */
    const input = { id: tx.id, type: ty, payee, amount, date, note: noteVal };
    if (ty === 'expense') {
      const rows = [...splitRows.querySelectorAll('.split-row')];
      input.account = acctSel.value || tx.account;
      if (rows.length > 1) {
        let sum = 0;
        const splits = rows.map(r => {
          const envelope = r.querySelector('.split-env').value;
          const amt = validateAmount(parseAmountInput(r.querySelector('.split-amt').value)) ?? 0;
          sum += amt;
          const lineItem = r._itemPick?.value();
          return { envelope, amount: amt, ...(lineItem ? { budgetItem: lineItem } : {}) };
        });
        if (splits.some(s => !s.envelope || s.envelope === '__none__')) {
          fieldError(amountEl.querySelector('input'), t('editTx.splitMissingEnvelope'), true);
          return;
        }
        if (splits.some(s => !isFinite(s.amount) || Math.abs(s.amount) < 0.005)) {
          fieldError(amountEl.querySelector('input'), t('editTx.splitInvalidAmount'), true);
          return;
        }
        if (Math.abs(sum - amount) > 0.01) {
          fieldError(amountEl.querySelector('input'), t('editTx.splitSumMismatch')
            .replace('{sum}', fmt(sum))
            .replace('{total}', fmt(amount)), true);
          return;
        }
        input.splits = splits;
      } else {
        const sel = rows[0] ? rows[0].querySelector('.split-env') : null;
        input.envelope = (sel && sel.value) || null;
        input.budgetItem = (itemPick ? itemPick.value() : null) || null;
      }
    } else if (ty === 'income') {
      input.envelope = incomeEnvSel ? (incomeEnvSel.value || null) : null;
      input.account = acctSel.value || tx.account;
      // Sent only when changed: set links the row, null clears the link.
      if (interestOfSel && (interestOfSel.value || null) !== (tx.interest_of || null)) {
        input.interestOf = interestOfSel.value || null;
      }
    } else if (ty === 'account_transfer') {
      input.fromAccount = fromAcctSel.value;
      input.toAccount = toAcctSel.value;
      if (input.fromAccount === input.toAccount) { fieldError(toAcctSel, t('editTx.accountsSameError'), true); return; }
    } else if (ty === 'investment_transfer') {
      input.fromAccount = fromAcctSel.value;
      input.toAccount = toAcctSel.value;
      input.envelope = invEnvSel.value || null;
      input.direction = invDirection === 'sell' ? 'sell'
                      : invDirection === 'dividend' ? 'dividend'
                      : 'buy';
      if (input.fromAccount === input.toAccount) { fieldError(toAcctSel, t('editTx.accountsSameError'), true); return; }
      const symRaw = invSymbolInput ? invSymbolInput.value.trim().toUpperCase() : '';
      if (input.direction === 'dividend') {
        // Dividend: envelope optional, no fee/units/price (the command drops them).
        if (!symRaw) { fieldError(invSymbolInput, t('editTx.symbolRequired'), true); return; }
      } else {
        if (!input.envelope) { fieldError(invEnvSel, t('editTx.envelopeRequired'), true); return; }
        const feeRaw = invFeeInput ? invFeeInput.value : '';
        const feeNum = feeRaw === '' ? 0 : parseAmountInput(feeRaw);
        const unitsRaw = invUnitsInput ? parseAmountInput(invUnitsInput.value) : NaN;
        const priceRaw = invPriceInput ? parseAmountInput(invPriceInput.value) : NaN;
        // §1.2 — same gate as add-tx.js. computeHoldings skips a `sell` with
        // no units, so the cash moves but the position never closes; this is
        // also the screen the existing unit-less sells get repaired on, so it
        // must not let one be saved back in that state.
        if (input.direction === 'sell' && !(Number.isFinite(unitsRaw) && unitsRaw > 0)) {
          fieldError(invUnitsInput, t('editTx.sellNeedsUnits'), true); return;
        }
        // The command stores fee, units and price only when positive, rounded
        // (2, 6 and 5 decimals); null clears one.
        input.fee = Number.isFinite(feeNum) && feeNum > 0 ? feeNum : null;
        input.units = Number.isFinite(unitsRaw) && unitsRaw > 0 ? unitsRaw : null;
        input.pricePerUnit = Number.isFinite(priceRaw) && priceRaw > 0 ? priceRaw : null;
      }
      input.symbol = symRaw || null;
    }

    if (!(await confirmClosedEdit([tx.date, date]))) return;
    // A dry run gives the row this edit would store: what the reconciled-row
    // guard weighs, and what the stale-link check reads.
    const dry = await dispatchOrReport('transaction.amend', input, { dryRun: true });
    if (!dry) return;
    if (!(await confirmReconciledEdit([tx], [dry.value.value]))) return;
    const link = await resolveScheduledLink(dry.value.value, tx.id);
    if (link) input.fromBudget = link;
    else if (Object.hasOwn(tx, 'from_budget')) input.fromBudget = null;

    // A new investment symbol is remembered for its payee, and earlier rows of
    // that payee that have none can take it: asked now, written as one commit
    // after the edit is saved.
    const rememberRule = ty === 'investment_transfer' && !!input.symbol && !!normalisePayeeKey(payee);
    const backfillIds = rememberRule ? await askPayeeBackfill(payee, input.symbol, tx.id) : [];

    if (!(await dispatchOrReport('transaction.amend', input))) return;
    finishSave();
    if (rememberRule) await savePayeeRule(payee, input.symbol, backfillIds);
    if (backfillIds.length) navigate(state.currentPage);
  }));
}
