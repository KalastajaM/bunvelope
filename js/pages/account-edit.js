import { setupFormValidation, markRequired } from '../ui/form-validation.js';
import { disclosure, node } from '../ui/planning-workspace.js';
// js/pages/account-edit.js
import { state, navigate, updateStatusBar, session, now as appNow } from '../app.js';
import { identityMove, askIdentityMove } from './account-type-move.js';
import { openSheet } from '../ui/sheet.js';
import { confirmDialog } from '../ui/dialog.js';
import { trackDirty } from '../ui/dirty-guard.js';
import { guardSubmit } from '../ui/submit-guard.js';
import { withBusy } from '../ui/busy.js';
import { attachFieldHint, setFieldHint } from '../ui/field-hint.js';
import { toast } from '../ui/toast.js';
import { reportDispatchFailure, reportMetaFailure, dispatchOrReport as dispatchOrReportVia } from '../ui/save-error.js';
import { undoAction } from '../ui/undo-action.js';
import { fmt, validateAmount } from '../utils.js';
import { t, fmtDateLang } from '../ui/i18n.js';
import { enableFormulaInput, parseAmountInput } from '../ui/amount-input.js';
import { isSpendingAccount, isCrisisCashAccount, spendingByDefault, futureRowsTouching, SETTLED_TYPES, canPayCards } from '../engine.js';
import { planItemsUsingAccount, plannedItemsForecastingFromAccount } from './account-plan-refs.js';
import { crisisCashToStore } from './account-edit-rules.js';
import { accountRefs } from '../core/entity-fields.js';

// Savings interest comes in balance tiers; loans carry a dated list of rates
// instead (the loan block below).
const INTEREST_TYPES = new Set(['savings']);
const LOAN_TYPES = new Set(['loan', 'loan_given']);

// Values are i18n keys — translated at render time so a locale switch
// is picked up without a reload.
const ACCOUNT_TYPES = [
  ['bank',        'accountEdit.typeBank'],
  ['cash',        'accountEdit.typeCash'],
  ['credit_card', 'accountEdit.typeCreditCard'],
  ['savings',     'accountEdit.typeSavings'],
  ['investment',  'accountEdit.typeInvestment'],
  ['asset',       'accountEdit.typeAsset'],
  ['loan',        'accountEdit.typeLoan'],
  ['loan_given',  'accountEdit.typeLoanGiven'],
];

/** One command through the session; the ok result, or null after telling the user why not. */
const dispatchOrReport = (name, input) => dispatchOrReportVia(session, name, input);

/** Total references to the account (the delete is offered only at zero). */
const countAccountRefs = (accountId) => Object.values(accountRefs(state, accountId)).reduce((a, b) => a + b, 0);

let _fieldSeq = 0;
function field(label, input) {
  const wrap = document.createElement('div');
  wrap.className = 'field';
  const lbl = document.createElement('label');
  lbl.textContent = label;
  if (!input.id) input.id = `acct-f-${++_fieldSeq}`;
  lbl.htmlFor = input.id;
  wrap.append(lbl, input);
  return wrap;
}

