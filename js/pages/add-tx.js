import { transactionNote } from '../ui/transaction-note.js';
import { setupFormValidation, markRequired, fieldError, focusFirstError } from '../ui/form-validation.js';
// js/pages/add-tx.js
import { state, navigate, session, activeLensInput, now as appNow } from '../app.js';
import { describeError } from '../core/errors.js';
import { openSheet, setSheetTitle } from '../ui/sheet.js';
import { txTypePicker } from '../ui/tx-type-picker.js';
import { trackDirty } from '../ui/dirty-guard.js';
import { guardSubmit } from '../ui/submit-guard.js';
import { attachFieldHint, setFieldHint } from '../ui/field-hint.js';
import { needsNoEnvelopeNote, noEnvelopeNote } from '../ui/unassigned.js';
import { rebalanceSplitLines, markAutoFilled } from '../ui/split-remainder.js';
import { toast } from '../ui/toast.js';
import { showVersionConflictDialog, reportDispatchFailure } from '../ui/save-error.js';
import { t, trEnv, fmtDateLang } from '../ui/i18n.js';
import { allPayees, findPayeeEntry } from '../state/payee-index.js';
import { appendEnvelopeOptions, envelopeOptionsHtml } from '../ui/envelope-options.js';
import { enhanceSelectWithSearch } from '../ui/select-combobox.js';
import { escHtml, fmt, fmtNum, validateAmount, filterArchivedForSelect } from '../utils.js';
import { loanItemsByLoanAccount } from '../engine.js';
import { ask } from '../ui/query.js';
import { isoDate } from '../core/context.js';
import { confirmDialog } from '../ui/dialog.js';
import { lookupSymbolForPayee, listKnownSymbolsWithNames } from '../state/investments.js';
import { askPayeeBackfill, savePayeeRule } from '../ui/payee-rule-backfill.js';
import { confirmClosedEdit } from '../ui/closed-period-guard.js';
import { overdrawnAccount } from '../ui/overdraw.js';
import { findUnmappedInvestmentTxs, showUnmappedCard } from './investments-unmapped.js';
import { trackedInvestmentAccounts } from './investments-shared.js';
import { budgetItemField } from '../ui/budget-item-field.js';
import { enableFormulaInput, enablePercentageInput, looksLikeFormula, looksLikePercentage, parseAmountInput } from '../ui/amount-input.js';

const UNALLOCATED_SENTINEL = '__unallocated__';

