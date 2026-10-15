import { infoButton } from './ui/info-button.js';
import { openReconcilePicker } from './reconcile-picker.js';
import { openImportSheet } from './import/import-sheet.js';
import { currentBudgetSession } from './state/budget-session.js';
// reconcile.js — Goodbudget-style account reconciliation.
//
// The user picks a reconciliation date (default today, min = last reconciliation
// date) and enters the actual statement balance for the account. We list every
// transaction touching that account that isn't yet `cleared` and whose date is
// on or before the reconciliation date, plus a running "cleared total" that
// converges on the target as the user toggles checkboxes.
//
// Features:
//   • "Select all" toggle to clear/uncheck every visible uncleared tx.
//   • "Add transaction" inline form — new expense/income for this account,
//     auto-checked in the list on save.
//   • On save, one session.dispatchBatch: the added rows are recorded, then
//     account.reconcile marks the selected txs `cleared: true`, posts an
//     optional `adjustment` for a remaining gap, and stamps the account with
//     `lastReconciledAt` (= reconciliation date) and `lastReconciledBalance`.

import { state, updateStatusBar, activeLensInput, session } from './app.js';
import { forecastScheduledTransactions, netForecastAgainstRealPayments, txAccountDelta, txAbsAmount } from './engine.js';
import { takenOccurrenceKeys } from './core/effective-txs.js';
import { getTombstones } from './state/scheduled-tombstones.js';
import { openSheet } from './ui/sheet.js';
import { ask } from './ui/query.js';
import { trackDirty } from './ui/dirty-guard.js';
import { withBusy } from './ui/busy.js';
import { confirmDialog, alertDialog } from './ui/dialog.js';
import { dispatchBatchOrReport, reportDispatchFailure, reportMetaFailure, SHARED_REPORT_CODES } from './ui/save-error.js';
import { describeError } from './core/errors.js';
import { toast } from './ui/toast.js';
import { t, fmtDateLang, trEnv } from './ui/i18n.js';
import { fmt, fmtNum, round2 } from './utils.js';
import { generateId } from './import.js';
import { openEditTx } from './pages/edit-tx.js';
import { enableFormulaInput, parseAmountInput } from './ui/amount-input.js';
import { attachFieldHint, setFieldHint } from './ui/field-hint.js';
import {
  SETTLED_EPSILON,
  isAccountTx,
  splitByCleared,
  reconcileTotals,
  scheduledRowsForAccount,
  scheduledRowKey,
  txFromScheduledRow,
  txsFromScheduledRow,
  scheduledRowDelta,
  untaggedMatchesForScheduledRow,
  buildManualTx,
  transferCounterpartOptions,
} from './reconcile-model.js';