export function openAccountEdit(accountOrNull) {
  const isNew = !accountOrNull;
  const acc = accountOrNull || { id: null, name: '', type: 'bank', initialBalance: 0, notes: '', archived: false };

  const form = document.createElement('form');

  const nameIn = document.createElement('input');
  nameIn.type = 'text';
  nameIn.name = 'name';
  nameIn.value = acc.name || '';
  nameIn.required = true;

  const nameField = field(t('accountEdit.name'), nameIn);
  attachFieldHint(nameField, nameIn);
  nameIn.addEventListener('input', () => setFieldHint(nameField, ''));

  const codeIn = document.createElement('input');
  codeIn.type = 'text'; codeIn.name = 'code'; codeIn.value = acc.code || '';
  codeIn.maxLength = 4; codeIn.pattern = '[A-Za-z0-9]{4}';
  codeIn.placeholder = t('coreError.shortCodeAuto');
  const codeField = field(t('coreError.shortCode'), codeIn);
  attachFieldHint(codeField, codeIn);
  const codeHelp = document.createElement('p');
  codeHelp.className = 'muted money-field-help';
  codeHelp.id = codeIn.getAttribute('aria-describedby') + '-usage';
  codeHelp.textContent = t('coreError.shortCodeChatHint');
  codeField.append(codeHelp);
  codeIn.setAttribute('aria-describedby', codeIn.getAttribute('aria-describedby') + ' ' + codeHelp.id);
  codeIn.addEventListener('input', () => setFieldHint(codeField, ''));


  const typeIn = document.createElement('select');
  ACCOUNT_TYPES.forEach(([k, lbl]) => {
    const o = document.createElement('option');
    o.value = k;
    o.textContent = t(lbl);
    if ((acc.type || 'bank') === k) o.selected = true;
    typeIn.append(o);
  });

  const initIn = document.createElement('input');
  initIn.type = 'number';
  initIn.step = '0.01';
  initIn.name = 'initialBalance';
  // A loan's opening balance is what is owed: entered and shown positive,
  // stored negative (the command refuses a positive one).
  const isLoanType = (type) => type === 'loan';
  initIn.value = String(isLoanType(acc.type) ? Math.abs(Number(acc.initialBalance) || 0) : (acc.initialBalance ?? 0));
  enableFormulaInput(initIn);

  const notesIn = document.createElement('textarea');
  notesIn.name = 'notes';
  notesIn.rows = 2;
  notesIn.value = acc.notes || '';
  notesIn.placeholder = t('accountEdit.notesPlaceholder');

  // ── Interest tiers (savings only) ────────────────────────
  const tiersWrap = document.createElement('div');
  tiersWrap.className = 'field';
  const tiersLbl = document.createElement('label');
  tiersLbl.textContent = t('accountEdit.interestTiers');
  const tiersHint = document.createElement('div');
  tiersHint.className = 'muted';
  tiersHint.style.cssText = 'font-size:12px;margin:2px 0 8px;';
  tiersHint.textContent = t('accountEdit.interestTiersHint');
  const tiersList = document.createElement('div');
  tiersList.style.cssText = 'display:flex;flex-direction:column;gap:6px;';
  const addTierBtn = document.createElement('button');
  addTierBtn.type = 'button';
  addTierBtn.className = 'btn btn-ghost';
  addTierBtn.style.cssText = 'align-self:flex-start;font-size:12px;padding:4px 10px;margin-top:6px;';
  addTierBtn.textContent = '+ ' + t('accountEdit.addTier');
  // When the tiers' interest is credited; the Net worth simulation pays it
  // on this schedule. Yearly is the default and is not saved.
  const payoutWrap = document.createElement('label');
  payoutWrap.style.cssText = 'display:flex;gap:8px;align-items:center;margin-top:10px;font-size:13px;';
  const payoutText = document.createElement('span');
  payoutText.textContent = t('accountEdit.interestPayout');
  const payoutIn = document.createElement('select');
  payoutIn.className = 'form-input';
  payoutIn.style.cssText = 'width:auto;padding:6px 10px;font-size:13px;';
  for (const [value, key] of [['yearly', 'interestPayoutYearly'], ['quarterly', 'interestPayoutQuarterly'], ['monthly', 'interestPayoutMonthly']]) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = t(`accountEdit.${key}`);
    payoutIn.append(opt);
  }
  payoutIn.value = acc.interestPayout === 'monthly' || acc.interestPayout === 'quarterly' ? acc.interestPayout : 'yearly';
  payoutWrap.append(payoutText, payoutIn);
  const tierModeIn = document.createElement('select');
  tierModeIn.name = 'interestTierMode';
  tierModeIn.className = 'form-input';
  for (const [value, key] of [['progressive', 'interestTierProgressive'], ['full-balance', 'interestTierFullBalance']]) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = t('accountEdit.' + key);
    tierModeIn.append(opt);
  }
  tierModeIn.value = acc.interestTierMode === 'full-balance' ? 'full-balance' : 'progressive';
  const tierModeField = field(t('accountEdit.interestTierMode'), tierModeIn);
  tiersWrap.append(tiersLbl, tiersHint, tierModeField, tiersList, addTierBtn, payoutWrap);

  function addTierRow(tier = {}, isLast = false) {
    const row = document.createElement('div');
    row.className = 'tier-row';
    row.style.cssText = 'display:flex;gap:6px;align-items:center;';
    const upToInput = document.createElement('input');
    upToInput.type = 'number'; upToInput.step = '0.01'; upToInput.min = '0';
    upToInput.className = 'form-input';
    upToInput.placeholder = t('accountEdit.upToPlaceholder');
    upToInput.style.cssText = 'flex:1;padding:6px 8px;font-size:13px;';
    if (tier.upTo != null && Number.isFinite(Number(tier.upTo))) {
      upToInput.value = Number(tier.upTo);
    }
    enableFormulaInput(upToInput);
    const rateInput = document.createElement('input');
    rateInput.type = 'number'; rateInput.step = '0.001'; rateInput.min = '0';
    rateInput.className = 'form-input';
    rateInput.placeholder = '%';
    rateInput.style.cssText = 'width:80px;padding:6px 8px;font-size:13px;';
    if (tier.rate != null && Number.isFinite(Number(tier.rate))) {
      rateInput.value = Number(tier.rate);
    }
    enableFormulaInput(rateInput, { decimals: 3 });
    const pct = document.createElement('span');
    pct.textContent = '%';
    pct.style.cssText = 'font-size:13px;color:var(--muted);';
    const rmBtn = document.createElement('button');
    rmBtn.type = 'button'; rmBtn.className = 'btn btn-ghost'; rmBtn.textContent = '×';
    rmBtn.style.cssText = 'padding:0 8px;line-height:1;';
    rmBtn.addEventListener('click', () => { row.remove(); applyPayoutVisibility(); });
    row.append(upToInput, rateInput, pct, rmBtn);
    if (isLast) {
      upToInput.placeholder = t('accountEdit.upToRest');
      upToInput.value = '';
    }
    tiersList.append(row);
    applyPayoutVisibility();
  }

  // The payout is saved only with tiers, so it is offered only with a row.
  function applyPayoutVisibility() {
    payoutWrap.style.display = tiersList.querySelector('.tier-row') ? 'flex' : 'none';
  }

  const initialTiers = Array.isArray(acc.interestTiers) ? acc.interestTiers : [];
  initialTiers.forEach((tier, i) => addTierRow(tier, i === initialTiers.length - 1 && tier && tier.upTo == null));
  addTierBtn.addEventListener('click', () => addTierRow({}, false));
  applyPayoutVisibility();

  function applyInterestVisibility() {
    tiersWrap.style.display = INTEREST_TYPES.has(typeIn.value) ? '' : 'none';
    applyPayoutVisibility();
  }
  applyInterestVisibility();
  typeIn.addEventListener('change', applyInterestVisibility);

  // ── Loans: interest rates over time; a loan given's dates and cycle ─────
  // A dated list of yearly rates: a fixed rate is one row, a Euribor-linked
  // loan gets a row each time the rate resets (engine loan-terms.js
  // `loanRateOn`). A loan given also has a start and a repaid-by date, and
  // how often its interest falls due, counted from the start; with no rate
  // there is nothing to fall due, so that choice stays hidden.
  const dateInput = (type, value, name) => {
    const inp = document.createElement('input');
    inp.type = type;
    inp.name = name;
    inp.className = 'form-input';
    inp.value = value || '';
    return inp;
  };
  const loanWrap = document.createElement('div');
  loanWrap.className = 'field';
  const ratesLbl = document.createElement('label');
  ratesLbl.textContent = t('accountEdit.interestRates');
  const ratesHint = document.createElement('div');
  ratesHint.className = 'muted';
  ratesHint.style.cssText = 'font-size:12px;margin:2px 0 8px;';
  ratesHint.textContent = t('accountEdit.interestRatesHint');
  const ratesList = document.createElement('div');
  ratesList.style.cssText = 'display:flex;flex-direction:column;gap:6px;';
  const addRateBtn = document.createElement('button');
  addRateBtn.type = 'button';
  addRateBtn.className = 'btn btn-ghost';
  addRateBtn.style.cssText = 'align-self:flex-start;font-size:12px;padding:4px 10px;margin-top:6px;';
  addRateBtn.textContent = '+ ' + t('accountEdit.addRate');
  function addRateRow(entry = {}) {
    const row = document.createElement('div');
    row.className = 'rate-row';
    row.style.cssText = 'display:flex;gap:6px;align-items:center;';
    const fromIn = dateInput('date', entry.from, 'rateFrom');
    fromIn.style.cssText = 'flex:1;padding:6px 8px;font-size:13px;';
    fromIn.setAttribute('aria-label', t('accountEdit.rateFrom'));
    const rateIn = document.createElement('input');
    rateIn.type = 'number'; rateIn.step = '0.001'; rateIn.min = '0';
    rateIn.name = 'rate';
    rateIn.className = 'form-input';
    rateIn.placeholder = '%';
    rateIn.setAttribute('aria-label', t('accountEdit.rateValue'));
    rateIn.style.cssText = 'width:90px;padding:6px 8px;font-size:13px;';
    if (entry.rate != null && Number.isFinite(Number(entry.rate))) rateIn.value = String(Number(entry.rate));
    const pct = document.createElement('span');
    pct.textContent = '%';
    pct.style.cssText = 'font-size:13px;color:var(--muted);';
    const rmBtn = document.createElement('button');
    rmBtn.type = 'button'; rmBtn.className = 'btn btn-ghost'; rmBtn.textContent = '×';
    rmBtn.setAttribute('aria-label', t('accountEdit.removeRate'));
    rmBtn.style.cssText = 'padding:0 8px;line-height:1;';
    rmBtn.addEventListener('click', () => { row.remove(); applyLoanVisibility(); });
    row.append(fromIn, rateIn, pct, rmBtn);
    ratesList.append(row);
    applyLoanVisibility();
  }
  addRateBtn.addEventListener('click', () => addRateRow({}));

  const loanStartIn = dateInput('date', acc.loanStart, 'loanStart');
  const loanEndIn = dateInput('date', acc.loanEnd, 'loanEnd');
  const loanStartField = field(t('accountEdit.loanStart'), loanStartIn);
  attachFieldHint(loanStartField, loanStartIn);
  loanStartIn.addEventListener('input', () => setFieldHint(loanStartField, ''));
  const loanEndField = field(t('accountEdit.loanEnd'), loanEndIn);
  attachFieldHint(loanEndField, loanEndIn);
  loanEndIn.addEventListener('input', () => setFieldHint(loanEndField, ''));
  const loanDatesRow = document.createElement('div');
  loanDatesRow.className = 'field-row';
  loanDatesRow.append(loanStartField, loanEndField);
  const loanPayoutSel = document.createElement('select');
  loanPayoutSel.className = 'form-input';
  loanPayoutSel.name = 'loanPayout';
  // Counted from the start date, not the calendar: not the savings labels.
  for (const [value, key] of [['yearly', 'loanPaidYearly'], ['quarterly', 'loanPaidQuarterly'], ['monthly', 'loanPaidMonthly']]) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = t(`accountEdit.${key}`);
    loanPayoutSel.append(opt);
  }
  loanPayoutSel.value = acc.interestPayout === 'monthly' || acc.interestPayout === 'quarterly' ? acc.interestPayout : 'yearly';
  const loanPayoutField = field(t('accountEdit.loanInterestPaid'), loanPayoutSel);
  const loanTermsHint = document.createElement('div');
  loanTermsHint.className = 'muted';
  loanTermsHint.style.cssText = 'font-size:12px;margin:-4px 0 8px;';
  loanTermsHint.textContent = t('accountEdit.loanTermsHint');
  const loanGivenPart = document.createElement('div');
  loanGivenPart.style.marginTop = '10px';
  loanGivenPart.append(loanDatesRow, loanPayoutField, loanTermsHint);
  // A loan's interest day count (engine loan-terms.js `loanDayCount`): by
  // actual days ÷ 365 unless the loan says otherwise. A loan given accrues
  // day by day on its own cycle, so it does not ask.
  const dayCountSel = document.createElement('select');
  dayCountSel.className = 'form-input';
  dayCountSel.name = 'interestDayCount';
  for (const [value, key] of [['act/365', 'dayCountAct365'], ['act/360', 'dayCountAct360'], ['30/360', 'dayCount30360']]) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = t(`accountEdit.${key}`);
    dayCountSel.append(opt);
  }
  dayCountSel.value = acc.interestDayCount === 'act/360' || acc.interestDayCount === '30/360' ? acc.interestDayCount : 'act/365';
  const dayCountField = field(t('accountEdit.interestDayCount'), dayCountSel);
  dayCountField.style.marginTop = '10px';
  const dayCountHint = document.createElement('div');
  dayCountHint.className = 'muted';
  dayCountHint.style.cssText = 'font-size:12px;margin:-4px 0 8px;';
  dayCountHint.textContent = t('accountEdit.interestDayCountHint');
  const loanOwedPart = document.createElement('div');
  loanOwedPart.append(dayCountField, dayCountHint);
  loanWrap.append(ratesLbl, ratesHint, ratesList, addRateBtn, loanOwedPart, loanGivenPart);

  function applyLoanVisibility() {
    const isLoanType = LOAN_TYPES.has(typeIn.value);
    loanWrap.style.display = isLoanType ? '' : 'none';
    loanGivenPart.style.display = typeIn.value === 'loan_given' ? '' : 'none';
    loanOwedPart.style.display = typeIn.value === 'loan' ? '' : 'none';
    // How often interest falls due only matters once there is a rate.
    loanPayoutField.style.display = ratesList.querySelector('.rate-row') ? '' : 'none';
  }
  // An account set up before rates had dates carries savings-style tiers:
  // offer its rate as the first dated row, from the start date.
  const initialRates = Array.isArray(acc.interestRates) && acc.interestRates.length
    ? acc.interestRates
    : (LOAN_TYPES.has(acc.type) && Array.isArray(acc.interestTiers)
      ? acc.interestTiers.filter(tier => tier && Number(tier.rate) > 0).slice(0, 1).map(tier => ({ from: acc.loanStart || '', rate: tier.rate }))
      : []);
  for (const r of initialRates) addRateRow(r);
  applyLoanVisibility();
  typeIn.addEventListener('change', applyLoanVisibility);

  // ── Track investments toggle (investment accounts only) ────────────────
  const trackWrap = document.createElement('div');
  trackWrap.className = 'field';
  const trackRow = document.createElement('label');
  trackRow.className = 'settings-toggle';
  trackRow.style.cssText = 'border-bottom:none;padding:4px 0;';
  const trackText = document.createElement('span');
  trackText.className = 'settings-toggle-text';
  const trackLbl = document.createElement('span');
  trackLbl.className = 'settings-toggle-label';
  trackLbl.textContent = t('accountEdit.trackInvestments');
  const trackHint = document.createElement('span');
  trackHint.className = 'settings-toggle-hint';
  trackHint.textContent = t('accountEdit.trackInvestmentsHint');
  trackText.append(trackLbl, trackHint);
  const trackSwitch = document.createElement('span');
  trackSwitch.className = 'bp-switch';
  const trackInput = document.createElement('input');
  trackInput.type = 'checkbox';
  trackInput.checked = acc.trackInvestments !== false; // default true
  const trackTrack = document.createElement('span');
  trackTrack.className = 'bp-switch-track';
  trackSwitch.append(trackInput, trackTrack);
  trackRow.append(trackText, trackSwitch);
  trackWrap.append(trackRow);

  function applyTrackVisibility() {
    trackWrap.style.display = typeIn.value === 'investment' ? '' : 'none';
  }
  applyTrackVisibility();
  typeIn.addEventListener('change', applyTrackVisibility);

  // ── Pension insurance toggle (investment accounts only) ─────────────────
  // Display-only: `type` stays 'investment' either way, so nothing that
  // keys off type === 'investment' for forecasting / off-budget math /
  // envelope exclusion changes behaviour. This just marks the account as
  // locked pension money (e.g. Mandatum) for the dashboard/report split.
  const pensionWrap = document.createElement('div');
  pensionWrap.className = 'field';
  const pensionRow = document.createElement('label');
  pensionRow.className = 'settings-toggle';
  pensionRow.style.cssText = 'border-bottom:none;padding:4px 0;';
  const pensionText = document.createElement('span');
  pensionText.className = 'settings-toggle-text';
  const pensionLbl = document.createElement('span');
  pensionLbl.className = 'settings-toggle-label';
  pensionLbl.textContent = t('accountEdit.pensionInsurance');
  const pensionHint = document.createElement('span');
  pensionHint.className = 'settings-toggle-hint';
  pensionHint.textContent = t('accountEdit.pensionInsuranceHint');
  pensionText.append(pensionLbl, pensionHint);
  const pensionSwitch = document.createElement('span');
  pensionSwitch.className = 'bp-switch';
  const pensionInput = document.createElement('input');
  pensionInput.type = 'checkbox';
  pensionInput.checked = acc.pensionInsurance === true; // default false
  const pensionTrack = document.createElement('span');
  pensionTrack.className = 'bp-switch-track';
  pensionSwitch.append(pensionInput, pensionTrack);
  pensionRow.append(pensionText, pensionSwitch);
  pensionWrap.append(pensionRow);

  function applyPensionVisibility() {
    pensionWrap.style.display = typeIn.value === 'investment' ? '' : 'none';
  }
  applyPensionVisibility();
  typeIn.addEventListener('change', applyPensionVisibility);

  // ── Tax-wrapped toggle (investment accounts only) ───────────────────────
  // An equity savings account (osakesäästötili) or similar wrapper: sales
  // inside it are not taxed one by one, so the Investments tax report leaves
  // it out (engine tax-lots.js). Pension insurance is left out anyway.
  const taxWrap = document.createElement('div');
  taxWrap.className = 'field';
  const taxRow = document.createElement('label');
  taxRow.className = 'settings-toggle';
  taxRow.style.cssText = 'border-bottom:none;padding:4px 0;';
  const taxText = document.createElement('span');
  taxText.className = 'settings-toggle-text';
  const taxLbl = document.createElement('span');
  taxLbl.className = 'settings-toggle-label';
  taxLbl.textContent = t('accountEdit.taxWrapped');
  const taxHint = document.createElement('span');
  taxHint.className = 'settings-toggle-hint';
  taxHint.textContent = t('accountEdit.taxWrappedHint');
  taxText.append(taxLbl, taxHint);
  const taxSwitch = document.createElement('span');
  taxSwitch.className = 'bp-switch';
  const taxInput = document.createElement('input');
  taxInput.type = 'checkbox';
  taxInput.checked = acc.taxWrapped === true; // default false
  const taxTrack = document.createElement('span');
  taxTrack.className = 'bp-switch-track';
  taxSwitch.append(taxInput, taxTrack);
  taxRow.append(taxText, taxSwitch);
  taxWrap.append(taxRow);

  function applyTaxVisibility() {
    taxWrap.style.display = typeIn.value === 'investment' ? '' : 'none';
  }
  applyTaxVisibility();
  typeIn.addEventListener('change', applyTaxVisibility);

  // ── Spending account (every type) ────────────────────────────────────────
  // Scope of the Overview's spending-accounts card, Age of Money and the
  // runway (engine `isSpendingAccount`). Defaults by type; stored only when
  // it differs from that default, so changing the type moves an account
  // that was never touched along with it.
  const spendWrap = document.createElement('div');
  spendWrap.className = 'field';
  const spendRow = document.createElement('label');
  spendRow.className = 'settings-toggle';
  spendRow.style.cssText = 'border-bottom:none;padding:4px 0;';
  const spendText = document.createElement('span');
  spendText.className = 'settings-toggle-text';
  const spendLbl = document.createElement('span');
  spendLbl.className = 'settings-toggle-label';
  spendLbl.textContent = t('accountEdit.spendingAccount');
  const spendHint = document.createElement('span');
  spendHint.className = 'settings-toggle-hint';
  spendHint.textContent = t('accountEdit.spendingAccountHint');
  spendText.append(spendLbl, spendHint);
  const spendSwitch = document.createElement('span');
  spendSwitch.className = 'bp-switch';
  const spendInput = document.createElement('input');
  spendInput.type = 'checkbox';
  spendInput.checked = isSpendingAccount({ ...acc, type: typeIn.value });
  const spendTrack = document.createElement('span');
  spendTrack.className = 'bp-switch-track';
  spendSwitch.append(spendInput, spendTrack);
  spendRow.append(spendText, spendSwitch);
  spendWrap.append(spendRow);
  let spendTouched = false;
  spendInput.addEventListener('change', () => { spendTouched = true; });
  typeIn.addEventListener('change', () => {
    if (!spendTouched && typeof acc.spending !== 'boolean') spendInput.checked = spendingByDefault(typeIn.value);
  });

  // ── Crisis cash (non-spending accounts only) ─────────────────────────────
  // Scope of the Stress page's cash-on-hand (engine `isCrisisCashAccount`).
  // Spending accounts always count, so the toggle is hidden for them.
  // Defaults to `type === 'savings'`; stored only when it differs.
  const crisisWrap = document.createElement('div');
  crisisWrap.className = 'field';
  const crisisRow = document.createElement('label');
  crisisRow.className = 'settings-toggle';
  crisisRow.style.cssText = 'border-bottom:none;padding:4px 0;';
  const crisisText = document.createElement('span');
  crisisText.className = 'settings-toggle-text';
  const crisisLbl = document.createElement('span');
  crisisLbl.className = 'settings-toggle-label';
  crisisLbl.textContent = t('accountEdit.crisisCash');
  const crisisHint = document.createElement('span');
  crisisHint.className = 'settings-toggle-hint';
  crisisHint.textContent = t('accountEdit.crisisCashHint');
  crisisText.append(crisisLbl, crisisHint);
  const crisisSwitch = document.createElement('span');
  crisisSwitch.className = 'bp-switch';
  const crisisInput = document.createElement('input');
  crisisInput.type = 'checkbox';
  const crisisTrack = document.createElement('span');
  crisisTrack.className = 'bp-switch-track';
  crisisSwitch.append(crisisInput, crisisTrack);
  crisisRow.append(crisisText, crisisSwitch);
  crisisWrap.append(crisisRow);

  const crisisDefault = () => typeIn.value === 'savings';
  crisisInput.checked = isCrisisCashAccount({ ...acc, type: typeIn.value, spending: spendInput.checked });
  let crisisTouched = false;
  crisisInput.addEventListener('change', () => { crisisTouched = true; });
  function applyCrisisVisibility() {
    crisisWrap.style.display = spendInput.checked ? 'none' : '';
    if (!crisisTouched && typeof acc.crisisCash !== 'boolean') crisisInput.checked = crisisDefault();
  }
  applyCrisisVisibility();
  spendInput.addEventListener('change', applyCrisisVisibility);
  typeIn.addEventListener('change', applyCrisisVisibility);

  // ── Paid off from (cards: credit cards, bank or cash used as one) ───────
  // The forecast and the Net worth projection pay what the card owes at each
  // month-end from this account (engine card-settlement.js). Offered: the
  // other live bank, cash and savings accounts.
  const settleIn = document.createElement('select');
  const settleNone = document.createElement('option');
  settleNone.value = '';
  settleNone.textContent = t('accountEdit.settledFromNone');
  settleIn.append(settleNone);
  for (const a of state.accounts || []) {
    if (!a || a.archived || a.id === acc.id || !canPayCards(a)) continue;
    const o = document.createElement('option');
    o.value = a.id;
    o.textContent = a.name;
    settleIn.append(o);
  }
  settleIn.value = [...settleIn.options].some(o => o.value === acc.settledFrom) ? acc.settledFrom : '';
  const settleWrap = field(t('accountEdit.settledFrom'), settleIn);
  const settleHint = document.createElement('div');
  settleHint.className = 'field-note';
  settleHint.textContent = t('accountEdit.settledFromHint');
  settleWrap.append(settleHint);
  function applySettleVisibility() {
    settleWrap.style.display = SETTLED_TYPES.includes(typeIn.value) ? '' : 'none';
  }
  applySettleVisibility();
  typeIn.addEventListener('change', applySettleVisibility);

  // ── Asset group (asset accounts only) ───────────────────────────────────
  // A free label ("Properties", "Gold", "Mortgage") the Accounts page groups
  // asset accounts by; the ones already in use are suggested.
  const groupIn = document.createElement('input');
  groupIn.type = 'text';
  groupIn.value = acc.group || '';
  groupIn.placeholder = t('accountEdit.assetGroupPlaceholder');
  const groupList = document.createElement('datalist');
  groupList.id = 'account-asset-groups';
  for (const g of new Set((state.accounts || []).map(a => a.group).filter(Boolean))) {
    const o = document.createElement('option'); o.value = g; groupList.append(o);
  }
  groupIn.setAttribute('list', groupList.id);
  const groupWrap = field(t('accountEdit.assetGroup'), groupIn);
  groupWrap.append(groupList);
  const groupHint = document.createElement('div');
  groupHint.className = 'field-note';
  groupHint.textContent = t('accountEdit.assetHint');
  groupWrap.append(groupHint);

  // An asset account is off-budget: never spending money or crisis cash, so
  // those switches do not apply to it.
  // A loan is off-budget the same way (engine `isLoanAccount`).
  function applyAssetVisibility() {
    const isAsset = typeIn.value === 'asset';
    const offBudget = isAsset || typeIn.value === 'loan' || typeIn.value === 'loan_given';
    groupWrap.style.display = isAsset ? '' : 'none';
    spendWrap.style.display = offBudget ? 'none' : '';
    if (offBudget) crisisWrap.style.display = 'none';
    else applyCrisisVisibility();
  }
  applyAssetVisibility();
  typeIn.addEventListener('change', applyAssetVisibility);

  const initBalField = field(t('accountEdit.initialBalance'), initIn);
  initBalField.append(node('p', 'muted money-field-help', t('moneyWorkspace.openingHelp')));
  attachFieldHint(initBalField, initIn);
  initIn.addEventListener('input', () => setFieldHint(initBalField, ''));
  const initBalLabel = initBalField.querySelector('label');
  let shownType = typeIn.value;
  function applyInitialBalanceLabel() {
    const wasLoan = isLoanType(shownType);
    const nowLoan = isLoanType(typeIn.value);
    shownType = typeIn.value;
    if (initBalLabel) initBalLabel.textContent = t(nowLoan ? 'accountEdit.amountOwed' : 'accountEdit.initialBalance');
    // Keep the balance's meaning across the switch: owed 500 is -500 on
    // any other type, and a -500 balance is 500 owed.
    if (wasLoan === nowLoan) return;
    const v = validateAmount(parseAmountInput(initIn.value));
    if (v === null || v === 0) return;
    initIn.value = String(nowLoan ? Math.abs(v) : -Math.abs(v));
  }
  applyInitialBalanceLabel();
  typeIn.addEventListener('change', applyInitialBalanceLabel);

  const typeBalRow = document.createElement('div');
  typeBalRow.className = 'field-row';
  typeBalRow.append(field(t('accountEdit.type'), typeIn), initBalField);

  form.append(
    nameField,
    typeBalRow,
    field(t('accountEdit.notes'), notesIn),
    codeField,
    groupWrap,
    tiersWrap,
    loanWrap,
    pensionWrap,
    taxWrap,
    disclosure(t('workspace.advanced'), [trackWrap, spendWrap, crisisWrap, settleWrap]),
  );

  if (!isNew && acc.lastReconciledAt) {
    const info = document.createElement('div');
    info.style.cssText = 'font-size:12px;color:var(--muted);margin-top:4px;';
    info.textContent = t('reconcile.lastReconciled')(
      fmt(acc.lastReconciledBalance ?? 0),
      fmtDateLang(acc.lastReconciledAt),
    );
    form.append(info);
  }

  const footer = document.createElement('div');
  footer.dataset.sheetActions = '';
  footer.style.cssText = 'display:flex;gap:8px;justify-content:space-between;align-items:center;margin-top:8px;flex-wrap:wrap;';

  const leftGroup = document.createElement('div');
  leftGroup.style.cssText = 'display:flex;gap:8px;';

  if (!isNew) {
    const archiveBtn = document.createElement('button');
    archiveBtn.type = 'button';
    archiveBtn.className = 'btn btn-ghost';
    archiveBtn.textContent = acc.archived ? t('common.unarchive') : t('common.archive');
    archiveBtn.addEventListener('click', async () => {
      // Archiving (not un-archiving) an account that plan items still post
      // to needs the same confirmation as deleting: the account keeps
      // receiving those postings today, archived or not.
      if (!acc.archived) {
        const planRefs = planItemsUsingAccount(state.budgetItems, acc.id);
        const forecastRefs = plannedItemsForecastingFromAccount(state.budgetItems, acc.id);
        const futureRows = futureRowsTouching({
          transactions: state.transactions, today: appNow(), accountIds: [acc.id],
        }).length;
        const lines = [
          ...(planRefs > 0 ? [t('accountEdit.planItemsArchiveWarning')(planRefs)] : []),
          ...(forecastRefs > 0 ? [t('accountEdit.plannedItemsHistoryWarning')(forecastRefs)] : []),
          ...(futureRows > 0 ? [t('common.futureRowsArchiveWarning')(futureRows)] : []),
        ];
        if (lines.length) {
          const ok = await confirmDialog(
            lines.join('\n\n'),
            { title: t('common.archive'), okLabel: t('common.archive') },
          );
          if (!ok) return;
        }
      }
      const r = await dispatchOrReport('account.archive', { id: acc.id, archived: !acc.archived });
      if (!r) return;
      updateStatusBar();
      close();
      navigate('accounts');
      toast(acc.archived ? t('common.unarchivedToast')(acc.name) : t('common.archivedToast')(acc.name), {
        action: undoAction(r.value.undo, 'accounts'),
      });
    });
    leftGroup.append(archiveBtn);

    const refs = countAccountRefs(acc.id);
    if (refs === 0) {
      const deleteBtn = document.createElement('button');
      deleteBtn.type = 'button';
      deleteBtn.className = 'btn btn-ghost';
      deleteBtn.style.color = 'var(--danger)';
      deleteBtn.textContent = t('common.delete');
      deleteBtn.addEventListener('click', async () => {
        const planRefs = planItemsUsingAccount(state.budgetItems, acc.id);
        const forecastRefs = plannedItemsForecastingFromAccount(state.budgetItems, acc.id);
        const message = [
          t('accountEdit.deleteConfirm')(acc.name),
          ...(planRefs > 0 ? [t('accountEdit.planItemsWarning')(planRefs)] : []),
          ...(forecastRefs > 0 ? [t('accountEdit.plannedItemsHistoryWarning')(forecastRefs)] : []),
        ].join('\n\n');
        const ok = await confirmDialog(
          message,
          { title: t('accountEdit.deleteTitle'), danger: true, okLabel: t('common.delete') },
        );
        if (!ok) return;
        // in_use cannot normally happen (the button is offered at zero refs);
        // if the budget changed underneath, the refusal is reported as is.
        const r = await dispatchOrReport('account.delete', { id: acc.id });
        if (!r) return;
        updateStatusBar();
        close();
        navigate('accounts');
        toast(t('accountEdit.deleted'), { action: undoAction(r.value.undo, 'accounts') });
      });
      leftGroup.append(deleteBtn);
    } else {
      const refInfo = document.createElement('span');
      refInfo.style.cssText = 'font-size:12px;color:var(--muted);align-self:center;';
      refInfo.textContent = t('accountEdit.refsCannotDelete')(refs);
      leftGroup.append(refInfo);
    }
  }

  const rightGroup = document.createElement('div');
  rightGroup.style.cssText = 'display:flex;gap:8px;';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'btn btn-ghost';
  cancel.textContent = t('common.cancel');
  const save = document.createElement('button');
  save.type = 'submit';
  save.className = 'btn btn-accent';
  save.textContent = t('common.save');
  rightGroup.append(cancel, save);

  footer.append(leftGroup, rightGroup);
  form.append(footer);

  const tracker = trackDirty(form);
  const { close, requestClose } = openSheet({
    title: isNew ? t('accounts.newTitle') : t('accounts.editTitle'),
    content: form,
    confirmClose: tracker.confirmClose,
  });
  cancel.addEventListener('click', requestClose);

  markRequired(initIn);
  setupFormValidation(form);

  form.addEventListener('submit', guardSubmit(async (e) => {
    e.preventDefault();
    const name = nameIn.value.trim();
    if (!name) return;
    const type = typeIn.value;
    const enteredBalance = validateAmount(parseAmountInput(initIn.value, { strict: true }));
    const initialBalance = enteredBalance !== null && isLoanType(type) ? -Math.abs(enteredBalance) : enteredBalance;
    if (initialBalance === null) {
      setFieldHint(initBalField, t('accountEdit.initialBalanceInvalid'));
      initIn.focus();
      return;
    }
    // The opening balance is part of every reconciled balance on the
    // account (js/engine/reconciled.js), so moving it asks first.
    if (!isNew && acc.lastReconciledAt
        && Math.abs(initialBalance - (Number(acc.initialBalance) || 0)) >= 0.005) {
      const ok = await confirmDialog(t('reconciledRow.openingConfirm')(fmtDateLang(acc.lastReconciledAt)), {
        title: t('reconciledRow.title'),
        okLabel: t('reconciledRow.editAnyway'),
        cancelLabel: t('common.cancel'),
      });
      if (ok !== true) return;
    }
    const notes = notesIn.value.trim();
    // Loan rates (both loan types) and a loan given's terms. Rows without a
    // date or a rate are dropped; an end before the start is refused, and a
    // loan given with interest needs a start date to count its cycle from.
    const isLoanGiven = type === 'loan_given';
    const interestRates = [];
    if (LOAN_TYPES.has(type)) {
      for (const row of ratesList.querySelectorAll('.rate-row')) {
        const from = row.querySelector('input[name="rateFrom"]').value;
        const rate = parseAmountInput(row.querySelector('input[name="rate"]').value);
        if (from && Number.isFinite(rate) && rate >= 0) interestRates.push({ from, rate: Math.round(rate * 1000) / 1000 });
      }
      interestRates.sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
    }
    // Stored only when it is not the default (actual/365).
    const interestDayCount = type === 'loan' && dayCountSel.value !== 'act/365' ? dayCountSel.value : null;
    const loanStart = isLoanGiven ? (loanStartIn.value || null) : null;
    const loanEnd = isLoanGiven ? (loanEndIn.value || null) : null;
    if (loanStart && loanEnd && loanEnd < loanStart) {
      setFieldHint(loanEndField, t('accountEdit.loanEndBeforeStart'));
      loanEndIn.focus();
      return;
    }
    if (isLoanGiven && interestRates.length && !loanStart) {
      setFieldHint(loanStartField, t('accountEdit.loanStartNeeded'));
      loanStartIn.focus();
      return;
    }

    // Collect interest tiers (only meaningful for savings).
    const tiers = [];
    if (INTEREST_TYPES.has(type)) {
      const rows = [...tiersList.querySelectorAll('.tier-row')];
      rows.forEach((row, i) => {
        const inputs = row.querySelectorAll('input');
        const upToRaw = inputs[0].value;
        const rateRaw = inputs[1].value;
        const rate = parseAmountInput(rateRaw);
        if (!Number.isFinite(rate) || rate < 0) return;
        const tier = { rate: Math.round(rate * 1000) / 1000 };
        const upTo = parseAmountInput(upToRaw);
        if (Number.isFinite(upTo) && upTo > 0 && i < rows.length - 1) {
          // The last tier always covers "the rest" — drop its upTo.
          tier.upTo = Math.round(upTo * 100) / 100;
        } else if (Number.isFinite(upTo) && upTo > 0) {
          tier.upTo = Math.round(upTo * 100) / 100;
        }
        tiers.push(tier);
      });
    }
    const interestPayout = isLoanGiven
      ? (interestRates.length && loanPayoutSel.value !== 'yearly' ? loanPayoutSel.value : null)
      : (tiers.length && payoutIn.value !== 'yearly' ? payoutIn.value : null);

    // Track-investments flag: persist only when relevant (investment type)
    // and only when the user opted out (default behaviour stays implicit).
    const trackInvestments = type === 'investment' ? trackInput.checked : null;

    // Pension-insurance flag: display-only, persist only when relevant
    // (investment type) and only when the user opted in (default false).
    const pensionInsurance = type === 'investment' ? pensionInput.checked : null;
    const taxWrapped = type === 'investment' ? taxInput.checked : null;

    const isAsset = type === 'asset';
    const group = isAsset ? groupIn.value.trim() : '';

    // Spending flag: persisted only when it differs from the type's default.
    // Never on an asset account, which the engine keeps off-budget anyway.
    const offBudget = isAsset || type === 'loan' || type === 'loan_given';
    const spending = offBudget || spendInput.checked === spendingByDefault(type) ? null : spendInput.checked;

    // Crisis-cash flag: irrelevant for a spending account (always counts);
    // otherwise persisted only when it differs from the type's default.
    const crisisCash = crisisCashToStore({
      isAsset: offBudget, spending: spendInput.checked, crisisChecked: crisisInput.checked, type,
    });

    // A type change across the budget's cash boundary moves Unallocated by
    // the whole balance; offer to release (or fund) the envelope that holds
    // it instead (account-type-move.js). The command writes the adjustment
    // row in the same commit as the type change.
    let move = null;
    if (!isNew) {
      const crossing = identityMove(acc, type, state.accounts, state.transactions);
      if (crossing) {
        const choice = await askIdentityMove(crossing, name);
        if (!choice) return;
        move = { moveEnvelope: choice.envelopeId, moveNote: t('accountEdit.moveNote')(name) };
      }
    }

    // The form's values as it computes them; null where an empty value is
    // not stored. The command drops the nulls and every field that does not
    // belong to the type (applyAccountFields), as this form used to.
    const fields = {
      code: codeIn.value.trim(),
      name, type, initialBalance,
      notes: notes || null,
      interestTiers: tiers.length ? tiers : null,
      interestTierMode: type === 'savings' && tierModeIn.value === 'full-balance' ? 'full-balance' : null,
      interestPayout,
      trackInvestments, pensionInsurance, taxWrapped,
      spending, crisisCash,
      group: group || null,
      interestRates: interestRates.length ? interestRates : null,
      interestDayCount,
      loanStart, loanEnd,
      settledFrom: SETTLED_TYPES.includes(type) && settleIn.value ? settleIn.value : null,
    };
    let r;
    try {
      r = await withBusy(save, () => (isNew
        ? session.dispatch('account.create', fields)
        : session.dispatch('account.update', { id: acc.id, fields, ...move })), { label: t('common.saving') });
    } catch (err) {
      console.error(err);
      toast(t('common.saveFailed')(err?.message || err), { assertive: true });
      return;
    }
    if (!r.ok) {
      if (['code_taken', 'code_invalid', 'code_exhausted'].includes(r.error.code)) {
        const key = { code_taken: 'codeTaken', code_invalid: 'codeInvalid', code_exhausted: 'codeExhausted' }[r.error.code];
        setFieldHint(codeField, t(`coreError.${key}`));
        codeIn.focus();
        return;
      }
      // A taken name belongs on the name field, not in a toast.
      if (r.error.code === 'name_taken') {
        setFieldHint(nameField, t('accountEdit.nameTaken')(r.error.params?.name ?? name));
        nameIn.focus();
        return;
      }
      reportDispatchFailure(r.error);
      return;
    }
    reportMetaFailure(r);
    updateStatusBar();
    close();
    navigate('accounts');
  }));
}
