import { setupFormValidation, markRequired, fieldError, focusField } from '../ui/form-validation.js';
import { isoDate } from '../core/context.js';
import { subscriptionDraft } from '../core/subscription-draft.js';
import { disclosure, node } from '../ui/planning-workspace.js';
import { currentBudgetSession } from '../state/budget-session.js';
import { flushItems } from '../ui/plan-item-live.js';
// js/pages/budget-plan-editor.js — the Budget Plan item editor sheet.
//
// Lifted out of budget-plan.js, which was 1659 lines with 685 of them here:
// the kind selector, the amount and buffer fields, the twelve month cells and
// their custom amounts, the schedule/account block, the stress category and
// its per-scenario cuts, delete, and save.
//
// It owns the sheet and nothing else. It writes through the session
// (budgetItem.create / update / delete). The one thing it needs from the page,
// the table repaint, comes in as a callback rather than as an import, so the
// dependency stays one-directional: the page imports the editor, never the
// other way round.

import { runDueScheduled, session, state, now } from '../app.js';
import { clampFrac, cutScenariosFor, setStressCutPct, stressCutPct } from '../engine/stress.js';
import { enableFormulaInput, parseAmountInput } from '../ui/amount-input.js';
import { withBusy } from '../ui/busy.js';
import { confirmDialog } from '../ui/dialog.js';
import { trackDirty } from '../ui/dirty-guard.js';
import { t, fmtMonthLang, fmtDateLang } from '../ui/i18n.js';
import { dispatchOrReport, reportDispatchFailure, reportMetaFailure } from '../ui/save-error.js';
import { openSheet } from '../ui/sheet.js';
import { enhanceSelectWithSearch } from '../ui/select-combobox.js';
import { guardSubmit } from '../ui/submit-guard.js';
import { toast } from '../ui/toast.js';
import { undoAction } from '../ui/undo-action.js';
import { escHtml, fmt } from '../utils.js';
import { resolveFundingStyle, LOAN_METHODS, itemStartMonth, itemEndMonth } from '../engine.js';
import { ask } from '../ui/query.js';
import { isAccountPickerEnabled, accountEmptyLabelKey } from './budget-plan-account-rules.js';
import { QUARTERS, collectScheduleFromCells, paintCell, wireMonthCell } from './budget-plan-cells.js';
import {
  a11ySwitch, accountSelectHtml, envelopeSelectHtml, field,
  showToast, todayYmd, updateDialogTotals,
} from './budget-plan-shared.js';

/**
 * Open the editor for `state.budgetItems[idx]`, or for a brand-new item when
 * `idx` is -1.
 *
 * `rerenderTable` is the page's own; it takes the page container, which the
 * sheet already has. It runs after a save or a delete has been written.
 */