function todayIso() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function openReconcileModal(accountId, onClose) {
  const account = state.accounts.find(a => a.id === accountId);
  if (!account) return;
  const generation = currentBudgetSession();
  const folder = state.budgetFolder;
  let closed = false;

  // ── Build content ──────────────────────────────────────────────────────
  const content = document.createElement('div');

  // "Last reconciled" / "never" line.
  const histLine = document.createElement('div');
  histLine.style.cssText = 'font-size:12px;color:var(--muted);margin-bottom:14px;';
  if (account.lastReconciledAt) {
    histLine.textContent = t('reconcile.lastReconciled')(
      fmt(account.lastReconciledBalance ?? 0),
      fmtDateLang(account.lastReconciledAt),
    );
  } else {
    histLine.textContent = t('reconcile.neverReconciled');
  }
  content.append(histLine);

  // Statement inputs share the date used by the checked-balance comparison.
  const grid = document.createElement('div');
  grid.className = 'reconcile-statement-fields';

  // The app's own field look (.field label + input), like every other form.
  const targetWrap = document.createElement('div');
  targetWrap.className = 'field';
  targetWrap.style.marginBottom = '0';
  const targetLbl = document.createElement('label');
  targetLbl.textContent = t('reconcile.statementBalance');
  const targetInput = document.createElement('input');
  targetInput.type = 'text';
  targetInput.id = 'reconcile-statement';
  targetLbl.htmlFor = targetInput.id;
  targetInput.inputMode = 'decimal';
  // The example in the budget's own number format (1 234,56 or 1,234.56).
  targetInput.placeholder = t('reconcile.statementBalancePh')(fmtNum(1234.56, { decimals: 2 }));
  enableFormulaInput(targetInput);
  targetWrap.append(targetLbl, targetInput);
  const dateWrap = document.createElement('div');
  dateWrap.className = 'field';
  dateWrap.style.marginBottom = '0';
  const dateLbl = document.createElement('label');
  dateLbl.textContent = t('reconcile.date');
  const dateInput = document.createElement('input');
  dateInput.type = 'date';
  dateInput.id = 'reconcile-date';
  dateLbl.htmlFor = dateInput.id;
  dateInput.value = todayIso();
  if (account.lastReconciledAt) dateInput.min = account.lastReconciledAt;
  dateWrap.append(dateLbl, dateInput);

  grid.append(dateWrap, targetWrap);
  const overview = document.createElement('div');
  overview.className = 'reconcile-overview';
  overview.append(grid);

  const box = document.createElement('div');
  box.className = 'reconcile-comparison';
  const rowStyle = 'display:flex;justify-content:space-between;gap:12px;';
  const breakdown = document.createElement('details');
  breakdown.className = 'reconcile-breakdown';
  const breakdownTitle = document.createElement('summary');
  breakdownTitle.textContent = t('reconcile.breakdown');
  breakdown.append(breakdownTitle);

  const rowAlready = document.createElement('div');
  rowAlready.style.cssText = rowStyle;
  const rowAlreadyLbl = document.createElement('span');
  rowAlreadyLbl.textContent = t('reconcile.alreadyCleared');
  const alreadyEl = document.createElement('strong');
  rowAlready.append(rowAlreadyLbl, alreadyEl);

  const rowNewly = document.createElement('div');
  rowNewly.style.cssText = rowStyle;
  const rowNewlyLbl = document.createElement('span');
  rowNewlyLbl.textContent = t('reconcile.newlyChecked');
  const newlyEl = document.createElement('strong');
  rowNewly.append(rowNewlyLbl, newlyEl);

  const rowTotal = document.createElement('div');
  rowTotal.style.cssText = rowStyle;
  const rowTotalLbl = document.createElement('span');
  rowTotalLbl.textContent = t('reconcile.reconciledTotal');
  const totalEl = document.createElement('strong');
  rowTotal.append(rowTotalLbl, totalEl);

  const rowDiff = document.createElement('div');
  rowDiff.style.cssText = rowStyle;
  const rowDiffLbl = document.createElement('span');
  rowDiffLbl.textContent = t('reconcile.difference');
  rowDiffLbl.append(infoButton(null, { title: t('reconcile.difference'), body: t('reconcile.enterBalanceHelp') }));
  const diffEl = document.createElement('strong');
  diffEl.setAttribute('role', 'status');
  diffEl.setAttribute('aria-live', 'polite');
  rowDiff.append(rowDiffLbl, diffEl);

  box.append(rowTotal, rowDiff);
  breakdown.append(rowAlready, rowNewly);
  overview.append(box);
  content.append(overview, breakdown);

  const instructions = document.createElement('p');
  instructions.className = 'reconcile-instructions';
  instructions.textContent = t('reconcile.selectHelp');
  content.append(instructions);

  // List-header bar: count + "Add tx" + "Select all".
  const listBar = document.createElement('div');
  listBar.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;gap:12px;flex-wrap:wrap;';
  const listCount = document.createElement('div');
  listCount.style.cssText = 'font-size:12px;color:var(--muted);';

  const barActions = document.createElement('div');
  barActions.style.cssText = 'display:flex;align-items:center;gap:12px;';
  const addTxBtn = document.createElement('button');
  addTxBtn.type = 'button';
  addTxBtn.className = 'btn btn-ghost';
  addTxBtn.style.cssText = 'font-size:12px;padding:4px 8px;';
  addTxBtn.textContent = t('reconcile.addTx');

  const clearAllLabel = document.createElement('label');
  clearAllLabel.style.cssText = 'display:flex;align-items:center;gap:6px;font-size:12px;color:var(--muted);cursor:pointer;';
  const clearAllCb = document.createElement('input');
  clearAllCb.type = 'checkbox';
  clearAllCb.style.width = 'auto';
  clearAllLabel.append(clearAllCb, document.createTextNode(t('reconcile.clearAll')));

  const findBtn = document.createElement('button');
  findBtn.type = 'button';
  findBtn.className = 'btn btn-ghost btn-sm';
  findBtn.textContent = t('reconcile.findPlanned');
  findBtn.addEventListener('click', () => openPicker());
  barActions.style.flexWrap = 'wrap';
  const fileBtn = document.createElement('button');
  fileBtn.type = 'button';
  fileBtn.className = 'btn btn-ghost btn-sm';
  fileBtn.textContent = t('reconcile.addFile');
  fileBtn.title = t('reconcile.dropFile');
  const importFile = initialFile => {
    if (saving || closed || generation !== currentBudgetSession()) return;
    openImportSheet(state, { initialFile, reconcile: {
      accountId,
      isActive: () => !closed && !saving && !!content.closest('[data-sheet-open]') && generation === currentBudgetSession() && folder === state.budgetFolder,
      getTransactions: () => [...workingTransactions(), ...newlyAddedTxs],
      getBalanceTarget: () => ({ target: parseTarget(), date: getReconcileDate(), checked: [...selected].filter(id => visibleDeltas.has(id)) }),
      onStage: (rows, review) => {
        if (review) {
          if (Number.isFinite(review.target)) targetInput.value = String(review.target);
          dateInput.value = review.date;
          if (rows.length && !statementContext) statementContext = review.context;
        }
        for (const row of rows) newlyAddedTxs.push({ ...row, id: generateId() });
        renderList();
      },
    } });
  };
  fileBtn.addEventListener('click', () => importFile(null));
  content.addEventListener('dragover', event => {
    if (!event.dataTransfer?.types.includes('Files')) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    content.classList.add('reconcile-file-drop');
  });
  content.addEventListener('dragleave', event => {
    if (!content.contains(event.relatedTarget)) content.classList.remove('reconcile-file-drop');
  });
  content.addEventListener('drop', event => {
    event.preventDefault();
    content.classList.remove('reconcile-file-drop');
    const files = event.dataTransfer?.files;
    if (files?.length > 1) { toast(t('reconcile.importOneFile')); return; }
    if (files?.[0]) importFile(files[0]);
  });
  barActions.append(addTxBtn, findBtn, fileBtn, clearAllLabel);
  listBar.append(listCount, barActions);
  content.append(listBar);

  // Inline add-tx panel (hidden by default).
  const addPanel = document.createElement('div');
  // Surface, not sunken: the .field inputs and selects inside are sunken with
  // no border, so on a sunken panel they had no visible edge at all.
  addPanel.style.cssText = 'display:none;border:1px solid var(--border);border-radius:6px;padding:12px;margin-bottom:10px;background:var(--surface);';
  content.append(addPanel);

  // Scheduled-but-not-yet-posted section (populated in renderScheduled).
  const scheduledWrap = document.createElement('div');
  scheduledWrap.style.cssText = 'display:none;border:1px dashed var(--border);border-radius:6px;padding:8px 10px;margin-bottom:10px;font-size:12px;';
  const scheduledTitle = document.createElement('div');
  scheduledTitle.style.cssText = 'color:var(--muted);margin-bottom:6px;';
  scheduledTitle.textContent = t('reconcile.scheduledTitle');
  const scheduledList = document.createElement('div');
  scheduledList.style.cssText = 'display:flex;flex-direction:column;gap:4px;';
  scheduledWrap.append(scheduledTitle, scheduledList);
  content.append(scheduledWrap);

  const undatedWrap = document.createElement('div');
  undatedWrap.className = 'reconcile-undated';
  content.append(undatedWrap);

  // Table wrapper.
  const tableWrap = document.createElement('div');
  tableWrap.style.cssText = 'border:1px solid var(--border);border-radius:6px;max-height:45vh;overflow:auto;';
  tableWrap.setAttribute('data-scroll-cue', '');
  const table = document.createElement('table');
  table.style.cssText = 'width:100%;min-width:620px;border-collapse:collapse;font-size:13px;';
  table.setAttribute('aria-label', t('reconcile.title')(account.name || ''));
  const thead = document.createElement('thead');
  thead.style.cssText = 'background:var(--bg-sunken, #f5f5f7);position:sticky;top:0;';
  const theadRow = document.createElement('tr');
  // Empty visual headers for the checkbox and actions columns get a
  // screen-reader-only label so AT can announce the column purpose.
  const headers = [
    { label: t('reconcile.columnSelect') || 'Select', sr: true },
    { label: t('reconcile.columnDate') },
    { label: t('reconcile.columnPayee') },
    { label: t('addTx.envelope') },
    { label: t('reconcile.columnAmount') },
    { label: t('reconcile.columnActions') || 'Actions', sr: true },
  ];
  headers.forEach((h, i) => {
    const th = document.createElement('th');
    th.scope = 'col';
    th.style.cssText = `padding:6px 10px;text-align:${i === 4 ? 'right' : 'left'};${i === 0 ? 'width:32px;' : ''}${i === 1 || i === 4 ? 'width:1%;white-space:nowrap;' : ''}${i === 3 ? 'width:24%;' : ''}${i === 5 ? 'width:56px;' : ''}`;
    if (h.sr) {
      th.textContent = '';
      const sr = document.createElement('span');
      sr.textContent = h.label;
      sr.style.cssText = 'position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0;';
      th.append(sr);
    } else {
      th.textContent = h.label;
    }
    theadRow.append(th);
  });
  thead.append(theadRow);
  const tbody = document.createElement('tbody');
  table.append(thead, tbody);
  tableWrap.append(table);
  content.append(tableWrap);

  // Empty-state placeholder (shown when no visible uncleared).
  const emptyState = document.createElement('div');
  emptyState.style.cssText = 'padding:20px;text-align:center;color:var(--muted);font-size:13px;display:none;';
  emptyState.textContent = t('reconcile.allCleared');
  tableWrap.append(emptyState);

  // Header action buttons (passed to openSheet).
  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'btn btn-ghost btn-sm';
  cancelBtn.textContent = t('reconcile.cancel');
  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.className = 'btn btn-accent btn-sm';
  saveBtn.textContent = t('reconcile.save');

  // ── State ──────────────────────────────────────────────────────────────
  const selected = new Set(); // tx ids checked for reconcile
  // newlyAddedTxs: txs created via the inline form during this session.
  // They are recorded only on save (transaction.record steps in the same
  // batch as account.reconcile) so a cancelled reconcile doesn't leave
  // orphan saves. Their ids are local to the sheet; the command gives each
  // its own. They're pre-selected by default.
  const newlyAddedTxs = [];
  let statementContext = null;
  // Stored rows are overlaid for the preview and amended only in the Save batch.
  const stagedEdits = new Map();
  function workingTransactions() {
    return state.transactions.map(tx => stagedEdits.get(tx.id)?.tx || tx);
  }
  function occurrenceKeys() {
    const keys = takenOccurrenceKeys(state.transactions, getTombstones(state.meta));
    for (const tx of newlyAddedTxs) if (tx.from_budget) keys.add(tx.from_budget);
    for (const key of linkKeys.values()) keys.add(key);
    for (const { tx } of stagedEdits.values()) if (tx.from_budget) keys.add(tx.from_budget);
    return keys;
  }
  function plannedForecasts() {
    const [year, month] = getReconcileDate().split('-').map(Number);
    const start = `${year}-${String(month).padStart(2, '0')}-01`;
    const anchor = new Date(year, month - 1, 0);
    const end = `${year + 1}-${String(month).padStart(2, '0')}-01`;
    const plans = (state.budgetItems || []).filter(item => item.kind === 'expense' || item.kind === 'income');
    const forecasts = forecastScheduledTransactions(plans, state.accounts || [],
      state.envelopes || [], anchor, end, null, state.meta?.country ?? 'FI', { transactions: state.transactions })
      .filter(tx => (tx.type === 'expense' || tx.type === 'income') && tx.date < end);
    // A manual payment can settle a plan without a from_budget occurrence key.
    // Use the Transactions view's matching rules, but leave uncleared payments
    // available for explicit reuse. Net before filtering taken keys so a payment
    // is consumed by its original occurrence, never a later month's invoice.
    const unpaid = netForecastAgainstRealPayments(forecasts, {
      transactions: state.transactions.filter(tx => tx.cleared), windowFromStr: start, windowToStr: end,
    });
    const unpaidKeys = new Set(unpaid.map(scheduledRowKey));
    return { unpaid, clearedKeys: new Set(forecasts.map(scheduledRowKey).filter(key => !unpaidKeys.has(key))) };
  }
  function plannedMatchTaken(source) {
    const key = scheduledRowKey(source);
    return occurrenceKeys().has(key) || plannedForecasts().clearedKeys.has(key);
  }
  function findCandidates() {
    const taken = occurrenceKeys();
    const booked = state.transactions.filter(tx => !tx.cleared && !stagedEdits.has(tx.id)
      && (tx.type === 'expense' || tx.type === 'income'))
      .map(tx => ({ tx, booked: true, month: tx.from_budget?.split(':').at(-1) || '' }));
    const forecasts = plannedForecasts().unpaid.filter(tx => !taken.has(scheduledRowKey(tx)))
      .sort((a, b) => a.date.localeCompare(b.date));
    const nextByPlan = new Map();
    for (const tx of forecasts) {
      if (!nextByPlan.has(tx.forecast_budget_item_id)) {
        nextByPlan.set(tx.forecast_budget_item_id, { tx, booked: false, month: tx.forecast_month_key });
      }
    }
    return [...booked, ...nextByPlan.values()].sort((a, b) => (a.tx.date || '').localeCompare(b.tx.date || '')
      || (a.tx.payee || '').localeCompare(b.tx.payee || ''));
  }
  async function stageMatch(candidate, fields) {
    const source = candidate.tx;
    if (candidate.booked) {
      const original = stagedEdits.get(source.id)?.original || source;
      const live = state.transactions.find(tx => tx.id === source.id);
      if (!live || live.cleared || JSON.stringify(live) !== JSON.stringify(original)) return false;
      stagedEdits.set(source.id, { original, tx: { ...source, ...fields, status: 'posted', cleared: false } });
      selected.add(source.id);
    } else {
      if (plannedMatchTaken(source)) return false;
      const available = [...workingTransactions(), ...newlyAddedTxs].filter(tx => !tx.cleared && !linkKeys.has(tx.id));
      const matches = [...new Map([
        ...untaggedMatchesForScheduledRow(source, available, source.account),
        ...untaggedMatchesForScheduledRow({ ...source, ...fields }, available, accountId),
      ].map(tx => [tx.id, tx])).values()];
      if (matches.length > 1) {
        const addAnyway = await confirmDialog(t('reconcile.scheduledSimilarMany')(matches.length), {
          title: t('reconcile.scheduledLinkTitle'), okLabel: t('reconcile.scheduledAddAnyway'),
        });
        if (!addAnyway) return null;
      } else if (matches.length === 1) {
        const match = matches[0];
        const useExisting = await confirmDialog(t('reconcile.scheduledLinkOne')(match.payee || '—', fmtDateLang(match.date), fmt(txAbsAmount(match))), {
          title: t('reconcile.scheduledLinkTitle'), okLabel: t('reconcile.scheduledLinkOk'),
          cancelLabel: t('reconcile.scheduledAddAnyway'), dismissLabel: t('common.cancel'),
        });
        if (useExisting === null) return null;
        if (useExisting) {
          if (plannedMatchTaken(source)) return false;
          const local = newlyAddedTxs.findIndex(tx => tx.id === match.id);
          if (local >= 0) {
            newlyAddedTxs[local] = { ...match, ...fields, from_budget: scheduledRowKey(source) };
            selected.add(match.id);
            renderList();
            return true;
          }
          const success = await stageMatch({ tx: match, booked: true }, fields);
          if (success) stagedEdits.get(match.id).tx.from_budget = scheduledRowKey(source);
          renderList();
          return success;
        }
      }
      if (plannedMatchTaken(source)) return false;
      const tx = { ...txFromScheduledRow(source, accountId, generateId()), ...fields };
      newlyAddedTxs.push(tx);
      selected.add(tx.id);
    }
    renderList();
    return true;
  }
  function openPicker(initial = null) {
    // Recheck cleared flags and occurrence links whenever search results refresh.
    openReconcilePicker({ candidates: findCandidates, accounts: state.accounts, account,
      date: getReconcileDate(), onStage: stageMatch, initial });
  }
  // txId → from_budget: rows already in the ledger that the user linked to a
  // scheduled occurrence (Post found them first). Written on save.
  const linkKeys = new Map();

  function getReconcileDate() {
    return dateInput.value || todayIso();
  }

  function allAccountTxs() {
    return [...workingTransactions(), ...newlyAddedTxs].filter(tx => isAccountTx(tx, accountId));
  }

  function buildVisibleState() {
    return splitByCleared(account, allAccountTxs(), accountId, getReconcileDate());
  }

  function buildScheduledForecasts() {
    const recDate = getReconcileDate();
    // Window = first of reconcile-date's month through reconcile date.
    const [y, m] = recDate.split('-').map(Number);
    if (!y || !m) return [];
    // Pass a "today" that's day 0 of month → tomorrow-of-that is day 1.
    const anchor = new Date(y, m - 1, 0);
    const forecasts = forecastScheduledTransactions(
      state.budgetItems || [],
      state.accounts || [],
      state.envelopes || [],
      anchor,
      recDate,
      null,
      state.meta?.country ?? 'FI',
      { transactions: [...workingTransactions(), ...newlyAddedTxs], tombstones: [...occurrenceKeys()] },
    );
    // Dedup against already-posted real txs, occurrences the user deleted
    // (tombstones), AND session-added txs.
    return scheduledRowsForAccount(forecasts, accountId, occurrenceKeys());
  }

  // Post found a transaction the user already recorded for this occurrence.
  // Link it (it becomes the payment, and is ticked) rather than add a second
  // copy. Returns true when the caller should not post.
  async function linkExistingInstead(f) {
    // A loan payment posts as its legs together; there is no single row to link.
    if (Array.isArray(f.legs)) return false;
    const matches = untaggedMatchesForScheduledRow(f, [...workingTransactions(), ...newlyAddedTxs], accountId)
      .filter(tx => !linkKeys.has(tx.id));
    if (matches.length === 0) return false;
    if (matches.length > 1) {
      const addAnyway = await confirmDialog(t('reconcile.scheduledSimilarMany')(matches.length), {
        title: t('reconcile.scheduledLinkTitle'), okLabel: t('reconcile.scheduledAddAnyway'),
      });
      return !addAnyway;
    }
    const [match] = matches;
    const link = await confirmDialog(
      t('reconcile.scheduledLinkOne')(match.payee || '—', fmtDateLang(match.date) || match.date, fmt(txAbsAmount(match))),
      {
        title: t('reconcile.scheduledLinkTitle'),
        okLabel: t('reconcile.scheduledLinkOk'),
        cancelLabel: t('reconcile.scheduledAddAnyway'),
        dismissLabel: t('common.cancel'),
      },
    );
    if (link === null) return true; // dismissed: do neither
    if (!link) return false;        // add a new row anyway
    const key = scheduledRowKey(f);
    const added = newlyAddedTxs.find(tx => tx.id === match.id);
    if (added) added.from_budget = key; else linkKeys.set(match.id, key);
    selected.add(match.id);
    renderList();
    return true;
  }

  function renderScheduled() {
    const items = buildScheduledForecasts();
    scheduledList.innerHTML = '';
    if (items.length === 0) {
      scheduledWrap.style.display = 'none';
      return;
    }
    scheduledWrap.style.display = '';
    items.forEach(f => {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:8px;font-variant-numeric:tabular-nums;';
      const d = document.createElement('span');
      d.style.cssText = 'color:var(--muted);min-width:96px;';
      d.textContent = fmtDateLang(f.date) || f.date;
      const p = document.createElement('span');
      p.style.flex = '1';
      p.textContent = f.payee || '';
      const a = document.createElement('span');
      // `f.amount` is always a positive magnitude (scheduledForecastRow does
      // `Math.abs(occ.amount)` for every kind); the account-side sign comes
      // from `txAccountDelta`, same as a real posted tx (summed over a loan
      // payment's legs).
      const signed = scheduledRowDelta(f, accountId);
      a.style.cssText = `min-width:80px;text-align:right;white-space:nowrap;${signed < 0 ? 'color:var(--danger-text);' : 'color:var(--success-text);'}`;
      a.textContent = fmt(signed, { signed: true });
      const editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.className = 'btn btn-ghost';
      editBtn.title = t('reconcile.addTxEdit');
      editBtn.textContent = '✎';
      editBtn.style.cssText = 'padding:2px 6px;font-size:13px;';
      editBtn.addEventListener('click', () => {
        addPanel.dataset.fromBudget = scheduledRowKey(f);
        buildAddPanel({
          type: f.type,
          date: f.date,
          amount: Math.abs(f.amount ?? 0),
          payee: f.payee || '',
          envelope_id: f.type === 'expense' ? (f.envelope_id || null) : null,
          from_account: f.from_account,
          to_account: f.to_account,
        });
        addPanel.style.display = 'block';
        addTxBtn.disabled = true;
      });

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn btn-ghost';
      btn.style.cssText = 'padding:2px 8px;font-size:12px;';
      btn.textContent = t('reconcile.scheduledPost');
      btn.addEventListener('click', async () => {
        if (await linkExistingInstead(f)) return;
        for (const real of txsFromScheduledRow(f, accountId, generateId)) {
          newlyAddedTxs.push(real);
          selected.add(real.id);
        }
        renderList();
      });
      // The add panel edits one row; a loan payment is posted whole. Its edit
      // button keeps its place (hidden) so the amounts stay in one column.
      if (Array.isArray(f.legs)) {
        editBtn.disabled = true;
        editBtn.tabIndex = -1;
        editBtn.setAttribute('aria-hidden', 'true');
        editBtn.style.visibility = 'hidden';
      }
      row.append(d, p, a, editBtn, btn);
      scheduledList.append(row);
    });
  }

  // Map<id, delta> for the currently rendered uncleared rows. Rebuilt on
  // every renderList(). Lets the totals block and the master "select all" sync run
  // off in-memory state instead of re-querying the DOM on every checkbox tick.
  let visibleDeltas = new Map();

  function renderList() {
    const { clearedBaseline, uncleared, undated } = buildVisibleState();
    undatedWrap.replaceChildren();
    if (undated.length) {
      const warning = document.createElement('p');
      warning.textContent = t('coreError.reconcileUndated');
      undatedWrap.append(warning);
      for (const tx of undated) {
        const button = document.createElement('button');
        button.className = 'btn btn-ghost btn-sm';
        button.textContent = `${tx.payee || tx.id} — ${t('reconcile.addTxEdit')}`;
        button.addEventListener('click', () => openEditTx(tx, { onAfterChange: renderList }));
        undatedWrap.append(button);
      }
    }
    renderScheduled();

    // Drop selections for txs no longer visible (e.g. reconcile date moved earlier).
    const visibleIds = new Set(uncleared.map(x => x.tx.id));
    for (const id of [...selected]) if (!visibleIds.has(id)) selected.delete(id);
    visibleDeltas = new Map(uncleared.map(({ tx, delta }) => [tx.id, delta]));
    // Imported rows after the statement date still need review/removal. Show
    // them, but never let them count toward this reconciliation's clear total.
    const displayRows = [...uncleared, ...newlyAddedTxs
      .filter(tx => tx.importFilename && tx.date > getReconcileDate())
      .map(tx => ({ tx, delta: txAccountDelta(tx, accountId), afterDate: true }))]
      .sort((a, b) => b.tx.date.localeCompare(a.tx.date));

    tbody.innerHTML = '';
    if (displayRows.length === 0) {
      tableWrap.style.borderStyle = 'dashed';
      table.style.display = 'none';
      emptyState.style.display = 'block';
    } else {
      tableWrap.style.borderStyle = '';
      table.style.display = '';
      emptyState.style.display = 'none';
      displayRows.forEach(({ tx, delta, afterDate }) => {
        const tr = document.createElement('tr');

        const tdCb = document.createElement('td');
        tdCb.style.cssText = 'padding:6px 10px;';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.dataset.id = tx.id;
        cb.dataset.delta = String(delta);
        cb.className = 'rec-check';
        cb.checked = selected.has(tx.id);
        cb.disabled = !!afterDate;
        const cbLabel = (tx.payee || tx.description || tx.type || 'transaction').toString();
        cb.setAttribute('aria-label',
          `${t('reconcile.markCleared') || 'Mark cleared'}: ${cbLabel} ${tx.date || ''} ${fmt(Math.abs(delta))}`.trim());
        cb.addEventListener('change', onCheckboxChange);
        tdCb.append(cb);
        if (stagedEdits.has(tx.id) || newlyAddedTxs.some(n => n.id === tx.id)) tr.style.fontStyle = 'italic';

        const tdDate = document.createElement('td');
        tdDate.style.cssText = 'padding:6px 10px;font-variant-numeric:tabular-nums;white-space:nowrap;';
        tdDate.textContent = fmtDateLang(tx.date) || (tx.date || '—');

        const tdLabel = document.createElement('td');
        tdLabel.style.cssText = 'padding:6px 10px;overflow-wrap:anywhere;';
        tdLabel.textContent = tx.payee || tx.description || tx.note || tx.type || '';
        if (tx.importFilename) {
          const source = document.createElement('span');
          source.className = 'reconcile-import-source';
          source.textContent = ' 📄';
          source.title = t('reconcile.importSource')(tx.importFilename);
          source.setAttribute('aria-label', source.title);
          tdLabel.append(source);
          if (afterDate) {
            const hint = document.createElement('div');
            hint.className = 'field-note';
            hint.textContent = t('reconcile.importAfterDate');
            tdLabel.append(hint);
          }
          if (tx.importMatch) {
            const warning = document.createElement('div');
            warning.className = 'field-note field-note--warn';
            const match = tx.importMatch;
            warning.textContent = `⚠ ${t('reconcile.importPossible')} · ${fmtDateLang(match.date)} · ${match.payee || ''} · ${fmt(txAccountDelta(match, accountId), { signed: true })}`;
            tdLabel.append(warning);
          }
        }

        const tdEnvelope = document.createElement('td');
        tdEnvelope.className = 'reconcile-envelope';
        tdEnvelope.style.cssText = 'padding:6px 10px;overflow-wrap:anywhere;color:var(--muted);';
        const envelopeIds = tx.envelope_splits?.length
          ? tx.envelope_splits.map(split => split.envelope_id) : [tx.envelope_id];
        tdEnvelope.textContent = [...new Set(envelopeIds)].map(id => {
          if (id === '__none__') return t('transactions.noEnvelopeCell');
          if (!id) return tx.type === 'expense' ? t('common.unassigned') : '—';
          return trEnv(state.envelopes.find(envelope => envelope.id === id)) || id;
        }).join(', ');

        const tdAmt = document.createElement('td');
        const color = delta < 0 ? 'color:var(--danger-text);' : 'color:var(--success-text);';
        tdAmt.style.cssText = `padding:6px 10px;text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap;${color}`;
        tdAmt.textContent = fmt(delta, { signed: true });

        const tdActions = document.createElement('td');
        tdActions.style.cssText = 'padding:6px 10px;text-align:right;white-space:nowrap;';
        const isNewlyAdded = newlyAddedTxs.some(n => n.id === tx.id);
        if (stagedEdits.has(tx.id)) {
          const edit = document.createElement('button');
          edit.type = 'button'; edit.className = 'btn btn-ghost btn-sm';
          edit.textContent = t('reconcile.addTxEdit');
          edit.addEventListener('click', () => openPicker({ tx, booked: true, month: tx.from_budget?.split(':').at(-1) || '' }));
          const undo = document.createElement('button');
          undo.type = 'button'; undo.className = 'btn btn-ghost btn-sm';
          undo.textContent = t('reconcile.undoMatch');
          undo.addEventListener('click', () => { stagedEdits.delete(tx.id); selected.delete(tx.id); renderList(); });
          tdActions.append(edit, undo);
        } else if (isNewlyAdded) {
          const editBtn = document.createElement('button');
          editBtn.type = 'button';
          editBtn.className = 'btn btn-ghost';
          editBtn.title = t('reconcile.addTxEdit');
          editBtn.textContent = '✎';
          editBtn.style.cssText = 'padding:2px 6px;font-size:13px;margin-right:4px;';
          editBtn.addEventListener('click', () => {
            if (tx.from_budget) addPanel.dataset.fromBudget = tx.from_budget;
            else delete addPanel.dataset.fromBudget;
            buildAddPanel(tx);
            addPanel.style.display = 'block';
            addTxBtn.disabled = true;
          });
          const rmBtn = document.createElement('button');
          rmBtn.type = 'button';
          rmBtn.className = 'btn btn-ghost';
          rmBtn.title = t('reconcile.addTxRemove');
          rmBtn.textContent = '×';
          rmBtn.style.cssText = 'padding:2px 6px;font-size:14px;color:var(--danger-text);';
          rmBtn.addEventListener('click', () => {
            const idx = newlyAddedTxs.findIndex(n => n.id === tx.id);
            if (idx >= 0) newlyAddedTxs.splice(idx, 1);
            selected.delete(tx.id);
            renderList();
          });
          tdActions.append(editBtn, rmBtn);
        } else {
          const editBtn = document.createElement('button');
          editBtn.type = 'button';
          editBtn.className = 'btn btn-ghost';
          editBtn.title = t('reconcile.addTxEdit');
          editBtn.textContent = '✎';
          editBtn.style.cssText = 'padding:2px 6px;font-size:13px;';
          editBtn.addEventListener('click', () => {
            openEditTx(tx, { onAfterChange: () => renderList() });
          });
          tdActions.append(editBtn);
        }
        tr.append(tdCb, tdDate, tdLabel, tdEnvelope, tdAmt, tdActions);
        tbody.append(tr);
      });
    }

    listCount.textContent = uncleared.length === 0
      ? ''
      : t('reconcile.uncleared')(uncleared.length);

    // Update "all-selected" state on the master checkbox.
    clearAllCb.checked = uncleared.length > 0 && uncleared.every(({ tx }) => selected.has(tx.id));

    updateTotals(clearedBaseline);
  }

  // The statement figure goes through the same reader as every other amount
  // field in the app — it used to have a hand-rolled one that mangled grouped
  // input.
  function parseTarget() {
    const n = parseAmountInput(targetInput.value || '');
    return Number.isFinite(n) ? n : null;
  }

  function selectedDeltas() {
    return [...selected].map(id => visibleDeltas.get(id));
  }

  // The app's money format, sign included ("€ −588,97", "€ +12,00"), not a
  // hyphen glued in front of the symbol.
  function signedFmt(v) {
    return fmt(v, { signed: true });
  }

  function updateTotals(clearedBaseline) {
    const { newly, total, gap, balanced } = reconcileTotals({
      clearedBaseline,
      selectedDeltas: selectedDeltas(),
      target: parseTarget(),
    });
    alreadyEl.textContent = signedFmt(clearedBaseline);
    newlyEl.textContent   = signedFmt(newly);
    totalEl.textContent   = signedFmt(total);
    if (gap === null) {
      diffEl.textContent = '—';
      diffEl.style.color = 'var(--muted)';
    } else {
      diffEl.textContent = fmt(gap);
      diffEl.style.color = balanced ? 'var(--success)' : 'var(--danger)';
    }
  }

  function recompute() {
    const { clearedBaseline } = buildVisibleState();
    updateTotals(clearedBaseline);
  }

  function onCheckboxChange(e) {
    const id = e.target.dataset.id;
    if (e.target.checked) selected.add(id); else selected.delete(id);
    // Keep master "select all" state in sync — derive from in-memory state.
    clearAllCb.checked = visibleDeltas.size > 0
      && [...visibleDeltas.keys()].every(k => selected.has(k));
    recompute();
  }

  clearAllCb.addEventListener('change', () => {
    const on = clearAllCb.checked;
    // Update model first, then re-render the rows from authoritative state.
    for (const id of visibleDeltas.keys()) {
      if (on) selected.add(id); else selected.delete(id);
    }
    for (const cb of tbody.querySelectorAll('.rec-check')) cb.checked = !cb.disabled && on;
    recompute();
  });

  targetInput.addEventListener('input', recompute);

  dateInput.addEventListener('change', () => {
    const min = account.lastReconciledAt;
    if (min && dateInput.value && dateInput.value < min) {
      alertDialog(t('reconcile.dateBeforeLast'), { title: t('reconcile.date') });
      dateInput.value = min;
    }
    renderList();
  });

  // ── Inline add-tx form ─────────────────────────────────────────────────
  // editingId: when set, save replaces the newly-added tx with that id.
  let editingId = null;
  function buildAddPanel(prefill) {
    addPanel.innerHTML = '';
    editingId = prefill?.id || null;

    // Payee index: lowercase name → most-recent tx for that payee.
    // Same pattern as pages/add-tx.js, but we only use it to prefill the
    // envelope (account is fixed to the reconciled account).
    const payeeMap = new Map();
    [...state.transactions, ...newlyAddedTxs]
      .filter(tx => tx.payee && tx.payee.trim())
      .sort((a, b) => (b.date || '').localeCompare(a.date || ''))
      .forEach(tx => {
        const key = tx.payee.trim().toLowerCase();
        if (!payeeMap.has(key)) payeeMap.set(key, tx);
      });

    // Row 1: Payee · Type · Amount · Date. Payee takes the slack; Type fits its
    // widest option; Amount is capped (amounts past ~1M are implausible); Date is
    // sized to the native control so it never grows wider than it needs.
    const row1 = document.createElement('div');
    row1.style.cssText = 'display:grid;grid-template-columns:minmax(0,1fr) 160px 130px max-content;gap:8px;margin-bottom:8px;';
    const payeeWrap = smallField(t('addTx.payee'), 'text', prefill?.payee || '');
    const payeeInput = payeeWrap.querySelector('input');

    // Native datalist dropdown for payee autocompletion.
    const datalistId = `rec-payee-suggestions-${accountId}`;
    const datalist = document.createElement('datalist');
    datalist.id = datalistId;
    payeeMap.forEach(tx => {
      const o = document.createElement('option');
      o.value = tx.payee.trim();
      datalist.append(o);
    });
    payeeInput.setAttribute('list', datalistId);
    payeeWrap.append(datalist);

    const amtWrap = smallField(t('addTx.amount'), 'number', prefill ? String(prefill.amount ?? '') : '');
    amtWrap.querySelector('input').step = '0.01';
    amtWrap.querySelector('input').min = '0';
    enableFormulaInput(amtWrap.querySelector('input'));
    const dateWrap2 = smallField(t('addTx.date'), 'date', prefill?.date || getReconcileDate());

    // Type select. Transfers and investments swap the Envelope field (row 2) for
    // the Other-account picker.
    const typeWrap = document.createElement('div');
    typeWrap.className = 'field';
    typeWrap.style.marginBottom = '0';
    const typeLbl = document.createElement('label');
    typeLbl.textContent = t('editTx.type');
    const typeSel = document.createElement('select');
    typeSel.style.cssText = 'padding:6px 8px;font-size:14px;';
    const oExp = document.createElement('option'); oExp.value = 'expense'; oExp.textContent = t('reconcile.addTxTypeExpense');
    const oInc = document.createElement('option'); oInc.value = 'income';  oInc.textContent = t('reconcile.addTxTypeIncome');
    const oXfrOut = document.createElement('option'); oXfrOut.value = 'transfer_out'; oXfrOut.textContent = t('reconcile.addTxTypeTransferOut');
    const oXfrIn  = document.createElement('option'); oXfrIn.value  = 'transfer_in';  oXfrIn.textContent  = t('reconcile.addTxTypeTransferIn');
    const oInvOut = document.createElement('option'); oInvOut.value = 'investment_out'; oInvOut.textContent = t('reconcile.addTxTypeInvestmentOut');
    const oInvIn  = document.createElement('option'); oInvIn.value  = 'investment_in';  oInvIn.textContent  = t('reconcile.addTxTypeInvestmentIn');
    typeSel.append(oExp, oInc, oXfrOut, oXfrIn, oInvOut, oInvIn);
    typeWrap.append(typeLbl, typeSel);
    row1.append(payeeWrap, typeWrap, amtWrap, dateWrap2);

    // Row 2: Envelope (or the Other-account picker, for transfers/investments)
    // plus Note. Envelope is narrower than Note — envelope names are short.
    const row2 = document.createElement('div');
    row2.style.cssText = 'display:flex;gap:8px;margin-bottom:8px;align-items:flex-start;';

    const envWrap = document.createElement('div');
    envWrap.className = 'field';
    envWrap.style.cssText = 'flex:1;margin-bottom:0;';
    const envLbl = document.createElement('label');
    envLbl.textContent = t('addTx.envelope');
    const envSel = document.createElement('select');
    envSel.style.cssText = 'padding:6px 8px;font-size:14px;';
    const optPick = document.createElement('option'); optPick.value = ''; optPick.textContent = t('addTx.pickEnvelope');
    const optNone = document.createElement('option'); optNone.value = '__none__'; optNone.textContent = t('reconcile.noEnvelopeOption');
    envSel.append(optPick, optNone);
    const balances = ask('balances', { ...activeLensInput(), includeArchived: true });
    const envBalMap = new Map(balances?.envelopes.map(e => [e.id, e.balance]) ?? []);
    state.envelopes.filter(e => !e.archived).forEach(e => {
      const o = document.createElement('option');
      o.value = e.id;
      o.textContent = balances ? `${trEnv(e)} — ${fmt(envBalMap.get(e.id) ?? 0)}` : trEnv(e);
      envSel.append(o);
    });
    if (prefill?.envelope_id) {
      if ([...envSel.options].some(o => o.value === prefill.envelope_id)) envSel.value = prefill.envelope_id;
    }
    envWrap.append(envLbl, envSel);

    const otherAcctWrap = document.createElement('div');
    otherAcctWrap.className = 'field';
    otherAcctWrap.style.marginBottom = '0';
    const otherAcctLbl = document.createElement('label');
    const otherAcctSel = document.createElement('select');
    otherAcctSel.style.cssText = 'padding:6px 8px;font-size:14px;';
    // A prefilled counterpart (✎ on a planned transfer) stays in the list even
    // when it is archived or an asset, rather than silently becoming the
    // first account offered.
    const keepCounterpart = prefill && (prefill.from_account === accountId ? prefill.to_account
      : prefill.to_account === accountId ? prefill.from_account : null);
    transferCounterpartOptions(state.accounts, accountId, keepCounterpart).forEach(a => {
      const o = document.createElement('option');
      o.value = a.id;
      o.textContent = a.kept && a.archived ? `${a.name} · ${t('addTx.archivedSuffix')}` : a.name;
      otherAcctSel.append(o);
    });
    otherAcctWrap.style.flex = '1';
    otherAcctWrap.append(otherAcctLbl, otherAcctSel);
    otherAcctWrap.style.display = 'none';

    const noteField = smallField(t('editTx.note'), 'text', prefill?.note || '');
    noteField.style.flex = '2';

    // Units, for the investment types only. A sale needs them: a sell with no
    // units can never close the position (holdings skip it), so
    // transaction.record refuses one. A buy may leave them blank.
    const unitsField = smallField(t('addTx.units'), 'number', prefill?.units != null ? String(prefill.units) : '');
    const unitsInput = unitsField.querySelector('input');
    unitsInput.step = '0.000001';
    unitsInput.min = '0';
    unitsInput.inputMode = 'decimal';
    unitsInput.placeholder = t('addTx.unitsPh');
    enableFormulaInput(unitsInput, { decimals: 6 });
    attachFieldHint(unitsField, unitsInput);
    unitsInput.addEventListener('input', () => setFieldHint(unitsField, ''));
    unitsField.style.flex = '1';
    unitsField.style.display = 'none';

    typeSel.addEventListener('change', () => {
      const v = typeSel.value;
      const usesAccount = v === 'transfer_out' || v === 'transfer_in' || v === 'investment_out' || v === 'investment_in';
      const isIncoming = v === 'transfer_in' || v === 'investment_in';
      envWrap.style.display = usesAccount ? 'none' : '';
      otherAcctWrap.style.display = usesAccount ? '' : 'none';
      unitsField.style.display = v === 'investment_out' || v === 'investment_in' ? '' : 'none';
      setFieldHint(unitsField, '');
      otherAcctLbl.textContent = isIncoming
        ? t('reconcile.addTxFromAccount')
        : t('reconcile.addTxToAccount');
    });

    row2.append(envWrap, otherAcctWrap, unitsField, noteField);

    // Prefill envelope (and type) from the most-recent tx for this payee.
    // The account is NOT prefilled — it's fixed to the reconciled account.
    const trySetSelect = (sel, value) => {
      if (!value) return;
      if ([...sel.options].some(o => o.value === value)) sel.value = value;
    };
    payeeInput.addEventListener('input', () => {
      const key = payeeInput.value.trim().toLowerCase();
      if (!payeeMap.has(key)) return;
      const tx = payeeMap.get(key);
      if (tx.type === 'account_transfer' || tx.type === 'investment_transfer') return;
      trySetSelect(envSel, tx.envelope_id || '');
      if (tx.type === 'income' || tx.type === 'expense') {
        trySetSelect(typeSel, tx.type);
      }
    });

    // Apply prefill for type/transfer direction now that all controls exist.
    if (prefill) {
      if (prefill.type === 'account_transfer' || prefill.type === 'investment_transfer') {
        const isInv = prefill.type === 'investment_transfer';
        if (prefill.from_account === accountId) {
          typeSel.value = isInv ? 'investment_out' : 'transfer_out';
          if ([...otherAcctSel.options].some(o => o.value === prefill.to_account)) otherAcctSel.value = prefill.to_account;
        } else if (prefill.to_account === accountId) {
          typeSel.value = isInv ? 'investment_in' : 'transfer_in';
          if ([...otherAcctSel.options].some(o => o.value === prefill.from_account)) otherAcctSel.value = prefill.from_account;
        }
      } else if (prefill.type === 'expense' || prefill.type === 'income') {
        typeSel.value = prefill.type;
      }
      typeSel.dispatchEvent(new Event('change'));
    }

    // Row 3: action buttons, right-aligned (Note now lives in row 2).
    const row3 = document.createElement('div');
    row3.style.cssText = 'display:flex;justify-content:flex-end;gap:8px;';
    const cancelAdd = document.createElement('button');
    cancelAdd.type = 'button';
    cancelAdd.className = 'btn btn-ghost';
    cancelAdd.style.flexShrink = '0';
    cancelAdd.textContent = t('reconcile.addTxCancel');
    const saveAdd = document.createElement('button');
    saveAdd.type = 'button';
    saveAdd.className = 'btn btn-accent';
    saveAdd.style.flexShrink = '0';
    saveAdd.textContent = t(editingId ? 'reconcile.addTxEdit' : 'reconcile.addTxSave');
    row3.append(cancelAdd, saveAdd);

    addPanel.append(row1, row2, row3);

    cancelAdd.addEventListener('click', () => {
      delete addPanel.dataset.fromBudget;
      addPanel.style.display = 'none';
      addTxBtn.disabled = false;
    });

    saveAdd.addEventListener('click', () => {
      const payee = payeeWrap.querySelector('input').value.trim();
      const amount = parseAmountInput(amtWrap.querySelector('input').value);
      const date = dateWrap2.querySelector('input').value;
      const type = typeSel.value;
      const note = noteField.querySelector('input').value.trim() || null;
      const isTransfer = type === 'transfer_out' || type === 'transfer_in';
      const isInvestment = type === 'investment_out' || type === 'investment_in';
      const usesAccount = isTransfer || isInvestment;
      if ((!usesAccount && !payee) || !(amount > 0) || !date) {
        toast(t('reconcile.addTxInvalid'));
        return;
      }
      let units = null;
      if (isInvestment) {
        const raw = unitsInput.value.trim();
        const n = raw ? parseAmountInput(raw) : NaN;
        const valid = Number.isFinite(n) && n > 0;
        const problem = type === 'investment_in' && !valid ? t('addTx.investmentSellNeedsUnits')
          : raw && !valid ? t('reconcile.addTxUnitsInvalid') : '';
        setFieldHint(unitsField, problem);
        if (problem) { unitsInput.focus(); return; }
        if (valid) units = n;
      }
      // Capture context flags before they're cleared below — they decide
      // whether to close the panel or keep it open for another entry.
      const wasEditing = !!editingId;
      const wasFromBudget = !!addPanel.dataset.fromBudget;
      const tx = buildManualTx({
        type, accountId, otherAccountId: usesAccount ? otherAcctSel.value : null,
        date, payee, amount, note, envelopeId: envSel.value || null, id: generateId(),
      });
      if (!tx) { toast(t('reconcile.addTxInvalid')); return; }
      if (units !== null) tx.units = units;
      if (addPanel.dataset.fromBudget) {
        tx.from_budget = addPanel.dataset.fromBudget;
        delete addPanel.dataset.fromBudget;
      }
      if (editingId) {
        const idx = newlyAddedTxs.findIndex(n => n.id === editingId);
        const original = newlyAddedTxs[idx];
        if (original?.importFilename) {
          tx.importFilename = original.importFilename;
          tx.importMatch = original.importMatch;
          tx.source = original.source;
        }
        const wasSelected = selected.has(editingId);
        if (idx >= 0) newlyAddedTxs.splice(idx, 1);
        selected.delete(editingId);
        if (wasSelected) selected.add(tx.id);
        editingId = null;
      }
      newlyAddedTxs.push(tx);
      if (!wasEditing) selected.add(tx.id); // preserve edited rows' clear choice
      renderList();
      // Reconciliation typically means entering several transactions in a row.
      // For fresh additions (not edits, not budget-prefills) rebuild the panel
      // with just the date preserved so the user can keep typing.
      if (wasEditing || wasFromBudget) {
        addPanel.style.display = 'none';
        addTxBtn.disabled = false;
      } else {
        buildAddPanel({ date });
        addPanel.style.display = 'block';
        addTxBtn.disabled = true;
        const firstInput = addPanel.querySelector('input');
        if (firstInput) firstInput.focus();
      }
    });
  }

  function smallField(label, type, value) {
    const wrap = document.createElement('div');
    wrap.className = 'field';
    wrap.style.marginBottom = '0';
    const lbl = document.createElement('label');
    lbl.textContent = label;
    const input = document.createElement('input');
    input.type = type;
    input.value = value;
    input.style.cssText = 'padding:6px 8px;font-size:14px;box-sizing:border-box;';
    wrap.append(lbl, input);
    return wrap;
  }

  addTxBtn.addEventListener('click', () => {
    if (addPanel.style.display === 'none' || !addPanel.style.display) {
      delete addPanel.dataset.fromBudget;
      buildAddPanel();
      addPanel.style.display = 'block';
      addTxBtn.disabled = true;
    }
  });

  // ── Open sheet ─────────────────────────────────────────────────────────
  // Dismissal guard: transactions added during the session live only in
  // newlyAddedTxs until Save, so Escape/Cancel/backdrop must not silently
  // throw them away.
  let settled = false;
  let saving = false; // a Save is in flight: the sheet must not close under it
  const { close, requestClose } = openSheet({
    title: t('reconcile.title')(account.name || ''),
    content,
    onClose: () => { closed = true; if (onClose) onClose(); },
    wide: true,
    headerActions: [cancelBtn, saveBtn],
    confirmClose: () => !saving && ((newlyAddedTxs.length === 0 && stagedEdits.size === 0) || confirmDialog(t('reconcile.discardSession'))),
  });
  const heading = content.closest('.sheet').querySelector('[id^="sheet-title-"]');
  heading.append(infoButton('reconciling', { title: t('reconcile.title')(account.name || ''), intro: t('reconcile.intro') }));
  cancelBtn.addEventListener('click', requestClose);

  renderList();

  // ── Save handler ───────────────────────────────────────────────────────
  saveBtn.addEventListener('click', async () => {
    if (settled) return;
    if (generation !== currentBudgetSession() || folder !== state.budgetFolder) {
      await alertDialog(describeError({ code: 'budget_switched' }, t));
      return;
    }
    if (buildVisibleState().undated.length) {
      await alertDialog(t('coreError.reconcileUndated'));
      return;
    }
    const recDate = getReconcileDate();
    const min = account.lastReconciledAt;
    if (min && recDate < min) {
      await alertDialog(t('reconcile.dateBeforeLast'), { title: t('reconcile.date') });
      return;
    }

    const target = parseTarget();
    if (target === null) {
      await alertDialog(t('reconcile.enterBalance'), { title: t('reconcile.mismatchTitle') });
      return;
    }

    const { clearedBaseline } = buildVisibleState();
    const { gap } = reconcileTotals({
      clearedBaseline,
      selectedDeltas: selectedDeltas(),
      target,
    });

    // Whether to post an adjustment for the gap: only when the user saw the
    // gap and said yes. Without the question nothing is posted, even if the
    // command's own figure (taken when the dispatch runs) has drifted.
    let adjust = false;
    if (Math.abs(gap) >= SETTLED_EPSILON) {
      const choice = await confirmDialog(
        t('reconcile.mismatch')(fmt(gap, { signed: true })),
        {
          title: t('reconcile.mismatchTitle'),
          okLabel: t('reconcile.mismatchYes'),
          cancelLabel: t('reconcile.mismatchNo'),
          dismissLabel: t('reconcile.continueChecking'),
        },
      );
      if (choice === null) return;
      adjust = choice;
    }

    // One batch: staged booked rows are amended, then additions recorded (cleared
    // where ticked; the command gives each its own id), then account.reconcile
    // clears the ticked existing rows, links plan keys, closes the gap and
    // stamps the account, on the data the records left behind.
    // A selected source may have changed while this sheet was open. Never
    // overwrite another edit or post an occurrence that has since been paid.
    const taken = takenOccurrenceKeys(state.transactions, getTombstones(state.meta));
    for (const key of plannedForecasts().clearedKeys) taken.add(key);
    if ([...stagedEdits].some(([id, { original }]) => JSON.stringify(state.transactions.find(tx => tx.id === id)) !== JSON.stringify(original))
        || [...stagedEdits.values()].some(({ tx, original }) => tx.from_budget && tx.from_budget !== original.from_budget && taken.has(tx.from_budget))
        || newlyAddedTxs.some(tx => tx.from_budget && taken.has(tx.from_budget))) {
      await alertDialog(t('reconcile.matchChanged'));
      return;
    }
    const addedIds = new Set(newlyAddedTxs.map(tx => tx.id));
    const steps = [
      ...(newlyAddedTxs.length && statementContext ? [{ name: 'transaction.import', input: {
        rows: newlyAddedTxs.map(tx => recordStep(tx, selected.has(tx.id)).input),
        ...(statementContext ? { expectedStatement: { account: accountId, context: statementContext } } : {}),
      } }] : []),
      ...[...stagedEdits.values()].map(({ tx, original }) => ({ name: 'transaction.amend', input: {
        id: tx.id, account: tx.account, date: tx.date, amount: txAbsAmount(tx), status: 'posted', cleared: false,
        ...(tx.from_budget !== original.from_budget ? { fromBudget: tx.from_budget } : {}),
      } })),
      ...(!statementContext ? newlyAddedTxs.map(tx => recordStep(tx, selected.has(tx.id))) : []),
      {
        name: 'account.reconcile',
        input: {
          account: accountId,
          balance: target,
          date: recDate,
          clear: [...selected].filter(id => !addedIds.has(id)),
          link: [...linkKeys].map(([id, fromBudget]) => ({ id, fromBudget })),
          adjust,
          note: t('reconcile.adjustmentNote'),
          // The gap the dialog showed: the command refuses if the data moved
          // before the batch ran, rather than post another amount.
          ...(adjust ? { expectGap: round2(gap) } : {}),
          // The command refuses an investment account unless forced; this
          // sheet reconciled one when it was opened for it (the import sheet
          // can), so keep doing that.
          ...(account.type === 'investment' ? { force: true } : {}),
        },
      },
    ];

    // The sheet stays open, Save busy and Cancel off, until the write lands;
    // a failure leaves it open with the user's work intact.
    saving = true;
    cancelBtn.disabled = true;
    let r;
    try {
      r = await withBusy(saveBtn, () => dispatchBatchOrReport(session, steps), { label: t('common.saving') });
    } finally {
      saving = false;
      cancelBtn.disabled = false;
    }
    if (!r) return;
    settled = true;
    updateStatusBar();
    // The command may have read newer data than the sheet's preview.
    const outcome = r.value.value.at(-1);
    toast(t(outcome.adjusted ? 'reconcile.toastAdjusted' : Math.abs(outcome.diff) >= SETTLED_EPSILON ? 'reconcile.toastUnresolved' : 'reconcile.toastSaved'));
    close();
  });
}

