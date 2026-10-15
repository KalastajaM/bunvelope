/**
 * setup.js — First-run setup wizard
 * Shown when opening a folder that has no budget-meta.json.
 *
 * Step 1 — budget name + currency
 * Step 2 — the main account (optional), and whether to import the bank's
 *          transactions into it right after setup, through the same import
 *          sheet the Transactions page uses (CSV, or a PDF/photo read by AI)
 * Step 3 — the main monthly income (optional): amount, payday, whether it
 *          moves to a working day, paid into the step 2 account. Finish
 *          stores it as an income plan item (budgetItem.create's rules), so
 *          the plan and the scheduler pick it up.
 * Step 4 — review, with a starter set of envelopes to pick from
 *
 * The old step 2 imported a Goodbudget history.csv, a one-off for the
 * owner's own move to Bunvelope; it was replaced by the generic import
 * (owner decision 2026-09-29).
 */

import {
  loadBudgetData, validateSchema,
  CURRENT_SCHEMA_VERSION,
} from './data.js';
import { isGuestFolder } from './storage/guest-adapter.js';
import { CURRENCIES, COUNTRIES, DEFAULT_COUNTRY } from './core/settings-fields.js';
import { displayName } from './ui/display-name.js';
import { writeInitialBudget } from './state/initial-budget.js';
import { state, navigate, updateStatusBar, getPrefs, savePrefs, now as appNow } from './app.js';
import budgetItemCreate from './core/commands/budget-item-create.js';
import { makeCtx } from './core/context.js';
import { setNoBudgetChrome } from './ui/no-budget-chrome.js';
import { setFormatDefaults, escHtml, fmt, slugify, uniqueId, validateAmount } from './utils.js';
import { rebuildPayeeIndex } from './state/payee-index.js';
import { generateId } from './import.js';
import { ensureAiConsent } from './ai/consent.js';
import { aiInsights, isCloudMode } from './ai/client.js';
import { aiErrorText } from './ai/render.js';
import { formatAiText } from './ai/money-text.js';
import { openSheet } from './ui/sheet.js';
import { t } from './ui/i18n.js';
import { toast } from './ui/toast.js';
import { enableFormulaInput, parseAmountInput } from './ui/amount-input.js';
import { STARTER_ENVELOPES, buildStarterEnvelopes, starterName, starterCategory } from './state/starter-envelopes.js';
import { maybeAutoStartTour } from './ui/tour.js';
import { holdBudget, releaseBudget, currentBudgetSession } from './state/budget-session.js';

// ── Wizard state ─────────────────────────────────────────────────────────────

let wizardData = emptyWizardData();

function emptyWizardData() {
  return {
    name:      t('setup.defaultBudgetName'),
    currency:  'EUR',
    country:   guessCountry(typeof navigator === 'undefined' ? [] : navigator.languages ?? [navigator.language]),
    // The main account: blank name = none. `balance` is the raw input text.
    account:   { name: '', type: 'bank', balance: '' },
    importAfter: false, // open the import sheet on that account after setup
    // The main monthly income: blank amount = none. Raw input text, as the
    // account's balance. Finnish pay moves to the working day before.
    income:    { amount: '', day: '', dayType: 'prev_work_day' },
    aiSuggestedEnvelopes: [], // [{ name, category, monthly_target? }]
    starterPicks: new Set(STARTER_ENVELOPES.map(e => e.key)),
  };
}

/**
 * The country the browser's languages name (en-GB → GB), when the app knows
 * its banking holidays; otherwise the default. Exported for tests.
 * @param {readonly string[]} languages BCP 47 tags, e.g. navigator.languages
 * @returns {string}
 */
export function guessCountry(languages) {
  const known = new Set(COUNTRIES.map(([code]) => code));
  for (const tag of languages || []) {
    const region = String(tag || '').split(/[-_]/)[1]?.toUpperCase();
    if (region && known.has(region)) return region;
  }
  return DEFAULT_COUNTRY;
}

/**
 * Step 1's lede. Only a local folder is "empty": a guest or cloud budget
 * has no folder to speak of. Exported for tests.
 * @param {any} folderHandle
 * @returns {string}
 */
export function welcomeBody(folderHandle) {
  const local = folderHandle && !isGuestFolder(folderHandle) && folderHandle.kind !== 'cloud';
  return local ? t('setup.welcomeBody') : t('setup.welcomeBodyNew');
}

// ── Render helpers ───────────────────────────────────────────────────────────

const STEPS = 4;