export function openAddTx() {
  const form = document.createElement('form');
  form.className = 'tx-editor';

  // ── Type selector ────────────────────────────────────────────────────────
  const typeWrap = document.createElement('div'); typeWrap.className = 'field';
  const typeLbl = document.createElement('label'); typeLbl.textContent = t('editTx.type');
  const typeSel = document.createElement('select');
  typeSel.style.display = 'none';
  const TX_TYPES = [
    ['expense',           t('editTx.typeExpense')],
    ['income',            t('editTx.typeIncome')],
    ['account_transfer',  t('editTx.typeTransfer')],
    ['envelope_transfer', t('addTx.typeEnvelopeTransfer')],
    ['investment_transfer', t('editTx.typeInvestment')],
  ];
  // A loan payment is offered once the budget has a loan account to pay.
  if ((state.accounts || []).some(a => a && a.type === 'loan' && !a.archived)) {
    TX_TYPES.push(['loan_payment', t('addTx.typeLoanPayment')]);
  }
  // And money lent out, once there is a loan-given account to lend through.
  if ((state.accounts || []).some(a => a && a.type === 'loan_given' && !a.archived)) {
    TX_TYPES.push(['loan_given', t('addTx.typeLoanGiven')]);
  }
  TX_TYPES.forEach(([v, label]) => {
    const o = document.createElement('option'); o.value = v; o.textContent = label;
    typeSel.append(o);
  });
  const typePicker = txTypePicker(TX_TYPES, typeSel.value, (v) => {
    typeSel.value = v;
    typeSel.dispatchEvent(new Event('change'));
  });
  typeWrap.append(typeSel, typePicker.el);
  form.append(typeWrap);

  // ── Common fields ────────────────────────────────────────────────────────
  const payee = field('payee', t('addTx.payee'), '', 'text');
  const payeeInput = payee.querySelector('input');

  const datalist = document.createElement('datalist');
  datalist.id = 'payee-suggestions-add';
  for (const payee of allPayees(state)) {
    const o = document.createElement('option');
    o.value = payee;
    datalist.append(o);
  }
  payeeInput.setAttribute('list', 'payee-suggestions-add');
  payeeInput.setAttribute('autocomplete', 'off');

  const amount = field('amount', t('addTx.amount'), '', 'number');
  amount.querySelector('input').step = '0.01';
  amount.querySelector('input').inputMode = 'decimal';
  attachFieldHint(amount);
  enableFormulaInput(amount.querySelector('input'));
  const date = field('date', t('addTx.date'), isoDate(appNow()), 'date');
  attachFieldHint(date);

  const fieldRow = document.createElement('div'); fieldRow.className = 'field-row';
  fieldRow.append(amount, date);
  form.append(payee, datalist, fieldRow);

  const noteWrap = field('note', t('editTx.note'), '', 'text');
  const noteInput = noteWrap.querySelector('input');

  // Pre-compute balances + label helpers + archived-visibility lists shared
  // across the dropdowns below. Archived accounts/envelopes only appear when
  // the matching Settings toggle is on (a fresh add has nothing pre-selected).
  const showArchivedAccts = !!(state.meta && state.meta.show_archived_accounts);
  const showArchivedEnv   = !!(state.meta && state.meta.show_archived_envelopes);
  // The labels' balances follow the active lens, archived rows included (the
  // pickers offer them with the toggle on). A failed query leaves the amounts
  // off rather than showing another figure.
  const balances = ask('balances', { ...activeLensInput(), includeArchived: true });
  const acctBalMap = new Map((balances?.accounts ?? []).map(a => [a.id, a.balance]));
  const envBalMap  = new Map((balances?.envelopes ?? []).map(e => [e.id, e.balance]));
  const withBalance = (name, map, id) => (balances ? `${name} — ${fmt(map.get(id) ?? 0)}` : name);
  const archivedSuffix = (item) => item && item.archived ? ' · ' + t('addTx.archivedSuffix') : '';
  const acctLabel = (a) => `${withBalance(a.name, acctBalMap, a.id)}${archivedSuffix(a)}`;
  const envLabel  = (e) => `${withBalance(trEnv(e), envBalMap, e.id)}${archivedSuffix(e)}`;
  // Sort: active first, archived last.
  // Asset accounts (a home, a mortgage) are revalued, never paid from or to.
  const sortedAccounts  = filterArchivedForSelect(state.accounts, showArchivedAccts)
    .filter(a => a.type !== 'asset')
    .sort((a, b) => Number(!!a.archived) - Number(!!b.archived));
  // A loan is paid to (a transfer or a loan payment), never spent from or
  // earned into, so the expense/income picker leaves it out.
  const payingAccounts = sortedAccounts.filter(a => a.type !== 'loan' && a.type !== 'loan_given');
  const loanAccounts   = sortedAccounts.filter(a => a.type === 'loan');
  const lentAccounts   = sortedAccounts.filter(a => a.type === 'loan_given');
  const sortedEnvelopes = filterArchivedForSelect(state.envelopes, showArchivedEnv)
    .sort((a, b) => Number(!!a.archived) - Number(!!b.archived));

  // ── Expense-only: envelope splits editor ─────────────────────────────────
  const envWrap = document.createElement('div'); envWrap.className = 'field';
  const envLbl = document.createElement('label'); envLbl.textContent = t('addTx.envelope');
  const splitRows = document.createElement('div');
  splitRows.className = 'split-list';
  const splitFooter = document.createElement('div');
  splitFooter.className = 'split-footer';
  const addSplitBtn = document.createElement('button');
  addSplitBtn.type = 'button';
  addSplitBtn.className = 'btn btn-ghost btn-sm split-add';
  addSplitBtn.textContent = '+ ' + t('addTx.addSplit');
  addSplitBtn.addEventListener('click', () => {
    const total = parseAmountInput(amount.querySelector('input').value) || 0;
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
  const itemPick = budgetItemField();
  envWrap.append(envLbl, splitRows, splitFooter, itemPick.el, envNote.el);

  function buildEnvOptionsHtml(selectedId) {
    const parts = [`<option value="">${t('addTx.pickEnvelope')}</option>`,
                   `<option value="__none__" ${selectedId === '__none__' ? 'selected' : ''}>${escHtml(t('addTx.noEnvelopeOption'))}</option>`];
    const sorted = filterArchivedForSelect(state.envelopes, showArchivedEnv, selectedId ? [selectedId] : [])
      .sort((a, b) => Number(!!a.archived) - Number(!!b.archived));
    parts.push(envelopeOptionsHtml(sorted, envLabel, selectedId));
    return parts.join('');
  }

  function addSplitRow(envelopeId = '', amountValue = '', itemId = null) {
    const row = document.createElement('div');
    row.className = 'split-row';
    // A split line can name the plan item it pays, like a single-envelope
    // expense (shown only with two or more lines, under the line).
    const linePick = budgetItemField({ compact: true, initial: itemId });
    row._itemPick = linePick;
    const sel = document.createElement('select');
    sel.className = 'split-env';
    sel.innerHTML = buildEnvOptionsHtml(envelopeId);
    const inp = document.createElement('input');
    inp.type = 'number'; inp.step = '0.01'; inp.min = '0';
    inp.className = 'split-amt';
    inp.placeholder = t('addTx.splitAmountPh');
    if (amountValue !== '' && amountValue != null) inp.value = amountValue;
    enableFormulaInput(inp);
    enablePercentageInput(inp, () => {
      const total = parseAmountInput(amount.querySelector('input').value) || 0;
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
      rebalanceSplitLines(splitRows, inp, parseAmountInput(amount.querySelector('input').value) || 0);
      updateSplits({ calledFromSplitAmt: true });
    });
    inp.addEventListener('change', () => {
      // Auto-add a row pre-filled with the remaining balance when the user
      // blurs out of an already-filled split row and the splits still don't
      // cover the transaction total. The "last row has a value" guard
      // prevents an infinite cascade of empty rows.
      const total = parseAmountInput(amount.querySelector('input').value) || 0;
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
  }

  function splitCount() { return splitRows.querySelectorAll('.split-row').length; }
  function lastSplitAmt() { return [...splitRows.querySelectorAll('.split-row .split-amt')].at(-1); }

  function updateSplits({ calledFromSplitAmt = false } = {}) {
    const count = splitCount();
    itemPick.refresh(count === 1 ? splitRows.querySelector('.split-env')?.value : null);
    splitRows.querySelectorAll('.split-row').forEach(r => r._itemPick?.refresh(count > 1 ? r.querySelector('.split-env')?.value : null));
    splitRows.querySelectorAll('.split-row .split-rm').forEach(b => {
      b.style.visibility = count > 1 ? 'visible' : 'hidden';
    });
    const total = parseAmountInput(amount.querySelector('input').value) || 0;
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
    validate();
  }

  // Start with one row.
  addSplitRow();

  // ── Expense/Income: account ──────────────────────────────────────────────
  const acctWrap = document.createElement('div'); acctWrap.className = 'field';
  const acctLbl = document.createElement('label'); acctLbl.textContent = t('addTx.account');
  const acctSel = document.createElement('select');
  payingAccounts.forEach(a => {
    const o = document.createElement('option'); o.value = a.id; o.textContent = a.name + archivedSuffix(a); acctSel.append(o);
  });
  acctWrap.append(acctLbl, acctSel);

  // ── Income-only: optional envelope to credit ─────────────────────────────
  const incomeEnvWrap = document.createElement('div'); incomeEnvWrap.className = 'field';
  const incomeEnvLbl = document.createElement('label'); incomeEnvLbl.textContent = t('addTx.incomeEnvelope');
  const incomeEnvSel = document.createElement('select');
  const incomeNoneOpt = document.createElement('option');
  incomeNoneOpt.value = ''; incomeNoneOpt.textContent = t('addTx.incomeEnvelopeNone');
  incomeEnvSel.append(incomeNoneOpt);
  appendEnvelopeOptions(incomeEnvSel, sortedEnvelopes, envLabel);
  incomeEnvWrap.append(incomeEnvLbl, incomeEnvSel);
  enhanceSelectWithSearch(incomeEnvSel, { placeholder: t('addTx.envelopeSearchPh'), noMatch: t('addTx.envelopeNoMatch') });

  // ── Account transfer: from/to account ────────────────────────────────────
  const fromAcctWrap = document.createElement('div'); fromAcctWrap.className = 'field';
  const fromAcctLbl = document.createElement('label'); fromAcctLbl.textContent = t('editTx.fromAccount');
  const fromAcctSel = document.createElement('select');
  sortedAccounts.forEach(a => {
    const o = document.createElement('option'); o.value = a.id; o.textContent = acctLabel(a); fromAcctSel.append(o);
  });
  fromAcctWrap.append(fromAcctLbl, fromAcctSel);

  const toAcctWrap = document.createElement('div'); toAcctWrap.className = 'field';
  const toAcctLbl = document.createElement('label'); toAcctLbl.textContent = t('editTx.toAccount');
  const toAcctSel = document.createElement('select');
  sortedAccounts.forEach(a => {
    const o = document.createElement('option'); o.value = a.id; o.textContent = acctLabel(a); toAcctSel.append(o);
  });
  toAcctWrap.append(toAcctLbl, toAcctSel);
  attachFieldHint(toAcctWrap, toAcctSel);
  // A transfer needs two different accounts, so To starts on the first one
  // that is not From (both start on the first account otherwise).
  function pickOtherToAccount() {
    if (toAcctSel.value !== fromAcctSel.value) return;
    const other = [...toAcctSel.options].find(o => o.value !== fromAcctSel.value);
    if (other) toAcctSel.value = other.value;
  }
  pickOtherToAccount();

  // ── Envelope transfer: from/to envelope ──────────────────────────────────
  const unallocatedLabel = balances
    ? `— ${t('addTx.unallocated')} (${fmt(balances.unallocated)}) —`
    : `— ${t('addTx.unallocated')} —`;

  const fromEnvWrap = document.createElement('div'); fromEnvWrap.className = 'field';
  const fromEnvLbl = document.createElement('label'); fromEnvLbl.textContent = t('addTx.fromEnvelope');
  const fromEnvSel = document.createElement('select');
  // eslint-disable-next-line no-restricted-syntax -- values are escHtml-wrapped
  fromEnvSel.innerHTML = `<option value="">${t('addTx.pickEnvelope')}</option>`;
  const fromUnallocOpt = document.createElement('option');
  fromUnallocOpt.value = UNALLOCATED_SENTINEL;
  fromUnallocOpt.textContent = unallocatedLabel;
  fromEnvSel.append(fromUnallocOpt);
  appendEnvelopeOptions(fromEnvSel, sortedEnvelopes, envLabel);
  fromEnvWrap.append(fromEnvLbl, fromEnvSel);
  enhanceSelectWithSearch(fromEnvSel, { placeholder: t('addTx.envelopeSearchPh'), noMatch: t('addTx.envelopeNoMatch') });

  const toEnvWrap = document.createElement('div'); toEnvWrap.className = 'field';
  const toEnvLbl = document.createElement('label'); toEnvLbl.textContent = t('addTx.toEnvelope');
  const toEnvSel = document.createElement('select');
  // eslint-disable-next-line no-restricted-syntax -- values are escHtml-wrapped
  toEnvSel.innerHTML = `<option value="">${t('addTx.pickEnvelope')}</option>`;
  const toUnallocOpt = document.createElement('option');
  toUnallocOpt.value = UNALLOCATED_SENTINEL;
  toUnallocOpt.textContent = unallocatedLabel;
  toEnvSel.append(toUnallocOpt);
  appendEnvelopeOptions(toEnvSel, sortedEnvelopes, envLabel);
  toEnvWrap.append(toEnvLbl, toEnvSel);
  enhanceSelectWithSearch(toEnvSel, { placeholder: t('addTx.envelopeSearchPh'), noMatch: t('addTx.envelopeNoMatch') });


  const acctTransferRow = document.createElement('div'); acctTransferRow.className = 'field-row';
  acctTransferRow.append(fromAcctWrap, toAcctWrap);
  const envTransferRow = document.createElement('div'); envTransferRow.className = 'field-row';
  envTransferRow.append(fromEnvWrap, toEnvWrap);

  // ── Investment transfer: direction toggle, accounts, envelope, fee ───────
  // Archived accounts are still listed (with suffix) so an existing tx that
  // points at one stays editable.
  const investmentAccounts = sortedAccounts.filter(a => a.type === 'investment');
  const nonInvestmentAccounts = payingAccounts.filter(a => a.type !== 'investment');

  // Direction toggle (Buy = cash → investment; Sell = investment → cash).
  const invDirWrap = document.createElement('div'); invDirWrap.className = 'field';
  const invDirLbl = document.createElement('label'); invDirLbl.textContent = t('addTx.investmentDirection');
  const invDirBtns = document.createElement('div'); invDirBtns.className = 'tx-type-btns';
  let invDirection = 'buy';
  const INV_DIRS = [
    ['buy',      t('addTx.investmentBuy')],
    ['sell',     t('addTx.investmentSell')],
    ['dividend', t('addTx.investmentDividend')],
  ];
  INV_DIRS.forEach(([v, label]) => {
    const btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'tx-type-btn'; btn.dataset.value = v;
    btn.textContent = label;
    if (v === invDirection) btn.classList.add('is-active');
    btn.addEventListener('click', () => {
      invDirection = v;
      invDirBtns.querySelectorAll('.tx-type-btn').forEach(b => b.classList.toggle('is-active', b.dataset.value === v));
      applyInvestmentDirection();
      applyVisibility();
      recomputeInvFields('direction');
      validate();
    });
    invDirBtns.append(btn);
  });
  invDirWrap.append(invDirLbl, invDirBtns);

  const invFromAcctWrap = document.createElement('div'); invFromAcctWrap.className = 'field';
  const invFromAcctLbl = document.createElement('label');
  const invFromAcctSel = document.createElement('select');
  invFromAcctWrap.append(invFromAcctLbl, invFromAcctSel);

  const invToAcctWrap = document.createElement('div'); invToAcctWrap.className = 'field';
  const invToAcctLbl = document.createElement('label');
  const invToAcctSel = document.createElement('select');
  invToAcctWrap.append(invToAcctLbl, invToAcctSel);

  const noInvAcctHint = document.createElement('div');
  noInvAcctHint.className = 'muted';
  noInvAcctHint.style.cssText = 'font-size:12px;margin-top:4px;';
  noInvAcctHint.textContent = t('addTx.investmentNoAccount');
  noInvAcctHint.style.display = 'none';

  function fillSelect(sel, items, labelFn) {
    sel.replaceChildren();
    items.forEach(a => {
      const o = document.createElement('option');
      o.value = a.id; o.textContent = labelFn(a);
      sel.append(o);
    });
  }

  function applyInvestmentDirection() {
    if (invDirection === 'buy') {
      invFromAcctLbl.textContent = t('editTx.fromAccount');
      invToAcctLbl.textContent   = t('addTx.investmentAccount');
      fillSelect(invFromAcctSel, nonInvestmentAccounts, acctLabel);
      fillSelect(invToAcctSel,   investmentAccounts,    acctLabel);
    } else {
      // Sell and dividend both source from an investment account; the
      // destination is the cash account that received proceeds /
      // distribution.
      invFromAcctLbl.textContent = t('addTx.investmentAccount');
      invToAcctLbl.textContent   = t('editTx.toAccount');
      fillSelect(invFromAcctSel, investmentAccounts,    acctLabel);
      fillSelect(invToAcctSel,   nonInvestmentAccounts, acctLabel);
    }
    const hasInv = investmentAccounts.some(a => !a.archived);
    noInvAcctHint.style.display = hasInv ? 'none' : '';
  }
  applyInvestmentDirection();
  invToAcctWrap.append(noInvAcctHint);

  const invEnvWrap = document.createElement('div'); invEnvWrap.className = 'field';
  const invEnvLbl = document.createElement('label'); invEnvLbl.textContent = t('addTx.envelope');
  const invEnvSel = document.createElement('select');
  // eslint-disable-next-line no-restricted-syntax -- values are escHtml-wrapped
  invEnvSel.innerHTML = `<option value="">${t('addTx.pickEnvelope')}</option>`;
  appendEnvelopeOptions(invEnvSel, sortedEnvelopes, envLabel);
  invEnvWrap.append(invEnvLbl, invEnvSel);
  enhanceSelectWithSearch(invEnvSel, { placeholder: t('addTx.envelopeSearchPh'), noMatch: t('addTx.envelopeNoMatch') });

  const invFeeWrap = field('fee', t('addTx.fee'), '', 'number');
  const invFeeInput = invFeeWrap.querySelector('input');
  invFeeInput.step = '0.01';
  invFeeInput.min = '0';
  invFeeInput.inputMode = 'decimal';
  invFeeInput.placeholder = fmtNum(0, { decimals: 2 });
  enableFormulaInput(invFeeInput);

  // Optional ticker symbol — drives the Investments portfolio view. Stored
  // uppercased; blank means the row is treated as untagged cash.
  const invSymbolWrap = field('symbol', t('addTx.symbol'), '', 'text');
  const invSymbolInput = invSymbolWrap.querySelector('input');
  invSymbolInput.placeholder = t('addTx.symbolPh');
  invSymbolInput.maxLength = 20;
  invSymbolInput.autocomplete = 'off';
  {
    const dl = document.createElement('datalist');
    dl.id = 'inv-symbols-datalist-add';
    for (const { sym, name } of listKnownSymbolsWithNames(state)) {
      const o = document.createElement('option');
      o.value = sym;
      if (name) o.label = `${sym} — ${name}`;
      dl.append(o);
    }
    invSymbolWrap.append(dl);
    invSymbolInput.setAttribute('list', dl.id);
  }

  // Optional units + per-unit price. When both are provided, the cash-side
  // amount above is auto-filled to (units × pricePerUnit). Leave blank to
  // keep entering the cash amount directly (lump-sum savings, etc.).
  const invUnitsWrap = field('units', t('addTx.units'), '', 'number');
  const invUnitsInput = invUnitsWrap.querySelector('input');
  invUnitsInput.step = '0.000001';
  invUnitsInput.min = '0';
  invUnitsInput.inputMode = 'decimal';
  invUnitsInput.placeholder = t('addTx.unitsPh');
  enableFormulaInput(invUnitsInput, { decimals: 6 });

  const invPriceWrap = field('price', t('addTx.pricePerUnit'), '', 'number');
  const invPriceInput = invPriceWrap.querySelector('input');
  invPriceInput.step = '0.00001';
  invPriceInput.min = '0';
  invPriceInput.inputMode = 'decimal';
  invPriceInput.placeholder = fmtNum(0, { decimals: 2 });
  enableFormulaInput(invPriceInput, { decimals: 5 });

  let isRecomputingInv = false;
  function recomputeInvFields(editedField) {
    if (isRecomputingInv) return;
    if (typeSel.value !== 'investment_transfer') return;
    const amtInput = amount.querySelector('input');
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

    setFieldHint(amount, '');

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
          else setFieldHint(amount, t('addTx.amountMismatch'));
        }
        return;
      }
      const expected = u * p + feeSign * f;
      if (Math.abs(a - expected) <= 0.005) return;
      if (editedField === 'amount') {
        const newU = (a - feeSign * f) / p;
        if (newU > 0) setU(newU);
        else setFieldHint(amount, t('addTx.amountMismatch'));
      } else {
        setAmt(expected);
      }
    } finally {
      isRecomputingInv = false;
    }
  }
  amount.querySelector('input').addEventListener('input', () => recomputeInvFields('amount'));
  invUnitsInput.addEventListener('input', () => recomputeInvFields('units'));
  invPriceInput.addEventListener('input', () => recomputeInvFields('price'));
  invFeeInput.addEventListener('input', () => recomputeInvFields('fee'));

  const investmentRow = document.createElement('div'); investmentRow.className = 'field-row';
  investmentRow.append(invFromAcctWrap, invToAcctWrap);
  const investmentEnvFeeRow = document.createElement('div'); investmentEnvFeeRow.className = 'field-row';
  investmentEnvFeeRow.append(invEnvWrap, invFeeWrap);
  const investmentUnitsRow = document.createElement('div'); investmentUnitsRow.className = 'field-row';
  investmentUnitsRow.style.gridTemplateColumns = '1fr 1fr 1fr';
  investmentUnitsRow.append(invSymbolWrap, invUnitsWrap, invPriceWrap);

  // ── Loan payment: from account, loan, envelope, interest part ────────────
  // Saved as two rows: the principal as a `debt_payment` into the loan
  // account (the debt shrinks; engine isLoanAccount) and the interest as an
  // ordinary expense. Both come out of the envelope, so the budget sees the
  // whole payment while the reports count only the interest as spending.
  const loanFromWrap = document.createElement('div'); loanFromWrap.className = 'field';
  const loanFromLbl = document.createElement('label'); loanFromLbl.textContent = t('editTx.fromAccount');
  const loanFromSel = document.createElement('select');
  nonInvestmentAccounts.forEach(a => {
    const o = document.createElement('option'); o.value = a.id; o.textContent = acctLabel(a); loanFromSel.append(o);
  });
  loanFromWrap.append(loanFromLbl, loanFromSel);
  const loanToWrap = document.createElement('div'); loanToWrap.className = 'field';
  const loanToLbl = document.createElement('label'); loanToLbl.textContent = t('addTx.loanAccount');
  const loanToSel = document.createElement('select');
  loanAccounts.forEach(a => {
    const o = document.createElement('option'); o.value = a.id; o.textContent = acctLabel(a); loanToSel.append(o);
  });
  loanToWrap.append(loanToLbl, loanToSel);
  const loanAcctRow = document.createElement('div'); loanAcctRow.className = 'field-row';
  loanAcctRow.append(loanFromWrap, loanToWrap);

  const loanEnvWrap = document.createElement('div'); loanEnvWrap.className = 'field';
  const loanEnvLbl = document.createElement('label'); loanEnvLbl.textContent = t('addTx.envelope');
  const loanEnvSel = document.createElement('select');
  const loanEnvNone = document.createElement('option');
  loanEnvNone.value = ''; loanEnvNone.textContent = t('addTx.pickEnvelope');
  loanEnvSel.append(loanEnvNone);
  appendEnvelopeOptions(loanEnvSel, sortedEnvelopes, envLabel);
  loanEnvWrap.append(loanEnvLbl, loanEnvSel);
  enhanceSelectWithSearch(loanEnvSel, { placeholder: t('addTx.envelopeSearchPh'), noMatch: t('addTx.envelopeNoMatch') });
  // The plan item that pays the chosen loan, if exactly one does
  // (`loanItemsByLoanAccount`); its envelope is where the payment is budgeted.
  const loanPlanItem = (loanId) => {
    const itemId = loanItemsByLoanAccount(state.budgetItems).get(loanId);
    return itemId ? (state.budgetItems.find(it => it.id === itemId) || null) : null;
  };
  // Picking a loan prefills its plan item's envelope (when that envelope is
  // offered); the user can still pick another.
  function prefillLoanEnvelope() {
    const envId = loanPlanItem(loanToSel.value)?.envelope_id;
    if (envId && [...loanEnvSel.options].some(o => o.value === envId)) loanEnvSel.value = envId;
  }
  loanToSel.addEventListener('change', prefillLoanEnvelope);
  prefillLoanEnvelope();
  const loanInterest = field('interest', t('addTx.loanInterest'), '', 'number');
  const loanInterestInput = loanInterest.querySelector('input');
  loanInterestInput.step = '0.01';
  loanInterestInput.inputMode = 'decimal';
  loanInterestInput.placeholder = '0';
  attachFieldHint(loanInterest);
  enableFormulaInput(loanInterestInput);
  // Other costs: a handling fee charged with the instalment. Booked as an
  // expense of its own, like the interest; the principal is what remains.
  const loanFee = field('loanFee', t('addTx.loanFee'), '', 'number');
  const loanFeeInput = loanFee.querySelector('input');
  loanFeeInput.step = '0.01';
  loanFeeInput.inputMode = 'decimal';
  loanFeeInput.placeholder = '0';
  attachFieldHint(loanFee);
  enableFormulaInput(loanFeeInput);
  const loanEnvRow = document.createElement('div'); loanEnvRow.className = 'field-row';
  loanEnvRow.style.gridTemplateColumns = '2fr 1fr 1fr';
  // A label may wrap at this width; line the inputs up regardless.
  loanEnvRow.style.alignItems = 'end';
  loanEnvRow.append(loanEnvWrap, loanInterest, loanFee);
  const loanHint = document.createElement('div');
  loanHint.className = 'muted';
  loanHint.style.cssText = 'font-size:12px;margin:-4px 0 8px;';
  loanHint.textContent = t('addTx.loanHint');

  // ── Loan given: lend (from an envelope) or take a repayment ─────────────
  // Lend: a `debt_payment` from an account into the loan-given account, paid
  // from an envelope, so Unallocated does not move (engine
  // isLoanGivenAccount). Repayment: the principal as a transfer back, which
  // lands in Unallocated, and any interest as income.
  let lentDirection = 'lend';
  const lentDirWrap = document.createElement('div'); lentDirWrap.className = 'field';
  const lentDirLbl = document.createElement('label'); lentDirLbl.textContent = t('addTx.investmentDirection');
  const lentDirBtns = document.createElement('div'); lentDirBtns.className = 'tx-type-btns';
  for (const [v, label] of [['lend', t('addTx.lentLend')], ['repay', t('addTx.lentRepay')]]) {
    const btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'tx-type-btn'; btn.dataset.value = v;
    btn.textContent = label;
    btn.setAttribute('aria-pressed', String(v === lentDirection));
    if (v === lentDirection) btn.classList.add('is-active');
    btn.addEventListener('click', () => {
      lentDirection = v;
      lentDirBtns.querySelectorAll('.tx-type-btn').forEach(b => {
        b.classList.toggle('is-active', b.dataset.value === v);
        b.setAttribute('aria-pressed', String(b.dataset.value === v));
      });
      applyVisibility();
      validate();
    });
    lentDirBtns.append(btn);
  }
  lentDirWrap.append(lentDirLbl, lentDirBtns);

  const lentAcctWrap = document.createElement('div'); lentAcctWrap.className = 'field';
  const lentAcctLbl = document.createElement('label');
  const lentAcctSel = document.createElement('select');
  nonInvestmentAccounts.forEach(a => {
    const o = document.createElement('option'); o.value = a.id; o.textContent = acctLabel(a); lentAcctSel.append(o);
  });
  lentAcctWrap.append(lentAcctLbl, lentAcctSel);
  const lentLoanWrap = document.createElement('div'); lentLoanWrap.className = 'field';
  const lentLoanLbl = document.createElement('label'); lentLoanLbl.textContent = t('addTx.lentAccount');
  const lentLoanSel = document.createElement('select');
  lentAccounts.forEach(a => {
    const o = document.createElement('option'); o.value = a.id; o.textContent = acctLabel(a); lentLoanSel.append(o);
  });
  lentLoanWrap.append(lentLoanLbl, lentLoanSel);
  lentLoanSel.addEventListener('change', () => applyVisibility());
  const lentAcctRow = document.createElement('div'); lentAcctRow.className = 'field-row';
  lentAcctRow.append(lentAcctWrap, lentLoanWrap);

  const lentEnvWrap = document.createElement('div'); lentEnvWrap.className = 'field';
  const lentEnvLbl = document.createElement('label'); lentEnvLbl.textContent = t('addTx.lentEnvelope');
  const lentEnvSel = document.createElement('select');
  const lentEnvNone = document.createElement('option');
  lentEnvNone.value = ''; lentEnvNone.textContent = t('addTx.pickEnvelope');
  lentEnvSel.append(lentEnvNone);
  appendEnvelopeOptions(lentEnvSel, sortedEnvelopes, envLabel);
  lentEnvWrap.append(lentEnvLbl, lentEnvSel);
  enhanceSelectWithSearch(lentEnvSel, { placeholder: t('addTx.envelopeSearchPh'), noMatch: t('addTx.envelopeNoMatch') });
  const lentInterest = field('lentInterest', t('addTx.loanInterest'), '', 'number');
  const lentInterestInput = lentInterest.querySelector('input');
  lentInterestInput.step = '0.01';
  lentInterestInput.inputMode = 'decimal';
  lentInterestInput.placeholder = '0';
  attachFieldHint(lentInterest);
  enableFormulaInput(lentInterestInput);
  const lentDetailRow = document.createElement('div'); lentDetailRow.className = 'field-row';
  lentDetailRow.append(lentEnvWrap, lentInterest);
  const lentHint = document.createElement('div');
  lentHint.className = 'muted';
  lentHint.style.cssText = 'font-size:12px;margin:-4px 0 8px;';

  form.append(envWrap, acctWrap, incomeEnvWrap, acctTransferRow, envTransferRow,
              loanAcctRow, loanEnvRow, loanHint,
              invDirWrap, investmentRow, investmentEnvFeeRow, investmentUnitsRow,
              lentDirWrap, lentAcctRow, lentDetailRow, lentHint);

  // ── Visibility by type ───────────────────────────────────────────────────
  function applyVisibility() {
    const ty = typeSel.value;
    typePicker.setActive(ty);
    // The row is icons; the title names the type ("New expense").
    setSheetTitle(form, t('addTx.newTitle')[ty] || t('addTx.title'));
    envWrap.style.display = ty === 'expense' ? '' : 'none';
    acctWrap.style.display = (ty === 'expense' || ty === 'income') ? '' : 'none';
    incomeEnvWrap.style.display = ty === 'income' ? '' : 'none';
    acctTransferRow.style.display = ty === 'account_transfer' ? '' : 'none';
    envTransferRow.style.display  = ty === 'envelope_transfer' ? '' : 'none';
    invDirWrap.style.display       = ty === 'investment_transfer' ? '' : 'none';
    investmentRow.style.display    = ty === 'investment_transfer' ? '' : 'none';
    // Units / price / fee don't apply to dividends — they're cash income
    // tied to a holding, not a unit-priced trade. The fee leg lives on
    // investmentEnvFeeRow alongside the envelope; dividends still take
    // an optional envelope (recipient of the income), so only swap the
    // fee field out for dividends rather than hiding the whole row.
    const isDividend = ty === 'investment_transfer' && invDirection === 'dividend';
    investmentEnvFeeRow.style.display = ty === 'investment_transfer' ? '' : 'none';
    invFeeWrap.style.display = isDividend ? 'none' : '';
    investmentUnitsRow.style.display  = (ty === 'investment_transfer' && !isDividend) ? '' : 'none';
    const isLoan = ty === 'loan_payment';
    loanAcctRow.style.display = isLoan ? '' : 'none';
    loanEnvRow.style.display  = isLoan ? '' : 'none';
    loanHint.style.display    = isLoan ? '' : 'none';
    const isLent = ty === 'loan_given';
    const lending = lentDirection === 'lend';
    lentDirWrap.style.display   = isLent ? '' : 'none';
    lentAcctRow.style.display   = isLent ? '' : 'none';
    lentDetailRow.style.display = isLent ? '' : 'none';
    lentHint.style.display      = isLent ? '' : 'none';
    lentEnvWrap.style.display   = lending ? '' : 'none';
    lentInterest.style.display  = lending ? 'none' : '';
    lentAcctLbl.textContent = lending ? t('editTx.fromAccount') : t('editTx.toAccount');
    lentHint.textContent = lending ? t('addTx.lentHintLend') : t('addTx.lentHintRepay');
    if (isLent && !lending) {
      // The interest the borrower still owes (accrued less what was already
      // received), to ask for with the repayment (the loan given's terms;
      // interest is paid in cash).
      const terms = lentLoanSel.value
        ? ask('accounts.detail', { accounts: [lentLoanSel.value], date: isoDate(appNow()) })?.accounts[0]?.loanTerms ?? null
        : null;
      if (terms?.dueDate && terms.accrued > 0) {
        lentHint.textContent += ` ${t('addTx.lentAccrued')(fmt(terms.accrued), fmtDateLang(terms.dueDate), fmt(terms.atDue))}`;
      }
    }

    // Default payee for transfer types (only if user hasn't typed anything)
    if (!payeeInput.value.trim()) {
      if (ty === 'account_transfer')  payeeInput.placeholder = t('addTx.transferPlaceholderAccount');
      else if (ty === 'envelope_transfer') payeeInput.placeholder = t('addTx.transferPlaceholderEnvelope');
      else if (ty === 'investment_transfer') payeeInput.placeholder = t('addTx.transferPlaceholderInvestment');
      else if (ty === 'loan_payment') payeeInput.placeholder = t('addTx.loanPayeePlaceholder');
      else if (ty === 'loan_given') payeeInput.placeholder = t('addTx.lentPayeePlaceholder');
      else payeeInput.placeholder = '';
    }
  }
  applyVisibility();
  let prevType = typeSel.value;
  typeSel.addEventListener('change', () => {
    const ty = typeSel.value;
    if (ty === 'account_transfer' && (prevType === 'expense' || prevType === 'income') && acctSel.value) {
      trySetSelect(fromAcctSel, acctSel.value);
    }
    if (ty === 'account_transfer') pickOtherToAccount();
    if (ty === 'investment_transfer') {
      if ((prevType === 'expense' || prevType === 'income') && acctSel.value) {
        trySetSelect(invFromAcctSel, acctSel.value);
      } else if (prevType === 'account_transfer') {
        if (fromAcctSel.value) trySetSelect(invFromAcctSel, fromAcctSel.value);
        if (toAcctSel.value)   trySetSelect(invToAcctSel,   toAcctSel.value);
      }
    }
    prevType = ty;
    applyVisibility();
    validate();
  });

  // ── Payee autofill (same as before, only for expense/income) ─────────────
  function trySetSelect(sel, value) {
    if (!value) return;
    if ([...sel.options].some(o => o.value === value)) sel.value = value;
  }
  payeeInput.addEventListener('input', () => {
    if (typeSel.value === 'investment_transfer' && !invSymbolInput.value.trim()) {
      const sym = lookupSymbolForPayee(state.meta, payeeInput.value);
      if (sym) {
        invSymbolInput.value = sym;
        invSymbolInput.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }
    const entry = findPayeeEntry(state, payeeInput.value);
    if (!entry) return;
    const tx = entry.lastTx;
    if (tx.type !== 'expense' && tx.type !== 'income') return;
    typeSel.value = tx.type;
    applyVisibility();
    // A split row has no single envelope; fall back to the payee's last one.
    const envId = tx.envelope_id || entry.lastEnvelopeId || '';
    if (tx.type === 'expense' && splitCount() === 1) {
      const sel = splitRows.querySelector('.split-env');
      if (sel) trySetSelect(sel, envId);
      // The item this payee was last linked to, when it is in that envelope.
      itemPick.refresh(sel?.value, entry.lastBudgetItemId);
    }
    if (tx.type === 'income') {
      trySetSelect(incomeEnvSel, envId);
    }
    trySetSelect(acctSel, tx.account);
  });

  // ── Header actions ───────────────────────────────────────────────────────
  // In a footer under the form, not the header's corner: the primary action
  // sits where the eye ends up after the last field (ux-review U16).
  const cancel = document.createElement('button'); cancel.type = 'button';
  cancel.className = 'btn btn-ghost'; cancel.textContent = t('addTx.cancel');
  const saveNew = document.createElement('button'); saveNew.type = 'button';
  saveNew.className = 'btn btn-ghost'; saveNew.textContent = t('addTx.addAndNew');

  const save = document.createElement('button'); save.type = 'submit';
  save.className = 'btn btn-accent'; save.textContent = t('addTx.addAndClose');
  let submitMode = 'close';
  save.addEventListener('click', () => { submitMode = 'close'; });
  saveNew.addEventListener('click', () => { submitMode = 'new'; form.requestSubmit(); });

  const errEl = document.createElement('div');
  errEl.style.cssText = 'color:var(--danger-text);font-size:13px;margin-top:8px;display:none;';
  const footer = document.createElement('div');
  footer.dataset.sheetActions = '';
  footer.className = 'sheet-footer-actions';
  const footerEnd = document.createElement('div');
  footerEnd.className = 'sheet-footer-actions-end';
  footerEnd.append(saveNew, save);
  footer.append(cancel, footerEnd);
  form.append(transactionNote(noteWrap), errEl, footer);
  const showError = (msg) => { errEl.textContent = msg; errEl.style.display = 'block'; };
  const clearError = () => { errEl.style.display = 'none'; errEl.textContent = ''; };

  let attempted = false;
  function validate(force = false) {
    if (force === true) attempted = true;
    const aInput = amount.querySelector('input');
    const dInput = date.querySelector('input');
    const a = parseAmountInput(aInput.value, { strict: true });
    const ty = typeSel.value;
    const errors = [];
    const controls = [aInput, dInput, acctSel, fromAcctSel, toAcctSel, fromEnvSel, toEnvSel,
      loanFromSel, loanToSel, loanEnvSel, loanInterestInput, loanFeeInput,
      lentAcctSel, lentLoanSel, lentEnvSel, lentInterestInput,
      invFromAcctSel, invToAcctSel, invEnvSel, invSymbolInput, invFeeInput, invUnitsInput, invPriceInput];
    controls.forEach(control => { markRequired(control, false); if (attempted) fieldError(control, ''); });
    const invalid = (control, message) => errors.push([control, message]);
    const need = control => {
      markRequired(control);
      if (!control.value.trim()) invalid(control, t('common.fieldRequired'));
    };
    markRequired(aInput); markRequired(dInput);
    if (!(a > 0) || validateAmount(a) === null) invalid(aInput, t('common.amountInvalid'));
    if (!dInput.value) invalid(dInput, t('common.dateRequired'));
    if (ty === 'expense' || ty === 'income') need(acctSel);
    if (ty === 'expense') {
      const rows = [...splitRows.querySelectorAll('.split-row')];
      if (rows.length > 1) {
        let sum = 0;
        for (const r of rows) {
          const sel = r.querySelector('.split-env');
          const inp = r.querySelector('.split-amt');
          const val = parseAmountInput(inp.value, { strict: true });
          if (!sel.value || sel.value === '__none__' || !(val > 0)) invalid(aInput, t('addTx.amountMismatch'));
          sum += val;
        }
        if (!Number.isFinite(sum) || Math.abs(sum - a) > 0.01) invalid(aInput, t('addTx.amountMismatch'));
      }
    }
    if (ty === 'account_transfer' || ty === 'investment_transfer') {
      const from = ty === 'account_transfer' ? fromAcctSel : invFromAcctSel;
      const to = ty === 'account_transfer' ? toAcctSel : invToAcctSel;
      need(from); need(to);
      if (from.value && from.value === to.value) invalid(to, t('addTx.accountsSameError'));
    }
    if (ty === 'envelope_transfer') {
      need(fromEnvSel); need(toEnvSel);
      if (fromEnvSel.value && fromEnvSel.value === toEnvSel.value) invalid(toEnvSel, t('editTx.envTransferSameError'));
    }
    if (ty === 'loan_payment') {
      [loanFromSel, loanToSel, loanEnvSel].forEach(need);
      const i = loanInterestInput.value === '' ? 0 : parseAmountInput(loanInterestInput.value, { strict: true });
      const f = loanFeeInput.value === '' ? 0 : parseAmountInput(loanFeeInput.value, { strict: true });
      if (!Number.isFinite(f) || f < 0) invalid(loanFeeInput, t('common.amountInvalid'));
      if (!Number.isFinite(i) || i < 0 || (a > 0 && i + (Number.isFinite(f) ? f : 0) > a + 0.005)) invalid(loanInterestInput, t('addTx.loanInterestInvalid'));
    }
    if (ty === 'loan_given') {
      need(lentAcctSel); need(lentLoanSel);
      if (lentDirection === 'lend') need(lentEnvSel);
      else {
        const i = lentInterestInput.value === '' ? 0 : parseAmountInput(lentInterestInput.value, { strict: true });
        if (!Number.isFinite(i) || i < 0 || (a > 0 && i > a + 0.005)) invalid(lentInterestInput, t('addTx.loanInterestInvalid'));
      }
    }
    if (ty === 'investment_transfer') {
      markRequired(invSymbolInput, invDirection === 'dividend');
      if (invDirection === 'dividend') need(invSymbolInput);
      else {
        need(invEnvSel);
        markRequired(invUnitsInput, invDirection === 'sell');
        if (invDirection === 'sell' && !(parseAmountInput(invUnitsInput.value, { strict: true }) > 0)) invalid(invUnitsInput, t('addTx.investmentSellNeedsUnits'));
        for (const control of [invUnitsInput, invPriceInput]) {
          if (control.value.trim() && !(parseAmountInput(control.value, { strict: true }) > 0)) invalid(control, t('common.amountInvalid'));
        }
        const f = invFeeInput.value === '' ? 0 : parseAmountInput(invFeeInput.value, { strict: true });
        if (!Number.isFinite(f) || f < 0) invalid(invFeeInput, t('common.amountInvalid'));
      }
    }
    if (attempted) errors.forEach(([control, message]) => fieldError(control, message));
    envNote.sync(needsNoEnvelopeNote({ type: ty, amount: a,
      envelopeValues: [...splitRows.querySelectorAll('.split-env')].map(s => s.value) }));
    if (force === true && errors.length) focusFirstError(form);
    return errors.length === 0;
  }
  amount.querySelector('input').addEventListener('input', updateSplits);
  form.addEventListener('input', validate);
  form.addEventListener('change', validate);
  updateSplits();
  validate();

  // Any dismissal of a half-filled form (Escape or Cancel) asks
  // before discarding; only successful saves close directly.
  const tracker = trackDirty(form);
  const { close, requestClose } = openSheet({
    title: t('addTx.newTitle')[typeSel.value] || t('addTx.title'), content: form,
    confirmClose: tracker.confirmClose,
    // Payee is what the user types first; the header's Cancel would
    // otherwise take focus because it comes first in the DOM.
    initialFocus: payeeInput,
  });
  cancel.addEventListener('click', requestClose);

  function resetForNewEntry() {
    payeeInput.value = '';
    amount.querySelector('input').value = '';
    noteInput.value = '';
    incomeEnvSel.value = '';
    fromEnvSel.value = '';
    toEnvSel.value = '';
    loanInterestInput.value = '';
    loanFeeInput.value = '';
    lentInterestInput.value = '';
    splitRows.replaceChildren();
    addSplitRow();
    clearError();
    attempted = false;
    for (const wrap of form.querySelectorAll('.has-error')) setFieldHint(wrap, '');
    updateSplits();
    validate();
    payeeInput.focus();
  }

  setupFormValidation(form, { required: false });

  form.addEventListener('submit', guardSubmit(async (e) => {
    e.preventDefault();
    clearError();
    if (!validate(true)) return;
    const ty = typeSel.value;
    const p = payeeInput.value.trim();
    const a = validateAmount(parseAmountInput(amount.querySelector('input').value, { strict: true }));
    const d = date.querySelector('input').value;
    if (!(a > 0) || !d) return;

    const noteRaw = noteInput.value.trim();
    const note = noteRaw || null;
    // The commands to run, in order: one transaction.record per row (a loan
    // payment's interest is a second row). The first record's row is the one
    // the toast names. The commands build the rows (ids, audit timestamps
    // from the session clock, field rules); the page decides what to ask for.
    /** @type {{ name: string, input: Record<string, any> }[]} */
    const steps = [];
    const record = (input) => steps.push({ name: 'transaction.record', input: { amount: a, date: d, note, ...input } });
    if (ty === 'expense') {
      const rows = [...splitRows.querySelectorAll('.split-row')];
      if (rows.length > 1) {
        record({
          type: 'expense', payee: p, account: acctSel.value,
          splits: rows.map(r => {
            const lineItem = r._itemPick?.value();
            return {
              envelope: r.querySelector('.split-env').value,
              amount: validateAmount(parseAmountInput(r.querySelector('.split-amt').value)) ?? 0,
              ...(lineItem ? { budgetItem: lineItem } : {}),
            };
          }),
        });
      } else {
        const itemId = itemPick.value();
        record({
          type: 'expense', payee: p, account: acctSel.value,
          envelope: rows[0].querySelector('.split-env').value || null,
          ...(itemId ? { budgetItem: itemId } : {}),
        });
      }
    } else if (ty === 'income') {
      record({ type: 'income', payee: p, account: acctSel.value, envelope: incomeEnvSel.value || null });
    } else if (ty === 'account_transfer') {
      if (fromAcctSel.value === toAcctSel.value) {
        showError(t('addTx.accountsSameError')); return;
      }
      record({
        type: 'account_transfer', payee: p || t('addTx.payeeAccountTransfer'),
        fromAccount: fromAcctSel.value, toAccount: toAcctSel.value,
      });
    } else if (ty === 'envelope_transfer') {
      if (fromEnvSel.value === toEnvSel.value) {
        showError(t('addTx.envelopesSameError')); return;
      }
      record({
        type: 'envelope_transfer', payee: p || t('addTx.payeeEnvelopeTransfer'),
        fromEnvelope: fromEnvSel.value === UNALLOCATED_SENTINEL ? null : fromEnvSel.value,
        toEnvelope: toEnvSel.value === UNALLOCATED_SENTINEL ? null : toEnvSel.value,
      });
    } else if (ty === 'investment_transfer') {
      if (invFromAcctSel.value === invToAcctSel.value) {
        showError(t('addTx.investmentAccountsSameError')); return;
      }
      const symRaw = invSymbolInput.value.trim().toUpperCase();
      const isDividend = invDirection === 'dividend';
      // §1.2 — computeHoldings skips a `sell` with no units (holdings.js:94):
      // it cannot reduce a position by an unknown quantity, and inferring one
      // from amount/price would be an invention about the owner's money. The
      // cash still moves, because the account walk reads `amount` — so the
      // position stays open forever at a cost basis that includes shares that
      // were sold. Refuse the row here, the way the engine already refuses to
      // process it. Buys without units are legitimate ("I put €100 into X")
      // and dividends are cash-only, so neither is gated.
      if (invDirection === 'sell') {
        const sellUnits = parseAmountInput(invUnitsInput.value);
        if (!(Number.isFinite(sellUnits) && sellUnits > 0)) {
          showError(t('addTx.investmentSellNeedsUnits')); return;
        }
      }
      const defaultPayee = isDividend ? t('addTx.payeeDividend')
                         : invDirection === 'sell' ? t('addTx.payeeInvestmentSale')
                         : t('addTx.payeeInvestment');
      /** @type {Record<string, any>} */
      const extras = {};
      if (!isDividend) {
        // The command stores fee, units and price only when positive and
        // rounds them (2, 6 and 5 decimals); the page passes what was typed.
        const feeRaw = invFeeInput.value;
        const feeNum = feeRaw === '' ? 0 : parseAmountInput(feeRaw);
        const unitsRaw = parseAmountInput(invUnitsInput.value);
        const priceRaw = parseAmountInput(invPriceInput.value);
        if (Number.isFinite(feeNum) && feeNum > 0) extras.fee = feeNum;
        if (Number.isFinite(unitsRaw) && unitsRaw > 0) extras.units = unitsRaw;
        if (Number.isFinite(priceRaw) && priceRaw > 0) extras.pricePerUnit = priceRaw;
      }
      if (symRaw) extras.symbol = symRaw;
      record({
        type: 'investment_transfer', payee: p || defaultPayee, direction: invDirection,
        fromAccount: invFromAcctSel.value, toAccount: invToAcctSel.value,
        envelope: invEnvSel.value || null,
        ...extras,
      });
    } else if (ty === 'loan_payment') {
      const iRaw = loanInterestInput.value;
      const interest = iRaw === '' ? 0 : (validateAmount(parseAmountInput(iRaw)) ?? 0);
      const fRaw = loanFeeInput.value;
      const fee = fRaw === '' ? 0 : (validateAmount(parseAmountInput(fRaw)) ?? 0);
      const principal = Math.round((a - interest - fee) * 100) / 100;
      const loanName = state.accounts.find(x => x.id === loanToSel.value)?.name || '';
      const envelope = loanEnvSel.value || null;
      // The plan item that pays this loan, if exactly one does. The principal
      // finds it by its loan account; the interest and other costs are plain
      // expenses, so they carry the link, and the whole payment counts as
      // that item's (fill %, the duplicate-post guard, the forecast). Only
      // when paid from the item's own envelope: a link to an item of another
      // envelope is ignored and reported (validateBudgetItemLink).
      const loanItem = loanPlanItem(loanToSel.value);
      const itemLink = loanItem && envelope && loanItem.envelope_id === envelope ? { budgetItem: loanItem.id } : {};
      // The principal first: it is the row the toast names.
      if (principal > 0) {
        record({
          type: 'debt_payment', payee: p || loanName, amount: principal, envelope,
          fromAccount: loanFromSel.value, toAccount: loanToSel.value,
        });
      }
      if (interest > 0) {
        record({
          type: 'expense', payee: p || loanName, amount: Math.round(interest * 100) / 100, envelope,
          account: loanFromSel.value, note: note || t('addTx.loanInterestNote'), ...itemLink,
        });
      }
      if (fee > 0) {
        record({
          type: 'expense', payee: p || loanName, amount: Math.round(fee * 100) / 100, envelope,
          account: loanFromSel.value, note: note || t('addTx.loanFeeNote'), ...itemLink,
        });
      }
      if (!steps.length) return;
    } else if (ty === 'loan_given') {
      const lentName = state.accounts.find(x => x.id === lentLoanSel.value)?.name || '';
      const payee = p || lentName;
      if (lentDirection === 'lend') {
        record({
          type: 'debt_payment', payee,
          fromAccount: lentAcctSel.value, toAccount: lentLoanSel.value,
          envelope: lentEnvSel.value || null,
        });
      } else {
        const iRaw = lentInterestInput.value;
        const interest = iRaw === '' ? 0 : (validateAmount(parseAmountInput(iRaw)) ?? 0);
        const principal = Math.round((a - interest) * 100) / 100;
        if (principal > 0) {
          record({
            type: 'account_transfer', payee, amount: principal,
            fromAccount: lentLoanSel.value, toAccount: lentAcctSel.value,
          });
        }
        if (interest > 0) {
          record({
            type: 'income', payee, amount: Math.round(interest * 100) / 100,
            account: lentAcctSel.value, envelope: null, note: note || t('addTx.lentInterestNote'),
            // Linked to the loan, so its terms count it as interest received.
            interestOf: lentLoanSel.value,
          });
        }
        if (!steps.length) return;
      }
    } else {
      return;
    }

    if (!(await confirmClosedEdit([d]))) return;

    // Guardrail: warn when a transaction would push unallocated negative
    // (over-allocation). Only fires if it crosses the threshold — repeated
    // spending while already negative isn't re-confirmed each time.
    // Both sides read through the active lens — a before/after comparison
    // across two different lenses would compare nothing meaningful.
    // The "after" side is the balances query asked of the budget after a dry
    // run of the very steps that will be committed (session.queryAfter), so
    // the rows it weighs are the rows that get written.
    const saveFailed = (err) => {
      console.error(err);
      toast(`${t('addTx.saveFailed')}: ${err.message || err}`, { assertive: true });
    };
    const lens = activeLensInput();
    let after;
    try {
      after = await session.queryAfter(steps, 'balances', lens);
    } catch (err) { saveFailed(err); return; }
    if (!after.ok) { showError(describeError(after.error, t)); return; }
    // A failed "before" query skips the warning: the save itself is unaffected.
    const before = ask('balances', lens);
    const beforeUnalloc = before?.unallocated ?? null;
    const afterUnalloc = after.value?.unallocated ?? null;
    // Either side missing skips the warning (the step error path above still shows its error).
    if (beforeUnalloc !== null && afterUnalloc !== null && beforeUnalloc >= -0.005 && afterUnalloc < -0.005) {
      const ok = await confirmDialog(
        t('addTx.unallocatedWarn')(fmt(Math.abs(afterUnalloc))),
        { title: t('addTx.unallocatedWarnTitle'), okLabel: t('addTx.unallocatedWarnOk'), cancelLabel: t('addTx.unallocatedWarnCancel'), danger: true },
      );
      if (!ok) return;
    }
    // An investment buy that takes its paying cash account below zero is
    // confirmed the same way, from the same two answers.
    const buy = steps[0].input;
    if (buy.type === 'investment_transfer' && buy.direction === 'buy') {
      const over = overdrawnAccount(before, after.value, buy.fromAccount);
      if (over) {
        const ok = await confirmDialog(
          t('addTx.overdrawWarn')(over.name, fmt(over.balance)),
          { title: t('addTx.overdrawWarnTitle'), okLabel: t('addTx.unallocatedWarnOk'), cancelLabel: t('addTx.unallocatedWarnCancel'), danger: true },
        );
        if (!ok) return;
      }
    }

    // A new investment symbol is remembered for its payee, and earlier rows of
    // that payee that have none can take it. The user is asked now; the rule
    // and the backfill are one best-effort commit after the entry is saved, so
    // a refused tag must never cost the user the entry they just typed.
    const first = steps[0].input;
    const rule = first.type === 'investment_transfer' && first.symbol
      ? { payee: p, symbol: first.symbol, ids: await askPayeeBackfill(p, first.symbol) }
      : null;

    tracker.reset();
    if (submitMode === 'new') {
      resetForNewEntry();
    } else {
      close();
    }
    // Not awaited: the guard drops a submit that arrives while a handler is
    // still running, and "Add & new" must accept the next entry while this one
    // is being written (the session runs dispatches one at a time).
    commit(steps, rule, first, a).catch(saveFailed);
  }));
}

/**
 * Save the entry, then its payee's symbol rule and the earlier rows it tags.
 * Failures of the entry are reported here; a throw is the caller's to report.
 */
async function commit(steps, rule, first, amount) {
  const r = await session.dispatchBatch(steps);
  if (!r.ok) {
    if (r.error.code === 'version_conflict') showVersionConflictDialog();
    // Its own text already says it was not saved, and why.
    else if (r.error.code === 'budget_loading') reportDispatchFailure(r.error);
    else toast(`${t('addTx.saveFailed')}: ${describeError(r.error, t)}`, { assertive: true });
    return;
  }
  navigate(state.currentPage);
  // Read the payee back from state: a payee merge may have applied an
  // alias, and the toast should name what was actually saved.
  const newId = r.value.value[0]?.id;
  const savedRow = state.transactions.find(x => x.id === newId);
  const savedPayee = savedRow?.payee ?? first.payee;
  const savedMsg = t('addTx.saved').replace('{payee}', savedPayee).replace('{amount}', fmt(amount));
  // An investment row with no symbol counts in no holding until it gets one:
  // say so, and link to the Investments card that assigns it.
  const tracked = new Set(trackedInvestmentAccounts(state.accounts).map(x => x.id));
  if (savedRow && findUnmappedInvestmentTxs([savedRow], tracked).length) {
    toast(`${savedMsg} · ${t('addTx.savedNoSymbol')}`, {
      duration: 8000,
      action: { label: t('addTx.assignSymbol'), onAction: () => { showUnmappedCard(); } },
    });
  } else {
    toast(savedMsg);
  }
  if (rule) await savePayeeRule(rule.payee, rule.symbol, rule.ids);
}

let _fieldSeq = 0;
function field(name, label, value = '', type = 'text') {
  const wrap = document.createElement('div'); wrap.className = 'field';
  const id = `addtx-f-${++_fieldSeq}`;
  const lbl = document.createElement('label'); lbl.textContent = label; lbl.htmlFor = id;
  const input = document.createElement('input');
  input.type = type; input.name = name; input.value = value; input.id = id;
  wrap.append(lbl, input);
  return wrap;
}