/**
 * The transaction.record step for a row added in the sheet: by hand
 * (buildManualTx) or by posting a scheduled row (txFromScheduledRow), with its
 * plan key when it has one. `cleared` when the row is ticked.
 * @param {Record<string, any>} tx
 * @param {boolean} cleared
 */
function recordStep(tx, cleared) {
  /** @type {Record<string, any>} */
  const input = { type: tx.type, amount: txAbsAmount(tx), date: tx.date, payee: tx.payee ?? '' };
  if (tx.type === 'expense' || tx.type === 'income') {
    input.account = tx.account;
    input.envelope = tx.envelope_id ?? null;
  } else {
    input.fromAccount = tx.from_account;
    input.toAccount = tx.to_account;
    // A loan payment's principal comes out of its envelope, as the scheduler posts it.
    if (tx.type === 'debt_payment' && tx.envelope_id) input.envelope = tx.envelope_id;
    if (tx.type === 'investment_transfer') {
      input.direction = tx.direction;
      if (tx.units) input.units = tx.units;
    }
  }
  if (tx.note) input.note = tx.note;
  if (tx.source) input.source = tx.source;
  if (tx.from_budget) input.fromBudget = tx.from_budget;
  if (cleared) input.cleared = true;
  return { name: 'transaction.record', input };
}

