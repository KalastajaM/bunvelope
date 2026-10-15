// js/pages/investments-holding-dialog.js — add/edit-holding sheet, split
// out of investments.js. Field helpers are local to the dialog. A save is one
// session batch (rename, override, price), so it lands whole or not at all.

import { state, session, navigate, now as appNow } from '../app.js';
import { isoDate } from '../core/context.js';
import { t } from '../ui/i18n.js';
import { toast } from '../ui/toast.js';
import { confirmDialog } from '../ui/dialog.js';
import { openSheet } from '../ui/sheet.js';
import { trackDirty } from '../ui/dirty-guard.js';
import { guardSubmit } from '../ui/submit-guard.js';
import { withBusy } from '../ui/busy.js';
import { dispatchOrReport, dispatchBatchOrReport } from '../ui/save-error.js';
import { attachFieldHint, setFieldHint } from '../ui/field-hint.js';
import { getInvestmentsMeta } from '../state/investments.js';
import { ensureSymbolsDatalist } from './investments-shared.js';
import { enableFormulaInput, parseAmountInput } from '../ui/amount-input.js';

export function openHoldingDialog({ accounts, initial = null, priceInfo = null }) {
  const isNew = !initial;
  const form = document.createElement('form');
  form.style.cssText = 'display:flex;flex-direction:column;gap:14px;';

  const intro = document.createElement('div');
  intro.className = 'muted';
  intro.style.cssText = 'font-size:13px;line-height:1.5;';
  intro.textContent = isNew ? t('investments.dialog.introNew') : t('investments.dialog.introEdit');
  form.append(intro);

  const acctWrap = document.createElement('div');
  acctWrap.className = 'field';
  const acctLbl = document.createElement('label');
  acctLbl.textContent = t('investments.dialog.account');
  const acctSel = document.createElement('select');
  for (const a of accounts) {
    const o = document.createElement('option');
    o.value = a.id;
    o.textContent = a.name;
    if (initial && initial.accountId === a.id) o.selected = true;
    acctSel.append(o);
  }
  acctSel.disabled = !!initial;
  acctWrap.append(acctLbl, acctSel);
  form.append(acctWrap);

  const symRow = document.createElement('div');
  symRow.style.cssText = 'display:grid;grid-template-columns:1fr 2fr;gap:12px;';
  const symField = textField(t('investments.dialog.symbol'), initial?.symbol || '', { upper: true, required: true });
  symField.input.placeholder = t('investments.dialog.symbolPh');
  if (!initial) {
    symField.input.setAttribute('list', ensureSymbolsDatalist());
    symField.input.autocomplete = 'off';
  }
  const nameField = textField(t('investments.dialog.name'), initial?.name || '');
  nameField.input.placeholder = t('investments.dialog.namePh');
  symRow.append(symField.wrap, nameField.wrap);
  form.append(symRow);

  const unitsCostRow = document.createElement('div');
  unitsCostRow.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:12px;';
  const unitsField = numberField(t('investments.dialog.units'), initial?.units ?? '', '0.000001');
  const costField = numberField(t('investments.dialog.costBasis'), initial?.costBasis ?? '', '0.01');
  const costHelp = document.createElement('p');
  costHelp.className = 'muted';
  costHelp.textContent = t('investments.dialog.costHelp');
  costField.wrap.append(costHelp);
  const modeWrap = document.createElement('div');
  modeWrap.className = 'field';
  const modeLabel = document.createElement('label');
  modeLabel.textContent = t('investments.dialog.costTracking');
  const modeSelect = document.createElement('select');
  modeSelect.setAttribute('aria-label', modeLabel.textContent);
  for (const [value, key] of [['cost', 'trackCost'], ['value', 'valueOnly']]) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = t('investments.dialog.' + key);
    modeSelect.append(option);
  }
  modeSelect.value = initial?.valuationOnly ? 'value' : 'cost';
  const modeHelp = document.createElement('p');
  modeHelp.className = 'muted';
  modeHelp.textContent = t('investments.dialog.valueOnlyHelp');
  modeWrap.append(modeLabel, modeSelect, modeHelp);
  form.append(modeWrap);
  const syncCostMode = () => {
    modeHelp.hidden = modeSelect.value !== 'value';
    costField.wrap.hidden = modeSelect.value === 'value';
    costField.input.disabled = modeSelect.value === 'value';
  };
  modeSelect.addEventListener('change', syncCostMode);
  syncCostMode();
  unitsCostRow.append(unitsField.wrap, costField.wrap);
  form.append(unitsCostRow);
  if (initial && initial.overridden === false) {
    unitsField.input.readOnly = true;
    costField.input.readOnly = true;
    const hint = document.createElement('p');
    hint.className = 'muted';
    hint.textContent = t('coreError.holdingHasHistory');
    form.append(hint);
  }

  for (const f of [symField, unitsField, costField]) {
    attachFieldHint(f.wrap, f.input);
    f.input.addEventListener('input', () => setFieldHint(f.wrap, ''));
  }

  const priceRow = document.createElement('div');
  priceRow.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:12px;';
  const priceField = numberField(t('investments.dialog.price'), priceInfo?.price ?? '', '0.00001');
  const asOfField = textField(t('investments.dialog.asOf'), priceInfo?.asOf || isoDate(appNow()));
  asOfField.input.type = 'date';
  priceRow.append(priceField.wrap, asOfField.wrap);
  form.append(priceRow);

  const existingUrl = (() => {
    if (!initial?.accountId || !initial?.symbol) return '';
    const inv = getInvestmentsMeta(state.meta);
    const sym = String(initial.symbol).trim().toUpperCase();
    return inv.holdingOverrides?.[initial.accountId]?.[sym]?.priceUrl || '';
  })();
  const urlField = textField(t('investments.dialog.priceUrl'), existingUrl);
  urlField.input.type = 'url';
  urlField.input.placeholder = t('investments.dialog.priceUrlPh');
  const urlHelp = document.createElement('div');
  urlHelp.className = 'muted';
  urlHelp.style.cssText = 'font-size:11.5px;margin-top:4px;';
  urlHelp.textContent = t('investments.dialog.priceUrlHelp');
  urlField.wrap.append(urlHelp);
  form.append(urlField.wrap);

  const footer = document.createElement('div');
  footer.dataset.sheetActions = '';
  footer.style.cssText = 'display:flex;justify-content:space-between;gap:8px;margin-top:8px;';
  const leftSide = document.createElement('div');
  if (initial?.overridden) {
    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'btn btn-ghost';
    removeBtn.textContent = t('investments.dialog.clearOverride');
    removeBtn.style.color = 'var(--danger, var(--rose))';
    removeBtn.addEventListener('click', async () => {
      const ok = await confirmDialog(t('investments.dialog.clearOverrideConfirm'));
      if (!ok) return;
      const cleared = await dispatchOrReport(session, 'investment.removeHolding', { account: initial.accountId, symbol: initial.symbol });
      if (!cleared) return;
      toast(t('investments.dialog.cleared'));
      close();
      navigate('investments');
    });
    leftSide.append(removeBtn);
  }
  footer.append(leftSide);

  const rightSide = document.createElement('div');
  rightSide.style.cssText = 'display:flex;gap:8px;';
  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'btn btn-ghost';
  cancelBtn.textContent = t('common.close');
  const saveBtn = document.createElement('button');
  saveBtn.type = 'submit';
  saveBtn.className = 'btn btn-accent';
  saveBtn.textContent = t('investments.dialog.save');
  rightSide.append(cancelBtn, saveBtn);
  footer.append(rightSide);
  form.append(footer);

  const tracker = trackDirty(form);
  const { close, requestClose } = openSheet({
    title: isNew ? t('investments.dialog.titleNew') : t('investments.dialog.titleEdit'),
    content: form,
    confirmClose: tracker.confirmClose,
  });
  cancelBtn.addEventListener('click', requestClose);

  form.addEventListener('submit', guardSubmit(async (e) => {
    e.preventDefault();
    const accountId = acctSel.value;
    const symbol = symField.input.value.trim().toUpperCase();
    if (!accountId || !symbol) {
      setFieldHint(symField.wrap, t('investments.dialog.symbolRequired'));
      symField.input.focus();
      return;
    }
    const numOrZero = (raw) => {
      const v = String(raw ?? '').trim();
      if (v === '') return 0;
      const n = parseAmountInput(v);
      return Number.isFinite(n) ? n : NaN;
    };
    const units = numOrZero(unitsField.input.value);
    const costBasis = modeSelect.value === 'value' ? (initial?.costBasis ?? 0) : numOrZero(costField.input.value);
    const unitsBad = !Number.isFinite(units) || units < 0;
    const costBad = !Number.isFinite(costBasis) || costBasis < 0;
    if (unitsBad || costBad) {
      if (unitsBad) setFieldHint(unitsField.wrap, t('investments.dialog.invalidNumbers'));
      if (costBad) setFieldHint(costField.wrap, t('investments.dialog.invalidNumbers'));
      (unitsBad ? unitsField : costField).input.focus();
      return;
    }
    const name = nameField.input.value.trim();
    const priceUrl = urlField.input.value.trim();

    const oldSymbol = initial?.symbol ? String(initial.symbol).trim().toUpperCase() : '';
    const renaming = oldSymbol && oldSymbol !== symbol;
    if (renaming) {
      const ok = await confirmDialog(t('investments.dialog.renameConfirm')(oldSymbol, symbol));
      if (!ok) return;
    }

    const steps = [];
    if (renaming) steps.push({ name: 'investment.renameSymbol', input: { from: oldSymbol, to: symbol } });
    steps.push({ name: 'investment.setHolding', input: { account: accountId, symbol, units, costBasis, name, priceUrl, ...(modeSelect.value === 'value' ? { valuationOnly: true } : {}) } });
    const priceVal = parseAmountInput(priceField.input.value);
    if (Number.isFinite(priceVal) && priceVal > 0) {
      const asOf = asOfField.input.value || isoDate(appNow());
      steps.push({ name: 'investment.setPrice', input: { symbol, price: priceVal, asOf } });
    }
    const saved = await withBusy(saveBtn, () => dispatchBatchOrReport(session, steps), { label: t('common.saving') });
    // On a failure the sheet stays open with the user's input, so they can retry.
    if (!saved) return;
    toast(t('investments.dialog.saved'));
    close();
    navigate('investments');
  }));
}

