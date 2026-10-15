// js/pages/whatif-editor.js — the What-if scenario editor sheet (Net worth
// page, spec 2026-09-28-what-if-scenarios-design.md).
//
// A name and a list of changes, each its own small card with a remove
// button; four "add" buttons build a fresh change from
// net-worth-whatif.js's `defaultChange`. Save re-validates the whole draft
// through `normalizeScenarios` (the same defensive read used on load) and
// refuses inline when it comes back empty — a scenario without a name or
// without one valid change is not saved. Save is disabled while the
// scenario has no change at all. The page (js/pages/net-worth.js)
// owns storage: this sheet only builds a `WhatIfScenario` and hands it to
// `onSave`, which persists the full list and reports write failures.

import { normalizeScenarios } from '../engine.js';
import { generateId } from '../import.js';
import { parseAmountInput } from '../ui/amount-input.js';
import { trackDirty } from '../ui/dirty-guard.js';
import { t } from '../ui/i18n.js';
import { openSheet } from '../ui/sheet.js';
import { guardSubmit } from '../ui/submit-guard.js';
import { fmtNum } from '../utils.js';
import { SCENARIOS } from '../engine/stress.js';
import { defaultChange, incomeItemsFor } from './net-worth-whatif.js';

// Every field gets an id so its label names it for assistive tech; change
// cards are rebuilt freely, so ids come from a running counter.
let fieldSeq = 0;
function field(labelText, input) {
  const wrap = document.createElement('div');
  wrap.className = 'field';
  const lbl = document.createElement('label');
  lbl.textContent = labelText;
  if (!input.id) input.id = `whatif-f-${++fieldSeq}`;
  lbl.htmlFor = input.id;
  wrap.append(lbl, input);
  return wrap;
}

/**
 * `<option>`s for an account picker: non-archived accounts (or the
 * currently-selected one, so a value saved before an account was archived
 * doesn't silently vanish), optionally excluding one (a transfer's "to"
 * picker excluding the "from" account) and with an optional leading empty
 * option.
 */
function accountOptions(accounts, selectedId, { excludeId = null, emptyLabel = null } = {}) {
  const frag = document.createDocumentFragment();
  if (emptyLabel != null) {
    const o = document.createElement('option');
    o.value = '';
    o.textContent = emptyLabel;
    frag.append(o);
  }
  for (const a of accounts || []) {
    if (!a) continue;
    if (a.archived && a.id !== selectedId) continue;
    if (excludeId && a.id === excludeId && a.id !== selectedId) continue;
    const o = document.createElement('option');
    o.value = a.id;
    o.textContent = a.name || a.id;
    if (a.id === selectedId) o.selected = true;
    frag.append(o);
  }
  return frag;
}

function amountInput(value) {
  const input = document.createElement('input');
  input.type = 'text';
  input.inputMode = 'decimal';
  input.value = fmtNum(value ?? 0, { maxDecimals: 2 });
  return input;
}

function changeCard(titleText, fieldsEl, onRemove) {
  const card = document.createElement('div');
  card.className = 'whatif-change-card';
  const head = document.createElement('div');
  head.className = 'whatif-change-head';
  const h = document.createElement('span');
  h.className = 'whatif-change-title';
  h.textContent = titleText;
  const rm = document.createElement('button');
  rm.type = 'button';
  rm.className = 'btn btn-sm btn-ghost whatif-change-remove';
  rm.textContent = t('whatIfEditor.remove');
  rm.addEventListener('click', onRemove);
  head.append(h, rm);
  card.append(head, fieldsEl);
  return card;
}

function fieldsRow(...fields) {
  const row = document.createElement('div');
  row.className = 'whatif-change-fields';
  row.append(...fields);
  return row;
}

function buildIncomeRow(change, { incomeItems, onRemove }) {
  const pctIn = document.createElement('input');
  pctIn.type = 'number';
  pctIn.step = '1';
  pctIn.min = '-100';
  pctIn.max = '500';
  pctIn.value = String(change.pct ?? 0);
  const fromIn = document.createElement('input');
  fromIn.type = 'month';
  fromIn.value = change.from || '';
  const itemSel = document.createElement('select');
  const allOpt = document.createElement('option');
  allOpt.value = '';
  allOpt.textContent = t('whatIfEditor.allIncome');
  itemSel.append(allOpt);
  for (const it of incomeItems) {
    const o = document.createElement('option');
    o.value = it.id;
    o.textContent = it.description || it.id;
    if (it.id === change.itemId) o.selected = true;
    itemSel.append(o);
  }
  const el = changeCard(t('whatIfEditor.incomeTitle'), fieldsRow(
    field(t('whatIfEditor.percentLabel'), pctIn),
    field(t('whatIfEditor.fromMonthLabel'), fromIn),
    field(t('whatIfEditor.incomeItemLabel'), itemSel),
  ), onRemove);
  return {
    el,
    read: () => {
      const out = { type: 'income', pct: Number(pctIn.value), from: fromIn.value };
      if (itemSel.value) out.itemId = itemSel.value;
      return out;
    },
  };
}