export function openBudgetItemEditor(container, idx, { rerenderTable, prefillScheduled = null }) {
  const generation = currentBudgetSession();
  const folder = state.budgetFolder;
  const isCurrent = () => currentBudgetSession() === generation && state.budgetFolder === folder;
  const isNew = idx === -1;
  const item = isNew
    ? {
        id: '', envelope_id: '', description: null,
        default_amount: 0, extra_buffer: 0, include: true,
        // Every month, as budgetItem.create defaults (owner decision 2026-10-05).
        monthly_schedule: Object.fromEntries(QUARTERS.flatMap(q => q.months).map(m => [m, true])),
        payment_day: 0,
        stress_category: null, stress_cut_pct: 0,
        include_in_emergency_budget: false,
        as_schedule: false, account_id: null, as_schedule_since: null,
        schedule_day_type: 'exact', kind: 'expense',
        investment_account_id: null, symbol: null, to_account_id: null,
      }
    : {
        ...state.budgetItems[idx],
        monthly_schedule: { ...(state.budgetItems[idx].monthly_schedule ?? {}) },
      };
  if (isNew && prefillScheduled) Object.assign(item, subscriptionDraft(prefillScheduled, state, isoDate(now())));
  if (!['income', 'investment_transfer', 'account_transfer', 'loan_payment'].includes(item.kind)) item.kind = 'expense';
  // A loan payment is offered once there is a loan to pay (or this item is one).
  const offerLoan = item.kind === 'loan_payment'
    || (state.accounts || []).some(a => a && a.type === 'loan' && !a.archived);
  const KINDS = [
    ['expense', t('budgetPlan.kindExpense')],
    ['income', t('budgetPlan.kindIncome')],
    ['investment_transfer', t('budgetPlan.kindInvestment')],
    ['account_transfer', t('budgetPlan.kindTransfer')],
    ...(offerLoan ? [['loan_payment', t('budgetPlan.kindLoan')]] : []),
  ];

  const form = document.createElement('form');
  if (isNew && prefillScheduled) {
    const hint = document.createElement('p'); hint.className = 'page-intro';
    hint.textContent = t(item.as_schedule ? 'discovery.aiDraftHelp' : 'discovery.unsupportedCadence');
    form.append(hint);
  }

  // ── Kind selector (expense / income / investment) ────────────────────────
  const kindSel = document.createElement('select');
  kindSel.id = 'bp-f-kind';
  KINDS.forEach(([v, lbl]) => {
    const o = document.createElement('option'); o.value = v; o.textContent = lbl;
    if (v === item.kind) o.selected = true;
    kindSel.append(o);
  });

  // ── Inputs ────────────────────────────────────────────────────────────────
  const envSel = document.createElement('select');
  envSel.id = 'bp-f-envelope';
  envSel.innerHTML = envelopeSelectHtml(item.envelope_id, { includeEmpty: true });
  // UI-only value: the stored representation of Unallocated is null.
  const unallocatedValue = '__unallocated__';
  const unallocatedOption = document.createElement('option');
  unallocatedOption.value = unallocatedValue;
  unallocatedOption.textContent = t('addTx.unallocated');
  envSel.insertBefore(unallocatedOption, envSel.children[1] || null);
  if ((!isNew || prefillScheduled) && !item.envelope_id && (!item.kind || item.kind === 'expense')) envSel.value = unallocatedValue;

  const descIn = document.createElement('input');
  descIn.type = 'text'; descIn.id = 'bp-f-description';
  descIn.value = item.description ?? '';
  descIn.placeholder = t('budgetPlan.descPlaceholder');

  const amtIn = document.createElement('input');
  amtIn.type = 'number'; amtIn.id = 'bp-f-amount';
  amtIn.step = '0.01'; amtIn.min = '0';
  amtIn.value = Math.abs(item.default_amount ?? 0);
  enableFormulaInput(amtIn);

  const transferMode = document.createElement('select');
  transferMode.id = 'bp-f-transfer-mode';
  for (const [value, key] of [['fixed', 'fixedTransfer'], ['target_balance', 'targetBalance']]) {
    const option = document.createElement('option');
    option.value = value; option.textContent = t(`budgetPlan.${key}`); transferMode.append(option);
  }
  transferMode.value = item.transfer_mode || 'fixed';
  const targetIn = document.createElement('input');
  targetIn.type = 'number'; targetIn.id = 'bp-f-target-balance';
  targetIn.step = '0.01'; targetIn.min = '0'; targetIn.value = item.target_balance ?? 500;
  const modeField = field(t('budgetPlan.transferMode'), transferMode);
  const targetField = field(t('budgetPlan.targetBalance'), targetIn);
  const targetHint = node('p', 'field-hint field-hint--info', t('budgetPlan.targetHint'));
  const targetPreview = node('p', 'field-hint field-hint--info');
  targetPreview.id = 'bp-transfer-preview'; targetPreview.setAttribute('aria-live', 'polite');
  const topUpBtn = node('button', 'btn btn-sm btn-ghost', t('budgetPlan.topUpNow'));
  topUpBtn.type = 'button';
  const targetControls = document.createElement('div');
  targetControls.append(targetHint, targetPreview, topUpBtn);
  const targetMode = () => kindSel.value === 'account_transfer' && transferMode.value === 'target_balance';

  const payDayIn = document.createElement('input');
  payDayIn.type = 'number'; payDayIn.id = 'bp-f-payment-day';
  payDayIn.step = '1'; payDayIn.min = '0'; payDayIn.max = '31';
  payDayIn.value = item.payment_day ?? 0;

  const stressSel = document.createElement('select');
  stressSel.id = 'bp-f-stress-cat';
  const stressCatVal = item.stress_category ?? '';
  [['', t('budgetPlan.stressCatNone')], ['A', t('budgetPlan.stressCatA')], ['B', t('budgetPlan.stressCatB')],
   ['C', t('budgetPlan.stressCatC')], ['D', t('budgetPlan.stressCatD')],
   ['E', t('budgetPlan.stressCatE')], ['Z', t('budgetPlan.stressCatZ')]].forEach(([v, lbl]) => {
    const o = document.createElement('option');
    o.value = v; o.textContent = lbl;
    if (v === stressCatVal) o.selected = true;
    stressSel.append(o);
  });

  // Per-scenario stress cuts: a working copy edited via the dynamic slider
  // group below, sent as the save's fields (never mutates `item`). The
  // command prunes the map to the scenarios the chosen category hits.
  const stressDraft = {
    stress_category: item.stress_category ?? null,
    stress_cut_pct: item.stress_cut_pct ?? 0,
    stress_cut_pcts: item.stress_cut_pcts ? { ...item.stress_cut_pcts } : undefined,
  };

  const includeCb = document.createElement('input');
  includeCb.type = 'checkbox'; includeCb.id = 'bp-f-include';
  // Only an explicit `include: false` is disabled (the engine's rule too):
  // an item saved before the field existed must not be switched off, and so
  // stop posting, just by opening and saving it.
  includeCb.checked = item.include !== false;

  const emergencyCb = document.createElement('input');
  emergencyCb.type = 'checkbox'; emergencyCb.id = 'bp-f-emergency';
  emergencyCb.checked = !!item.include_in_emergency_budget;

  const bufferIn = document.createElement('input');
  bufferIn.type = 'number'; bufferIn.id = 'bp-f-buffer';
  bufferIn.step = '0.01'; bufferIn.min = '0';
  bufferIn.value = Math.abs(item.extra_buffer ?? 0);
  bufferIn.placeholder = '0';
  enableFormulaInput(bufferIn);

  const asScheduleCb = document.createElement('input');
  asScheduleCb.type = 'checkbox'; asScheduleCb.id = 'bp-f-as-schedule';
  asScheduleCb.checked = !!item.as_schedule;

  const accountSel = document.createElement('select');
  accountSel.id = 'bp-f-account';
  accountSel.innerHTML = accountSelectHtml(item.account_id, {
    emptyLabel: t(accountEmptyLabelKey(item.kind, !!item.as_schedule)),
  });
  // Refreshed whenever kind or scheduling changes; see applyKindVisibility
  // and the "Post as scheduled" toggle handlers below. The empty option's
  // label follows too: "from history" is only true while unscheduled.
  function refreshAccountSelDisabled() {
    accountSel.disabled = !isAccountPickerEnabled(kindSel.value, asScheduleCb.checked);
    const empty = accountSel.querySelector('option[value=""]');
    if (empty) empty.textContent = t(accountEmptyLabelKey(kindSel.value, asScheduleCb.checked));
  }
  refreshAccountSelDisabled();
  asScheduleCb.addEventListener('change', () => {
    refreshAccountSelDisabled();
    refreshPlannedAccountHint();
  });

  const dayTypeSel = document.createElement('select');
  dayTypeSel.id = 'bp-f-day-type';
  dayTypeSel.disabled = !asScheduleCb.checked;
  [['exact', t('budgetPlan.dayTypeExact')], ['next_work_day', t('budgetPlan.dayTypeNextWork')], ['prev_work_day', t('budgetPlan.dayTypePrevWork')]].forEach(([v, lbl]) => {
    const o = document.createElement('option');
    o.value = v; o.textContent = lbl;
    if (v === (item.schedule_day_type || 'exact')) o.selected = true;
    dayTypeSel.append(o);
  });
  asScheduleCb.addEventListener('change', () => {
    dayTypeSel.disabled = !asScheduleCb.checked;
  });

  // ── Kind toggle buttons ────────────────────────────────────────────────────
  const kindBtns = document.createElement('div');
  kindBtns.className = 'tx-type-btns';
  kindBtns.style.cssText = 'flex:1;display:flex;gap:6px;';
  const kindBtnEls = KINDS.map(([v, lbl]) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'tx-type-btn' + (v === item.kind ? ' is-active' : '');
    b.style.cssText = 'flex:1;min-width:72px;height:100%;';
    b.textContent = lbl;
    b.addEventListener('click', () => {
      kindSel.value = v;
      kindBtnEls.forEach(btn => btn.classList.toggle('is-active', btn === b));
      kindSel.dispatchEvent(new Event('change'));
    });
    return b;
  });
  kindBtns.append(...kindBtnEls);
  kindSel.style.display = 'none';

  // ── Row 1: Kind buttons + Envelope / Template ─────────────────────────────
  const kindEnvRow = document.createElement('div');
  // Wraps on a narrow sheet: four kind buttons need ~380px on their own.
  kindEnvRow.style.cssText = 'display:flex;flex-wrap:wrap;gap:10px;align-items:stretch;margin-bottom:14px;';
  const kindBtnsField = document.createElement('div');
  kindBtnsField.className = 'field';
  kindBtnsField.style.cssText = 'flex:none;width:390px;max-width:100%;margin-bottom:0;display:flex;flex-direction:column;';
  const kindBtnsLbl = document.createElement('label');
  kindBtnsLbl.textContent = t('budgetPlan.kind');
  kindBtnsField.append(kindBtnsLbl, kindBtns, kindSel);
  const envField = field(t('addTx.envelope'), envSel);
  envField.style.cssText = 'flex:1 1 200px;margin-bottom:0;';
  // The searchable picker the transaction sheets use. The select it hides
  // stays the value; the label and focus go to its search input. The submit
  // checks the envelope itself (a required hidden select would block the
  // submit with nothing shown).
  enhanceSelectWithSearch(envSel, { placeholder: t('addTx.envelopeSearchPh'), noMatch: t('addTx.envelopeNoMatch') });
  const envSearch = /** @type {HTMLInputElement} */ (envField.querySelector('input[role="combobox"]'));
  envField.querySelector('label').htmlFor = envSearch.id;
  kindEnvRow.append(kindBtnsField, envField);

  // Income has no envelope — it lands in unallocated. This used to be where
  // the "Envelope Template" picker sat, so say where allocation lives now
  // rather than leaving a hole for anyone who remembers the picker.
  const incomeHint = document.createElement('div');
  incomeHint.className = 'field-hint field-hint--info';
  incomeHint.style.cssText = 'flex:1 1 200px;align-self:flex-end;margin-bottom:6px;';
  incomeHint.textContent = t('bp.incomeAllocationHint');
  kindEnvRow.append(incomeHint);

  // ── Row 2: Amount + Payment Day + Description ─────────────────────────────
  const basicRow = document.createElement('div');
  basicRow.style.cssText = 'display:flex;gap:10px;margin-bottom:14px;';
  const amtField = field(t('budgetPlan.defaultAmount'), amtIn);
  amtField.style.cssText = 'flex:none;width:145px;margin-bottom:0;';
  const payDayField = field(t('budgetPlan.dayLabel'), payDayIn);
  payDayField.style.cssText = 'flex:none;width:145px;margin-bottom:0;';
  const descField = field(t('budgetPlan.descriptionOptional'), descIn);
  descField.style.cssText = 'flex:1;margin-bottom:0;';
  basicRow.append(amtField, payDayField, descField);

  // ── Toggle rows for Include in Budget / Emergency ─────────────────────────
  const includeToggleEl = document.createElement('div');
  // Drawn from the same rule as the hidden checkbox: only an explicit
  // `include: false` is off.
  includeToggleEl.className = 'toggle' + (item.include !== false ? ' on' : '');
  const includeToggleRow = document.createElement('div');
  includeToggleRow.style.cssText = 'display:grid;grid-template-columns:38px 1fr;align-items:center;gap:10px;margin-bottom:10px;';
  const includeLblEl = document.createElement('span');
  includeLblEl.textContent = t('budgetPlan.includeBudget');
  includeLblEl.style.cssText = 'font-size:14px;cursor:pointer;';
  [includeToggleEl, includeLblEl].forEach(el => el.addEventListener('click', () => {
    includeToggleEl.classList.toggle('on');
    includeCb.checked = includeToggleEl.classList.contains('on');
  }));
  // What switching this off does beyond the totals: a scheduled item pauses.
  const includeHintEl = document.createElement('span');
  includeHintEl.className = 'muted';
  includeHintEl.textContent = t('budgetPlan.disabledHint');
  includeHintEl.style.cssText = 'grid-column:2;font-size:12px;margin-top:-8px;';
  includeToggleRow.append(includeToggleEl, includeLblEl, includeHintEl);
  a11ySwitch(includeToggleEl, t('budgetPlan.includeBudget'));

  const emergencyToggleEl = document.createElement('div');
  emergencyToggleEl.className = 'toggle' + (item.include_in_emergency_budget ? ' on' : '');
  const emergencyToggleRow = document.createElement('div');
  emergencyToggleRow.style.cssText = 'display:grid;grid-template-columns:38px 1fr;align-items:center;gap:10px;';
  const emergencyLblEl = document.createElement('span');
  emergencyLblEl.textContent = t('budgetPlan.includeEmergency');
  emergencyLblEl.style.cssText = 'font-size:14px;cursor:pointer;';
  [emergencyToggleEl, emergencyLblEl].forEach(el => el.addEventListener('click', () => {
    emergencyToggleEl.classList.toggle('on');
    emergencyCb.checked = emergencyToggleEl.classList.contains('on');
  }));
  emergencyToggleRow.append(emergencyToggleEl, emergencyLblEl);
  a11ySwitch(emergencyToggleEl, t('budgetPlan.includeEmergency'));

  includeCb.style.display = 'none';
  emergencyCb.style.display = 'none';

  // ── applyKindVisibility ───────────────────────────────────────────────────
  // Set while a transfer forces "Post as scheduled" on; the toggle's click
  // handler (below, near asScheduleToggleEl) checks this so the lock can't be
  // clicked or space/enter'd through.
  let scheduleLocked = false;
  // Whether the transfer kind turned the toggle on (it was off before), so
  // switching to another kind can put it back the way the user left it.
  let scheduleForcedOn = false;
  function applyKindVisibility() {
    const isIncome = kindSel.value === 'income';
    unallocatedOption.disabled = kindSel.value !== 'expense';
    unallocatedOption.hidden = unallocatedOption.disabled;
    if (unallocatedOption.disabled && envSel.value === unallocatedValue) envSel.value = '';
    const isInvestment = kindSel.value === 'investment_transfer';
    const isTransfer = kindSel.value === 'account_transfer';
    // A loan payment is expense-shaped (an envelope pays it) but, like a
    // transfer, names a second account and always posts on its schedule:
    // the interest/principal split happens when a payment is written.
    const isLoan = kindSel.value === 'loan_payment';
    // Investment kind needs an envelope (the investing envelope debited
    // by each buy) just like expense. Income has none: it lands in
    // unallocated, and a scheduled envelope template distributes it from
    // there on its own calendar. A transfer moves money between the user's
    // own accounts, so it has no envelope either.
    envField.style.display = (isIncome || isTransfer) ? 'none' : '';
    incomeHint.style.display = isIncome ? '' : 'none';
    envSearch.setAttribute('aria-required', String(!(isIncome || isTransfer)));
    emergencyToggleRow.style.display = (isIncome || isInvestment || isTransfer) ? 'none' : 'grid';
    if (isIncome || isInvestment || isTransfer) {
      emergencyCb.checked = false;
      emergencyToggleEl.classList.remove('on');
    }
    invRow.style.display = isInvestment ? 'flex' : 'none';
    // Fill % splits an envelope across its expense items only.
    fundingField.style.display = (isIncome || isInvestment || isTransfer) ? 'none' : '';
    transferRow.style.display = (isTransfer || isLoan) ? 'flex' : 'none';
    loanRateField.style.display = isLoan ? '' : 'none';
    loanRateHint.style.display = isLoan ? '' : 'none';
    loanRow.style.display = isLoan ? 'flex' : 'none';
    // A loan's span is the loan's own (its end month, the payoff).
    activeRow.style.display = isLoan ? 'none' : 'flex';
    refreshLoanPreview();
    const toLbl = toAcctField.querySelector('label');
    if (toLbl) toLbl.textContent = isLoan ? t('budgetPlan.loanAccount') : t('budgetPlan.toAccount');
    // Moving money between your own accounts is never a stress cut, and nor
    // is a loan instalment: the bank sets it. Hide the Stress Settings column
    // and clear any category left over from a different kind.
    stressCol.style.display = (isTransfer || isLoan) ? 'none' : '';
    // Extra buffer is envelope money; a transfer has no envelope.
    bufferField.style.display = isTransfer ? 'none' : '';
    if ((isTransfer || isLoan) && stressSel.value) {
      stressSel.value = '';
      rebuildStressCuts();
    }
    // A transfer always posts as a scheduled transaction; force the toggle on
    // and lock it so it can't be turned off while this kind is selected.
    const locked = isTransfer || isLoan;
    scheduleLocked = locked;
    asScheduleToggleEl.classList.toggle('toggle--locked', locked);
    asScheduleToggleEl.setAttribute('aria-disabled', String(locked));
    asScheduleLblEl.style.opacity = locked ? '0.6' : '';
    asScheduleLblEl.style.cursor = locked ? 'default' : 'pointer';
    const setScheduled = (on) => {
      asScheduleToggleEl.classList.toggle('on', on);
      // a11ySwitch syncs aria-checked on click only; this is not a click.
      asScheduleToggleEl.setAttribute('aria-checked', String(on));
      asScheduleCb.checked = on;
      refreshAccountSelDisabled();
      refreshPlannedAccountHint();
      dayTypeSel.disabled = !on;
    };
    if (locked && !asScheduleToggleEl.classList.contains('on')) {
      setScheduled(true);
      scheduleForcedOn = true;
    } else if (!locked && scheduleForcedOn) {
      setScheduled(false);
      scheduleForcedOn = false;
    }
    // "Account" relabels to "From account" for a transfer, so the two
    // pickers read left-to-right as the direction of the money.
    const accountFieldLbl = accountField.querySelector('label');
    if (accountFieldLbl) {
      accountFieldLbl.textContent = (isTransfer || isLoan) ? t('budgetPlan.fromAccount') : t('budgetPlan.account');
    }
    // Re-filter the cash-side account picker. Investment kind: only
    // non-investment accounts (the source of cash). Otherwise: all. The
    // empty option's label is set by refreshAccountSelDisabled below.
    const prev = accountSel.value;
    accountSel.innerHTML = accountSelectHtml(prev, {
      ...((isInvestment || isLoan) ? { nonInvestmentOnly: true } : {}),
    });
    refreshAccountSelDisabled();
    refreshPlannedAccountHint();
    refreshToAcctOptions();
    refreshTargetMode();
  }
  kindSel.addEventListener('change', applyKindVisibility);

  // ── Stress cut % — one slider per applicable scenario (category gates) ─────
  const stressCutGroupLbl = document.createElement('label');
  stressCutGroupLbl.textContent = t('budgetPlan.stressCutGroup');
  stressCutGroupLbl.style.cssText = 'font-size:13px;display:block;';
  const stressCutGroup = document.createElement('div');
  stressCutGroup.style.cssText = 'display:flex;flex-direction:column;gap:0;margin-top:4px;';
  const stressCutGroupEmpty = document.createElement('div');
  stressCutGroupEmpty.className = 'muted';
  stressCutGroupEmpty.style.cssText = 'font-size:12px;padding:6px 0;';
  stressCutGroupEmpty.textContent = t('budgetPlan.stressCutEmpty');

  // Rebuild the slider group from the draft's current category. Worse scenarios
  // (A) are shown first, the category's own level last.
  function rebuildStressCuts() {
    stressDraft.stress_category = stressSel.value || null;
    stressCutGroup.replaceChildren();
    const scs = cutScenariosFor(stressDraft);
    if (!scs.length) {
      stressCutGroup.append(stressCutGroupEmpty);
      return;
    }
    for (const s of scs) {
      const row = document.createElement('div');
      row.className = 'bp-stress-slider-row';
      const lbl = document.createElement('span');
      lbl.className = 'bp-stress-slider-lbl';
      lbl.textContent = `${s} — ${t('stress.cat' + s) || s}`;
      const slider = document.createElement('input');
      slider.type = 'range';
      slider.min = '0'; slider.max = '100'; slider.step = '1';
      slider.className = 'stress-slider';
      const initial = Math.round(stressCutPct(stressDraft, s) * 100);
      slider.value = String(initial);
      const pct = document.createElement('span');
      pct.className = 'stress-slider-pct';
      pct.textContent = `${initial}%`;
      slider.addEventListener('input', () => {
        const v = Math.max(0, Math.min(100, Number(slider.value) || 0));
        setStressCutPct(stressDraft, s, v / 100);
        pct.textContent = `${v}%`;
      });
      row.append(lbl, slider, pct);
      stressCutGroup.append(row);
    }
  }
  stressSel.addEventListener('change', rebuildStressCuts);

  // Budget Settings group (left column, below Scheduling).
  const budgetGroup = document.createElement('div');
  const budgetColLbl = document.createElement('div');
  budgetColLbl.className = 'bp-section-label';
  budgetColLbl.textContent = t('budgetPlan.budgetSettings');
  budgetGroup.append(budgetColLbl, includeToggleRow, emergencyToggleRow, includeCb, emergencyCb);

  // Fill %: how the envelope's money is matched to this item. Only an explicit
  // click is saved; untouched, the item keeps following the default
  // (resolveFundingStyle), so turning on "Post as scheduled" later still
  // makes it a bill.
  let fundingStyle = item.funding_style === 'bill' || item.funding_style === 'spending' ? item.funding_style : null;
  const fundingField = document.createElement('div');
  fundingField.className = 'field';
  fundingField.style.cssText = 'margin:4px 0 0;';
  const fundingLbl = document.createElement('label');
  fundingLbl.textContent = t('budgetPlan.fundingStyle');
  const fundingBtns = document.createElement('div');
  fundingBtns.className = 'tx-type-btns';
  fundingBtns.setAttribute('role', 'group');
  fundingBtns.setAttribute('aria-label', t('budgetPlan.fundingStyle'));
  const fundingHint = document.createElement('div');
  fundingHint.className = 'muted';
  fundingHint.style.cssText = 'font-size:12px;margin-top:4px;line-height:1.3;';
  const fundingBtnEls = [['bill', t('budgetPlan.fundingBill')], ['spending', t('budgetPlan.fundingSpending')]].map(([v, lbl]) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'tx-type-btn';
    b.style.flex = '1';
    b.dataset.value = v;
    b.textContent = lbl;
    b.addEventListener('click', () => { fundingStyle = v; paintFunding(); tracker.markDirty(); });
    return b;
  });
  function paintFunding() {
    const active = fundingStyle || resolveFundingStyle(item);
    for (const b of fundingBtnEls) {
      const on = b.dataset.value === active;
      b.classList.toggle('is-active', on);
      b.setAttribute('aria-pressed', String(on));
    }
    fundingHint.textContent = t(active === 'spending' ? 'budgetPlan.fundingSpendingHint' : 'budgetPlan.fundingBillHint');
  }
  fundingBtns.append(...fundingBtnEls);
  fundingField.append(fundingLbl, fundingBtns, fundingHint);
  paintFunding();
  budgetGroup.append(fundingField);

  // Stress Settings group (right column).
  const stressCol = document.createElement('div');
  stressCol.style.cssText = 'flex:1;min-width:0;';
  const stressColLbl = document.createElement('div');
  stressColLbl.className = 'bp-section-label';
  stressColLbl.textContent = t('budgetPlan.stressSettings');
  const stressCatField = field(t('budgetPlan.filterHintCategory'), stressSel);
  stressCatField.style.cssText = 'margin-bottom:8px;';
  stressCol.append(stressColLbl, stressCatField, stressCutGroupLbl, stressCutGroup);
  rebuildStressCuts();

  // ── Layout: Monthly Schedule ──────────────────────────────────────────────
  const schedHead = document.createElement('div');
  schedHead.className = 'bp-sched-head';
  const schedTitle = document.createElement('div');
  schedTitle.className = 'bp-section-label';
  schedTitle.textContent = t('budgetPlan.monthlySchedule');
  const schedBtns = document.createElement('div');
  schedBtns.style.cssText = 'display:flex;gap:6px;';
  const allBtn = document.createElement('button');
  allBtn.type = 'button'; allBtn.className = 'btn btn-sm btn-ghost';
  allBtn.textContent = t('common.all');
  const noneBtn = document.createElement('button');
  noneBtn.type = 'button'; noneBtn.className = 'btn btn-sm btn-ghost';
  noneBtn.textContent = t('common.none');
  schedBtns.append(allBtn, noneBtn);
  schedHead.append(schedTitle, schedBtns);

  const sched = document.createElement('div');
  sched.className = 'bp-sched';

  QUARTERS.forEach(q => {
    const row = document.createElement('div');
    row.className = 'bp-sched-row';
    const qLbl = document.createElement('div');
    qLbl.className = 'bp-qlabel';
    qLbl.textContent = q.label;
    row.append(qLbl);
    q.months.forEach(mon => {
      const cell = document.createElement('button');
      cell.type = 'button';
      cell.className = 'bp-mcell';
      cell.dataset.mon = mon;
      cell.title = t('bp.cellTitleActive');
      const val = item.monthly_schedule[mon];
      const active = val !== undefined && val !== false;
      const customVal = typeof val === 'number' ? Math.abs(val) : undefined;
      paintCell(cell, { active, customVal });
      row.append(cell);
    });
    const qTotal = document.createElement('div');
    qTotal.className = 'bp-qtotal';
    qTotal.dataset.q = q.label;
    qTotal.textContent = '—';
    row.append(qTotal);
    sched.append(row);
  });

  // ── Totals row (buffer + yearly + avg) ────────────────────────────────────
  const totalsRow = document.createElement('div');
  totalsRow.className = 'bp-totals-row';

  const bufferField = field(t('budgetPlan.extraBuffer'), bufferIn);

  const yearlyWrap = document.createElement('div');
  yearlyWrap.className = 'bp-stat';
  // eslint-disable-next-line no-restricted-syntax -- values are escHtml-wrapped
  yearlyWrap.innerHTML = `<div class="bp-stat-label">${escHtml(t('budgetPlan.totalYearly'))}</div><div class="bp-stat-value" id="bp-total-yearly">—</div>`;

  const avgWrap = document.createElement('div');
  avgWrap.className = 'bp-stat';
  // eslint-disable-next-line no-restricted-syntax -- values are escHtml-wrapped
  avgWrap.innerHTML = `<div class="bp-stat-label">${escHtml(t('budgetPlan.avgPerMonth'))}</div><div class="bp-stat-value muted" id="bp-avg-month">—</div>`;

  totalsRow.append(bufferField, yearlyWrap, avgWrap);

  // ── Action buttons ────────────────────────────────────────────────────────
  // Header actions stay outside the scrolling form.
  let deleteBtn = null;
  if (!isNew) {
    deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'btn btn-ghost';
    deleteBtn.style.color = 'var(--danger)';
    deleteBtn.textContent = t('common.delete');
  }
  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button'; cancelBtn.className = 'btn btn-ghost';
  cancelBtn.textContent = t('common.cancel');
  const saveBtn = document.createElement('button');
  saveBtn.type = 'submit'; saveBtn.className = 'btn btn-accent';
  saveBtn.textContent = t('common.save');
  const errEl = document.createElement('div');
  errEl.style.cssText = 'color:var(--danger-text);font-size:13px;margin-top:8px;display:none;';
  errEl.setAttribute('role', 'alert');
  const showError = (msg, control) => {
    if (control?.closest('.field')) fieldError(control, msg, true);
    else {
      errEl.textContent = msg; errEl.style.display = 'block';
      if (control) focusField(control);
    }
  };
  const clearError = () => { errEl.style.display = 'none'; errEl.textContent = ''; };

  // ── Scheduling row: toggle spans amount+day width, account spans description
  const asScheduleToggleEl = document.createElement('div');
  asScheduleToggleEl.className = 'toggle' + (item.as_schedule ? ' on' : '');
  asScheduleToggleEl.style.flexShrink = '0';
  const asScheduleLblEl = document.createElement('span');
  asScheduleLblEl.textContent = t('budgetPlan.postAsScheduled');
  asScheduleLblEl.style.cssText = 'font-size:14px;cursor:pointer;';
  const asScheduleToggleRow = document.createElement('div');
  asScheduleToggleRow.style.cssText = 'display:grid;grid-template-columns:38px 1fr;align-items:center;gap:10px;';
  asScheduleToggleRow.append(asScheduleToggleEl, asScheduleLblEl);
  [asScheduleToggleEl, asScheduleLblEl].forEach(el => el.addEventListener('click', () => {
    if (scheduleLocked) return;
    asScheduleToggleEl.classList.toggle('on');
    asScheduleCb.checked = asScheduleToggleEl.classList.contains('on');
    refreshAccountSelDisabled();
    refreshPlannedAccountHint();
    dayTypeSel.disabled = !asScheduleCb.checked;
  }));
  a11ySwitch(asScheduleToggleEl, t('budgetPlan.postAsScheduled'));
  asScheduleCb.style.display = 'none';
  refreshAccountSelDisabled();

  const schedSectionLbl = document.createElement('div');
  schedSectionLbl.className = 'bp-section-label';
  schedSectionLbl.textContent = t('budgetPlan.scheduling');

  const dayTypeField = field(t('budgetPlan.dayType'), dayTypeSel);
  dayTypeField.style.cssText = 'flex:none;width:150px;margin-bottom:0;';
  const accountField = field(t('budgetPlan.account'), accountSel);
  accountField.style.cssText = 'flex:1;min-width:0;margin-bottom:0;';
  const schedConfigRow = document.createElement('div');
  schedConfigRow.style.cssText = 'display:flex;gap:10px;align-items:flex-end;margin-top:8px;';
  schedConfigRow.append(dayTypeField, accountField);

  // Shown only for an unscheduled expense item: the account picker is
  // optional there, and this says what leaving it empty (or filling it in)
  // does, since "Optional for planned items" reads oddly once the item
  // posts on a schedule (scheduleNote covers that case instead).
  const plannedAccountHint = document.createElement('div');
  plannedAccountHint.className = 'field-hint field-hint--info';
  plannedAccountHint.style.cssText = 'margin-top:6px;';
  plannedAccountHint.textContent = t('budgetPlan.plannedAccountHint');
  function refreshPlannedAccountHint() {
    const isExpense = !['income', 'investment_transfer', 'account_transfer'].includes(kindSel.value);
    plannedAccountHint.style.display = (isExpense && !asScheduleCb.checked) ? '' : 'none';
  }
  refreshPlannedAccountHint();

  const scheduleNote = document.createElement('div');
  scheduleNote.style.cssText = 'font-size:12px;color:var(--muted);margin-bottom:14px;';
  scheduleNote.textContent = t('budgetPlan.scheduleNote');

  // \u2500\u2500 Investment-specific row (visible only when kind === 'investment_transfer') \u2500
  // Two flavours:
  //   buy:      cash \u2192 investment, debits the investing envelope (DCA).
  //   dividend: investment \u2192 cash, optional envelope credit (income-shape).
  // `accountSel` (filtered to non-investment when this kind is active) is the
  // cash side; `invAcctSel` is the broker. For buys the symbol is optional \u2014
  // a missing symbol just means the materialised tx won't tie to a specific
  // holding. For dividends the symbol is required so the tx ties back to a
  // holding (matches the per-tx dividend rules).
  const invDirSel = document.createElement('select');
  invDirSel.id = 'bp-f-inv-direction';
  for (const [v, lbl] of [['buy', t('budgetPlan.directionBuy')], ['dividend', t('budgetPlan.directionDividend')]]) {
    const o = document.createElement('option'); o.value = v; o.textContent = lbl;
    if (v === (item.direction === 'dividend' ? 'dividend' : 'buy')) o.selected = true;
    invDirSel.append(o);
  }
  const invAcctSel = document.createElement('select');
  invAcctSel.id = 'bp-f-investment-account';
  invAcctSel.innerHTML = accountSelectHtml(item.investment_account_id, { investmentOnly: true });
  const symbolIn = document.createElement('input');
  symbolIn.type = 'text'; symbolIn.id = 'bp-f-symbol';
  symbolIn.maxLength = 20;
  symbolIn.autocomplete = 'off';
  symbolIn.placeholder = t('budgetPlan.symbolPlaceholder');
  symbolIn.value = item.symbol || '';
  const invRow = document.createElement('div');
  invRow.style.cssText = 'display:flex;gap:10px;margin-bottom:14px;';
  const invDirField = field(t('budgetPlan.direction'), invDirSel);
  invDirField.style.cssText = 'flex:none;width:160px;margin-bottom:0;';
  const invAcctField = field(t('budgetPlan.investmentAccountRequired'), invAcctSel);
  invAcctField.style.cssText = 'flex:1;margin-bottom:0;';
  const symbolField = field(t('budgetPlan.symbolOptional'), symbolIn);
  symbolField.style.cssText = 'flex:1;margin-bottom:0;';
  invRow.append(invDirField, invAcctField, symbolField);

  // Symbol label flips between optional and required as the direction
  // toggles; the listener covers in-modal direction changes.
  function applyDirectionVisibility() {
    const sf = symbolField.querySelector('label');
    const dir = invDirSel.value === 'dividend' ? 'dividend' : 'buy';
    if (sf) sf.textContent = dir === 'dividend' ? t('budgetPlan.symbolRequired') : t('budgetPlan.symbolOptional');
  }
  invDirSel.addEventListener('change', applyDirectionVisibility);
  applyDirectionVisibility();

  // ── Transfer-specific row (visible only when kind === 'account_transfer') ─
  // `accountSel` (relabelled "From account" for this kind) is the source;
  // `toAcctSel` is the destination. The from-account is excluded from the
  // "to" list — refreshToAcctOptions() re-filters it whenever the from-account
  // changes, matching the brief's "not offered" half of the save guard (the
  // submit handler below still rejects a match, in case the two lists diverge).
  const toAcctSel = document.createElement('select');
  toAcctSel.id = 'bp-f-to-account';
  toAcctSel.innerHTML = accountSelectHtml(item.to_account_id, { excludeId: item.account_id });
  function refreshToAcctOptions() {
    const prevTo = toAcctSel.value;
    toAcctSel.innerHTML = kindSel.value === 'loan_payment'
      ? accountSelectHtml(prevTo, { loanOnly: true })
      : accountSelectHtml(prevTo, { excludeId: accountSel.value || null });
  }
  accountSel.addEventListener('change', refreshToAcctOptions);
  const transferRow = document.createElement('div');
  transferRow.className = 'bp-transfer-fields';
  transferRow.style.cssText = 'display:flex;gap:10px;margin-bottom:14px;';
  const toAcctField = field(t('budgetPlan.toAccount'), toAcctSel);
  // Loan payment: fixed other costs per payment (a handling fee), booked as
  // an expense of their own. The interest rate lives on the loan account
  // (its dated rates), so it is not asked here.
  const loanFeeIn = document.createElement('input');
  loanFeeIn.type = 'number';
  loanFeeIn.id = 'bp-f-loan-fee';
  loanFeeIn.className = 'form-input';
  loanFeeIn.step = '0.01';
  loanFeeIn.min = '0';
  loanFeeIn.inputMode = 'decimal';
  loanFeeIn.placeholder = '0';
  loanFeeIn.value = Number(item.loan_fee) > 0 ? String(item.loan_fee) : '';
  const loanRateField = field(t('budgetPlan.loanFee'), loanFeeIn);
  loanRateField.style.cssText = 'flex:none;width:160px;margin-bottom:0;';
  const loanRateHint = document.createElement('div');
  loanRateHint.className = 'field-hint field-hint--info';
  loanRateHint.style.cssText = 'flex-basis:100%;margin-top:-6px;';
  loanRateHint.textContent = t('budgetPlan.loanRateFromAccount');
  transferRow.style.flexWrap = 'wrap';
  transferRow.append(toAcctField, modeField, targetField, loanRateField, loanRateHint);

  // ── Loan repayment: the method, the last payment month, and the payoff ────
  // A fixed payment is the amount typed in; an annuity or equal principal is
  // calculated each month from what is owed, the rate and the months left,
  // so for those the amount shows this month's payment and is not typed.
  const loanMethodSel = document.createElement('select');
  loanMethodSel.id = 'bp-f-loan-method';
  for (const [v, key] of [
    ['fixed_payment', 'budgetPlan.loanMethodFixed'],
    ['annuity', 'budgetPlan.loanMethodAnnuity'],
    ['equal_principal', 'budgetPlan.loanMethodEqual'],
  ]) {
    const o = document.createElement('option'); o.value = v; o.textContent = t(key);
    loanMethodSel.append(o);
  }
  loanMethodSel.value = LOAN_METHODS.includes(item.loan_method) ? item.loan_method : 'fixed_payment';
  const loanEndIn = document.createElement('input');
  loanEndIn.type = 'month';
  loanEndIn.id = 'bp-f-loan-end';
  loanEndIn.className = 'form-input';
  loanEndIn.value = typeof item.loan_end === 'string' ? item.loan_end : '';
  const loanMethodField = field(t('budgetPlan.loanMethod'), loanMethodSel);
  loanMethodField.style.cssText = 'flex:1;margin-bottom:0;';
  const loanEndField = field(t('budgetPlan.loanEnd'), loanEndIn);
  loanEndField.style.cssText = 'flex:none;width:180px;margin-bottom:0;';
  const loanSummary = document.createElement('div');
  loanSummary.className = 'field-hint';
  loanSummary.id = 'bp-f-loan-summary';
  loanSummary.setAttribute('aria-live', 'polite');
  loanSummary.style.cssText = 'flex-basis:100%;margin-top:-6px;';
  const loanRow = document.createElement('div');
  loanRow.style.cssText = 'display:none;flex-wrap:wrap;gap:10px;margin-bottom:14px;';
  loanRow.append(loanMethodField, loanEndField, loanSummary);

  // Active from / until: the months the item applies, either one open. A
  // ticked month outside them counts nowhere and does not post
  // (js/engine/item-dates.js). Until opens on a legacy end date.
  const startMonthIn = document.createElement('input');
  startMonthIn.type = 'month';
  startMonthIn.id = 'bp-f-start-month';
  startMonthIn.className = 'form-input';
  startMonthIn.value = itemStartMonth(item) ?? '';
  const endMonthIn = document.createElement('input');
  endMonthIn.type = 'month';
  endMonthIn.id = 'bp-f-end-month';
  endMonthIn.className = 'form-input';
  endMonthIn.value = itemEndMonth(item) ?? '';
  const startMonthField = field(t('budgetPlan.activeFrom'), startMonthIn);
  startMonthField.style.cssText = 'flex:none;width:180px;margin-bottom:0;';
  const endMonthField = field(t('budgetPlan.activeUntil'), endMonthIn);
  endMonthField.style.cssText = 'flex:none;width:180px;margin-bottom:0;';
  const activeHint = document.createElement('div');
  activeHint.className = 'field-hint field-hint--info';
  activeHint.textContent = t('budgetPlan.activeHint');
  activeHint.style.cssText = 'flex-basis:100%;margin-top:-6px;';
  const activeRow = document.createElement('div');
  activeRow.className = 'bp-active-row';
  activeRow.style.cssText = 'display:flex;flex-wrap:wrap;gap:10px;margin-bottom:14px;';
  activeRow.append(startMonthField, endMonthField, activeHint);
  // Disabled automatically once the loan was repaid (app.js runLoanPlanUpkeep).
  if (item.loan_paid_off && item.include === false) {
    const paidOff = document.createElement('div');
    paidOff.className = 'field-hint field-hint--info';
    paidOff.id = 'bp-f-loan-paid-off';
    paidOff.style.cssText = 'flex-basis:100%;';
    paidOff.textContent = t('loanSchedule.paidOffNote')(fmtDateLang(item.loan_paid_off));
    loanRow.append(paidOff);
  }

  /**
   * The item as the form stands, for the payoff preview: the fields its
   * schedule reads (`loan.preview`), the stored item's own dates and legacy
   * rate with them. A new item has no id yet.
   */
  function draftLoanItem() {
    return {
      ...(item.id ? { id: item.id } : {}),
      default_amount: -(parseAmountInput(amtIn.value) || 0),
      loan_fee: Number(loanFeeIn.value) > 0 ? Number(loanFeeIn.value) : undefined,
      loan_method: loanMethodSel.value,
      loan_end: loanEndIn.value || undefined,
      payment_day: parseInt(payDayIn.value) || 0,
      schedule_day_type: dayTypeSel.value || 'exact',
      monthly_schedule: collectScheduleFromCells(mcells()),
      as_schedule_since: item.as_schedule_since || todayYmd(),
      as_schedule_until: item.as_schedule_until,
      start_month: item.start_month,
      end_month: item.end_month,
      skipped_occurrences: item.skipped_occurrences,
      loan_rate: item.loan_rate,
    };
  }

  function refreshLoanPreview() {
    if (kindSel.value !== 'loan_payment') { amtIn.readOnly = false; return; }
    const calculated = loanMethodSel.value !== 'fixed_payment';
    loanEndField.style.display = calculated ? '' : 'none';
    amtIn.readOnly = calculated;
    amtIn.title = calculated ? t('budgetPlan.loanAmountCalculated') : '';
    const loan = (state.accounts || []).find(a => a.id === toAcctSel.value);
    if (!loan || (calculated && !loanEndIn.value)) {
      loanSummary.textContent = calculated ? t('budgetPlan.loanEndRequired') : '';
      return;
    }
    const s = ask('loan.preview', { item: draftLoanItem(), loan: loan.id, date: todayYmd() });
    // A failed preview leaves the summary off (warned).
    if (!s) { loanSummary.textContent = ''; return; }
    if (calculated && s.firstPayment !== null) {
      const next = s.firstPayment.toFixed(2);
      if (amtIn.value !== next) {
        amtIn.value = next;
        amtIn.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }
    if (s.ends === 'repaid' && s.payoffDate) {
      loanSummary.textContent = t('budgetPlan.loanPaidOff')(fmtMonthLang(s.payoffDate.slice(0, 7)), fmt(s.totalInterest));
    } else if (s.ends === 'not_repaid') {
      loanSummary.textContent = t('budgetPlan.loanNotRepaid');
    } else if (s.ends === 'plan_ends') {
      loanSummary.textContent = t('budgetPlan.loanPlanEnds')(fmtMonthLang(s.lastMonth), fmt(s.owedAtEnd));
    } else {
      loanSummary.textContent = s.owedNow > 0 ? '' : t('budgetPlan.loanNothingOwed');
    }
  }
  for (const [el, ev] of [[amtIn, 'input'], [loanFeeIn, 'input'], [loanMethodSel, 'change'], [loanEndIn, 'change'],
    [toAcctSel, 'change'], [payDayIn, 'change'], [dayTypeSel, 'change']]) {
    el.addEventListener(ev, refreshLoanPreview);
  }

  // Scheduling group (left column, above Budget Settings).
  const schedGroup = document.createElement('div');
  schedGroup.append(schedSectionLbl, asScheduleToggleRow, asScheduleCb, schedConfigRow, plannedAccountHint, scheduleNote);

  form.append(disclosure(t('workspace.basics'), [kindEnvRow, basicRow, invRow, transferRow, targetControls, loanRow], true));
  const schedSection = document.createElement('section');
  schedSection.className = 'bp-sheet-section';
  schedSection.append(schedHead, activeRow, sched, totalsRow);
  const monthsSection = disclosure(t('workspace.monthlyAmounts'), [schedSection], true);
  form.append(disclosure(t('workspace.schedule'), [schedGroup], true),
    monthsSection,
    disclosure(t('workspace.advanced'), [budgetGroup, stressCol]), errEl);
  form.addEventListener('invalid', event => {
    let parent = event.target.parentElement;
    while (parent && parent !== form) { if (parent.tagName === 'DETAILS') parent.open = true; parent = parent.parentElement; }
  }, true);

  if (!isNew) {
    const skipped = document.createElement('section');
    skipped.className = 'bp-sheet-section skipped-occurrences';
    let restoring = false;
    function paintSkipped() {
      skipped.replaceChildren();
      const months = state.budgetItems.find(it => it.id === item.id)?.skipped_occurrences || [];
      const heading = document.createElement('h3'); heading.textContent = t('unskip.title');
      const hint = document.createElement('p'); hint.textContent = t('unskip.explanation');
      skipped.append(heading, hint);
      if (!months.length) {
        const empty = document.createElement('p'); empty.textContent = t('unskip.empty'); skipped.append(empty);
      }
      for (const month of [...new Set(months)].sort()) {
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;align-items:center;justify-content:space-between;margin:8px 0;';
        const label = document.createElement('span'); label.textContent = fmtMonthLang(month);
        const restore = document.createElement('button');
        restore.type = 'button'; restore.className = 'btn btn-ghost btn-sm';
        restore.textContent = t('unskip.restore'); restore.dataset.month = month;
        restore.addEventListener('click', guardSubmit(async () => {
          if (restoring || !isCurrent()) return;
          restoring = true; restore.disabled = true;
          try {
            await flushItems();
            if (!isCurrent() || !form.closest('[data-sheet-open]')) return;
            const latest = state.budgetItems.find(it => it.id === item.id);
            if (!latest?.skipped_occurrences?.includes(month)) { paintSkipped(); return; }
            const result = await dispatchOrReport(session, 'budgetItem.unskipOccurrence', { id: item.id, month });
            if (!result || !isCurrent() || !form.closest('[data-sheet-open]')) return;
            paintSkipped(); rerenderTable(container);
            toast(t('unskip.restored'));
          } finally { restoring = false; restore.disabled = false; }
        }));
        row.append(label, restore); skipped.append(row);
      }
    }
    paintSkipped(); form.append(skipped);
  }

  const saveHint = node('p', 'workspace-save-hint', t('workspace.saveSchedule'));
  form.prepend(saveHint);

  function refreshTargetMode() {
    const active = targetMode();
    targetControls.hidden = kindSel.value !== 'account_transfer';
    modeField.hidden = kindSel.value !== 'account_transfer';
    targetField.hidden = targetHint.hidden = targetPreview.hidden = !active;
    amtField.hidden = active;
    amtIn.disabled = active;
    targetIn.disabled = !active;
    targetIn.required = active;
    totalsRow.hidden = active;
    scheduleNote.textContent = t(active ? 'budgetPlan.targetScheduleNote' : 'budgetPlan.scheduleNote');
    monthsSection.querySelector('summary').textContent = t(active ? 'budgetPlan.targetMonths' : 'workspace.monthlyAmounts');
    sched.querySelectorAll('.bp-qtotal').forEach(el => { el.hidden = active; });
    // A target applies on each enabled month; a custom fixed payment does not.
    if (active) sched.querySelectorAll('.bp-mcell').forEach(cell => {
      paintCell(cell, { active: cell.classList.contains('active') });
    });
    topUpBtn.hidden = !active || isNew || item.transfer_mode !== 'target_balance';
    refreshTargetPreview();
  }
  function refreshTargetPreview() {
    if (!targetMode()) return;
    targetPreview.textContent = '';
    targetPreview.style.color = '';
    const fields = {
      kind: 'account_transfer', transfer_mode: 'target_balance', target_balance: Number(targetIn.value),
      account_id: accountSel.value || null, to_account_id: toAcctSel.value || null,
      default_amount: 0, payment_day: Number(payDayIn.value), schedule_day_type: dayTypeSel.value,
      monthly_schedule: collectScheduleFromCells(sched.querySelectorAll('.bp-mcell')),
      include: includeCb.checked, as_schedule: true,
      start_month: startMonthIn.value || null, end_month: endMonthIn.value || null,
    };
    // Incomplete drafts have no estimate; keep field errors for Save.
    const preview = ask('transfer.preview', { ...(isNew ? {} : { id: item.id }), fields }, () => true);
    if (!preview) return;
    targetPreview.textContent = preview.next
      ? t('budgetPlan.targetEstimate')(fmt(preview.next.amount), fmtDateLang(preview.next.date))
      : t('budgetPlan.targetNoOccurrence');
    if (preview.next?.fundingShortfall > 0) {
      targetPreview.style.color = 'var(--danger-text)';
      targetPreview.textContent += ' ' + t('budgetPlan.targetShortfall')(fmt(preview.next.fundingShortfall));
    }
  }
  transferMode.addEventListener('change', refreshTargetMode);
  form.addEventListener('input', refreshTargetPreview);
  form.addEventListener('change', refreshTargetPreview);
  topUpBtn.addEventListener('click', guardSubmit(async () => {
    if (!isCurrent()) return;
    // Extra runs use the saved rule. Re-read for confirmation and dispatch
    // computes the amount again from current posted balances.
    await flushItems();
    if (!isCurrent()) return;
    const preview = ask('transfer.preview', { id: item.id });
    if (!preview) return;
    if (!preview.today.amount) { toast(t('budgetPlan.targetNothingNeeded')); return; }
    const latest = state.budgetItems.find(it => it.id === item.id);
    const from = state.accounts.find(a => a.id === latest?.account_id)?.name || '';
    const to = state.accounts.find(a => a.id === latest?.to_account_id)?.name || '';
    let message = t('budgetPlan.topUpConfirm')(fmt(preview.today.amount), from, to);
    if (preview.today.fundingShortfall > 0) message += ' ' + t('budgetPlan.targetShortfall')(fmt(preview.today.fundingShortfall));
    if (!await confirmDialog(message) || !isCurrent()) return;
    const result = await dispatchOrReport(session, 'budgetItem.topUp', { id: item.id });
    if (!result || !isCurrent()) return;
    rerenderTable(container); refreshTargetPreview();
    toast(t(result.value.value?.amount ? 'budgetPlan.topUpRecorded' : 'budgetPlan.targetNothingNeeded'),
      { action: undoAction(result.value.undo, state.currentPage) });
  }));

  // ── Open sheet ────────────────────────────────────────────────────────────
  const tracker = trackDirty(form);
  const { close, requestClose } = openSheet({
    title: isNew ? t('budgetPlan.addTitle') : t('budgetPlan.editTitle'),
    wide: true,
    content: form,
    headerActions: [deleteBtn, cancelBtn, saveBtn].filter(Boolean),
    confirmClose: tracker.confirmClose,
    // Not the envelope picker, the first field: focusing its search input
    // opens the list over the form before anything is asked.
    initialFocus: amtIn,
  });

  form.closest('.sheet').classList.add('budget-item-sheet');

  // ── Wire month cell interactions ──────────────────────────────────────────
  const mcells = () => sched.querySelectorAll('.bp-mcell');
  const recalc = () => { updateDialogTotals(form); refreshTargetPreview(); };

  mcells().forEach(cell => {
    wireMonthCell(cell, {
      getDefaultAmt: () => parseAmountInput(amtIn.value) || 0,
      allowCustom: () => !targetMode(),
      // Cell toggles repaint DOM directly without input/change events, so
      // the dirty tracker needs an explicit nudge here.
      onChange: () => { tracker.markDirty(); recalc(); },
    });
  });

  allBtn.addEventListener('click', () => {
    mcells().forEach(cell => {
      if (!cell.classList.contains('active')) paintCell(cell, { active: true });
    });
    tracker.markDirty();
    recalc();
  });
  noneBtn.addEventListener('click', () => {
    mcells().forEach(cell => paintCell(cell, { active: false }));
    tracker.markDirty();
    recalc();
  });

  amtIn.addEventListener('input', recalc);
  bufferIn.addEventListener('input', recalc);
  for (const inp of [startMonthIn, endMonthIn]) {
    inp.addEventListener('input', recalc);
    inp.addEventListener('change', recalc);
  }
  recalc();
  applyKindVisibility();

  cancelBtn.addEventListener('click', requestClose);

  if (deleteBtn) {
    deleteBtn.addEventListener('click', async () => {
      if (!await confirmDialog(t('budgetPlan.deleteConfirm'), { title: t('budgetPlan.deleteTitle'), danger: true, okLabel: t('common.delete') })) return;
      // The session changes the plan only once the write lands; a failure is
      // reported and leaves the item (and this sheet) as they were.
      const r = await dispatchOrReport(session, 'budgetItem.delete', { id: item.id });
      if (!r) return;
      close();
      rerenderTable(container);
      // Undo repaints whichever page opened the editor (Plan or Stress).
      toast(t('budgetPlan.deletedToast'), { action: undoAction(r.value.undo, state.currentPage) });
    });
  }

  function requiredFields() {
    const kind = kindSel.value;
    const dividend = kind === 'investment_transfer' && invDirSel.value === 'dividend';
    markRequired(amtIn, !targetMode());
    markRequired(targetIn, targetMode());
    markRequired(envSearch, !['income', 'account_transfer'].includes(kind) && !dividend);
    markRequired(accountSel, asScheduleCb.checked || kind === 'account_transfer');
    markRequired(toAcctSel, kind === 'account_transfer' || kind === 'loan_payment');
    markRequired(invAcctSel, kind === 'investment_transfer');
    markRequired(symbolIn, dividend);
    markRequired(payDayIn, asScheduleCb.checked);
  }
  requiredFields();
  // Kind buttons dispatch a non-bubbling change on their backing select.
  kindSel.addEventListener('change', requiredFields);
  form.addEventListener('change', requiredFields);
  setupFormValidation(form, { required: false });

  form.addEventListener('submit', guardSubmit(async e => {
    e.preventDefault();
    clearError();

    if (targetMode() && (!targetIn.value.trim() || !Number.isFinite(Number(targetIn.value)) || Number(targetIn.value) < 0)) {
      showError(t('common.amountInvalid'), targetIn); return;
    }
    if (!targetMode() && (!Number.isFinite(parseAmountInput(amtIn.value, { strict: true })) || parseAmountInput(amtIn.value, { strict: true }) < 0)) {
      showError(t('common.amountInvalid'), amtIn); return;
    }
    if (bufferIn.value.trim() && (!Number.isFinite(parseAmountInput(bufferIn.value, { strict: true })) || parseAmountInput(bufferIn.value, { strict: true }) < 0)) {
      showError(t('common.bufferInvalid'), bufferIn); return;
    }
    const kindVal = ['income', 'investment_transfer', 'account_transfer', 'loan_payment'].includes(kindSel.value)
      ? kindSel.value
      : 'expense';
    const isLoan = kindVal === 'loan_payment';
    const isIncome = kindVal === 'income';
    const isInvestment = kindVal === 'investment_transfer';
    const isTransfer = kindVal === 'account_transfer';
    const invDirection = isInvestment && invDirSel.value === 'dividend' ? 'dividend' : 'buy';
    const isInvDividend = isInvestment && invDirection === 'dividend';
    // Dividends behave like income for envelope-side aggregation: an
    // optional envelope (lands in unallocated when blank) and no debit to
    // an investing envelope. A transfer has no envelope at all.
    const isUnallocated = kindVal === 'expense' && envSel.value === unallocatedValue;
    const envelopeId = isTransfer || isUnallocated
      ? null
      : (isIncome || isInvDividend) ? (envSel.value || null) : envSel.value;
    if (!isIncome && !isInvDividend && !isTransfer && !isUnallocated && !envelopeId) {
      showError(t('budgetPlan.errEnvelopeRequired'), envSearch);
      return;
    }

    const payDayVal = parseInt(payDayIn.value) || 0;
    const asSchedule = asScheduleCb.checked;
    const accountIdVal = accountSel.value || null;
    const scheduleDayType = dayTypeSel.value || 'exact';
    const invAcctVal = isInvestment ? (invAcctSel.value || null) : null;
    const symbolVal = isInvestment && symbolIn.value.trim()
      ? symbolIn.value.trim().toUpperCase()
      : null;
    const toAcctVal = (isTransfer || isLoan) ? (toAcctSel.value || null) : null;
    const loanFee = isLoan && loanFeeIn.value !== '' ? Number(loanFeeIn.value) : null;

    if (isInvestment) {
      if (!invAcctVal) {
        showError(t('budgetPlan.errInvestmentAccount'), invAcctSel);
        return;
      }
      if (asSchedule && accountIdVal === invAcctVal) {
        showError(t('budgetPlan.errAccountsSame'), accountSel);
        return;
      }
      if (isInvDividend && !symbolVal) {
        showError(t('budgetPlan.errSymbolRequired'), symbolIn);
        return;
      }
    }

    if (isTransfer) {
      if (!accountIdVal || !toAcctVal) {
        showError(t('budgetPlan.transferAccountsRequired'), accountIdVal ? toAcctSel : accountSel);
        return;
      }
      if (accountIdVal === toAcctVal) {
        showError(t('budgetPlan.transferSameAccount'), toAcctSel);
        return;
      }
    }

    if (isLoan) {
      if (!toAcctVal) {
        showError(t('budgetPlan.loanAccountRequired'), toAcctSel);
        return;
      }
      if (loanFee !== null && !(Number.isFinite(loanFee) && loanFee >= 0)) {
        showError(t('budgetPlan.loanFeeInvalid'), loanFeeIn);
        return;
      }
      if (loanMethodSel.value !== 'fixed_payment' && !/^\d{4}-\d{2}$/.test(loanEndIn.value)) {
        showError(t('budgetPlan.loanEndRequired'), loanEndIn);
        return;
      }
    }

    // A loan payment keeps no dates of its own.
    const startMonthVal = isLoan ? null : (startMonthIn.value || null);
    const endMonthVal = isLoan ? null : (endMonthIn.value || null);
    if (startMonthVal && endMonthVal && endMonthVal < startMonthVal) {
      showError(t('budgetPlan.activeOrder'), endMonthIn);
      return;
    }

    // An included item needs an active month (the command refuses it too).
    const scheduleVal = collectScheduleFromCells(mcells());
    if (includeCb.checked && Object.keys(scheduleVal).length === 0) {
      showError(t('budgetPlan.errNoMonths'));
      mcells()[0]?.focus();
      return;
    }

    if (asSchedule) {
      if (!accountIdVal) {
        showError(t('budgetPlan.errPickAccount'), accountSel);
        return;
      }
      if (payDayVal < 1 || payDayVal > 31) {
        showError(t('budgetPlan.errPaymentDay'), payDayIn);
        return;
      }
    }

    // The form's values as it computes them. The command does the rest as
    // this form used to (applyItemFields): the amount's sign from the kind,
    // the off value of every field the kind has no use for, the account a
    // non-expense keeps only while scheduled, and as_schedule_since. Fields
    // the form does not render (skipped months, a schedule's end date, loan
    // upkeep's marks) stay as stored.
    const fields = {
      kind: kindVal,
      envelope_id: envelopeId || null,
      description: descIn.value,
      default_amount: targetMode() ? 0 : (parseAmountInput(amtIn.value) || 0),
      transfer_mode: isTransfer ? transferMode.value : null,
      target_balance: targetMode() ? Number(targetIn.value) : null,
      extra_buffer: isTransfer ? 0 : (parseAmountInput(bufferIn.value) || 0),
      include: includeCb.checked,
      include_in_emergency_budget: emergencyCb.checked,
      payment_day: payDayVal,
      stress_category: stressSel.value || null,
      // Clamped: some stored items carry a legacy whole percent here (the
      // guest example budget's 15, 50, 100), which the engine reads clamped
      // to 0-1 already and the command's fraction field would refuse.
      stress_cut_pct: clampFrac(stressDraft.stress_cut_pct),
      stress_cut_pcts: stressDraft.stress_cut_pcts ?? null,
      monthly_schedule: scheduleVal,
      as_schedule: asSchedule,
      account_id: accountIdVal,
      schedule_day_type: scheduleDayType,
      investment_account_id: invAcctVal,
      symbol: symbolVal,
      direction: isInvestment ? invDirection : null,
      to_account_id: toAcctVal,
      loan_fee: loanFee,
      // A fixed payment is the default and is not stored. For a calculated
      // method the amount saved is this month's payment, the plan's figure
      // for budget totals, fill % and Stress.
      loan_method: isLoan && loanMethodSel.value !== 'fixed_payment' ? loanMethodSel.value : null,
      loan_end: isLoan && loanMethodSel.value !== 'fixed_payment' ? loanEndIn.value : null,
    };
    // Only an explicit click is saved; untouched, the stored style stays.
    if (fundingStyle) fields.funding_style = fundingStyle;
    // The end month replaces a legacy end date (the command drops it).
    if (!isLoan) {
      fields.start_month = startMonthVal;
      fields.end_month = endMonthVal;
    }

    let r;
    try {
      r = await withBusy(saveBtn, () => (isNew
        ? session.dispatch('budgetItem.create', fields)
        : session.dispatch('budgetItem.update', { id: item.id, fields })), { label: t('common.saving') });
    } catch (err) {
      console.error(err);
      toast(t('common.saveFailed')(err?.message || err), { assertive: true });
      return;
    }
    if (!r.ok) {
      // A refusal on a field this form has an error for is shown there, as
      // the checks above show theirs; anything else is reported. Either way
      // nothing was written and the sheet stays open.
      if (r.error.code === 'bad_input' && showFieldError(r.error.params?.errors)) return;
      reportDispatchFailure(r.error);
      return;
    }
    reportMetaFailure(r);

    close();
    rerenderTable(container);
    if (container.isConnected) showToast(container, t('budgetPlan.savedToast'));
    const saved = state.budgetItems.find(it => it.id === r.value.value?.id);
    if (saved?.as_schedule) {
      try { await runDueScheduled(); } catch (err) { console.error('runDueScheduled after save failed:', err); }
    }

    /**
     * Show the first refused field the form has an error for.
     * @param {{ path: string, message: string }[] | undefined} errors
     * @returns {boolean} whether one was shown
     */
    function showFieldError(errors) {
      for (const e of errors || []) {
        const key = String(e.path || '').replace(/^fields\./, '').split('.')[0];
        const hit = {
          envelope_id: ['budgetPlan.errEnvelopeRequired', envSearch],
          investment_account_id: ['budgetPlan.errInvestmentAccount', invAcctSel],
          symbol: ['budgetPlan.errSymbolRequired', symbolIn],
          account_id: isInvestment && accountIdVal === invAcctVal ? ['budgetPlan.errAccountsSame', accountSel]
            : isTransfer ? ['budgetPlan.transferAccountsRequired', accountSel]
              : ['budgetPlan.errPickAccount', accountSel],
          to_account_id: isLoan ? ['budgetPlan.loanAccountRequired', toAcctSel]
            : accountIdVal && accountIdVal === toAcctVal ? ['budgetPlan.transferSameAccount', toAcctSel]
              : ['budgetPlan.transferAccountsRequired', toAcctSel],
          default_amount: ['common.amountInvalid', amtIn],
          target_balance: ['common.amountInvalid', targetIn],
          extra_buffer: ['common.bufferInvalid', bufferIn],
          loan_fee: ['budgetPlan.loanFeeInvalid', loanFeeIn],
          loan_end: ['budgetPlan.loanEndRequired', loanEndIn],
          payment_day: ['budgetPlan.errPaymentDay', payDayIn],
          start_month: ['budgetPlan.activeInvalid', startMonthIn],
          end_month: ['budgetPlan.activeOrder', endMonthIn],
          monthly_schedule: ['budgetPlan.errNoMonths', mcells()[0]],
        }[key];
        if (!hit) continue;
        showError(t(hit[0]), hit[1]);
        return true;
      }
      return false;
    }
  }));
}
