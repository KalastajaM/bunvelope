// js/pages/transactions.js
import { infoButton } from '../ui/info-button.js';
import { state, session, now as appNow } from '../app.js';
import { fillDisplayTotal, fillSetLineCount, txAccountDelta, txNetAccountDelta, txAbsAmount, extractTxTags, collectAllTags } from '../engine.js';
import { avatar } from '../ui/avatar.js';
import { unassignedChip } from '../ui/unassigned.js';
import { moneyEl } from '../ui/money.js';
import { ask } from '../ui/query.js';
import { withBusy } from '../ui/busy.js';
import { toast } from '../ui/toast.js';
import { undoAction } from '../ui/undo-action.js';
import { confirmDialog, alertDialog } from '../ui/dialog.js';
import { dispatchOrReport as dispatchOrReportVia } from '../ui/save-error.js';
import { t, fmtDateLang, trEnv } from '../ui/i18n.js';
import { datePreset, pendingFilterFields, openAtTodayIndex, realIsoDate, filterKey } from './transactions-filter.js';
import { createVirtualList } from '../ui/virtual-list.js';
import { icon } from '../ui/icon.js';
import { emptyState } from '../ui/empty-state.js';
import { fmt, validateAmount, round2 } from '../utils.js';
import { isAiFeatureEnabled, aiSearch } from '../ai/client.js';
import { aiErrorText } from '../ai/render.js';
import { formatAiText, bareAiNumbers } from '../ai/money-text.js';
import { openSheet } from '../ui/sheet.js';
import { allPayees } from '../state/payee-index.js';
import { closedMonthsIn, countClosedRows } from '../state/closed-periods.js';
import { confirmClosedEdit } from '../ui/closed-period-guard.js';
import { confirmReconciledEdit } from '../ui/reconciled-guard.js';

// Filter state retained across renders so add/edit/delete tx flows that
// navigate back to this page don't drop the user's active filter. Cleared
// when an explicit pendingFilter arrives (e.g. drilling in from another page).
let savedUi = null;
// Scroll offset to restore on the next render — set when opening edit-tx so
// returning from the dialog (which triggers a full navigate / re-render) lands
// the user back where they were instead of jumping to the top.
let pendingScrollTop = null;

// A `debt_payment` into a loan-given account is money lent out, not a debt
// paid down; the row says so (engine isLoanGivenAccount).
function debtChipLabel(tx) {
  const to = state.accounts.find(a => a.id === tx.to_account);
  return to?.type === 'loan_given' ? t('transactions.chipLent') : t('transactions.chipDebt');
}