function stepHeader(step, total) {
  return `<p style="color:var(--muted);font-size:13px;margin-bottom:8px;">${escHtml(t('setup.step')(step, total))}</p>`;
}

function card(content, { maxWidth = 560 } = {}) {
  return `<div class="card" style="max-width:${maxWidth}px;margin:0 auto;padding:36px 32px;">${content}</div>`;
}

function pageWrap(content) {
  return `<div class="page" style="display:flex;align-items:flex-start;justify-content:center;padding-top:60px;">${content}</div>`;
}

// ── Step 1: Welcome + Name ────────────────────────────────────────────────────

function renderStep1(container, folderHandle) {
  container.innerHTML = pageWrap(card(`
    ${stepHeader(1, STEPS)}
    <h1 style="font-size:22px;font-weight:700;margin-bottom:8px;">${escHtml(t('setup.welcomeTitle'))}</h1>
    <p style="color:var(--muted);margin-bottom:24px;line-height:1.5;">
      ${escHtml(welcomeBody(folderHandle))}
    </p>

    <div style="margin-bottom:16px;">
      <label style="display:block;font-size:13px;font-weight:600;margin-bottom:4px;">${escHtml(t('setup.budgetName'))}</label>
      <input id="setup-name" class="form-input" type="text" value="${escHtml(wizardData.name)}"
             style="width:100%;box-sizing:border-box;" />
    </div>

    <div style="margin-bottom:16px;">
      <label for="setup-currency" style="display:block;font-size:13px;font-weight:600;margin-bottom:4px;">${escHtml(t('setup.currency'))}</label>
      <select id="setup-currency" class="form-input" style="width:100%;box-sizing:border-box;">
        ${CURRENCIES.map(([k, lbl]) =>
          `<option value="${k}" ${wizardData.currency === k ? 'selected' : ''}>${k} — ${escHtml(displayName('currency', k, lbl))}</option>`
        ).join('')}
      </select>
    </div>

    <div style="margin-bottom:28px;">
      <label for="setup-country" style="display:block;font-size:13px;font-weight:600;margin-bottom:4px;">${escHtml(t('settings.budget.country'))}</label>
      <select id="setup-country" class="form-input" style="width:100%;box-sizing:border-box;">
        ${COUNTRIES.map(([k, lbl]) =>
          `<option value="${k}" ${wizardData.country === k ? 'selected' : ''}>${escHtml(displayName('region', k, lbl))}</option>`
        ).join('')}
      </select>
      <p style="font-size:12px;color:var(--muted);margin:4px 0 0;">${escHtml(t('settings.budget.countryHint'))}</p>
    </div>

    <button class="btn btn-primary" id="setup-next1" style="width:100%;justify-content:center;">
      ${escHtml(t('setup.getStarted'))}
    </button>
    <button class="btn btn-ghost" id="setup-ai-help" style="width:100%;justify-content:center;margin-top:8px;display:none;">
      ${escHtml(t('setup.askAi'))}
    </button>
    <p id="setup-ai-summary" style="font-size:12px;color:var(--muted);margin-top:8px;text-align:center;display:none;"></p>
  `));

  document.getElementById('setup-next1').addEventListener('click', () => {
    wizardData.name     = document.getElementById('setup-name').value.trim() || t('setup.defaultBudgetName');
    wizardData.currency = document.getElementById('setup-currency').value;
    wizardData.country  = document.getElementById('setup-country').value;
    renderStep2(container, folderHandle);
  });

  const aiBtn = document.getElementById('setup-ai-help');
  const aiSummary = document.getElementById('setup-ai-summary');
  if (isCloudMode()) {
    aiBtn.style.display = '';
    aiBtn.addEventListener('click', async () => {
      const consented = await ensureAiConsent({ setup: true });
      if (!consented) return;
      openOnboardingSheet(() => {
        const n = wizardData.aiSuggestedEnvelopes.length;
        if (n) {
          aiSummary.style.display = '';
          aiSummary.textContent = `${n} envelope${n === 1 ? '' : 's'} ready to add when you finish setup.`;
        }
      });
    });
    if (wizardData.aiSuggestedEnvelopes.length) {
      aiSummary.style.display = '';
      const n = wizardData.aiSuggestedEnvelopes.length;
      aiSummary.textContent = `${n} envelope${n === 1 ? '' : 's'} ready to add when you finish setup.`;
    }
  }
}

