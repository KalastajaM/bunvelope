// Editor for additional expenses used only in stress scenarios.
import { state, session } from '../app.js';
import { currentBudgetSession } from '../state/budget-session.js';
import { MONTHS, SCENARIOS } from '../engine/stress.js';
import { isSpendingAccount } from '../engine/balances.js';
import { t } from '../ui/i18n.js';
import { fmt } from '../utils.js';
import { openSheet } from '../ui/sheet.js';
import { trackDirty } from '../ui/dirty-guard.js';
import { dispatchOrReport } from '../ui/save-error.js';
import { withBusy } from '../ui/busy.js';
import { guardSubmit } from '../ui/submit-guard.js';
import { confirmDialog } from '../ui/dialog.js';

export function buildStressExpenses(expenses, onChange) {
  const section = document.createElement('section');
  section.className = 'card';
  section.id = 'stress-expenses';
  section.style.marginTop = '12px';
  const title = document.createElement('h3'); title.textContent = t('stressExpenses.title');
  const help = document.createElement('p'); help.className = 'muted'; help.textContent = t('stressExpenses.help');
  const add = document.createElement('button'); add.className = 'btn btn-ghost'; add.textContent = t('stressExpenses.add');
  add.addEventListener('click', () => openExpense(null, onChange));
  section.append(title, help, add);
  for (const expense of expenses) {
    const row = document.createElement('div'); row.className = 'field';
    const edit = document.createElement('button'); edit.className = 'btn btn-ghost'; edit.textContent = expense.name;
    edit.addEventListener('click', () => openExpense(expense, onChange));
    const amounts = document.createElement('p'); amounts.className = 'muted';
    amounts.textContent = `${t('stressExpenses.annual')}: ${SCENARIOS.map(s => `${s} ${fmt(expense.annual[s])}`).join(' · ')}`;
    row.append(edit, amounts); section.append(row);
  }
  return section;
}

function openExpense(expense, onChange) {
  const generation = currentBudgetSession(), folder = state.budgetFolder;
  const current = () => generation === currentBudgetSession() && folder === state.budgetFolder;
  const form = document.createElement('form'); form.dataset.stressExpenseForm = '';
  form.style.cssText = 'display:flex;flex-direction:column;gap:12px;';
  let fieldId = 0;
  const field = (label, input) => {
    const wrap = document.createElement('div'); wrap.className = 'field';
    const caption = document.createElement('label'); caption.textContent = label;
    input.id = `stress-expense-field-${++fieldId}`; caption.htmlFor = input.id;
    wrap.append(caption, input); form.append(wrap); return input;
  };
  const name = field(t('stressExpenses.name'), document.createElement('input'));
  name.name = 'name'; name.required = true; name.value = expense?.name || '';
  const account = field(t('stressExpenses.account'), document.createElement('select')); account.name = 'account'; account.required = true;
  for (const a of state.accounts.filter(a => !a.archived && isSpendingAccount(a))) {
    const opt = document.createElement('option'); opt.value = a.id; opt.textContent = a.name; account.append(opt);
  }
  if (expense) account.value = expense.account;
  const inputs = {};
  for (const s of SCENARIOS) {
    const input = field(`${s} — ${t('stressExpenses.monthly')}`, document.createElement('input'));
    input.type = 'number'; input.min = '0'; input.step = '0.01'; input.required = true; input.name = s;
    input.value = String(expense?.amounts[s] || 0); inputs[s] = input;
  }
  const day = field(t('stressExpenses.day'), document.createElement('input'));
  day.type = 'number'; day.min = '1'; day.max = '28'; day.required = true; day.name = 'day'; day.value = String(expense?.day || 1);
  const months = document.createElement('fieldset');
  months.style.cssText = 'display:flex;flex-wrap:wrap;gap:10px;padding:12px;border:1px solid var(--border);border-radius:12px;';
  const legend = document.createElement('legend'); legend.textContent = t('stressExpenses.months'); months.append(legend);
  const boxes = {};
  for (const m of MONTHS) {
    const label = document.createElement('label'); label.style.cssText = 'display:inline-flex;align-items:center;gap:6px;white-space:nowrap;';
    const input = document.createElement('input'); input.type = 'checkbox'; input.name = m; input.style.width = 'auto';
    input.checked = expense ? expense.months[m] === true : true; boxes[m] = input;
    label.append(input, document.createTextNode(t(`bp.monthAbbr.${m}`))); months.append(label);
  }
  form.append(months);
  const error = document.createElement('p'); error.setAttribute('role', 'alert'); error.className = 'field-hint'; form.append(error);
  const actions = document.createElement('div');
  actions.dataset.sheetActions = '';
  actions.className = 'sheet-actions';
  actions.style.cssText = 'display:flex;justify-content:flex-end;gap:8px;';
  const cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'btn btn-ghost'; cancel.textContent = t('common.cancel');
  const save = document.createElement('button'); save.type = 'submit'; save.className = 'btn btn-accent'; save.textContent = t('common.save');
  actions.append(cancel, save); form.append(actions);
  const tracker = trackDirty(form);
  const { close, requestClose } = openSheet({ title: t('stressExpenses.title'), content: form, confirmClose: tracker.confirmClose });
  cancel.addEventListener('click', requestClose);
  if (expense) {
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'btn btn-ghost'; remove.textContent = t('common.delete');
    remove.addEventListener('click', async () => {
      if (!current() || !await confirmDialog(t('stressExpenses.deleteConfirm')) || !current()) return;
      const result = await withBusy(remove, () => dispatchOrReport(session, 'stressExpense.delete', { id: expense.id }));
      if (result && current()) { close(); onChange(); }
    });
    actions.prepend(remove);
  }
  form.addEventListener('submit', guardSubmit(async event => {
    event.preventDefault();
    if (!current()) { close(); return; }
    const amounts = Object.fromEntries(SCENARIOS.map(s => [s, Number(inputs[s].value)]));
    const selected = Object.fromEntries(MONTHS.map(m => [m, boxes[m].checked]));
    if (!name.value.trim() || !Object.values(amounts).some(v => v > 0) || !Object.values(selected).some(Boolean)) {
      error.textContent = t('stressExpenses.invalid'); return;
    }
    const input = { name: name.value.trim(), account: account.value, day: Number(day.value), amounts, months: selected };
    if (expense) input.id = expense.id;
    const result = await withBusy(save, () => dispatchOrReport(session, 'stressExpense.set', input));
    if (result && current()) { close(); onChange(); }
  }));
}