function buildMonthlyRow(change, { accounts, onRemove }) {
  const amtIn = amountInput(change.amount);
  const acctSel = document.createElement('select');
  acctSel.append(accountOptions(accounts, change.account));
  const toSel = document.createElement('select');
  const refreshTo = () => {
    const prevTo = toSel.value || change.toAccount || '';
    toSel.replaceChildren();
    toSel.append(accountOptions(accounts, prevTo, { excludeId: acctSel.value || null, emptyLabel: t('whatIfEditor.noTransfer') }));
  };
  refreshTo();
  acctSel.addEventListener('change', refreshTo);
  const fromIn = document.createElement('input');
  fromIn.type = 'month';
  fromIn.value = change.from || '';
  const untilIn = document.createElement('input');
  untilIn.type = 'month';
  untilIn.value = change.until || '';
  const dayIn = document.createElement('input');
  dayIn.type = 'number';
  dayIn.min = '1';
  dayIn.max = '28';
  dayIn.step = '1';
  dayIn.value = String(change.day ?? 1);
  const el = changeCard(t('whatIfEditor.monthlyTitle'), fieldsRow(
    field(t('whatIfEditor.amountLabel'), amtIn),
    field(t('whatIfEditor.accountLabel'), acctSel),
    field(t('whatIfEditor.toAccountLabel'), toSel),
    field(t('whatIfEditor.fromMonthLabel'), fromIn),
    field(t('whatIfEditor.untilMonthLabel'), untilIn),
    field(t('whatIfEditor.dayLabel'), dayIn),
  ), onRemove);
  return {
    el,
    read: () => {
      const out = {
        type: 'monthly',
        amount: parseAmountInput(amtIn.value) || 0,
        account: acctSel.value,
        from: fromIn.value,
        day: parseInt(dayIn.value, 10) || 1,
      };
      if (toSel.value) out.toAccount = toSel.value;
      if (untilIn.value) out.until = untilIn.value;
      return out;
    },
  };
}

function buildOneoffRow(change, { accounts, onRemove }) {
  const dateIn = document.createElement('input');
  dateIn.type = 'date';
  dateIn.value = change.date || '';
  const amtIn = amountInput(change.amount);
  const acctSel = document.createElement('select');
  acctSel.append(accountOptions(accounts, change.account));
  const labelIn = document.createElement('input');
  labelIn.type = 'text';
  labelIn.value = change.label || '';
  const el = changeCard(t('whatIfEditor.oneoffTitle'), fieldsRow(
    field(t('whatIfEditor.dateLabel'), dateIn),
    field(t('whatIfEditor.amountLabel'), amtIn),
    field(t('whatIfEditor.accountLabel'), acctSel),
    field(t('whatIfEditor.labelLabel'), labelIn),
  ), onRemove);
  return {
    el,
    read: () => ({
      type: 'oneoff',
      date: dateIn.value,
      amount: parseAmountInput(amtIn.value) || 0,
      account: acctSel.value,
      label: labelIn.value.trim(),
    }),
  };
}

function buildStressRow(change, { onRemove }) {
  const scenarioSel = document.createElement('select');
  for (const s of SCENARIOS) {
    const o = document.createElement('option');
    o.value = s;
    o.textContent = `${s} — ${t(`stress.cat${s}`)}`;
    if (s === change.scenario) o.selected = true;
    scenarioSel.append(o);
  }
  const fromIn = document.createElement('input');
  fromIn.type = 'month';
  fromIn.value = change.from || '';
  const el = changeCard(t('whatIfEditor.stressTitle'), fieldsRow(
    field(t('whatIfEditor.scenarioLabel'), scenarioSel),
    field(t('whatIfEditor.fromMonthLabel'), fromIn),
  ), onRemove);
  return { el, read: () => ({ type: 'stress', scenario: scenarioSel.value, from: fromIn.value }) };
}

/**
 * @param {object} input
 * @param {import('../engine/whatif.js').WhatIfScenario | null} input.scenario  null for a new scenario
 * @param {any[]} input.accounts
 * @param {any[]} input.budgetItems
 * @param {Date} input.today
 * @param {(scenario: import('../engine/whatif.js').WhatIfScenario) => Promise<boolean>} input.onSave
 *   persists the scenario (as part of the full list); resolves false to
 *   keep the sheet open (the page already reported the failure)
 */