function openOnboardingSheet(onChange) {
  const content = document.createElement('div');
  content.style.cssText = 'display:flex;flex-direction:column;gap:12px;';

  const ta = document.createElement('textarea');
  ta.className = 'form-input';
  ta.rows = 4;
  ta.placeholder = t('ai.onboarding.placeholder');
  ta.style.cssText = 'resize:vertical;min-height:90px;padding:8px 10px;';
  content.append(ta);

  const submitRow = document.createElement('div');
  submitRow.dataset.sheetActions = '';
  submitRow.style.cssText = 'display:flex;justify-content:flex-end;gap:8px;';
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'btn btn-ghost';
  closeBtn.textContent = t('common.close');
  const submit = document.createElement('button');
  submit.type = 'button';
  submit.className = 'btn btn-accent';
  submit.textContent = t('ai.onboarding.title');
  submitRow.append(closeBtn, submit);
  content.append(submitRow);

  const result = document.createElement('div');
  result.style.cssText = 'min-height:24px;';
  content.append(result);

  let inFlight = false;
  submit.addEventListener('click', async () => {
    const input = ta.value.trim();
    if (!input || inFlight) return;
    inFlight = true;
    submit.disabled = true;
    result.replaceChildren(loadingNote());
    try {
      const out = await aiInsights('onboarding', { input });
      renderOnboardingResult(result, out, onChange);
    } catch (err) {
      const note = document.createElement('div');
      note.className = 'ai-error';
      note.textContent = aiErrorText(err);
      result.replaceChildren(note);
    } finally {
      inFlight = false;
      submit.disabled = false;
    }
  });

  const sheet = openSheet({ title: t('ai.onboarding.title'), content, wide: true });
  closeBtn.addEventListener('click', () => sheet.close());
}

function loadingNote() {
  const d = document.createElement('div');
  d.className = 'ai-error';
  d.textContent = t('common.loading');
  return d;
}

function renderOnboardingResult(host, out, onChange) {
  host.replaceChildren();
  if (out?.message) {
    const p = document.createElement('p');
    p.style.cssText = 'margin:0 0 8px;line-height:1.5;';
    p.textContent = formatAiText(out.message);
    host.append(p);
  }
  const list = Array.isArray(out?.suggested_envelopes) ? out.suggested_envelopes : [];
  if (!list.length) return;

  const ul = document.createElement('div');
  ul.style.cssText = 'display:flex;flex-direction:column;gap:6px;';
  const checks = [];
  for (const e of list) {
    const row = document.createElement('label');
    row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:6px 8px;border:1px solid var(--border);border-radius:6px;';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = true;
    const label = document.createElement('span');
    label.style.flex = '1';
    const target = Number(e.monthly_target) > 0 ? ` · ${fmt(Number(e.monthly_target))}/mo` : '';
    label.textContent = `${formatAiText(e.name || '')} (${formatAiText(e.category || 'Other')})${target}`;
    row.append(cb, label);
    checks.push({ cb, e });
    ul.append(row);
  }
  host.append(ul);

  const actions = document.createElement('div');
  actions.style.cssText = 'display:flex;justify-content:flex-end;gap:8px;margin-top:12px;';
  const accept = document.createElement('button');
  accept.type = 'button';
  accept.className = 'btn btn-accent';
  accept.textContent = t('ai.onboarding.acceptSelected');
  accept.addEventListener('click', () => {
    const picks = checks.filter((c) => c.cb.checked).map((c) => c.e);
    wizardData.aiSuggestedEnvelopes = picks.map((e) => ({
      // Stored as envelope data on accept, so tokens are resolved first.
      name: formatAiText(e.name || '').trim() || 'Envelope',
      category: formatAiText(e.category || 'Other'),
      monthly_target: Number.isFinite(Number(e.monthly_target)) ? Number(e.monthly_target) : null,
    })).filter((e) => e.name);
    toast(t('ai.reconcile.applied'));
    if (onChange) onChange();
  });
  actions.append(accept);
  host.append(actions);
}

// ── Step 2: the main account (optional) ─────────────────────────────────────

const ACCOUNT_TYPES = [
  ['bank', 'accountEdit.typeBank'],
  ['cash', 'accountEdit.typeCash'],
  ['credit_card', 'accountEdit.typeCreditCard'],
  ['savings', 'accountEdit.typeSavings'],
];

