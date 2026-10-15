// The plan-item editor sheet's save as it was before it dispatched commands,
// kept as the reference the commands and the page are checked against
// (tests/core-entity-fields.test.js, tests/page-budget-plan-editor.test.js).
import { slugify, uniqueId } from '../../js/utils.js';
import { sinceOnSave, resolvePlanItemAccountId } from '../../js/core/plan-item-rules.js';
import { cutScenariosFor, stressCutPct } from '../../js/engine/stress.js';

// The editor's save at aec9887 (js/pages/budget-plan-editor.js, the submit
// handler, 891-1073), its DOM reads replaced by `form`. `form.cuts` stands in
// for the cut sliders (setStressCutPct on the draft); `form.months` is what
// collectScheduleFromCells returns.
export function oldEditorItem(item, form, { isNew, items, today }) {
  const parseAmountInput = (v) => (v === '' ? NaN : Number(v));
  const newItemIdOld = (envelopeId) => {
    const taken = new Set(items.map(it => it.id));
    const base = slugify(`${envelopeId || 'item'}-item`) || 'item';
    return uniqueId(base, taken);
  };
  const stressDraft = {
    stress_category: item.stress_category ?? null,
    stress_cut_pct: item.stress_cut_pct ?? 0,
    stress_cut_pcts: item.stress_cut_pcts ? { ...item.stress_cut_pcts } : undefined,
  };
  if (form.cuts) stressDraft.stress_cut_pcts = { ...form.cuts };
  function buildStressCutsForSave() {
    const cat = form.stress || null;
    if (!cat || cat === 'Z') return undefined;
    stressDraft.stress_category = cat;
    const cuts = {};
    for (const s of cutScenariosFor(stressDraft)) cuts[s] = stressCutPct(stressDraft, s);
    return Object.keys(cuts).length ? cuts : undefined;
  }
  let fundingStyle = item.funding_style === 'bill' || item.funding_style === 'spending' ? item.funding_style : null;
  if (form.fundingStyle) fundingStyle = form.fundingStyle;

  const kindVal = ['income', 'investment_transfer', 'account_transfer', 'loan_payment'].includes(form.kind)
    ? form.kind
    : 'expense';
  const isLoan = kindVal === 'loan_payment';
  const isIncome = kindVal === 'income';
  const isInvestment = kindVal === 'investment_transfer';
  const isTransfer = kindVal === 'account_transfer';
  const invDirection = isInvestment && form.invDir === 'dividend' ? 'dividend' : 'buy';
  const isInvDividend = isInvestment && invDirection === 'dividend';
  const envelopeId = isTransfer
    ? null
    : (isIncome || isInvDividend) ? (form.env || null) : form.env;
  const payDayVal = parseInt(form.payDay) || 0;
  const asSchedule = form.asSchedule;
  const accountIdVal = form.account || null;
  const scheduleDayType = form.dayType || 'exact';
  const invAcctVal = isInvestment ? (form.invAcct || null) : null;
  const symbolVal = isInvestment && form.symbol.trim()
    ? form.symbol.trim().toUpperCase()
    : null;
  const toAcctVal = (isTransfer || isLoan) ? (form.toAcct || null) : null;
  const loanFee = isLoan && form.loanFee !== '' ? Number(form.loanFee) : null;
  const sinceVal = sinceOnSave({
    prevItem: isNew ? null : item,
    nextInclude: form.include,
    nextKind: kindVal,
    asSchedule,
    today,
  });
  const idBase = isIncome
    ? 'income'
    : isInvDividend
      ? `dividend-${symbolVal || ''}`
      : isTransfer ? 'transfer' : envelopeId;
  const updated = {
    ...(isNew ? {} : item),
    id: isNew ? newItemIdOld(idBase) : item.id,
    kind: kindVal,
    envelope_id: envelopeId,
    description: form.desc.trim() || null,
    default_amount: (isIncome || isInvDividend)
      ? Math.abs(parseAmountInput(form.amt) || 0)
      : -(parseAmountInput(form.amt) || 0),
    extra_buffer: isTransfer ? 0 : (parseAmountInput(form.buffer) || 0),
    include: form.include,
    include_in_emergency_budget: (isIncome || isInvestment || isTransfer) ? false : form.emergency,
    payment_day: payDayVal,
    stress_category: (isTransfer || isLoan) ? null : (form.stress || null),
    stress_cut_pct: (!isTransfer && !isLoan && form.stress && form.stress !== 'Z') ? (stressDraft.stress_cut_pct ?? 0) : 0,
    stress_cut_pcts: (isTransfer || isLoan) ? undefined : buildStressCutsForSave(),
    monthly_schedule: {},
    as_schedule: asSchedule,
    account_id: resolvePlanItemAccountId(kindVal, asSchedule, accountIdVal),
    as_schedule_since: sinceVal,
    schedule_day_type: asSchedule ? scheduleDayType : 'exact',
    investment_account_id: isInvestment ? invAcctVal : null,
    symbol: symbolVal,
    direction: isInvestment ? invDirection : null,
    to_account_id: (isTransfer || isLoan) ? toAcctVal : null,
    loan_fee: isLoan && loanFee ? Math.round(loanFee * 100) / 100 : undefined,
  };
  if (!updated.loan_fee) delete updated.loan_fee;
  if (isLoan && form.loanMethod !== 'fixed_payment') {
    updated.loan_method = form.loanMethod;
    updated.loan_end = form.loanEnd;
  } else {
    delete updated.loan_method;
    delete updated.loan_end;
  }
  if (!isLoan) {
    delete updated.loan_months_off;
    delete updated.loan_paid_off;
  }
  delete updated.loan_rate;
  const fundable = kindVal === 'expense' || kindVal === 'loan_payment';
  if (fundable && fundingStyle) updated.funding_style = fundingStyle;
  else if (!fundable) delete updated.funding_style;

  // Active from / until (not for a loan payment, whose span is the loan's).
  // A new item starts from budgetItem.create's new item, which carries empty
  // months; a form that names them stores them, and an end month replaces a
  // legacy end date.
  if (isLoan) {
    delete updated.start_month;
    delete updated.end_month;
  } else if ('startMonth' in form || 'endMonth' in form) {
    updated.start_month = form.startMonth || null;
    updated.end_month = form.endMonth || null;
    delete updated.as_schedule_until;
  } else if (isNew) {
    updated.start_month = null;
    updated.end_month = null;
  }
  updated.monthly_schedule = { ...form.months };
  if (updated.loan_months_off) {
    const still = Object.entries(updated.loan_months_off).filter(([m]) => !updated.monthly_schedule[m]);
    if (still.length) updated.loan_months_off = Object.fromEntries(still);
    else delete updated.loan_months_off;
  }
  return updated;
}