export function openWhatIfEditor({ scenario, accounts, budgetItems, today, onSave }) {
  const isNew = !scenario;
  const draftId = isNew ? generateId() : scenario.id;
  const incomeItems = incomeItemsFor(budgetItems);

  const form = document.createElement('form');
  const tracker = trackDirty(form);

  const nameIn = document.createElement('input');
  nameIn.type = 'text';
  nameIn.required = true;
  nameIn.value = scenario?.name || '';
  const nameField = field(t('whatIfEditor.nameLabel'), nameIn);

  const list = document.createElement('div');
  list.className = 'whatif-change-list';
  const emptyMsg = document.createElement('p');
  emptyMsg.className = 'muted whatif-change-empty';
  emptyMsg.textContent = t('whatIfEditor.noChanges');

  /** @type {{ el: HTMLElement, read: () => any }[]} */
  const rows = [];
  /** @type {HTMLButtonElement | null} */
  let saveBtn = null;
  // A scenario needs at least one change: Save stays disabled until there is
  // one (the save would refuse it anyway), and the empty note says why.
  const refreshEmpty = () => {
    emptyMsg.style.display = rows.length ? 'none' : '';
    if (saveBtn) {
      saveBtn.disabled = !rows.length;
      saveBtn.title = rows.length ? '' : t('whatIfEditor.noChanges');
    }
  };

  function removeRow(row) {
    const i = rows.indexOf(row);
    if (i >= 0) rows.splice(i, 1);
    row.el.remove();
    refreshEmpty();
  }

  function createRow(type, change) {
    let row;
    const onRemove = () => { removeRow(row); tracker.markDirty(); };
    if (type === 'income') row = buildIncomeRow(change, { incomeItems, onRemove });
    else if (type === 'monthly') row = buildMonthlyRow(change, { accounts, onRemove });
    else if (type === 'oneoff') row = buildOneoffRow(change, { accounts, onRemove });
    else row = buildStressRow(change, { onRemove });
    rows.push(row);
    list.append(row.el);
    refreshEmpty();
    return row;
  }

  for (const c of scenario?.changes || []) {
    if (c && c.type) createRow(c.type, c);
  }
  refreshEmpty();

  const addBtns = document.createElement('div');
  addBtns.className = 'whatif-add-row';
  for (const [type, key] of [['income', 'addIncome'], ['monthly', 'addMonthly'], ['oneoff', 'addOneoff'], ['stress', 'addStress']]) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn btn-sm btn-ghost';
    b.textContent = t(`whatIfEditor.${key}`);
    b.addEventListener('click', () => {
      createRow(type, defaultChange(type, { today, accounts }));
      tracker.markDirty();
    });
    addBtns.append(b);
  }

  const errEl = document.createElement('div');
  errEl.style.cssText = 'color:var(--danger-text);font-size:13px;margin-top:8px;display:none;';
  const showError = (msg) => { errEl.textContent = msg; errEl.style.display = 'block'; };
  const clearError = () => { errEl.style.display = 'none'; errEl.textContent = ''; };

  form.append(nameField, list, emptyMsg, addBtns, errEl);

  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'btn btn-ghost';
  cancelBtn.textContent = t('common.cancel');
  saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.className = 'btn btn-accent';
  saveBtn.textContent = t('common.save');
  saveBtn.addEventListener('click', () => form.requestSubmit());
  // In a footer under the form, as add-tx and the plan editor have it.
  const footer = document.createElement('div');
  footer.dataset.sheetActions = '';
  footer.className = 'sheet-footer-actions';
  const footerEnd = document.createElement('div');
  footerEnd.className = 'sheet-footer-actions-end';
  footerEnd.append(cancelBtn, saveBtn);
  footer.append(document.createElement('span'), footerEnd);
  form.append(footer);
  refreshEmpty();

  const { close, requestClose } = openSheet({
    title: isNew ? t('whatIfEditor.addTitle') : t('whatIfEditor.editTitle'),
    content: form,
    confirmClose: tracker.confirmClose,
  });
  cancelBtn.addEventListener('click', requestClose);

  form.addEventListener('submit', guardSubmit(async (e) => {
    e.preventDefault();
    clearError();
    const draft = { id: draftId, name: nameIn.value.trim(), changes: rows.map(r => r.read()) };
    const normalized = normalizeScenarios([draft], { accounts, budgetItems });
    if (!normalized.length) {
      showError(t('whatIfEditor.errEmpty'));
      return;
    }
    // Never save a change the cleanup would silently drop (an amount of 0,
    // a day after the 28th, a missing account…): say so and let the user
    // fix or remove it.
    const dropped = draft.changes.length - normalized[0].changes.length;
    if (dropped > 0) {
      showError(t('whatIfEditor.errIncomplete')(dropped));
      return;
    }
    const ok = await onSave(normalized[0]);
    if (ok === false) return;
    close();
  }));
}