function renderStep2(container, folderHandle) {
  const a = wizardData.account;
  container.innerHTML = pageWrap(card(`
    ${stepHeader(2, STEPS)}
    <h2 style="font-size:18px;font-weight:700;margin-bottom:6px;">${escHtml(t('setup.accountTitle'))}</h2>
    <p style="color:var(--muted);margin-bottom:20px;font-size:14px;line-height:1.5;">
      ${escHtml(t('setup.accountBody'))}
    </p>

    <div class="field">
      <label for="setup-acct-name">${escHtml(t('setup.accountName'))}</label>
      <input id="setup-acct-name" type="text" value="${escHtml(a.name)}" placeholder="${escHtml(t('setup.accountNamePh'))}" />
    </div>
    <div class="field-row">
      <div class="field">
        <label for="setup-acct-type">${escHtml(t('setup.accountType'))}</label>
        <select id="setup-acct-type">
          ${ACCOUNT_TYPES.map(([v, k]) => `<option value="${escHtml(v)}" ${a.type === v ? 'selected' : ''}>${escHtml(t(k))}</option>`).join('')}
        </select>
      </div>
      <div class="field">
        <label for="setup-acct-balance">${escHtml(t('setup.accountBalance'))}</label>
        <input id="setup-acct-balance" type="text" inputmode="decimal" value="${escHtml(a.balance)}" placeholder="0" />
      </div>
    </div>

    <label class="setup-import-after" style="display:flex;gap:10px;align-items:flex-start;margin:4px 0 6px;font-size:14px;cursor:pointer;">
      <input type="checkbox" id="setup-import-after" style="width:auto;margin-top:3px;" ${wizardData.importAfter ? 'checked' : ''} />
      <span>
        <span style="font-weight:600;">${escHtml(t('setup.importAfter'))}</span><br>
        <span style="color:var(--muted);font-size:13px;">${escHtml(t('setup.importAfterHint'))}</span>
      </span>
    </label>

    <div id="setup-acct-error" style="color:var(--danger-text);font-size:13px;margin:8px 0;display:none;"></div>

    <div style="display:flex;gap:12px;margin-top:16px;">
      <button class="btn btn-secondary" id="setup-back2" style="flex:1;justify-content:center;">${escHtml(t('setup.back'))}</button>
      <button class="btn btn-primary"   id="setup-next2" style="flex:2;justify-content:center;">${escHtml(t('setup.continueBtn'))}</button>
    </div>
  `));

  const nameIn = document.getElementById('setup-acct-name');
  const typeIn = document.getElementById('setup-acct-type');
  const balIn = document.getElementById('setup-acct-balance');
  const importCb = document.getElementById('setup-import-after');
  const errEl = document.getElementById('setup-acct-error');
  enableFormulaInput(balIn);
  // Importing needs an account to import into.
  const syncImport = () => {
    const has = nameIn.value.trim() !== '';
    importCb.disabled = !has;
    if (!has) importCb.checked = false;
    importCb.closest('label').style.opacity = has ? '' : '0.55';
  };
  nameIn.addEventListener('input', syncImport);
  syncImport();

  const collect = () => {
    wizardData.account = { name: nameIn.value.trim(), type: typeIn.value, balance: balIn.value.trim() };
    wizardData.importAfter = importCb.checked && !importCb.disabled;
  };
  document.getElementById('setup-back2').addEventListener('click', () => { collect(); renderStep1(container, folderHandle); });
  document.getElementById('setup-next2').addEventListener('click', () => {
    collect();
    if (wizardData.account.name && openingBalance(wizardData.account) === null) {
      errEl.textContent = t('setup.accountBalanceInvalid');
      errEl.style.display = 'block';
      return;
    }
    renderIncome(container, folderHandle);
  });
}

/** The opening balance as a number (blank = 0), or null when unreadable. */
function openingBalance(account) {
  if (!account.balance) return 0;
  return validateAmount(parseAmountInput(account.balance));
}

// ── Step 3: the main income (optional) ──────────────────────────────────────

const DAY_TYPES = [
  ['prev_work_day', 'setup.incomeDayPrev'],
  ['next_work_day', 'setup.incomeDayNext'],
  ['exact', 'setup.incomeDayExact'],
];