function textField(label, value, { upper = false, required = false } = {}) {
  const wrap = document.createElement('div'); wrap.className = 'field';
  const lbl = document.createElement('label'); lbl.textContent = label;
  const input = document.createElement('input');
  input.type = 'text';
  input.value = value || '';
  if (required) input.required = true;
  if (upper) {
    input.style.textTransform = 'uppercase';
    input.addEventListener('input', () => { input.value = input.value.toUpperCase(); });
  }
  wrap.append(lbl, input);
  return { wrap, input };
}

function numberField(label, value, step) {
  const wrap = document.createElement('div'); wrap.className = 'field';
  const lbl = document.createElement('label'); lbl.textContent = label;
  const input = document.createElement('input');
  input.type = 'number';
  input.step = step;
  input.min = '0';
  input.inputMode = 'decimal';
  input.value = value === '' || value === null || value === undefined ? '' : String(value);
  // Evaluation precision follows the step (0.000001 → 6dp units, 0.00001 →
  // 5dp prices); money steps fall back to the 2dp default.
  enableFormulaInput(input, { decimals: (String(step).split('.')[1] || '').length || 2 });
  wrap.append(lbl, input);
  return { wrap, input };
}

// ── AI portfolio insight card ───────────────────────────────────────────
// Auto-fetches on mount. Prompts the model with cost-basis-only data; the
// server prompt forbids buy/sell/hold advice and price predictions.