export async function render(container) {
  const page = document.createElement('div');
  page.className = 'page working-money page-transactions';

  const initialFilter = state.pendingFilter;
  state.pendingFilter = null;
  // pendingFilter may be an envelope id, "account:<id>", "month:YYYY-MM" or a
  // structured filter from Reports; see pendingFilterFields.
  const fromPending = pendingFilterFields(initialFilter);
  let initialSearch = fromPending.search;
  let initialEnvelope = fromPending.envelope;
  let initialAccount = fromPending.account;
  let initialType = fromPending.type;
  let initialStatus = 'all';
  let initialDateFrom = fromPending.dateFrom;
  let initialDateTo = fromPending.dateTo;
  let initialFlagged = 'all';
  if (!initialFilter && savedUi) {
    // No incoming pendingFilter: re-renders triggered by add/edit/delete tx
    // (which call navigate(currentPage)) should preserve whatever filters
    // the user had set before they opened the dialog.
    initialSearch   = savedUi.search   || '';
    initialEnvelope = savedUi.envelope || '';
    initialAccount  = savedUi.account  || '';
    initialType     = savedUi.type     || 'all';
    initialStatus   = savedUi.status   || 'all';
    initialDateFrom = savedUi.dateFrom || '';
    initialDateTo   = savedUi.dateTo   || '';
    initialFlagged  = savedUi.flagged  || 'all';
  }
  const ui = {
    search: initialSearch,
    envelope: initialEnvelope,
    account: initialAccount,
    type: initialType,
    status: initialStatus,
    dateFrom: initialDateFrom,
    dateTo: initialDateTo,
    flagged: initialFlagged,
    filtersOpen: !initialFilter && !!savedUi?.filtersOpen,
    selectMode: false,
    selected: new Set(),
    showScheduled: loadShowScheduled(),
  };
  // Retain a reference so the next render() (after add/edit/delete tx
  // navigates back) can read the current filter state.
  savedUi = ui;

  function persistKey() {
    const name = state.budgetFolder?.name || '_default';
    return `bunvelope.tx.showScheduled.${name}`;
  }
  function legacyKey() {
    const name = state.budgetFolder?.name || '_default';
    return `buvelope.tx.showScheduled.${name}`;
  }
  function loadShowScheduled() {
    try {
      let v = localStorage.getItem(persistKey());
      if (v === null) v = localStorage.getItem(legacyKey());
      return v === null ? true : v === '1';
    } catch { return true; }
  }
  function saveShowScheduled(v) {
    try {
      localStorage.setItem(persistKey(), v ? '1' : '0');
      localStorage.removeItem(legacyKey());
    } catch { /* ignore storage errors */ }
  }

  /**
   * Flatten grouped rows into a single virtual-list item array. Each item is
   * either { kind: 'header', date, count, total, latestBalance? } or
   * { kind: 'row', tx }.
   *
   * `dayMeta` (optional) maps date → { total, latestBalance? } and is merged
   * onto the corresponding header items.
   */
  function buildFlatItems(rows, dayMeta = null) {
    const items = [];
    let currentDate = null;
    let bucketStart = -1;
    for (const tx of rows) {
      const d = tx.date?.slice(0, 10) || '—';
      if (d !== currentDate) {
        if (bucketStart >= 0) items[bucketStart].count = items.length - bucketStart - 1;
        currentDate = d;
        bucketStart = items.length;
        const header = { kind: 'header', date: d, count: 0 };
        const meta = dayMeta && dayMeta.get(d);
        if (meta) {
          header.total = meta.total;
          if (meta.latestBalance != null) header.latestBalance = meta.latestBalance;
        }
        items.push(header);
      }
      items.push({ kind: 'row', tx });
    }
    if (bucketStart >= 0) items[bucketStart].count = items.length - bucketStart - 1;
    return items;
  }

  /**
   * Build per-day metadata for the headers. When `days` is provided (the
   * single-envelope or single-account ledger, by date), each day's `total` is
   * the net delta to that entity (= ending balance − previous-day ending
   * balance) and `latestBalance` is the ending balance for the day. Otherwise
   * `total` is the day's net movement over its visible rows.
   */
  function buildDayMeta(rows, days) {
    const out = new Map();
    if (rows.length === 0) return out;

    if (days) {
      // The ledger walks the FULL list, so a day filtered out of the visible
      // window (e.g. by date range) still anchors the delta of the next
      // visible day.
      for (const tx of rows) {
        const date = (tx.date || '').slice(0, 10);
        const day = days.get(date);
        if (day && !out.has(date)) out.set(date, { total: day.total, latestBalance: day.balance });
      }
    } else {
      // No entity filter — the day's net movement across every account.
      //
      // This used to sum the rows' DISPLAY amounts as `expense ? -raw : raw`,
      // which counted transfers, fills, debt payments and investment moves as
      // credits: a day holding one €400 transfer between two of your own
      // accounts read +€400 though nothing arrived. Adding display amounts
      // across mixed types does not produce a quantity of anything.
      //
      // Netting across accounts also makes the header slot mean ONE thing
      // regardless of filter — the single-entity branch above is already the
      // net delta to that entity, and this is the same figure widened to all
      // of them. A transfer day now reads €0,00, which is the honest answer:
      // no money entered or left. Individual rows still show their own signed
      // amount, so a transfer row keeps its magnitude while contributing
      // nothing to the total.
      const accountIds = new Set((state.accounts || []).map(a => a && a.id).filter(Boolean));
      let i = 0;
      while (i < rows.length) {
        const date = (rows[i].date || '').slice(0, 10);
        let j = i;
        let total = 0;
        while (j < rows.length && (rows[j].date || '').slice(0, 10) === date) {
          total += txNetAccountDelta(rows[j], accountIds);
          j++;
        }
        out.set(date, { total: round2(total) });
        i = j;
      }
    }
    return out;
  }

  const stickyTop = document.createElement('div');
  stickyTop.className = 'page-sticky-top-wrap';
  page.append(stickyTop);

  const head = document.createElement('div');
  head.className = 'page-head';
  const left = document.createElement('div');
  const h1 = document.createElement('h1');
  h1.textContent = t('transactions.title');
  h1.append(infoButton('txTypes'));
  left.append(h1);
  head.append(left);

  const actions = document.createElement('div'); actions.className = 'actions';
  const selectBtn = document.createElement('button');
  selectBtn.className = 'btn btn-ghost tx-select-mode';
  selectBtn.type = 'button';
  selectBtn.setAttribute('aria-pressed', 'false');
  selectBtn.textContent = t('transactions.selectMode');
  selectBtn.addEventListener('click', () => {
    ui.selectMode = !ui.selectMode;
    ui.selected.clear();
    selectBtn.setAttribute('aria-pressed', String(ui.selectMode));
    selectBtn.textContent = ui.selectMode ? t('transactions.selectCancel') : t('transactions.selectMode');
    repaint();
  });
  // A lazily loaded sheet whose chunk fails to arrive (offline, a deploy
  // swapped the files) must say so; otherwise the button just does nothing.
  const reportLoadFailure = (err) => {
    console.error('transactions: sheet failed to load', err);
    toast(t('common.moduleLoadFailed'), { assertive: true });
  };
  const addBtn = document.createElement('button');
  addBtn.className = 'btn btn-accent';
  addBtn.textContent = '+ ' + t('transactions.new');
  addBtn.addEventListener('click', () => import('./add-tx.js').then(m => m.openAddTx()).catch(reportLoadFailure));

  const importBtn = document.createElement('button');
  importBtn.type = 'button';
  importBtn.className = 'btn btn-ghost';
  importBtn.textContent = t('txImport.menuItem');
  importBtn.addEventListener('click', () =>
    import('../import/import-sheet.js')
      .then(m => m.openImportSheet(state))
      .catch(reportLoadFailure)
  );

  actions.append(importBtn, addBtn);
  head.append(actions);
  stickyTop.append(head);

  const selectionBar = document.createElement('div');
  selectionBar.className = 'tx-selection-bar';
  selectionBar.hidden = true;
  const selectionLabel = document.createElement('div');
  selectionLabel.className = 'tx-selection-count';
  selectionLabel.setAttribute('role', 'status');

  const selectionActions = document.createElement('div');
  selectionActions.className = 'bulk-actions';
  const bulkTools = document.createElement('div');
  bulkTools.className = 'tx-bulk-tools';
  bulkTools.hidden = true;

  const assignSel = document.createElement('select');
  assignSel.setAttribute('aria-label', t('transactions.bulkAssignPlaceholder'));
  const assignPlaceholder = document.createElement('option');
  assignPlaceholder.value = ''; assignPlaceholder.textContent = t('transactions.bulkAssignPlaceholder');
  const assignNoneOpt = document.createElement('option');
  assignNoneOpt.value = '__none__'; assignNoneOpt.textContent = t('transactions.noEnvelopeOption');
  assignSel.append(assignPlaceholder, assignNoneOpt);
  state.envelopes.filter(e => !e.archived).forEach(e => {
    const o = document.createElement('option'); o.value = e.id; o.textContent = trEnv(e);
    assignSel.append(o);
  });
  assignSel.addEventListener('change', () => {
    const val = assignSel.value;
    if (!val) return;
    onBatchAssign(val);
    assignSel.value = '';
  });

  // Bulk date-shift: opens a small dialog with a date picker.
  const dateShiftBtn = document.createElement('button');
  dateShiftBtn.type = 'button';
  dateShiftBtn.className = 'btn btn-ghost btn-sm btn-icon';
  dateShiftBtn.title = t('transactions.bulkSetDate');
  dateShiftBtn.setAttribute('aria-label', t('transactions.bulkSetDate'));
  dateShiftBtn.append(icon('calendar', 22));
  dateShiftBtn.addEventListener('click', onBatchSetDateClick);

  const flagToggleBtn = document.createElement('button');
  flagToggleBtn.type = 'button';
  flagToggleBtn.className = 'btn btn-ghost btn-sm btn-icon';
  flagToggleBtn.append(icon('flag', 22));
  flagToggleBtn.addEventListener('click', onBatchToggleFlag);

  // Bulk cleared: marks every selected row that moves an account cleared, or
  // uncleared when they all already are (the flag button's rule).
  const clearedToggleBtn = document.createElement('button');
  clearedToggleBtn.type = 'button';
  clearedToggleBtn.className = 'btn btn-ghost btn-sm btn-icon';
  clearedToggleBtn.append(icon('check', 22));
  clearedToggleBtn.addEventListener('click', onBatchToggleCleared);

  const changePayeeBtn = document.createElement('button');
  changePayeeBtn.className = 'btn btn-ghost';
  changePayeeBtn.textContent = t('transactions.bulkChangePayee');
  changePayeeBtn.addEventListener('click', onBatchChangePayee);

  const mergeBtn = document.createElement('button');
  mergeBtn.className = 'btn btn-accent';
  mergeBtn.textContent = t('transactions.mergeTransfer');
  mergeBtn.addEventListener('click', onMergeClick);

  const deleteBtn = document.createElement('button');
  deleteBtn.type = 'button';
  deleteBtn.className = 'btn btn-ghost btn-sm btn-icon';
  deleteBtn.style.color = 'var(--danger, #c0392b)';
  deleteBtn.title = t('transactions.deleteSelected');
  deleteBtn.setAttribute('aria-label', t('transactions.deleteSelected'));
  deleteBtn.append(icon('trash', 22));
  deleteBtn.addEventListener('click', onDeleteSelected);

  const selectToggleBtn = document.createElement('button');
  selectToggleBtn.className = 'btn btn-ghost';
  selectToggleBtn.addEventListener('click', () => {
    if (ui.selected.size > 0) {
      ui.selected.clear();
    } else {
      // Select every currently-visible (filtered) row.
      const visible = searchRows();
      for (const tx of visible) ui.selected.add(tx.id);
    }
    repaint();
  });

  bulkTools.append(assignSel, dateShiftBtn, flagToggleBtn, clearedToggleBtn, changePayeeBtn, mergeBtn, deleteBtn);
  selectionActions.append(selectToggleBtn, bulkTools);
  selectionBar.append(selectionLabel, selectionActions);

  function updateSelectionBar() {
    selectionBar.hidden = !ui.selectMode;
    bulkTools.hidden = ui.selected.size === 0;
    if (!ui.selectMode) return;
    selectionLabel.textContent = t('transactions.selected')(ui.selected.size);
    mergeBtn.disabled = !validPair();
    const sel = selectedTxs();
    const anyExpense = sel.some(x => x.type === 'expense');
    assignSel.disabled = !anyExpense;
    const n = ui.selected.size;
    deleteBtn.disabled = n === 0;
    dateShiftBtn.disabled = n === 0;
    flagToggleBtn.disabled = n === 0;
    changePayeeBtn.disabled = n === 0;
    // Flag icon: red when next click will flag everything; muted when it will
    // clear flags (i.e. all selected rows are already flagged).
    const willFlag = n === 0 ? true : sel.some(x => !x.flagged);
    flagToggleBtn.style.color = willFlag ? 'var(--danger, #c0392b)' : 'var(--muted)';
    const flagLabel = willFlag ? t('transactions.bulkFlagAll') : t('transactions.bulkUnflagAll');
    flagToggleBtn.title = flagLabel;
    flagToggleBtn.setAttribute('aria-label', flagLabel);
    const clearable = sel.filter(affectsAccount);
    clearedToggleBtn.disabled = clearable.length === 0;
    const willClear = clearable.length === 0 || clearable.some(x => !x.cleared);
    clearedToggleBtn.style.color = willClear ? 'var(--accent-ink, var(--text))' : 'var(--muted)';
    const clearedLabel = willClear ? t('transactions.bulkMarkCleared') : t('transactions.bulkMarkUncleared');
    clearedToggleBtn.title = clearedLabel;
    clearedToggleBtn.setAttribute('aria-label', clearedLabel);
    selectToggleBtn.textContent = n > 0
      ? t('transactions.selectNone')
      : t('transactions.selectAll');
  }

  /** One command through the session; the ok result, or null after reporting why not. */
  const dispatchOrReport = (name, input, report) => dispatchOrReportVia(session, name, input, undefined, report);
  // Bulk flag, payee and merge have always said "editTx.saveFailed" (assertively) when a write fails.
  const EDIT_FAILED = { failKey: 'editTx.saveFailed', assertive: true };

  /**
   * The toast "Undo" action for a committed result, or undefined when the
   * command changed nothing (a no-op commit has no undo token). Repaints the
   * list once the rows are back.
   */
  function undoToastAction(r) {
    const token = r.value.undo;
    return token ? undoAction(token, null, repaint) : undefined;
  }

  /** Clear the selection, toast the success (with Undo when there is one), repaint. */
  function finishBulk(r, message) {
    ui.selected.clear();
    const action = undoToastAction(r);
    toast(message, action ? { action } : undefined);
    repaint();
  }

  async function onBatchDate(newDate) {
    const sel = selectedTxs();
    if (sel.length === 0) return;
    const closedCount = closedMonthsIn(state.meta, [newDate], appNow()).length > 0
      ? sel.length
      : countClosedRows(state.meta, sel, appNow());
    if (!(await confirmClosedEdit([newDate, ...sel.map(x => x.date)], closedCount))) return;
    if (!(await confirmReconciledEdit(sel, sel.map(x => ({ ...x, date: newDate }))))) return;
    const ok = await confirmDialog(
      t('transactions.bulkDateConfirm')(sel.length, newDate),
      { title: t('transactions.bulkSetDate') },
    );
    if (!ok) return;
    const r = await dispatchOrReport('transaction.setFields', { ids: sel.map(x => x.id), date: newDate });
    if (!r) { repaint(); return; }
    finishBulk(r, t('transactions.bulkDateDone')(sel.length));
  }

  function onBatchSetDateClick() {
    if (ui.selected.size === 0) return;

    const wrap = document.createElement('div');
    wrap.style.cssText = 'display:flex;flex-direction:column;gap:12px;';

    const input = document.createElement('input');
    input.type = 'date';
    input.className = 'form-input';

    const footer = document.createElement('div');
    footer.dataset.sheetActions = '';
    footer.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;';
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'btn btn-ghost';
    cancelBtn.textContent = t('common.cancel');
    const applyBtn = document.createElement('button');
    applyBtn.type = 'button';
    applyBtn.className = 'btn btn-accent';
    applyBtn.textContent = t('transactions.bulkSetDateApply');
    footer.append(cancelBtn, applyBtn);

    wrap.append(input, footer);

    const sheet = openSheet({
      title: t('transactions.bulkSetDate'),
      content: wrap,
      narrow: true,
    });

    cancelBtn.addEventListener('click', () => sheet.close());
    function apply() {
      const val = input.value;
      if (!val) { input.focus(); return; }
      sheet.close();
      onBatchDate(val);
    }
    applyBtn.addEventListener('click', apply);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); apply(); }
    });
  }

  async function onBatchToggleFlag() {
    const sel = selectedTxs();
    if (sel.length === 0) return;
    // If any selected row is unflagged, the bulk action sets all to flagged.
    // Otherwise it clears the flag.
    const anyUnflagged = sel.some(x => !x.flagged);
    const target = anyUnflagged;
    const r = await dispatchOrReport('transaction.flag', { ids: sel.map(x => x.id), flagged: target }, EDIT_FAILED);
    if (!r) { repaint(); return; }
    finishBulk(r, target ? t('transactions.bulkFlagged')(sel.length) : t('transactions.bulkUnflagged')(sel.length));
  }

  async function onBatchToggleCleared() {
    // Only rows that move an account have a cleared flag (the row's own
    // toggle is hidden on the others).
    const sel = selectedTxs().filter(affectsAccount);
    if (sel.length === 0) return;
    const target = sel.some(x => !x.cleared);
    const changing = sel.filter(x => !!x.cleared !== target);
    if (!(await confirmReconciledEdit(changing, changing.map(x => ({ ...x, cleared: target }))))) return;
    const r = await dispatchOrReport('transaction.clear', { ids: changing.map(x => x.id), cleared: target }, EDIT_FAILED);
    if (!r) { repaint(); return; }
    finishBulk(r, target ? t('transactions.bulkCleared')(changing.length) : t('transactions.bulkUncleared')(changing.length));
  }

  function onBatchChangePayee() {
    const sel = selectedTxs();
    if (sel.length === 0) return;

    const wrap = document.createElement('div');
    wrap.style.cssText = 'display:flex;flex-direction:column;gap:12px;';

    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = t('transactions.bulkChangePayeePlaceholder');
    input.setAttribute('list', 'payee-suggestions-bulk');
    input.setAttribute('autocomplete', 'off');
    input.className = 'form-input';

    const datalist = document.createElement('datalist');
    datalist.id = 'payee-suggestions-bulk';
    for (const p of allPayees(state)) {
      const o = document.createElement('option');
      o.value = p;
      datalist.append(o);
    }

    const footer = document.createElement('div');
    footer.dataset.sheetActions = '';
    footer.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;';
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'btn btn-ghost';
    cancelBtn.textContent = t('common.cancel');
    const applyBtn = document.createElement('button');
    applyBtn.type = 'button';
    applyBtn.className = 'btn btn-accent';
    applyBtn.textContent = t('transactions.bulkChangePayeeApply');
    footer.append(cancelBtn, applyBtn);

    wrap.append(input, datalist, footer);

    const sheet = openSheet({
      title: t('transactions.bulkChangePayeeTitle')(sel.length),
      content: wrap,
      narrow: true,
    });

    cancelBtn.addEventListener('click', () => sheet.close());
    async function apply() {
      const newPayee = input.value.trim();
      if (!newPayee) { input.focus(); return; }
      if (!(await confirmClosedEdit(sel.map(x => x.date), countClosedRows(state.meta, sel, appNow())))) return;
      const r = await dispatchOrReport('transaction.setFields', { ids: sel.map(x => x.id), payee: newPayee }, EDIT_FAILED);
      if (!r) { repaint(); return; }
      sheet.close();
      finishBulk(r, t('transactions.bulkChangePayeeToast')(sel.length));
    }
    applyBtn.addEventListener('click', apply);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); apply(); }
    });

    setTimeout(() => input.focus(), 0);
  }

  async function onDeleteSelected() {
    const sel = selectedTxs();
    if (sel.length === 0) return;
    if (!(await confirmClosedEdit(sel.map(x => x.date), countClosedRows(state.meta, sel, appNow())))) return;
    if (!(await confirmReconciledEdit(sel, []))) return;
    const ok = await confirmDialog(
      t('transactions.deleteSelectedConfirm')(sel.length),
      { title: t('transactions.deleteSelected'), danger: true },
    );
    if (!ok) return;
    // The command writes the tombstone of a plan-linked row itself, and its
    // undo token takes the tombstones back with the rows.
    const r = await dispatchOrReport('transaction.delete', { ids: sel.map(x => x.id) });
    if (!r) { repaint(); return; }
    finishBulk(r, t('transactions.deletedSelected')(sel.length));
  }

  async function onBatchAssign(envelopeId) {
    const sel = selectedTxs().filter(x => x.type === 'expense');
    if (sel.length === 0) {
      await alertDialog(t('transactions.assignNoExpenses'), { title: t('transactions.assignTitle') });
      return;
    }
    if (!(await confirmClosedEdit(sel.map(x => x.date), countClosedRows(state.meta, sel, appNow())))) return;
    const envLabel = envelopeId === '__none__'
      ? t('transactions.assignNoEnvelope')
      : (state.envelopes.find(e => e.id === envelopeId)?.name || envelopeId);
    const ok = await confirmDialog(
      t('transactions.assignConfirm')(sel.length, envLabel),
      { title: t('transactions.assignTitle') },
    );
    if (!ok) return;
    // The command drops the budget-item link and any splits with the envelope.
    const r = await dispatchOrReport('transaction.setFields', { ids: sel.map(x => x.id), envelope: envelopeId });
    if (!r) { repaint(); return; }
    finishBulk(r, t('transactions.assignedToast')(sel.length, envLabel));
  }

  function selectedTxs() {
    const byId = new Map(state.transactions.map(x => [x.id, x]));
    return [...ui.selected].map(id => byId.get(id)).filter(Boolean);
  }

  function validPair() {
    const sel = selectedTxs();
    if (sel.length !== 2) return null;
    const inc = sel.find(x => x.type === 'income');
    const exp = sel.find(x => x.type === 'expense');
    if (!inc || !exp) return null;
    if (Math.abs(txAbsAmount(inc) - txAbsAmount(exp)) > 0.005) return null;
    if (!inc.account || !exp.account || inc.account === exp.account) return null;
    return { inc, exp };
  }

  async function onMergeClick() {
    const pair = validPair();
    if (!pair) { await alertDialog(t('transactions.mergeInvalid')); return; }
    if (!(await confirmClosedEdit([pair.exp.date, pair.inc.date], countClosedRows(state.meta, [pair.exp, pair.inc], appNow())))) return;
    const fromName = accountName(pair.exp.account);
    const toName   = accountName(pair.inc.account);
    const amt      = txAbsAmount(pair.inc);
    const ok = await confirmDialog(t('transactions.mergeConfirm')(fromName, toName, amt), { title: t('transactions.mergeTransfer') });
    if (!ok) return;

    const payee = pair.inc.payee || pair.exp.payee || t('transactions.accountTransferPayee');
    // What the command will build, for the reconciled-balance check only (the
    // command assigns the real id and timestamps).
    const preview = {
      id: '(merged transfer)',
      type: 'account_transfer',
      date: [pair.exp.date, pair.inc.date].sort()[0],
      from_account: pair.exp.account,
      to_account:   pair.inc.account,
      amount: amt,
      payee,
      // Both legs on the statement: the transfer replacing them is too.
      ...(pair.exp.cleared && pair.inc.cleared ? { cleared: true } : {}),
    };
    if (!(await confirmReconciledEdit([pair.exp, pair.inc], [preview]))) return;
    const r = await dispatchOrReport('transaction.mergeTransfer', { incomeId: pair.inc.id, expenseId: pair.exp.id, payee }, EDIT_FAILED);
    if (!r) { repaint(); return; }
    finishBulk(r, t('transactions.merged'));
  }

  const filters = document.createElement('div');
  filters.className = 'filters';

  // ── Search + Clear filters ────────────────────────────────────────────────
  const searchGroup = document.createElement('div');
  searchGroup.className = 'filter-group';
  searchGroup.style.cssText = 'flex:1;min-width:min(200px, 100%);';

  const search = document.createElement('div'); search.className = 'search';
  const searchIcon = document.createElement('span');
  searchIcon.style.color = 'var(--muted)';
  searchIcon.style.display = 'inline-flex';
  searchIcon.append(icon('search', 16));
  const searchInput = document.createElement('input');
  searchInput.placeholder = t('transactions.searchPlaceholderRich') || t('transactions.searchPlaceholder');
  searchInput.title = t('transactions.searchHint') || 'Search payees and notes. Use >50 / <100 / =42 to filter by amount.';
  searchInput.setAttribute('aria-label', t('transactions.searchPlaceholder'));
  if (ui.search) searchInput.value = ui.search;
  const searchCount = document.createElement('span');
  searchCount.className = 'search-count';
  searchCount.setAttribute('aria-live', 'polite');
  search.style.position = 'relative';
  search.append(searchIcon, searchInput, searchCount);

  const tagSuggest = document.createElement('div');
  tagSuggest.className = 'tag-suggest-popover';
  tagSuggest.style.display = 'none';
  tagSuggest.setAttribute('role', 'listbox');
  search.append(tagSuggest);

  let aiBtn = null;
  if (isAiFeatureEnabled('search')) {
    aiBtn = document.createElement('button');
    aiBtn.type = 'button';
    aiBtn.className = 'btn btn-ghost';
    aiBtn.style.cssText = 'height:36px;white-space:nowrap;font-size:12px;display:inline-flex;align-items:center;gap:6px;';
    aiBtn.innerHTML = '';
    aiBtn.textContent = '✨ ' + t('ai.search.button');
  }

  const toggleBtn = document.createElement('button');
  toggleBtn.type = 'button';
  toggleBtn.className = 'btn btn-ghost';
  toggleBtn.style.cssText = 'font-size:12px;height:36px;white-space:nowrap;';
  const toggleLbl = document.createElement('span');
  toggleLbl.textContent = t('transactions.filters') || 'Filters';
  const toggleCount = document.createElement('span');
  toggleCount.className = 'filter-count-badge';
  toggleCount.style.cssText = 'margin-left:6px;font-size:11px;background:var(--accent);color:var(--accent-ink);border-radius:10px;padding:1px 6px;display:none;';
  toggleBtn.append(toggleLbl, toggleCount);

  const clearFiltersBtn = document.createElement('button');
  clearFiltersBtn.type = 'button';
  clearFiltersBtn.className = 'btn btn-ghost btn-sm';
  clearFiltersBtn.textContent = t('transactions.clearAll') || 'Clear all';
  clearFiltersBtn.style.display = 'none';

  const toggleRow = document.createElement('div');
  toggleRow.className = 'tx-search-actions';
  toggleRow.append(toggleBtn, selectBtn, clearFiltersBtn);
  if (aiBtn) toggleRow.append(aiBtn);

  // .tx-search-row wraps the buttons under the search on a phone
  // (css/mobile.css); `flex: 1` on the search is in app.css for that reason.
  const searchRow = document.createElement('div');
  searchRow.className = 'tx-search-row';
  searchRow.append(search, toggleRow);
  searchGroup.append(searchRow);
  filters.append(searchGroup);

  // AI search popover (collapsed by default).
  let aiPopover = null;
  if (aiBtn) {
    aiPopover = document.createElement('div');
    aiPopover.style.cssText = 'display:none;flex-direction:column;gap:6px;width:100%;padding:10px 12px;border:1px solid var(--border);border-radius:8px;background:var(--surface);margin-top:6px;';
    const ta = document.createElement('textarea');
    ta.className = 'form-input';
    ta.rows = 2;
    ta.placeholder = t('ai.search.placeholder');
    ta.style.cssText = 'resize:vertical;min-height:48px;padding:6px 8px;';
    const submit = document.createElement('button');
    submit.type = 'button';
    submit.className = 'btn btn-accent';
    submit.style.cssText = 'align-self:flex-end;font-size:12px;height:30px;';
    submit.textContent = t('ai.search.submit');
    aiPopover.append(ta, submit);
    searchGroup.append(aiPopover);

    aiBtn.addEventListener('click', () => {
      const open = aiPopover.style.display === 'none';
      aiPopover.style.display = open ? 'flex' : 'none';
      if (open) ta.focus();
    });

    const applyAiSearch = async (input) => {
      const res = await aiSearch(input);
      const f = res?.filter || {};
      const envIds = new Set((state.envelopes || []).map((e) => e.id));
      const acctIds = new Set((state.accounts || []).map((a) => a.id));
      const types = new Set(['all', 'expense', 'income', 'transfer', 'fill', 'adjustment']);
      const statuses = new Set(['all', 'posted', 'scheduled']);
      let droppedUnknown = false;
      // Search text is matched, not read: a token becomes the bare amount
      // ("12.50", the exact-amount search token), never the formatted "€ 12,50".
      ui.search = typeof f.search === 'string' ? bareAiNumbers(f.search) : '';
      if (f.envelope && envIds.has(f.envelope)) ui.envelope = f.envelope;
      else { if (f.envelope) droppedUnknown = true; ui.envelope = ''; }
      if (f.account && acctIds.has(f.account)) ui.account = f.account;
      else { if (f.account) droppedUnknown = true; ui.account = ''; }
      ui.type = types.has(f.type) ? f.type : 'all';
      ui.status = statuses.has(f.status) ? f.status : 'all';
      ui.dateFrom = typeof f.dateFrom === 'string' ? f.dateFrom : '';
      ui.dateTo   = typeof f.dateTo   === 'string' ? f.dateTo   : '';
      searchInput.value = ui.search;
      envSel.value = ui.envelope;
      acctSel.value = ui.account;
      typeSel.value = ui.type;
      statusSel.value = ui.status;
      fromInput.value = ui.dateFrom;
      toInput.value = ui.dateTo;
      const explanation = res?.explanation ? formatAiText(res.explanation) : '';
      const note = explanation || t('ai.search.empty');
      toast(droppedUnknown ? `${note} (${t('ai.search.unknownIds')})` : note);
      updateClearFiltersBtn();
      repaint();
      aiPopover.style.display = 'none';
    };

    // inFlight guards the Cmd+Enter path, which bypasses the disabled button.
    let inFlight = false;
    const runAiSearch = async () => {
      const input = ta.value.trim();
      if (!input || inFlight) return;
      inFlight = true;
      try {
        await withBusy(submit, () => applyAiSearch(input), { label: t('common.loading') });
      } catch (err) {
        toast(aiErrorText(err));
      } finally {
        inFlight = false;
      }
    };

    submit.addEventListener('click', runAiSearch);
    ta.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        runAiSearch();
      }
    });
  }

  // Active-filter chips row
  const chipsRow = document.createElement('div');
  chipsRow.className = 'filter-chips';

  filters.append(chipsRow);

  // Advanced filters wrapper (collapsed by default)
  const advanced = document.createElement('div');
  advanced.className = 'filters-advanced';
  advanced.id = 'tx-filters-advanced';
  advanced.style.cssText = 'gap:12px;width:100%;';
  let advOpen = ui.filtersOpen;
  toggleBtn.setAttribute('aria-controls', advanced.id);
  advanced.style.display = advOpen ? 'grid' : 'none';
  toggleBtn.classList.toggle('is-active', advOpen);
  toggleBtn.setAttribute('aria-expanded', String(advOpen));
  toggleBtn.addEventListener('click', () => {
    advOpen = !advOpen;
    ui.filtersOpen = advOpen;
    advanced.style.display = advOpen ? 'grid' : 'none';
    toggleBtn.classList.toggle('is-active', advOpen);
    toggleBtn.setAttribute('aria-expanded', String(advOpen));
  });
  filters.append(advanced);

  // ── Envelope + Account ───────────────────────────────────────────────────
  const envAccountGroup = document.createElement('div');
  envAccountGroup.className = 'filter-group';

  const envSel = document.createElement('select');
  envSel.setAttribute('aria-label', t('transactions.allEnvelopes'));
  // eslint-disable-next-line no-restricted-syntax -- values are escHtml-wrapped
  envSel.innerHTML = `<option value="">${t('transactions.allEnvelopes')}</option>`;
  const envNoneOpt = document.createElement('option');
  envNoneOpt.value = '__noenvelope__';
  envNoneOpt.textContent = t('transactions.noEnvelope');
  envSel.append(envNoneOpt);
  state.envelopes.filter(e=>!e.archived).forEach(e => {
    const o = document.createElement('option'); o.value = e.id; o.textContent = trEnv(e);
    envSel.append(o);
  });
  envSel.value = ui.envelope;

  const acctSel = document.createElement('select');
  acctSel.setAttribute('aria-label', t('transactions.allAccountsOption'));
  const allAcctOpt = document.createElement('option');
  allAcctOpt.value = ''; allAcctOpt.textContent = t('transactions.allAccountsOption');
  acctSel.append(allAcctOpt);
  (state.accounts || []).filter(a => !a.archived).forEach(a => {
    const o = document.createElement('option'); o.value = a.id; o.textContent = a.name || a.id;
    acctSel.append(o);
  });
  acctSel.value = ui.account;

  envAccountGroup.append(envSel, acctSel);
  advanced.append(envAccountGroup);

  // ── Type + Status + Hide future ──────────────────────────────────────────
  const typeStatusGroup = document.createElement('div');
  typeStatusGroup.className = 'filter-group';

  const typeSel = document.createElement('select');
  typeSel.setAttribute('aria-label', t('transactions.typeAll'));
  [
    ['all',               t('transactions.typeAll')],
    ['expense',           t('transactions.typeExpense')],
    ['income',            t('transactions.typeIncome')],
    ['account_transfer',  t('transactions.typeAccountTransfer')],
    ['envelope_transfer', t('transactions.typeEnvelopeTransfer')],
    ['investment_transfer', t('transactions.typeInvestment')],
    ['adjustment',        t('transactions.typeAdjustment')],
    ['fill',              t('transactions.typeFill')],
    ['debt_payment',      t('transactions.typeDebt')],
  ].forEach(([v,label]) => {
    const o = document.createElement('option'); o.value = v; o.textContent = label; typeSel.append(o);
  });

  const statusSel = document.createElement('select');
  statusSel.setAttribute('aria-label', t('transactions.statusAll'));
  [
    ['all',       t('transactions.statusAll')],
    ['cleared',   t('transactions.statusCleared')],
    ['uncleared', t('transactions.statusUncleared')],
    ['scheduled', t('transactions.statusScheduled')],
  ].forEach(([v,label]) => {
    const o = document.createElement('option'); o.value = v; o.textContent = label; statusSel.append(o);
  });

  typeSel.value = ui.type;
  statusSel.value = ui.status;
  typeStatusGroup.append(typeSel, statusSel);
  advanced.append(typeStatusGroup);

  // ── From + To dates (single row, en-dash separator) ──────────────────────
  const datesGroup = document.createElement('div');
  datesGroup.className = 'filter-group';

  const dateRow = document.createElement('div'); dateRow.className = 'filter-date-row';
  const fromInput = document.createElement('input');
  fromInput.type = 'date'; fromInput.title = t('transactions.fromDate'); fromInput.setAttribute('aria-label', t('transactions.fromDate'));
  if (initialDateFrom) fromInput.value = initialDateFrom;

  const dateSep = document.createElement('span');
  dateSep.textContent = '–';
  dateSep.style.cssText = 'color:var(--muted);font-size:13px;';
  dateSep.setAttribute('aria-hidden', 'true');

  const toInput = document.createElement('input');
  toInput.type = 'date'; toInput.title = t('transactions.untilDate'); toInput.setAttribute('aria-label', t('transactions.untilDate'));
  if (initialDateTo) toInput.value = initialDateTo;

  dateRow.append(fromInput, dateSep, toInput);
  datesGroup.append(dateRow);

  // Date-preset buttons — quick way to set last7 / last30 / thisMonth / etc.
  const datePresets = document.createElement('div');
  datePresets.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;margin-top:6px;';
  const presetSpecs = [
    ['last7', t('transactions.preset7') || 'Last 7 days'],
    ['last30', t('transactions.preset30') || 'Last 30 days'],
    ['thisMonth', t('transactions.presetThisMonth') || 'This month'],
    ['lastMonth', t('transactions.presetLastMonth') || 'Last month'],
    ['ytd', t('transactions.presetYTD') || 'YTD'],
  ];
  for (const [key, label] of presetSpecs) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn btn-ghost btn-sm';
    b.textContent = label;
    b.addEventListener('click', () => {
      const range = datePreset(key, appNow());
      ui.dateFrom = range.from;
      ui.dateTo = range.to;
      fromInput.value = range.from || '';
      toInput.value = range.to || '';
      updateClearFiltersBtn();
      repaint();
    });
    datePresets.append(b);
  }
  datesGroup.append(datePresets);
  advanced.append(datesGroup);

  // ── Show scheduled + Flagged-only toggles ────────────────────────────────
  const togglesGroup = document.createElement('div');
  togglesGroup.className = 'filter-group tx-filter-toggles';

  function makeToggleRow({ labelText, tooltip, checked, onChange }) {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:8px;';
    row.title = tooltip;

    const lbl = document.createElement('label');
    lbl.className = 'filter-label';
    lbl.style.cssText = 'font-size:12px;color:var(--muted);';
    lbl.textContent = labelText;

    const switchLbl = document.createElement('label');
    switchLbl.className = 'bp-switch';
    const switchCb = document.createElement('input');
    switchCb.type = 'checkbox';
    switchCb.setAttribute('aria-label', labelText);
    switchCb.checked = checked;
    switchCb.addEventListener('change', () => onChange(switchCb.checked));
    const switchTrack = document.createElement('span');
    switchTrack.className = 'bp-switch-track';
    switchLbl.append(switchCb, switchTrack);

    row.append(lbl, switchLbl);
    return { row, switchCb };
  }

  const scheduledToggle = makeToggleRow({
    labelText: t('transactions.showScheduled'),
    tooltip: t('transactions.scheduledHint'),
    checked: ui.showScheduled,
    onChange: (v) => { ui.showScheduled = v; saveShowScheduled(v); repaint(); },
  });

  const flaggedToggle = makeToggleRow({
    labelText: t('transactions.flaggedOnly'),
    tooltip: t('transactions.flaggedOnlyHint'),
    checked: ui.flagged === 'only',
    onChange: (v) => { ui.flagged = v ? 'only' : 'all'; updateClearFiltersBtn(); repaint(); },
  });
  const flaggedCb = flaggedToggle.switchCb;

  togglesGroup.append(scheduledToggle.row, flaggedToggle.row);
  advanced.append(togglesGroup);

  // ── Clear filters logic + chips ──────────────────────────────────────────
  function makeChip(label, onRemove) {
    const chip = document.createElement('span');
    chip.className = 'filter-chip';
    chip.textContent = label;
    const x = document.createElement('button');
    x.type = 'button';
    x.className = 'filter-chip-x';
    x.setAttribute('aria-label', t('transactions.removeFilter'));
    x.textContent = '×';
    x.addEventListener('click', onRemove);
    chip.append(x);
    return chip;
  }
  function updateClearFiltersBtn() {
    const anyAdv = (ui.envelope ? 1 : 0) + (ui.account ? 1 : 0) +
      (ui.type !== 'all' ? 1 : 0) + (ui.status !== 'all' ? 1 : 0) +
      (ui.flagged !== 'all' ? 1 : 0) +
      (ui.dateFrom ? 1 : 0) + (ui.dateTo ? 1 : 0);
    const active = !!(ui.search) || anyAdv > 0;
    clearFiltersBtn.style.display = active ? '' : 'none';
    if (anyAdv > 0) {
      toggleCount.style.display = '';
      toggleCount.textContent = String(anyAdv);
    } else {
      toggleCount.style.display = 'none';
    }
    // Render chips for advanced filters only
    chipsRow.innerHTML = '';
    chipsRow.hidden = anyAdv === 0;
    if (ui.envelope) {
      let label;
      if (ui.envelope === '__noenvelope__') {
        label = t('transactions.noEnvelope');
      } else {
        const env = state.envelopes.find(e => e.id === ui.envelope);
        label = env ? trEnv(env) : ui.envelope;
      }
      chipsRow.append(makeChip(label, () => { ui.envelope = ''; envSel.value = ''; updateClearFiltersBtn(); repaint(); }));
    }
    if (ui.account) {
      const a = (state.accounts || []).find(x => x.id === ui.account);
      chipsRow.append(makeChip(a ? (a.name || a.id) : ui.account, () => { ui.account = ''; acctSel.value = ''; updateClearFiltersBtn(); repaint(); }));
    }
    if (ui.type !== 'all') {
      chipsRow.append(makeChip(typeSel.selectedOptions[0]?.textContent || ui.type, () => { ui.type = 'all'; typeSel.value = 'all'; updateClearFiltersBtn(); repaint(); }));
    }
    if (ui.status !== 'all') {
      chipsRow.append(makeChip(statusSel.selectedOptions[0]?.textContent || ui.status, () => { ui.status = 'all'; statusSel.value = 'all'; updateClearFiltersBtn(); repaint(); }));
    }
    if (ui.flagged === 'only') {
      chipsRow.append(makeChip(t('transactions.flaggedOnlyChip'), () => { ui.flagged = 'all'; flaggedCb.checked = false; updateClearFiltersBtn(); repaint(); }));
    }
    if (ui.dateFrom) chipsRow.append(makeChip(t('transactions.fromChip')(ui.dateFrom), () => { ui.dateFrom = ''; fromInput.value = ''; updateClearFiltersBtn(); repaint(); }));
    if (ui.dateTo) chipsRow.append(makeChip(t('transactions.toChip')(ui.dateTo), () => { ui.dateTo = ''; toInput.value = ''; updateClearFiltersBtn(); repaint(); }));
  }

  clearFiltersBtn.addEventListener('click', () => {
    ui.search = ''; ui.envelope = ''; ui.account = '';
    ui.type = 'all'; ui.status = 'all'; ui.flagged = 'all';
    ui.dateFrom = ''; ui.dateTo = '';
    searchInput.value = '';
    envSel.value = ''; acctSel.value = '';
    typeSel.value = 'all'; statusSel.value = 'all'; flaggedCb.checked = false;
    fromInput.value = ''; toInput.value = '';
    updateClearFiltersBtn();
    repaint();
  });

  fromInput.addEventListener('change', () => { ui.dateFrom = fromInput.value; updateClearFiltersBtn(); repaint(); });
  toInput.addEventListener('change',   () => { ui.dateTo   = toInput.value;   updateClearFiltersBtn(); repaint(); });

  stickyTop.append(filters, selectionBar);

  const listCard = document.createElement('div');
  listCard.className = 'card';
  listCard.style.padding = '0';
  listCard.style.overflow = 'hidden';

  const pinnedHeader = document.createElement('div');
  pinnedHeader.className = 'tx-date-header tx-pinned-header';
  listCard.append(pinnedHeader);

  const scroller = document.createElement('div');
  scroller.style.overflowY = 'auto';
  function syncScrollerHeight() {
    // Pages have no teardown hook; detach the window listener the first
    // time it fires after this render's DOM has been replaced.
    if (!scroller.isConnected) {
      window.removeEventListener('resize', syncScrollerHeight);
      return;
    }
    const top = scroller.getBoundingClientRect().top;
    scroller.style.maxHeight = Math.max(200, window.innerHeight - top - 20) + 'px';
  }
  requestAnimationFrame(syncScrollerHeight);
  window.addEventListener('resize', syncScrollerHeight);
  listCard.append(scroller);
  page.append(listCard);

  scroller.addEventListener('click', (e) => {
    const header = e.target.closest('[data-header-date]');
    if (header) {
      const date = header.dataset.headerDate;
      if (date && date !== '—') {
        ui.dateFrom = date;
        ui.dateTo = date;
        ui.search = '';
        ui.envelope = '';
        ui.type = 'all';
        ui.status = 'all';
        if (fromInput) fromInput.value = date;
        if (toInput) toInput.value = date;
        if (searchInput) searchInput.value = '';
        if (envSel) envSel.value = '';
        if (typeSel) typeSel.value = 'all';
        if (statusSel) statusSel.value = 'all';
        updateClearFiltersBtn();
        repaint();
      }
      return;
    }
    const row = e.target.closest('[data-tx-id]');
    if (!row) return;
    activateTxRow(row);
  });

  // Keyboard: each row's payee is a real <button> (see txRow), so Enter and
  // Space fire a native click that reaches the delegated handler above. The
  // row itself is no longer a role="button" — it held the flag, cleared and
  // tag buttons, and nested interactive controls are unreachable or
  // misannounced by screen readers.

  function activateTxRow(row) {
    const txId = row.dataset.txId;
    let tx = state.transactions.find(t => t.id === txId);
    if (!tx && row.classList.contains('is-forecast')) {
      tx = searchRows().find(t => t.id === txId);
    }
    if (!tx) return;
    if (ui.selectMode) {
      if (ui.selected.has(tx.id)) { ui.selected.delete(tx.id); row.classList.remove('is-selected'); }
      else                        { ui.selected.add(tx.id);    row.classList.add('is-selected'); }
      const cb = row.querySelector('[data-role="select-checkbox"]');
      if (cb) cb.checked = ui.selected.has(tx.id);
      updateSelectionBar();
    } else {
      // Keep the scroll position only for the re-render a save or delete
      // triggers. Set on open, a cancelled edit left it behind, and the next
      // unrelated visit (an account's transactions, say) restored it.
      const onAfterChange = () => { pendingScrollTop = scroller.scrollTop; };
      import('./edit-tx.js').then(m => m.openEditTx(tx, { onAfterChange })).catch(err => console.error(err));
    }
  }

  let virtualList = null;
  let currentRowHeight = null;
  let runningBal = null;
  let envStepByTxId = null;

  // The virtual list and "select all" need every match, not just a CLI-sized
  // page. Filtering and forecast construction belong to the shared query.
  function searchRows() {
    const input = { search: ui.search, searchMode: 'tokens', showScheduled: !!ui.showScheduled,
      status: ui.status, limit: Number.MAX_SAFE_INTEGER };
    if (ui.type !== 'all') input.type = ui.type;
    if (ui.account) input.account = ui.account;
    if (ui.envelope === '__noenvelope__') input.noEnvelope = true;
    else if (ui.envelope) input.envelope = ui.envelope;
    if (ui.flagged === 'only') input.flagged = true;
    const dateFrom = realIsoDate(ui.dateFrom);
    const dateTo = realIsoDate(ui.dateTo);
    if (dateFrom) input.dateFrom = dateFrom;
    if (dateTo) input.dateTo = dateTo;
    return ask('transactions.search', input)?.rows ?? [];
  }

  // The running balances of one envelope or account: the ledger.running query
  // walks the same list (lens-less, the same preview) from the beginning of
  // time. Its answer depends only on the entity, the preview toggle and range,
  // today and the budget's arrays, so it is kept for as long as those stay the
  // same: a search keystroke, or a type or status filter, repaints without
  // walking again. A write replaces an array, which asks again.
  //
  // The "no envelope" filter is not an envelope: nothing touches it, so its
  // ledger is empty (no balances, no day totals), as the walk always gave.
  // A failed query leaves the balances off the same way. A range date that is
  // not a real YYYY-MM-DD (a filter from another page arrives unchecked) is
  // left out of both the preview list and the ask rather than failing it.
  const EMPTY_LEDGER = { balance: new Map(), step: new Map(), days: new Map() };
  let ledgerCache = null;
  function ledgerOf(entity) {
    const d = appNow();
    const todayKey = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
    const key = [entity.envelope, entity.account, !!ui.showScheduled, ui.dateFrom || null, ui.dateTo || null, todayKey,
      state.transactions, state.budgetItems, state.envelopeTemplates, state.accounts, state.envelopes, state.meta];
    if (ledgerCache && ledgerCache.key.every((v, i) => v === key[i])) return ledgerCache.ledger;
    let ledger = EMPTY_LEDGER;
    if (entity.envelope !== '__noenvelope__') {
      const input = { ...entity, showScheduled: !!ui.showScheduled };
      const dateFrom = realIsoDate(ui.dateFrom);
      const dateTo = realIsoDate(ui.dateTo);
      if (dateFrom) input.dateFrom = dateFrom;
      if (dateTo) input.dateTo = dateTo;
      const answer = ask('ledger.running', input);
      if (answer) {
        ledger = {
          balance: new Map(answer.rows.map(r => [r.id, r.balance])),
          step: new Map(answer.rows.map(r => [r.id, r.step])),
          days: new Map(answer.days.map(day => [day.date, day])),
        };
      }
    }
    ledgerCache = { key, ledger };
    return ledger;
  }

  let isFirstRepaint = true;
  let lastFilterKey = filterKey(ui);
  function repaint() {
    const isFirst = isFirstRepaint;
    isFirstRepaint = false;
    const key = filterKey(ui);
    const filtersChanged = key !== lastFilterKey;
    lastFilterKey = key;
    const rows = searchRows();
    // A search or filter change can hide selected rows; a bulk action must
    // act only on rows the user can still see, so drop the hidden ones.
    if (ui.selected.size > 0) {
      const visible = new Set(rows.map(r => r.id));
      for (const id of [...ui.selected]) if (!visible.has(id)) ui.selected.delete(id);
    }
    updateSelectionBar();

    const anyFilter = !!(ui.search || ui.envelope || ui.account ||
      ui.type !== 'all' || ui.status !== 'all' || ui.flagged !== 'all' || ui.dateFrom || ui.dateTo);
    if (anyFilter) {
      searchCount.textContent = rows.length === 0
        ? t('common.noResults')
        : t('common.resultsFound')(rows.length);
      searchCount.classList.toggle('is-empty', rows.length === 0);
    } else {
      searchCount.textContent = '';
      searchCount.classList.remove('is-empty');
    }

    if (rows.length === 0) {
      if (virtualList) { virtualList.destroy(); virtualList = null; }
      scroller.innerHTML = '';
      const isFresh = (state.transactions || []).length === 0;
      const es = isFresh
        ? emptyState({
            icon: 'tx',
            title: t('transactions.emptyFresh'),
            body: t('transactions.emptyFreshBody'),
            action: {
              label: t('transactions.emptyFreshAction'),
              onClick: () => import('./add-tx.js').then(m => m.openAddTx()).catch(reportLoadFailure),
            },
          })
        : emptyState({
            icon: 'tx',
            title: t('transactions.empty'),
            body: t('transactions.emptyBody') || t('transactions.searchWider') || '',
          });
      es.style.margin = '24px';
      scroller.append(es);
      pinnedHeader.style.display = 'none';
      return;
    }

    const baseRowHeight = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--tx-row-height'), 10) || 56;
    const headerHeight = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--tx-date-header-height'), 10) || 28;
    // Show running balance only when one entity (envelope OR account) is
    // selected and no other filter narrows the stream. Date range is allowed
    // because the balance walk always starts from the beginning of time and
    // each row's lookup is by tx.id, regardless of the visible window.
    const oneEntity = (!!ui.envelope) !== (!!ui.account);
    const showRunning = oneEntity
      && ui.status === 'all'
      && ui.type === 'all'
      && !ui.search;
    // Per-envelope contribution of each fill row. `set`-mode fill lines store
    // an absolute target, not a delta, so the raw line amount does not match
    // the envelope's running-balance step (target − prior balance). The
    // ledger's step for the row is the real delta, so the ledger amount equals
    // the step. Read whenever an envelope is selected, even when the
    // running-balance column itself is hidden by a type/status/search filter;
    // an account's ledger only when its balances show.
    const ledger = ui.envelope ? ledgerOf({ envelope: ui.envelope })
      : showRunning ? ledgerOf({ account: ui.account }) : null;
    runningBal = showRunning ? ledger.balance : null;
    envStepByTxId = ui.envelope ? ledger.step : null;
    const txRowHeight = showRunning ? baseRowHeight + 18 : baseRowHeight;

    const dayMeta = buildDayMeta(rows, showRunning ? ledger.days : null);
    const items = buildFlatItems(rows, dayMeta);
    const rowHeightFn = (item) => item.kind === 'header' ? headerHeight : txRowHeight;
    // Shape descriptor — destroy and recreate the virtual list when row
    // dimensions change so the pre-computed offsets don't go stale.
    const shape = `${txRowHeight}|${headerHeight}`;
    if (virtualList && currentRowHeight !== shape) {
      virtualList.destroy();
      virtualList = null;
    }
    currentRowHeight = shape;

    // A new search or filter is a new question: its answer starts at the
    // top. A repaint with the same filters (a save, a toggle) keeps the place.
    if (filtersChanged) scroller.scrollTop = 0;

    if (!virtualList) {
      virtualList = createVirtualList({
        container: scroller,
        items,
        rowHeight: rowHeightFn,
        renderRow: (item) => item.kind === 'header' ? dateHeaderRow(item) : txRow(item.tx),
        overscan: 5,
        onWindowChange: (startIdx) => updatePinnedHeader(items, startIdx),
      });
    } else {
      virtualList.setItems(items);
      updatePinnedHeader(items, virtualList.getRenderedRange().startIdx);
    }

    if (isFirst && pendingScrollTop !== null) {
      const target = pendingScrollTop;
      pendingScrollTop = null;
      // Defer until after the virtual list has applied its content height.
      requestAnimationFrame(() => { scroller.scrollTop = target; });
    } else if (isFirst) {
      // Open at today; future rows stay one scroll up (see openAtTodayIndex).
      const d = appNow();
      const p = n => String(n).padStart(2, '0');
      const todayKey = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
      const idx = openAtTodayIndex(items, ui, todayKey);
      if (idx > 0) {
        const list = virtualList;
        requestAnimationFrame(() => list.scrollToIndex(idx));
      }
    }
  }

  function updatePinnedHeader(items, startIdx) {
    // If the first visible item is itself a header, it's already on screen —
    // hide the pinned duplicate.
    if (items[startIdx] && items[startIdx].kind === 'header') {
      pinnedHeader.style.display = 'none';
      return;
    }
    let header = null;
    for (let i = Math.min(startIdx, items.length - 1); i >= 0; i--) {
      if (items[i] && items[i].kind === 'header') { header = items[i]; break; }
    }
    if (!header) { pinnedHeader.style.display = 'none'; return; }
    pinnedHeader.style.display = 'flex';
    pinnedHeader.dataset.headerDate = header.date;
    fillDateHeader(pinnedHeader, header);
  }

  function applyTagFilter(tag) {
    if (!tag) return;
    const token = `#${tag}`;
    const current = (ui.search || '').trim();
    const has = current
      .split(/\s+/)
      .some(t => t.toLowerCase() === token.toLowerCase());
    if (has) return;
    ui.search = current ? `${current} ${token}` : token;
    searchInput.value = ui.search;
    updateClearFiltersBtn();
    repaint();
  }

  function txRow(tx) {
    const row = document.createElement('div');
    row.className = 'tx-row';
    row.dataset.txId = tx.id;
    if (tx.is_forecast) {
      row.classList.add('is-forecast');
      // Template-fill forecasts carry no budget item; assigning undefined
      // would stamp the literal string "undefined" on the row.
      if (tx.forecast_budget_item_id != null) row.dataset.forecastBudgetItemId = tx.forecast_budget_item_id;
      if (tx.forecast_month_key != null) row.dataset.forecastMonthKey = tx.forecast_month_key;
      if (tx.is_overdue) row.classList.add('is-overdue');
    }
    if (ui.selected.has(tx.id)) row.classList.add('is-selected');

    if (ui.selectMode) {
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = ui.selected.has(tx.id);
      cb.style.cssText = 'width:18px;height:18px;accent-color:var(--accent-ink);cursor:pointer;';
      cb.dataset.role = 'select-checkbox';
      row.append(cb);
    }
    row.append(avatar(tx.payee || '?'));

    const col = document.createElement('div'); col.className = 'tx-row-col';
    // The row's primary control: opens the transaction (or toggles it in
    // select mode) via the scroller's delegated click handler.
    const name = document.createElement('button');
    name.type = 'button';
    name.className = 'tx-row-open';
    const payeeText = tx.payee && tx.payee.trim()
      ? tx.payee
      : (tx.type === 'adjustment' && tx.note)
        ? tx.note
        : (tx.type === 'adjustment'       ? t('transactions.chipAdjustment')
          : tx.type === 'envelope_transfer' ? t('transactions.chipTransfer')
          : tx.type === 'fill'               ? t('transactions.chipFill')
          : tx.type === 'debt_payment'       ? debtChipLabel(tx)
          : tx.type === 'investment_transfer' ? t('transactions.chipInvestment')
          : '—');
    name.textContent = payeeText;

    const meta = document.createElement('div');
    meta.className = 'tx-row-meta';
    meta.append(chipFor(tx));
    const acct = document.createElement('span'); acct.className = 'muted'; acct.style.fontSize = '11.5px';
    acct.textContent = accountName(tx.account);
    meta.append(acct);
    for (const tag of extractTxTags(tx.note)) {
      const tagChip = document.createElement('button');
      tagChip.type = 'button';
      tagChip.className = 'tx-tag-chip';
      tagChip.textContent = `#${tag}`;
      tagChip.title = t('transactions.tagFilterHint') || 'Filter by this tag';
      tagChip.addEventListener('click', (e) => {
        e.stopPropagation();
        applyTagFilter(tag);
      });
      meta.append(tagChip);
    }
    col.append(name, meta);
    row.append(col);

    const amt = document.createElement('div');
    amt.className = 'tx-row-money';
    amt.style.cssText = 'display:flex;flex-direction:column;align-items:flex-end;';
    // Adjustment amounts are signed; all other types store a magnitude. A fill
    // has neither — it carries `lines` — so `txAbsAmount` returned 0 and every
    // fill row rendered as 0.00 next to a chip reading "Fill · 11".
    let rawAmt = tx.type === 'adjustment'
      ? (validateAmount(tx.amount) ?? 0)
      : tx.type === 'fill'
        ? fillDisplayTotal(tx)
        : txAbsAmount(tx);
    // When filtering by a single envelope, show the per-envelope contribution
    // (split share, fill line, transfer leg, adjustment delta) instead of the
    // gross tx amount, so each row's amount equals its running-balance step.
    let isSplitShare = false;
    let displayAmt;
    let amtTitle = null;
    let signedDisplay = tx.type === 'income';
    if (ui.envelope && tx.type === 'expense'
        && Array.isArray(tx.envelope_splits) && tx.envelope_splits.length) {
      const share = tx.envelope_splits.find(s => s.envelope_id === ui.envelope);
      if (share) { rawAmt = share.amount || 0; isSplitShare = true; }
      displayAmt = -Math.abs(rawAmt);
    } else if (ui.envelope && tx.type === 'fill') {
      const lines = (tx.lines || []).filter(l => l.envelope_id === ui.envelope);
      const sum = lines.reduce((s, l) => s + (Number(l.amount) || 0), 0);
      const isSet = lines.some(l => l.mode === 'set');
      // `set`-mode fills store an absolute target, so `sum` is the target, not
      // the amount actually moved into the envelope. Show the real delta (the
      // running-balance step) instead so the row reconciles with the balance
      // column; `add`-mode lines already store the delta, so `sum` is correct.
      // Without a step (the ledger query failed) the amount is left off (a
      // dash), not shown as the target; the title still names the target.
      displayAmt = isSet
        ? (envStepByTxId && envStepByTxId.has(tx.id) ? envStepByTxId.get(tx.id) : null)
        : sum;
      signedDisplay = true;
      if (isSet) {
        amtTitle = t('transactions.fillSetTargetTitle')(fmt(sum));
      }
    } else if (ui.envelope && tx.type === 'envelope_transfer') {
      const mag = txAbsAmount(tx);
      const inLeg  = tx.to_envelope_id   === ui.envelope ? +mag : 0;
      const outLeg = tx.from_envelope_id === ui.envelope ? -mag : 0;
      displayAmt = inLeg + outLeg;
      signedDisplay = true;
    } else if (ui.envelope && tx.type === 'adjustment'
               && tx.target === 'envelope' && tx.target_id === ui.envelope) {
      displayAmt = validateAmount(tx.amount) ?? 0;
      signedDisplay = true;
    } else if (ui.account && tx.type === 'fill'
               && tx.source === 'new_income' && tx.source_account === ui.account) {
      displayAmt = txAccountDelta(tx, ui.account);
      signedDisplay = true;
    } else if (ui.account && tx.type === 'adjustment'
               && tx.target === 'account' && tx.target_id === ui.account) {
      displayAmt = txAccountDelta(tx, ui.account);
      signedDisplay = true;
    } else if (ui.account && (tx.type === 'investment_transfer' || tx.type === 'account_transfer')
               && (tx.from_account === ui.account || tx.to_account === ui.account)) {
      // Filtered to one side of a transfer: show that side's sign, matching
      // the running balance (−X leaving, +X arriving).
      displayAmt = txAccountDelta(tx, ui.account);
      signedDisplay = true;
    } else if (ui.envelope && tx.type === 'investment_transfer'
               && tx.envelope_id === ui.envelope) {
      const mag = txAbsAmount(tx);
      displayAmt = tx.direction === 'buy' ? -mag : +mag;
      signedDisplay = true;
    } else if (tx.type === 'investment_transfer') {
      const mag = Math.abs(rawAmt);
      displayAmt = tx.direction === 'buy' ? -mag : +mag;
      signedDisplay = true;
    } else {
      displayAmt = tx.type === 'expense' ? -Math.abs(rawAmt) : rawAmt;
    }
    const span = moneyEl(displayAmt, { size: 'md', signed: signedDisplay });
    // Name the button by payee and amount, the two things a sighted user
    // reads off the row to pick it out.
    name.setAttribute('aria-label', `${payeeText}, ${span.textContent}`);
    if (tx.type === 'income') span.style.color = 'var(--success)';
    if (isSplitShare) span.title = t('transactions.splitShareTitle')(fmt(txAbsAmount(tx)));
    else if (amtTitle) span.title = amtTitle;
    amt.append(span);
    // The fill total leaves out lines that SET an envelope to a value; say
    // they exist so the row does not read as the whole fill. Not in the
    // single-envelope view, where the row already shows that envelope's step.
    const setLines = !ui.envelope ? fillSetLineCount(tx) : 0;
    if (setLines > 0) {
      const note = document.createElement('div');
      note.style.cssText = 'font-size:11px;color:var(--muted);margin-top:2px;line-height:1.1;';
      note.textContent = t('transactions.fillSetsNote')(setLines);
      amt.append(note);
    }
    if (runningBal && runningBal.has(tx.id)) {
      const balLine = document.createElement('div');
      balLine.style.cssText = 'font-size:11px;color:var(--muted);margin-top:2px;line-height:1.1;';
      balLine.textContent = fmt(runningBal.get(tx.id));
      amt.append(balLine);
    }
    row.append(amt);

    // Flag-for-later toggle. Reconcile and reports both filter on this so the
    // user can mark a transaction needing investigation without breaking the
    // rest of the workflow.
    const flagBtn = document.createElement('button');
    flagBtn.type = 'button';
    flagBtn.className = 'tx-flag-btn' + (tx.flagged ? ' is-flagged' : '');
    flagBtn.style.cssText = 'background:transparent;border:0;padding:0 6px;cursor:pointer;font-size:14px;line-height:1;'
      + (tx.flagged ? 'color:var(--warning,#b45309);' : 'color:var(--muted);opacity:.4;');
    flagBtn.textContent = tx.flagged ? '🚩' : '⚐';
    flagBtn.title = tx.flagged ? t('transactions.flagged') : t('transactions.flagForLater');
    flagBtn.setAttribute('aria-label', flagBtn.title);
    flagBtn.addEventListener('click', e => { e.stopPropagation(); toggleFlagged(tx); });
    row.append(flagBtn);

    const clearedBtn = document.createElement('button');
    clearedBtn.type = 'button';
    if (affectsAccount(tx)) {
      clearedBtn.className = 'tx-cleared-btn' + (tx.cleared ? ' is-cleared' : '');
      clearedBtn.title = tx.cleared ? t('transactions.clearedTitle') : t('transactions.unclearedTitle');
      clearedBtn.setAttribute('aria-label', clearedBtn.title);
      clearedBtn.addEventListener('click', e => { e.stopPropagation(); toggleCleared(tx); });
    } else {
      clearedBtn.className = 'tx-cleared-btn';
      clearedBtn.style.visibility = 'hidden';
      clearedBtn.tabIndex = -1;
      clearedBtn.setAttribute('aria-hidden', 'true');
    }
    row.append(clearedBtn);
    return row;
  }

  async function toggleFlagged(tx) {
    // A forecast row is not a stored transaction: nothing to flag.
    if (tx.is_forecast) return;
    const r = await dispatchOrReport('transaction.flag', { ids: [tx.id], flagged: !tx.flagged });
    if (r) repaint();
  }

  function affectsAccount(tx) {
    if (tx.type === 'fill') return false;
    if (tx.type === 'envelope_transfer') return false;
    if (tx.type === 'adjustment' && tx.target === 'envelope') return false;
    return true;
  }

  async function toggleCleared(tx) {
    if (!(await confirmReconciledEdit([tx], [{ ...tx, cleared: !tx.cleared }]))) return;
    // No manual rollback: a refused dispatch never published, so the row is
    // still as it was. Repaint either way to drop any optimistic UI state.
    await dispatchOrReport('transaction.clear', { ids: [tx.id], cleared: !tx.cleared });
    repaint();
  }

  function fillDateHeader(el, header) {
    el.innerHTML = '';
    const left = document.createElement('span');
    left.textContent = fmtDateLang(header.date);
    el.append(left);

    const right = document.createElement('span');
    right.className = 'tx-date-meta';
    const countEl = document.createElement('span');
    countEl.textContent = t('transactions.itemCount')(header.count);
    right.append(countEl);

    if (header.total != null && Number.isFinite(header.total)) {
      const sep = document.createElement('span');
      sep.className = 'tx-date-meta-sep';
      sep.textContent = '·';
      right.append(sep);
      const totalEl = document.createElement('span');
      totalEl.className = 'tx-date-total';
      if (header.total < -0.005) totalEl.classList.add('is-neg');
      else if (header.total > 0.005) totalEl.classList.add('is-pos');
      totalEl.textContent = fmt(header.total, { signed: true });
      right.append(totalEl);
    }
    if (header.latestBalance != null && Number.isFinite(header.latestBalance)) {
      const sep = document.createElement('span');
      sep.className = 'tx-date-meta-sep';
      sep.textContent = '·';
      right.append(sep);
      const balEl = document.createElement('span');
      balEl.className = 'tx-date-balance';
      balEl.textContent = fmt(header.latestBalance);
      right.append(balEl);
    }
    el.append(right);
  }

  function dateHeaderRow(header) {
    const el = document.createElement('div');
    el.className = 'tx-date-header';
    el.dataset.headerDate = header.date;
    fillDateHeader(el, header);
    return el;
  }

  function chipFor(tx) {
    if (tx.status === 'scheduled') {
      const chip = document.createElement('span');
      if (tx.is_overdue) {
        chip.className = 'chip overdue';
        chip.textContent = t('transactions.chipOverdue');
      } else {
        chip.className = 'chip scheduled' + (tx.type === 'income' ? ' income' : '');
        chip.textContent = t('transactions.statusScheduled');
      }
      return chip;
    }
    const c = document.createElement('span');
    c.className = 'chip';
    if (tx.type === 'income') {
      c.classList.add('income');
      c.style.background = 'oklch(from var(--mint) calc(l + 0.05) calc(c * 0.5) h)';
      c.style.color = 'var(--mint-ink)';
      c.textContent = t('transactions.incomeChip');
      return c;
    }
    if (tx.type === 'account_transfer') {
      const from = state.accounts.find(a => a.id === tx.from_account);
      const to   = state.accounts.find(a => a.id === tx.to_account);
      if (from && to) c.textContent = `↔ ${from.name} → ${to.name}`;
      else c.textContent = '↔ ' + t('transactions.chipTransfer');
      return c;
    }
    if (tx.type === 'envelope_transfer') {
      const from = state.envelopes.find(e => e.id === tx.from_envelope_id);
      const to   = state.envelopes.find(e => e.id === tx.to_envelope_id);
      const fromLabel = from ? trEnv(from) : (tx.from_envelope_id ? '(deleted)' : t('transactions.unallocatedShort'));
      const toLabel   = to   ? trEnv(to)   : (tx.to_envelope_id   ? '(deleted)' : t('transactions.unallocatedShort'));
      c.textContent = `↔ ${fromLabel} → ${toLabel}`;
      return c;
    }
    if (tx.type === 'fill') {
      const n = Array.isArray(tx.lines) ? tx.lines.length : 0;
      c.textContent = t('transactions.chipFill') + (n ? ` · ${n}` : '');
      return c;
    }
    if (tx.type === 'adjustment') {
      const amt = validateAmount(tx.amount) ?? 0;
      const amtStr = fmt(amt, { signed: true });
      if (tx.target === 'envelope') {
        const env = state.envelopes.find(e => e.id === tx.target_id);
        const name = env ? trEnv(env) : (tx.target_id ? '(deleted)' : '');
        c.textContent = `± ${name || t('transactions.chipAdjustment')} ${amtStr}`;
      } else if (tx.target === 'account') {
        const acc = state.accounts.find(a => a.id === tx.target_id);
        c.textContent = `± ${acc ? acc.name : '(deleted)'} ${amtStr}`;
      } else {
        c.textContent = `± ${t('transactions.chipAdjustment')} ${amtStr}`;
      }
      return c;
    }
    if (tx.type === 'debt_payment') {
      const from = state.accounts.find(a => a.id === tx.from_account);
      const to   = state.accounts.find(a => a.id === tx.to_account);
      if (from && to) c.textContent = `${debtChipLabel(tx)} · ${from.name} → ${to.name}`;
      else c.textContent = t('transactions.chipDebt');
      return c;
    }
    if (tx.type === 'investment_transfer') {
      const from = state.accounts.find(a => a.id === tx.from_account);
      const to   = state.accounts.find(a => a.id === tx.to_account);
      const label = tx.direction === 'sell' ? t('transactions.chipInvestmentSell')
                  : tx.direction === 'dividend' ? t('transactions.chipInvestmentDividend')
                  : t('transactions.chipInvestment');
      let text = (from && to) ? `${label} · ${from.name} → ${to.name}` : label;
      const units = Number(tx.units);
      const price = Number(tx.pricePerUnit);
      if (Number.isFinite(units) && units > 0 && Number.isFinite(price) && price > 0) {
        text += ` · ${units} × ${fmt(price)}`;
      }
      const feeRaw = Number(tx.fee);
      if (Number.isFinite(feeRaw) && Math.abs(feeRaw) > 0.005) {
        text += ` · ${t('transactions.chipFee')(fmt(Math.abs(feeRaw)))}`;
      }
      c.textContent = text;
      return c;
    }
    if (Array.isArray(tx.envelope_splits) && tx.envelope_splits.length) {
      const lines = tx.envelope_splits.map(s => {
        const env = state.envelopes.find(e => e.id === s.envelope_id);
        return `${trEnv(env) || s.envelope_id}: ${fmt(Math.abs(s.amount || 0))}`;
      });
      // When the envelope filter narrows to a single envelope, show its share
      // directly inside the chip — the user is asking "how much of this went
      // to envelope X?", and the chip is the right surface for the answer.
      if (ui.envelope) {
        const share = tx.envelope_splits.find(s => s.envelope_id === ui.envelope);
        const env = state.envelopes.find(e => e.id === ui.envelope);
        if (share) {
          const dot = document.createElement('span'); dot.className = 'dot';
          dot.style.background = envColor(env);
          c.append(dot, document.createTextNode(`${trEnv(env) || ui.envelope}: ${fmt(Math.abs(share.amount || 0))} (split)`));
          c.title = lines.join('\n');
          return c;
        }
      }
      c.textContent = t('transactions.splitCount')(tx.envelope_splits.length);
      c.title = lines.join('\n');
      return c;
    }
    if (tx.envelope_id === '__none__') {
      c.textContent = t('transactions.noEnvelopeCell');
      return c;
    }
    if (!tx.envelope_id) {
      // An expense saved without an envelope used to render an empty chip:
      // present in the DOM, invisible to the user. Say so instead.
      return unassignedChip();
    }
    const env = state.envelopes.find(e => e.id === tx.envelope_id);
    const dot = document.createElement('span'); dot.className = 'dot';
    dot.style.background = envColor(env);
    c.append(dot, document.createTextNode(trEnv(env)));
    return c;
  }

  function envColor(env) {
    const CAT = { housing:'var(--peach)', transport:'var(--sky)', food:'var(--mint)',
      leisure:'var(--lilac)', utilities:'var(--butter)', saving:'var(--mint)', debt:'var(--rose)', other:'var(--faint)' };
    return CAT[env?.category] || CAT.other;
  }

  function accountName(id) {
    return state.accounts.find(a => a.id === id)?.name || '';
  }

  const SEARCH_DEBOUNCE_MS = 150;
  let searchTimer = null;
  searchInput.addEventListener('input', (e) => {
    const value = e.target.value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      ui.search = value;
      updateClearFiltersBtn();
      repaint();
    }, SEARCH_DEBOUNCE_MS);
    updateTagSuggest();
  });

  // ── Tag suggestion popover ───────────────────────────────────────────────
  // When the caret sits inside a `#…` token in the search input, show a
  // dropdown of matching tags pulled from state.transactions notes. Clicking
  // (or pressing Enter on) a suggestion replaces the `#prefix` at the caret
  // with the full `#tag` and re-runs the search.
  let tagSuggestActive = -1;
  let tagSuggestItems = [];

  function findHashTokenAtCaret() {
    const val = searchInput.value;
    const caret = searchInput.selectionStart ?? val.length;
    // Walk back from the caret to the nearest whitespace or string start.
    let start = caret;
    while (start > 0 && !/\s/.test(val[start - 1])) start--;
    if (val[start] !== '#') return null;
    // Walk forward to the next whitespace.
    let end = caret;
    while (end < val.length && !/\s/.test(val[end])) end++;
    const token = val.slice(start, end);
    // Only suggest while the prefix is well-formed (or just `#`).
    if (!/^#[\p{L}\p{N}_-]*$/u.test(token)) return null;
    return { start, end, prefix: token.slice(1).toLowerCase() };
  }

  function updateTagSuggest() {
    const tok = findHashTokenAtCaret();
    if (!tok) { hideTagSuggest(); return; }
    const all = collectAllTags(state.transactions);
    const matches = all.filter(({ tag }) => tag.startsWith(tok.prefix)).slice(0, 12);
    if (!matches.length && !tok.prefix) {
      hideTagSuggest();
      return;
    }
    renderTagSuggest(matches, tok);
  }

  function renderTagSuggest(matches, tok) {
    tagSuggest.innerHTML = '';
    tagSuggestItems = matches;
    if (!matches.length) {
      const empty = document.createElement('div');
      empty.className = 'tag-suggest-empty';
      empty.textContent = t('transactions.tagSuggestEmpty') || 'No matching tags';
      tagSuggest.append(empty);
    } else {
      matches.forEach(({ tag, count }, i) => {
        const item = document.createElement('div');
        item.className = 'tag-suggest-item' + (i === tagSuggestActive ? ' is-active' : '');
        item.setAttribute('role', 'option');
        const label = document.createElement('span');
        label.textContent = `#${tag}`;
        const cnt = document.createElement('span');
        cnt.className = 'count';
        cnt.textContent = String(count);
        item.append(label, cnt);
        item.addEventListener('mousedown', (e) => {
          e.preventDefault();
          applyTagSuggestion(tag, tok);
        });
        tagSuggest.append(item);
      });
    }
    tagSuggest.style.top = `${searchInput.offsetTop + searchInput.offsetHeight + 4}px`;
    tagSuggest.style.left = `${searchInput.offsetLeft}px`;
    tagSuggest.style.display = '';
  }

  function hideTagSuggest() {
    tagSuggest.style.display = 'none';
    tagSuggestActive = -1;
    tagSuggestItems = [];
  }

  function applyTagSuggestion(tag, tok) {
    const val = searchInput.value;
    const next = `${val.slice(0, tok.start)}#${tag}${val.slice(tok.end)}`;
    const caret = tok.start + 1 + tag.length;
    searchInput.value = next;
    searchInput.setSelectionRange(caret, caret);
    ui.search = next;
    clearTimeout(searchTimer);
    hideTagSuggest();
    updateClearFiltersBtn();
    repaint();
    searchInput.focus();
  }

  searchInput.addEventListener('focus', updateTagSuggest);
  searchInput.addEventListener('click', updateTagSuggest);
  searchInput.addEventListener('keydown', (e) => {
    if (tagSuggest.style.display === 'none' || !tagSuggestItems.length) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      tagSuggestActive = (tagSuggestActive + 1) % tagSuggestItems.length;
      renderTagSuggest(tagSuggestItems, findHashTokenAtCaret() || { start: 0, end: 0, prefix: '' });
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      tagSuggestActive = (tagSuggestActive - 1 + tagSuggestItems.length) % tagSuggestItems.length;
      renderTagSuggest(tagSuggestItems, findHashTokenAtCaret() || { start: 0, end: 0, prefix: '' });
    } else if (e.key === 'Enter' && tagSuggestActive >= 0) {
      const tok = findHashTokenAtCaret();
      if (tok) {
        e.preventDefault();
        applyTagSuggestion(tagSuggestItems[tagSuggestActive].tag, tok);
      }
    } else if (e.key === 'Escape') {
      hideTagSuggest();
    }
  });
  searchInput.addEventListener('blur', () => {
    // Delay so a click on a suggestion still registers.
    setTimeout(hideTagSuggest, 150);
  });
  envSel.addEventListener('change', (e) => { ui.envelope = e.target.value; updateClearFiltersBtn(); repaint(); });
  typeSel.addEventListener('change', (e) => { ui.type = e.target.value; updateClearFiltersBtn(); repaint(); });
  statusSel.addEventListener('change', (e) => { ui.status = e.target.value; updateClearFiltersBtn(); repaint(); });
  acctSel.addEventListener('change', (e) => { ui.account = e.target.value; updateClearFiltersBtn(); repaint(); });
  updateClearFiltersBtn();
  repaint();

  container.append(page);
}