function renderIncome(container, folderHandle) {
  const inc = wizardData.income;
  const acctName = wizardData.account.name;
  container.innerHTML = pageWrap(card(`
    ${stepHeader(3, STEPS)}
    <h2 style="font-size:18px;font-weight:700;margin-bottom:6px;">${escHtml(t('setup.incomeTitle'))}</h2>
    <p style="color:var(--muted);margin-bottom:20px;font-size:14px;line-height:1.5;">
      ${escHtml(t('setup.incomeBody'))}
    </p>

    <div class="field-row">
      <div class="field">
        <label for="setup-income-amount">${escHtml(t('setup.incomeAmount'))}</label>
        <input id="setup-income-amount" type="text" inputmode="decimal" value="${escHtml(inc.amount)}" placeholder="0" />
      </div>
      <div class="field">
        <label for="setup-income-day">${escHtml(t('setup.incomeDay'))}</label>
        <input id="setup-income-day" type="number" min="1" max="31" step="1" inputmode="numeric" value="${escHtml(inc.day)}" placeholder="15" />
      </div>
    </div>
    ${acctName ? `
    <div class="field">
      <label for="setup-income-account">${escHtml(t('setup.incomeAccount'))}</label>
      <select id="setup-income-account" disabled><option>${escHtml(acctName)}</option></select>
    </div>
    <div class="field">
      <label for="setup-income-daytype">${escHtml(t('setup.incomeDayType'))}</label>
      <select id="setup-income-daytype">
        ${DAY_TYPES.map(([v, k]) => `<option value="${escHtml(v)}" ${inc.dayType === v ? 'selected' : ''}>${escHtml(t(k))}</option>`).join('')}
      </select>
    </div>` : `
    <p id="setup-income-noacct" style="color:var(--muted);font-size:13px;line-height:1.45;margin:4px 0 0;">${escHtml(t('setup.incomeNoAccount'))}</p>`}

    <div id="setup-income-error" style="color:var(--danger-text);font-size:13px;margin:8px 0;display:none;"></div>

    <div style="display:flex;gap:12px;margin-top:16px;">
      <button class="btn btn-secondary" id="setup-back-income" style="flex:1;justify-content:center;">${escHtml(t('setup.back'))}</button>
      <button class="btn btn-secondary" id="setup-skip-income" style="flex:1;justify-content:center;">${escHtml(t('setup.skip'))}</button>
      <button class="btn btn-primary"   id="setup-next3" style="flex:2;justify-content:center;">${escHtml(t('setup.continueBtn'))}</button>
    </div>
  `));

  const amountIn = /** @type {HTMLInputElement} */ (document.getElementById('setup-income-amount'));
  const dayIn = /** @type {HTMLInputElement} */ (document.getElementById('setup-income-day'));
  const typeIn = /** @type {HTMLSelectElement|null} */ (document.getElementById('setup-income-daytype'));
  const errEl = document.getElementById('setup-income-error');
  enableFormulaInput(amountIn);
  const collect = () => {
    wizardData.income = {
      amount: amountIn.value.trim(),
      day: dayIn.value.trim(),
      dayType: typeIn ? typeIn.value : inc.dayType,
    };
  };
  document.getElementById('setup-back-income').addEventListener('click', () => { collect(); renderStep2(container, folderHandle); });
  document.getElementById('setup-skip-income').addEventListener('click', () => {
    wizardData.income = { amount: '', day: '', dayType: inc.dayType };
    renderReview(container, folderHandle);
  });
  document.getElementById('setup-next3').addEventListener('click', () => {
    collect();
    const bad = incomeError(wizardData.income);
    if (bad) {
      errEl.textContent = t(bad);
      errEl.style.display = 'block';
      return;
    }
    renderReview(container, folderHandle);
  });
}

/**
 * The income the wizard collected, read: null when the amount is blank (the
 * step was skipped), otherwise its amount and payday. Exported for tests.
 * @param {{ amount: string, day: string, dayType: string }} income
 * @returns {null | { amount: number | null, day: number | null, dayType: string }}
 */
export function readIncome(income) {
  if (!income || !String(income.amount ?? '').trim()) return null;
  const amount = validateAmount(parseAmountInput(String(income.amount)));
  const day = Number(String(income.day ?? '').trim());
  return {
    amount: amount !== null && amount > 0 ? amount : null,
    day: Number.isInteger(day) && day >= 1 && day <= 31 ? day : null,
    dayType: income.dayType || 'exact',
  };
}

/** The i18n key of what is wrong with the income, or null. */
function incomeError(income) {
  const read = readIncome(income);
  if (!read) return null;
  if (read.amount === null) return 'setup.incomeAmountInvalid';
  if (read.day === null) return 'setup.incomeDayInvalid';
  return null;
}