/**
 * Quick "Update value" dialog for investment-type accounts. Shows the
 * Bunvelope-tracked balance, asks for the current actual value (e.g. broker
 * portfolio total), and posts an `adjustment` transaction for the delta so the
 * account balance matches reality. Envelopes are not touched.
 */
export function openInvestmentValueDialog(accountId, onClose, { suggestedValue, asset = false } = {}) {
  const account = state.accounts.find(a => a.id === accountId);
  if (!account) return;

  const balances = ask('balances', { ...activeLensInput(), includeArchived: true });
  if (!balances) return;
  const current = balances.accounts.find(a => a.id === accountId)?.balance;
  if (current == null) return;

  const content = document.createElement('div');

  const intro = document.createElement('p');
  intro.className = 'muted';
  intro.style.cssText = 'font-size:13px;margin:0 0 14px;';
  // Asset accounts (a home, gold, a mortgage) share this dialog; only the
  // wording differs, since there is no broker statement to read from.
  intro.textContent = t(asset ? 'assetValue.intro' : 'investmentValue.intro');
  content.append(intro);

  if (Number.isFinite(suggestedValue)) {
    const pre = document.createElement('p');
    pre.className = 'muted';
    pre.style.cssText = 'font-size:12px;margin:-8px 0 14px;';
    pre.textContent = t('investmentValue.prefilledHint');
    content.append(pre);
  }

  const grid = document.createElement('div');
  grid.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px;';

  const curWrap = document.createElement('div');
  curWrap.className = 'field';
  curWrap.style.marginBottom = '0';
  const curLbl = document.createElement('label');
  curLbl.textContent = t('investmentValue.tracked');
  const curVal = document.createElement('div');
  curVal.style.cssText = 'padding:10px 0;font-size:14px;font-variant-numeric:tabular-nums;';
  curVal.textContent = fmt(current);
  curWrap.append(curLbl, curVal);

  const newWrap = document.createElement('div');
  newWrap.className = 'field';
  newWrap.style.marginBottom = '0';
  const newLbl = document.createElement('label');
  newLbl.textContent = t('investmentValue.newValue');
  const newInput = document.createElement('input');
  newInput.type = 'text';
  newInput.id = 'invval-new';
  newLbl.htmlFor = newInput.id;
  newInput.inputMode = 'decimal';
  newInput.placeholder = fmtNum(current, { decimals: 2 });
  if (Number.isFinite(suggestedValue)) newInput.value = round2(suggestedValue).toFixed(2);
  newInput.style.cssText = 'padding:6px 8px;font-size:15px;';
  newWrap.append(newLbl, newInput);

  grid.append(curWrap, newWrap);
  content.append(grid);

  const dateWrap = document.createElement('div');
  dateWrap.className = 'field';
  dateWrap.style.marginBottom = '12px';
  const dateLbl = document.createElement('label');
  dateLbl.textContent = t('addTx.date');
  const dateInput = document.createElement('input');
  dateInput.type = 'date';
  dateInput.id = 'invval-date';
  dateLbl.htmlFor = dateInput.id;
  dateInput.value = todayIso();
  dateInput.style.cssText = 'padding:6px 8px;font-size:15px;';
  dateWrap.append(dateLbl, dateInput);
  content.append(dateWrap);

  const noteWrap = document.createElement('div');
  noteWrap.className = 'field';
  noteWrap.style.marginBottom = '12px';
  const noteLbl = document.createElement('label');
  noteLbl.textContent = t('editTx.note');
  const noteInput = document.createElement('input');
  noteInput.type = 'text';
  noteInput.id = 'invval-note';
  noteLbl.htmlFor = noteInput.id;
  noteInput.placeholder = t('investmentValue.notePh');
  noteInput.style.cssText = 'padding:6px 8px;font-size:15px;';
  noteWrap.append(noteLbl, noteInput);
  content.append(noteWrap);

  // A value turning negative is legitimate for a debt (an asset account is
  // "asset or debt") but is usually a typo or a missed minus on the wrong
  // account, so a flip from zero-or-above to below zero is called out here
  // and confirmed on save. A value already negative is left alone.
  const flipsNegative = (v) => v !== null && v < 0 && current >= 0;
  const negWarn = document.createElement('div');
  negWarn.className = 'invval-negative-warn';
  negWarn.setAttribute('role', 'status');
  negWarn.style.cssText = 'display:none;margin:0 0 12px;padding:8px 10px;border-radius:6px;font-size:12px;'
    + 'background:var(--warning-soft, #fff3cd);color:var(--warning, #b45309);';
  negWarn.textContent = t('investmentValue.negativeWarn');
  content.append(negWarn);

  const deltaLine = document.createElement('div');
  deltaLine.style.cssText = 'background:var(--bg-sunken, #f5f5f7);border-radius:6px;padding:10px 12px;font-size:13px;display:flex;justify-content:space-between;';
  const deltaLbl = document.createElement('span');
  deltaLbl.textContent = t('investmentValue.delta');
  const deltaVal = document.createElement('strong');
  deltaLine.append(deltaLbl, deltaVal);
  content.append(deltaLine);

  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'btn btn-ghost btn-sm';
  cancel.textContent = t('addTx.cancel');
  const save = document.createElement('button');
  save.type = 'button';
  save.className = 'btn btn-accent btn-sm';
  save.textContent = t('addTx.save');
  save.disabled = true;

  function parsedNew() {
    const n = parseAmountInput(newInput.value || '');
    return Number.isFinite(n) ? n : null;
  }
  function recomputeDelta() {
    const v = parsedNew();
    negWarn.style.display = flipsNegative(v) ? '' : 'none';
    if (v === null) {
      deltaVal.textContent = '—';
      deltaVal.style.color = '';
      save.disabled = true;
      return;
    }
    const delta = round2(v - current);
    deltaVal.textContent = fmt(delta, { signed: true });
    deltaVal.style.color = delta < -SETTLED_EPSILON ? 'var(--danger)'
      : delta > SETTLED_EPSILON ? 'var(--success)' : '';
    // Allow saving even when delta is exactly 0 — useful for refreshing
    // lastReconciledAt without changing the value? No — keep disabled to
    // avoid creating a no-op adjustment.
    save.disabled = Math.abs(delta) < SETTLED_EPSILON || !dateInput.value;
  }
  newInput.addEventListener('input', recomputeDelta);
  dateInput.addEventListener('input', recomputeDelta);
  recomputeDelta();

  // openSheet's onClose fires on every dismissal path (Escape, backdrop,
  // Cancel, post-save), so callers' refresh callbacks no longer need manual
  // invocation — Escape previously skipped them and left a stale page.
  const tracker = trackDirty(content);
  const { close, requestClose } = openSheet({
    title: t(asset ? 'assetValue.title' : 'investmentValue.title'),
    content,
    headerActions: [cancel, save],
    confirmClose: tracker.confirmClose,
    onClose: () => { onClose && onClose(); },
  });
  cancel.addEventListener('click', requestClose);

  save.addEventListener('click', async () => {
    const v = parsedNew();
    if (v === null) return;
    // The delta against the balance the dialog shows (the active lens).
    const amount = round2(v - current);
    // Only reachable when Save is disabled (recomputeDelta disables it below
    // the threshold), e.g. a programmatic click: never post a no-op adjustment.
    if (Math.abs(amount) < SETTLED_EPSILON) return;
    if (flipsNegative(v) && !(await confirmDialog(t('investmentValue.negativeConfirm')(fmt(v)),
      { title: t(asset ? 'assetValue.title' : 'investmentValue.title') }))) return;
    const input = {
      account: accountId,
      amount,
      note: noteInput.value.trim() || t(asset ? 'assetValue.defaultNote' : 'investmentValue.defaultNote'),
      date: dateInput.value,
    };
    // withBusy disables Save synchronously, so a double-click cannot post the
    // adjustment twice. The session writes first and publishes after (which
    // also marks the payee index stale), so a refused write leaves state as
    // it was.
    let r;
    try {
      r = await withBusy(save, () => session.dispatch('balance.adjust', input), { label: t('common.saving') });
    } catch (err) {
      console.error(err);
      await alertDialog(`${t('reconcile.saveFailed')}: ${err?.message || err?.name || 'unknown'}`,
        { title: t('reconcile.saveFailed') });
      return;
    }
    if (!r.ok) {
      // A version conflict gets the reload dialog and a budget switch says
      // nothing, as everywhere; any other refusal keeps this dialog's alert.
      if (SHARED_REPORT_CODES.has(r.error.code)) { reportDispatchFailure(r.error); return; }
      await alertDialog(describeError(r.error, t), { title: t('reconcile.saveFailed') });
      return;
    }
    reportMetaFailure(r);
    updateStatusBar();
    toast(t(asset ? 'assetValue.toastSaved' : 'investmentValue.toastSaved'));
    close();
  });
}