/**
 * The income plan item for the new budget, built by budgetItem.create from
 * the fields the Plan editor would store: a positive amount, every month,
 * the payday, and, with an account, posted on a schedule into it with the
 * day type. Null when the step was skipped. Throws when the command refuses
 * it. Exported for tests.
 * @param {{ amount: string, day: string, dayType: string }} income
 * @param {{ budgetItems: any[], accounts: any[], envelopes: any[] }} data
 * @param {Date} now
 * @returns {Record<string, any> | null}
 */
export function incomePlanItem(income, data, now) {
  const read = readIncome(income);
  if (!read) return null;
  const account = data.accounts[0] || null;
  /** @type {Record<string, any>} */
  const fields = {
    kind: 'income',
    description: t('setup.incomeDescription'),
    default_amount: read.amount ?? 0,
    payment_day: read.day ?? 0,
    as_schedule: !!account,
    account_id: account ? account.id : null,
    schedule_day_type: account ? read.dayType : 'exact',
  };
  const ctx = makeCtx({ now, newId: generateId, country: wizardData.country });
  const res = budgetItemCreate.execute({ ...data, transactions: [], meta: {} }, fields, ctx);
  if (!res.ok) {
    const errors = res.error?.params?.errors || [];
    throw new Error(errors.map((/** @type {any} */ e) => `${e.path} ${e.message}`).join('; ') || res.error?.code || 'income');
  }
  const created = /** @type {any[]} */ (res.value.changes.budgetItems);
  return created[created.length - 1];
}

// ── Step 4: review and finish ────────────────────────────────────────────────

function renderReview(container, folderHandle) {
  const income = readIncome(wizardData.income);
  container.innerHTML = pageWrap(card(`
    ${stepHeader(4, STEPS)}
    <h2 style="font-size:18px;font-weight:700;margin-bottom:6px;">${escHtml(t('setup.reviewTitle'))}</h2>
    <p style="color:var(--muted);margin-bottom:20px;font-size:14px;">
      ${escHtml(t('setup.reviewBody'))}
    </p>

    <table style="width:100%;border-collapse:collapse;margin-bottom:24px;font-size:14px;">
      <tr><td style="padding:6px 0;">${escHtml(t('setup.budgetName'))}</td><td style="padding:6px 0;font-weight:600;text-align:right;">${escHtml(wizardData.name)}</td></tr>
      <tr><td style="padding:6px 0;">${escHtml(t('setup.currency'))}</td><td style="padding:6px 0;font-weight:600;text-align:right;">${escHtml(wizardData.currency)}</td></tr>
      <tr><td style="padding:6px 0;">${escHtml(t('settings.budget.country'))}</td><td style="padding:6px 0;font-weight:600;text-align:right;">${escHtml(displayName('region', wizardData.country, wizardData.country))}</td></tr>
      ${wizardData.account.name ? `<tr><td style="padding:6px 0;">${escHtml(t('setup.accountName'))}</td><td style="padding:6px 0;font-weight:600;text-align:right;">${escHtml(wizardData.account.name)}</td></tr>
      <tr><td style="padding:6px 0;">${escHtml(t('setup.accountBalance'))}</td><td style="padding:6px 0;font-weight:600;text-align:right;" id="setup-review-balance">${escHtml(fmt(openingBalance(wizardData.account) ?? 0, { currency: wizardData.currency }))}</td></tr>` : ''}
      ${income ? `<tr><td style="padding:6px 0;">${escHtml(t('setup.incomeReview'))}</td><td style="padding:6px 0;font-weight:600;text-align:right;" id="setup-review-income">${escHtml(t('setup.incomeReviewValue')(fmt(income.amount ?? 0, { currency: wizardData.currency }), income.day ?? 0))}</td></tr>` : ''}
    </table>

    <div id="setup-starter"></div>

    <div id="setup-finish-error" style="color:var(--danger-text);font-size:13px;margin-bottom:12px;display:none;white-space:pre-wrap;"></div>

    <div style="display:flex;gap:12px;">
      <button class="btn btn-secondary" id="setup-back3" style="flex:1;justify-content:center;">${escHtml(t('setup.back'))}</button>
      <button class="btn btn-primary"   id="setup-finish" style="flex:2;justify-content:center;">${escHtml(t('setup.finish'))}</button>
    </div>
  `));
  // Envelopes the AI suggested stand in for the starter set; offering both
  // would be two answers to one question.
  if (!wizardData.aiSuggestedEnvelopes.length) {
    document.getElementById('setup-starter').append(starterPicker());
  }
  document.getElementById('setup-back3').addEventListener('click', () => renderIncome(container, folderHandle));
  document.getElementById('setup-finish').addEventListener('click', () => doFinish(container, folderHandle));
}

// The starter envelopes as ticked checkboxes, grouped by category. The picks
// live in wizardData, so Back and forward again keeps them.
function starterPicker() {
  const wrap = document.createElement('fieldset');
  wrap.className = 'setup-starter';
  wrap.style.cssText = 'border:none;padding:0;margin:0 0 24px;';
  const legend = document.createElement('legend');
  legend.style.cssText = 'font-size:14px;font-weight:600;margin-bottom:4px;padding:0;';
  legend.textContent = t('setup.starter.title');
  const hint = document.createElement('p');
  hint.style.cssText = 'color:var(--muted);font-size:13px;margin:0 0 10px;line-height:1.45;';
  hint.textContent = t('setup.starter.body');
  wrap.append(legend, hint);

  const grid = document.createElement('div');
  grid.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:6px;';
  for (const s of STARTER_ENVELOPES) {
    const row = document.createElement('label');
    row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:6px 8px;border:1px solid var(--border);border-radius:6px;font-size:13.5px;cursor:pointer;';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.style.cssText = 'margin:0;accent-color:var(--accent-ink);cursor:pointer;';
    cb.value = s.key;
    cb.checked = wizardData.starterPicks.has(s.key);
    cb.addEventListener('change', () => {
      if (cb.checked) wizardData.starterPicks.add(s.key);
      else wizardData.starterPicks.delete(s.key);
    });
    const name = document.createElement('span');
    name.style.flex = '1';
    name.textContent = starterName(s.key);
    const cat = document.createElement('span');
    cat.style.cssText = 'color:var(--muted);font-size:12px;';
    cat.textContent = starterCategory(s.category);
    row.append(cb, name, cat);
    grid.append(row);
  }
  wrap.append(grid);
  return wrap;
}

async function doFinish(container, folderHandle) {
  const btn   = document.getElementById('setup-finish');
  const errEl = document.getElementById('setup-finish-error');
  btn.disabled = true;
  btn.textContent = t('setup.saving');
  errEl.style.display = 'none';

  try {
    const now = new Date().toISOString();
    const month = now.slice(0, 7);

    const meta = {
      schemaVersion:              CURRENT_SCHEMA_VERSION,
      name:                       wizardData.name,
      currency:                   wizardData.currency,
      country:                    wizardData.country,
      created_at:                 now,
      last_opened_month:          month,
      emergency_envelope_id:      null,
      emergency_duration_months:  6,
      emergency_credit_source:    'flagged',
      ...(state.meta?.ai ? { ai: state.meta.ai } : {}),
    };
    const aiEnvelopes = (wizardData.aiSuggestedEnvelopes || [])
      .filter((e) => e.name)
      .map((e) => ({
        id: generateId(),
        name: e.name,
        category: e.category || 'Other',
        archived: false,
      }));
    // The starter set is offered only when the AI suggested nothing.
    const starterEnvelopes = !aiEnvelopes.length
      ? buildStarterEnvelopes(wizardData.starterPicks)
      : [];
    const envelopes    = [...aiEnvelopes, ...starterEnvelopes];
    const acct = wizardData.account;
    const accounts = acct.name
      ? [{ id: uniqueId(slugify(acct.name) || 'account', new Set()), name: acct.name, type: acct.type,
        initialBalance: openingBalance(acct) ?? 0 }]
      : [];
    const aiBudgetItems = aiEnvelopes
      .filter((e) => {
        const src = (wizardData.aiSuggestedEnvelopes || []).find((s) => s.name === e.name);
        return Number(src?.monthly_target) > 0;
      })
      .map((e) => {
        const target = Number((wizardData.aiSuggestedEnvelopes || []).find((s) => s.name === e.name)?.monthly_target) || 0;
        const sched = {};
        for (const m of ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']) sched[m] = true;
        return {
          id: generateId(),
          envelope_id: e.id,
          description: '',
          default_amount: target,
          monthly_schedule: sched,
          extra_buffer: 0,
          include: true,
          include_in_emergency_budget: false,
          payment_day: null,
          stress_category: null,
          stress_cut_pct: 0,
        };
      });
    const income = incomePlanItem(wizardData.income, { budgetItems: aiBudgetItems, accounts, envelopes }, appNow());
    const budgetItems = income ? [...aiBudgetItems, income] : aiBudgetItems;
    const transactions = [];
    const envelopeTemplates = [];

    const preflightBundle = { envelopes, budgetItems, transactions, accounts, meta };
    const check = validateSchema(preflightBundle);
    if (!check.ok) {
      const msg = check.errors.slice(0, 10).join('\n  • ');
      const more = check.truncated ? '\n  (more issues omitted)' : '';
      throw new Error(`The new budget has problems:\n\n  • ${msg}${more}`);
    }

    // One publication, meta last: a partial failure must not leave meta on
    // disk, or the next open skips the wizard for a half-saved budget.
    await writeInitialBudget(folderHandle, {
      envelopes, budgetItems, accounts, transactions, envelopeTemplates, meta,
    });

    // Cloud budgets carry a record-level name shown in the picker, separate
    // from meta.name. Sync it to whatever the wizard collected, so the user
    // doesn't have to be prompted for the same name twice.
    if (folderHandle?.kind === 'cloud' && folderHandle.budgetId) {
      try {
        const { renameCloudBudget } = await import('./storage/api-adapter.js');
        await renameCloudBudget(folderHandle.budgetId, wizardData.name);
        folderHandle.name = wizardData.name;
      } catch (err) {
        console.warn('cloud budget rename failed:', err);
      }
    }

    // Another budget was opened while this one was being written: it owns
    // the screen and `state` now.
    if (!(await publishNewBudget(folderHandle))) return;
    try { rebuildPayeeIndex(state); } catch (err) { console.error('rebuildPayeeIndex failed after setup:', err); }
    setFormatDefaults({ currency: state.meta?.currency, locale: state.meta?.locale });
    // Someone setting up their first budget starts in simple mode. Anyone who
    // has picked a mode, or has been through the tour, already knows the app
    // and keeps what they had.
    const prefs = getPrefs();
    if (prefs.uiMode === undefined && !prefs.tourSeen) savePrefs({ uiMode: 'simple' });
    updateStatusBar();
    await navigate('dashboard');
    if (wizardData.importAfter && accounts.length) {
      // The same import the Transactions page opens: a bank CSV, or a PDF or
      // photo read by AI where that is set up. The tour waits for another
      // visit rather than opening on top of it.
      const { openImportSheet } = await import('./import/import-sheet.js');
      openImportSheet(state);
    } else {
      // The load path starts the tour for an empty budget, but setup bypasses
      // it, so a brand-new user used to reach the Overview with no guide.
      maybeAutoStartTour();
    }

  } catch (err) {
    errEl.textContent = err.message;
    errEl.style.display = 'block';
    btn.disabled = false;
    btn.textContent = t('setup.finish');
  }
}

// The session the wizard holds the budget for (js/state/budget-session.js):
// from the load that found no budget until the new one is published, `state`
// is cleared under the new handle, so the browser session refuses writes.
let wizardSession = 0;

/**
 * Read the budget the wizard just wrote into `state`, and end the wizard's
 * hold: from here on the session may write. Publishes nothing, and returns
 * false, when another budget has been opened since the wizard started (its
 * session no longer owns app state). Exported for tests.
 * @param {any} folderHandle
 * @returns {Promise<boolean>}
 */
export async function publishNewBudget(folderHandle) {
  const owned = () => wizardSession !== 0 && currentBudgetSession() === wizardSession;
  if (!owned()) return false;
  const data = await loadBudgetData(folderHandle);
  if (!owned()) return false;
  state.envelopes         = data.envelopes;
  state.budgetItems       = data.budgetItems ?? [];
  state.transactions      = data.transactions;
  state.accounts          = data.accounts;
  state.envelopeTemplates = data.envelopeTemplates ?? [];
  state.meta              = data.meta;
  releaseBudget(wizardSession);
  return true;
}

// ── Public entry point ────────────────────────────────────────────────────────

/**
 * Run the first-run setup wizard.
 * @param {HTMLElement} container - the #app element
 * @param {FileSystemDirectoryHandle|object} folderHandle
 * @param {number} [session] the budget session the loader handed over
 */
export async function runSetupWizard(container, folderHandle, session = currentBudgetSession()) {
  // `session` is the one the loader that found no budget handed over (its
  // result's `session`). If another budget was opened since (the caller
  // awaited this module), that load owns the screen and `state`: no wizard,
  // and no hold over the budget it opened.
  if (session !== currentBudgetSession()) return;
  // The loader kept its hold for the wizard; the wizard releases it when it
  // publishes.
  wizardSession = holdBudget();
  wizardData = emptyWizardData();
  setNoBudgetChrome(true);
  renderStep1(container, folderHandle);
}
