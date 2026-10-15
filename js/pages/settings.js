import { contentTabs } from '../ui/content-tabs.js';
import { appendBackupSettings } from '../ui/backup-settings.js';
// settings.js — In-app settings: budget metadata + info tabs.

import { addPageHelp } from '../ui/info-button.js';
import { state, updateStatusBar, getPrefs, savePrefs, navigate, session, now } from '../app.js';
import { isoDate } from '../core/context.js';
import { setFormatDefaults, escHtml, fmtNum, localeForCurrency, NUMBER_FORMAT_LOCALES, numberFormatExample } from '../utils.js';
import { startTour } from '../ui/tour.js';
import { buildGuidesCard, buildVisualGuideCard } from '../ui/budget-guides.js';
import { t, fmtDateLang, fmtMonthLang, setLang, LOCALES, LOCALE_NAMES } from '../ui/i18n.js';
import { autoCloseAfterMonths } from '../state/closed-periods.js';
import { CURRENCIES, COUNTRIES } from '../core/settings-fields.js';
import { displayName } from '../ui/display-name.js';
import { downloadBlob, sanitiseFilename } from '../ui/download.js';
import { makeCompressedZipBlob } from '../ui/zip.js';
import { restoreMigrationBackup } from '../data.js';
import { buildExportEntries } from '../state/build-export-entries.js';
import { confirmDialog } from '../ui/dialog.js';
import { withBusy } from '../ui/busy.js';
import { updateMeta, StaleBudgetError } from '../state/meta-writes.js';
import { toast } from '../ui/toast.js';
import { describeError } from '../core/errors.js';
import { infoButton } from '../ui/info-button.js';
import { showVersionConflictDialog } from '../ui/save-error.js';
import { renderCleanupTab } from './settings-cleanup.js';
import {
  ensureAiConsent, disableAi, setPerFeatureFlag, setAiModel, defaultPerFeatureFlags,
  listDismissed, restoreItem, clearDismissedFeature,
} from '../ai/consent.js';
import {
  clearAiCache, isRelayFeatureAvailable, isGuestSession,
  aiGetKeyStatus, aiSaveKey, aiDeleteKey, aiTestKey,
} from '../ai/client.js';
import { getLocalKey, setLocalKey, clearLocalKey, maskKey } from '../ai/keystore.js';
import { getUsage, resetUsage, formatCost, formatTokens } from '../ai/usage.js';
import { formatAiText } from '../ai/money-text.js';
import { testDirectKey } from '../ai/transport.js';
import { AI_MODELS, currentModelId } from '../ai/intents.js';
import { renameCloudBudget } from '../storage/api-adapter.js';
import { setNavItemVisible, refreshAiEntryPoints, relabelShell } from '../ui/shell.js';

// ── Constants ─────────────────────────────────────────────────────────────

// Currency and country labels: displayName (js/ui/display-name.js).

// ── Active tab (module state) ─────────────────────────────────────────────

let activeTab = 'budget';

// ── Renderers ─────────────────────────────────────────────────────────────

// Settings used to have one Save button per card (ux-review U24). Saving
// each field on `change` instead is easier to trust and can't lose edits
// left in a field when the user navigates away. Writes go through the
// shared `updateMeta` queue (js/state/meta-writes.js), which every other
// meta writer in the app now also uses, so two quick edits here (or a
// concurrent write from elsewhere) don't race and drop one of them.

/** Status text: saving → saved, or the error. */
function setSaveStatus(el, kind, msg = '') {
  el.textContent = kind === 'saving' ? t('settings.budget.saving')
    : kind === 'saved' ? t('settings.budget.saved')
    : t('settings.budget.error')(msg);
  el.style.color = kind === 'error' ? 'var(--danger)' : kind === 'saved' ? 'var(--success, green)' : 'var(--muted)';
}

/**
 * The small "Saving… / Saved" status for one autosaved field, created lazily
 * right where it is needed (the templates below don't reserve a slot for
 * it). Settings used to share one status line per card; two fields in the
 * same card saving close together could then show the wrong field's
 * outcome, so every autosaved field now gets its own, next to that field —
 * same idea as `.field-hint`, just for save feedback instead of validation.
 */
function fieldStatusEl(input) {
  const host = input.closest('.field')
    || input.closest('.settings-toggle')?.querySelector('.settings-toggle-text')
    || input.parentElement;
  let el = host.querySelector('.field-status');
  if (!el) {
    el = document.createElement('div');
    el.className = 'field-status';
    host.append(el);
  }
  return el;
}

/**
 * Save `input` on change. `patchFor(meta)` returns the next meta (may be
 * async, may throw to reject the save); `revert()` puts the field back to
 * what is saved when the write fails; `after()` runs once the write lands.
 * A stale budget (the user switched budgets mid-write) clears the status
 * and does nothing else: this page is about to be replaced.
 */
function autosaveField(input, patchFor, revert, after) {
  input.addEventListener('change', async () => {
    const statusEl = fieldStatusEl(input);
    setSaveStatus(statusEl, 'saving');
    try {
      await updateMeta(state, patchFor);
      setSaveStatus(statusEl, 'saved');
      after?.();
    } catch (err) {
      if (err instanceof StaleBudgetError) { statusEl.textContent = ''; return; }
      revert();
      setSaveStatus(statusEl, 'error', err.message);
    }
  });
}

/**
 * One command through the session. Resolves `{ ok: true }`, `{ stale: true }`
 * when the budget was switched under the write (this page is about to be
 * replaced), `{ conflict: true }` after opening the reload dialog for a version
 * conflict (as every moved page does), or `{ message }` with the text to show
 * next to the field.
 * @param {string} name
 * @param {Record<string, any>} input
 */
async function dispatchCommand(name, input) {
  let r;
  try {
    r = await session.dispatch(name, input);
  } catch (err) {
    return { message: err?.message || String(err) };
  }
  if (r.ok) return { ok: true };
  if (r.error.code === 'budget_switched') return { stale: true };
  if (r.error.code === 'version_conflict') { showVersionConflictDialog(); return { conflict: true }; }
  return { message: describeError(r.error, t) };
}

/**
 * Save a budget-meaning setting on change through settings.update.
 * `fieldsFor()` returns the command's `fields` (it may throw to reject the
 * save); `revert()` and `after()` are as for autosaveField.
 */
function autosaveSetting(input, fieldsFor, revert, after) {
  input.addEventListener('change', async () => {
    const statusEl = fieldStatusEl(input);
    setSaveStatus(statusEl, 'saving');
    let res;
    try {
      res = await dispatchCommand('settings.update', { fields: fieldsFor() });
    } catch (err) {
      res = { message: err.message };
    }
    if (res.ok) {
      setSaveStatus(statusEl, 'saved');
      after?.();
    } else if (res.stale) {
      statusEl.textContent = '';
    } else if (res.conflict) {
      revert();
      statusEl.textContent = '';
    } else {
      revert();
      setSaveStatus(statusEl, 'error', res.message);
    }
  });
}

function renderBudgetTab(container) {
  const meta = state.meta || {};
  const name = meta.name ?? '';
  const currency = meta.currency ?? 'EUR';
  const locale = meta.locale ?? '';
  const country = meta.country ?? 'FI';
  const emergencyEnvelopeId = meta.emergency_envelope_id ?? '';
  const emergencyDuration = meta.emergency_duration_months ?? 6;
  const emergencyCreditSource = meta.emergency_credit_source === 'all' ? 'all' : 'flagged';
  const showArchivedEnvelopes = !!meta.show_archived_envelopes;
  const showArchivedAccounts = !!meta.show_archived_accounts;
  const autoCloseAfter = [1, 2, 3, 6, 12].includes(Number(meta.auto_close_after_months))
    ? Number(meta.auto_close_after_months) : 0;

  const activeEnvelopes = (state.envelopes || []).filter(e => !e.archived);

  // eslint-disable-next-line no-restricted-syntax -- values are escHtml-wrapped
  container.innerHTML = `
    <div class="card" style="max-width:560px">
      <div class="card-title">
        <h3>${escHtml(t('settings.budget.cardTitle'))}</h3>
      </div>
      <p style="font-size:12px;color:var(--muted);margin:0 0 12px;">${escHtml(t('settings.autosaveHint'))}</p>

      <div class="field">
        <label>${escHtml(t('settings.budget.name'))}</label>
        <input id="settings-name" type="text" value="${escHtml(name)}">
      </div>

      <div class="field">
        <label>${escHtml(t('settings.budget.currency'))}</label>
        <select id="settings-currency">
          ${CURRENCIES.map(([k, lbl]) =>
            `<option value="${k}" ${currency === k ? 'selected' : ''}>${k} — ${escHtml(displayName('currency', k, lbl))}</option>`
          ).join('')}
        </select>
      </div>

      <div class="field">
        <label>${escHtml(t('settings.budget.locale'))}</label>
        <select id="settings-locale">
          <option value="" ${locale ? '' : 'selected'}>${escHtml(t('settings.budget.localeAuto')(numberFormatExample(localeForCurrency(currency))))}</option>
          ${[...NUMBER_FORMAT_LOCALES, ...(locale && !NUMBER_FORMAT_LOCALES.includes(locale) ? [locale] : [])].map(l =>
            `<option value="${escHtml(l)}" ${locale === l ? 'selected' : ''}>${escHtml(numberFormatExample(l))}</option>`
          ).join('')}
        </select>
        <p style="font-size:12px;color:var(--muted);margin:4px 0 0;">${escHtml(t('settings.budget.localeHint'))}</p>
      </div>

      <div class="field">
        <label>${escHtml(t('settings.budget.country'))}</label>
        <select id="settings-country">
          ${COUNTRIES.map(([k, lbl]) =>
            `<option value="${k}" ${country === k ? 'selected' : ''}>${escHtml(displayName('region', k, lbl))}</option>`
          ).join('')}
        </select>
        <p style="font-size:11px;color:var(--muted);margin:4px 0 0;">${escHtml(t('settings.budget.countryHint'))}</p>
      </div>
    </div>

    <div class="card" style="max-width:560px;margin-top:16px;">
      <div class="card-title">
        <h3>${escHtml(t('settings.emergency.cardTitle'))}</h3>
      </div>

      <div class="field">
        <label>${escHtml(t('settings.emergency.envelope'))}</label>
        <select id="settings-emergency-envelope">
          <option value="">${escHtml(t('settings.emergency.envelopeNone'))}</option>
          ${activeEnvelopes.map(e =>
            `<option value="${escHtml(e.id)}" ${emergencyEnvelopeId === e.id ? 'selected' : ''}>${escHtml(e.name)}</option>`
          ).join('')}
        </select>
      </div>

      <div class="field">
        <label>${escHtml(t('settings.emergency.duration'))}</label>
        <input id="settings-emergency-duration" type="number" min="1" max="120"
               value="${emergencyDuration}" style="width:100px;">
      </div>

      <div class="field">
        <label>${escHtml(t('envelopes.emergencyCreditSourceLabel'))}</label>
        <select id="settings-emergency-credit-source">
          <option value="flagged" ${emergencyCreditSource === 'flagged' ? 'selected' : ''}>${escHtml(t('envelopes.emergencyCreditSourceFlagged'))}</option>
          <option value="all" ${emergencyCreditSource === 'all' ? 'selected' : ''}>${escHtml(t('envelopes.emergencyCreditSourceAll'))}</option>
        </select>
        <p style="font-size:11px;color:var(--muted);margin:6px 0 0;">
          ${escHtml(t('envelopes.emergencyCreditSourceHint'))}
        </p>
      </div>

      <p style="font-size:12px;color:var(--muted);margin:8px 0 0;">
        ${escHtml(t('settings.emergency.hint'))}
      </p>
    </div>

    <div class="card" style="max-width:560px;margin-top:16px;">
      <div class="card-title">
        <h3>${escHtml(t('settings.closing.cardTitle'))}</h3>
      </div>

      <div class="field">
        <label for="settings-auto-close">${escHtml(t('settings.closing.autoClose'))}</label>
        <select id="settings-auto-close">
          <option value="0" ${autoCloseAfter === 0 ? 'selected' : ''}>${escHtml(t('settings.closing.off'))}</option>
          ${[1, 2, 3, 6, 12].map(n =>
            `<option value="${n}" ${autoCloseAfter === n ? 'selected' : ''}>${escHtml(t('settings.closing.after')(n))}</option>`
          ).join('')}
        </select>
        <p style="font-size:11px;color:var(--muted);margin:4px 0 0;">${escHtml(t('settings.closing.hint'))}</p>
      </div>
      <div id="settings-reopened-months"></div>
    </div>

    <div class="card" style="max-width:560px;margin-top:16px;">
      <div class="card-title">
        <h3>${escHtml(t('settings.display.cardTitle'))}</h3>
      </div>

      <label class="settings-toggle" for="settings-show-archived-envelopes">
        <span class="settings-toggle-text">
          <span class="settings-toggle-label">${escHtml(t('settings.display.showArchivedEnv'))}</span>
          <span class="settings-toggle-hint">${escHtml(t('settings.display.showArchivedEnvHint'))}</span>
        </span>
        <span class="bp-switch">
          <input id="settings-show-archived-envelopes" type="checkbox" ${showArchivedEnvelopes ? 'checked' : ''}>
          <span class="bp-switch-track"></span>
        </span>
      </label>

      <label class="settings-toggle" for="settings-show-archived-accounts">
        <span class="settings-toggle-text">
          <span class="settings-toggle-label">${escHtml(t('settings.display.showArchivedAcct'))}</span>
          <span class="settings-toggle-hint">${escHtml(t('settings.display.showArchivedAcctHint'))}</span>
        </span>
        <span class="bp-switch">
          <input id="settings-show-archived-accounts" type="checkbox" ${showArchivedAccounts ? 'checked' : ''}>
          <span class="bp-switch-track"></span>
        </span>
      </label>
    </div>

  `;

  const nameIn = container.querySelector('#settings-name');
  // Cloud: rename the DB row inside the patch, before the meta write, so a
  // meta-write failure aborts before the two stores diverge (budgets.name
  // vs meta.name in the encrypted blob). If the rename lands but the meta
  // write then fails — including a StaleBudgetError, since the DB row was
  // still renamed under the old budget — undo the rename first, using the
  // folder/name captured at the start of this handler (not state.budgetFolder,
  // which may already point at the new budget by the time the catch runs).
  nameIn.addEventListener('change', async () => {
    const folder = state.budgetFolder;
    const prevFolderName = folder?.name;
    let renamedCloud = false;
    const statusEl = fieldStatusEl(nameIn);
    setSaveStatus(statusEl, 'saving');
    try {
      await updateMeta(state, async (m) => {
        const name = nameIn.value.trim() || (m.name ?? t('settings.defaultBudgetName'));
        if (folder && folder.kind === 'cloud' && folder.budgetId && name !== folder.name) {
          await renameCloudBudget(folder.budgetId, name);
          folder.name = name;
          renamedCloud = true;
        }
        return { ...m, name };
      });
      setSaveStatus(statusEl, 'saved');
    } catch (err) {
      // The DB row was renamed but the meta write failed (for any reason,
      // stale budget included): put the DB name back so the picker
      // (budgets.name) and meta.name do not diverge.
      if (renamedCloud) {
        try { await renameCloudBudget(folder.budgetId, prevFolderName); folder.name = prevFolderName; }
        catch (undoErr) { console.error('settings: could not undo cloud rename:', undoErr); }
      }
      if (err instanceof StaleBudgetError) { statusEl.textContent = ''; return; }
      nameIn.value = state.meta?.name ?? '';
      setSaveStatus(statusEl, 'error', err.message);
    }
  });

  const curSel = container.querySelector('#settings-currency');
  curSel.addEventListener('change', async () => {
    const oldCurrency = state.meta?.currency ?? 'EUR';
    const newCurrency = curSel.value;
    if (newCurrency === oldCurrency) return;
    const ok = await confirmDialog(t('settings.budget.currencyConfirm')(oldCurrency, newCurrency), {
      title: t('settings.budget.currencyConfirmTitle'),
      okLabel: t('settings.budget.currencyConfirmOk')(newCurrency),
      cancelLabel: t('settings.budget.cancel'),
      danger: true,
    });
    if (!ok) { curSel.value = oldCurrency; return; }
    const statusEl = fieldStatusEl(curSel);
    setSaveStatus(statusEl, 'saving');
    const res = await dispatchCommand('settings.update', { fields: { currency: newCurrency } });
    if (res.ok) {
      setFormatDefaults({ currency: state.meta.currency, locale: state.meta.locale });
      // The automatic number format follows the currency; show its new example.
      const autoOpt = container.querySelector('#settings-locale option[value=""]');
      if (autoOpt) autoOpt.textContent = t('settings.budget.localeAuto')(numberFormatExample(localeForCurrency(newCurrency)));
      updateStatusBar();
      setSaveStatus(statusEl, 'saved');
    } else if (res.stale) {
      statusEl.textContent = '';
    } else if (res.conflict) {
      curSel.value = oldCurrency;
      statusEl.textContent = '';
    } else {
      curSel.value = oldCurrency;
      setSaveStatus(statusEl, 'error', res.message);
    }
  });

  const localeIn = container.querySelector('#settings-locale');
  autosaveSetting(localeIn, () => ({ locale: localeIn.value || null }),
    () => { localeIn.value = state.meta?.locale ?? ''; }, () => {
      setFormatDefaults({ currency: state.meta.currency, locale: state.meta.locale });
      updateStatusBar();
    });

  const countrySel = container.querySelector('#settings-country');
  autosaveSetting(countrySel, () => ({ country: countrySel.value || null }),
    () => { countrySel.value = state.meta?.country ?? 'FI'; });

  const envSel = container.querySelector('#settings-emergency-envelope');
  envSel.closest('.card').querySelector('h3').append(infoButton('emergencyRunway'));
  autosaveSetting(envSel, () => ({ emergency_envelope_id: envSel.value || null }),
    () => { envSel.value = state.meta?.emergency_envelope_id ?? ''; });

  const durIn = container.querySelector('#settings-emergency-duration');
  autosaveSetting(durIn, () => {
    const d = parseInt(durIn.value, 10);
    if (!Number.isFinite(d) || d < 1 || d > 120) throw new Error(t('settings.emergency.durationInvalid'));
    return { emergency_duration_months: d };
  }, () => { durIn.value = String(state.meta?.emergency_duration_months ?? 6); });

  const srcSel = container.querySelector('#settings-emergency-credit-source');
  autosaveSetting(srcSel,
    () => ({ emergency_credit_source: srcSel.value === 'all' ? 'all' : 'flagged' }),
    () => { srcSel.value = state.meta?.emergency_credit_source === 'all' ? 'all' : 'flagged'; });

  // Closing months automatically (js/state/closed-periods.js). Off sends null,
  // which removes the key rather than storing 0, so a budget that never used it
  // stays as it was.
  const autoCloseSel = container.querySelector('#settings-auto-close');
  autosaveSetting(autoCloseSel, () => {
    const n = Number(autoCloseSel.value);
    return { auto_close_after_months: n > 0 ? n : null };
  }, () => { autoCloseSel.value = String(state.meta?.auto_close_after_months || 0); }, () => paintReopened());

  // Months reopened past the automatic rule, each with a way back. Only shown
  // while the rule is on: without it the exceptions change nothing.
  const reopenedHost = container.querySelector('#settings-reopened-months');
  function paintReopened() {
    reopenedHost.replaceChildren();
    const months = (Array.isArray(state.meta?.reopened_months) ? state.meta.reopened_months : [])
      .filter(m => typeof m === 'string');
    if (!autoCloseAfterMonths(state.meta) || !months.length) return;
    const field = document.createElement('div');
    field.className = 'field';
    const label = document.createElement('label');
    label.textContent = t('settings.closing.reopenedLabel');
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;';
    for (const ym of months) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn btn-ghost btn-sm';
      btn.dataset.month = ym;
      btn.textContent = t('settings.closing.closeAgain')(fmtMonthLang(ym));
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        const res = await dispatchCommand('month.clearReopen', { month: ym });
        if (res.ok) { paintReopened(); return; }
        btn.disabled = false;
        if (res.stale || res.conflict) return;
        toast(t('settings.budget.error')(res.message));
      });
      row.append(btn);
    }
    field.append(label, row);
    reopenedHost.append(field);
  }
  paintReopened();

  for (const [id, key] of [['#settings-show-archived-envelopes', 'show_archived_envelopes'],
                           ['#settings-show-archived-accounts', 'show_archived_accounts']]) {
    const box = container.querySelector(id);
    autosaveField(box, (m) => ({ ...m, [key]: box.checked }),
      () => { box.checked = !!state.meta?.[key]; });
  }

  // Language lived only in the Tweaks popover (ux-review U24). It is a
  // personal preference, not budget data, so it applies at once: no Save.
  const displayCard = container.querySelector('#settings-show-archived-envelopes')?.closest('.card');
  if (displayCard) displayCard.before(buildLanguageCard());
}

const CONCEPT_KEYS = [
  'envelopes', 'unallocated', 'accountBalances', 'envelopeFigures',
  'txTypes', 'reconciling', 'emergencyRunway',
];

function mountConceptsCard(slot) {
  if (!slot) return;
  const card = document.createElement('div');
  card.className = 'card';
  card.style.cssText = 'max-width:560px;margin-top:16px;';

  const head = document.createElement('div');
  head.className = 'card-title';
  head.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:12px;';
  const title = document.createElement('h3');
  title.textContent = t('settings.concepts.title');
  const replay = document.createElement('button');
  replay.type = 'button';
  replay.className = 'btn btn-ghost btn-sm';
  replay.textContent = t('settings.concepts.replayLink');
  replay.addEventListener('click', () => startTour());
  head.append(title, replay);
  card.append(head);

  const intro = document.createElement('p');
  intro.style.cssText = 'font-size:12px;color:var(--muted);margin:0 0 12px;';
  intro.textContent = t('settings.concepts.intro');
  card.append(intro);

  const list = document.createElement('div');
  list.style.cssText = 'display:flex;flex-direction:column;';
  for (const key of CONCEPT_KEYS) {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:flex-start;gap:8px;padding:10px 0;border-top:1px solid var(--border);';
    const text = document.createElement('div');
    text.style.cssText = 'flex:1;min-width:0;';
    const name = document.createElement('div');
    name.style.cssText = 'font-weight:600;font-size:14px;color:var(--ink);';
    name.textContent = t(`help.${key}.title`);
    const oneLiner = document.createElement('div');
    oneLiner.style.cssText = 'font-size:12.5px;color:var(--muted);margin-top:2px;line-height:1.4;';
    oneLiner.textContent = firstSentence(t(`help.${key}.body`));
    text.append(name, oneLiner);
    row.append(text, infoButton(key));
    list.append(row);
  }
  card.append(list);

  slot.replaceWith(card);
}

function firstSentence(body) {
  const s = String(body || '').split(/\n{2,}/)[0] || '';
  const m = s.match(/^[^.!?]+[.!?]/);
  return (m ? m[0] : s).trim();
}

function renderHelpTab(container) {
  container.replaceChildren();
  const slot = document.createElement('div');
  container.append(buildVisualGuideCard(), buildGuidesCard(), slot);
  mountConceptsCard(slot);
}

function renderInfoTab(container) {
  const meta = state.meta || {};
  // Counts include archived records, which every other page hides, so say
  // how many — otherwise 51 here reads as a contradiction of 38 on Envelopes.
  const countWithArchived = (list) => {
    const all = list?.length ?? 0;
    const archived = (list || []).filter(x => x?.archived).length;
    return archived ? t('settings.info.withArchived')(fmtNum(all), fmtNum(archived)) : fmtNum(all);
  };
  const envCount = countWithArchived(state.envelopes);
  const txCount  = fmtNum(state.transactions?.length ?? 0);
  const acctCount = countWithArchived(state.accounts);
  const tplCount = fmtNum(state.envelopeTemplates?.length ?? 0);

  const row = (label, value) => `
    <div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--border)">
      <span style="color:var(--muted)">${label}</span>
      <span style="font-family:monospace">${escHtml(value)}</span>
    </div>
  `;

  // eslint-disable-next-line no-restricted-syntax -- values are escHtml-wrapped
  container.innerHTML = `
    <div class="card" style="max-width:560px">
      <div class="card-title"><h3>${escHtml(t('settings.info.cardTitle'))}</h3></div>
      ${row(escHtml(t('settings.info.schemaVersion')), String(meta.schemaVersion ?? '—'))}
      ${row(escHtml(t('settings.info.created')), meta.created_at ? fmtDateLang(meta.created_at) : '—')}
      ${row(escHtml(t('settings.info.envelopes')), String(envCount))}
      ${row(escHtml(t('settings.info.transactions')), String(txCount))}
      ${row(escHtml(t('settings.info.accounts')), String(acctCount))}
      ${row(escHtml(t('settings.info.templates')), String(tplCount))}
    </div>

  `;
  // "Replay tour" lives on the Help tab (and the sidebar's Help button); a
  // third copy here only made Info look like a second Help (ux-review U24).
}

function buildLanguageCard() {
  const card = document.createElement('div');
  card.className = 'card';
  card.style.cssText = 'max-width:560px;margin-top:16px;';
  const title = document.createElement('div');
  title.className = 'card-title';
  const h3 = document.createElement('h3');
  h3.textContent = t('settings.language.cardTitle');
  title.append(h3);
  const field = document.createElement('div');
  field.className = 'field';
  const lbl = document.createElement('label');
  lbl.htmlFor = 'settings-language';
  lbl.textContent = t('settings.language.label');
  const sel = document.createElement('select');
  sel.id = 'settings-language';
  for (const code of LOCALES) {
    const o = document.createElement('option');
    o.value = code;
    o.textContent = LOCALE_NAMES[code];
    if (code === getPrefs().lang) o.selected = true;
    sel.append(o);
  }
  sel.addEventListener('change', () => {
    savePrefs({ lang: sel.value });
    setLang(sel.value);
    relabelShell();
    navigate('settings');
  });
  const hint = document.createElement('p');
  hint.style.cssText = 'font-size:12px;color:var(--muted);margin:6px 0 0;';
  hint.textContent = t(isCloudMode() && !isGuestSession() ? 'settings.language.hint' : 'settings.language.localHint');
  field.append(lbl, sel, hint);
  card.append(title, field);
  return card;
}

function isCloudMode() {
  return !!(typeof window !== 'undefined'
    && window.__BUNVELOPE_MODE
    && window.__BUNVELOPE_MODE.kind === 'cloud');
}

function appendDataCard(container) {
  const card = document.createElement('div');
  card.className = 'card';
  card.style.maxWidth = '560px';

  const titleWrap = document.createElement('div');
  titleWrap.className = 'card-title';
  const h3 = document.createElement('h3');
  h3.textContent = t('settings.data.title');
  titleWrap.append(h3);
  card.append(titleWrap);

  const desc = document.createElement('p');
  desc.style.cssText = 'font-size:12px;color:var(--muted);margin:4px 0 12px;';
  desc.textContent = t('settings.data.description');
  card.append(desc);

  const usage = document.createElement('div');
  usage.id = 'settings-storage-size';
  usage.className = 'sub';
  const compactBtn = document.createElement('button');
  compactBtn.id = 'settings-compact-history';
  compactBtn.className = 'btn btn-ghost btn-sm';
  compactBtn.textContent = t('settings.storage.compact');
  const refreshUsage = () => {
    const result = session.query('storage.size', {});
    if (!result.ok) return;
    const size = result.value;
    const mb = n => `${fmtNum(n / 1000000, { decimals: 2 })} MB`;
    usage.replaceChildren();
    for (const [label, value] of [
      ['total', mb(size.totalBytes)], ['data', mb(size.dataBytes)],
      ['history', mb(size.historyBytes)], ['revisions', String(size.revisions)],
      ['savings', mb(size.reclaimableBytes)],
    ]) {
      const line = document.createElement('p');
      line.textContent = `${t(`settings.storage.${label}`)}: ${value}`;
      usage.append(line);
    }
    compactBtn.disabled = size.reclaimableBytes === 0;
  };
  refreshUsage();
  const usageHelp = document.createElement('p');
  usageHelp.className = 'sub';
  usageHelp.textContent = t('settings.storage.help');
  compactBtn.addEventListener('click', async () => {
    compactBtn.disabled = true;
    try {
      const result = await session.dispatch('history.compact', {});
      if (!result.ok) throw new Error(describeError(result.error, t));
      toast(t('settings.storage.compacted'));
    } catch (err) { toast(err.message, 'error'); }
    finally { refreshUsage(); }
  });
  card.append(usage, usageHelp, compactBtn);

  const row = document.createElement('div');
  row.style.cssText = 'display:flex;justify-content:flex-end;gap:8px;margin-top:4px;align-items:center';
  const statusEl = document.createElement('span');
  statusEl.id = 'settings-data-status';
  statusEl.style.cssText = 'font-size:12px;color:var(--muted)';
  const exportBtn = document.createElement('button');
  exportBtn.id = 'settings-export-zip';
  exportBtn.className = 'btn btn-accent';
  exportBtn.textContent = t('settings.data.exportButton');
  exportBtn.addEventListener('click', async () => {
    exportBtn.disabled = true;
    statusEl.textContent = t('settings.export.exporting');
    statusEl.style.color = 'var(--muted)';
    try {
      const entries = buildExportEntries(state);
      const blob = await makeCompressedZipBlob(entries);
      const today = isoDate(now());
      const safeName = sanitiseFilename(state.meta?.name || 'budget');
      downloadBlob(`bunvelope-${safeName}-${today}.zip`, blob);
      statusEl.textContent = t('settings.export.exported');
      statusEl.style.color = 'var(--success, green)';
    } catch (err) {
      statusEl.textContent = t('settings.export.failed')(err.message);
      statusEl.style.color = 'var(--danger)';
    } finally {
      exportBtn.disabled = false;
    }
  });
  row.append(statusEl, exportBtn);
  card.append(row);

  if (typeof window.showDirectoryPicker === 'function') {
    const help = document.createElement('p');
    help.className = 'sub';
    help.style.cssText = 'margin:16px 0 12px;color:var(--muted);font-size:13px;line-height:1.5';
    help.textContent = t(isCloudMode() ? 'automaticBackup.cloudRestoreHelp' : 'automaticBackup.restoreHelp');
    const select = document.createElement('button');
    select.className = 'btn btn-ghost';
    select.textContent = t('automaticBackup.selectRestore');
    const restore = document.createElement('button');
    restore.className = 'btn btn-ghost';
    restore.textContent = t('migrationBackup.restore');
    restore.disabled = true;
    let backup = null;
    select.addEventListener('click', async () => {
      try {
        backup = await window.showDirectoryPicker({ mode: 'read' });
        restore.disabled = false;
        statusEl.textContent = backup.name;
      } catch (error) { if (error.name !== 'AbortError') statusEl.textContent = t('settings.export.failed')(error.message); }
    });
    restore.addEventListener('click', async () => {
      select.disabled = restore.disabled = true;
      try {
        const destination = await window.showDirectoryPicker({ mode: 'readwrite' });
        await restoreMigrationBackup(backup, destination);
        statusEl.textContent = t('migrationBackup.done');
      } catch (error) { if (error.name !== 'AbortError') statusEl.textContent = t('settings.export.failed')(error.message); }
      finally { select.disabled = false; restore.disabled = !backup; }
    });
    const actions = document.createElement('div');
    actions.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px';
    actions.append(select, restore);
    card.append(help, actions);
  }

  container.append(card);
}

function renderDataSecurityTab(container) {
  container.innerHTML = '';
  appendDataCard(container);
  appendBackupSettings(container, state.budgetFolder);

  const card = document.createElement('div');
  card.className = 'card';
  card.style.maxWidth = '560px';
  card.style.marginTop = '16px';
  container.append(card);

  const titleWrap = document.createElement('div');
  titleWrap.className = 'card-title';
  const h3 = document.createElement('h3');
  h3.textContent = t('security.tab.title');
  titleWrap.append(h3);
  card.append(titleWrap);

  if (!isCloudMode() || isGuestSession()) {
    const p = document.createElement('p');
    p.style.cssText = 'color:var(--muted);margin:0;';
    p.textContent = t(isCloudMode() ? 'security.tab.guestOnly' : 'security.tab.cloudOnly');
    card.append(p);
    return;
  }

  const stateLine = document.createElement('p');
  stateLine.style.cssText = 'font-size:14px;margin:0 0 6px;';
  const desc = document.createElement('p');
  desc.style.cssText = 'color:var(--muted);font-size:13px;margin:0 0 16px;line-height:1.5;';
  desc.textContent = t('security.tab.description');
  const actions = document.createElement('div');
  actions.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;';
  const status = document.createElement('div');
  status.style.cssText = 'margin-top:10px;font-size:12px;color:var(--muted);min-height:16px;';
  card.append(stateLine, desc, actions, status);

  (async () => {
    const api = await import('../storage/api-adapter.js');
    const crypto = await import('../storage/crypto.js');
    const { convertBudgetEncryption } = await import('../storage/encryption-config.js');
    const progress = (index, total, name) => { status.textContent = `${index + 1} / ${total}: ${name}`; };
    const prompts = await import('../ui/passphrase-prompt.js');
    const { confirmDialog, alertDialog } = await import('../ui/dialog.js');

    async function refresh() {
      const cfg = await api.getEncryptionConfig();
      actions.innerHTML = '';
      if (cfg?.enabled) {
        stateLine.textContent = t(cfg.incomplete ? 'security.tab.incomplete' : 'security.tab.enabled');
        if (cfg.incomplete) {
          const resumeBtn = document.createElement('button');
          resumeBtn.className = 'btn btn-accent';
          resumeBtn.textContent = t('security.tab.resume');
          resumeBtn.addEventListener('click', async () => {
            const pass = await prompts.promptUnlock();
            if (pass == null) return;
            try {
              const { unlockDataKey } = await import('../storage/encryption-config.js');
              const key = await unlockDataKey(cfg, pass);
              if (!key) {
                await alertDialog(t('security.err.wrongPassphrase'));
                return;
              }
              await api.flushWrites();
              api.setEncryptionKey(key, cfg.verifier.keyId || cfg.salt);
              api.setEncryptionRequired(true);
              resumeBtn.disabled = true;
              await convertBudgetEncryption(api, key, progress);
              window.location.reload();
            } catch (err) {
              console.error(err);
              await alertDialog(t('security.err.enablePartial'));
              window.location.reload();
            }
          });
          actions.append(resumeBtn);
        }
        const changeBtn = document.createElement('button');
        changeBtn.className = 'btn';
        changeBtn.textContent = t('security.tab.change');
        changeBtn.addEventListener('click', async () => {
          const answer = await prompts.promptChange();
          if (!answer) return;
          const { preparePassphraseChange } = await import('../storage/encryption-config.js');
          changeBtn.disabled = true;
          try {
            await api.flushWrites();
            const next = await preparePassphraseChange(cfg, answer.oldPassphrase, answer.newPassphrase);
            await api.putEncryptionConfig(next, cfg);
            status.textContent = t('security.status.done');
          } catch (err) {
            console.error(err);
            status.textContent = t('security.err.failed');
            // A lost response can mean either config committed. Both protect the
            // same data key; never claim a rollback we cannot confirm.
            await alertDialog(t('security.err.changeUncertain'));
          } finally {
            changeBtn.disabled = false;
            await refresh();
          }
        });
        const disableBtn = document.createElement('button');
        disableBtn.className = 'btn';
        disableBtn.style.background = 'var(--danger-fill)';
        disableBtn.style.color = '#fff';
        disableBtn.textContent = t('security.tab.disable');
        disableBtn.addEventListener('click', async () => {
          const ok = await confirmDialog(t('security.disable.confirm'), {
            title: t('security.disable.title'),
            danger: true,
            okLabel: t('security.tab.disable'),
          });
          if (!ok) return;
          const pass = await prompts.promptUnlock();
          if (pass == null) return;
          const { unlockDataKey } = await import('../storage/encryption-config.js');
          const oldKey = await unlockDataKey(cfg, pass);
          if (!oldKey) {
            await alertDialog(t('security.err.wrongPassphrase'));
            return;
          }
          api.setEncryptionKey(oldKey, cfg.verifier.keyId || cfg.salt);
          api.setEncryptionRequired(true);
          try {
            status.textContent = t('security.status.decrypting');
            // Config LAST here, and deliberately so: the old key must stay
            // named for as long as any blob is still encrypted. Writing
            // `enabled: false` first would stop sign-in prompting while
            // encrypted budgets remained — the same lockout as a mis-ordered
            // Enable, in the other direction.
            await convertBudgetEncryption(api, null, progress);
            await api.putEncryptionConfig({ enabled: false }, cfg);
            api.setEncryptionKey(null);
            api.setEncryptionRequired(false);
            status.textContent = t('security.status.done');
            window.location.reload();
          } catch (err) {
            console.error(err);
            status.textContent = t('security.err.failed');
            // Partial run is safe: the config still names the old passphrase,
            // so anything still encrypted opens and re-running Disable
            // finishes the job.
            await alertDialog(t('security.err.disablePartial'));
            window.location.reload();
          }
        });
        actions.append(changeBtn, disableBtn);
      } else {
        stateLine.textContent = t('security.tab.disabled');
        const enableBtn = document.createElement('button');
        enableBtn.className = 'btn btn-accent';
        enableBtn.textContent = t('security.tab.enable');
        enableBtn.addEventListener('click', async () => {
          const pass = await prompts.promptSetup();
          if (pass == null) return;
          const salt = crypto.randomBytes(16);
          const key = await crypto.deriveKey(pass, salt);
          const verifier = await crypto.buildVerifier(key);
          verifier.keyId = crypto.bytesToBase64(salt);
          try {
            // Persist config before the first budget is encrypted.
            // Nothing is encrypted yet, so naming this key early costs
            // nothing; doing it last is a permanent lockout if the re-encrypt
            // loop then fails, because sign-in would never prompt for the
            // passphrase that the already-encrypted blobs need.
            await api.flushWrites();
            api.setEncryptionKey(key, verifier.keyId);
            api.setEncryptionRequired(true);
            await api.putEncryptionConfig({
              enabled: true,
              salt: crypto.bytesToBase64(salt),
              verifier,
            }, cfg);
            status.textContent = t('security.status.encrypting');
            await convertBudgetEncryption(api, key, progress);
            status.textContent = t('security.status.done');
            window.location.reload();
          } catch (err) {
            console.error(err);
            status.textContent = t('security.err.failed');
            // A partial run is safe and resumable: the config already names
            // this passphrase if committed. Reload discovers the authoritative
            // config and exposes Finish encryption for remaining plaintext.
            await alertDialog(t('security.err.enablePartial'));
            window.location.reload();
          }
        });
        actions.append(enableBtn);
      }
    }

    refresh().catch((err) => {
      console.error('load encryption config failed:', err);
      status.textContent = t('security.err.failed');
    });
  })();

  if (window.__BUNVELOPE_MODE?.bypassGoogle === true) {
    container.append(buildBypassPasswordCard());
  }
}

function buildBypassPasswordCard() {
  const card = document.createElement('div');
  card.className = 'card';
  card.style.maxWidth = '560px';
  card.style.marginTop = '16px';

  const titleWrap = document.createElement('div');
  titleWrap.className = 'card-title';
  const h3 = document.createElement('h3');
  h3.textContent = t('settings.bypassPassword.title');
  titleWrap.append(h3);
  card.append(titleWrap);

  const desc = document.createElement('p');
  desc.style.cssText = 'color:var(--muted);font-size:13px;margin:0 0 16px;line-height:1.5;';
  desc.textContent = t('settings.bypassPassword.description');
  card.append(desc);

  const btn = document.createElement('button');
  btn.className = 'btn';
  btn.textContent = t('settings.bypassPassword.changeButton');
  btn.addEventListener('click', () => openBypassPasswordDialog());
  card.append(btn);
  return card;
}

async function openBypassPasswordDialog() {
  const { openSheet } = await import('../ui/sheet.js');

  const content = document.createElement('div');
  content.style.cssText = 'display:flex;flex-direction:column;gap:12px;';

  const lede = document.createElement('p');
  lede.style.cssText = 'color:var(--muted);margin:0 0 4px;line-height:1.5;font-size:13px;';
  lede.textContent = t('settings.bypassPassword.dialogLede');
  content.append(lede);

  const currentInput = document.createElement('input');
  currentInput.type = 'password';
  currentInput.className = 'form-input';
  currentInput.required = true;
  currentInput.autocomplete = 'current-password';
  currentInput.placeholder = t('settings.bypassPassword.currentPlaceholder');
  content.append(currentInput);

  const newInput = document.createElement('input');
  newInput.type = 'password';
  newInput.className = 'form-input';
  newInput.required = true;
  newInput.autocomplete = 'new-password';
  newInput.minLength = 16;
  newInput.placeholder = t('auth.newPasswordPlaceholder');
  content.append(newInput);

  const confirmInput = document.createElement('input');
  confirmInput.type = 'password';
  confirmInput.className = 'form-input';
  confirmInput.required = true;
  confirmInput.autocomplete = 'new-password';
  confirmInput.minLength = 16;
  confirmInput.placeholder = t('auth.confirmPasswordPlaceholder');
  content.append(confirmInput);

  const errEl = document.createElement('p');
  errEl.style.cssText = 'color:var(--danger-text);font-size:13px;margin:0;display:none;';
  content.append(errEl);

  const actions = document.createElement('div');
  actions.dataset.sheetActions = '';
  actions.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;margin-top:8px;';
  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'btn';
  cancelBtn.textContent = t('common.cancel');
  const submitBtn = document.createElement('button');
  submitBtn.type = 'button';
  submitBtn.className = 'btn btn-accent';
  submitBtn.textContent = t('auth.changePasswordSubmit');
  actions.append(cancelBtn, submitBtn);
  content.append(actions);

  const sheet = openSheet({
    title: t('settings.bypassPassword.dialogTitle'),
    content,
  });

  cancelBtn.addEventListener('click', () => sheet.close());

  function showError(msg) {
    errEl.textContent = msg;
    errEl.style.display = 'block';
  }

  submitBtn.addEventListener('click', async () => {
    errEl.style.display = 'none';
    if (newInput.value.length < 16) {
      showError(t('auth.changePasswordTooShort'));
      newInput.focus();
      return;
    }
    if (newInput.value !== confirmInput.value) {
      showError(t('auth.changePasswordMismatch'));
      confirmInput.focus();
      return;
    }
    try {
      await withBusy(submitBtn, async () => {
        const resp = await fetch('/auth/password/change', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ current: currentInput.value, new: newInput.value }),
        });
        if (resp.ok) {
          sheet.close();
          toast(t('settings.bypassPassword.success'));
          return;
        }
        const data = await resp.json().catch(() => ({}));
        if (resp.status === 429) {
          showError(t('auth.bypassRateLimited'));
        } else if (resp.status === 401) {
          showError(t('settings.bypassPassword.wrongCurrent'));
        } else if (data?.error === 'password_too_short') {
          showError(t('auth.changePasswordTooShort'));
        } else {
          showError(t('auth.changePasswordFailed'));
        }
      });
    } catch (err) {
      console.error('bypass password change failed:', err);
      showError(t('auth.changePasswordFailed'));
    }
  });

  setTimeout(() => currentInput.focus(), 0);
}

function renderTab(bodyEl) {
  bodyEl.innerHTML = '';
  if (activeTab === 'budget')        renderBudgetTab(bodyEl);
  else if (activeTab === 'cleanup')  renderCleanupTab(bodyEl);
  else if (activeTab === 'help')     renderHelpTab(bodyEl);
  else if (activeTab === 'info')     renderInfoTab(bodyEl);
  else if (activeTab === 'ai')       renderAiTab(bodyEl);
  else if (activeTab === 'security') renderDataSecurityTab(bodyEl);
}

// ── AI tab ────────────────────────────────────────────────────────────────

const AI_FEATURES_LIST = [
  ['monthlyBriefing', 'ai.briefing.title'],
  ['anomaly',         'ai.anomaly.title'],
  ['envelopeHealth',  'ai.health.title'],
  ['subscription',    'ai.subs.title'],
  ['search',          'ai.search.button'],
  ['whatif',          'ai.whatif.title'],
  ['reconcile',       'ai.reconcile.title'],
  ['onboarding',      'ai.onboarding.title'],
];

function renderAiTab(container) {
  container.replaceChildren();
  const ai = state.meta?.ai || {};
  const enabled = !!ai.enabled;
  const cloud = isCloudMode();

  // Card 1: enable toggle.
  const card1 = document.createElement('div');
  card1.className = 'card';
  card1.style.maxWidth = '560px';
  const head1 = document.createElement('div');
  head1.className = 'card-title';
  const h1 = document.createElement('h3');
  h1.textContent = t('ai.settings.tab');
  head1.append(h1);
  card1.append(head1);

  // A cloud guest has no authenticated session, so the relay would 401 —
  // there is nothing they can usefully configure here. A static guest is a
  // different case: their key would go in this browser like anyone else's.
  if (cloud && isGuestSession()) {
    const note = document.createElement('p');
    note.style.cssText = 'color:var(--muted);margin:0;';
    note.textContent = t('ai.settings.requiresAccount');
    card1.append(note);
    container.append(card1);
    return;
  }

  const row = document.createElement('label');
  row.className = 'settings-toggle';
  const rowText = document.createElement('span');
  rowText.className = 'settings-toggle-text';
  const lbl = document.createElement('span');
  lbl.className = 'settings-toggle-label';
  lbl.textContent = t('ai.settings.enable');
  const hint = document.createElement('span');
  hint.className = 'settings-toggle-hint';
  hint.textContent = enabled ? t('ai.settings.enabled') : t('ai.settings.disabled');
  rowText.append(lbl, hint);
  const sw = document.createElement('span');
  sw.className = 'bp-switch';
  const tog = document.createElement('input');
  tog.type = 'checkbox';
  tog.checked = enabled;
  const swTrack = document.createElement('span');
  swTrack.className = 'bp-switch-track';
  sw.append(tog, swTrack);
  row.append(rowText, sw);
  card1.append(row);

  tog.addEventListener('change', async () => {
    try {
      if (tog.checked) {
        const ok = await ensureAiConsent();
        if (!ok) { tog.checked = false; return; }
      } else {
        await disableAi();
      }
      setNavItemVisible('insights', isRelayFeatureAvailable());
      refreshAiEntryPoints();
      renderAiTab(container);
    } catch (err) {
      console.error(err);
      tog.checked = !tog.checked;
    }
  });
  container.append(card1);

  // Card 1.5: the API key. Cloud mode stores it server-side, encrypted;
  // static mode has no server and must keep it in this browser instead.
  // Two genuinely different postures, so two different cards — presenting
  // them identically would misrepresent where the key lives.
  const keyCard = document.createElement('div');
  keyCard.className = 'card';
  keyCard.style.cssText = 'max-width:560px;margin-top:16px;';
  container.append(keyCard);
  if (cloud) renderApiKeyCard(keyCard, () => renderAiTab(container));
  else renderLocalKeyCard(keyCard, () => renderAiTab(container));

  // Card 1.6: what this session has spent against that key.
  const usageCard = document.createElement('div');
  usageCard.className = 'card';
  usageCard.style.cssText = 'max-width:560px;margin-top:16px;';
  container.append(usageCard);
  renderUsageCard(usageCard, () => renderAiTab(container));

  // Cards 2 and 2b cover the dashboard AI cards, which call /api/ai/insights
  // and therefore only exist in cloud mode. Static mode gets the agent
  // surfaces instead, so showing switches for cards it cannot run would just
  // be misleading.
  if (!cloud) {
    appendAiPrivacyCard(container);
    return;
  }

  // Card 2: per-feature visibility.
  const card2 = document.createElement('div');
  card2.className = 'card';
  card2.style.cssText = 'max-width:560px;margin-top:16px;';
  const head2 = document.createElement('div');
  head2.className = 'card-title';
  const h2 = document.createElement('h3');
  h2.textContent = t('ai.settings.perFeatureTitle');
  head2.append(h2);
  card2.append(head2);

  const flags = ai.perFeature || defaultPerFeatureFlags();
  for (const [key, labelKey] of AI_FEATURES_LIST) {
    const wrap = document.createElement('label');
    wrap.className = 'settings-toggle';
    const text = document.createElement('span');
    text.className = 'settings-toggle-text';
    const span = document.createElement('span');
    span.className = 'settings-toggle-label';
    span.textContent = t(labelKey);
    text.append(span);
    const sw = document.createElement('span');
    sw.className = 'bp-switch';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = flags[key] !== false;
    cb.disabled = !enabled;
    const track = document.createElement('span');
    track.className = 'bp-switch-track';
    sw.append(cb, track);
    wrap.append(text, sw);
    cb.addEventListener('change', async () => {
      try { await setPerFeatureFlag(key, cb.checked); }
      catch (err) { console.error(err); cb.checked = !cb.checked; }
    });
    card2.append(wrap);
  }
  container.append(card2);

  // Card 2b: Hidden suggestions — manage items dismissed across AI cards.
  const dismissedCard = document.createElement('div');
  dismissedCard.className = 'card';
  dismissedCard.style.cssText = 'max-width:560px;margin-top:16px;';
  renderDismissedCard(dismissedCard, () => renderAiTab(container));
  container.append(dismissedCard);

  // Card 3: advanced.
  const card3 = document.createElement('details');
  card3.className = 'card';
  card3.style.cssText = 'max-width:560px;margin-top:16px;';
  const summary = document.createElement('summary');
  summary.style.cssText = 'cursor:pointer;font-weight:600;list-style:revert;';
  summary.textContent = t('ai.settings.advanced');
  card3.append(summary);

  const modelField = document.createElement('div');
  modelField.className = 'field';
  modelField.style.marginTop = '12px';
  const modelLabel = document.createElement('label');
  modelLabel.textContent = t('ai.settings.modelLabel');
  const modelSel = document.createElement('select');
  // A choice saved before a model moved on shows as its tier's current model,
  // which is also what the server will run.
  const savedModel = currentModelId(ai.model) || '';
  for (const [val, lblKey] of [
    ['',               'ai.settings.modelDefault'],
    [AI_MODELS.haiku,  'ai.settings.modelHaiku'],
    [AI_MODELS.sonnet, 'ai.settings.modelSonnet'],
  ]) {
    const opt = document.createElement('option');
    opt.value = val;
    opt.textContent = t(lblKey);
    if (savedModel === val) opt.selected = true;
    modelSel.append(opt);
  }
  modelSel.disabled = !enabled;
  modelSel.addEventListener('change', async () => {
    try { await setAiModel(modelSel.value || null); }
    catch (err) { console.error(err); }
  });
  // The picker only reaches the insight cards; say so, or it reads as the
  // model for everything (the chat and document reading are fixed on Opus).
  const modelHint = document.createElement('div');
  modelHint.className = 'settings-toggle-hint';
  modelHint.style.marginTop = '6px';
  modelHint.textContent = t('ai.settings.modelHint');
  modelField.append(modelLabel, modelSel, modelHint);
  card3.append(modelField);

  const clearBtn = document.createElement('button');
  clearBtn.type = 'button';
  clearBtn.className = 'btn btn-ghost';
  clearBtn.style.cssText = 'margin-top:12px;';
  clearBtn.textContent = t('ai.settings.clearCache');
  clearBtn.disabled = !enabled;
  clearBtn.addEventListener('click', async () => {
    clearBtn.disabled = true;
    try {
      await clearAiCache();
      toast(t('ai.settings.cacheCleared'));
    } catch (err) {
      console.error(err);
      toast(t('ai.error.generic'));
    } finally {
      clearBtn.disabled = !enabled;
    }
  });
  card3.append(clearBtn);
  container.append(card3);

  appendAiPrivacyCard(container);
}

function appendAiPrivacyCard(container) {
  const card = document.createElement('div');
  card.className = 'card';
  card.style.cssText = 'max-width:560px;margin-top:16px;';
  const head = document.createElement('div');
  head.className = 'card-title';
  const h = document.createElement('h3');
  h.textContent = t('ai.settings.privacyTitle');
  head.append(h);
  card.append(head);
  const body = document.createElement('p');
  body.style.cssText = 'margin:0;color:var(--muted);font-size:13px;line-height:1.5;';
  body.textContent = t('ai.settings.privacyBody');
  card.append(body);
  const link = document.createElement('a');
  link.href = 'https://www.anthropic.com/privacy';
  link.target = '_blank';
  link.rel = 'noopener';
  link.style.cssText = 'display:inline-block;margin-top:8px;font-size:13px;';
  link.textContent = t('ai.settings.privacyLink');
  card.append(link);
  container.append(card);
}

const FEATURE_LABEL_KEY = {
  anomaly:          'ai.dismissed.feature.anomaly',
  envelope_health:  'ai.dismissed.feature.envelopeHealth',
  subscription:     'ai.dismissed.feature.subscription',
};

// ── Session usage ─────────────────────────────────────────────────────────
// An estimate, and labelled as one: prices are hard-coded and Anthropic's
// change. It exists so "what did that import cost" has an answer that is not
// "open the billing console".

function renderUsageCard(card, refreshAll) {
  card.replaceChildren();

  const head = document.createElement('div');
  head.className = 'card-title';
  const h = document.createElement('h3');
  h.textContent = t('ai.settings.usageTitle');
  head.append(h);
  card.append(head);

  const usage = getUsage();

  if (!usage.calls) {
    const empty = document.createElement('p');
    empty.style.cssText = 'margin:0;color:var(--muted);font-size:13px;';
    empty.textContent = t('ai.settings.usageEmpty');
    card.append(empty);
    return;
  }

  const grid = document.createElement('div');
  grid.className = 'ai-usage-grid';
  const stat = (labelKey, value) => {
    const cell = document.createElement('div');
    cell.className = 'ai-usage-stat';
    const lbl = document.createElement('span');
    lbl.className = 'ai-usage-label';
    lbl.textContent = t(labelKey);
    const val = document.createElement('span');
    val.className = 'ai-usage-value';
    val.textContent = value;
    cell.append(lbl, val);
    return cell;
  };

  grid.append(stat('ai.settings.usageCost', formatCost(usage.costUsd)));
  grid.append(stat('ai.settings.usageCalls', String(usage.calls)));
  grid.append(stat('ai.settings.usageIn', formatTokens(
    usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens,
  )));
  grid.append(stat('ai.settings.usageOut', formatTokens(usage.outputTokens)));
  card.append(grid);

  if (usage.cacheReadTokens > 0) {
    const cached = document.createElement('p');
    cached.style.cssText = 'margin:10px 0 0;color:var(--muted);font-size:12px;';
    cached.textContent = typeof t('ai.settings.usageCached') === 'function'
      ? t('ai.settings.usageCached')(formatTokens(usage.cacheReadTokens))
      : t('ai.settings.usageCached');
    card.append(cached);
  }

  const note = document.createElement('p');
  note.style.cssText = 'margin:10px 0 0;color:var(--muted);font-size:12px;line-height:1.5;';
  note.textContent = t('ai.settings.usageNote');
  card.append(note);

  const reset = document.createElement('button');
  reset.type = 'button';
  reset.className = 'btn btn-ghost';
  reset.style.marginTop = '12px';
  reset.textContent = t('ai.settings.usageReset');
  reset.addEventListener('click', () => { resetUsage(); refreshAll(); });
  card.append(reset);
}

// ── Static-mode API key ───────────────────────────────────────────────────
// No server, so no encrypted server-side store: the key sits in this
// browser's local storage. That is a weaker posture than the cloud card
// above and the copy says so plainly — do not soften it to make the two
// look alike.

function renderLocalKeyCard(card, refreshAll) {
  card.replaceChildren();

  const head = document.createElement('div');
  head.className = 'card-title';
  const h = document.createElement('h3');
  h.textContent = t(globalThis.bunvelopeDesktop ? 'migrationBackup.keyTitle' : 'ai.settings.localKeyTitle');
  head.append(h);
  card.append(head);

  const hint = document.createElement('p');
  hint.style.cssText = 'margin:0 0 10px 0;color:var(--muted);font-size:13px;line-height:1.5;';
  hint.textContent = t(globalThis.bunvelopeDesktop ? 'migrationBackup.keyHint' : 'ai.settings.localKeyHint');
  card.append(hint);

  const warn = document.createElement('p');
  warn.className = 'ai-key-warning';
  warn.textContent = t(globalThis.bunvelopeDesktop ? 'migrationBackup.keyStorage' : 'ai.settings.localKeyWarning');
  card.append(warn);

  const link = document.createElement('a');
  link.href = 'https://console.anthropic.com/settings/keys';
  link.target = '_blank';
  link.rel = 'noopener';
  link.style.cssText = 'display:inline-block;margin:0 0 12px 0;font-size:13px;';
  link.textContent = t('ai.settings.apiKeyConsoleLink');
  card.append(link);

  const status = document.createElement('div');
  status.style.cssText = 'font-size:13px;margin-bottom:12px;';
  card.append(status);

  const existing = getLocalKey();
  if (existing) {
    status.style.color = 'var(--success, green)';
    status.textContent = `${t('ai.settings.apiKeyConfigured')} · ${maskKey(existing)}`;
  } else {
    status.style.color = 'var(--muted)';
    status.textContent = t('ai.settings.apiKeyNotSet');
  }

  const form = document.createElement('div');
  form.style.cssText = 'display:flex;flex-direction:column;gap:8px;';

  const inputField = document.createElement('div');
  inputField.className = 'field';
  inputField.style.marginBottom = '0';
  const input = document.createElement('input');
  input.type = 'password';
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.placeholder = existing
    ? t('ai.settings.apiKeyPlaceholderReplace')
    : t('ai.settings.apiKeyPlaceholder');
  input.style.fontFamily = 'ui-monospace,Menlo,Consolas,monospace';
  inputField.append(input);

  const buttons = document.createElement('div');
  buttons.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px;';

  const testBtn = document.createElement('button');
  testBtn.type = 'button';
  testBtn.className = 'btn btn-ghost';
  testBtn.textContent = t('ai.settings.apiKeyTest');

  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.className = 'btn';
  saveBtn.textContent = t('ai.settings.apiKeySave');
  saveBtn.disabled = true;

  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.className = 'btn btn-ghost';
  removeBtn.textContent = t('ai.settings.apiKeyRemove');
  if (!existing) removeBtn.style.display = 'none';

  buttons.append(testBtn, saveBtn, removeBtn);

  const testResult = document.createElement('div');
  testResult.style.cssText = 'font-size:13px;min-height:18px;';

  form.append(inputField, buttons, testResult);
  card.append(form);

  // Same discipline as the cloud card: Save only unlocks once Test has
  // succeeded for the exact value in the box. A key that fails at import
  // time is far more annoying than one that fails at entry time.
  let testedValue = null;
  input.addEventListener('input', () => {
    saveBtn.disabled = true;
    testResult.textContent = '';
    testResult.style.color = '';
    if (input.value && input.value !== testedValue) testedValue = null;
  });

  testBtn.addEventListener('click', async () => {
    const candidate = input.value.trim();
    if (!candidate) {
      testResult.style.color = 'var(--danger, #c0392b)';
      testResult.textContent = t('ai.settings.apiKeyEnterFirst');
      return;
    }
    testBtn.disabled = true;
    testResult.style.color = 'var(--muted)';
    testResult.textContent = t('ai.settings.apiKeyTesting');
    try {
      const res = await testDirectKey(candidate);
      if (res.ok) {
        testedValue = candidate;
        saveBtn.disabled = false;
        testResult.style.color = 'var(--success, green)';
        testResult.textContent = t('ai.settings.apiKeyTestOk');
      } else {
        testResult.style.color = 'var(--danger, #c0392b)';
        testResult.textContent = res.code === 'network'
          ? t('ai.settings.localKeyNetworkFail')
          : t('ai.settings.apiKeyTestFail');
      }
    } catch {
      testResult.style.color = 'var(--danger, #c0392b)';
      testResult.textContent = t('ai.settings.apiKeyTestFail');
    } finally {
      testBtn.disabled = false;
    }
  });

  saveBtn.addEventListener('click', () => {
    const candidate = input.value.trim();
    if (!candidate || candidate !== testedValue) return;
    try { setLocalKey(candidate); } catch { toast(t('migrationBackup.keyFailure')); return; }
    toast(t('ai.settings.apiKeySaved'));
    refreshAiEntryPoints();
    refreshAll();
  });

  removeBtn.addEventListener('click', async () => {
    const ok = await confirmDialog(t('ai.settings.apiKeyRemoveConfirm'));
    if (!ok) return;
    try { clearLocalKey(); } catch { toast(t('migrationBackup.keyFailure')); return; }
    toast(t('ai.settings.apiKeyRemoved'));
    refreshAiEntryPoints();
    refreshAll();
  });
}

function renderDismissedCard(card, refreshAll) {
  card.replaceChildren();

  const head = document.createElement('div');
  head.className = 'card-title';
  const h = document.createElement('h3');
  h.textContent = t('ai.settings.dismissedTitle');
  head.append(h);
  card.append(head);

  const items = listDismissed();
  if (!items.length) {
    const empty = document.createElement('p');
    empty.style.cssText = 'margin:0;color:var(--muted);font-size:13px;';
    empty.textContent = t('ai.settings.dismissedEmpty');
    card.append(empty);
    return;
  }

  // Group by feature.
  const groups = new Map();
  for (const it of items) {
    const arr = groups.get(it.feature) || [];
    arr.push(it);
    groups.set(it.feature, arr);
  }

  for (const [feature, list] of groups.entries()) {
    const section = document.createElement('div');
    section.style.cssText = 'margin-top:12px;padding-top:12px;border-top:1px solid var(--border);';

    const heading = document.createElement('div');
    heading.style.cssText = 'display:flex;align-items:center;justify-content:space-between;font-weight:500;font-size:13px;margin-bottom:8px;';
    const title = document.createElement('span');
    title.textContent = t(FEATURE_LABEL_KEY[feature] || 'ai.settings.dismissedTitle');
    const clearAll = document.createElement('button');
    clearAll.type = 'button';
    clearAll.className = 'btn btn-ghost btn-sm';
    clearAll.style.cssText = 'font-size:11px;padding:2px 8px;';
    clearAll.textContent = t('ai.settings.dismissedClearAll');
    clearAll.addEventListener('click', async () => {
      try { await clearDismissedFeature(feature); }
      catch (err) { console.error(err); return; }
      refreshAll();
    });
    heading.append(title, clearAll);
    section.append(heading);

    for (const it of list) {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:10px;padding:6px 0;font-size:13px;';
      const label = document.createElement('div');
      label.style.flex = '1';
      label.textContent = formatAiText(it.label) || it.key;
      const date = document.createElement('span');
      date.style.cssText = 'color:var(--muted);font-size:12px;';
      date.textContent = it.dismissedAt ? it.dismissedAt.slice(0, 10) : '';
      const restore = document.createElement('button');
      restore.type = 'button';
      restore.className = 'btn btn-ghost btn-sm';
      restore.style.cssText = 'font-size:11px;padding:2px 10px;';
      restore.textContent = t('ai.settings.dismissedRestore');
      restore.addEventListener('click', async () => {
        try { await restoreItem(it.feature, it.key); }
        catch (err) { console.error(err); return; }
        refreshAll();
      });
      row.append(label, date, restore);
      section.append(row);
    }
    card.append(section);
  }
}

// ── API key card ──────────────────────────────────────────────────────────
// BYOK: user supplies their own Anthropic API key. Card supports
// loading state, save (with Test required first), and remove. Surfaces
// a warning when the server hasn't configured at-rest encryption.

function renderApiKeyCard(card, refreshAll) {
  card.replaceChildren();

  const head = document.createElement('div');
  head.className = 'card-title';
  const h = document.createElement('h3');
  h.textContent = t('ai.settings.apiKeyTitle');
  head.append(h);
  card.append(head);

  const hint = document.createElement('p');
  hint.style.cssText = 'margin:0 0 12px 0;color:var(--muted);font-size:13px;line-height:1.5;';
  hint.textContent = t('ai.settings.apiKeyHint');
  card.append(hint);

  const link = document.createElement('a');
  link.href = 'https://console.anthropic.com/settings/keys';
  link.target = '_blank';
  link.rel = 'noopener';
  link.style.cssText = 'display:inline-block;margin:0 0 12px 0;font-size:13px;';
  link.textContent = t('ai.settings.apiKeyConsoleLink');
  card.append(link);

  const status = document.createElement('div');
  status.style.cssText = 'font-size:13px;margin-bottom:12px;';
  status.textContent = t('ai.settings.apiKeyLoading');
  card.append(status);

  const warn = document.createElement('div');
  warn.className = 'notice-warn';
  warn.style.cssText = 'display:none;border-radius:6px;padding:10px 12px;font-size:13px;margin-bottom:12px;line-height:1.5;';
  card.append(warn);

  const encOk = document.createElement('p');
  encOk.style.cssText = 'display:none;margin:0 0 12px 0;color:var(--muted);font-size:12px;line-height:1.5;';
  card.append(encOk);

  const form = document.createElement('div');
  form.style.cssText = 'display:flex;flex-direction:column;gap:8px;';

  const inputField = document.createElement('div');
  inputField.className = 'field';
  inputField.style.marginBottom = '0';
  const input = document.createElement('input');
  input.type = 'password';
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.placeholder = t('ai.settings.apiKeyPlaceholder');
  input.style.fontFamily = 'ui-monospace,Menlo,Consolas,monospace';
  inputField.append(input);

  const buttons = document.createElement('div');
  buttons.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px;';

  const testBtn = document.createElement('button');
  testBtn.type = 'button';
  testBtn.className = 'btn btn-ghost';
  testBtn.textContent = t('ai.settings.apiKeyTest');

  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.className = 'btn';
  saveBtn.textContent = t('ai.settings.apiKeySave');
  saveBtn.disabled = true;

  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.className = 'btn btn-ghost';
  removeBtn.textContent = t('ai.settings.apiKeyRemove');
  removeBtn.style.display = 'none';

  buttons.append(testBtn, saveBtn, removeBtn);

  const testResult = document.createElement('div');
  testResult.style.cssText = 'font-size:13px;min-height:18px;';

  form.append(inputField, buttons, testResult);
  card.append(form);

  // Re-disable Save whenever the input changes — Test must succeed for
  // the current value before Save unlocks.
  let testedValue = null;
  input.addEventListener('input', () => {
    saveBtn.disabled = true;
    testResult.textContent = '';
    testResult.style.color = '';
    if (input.value && input.value !== testedValue) testedValue = null;
  });

  testBtn.addEventListener('click', async () => {
    const candidate = input.value.trim();
    if (!candidate) {
      testResult.style.color = 'var(--danger, #c0392b)';
      testResult.textContent = t('ai.settings.apiKeyEnterFirst');
      return;
    }
    testBtn.disabled = true;
    saveBtn.disabled = true;
    testResult.style.color = '';
    testResult.textContent = t('ai.settings.apiKeyTesting');
    try {
      const res = await aiTestKey(candidate);
      if (res.ok) {
        testResult.style.color = 'var(--success, #1f8b4c)';
        testResult.textContent = t('ai.settings.apiKeyTestOk');
        testedValue = candidate;
        saveBtn.disabled = false;
      } else {
        testResult.style.color = 'var(--danger, #c0392b)';
        testResult.textContent = res.code === 'invalid_user_api_key'
          ? t('ai.settings.apiKeyTestInvalid')
          : t('ai.settings.apiKeyTestFail');
      }
    } catch (err) {
      console.error(err);
      testResult.style.color = 'var(--danger, #c0392b)';
      testResult.textContent = err.code === 'bad_api_key'
        ? t('ai.settings.apiKeyTestBadShape')
        : t('ai.settings.apiKeyTestFail');
    } finally {
      testBtn.disabled = false;
    }
  });

  saveBtn.addEventListener('click', async () => {
    const candidate = input.value.trim();
    if (!candidate || candidate !== testedValue) return;
    saveBtn.disabled = true;
    testBtn.disabled = true;
    try {
      await aiSaveKey(candidate);
      toast(t('ai.settings.apiKeySaved'));
      setNavItemVisible('insights', isRelayFeatureAvailable());
      refreshAiEntryPoints();
      refreshAll();
    } catch (err) {
      console.error(err);
      testBtn.disabled = false;
      toast(t('ai.error.generic'));
    }
  });

  removeBtn.addEventListener('click', async () => {
    const ok = await confirmDialog(t('ai.settings.apiKeyRemoveConfirm'));
    if (!ok) return;
    removeBtn.disabled = true;
    try {
      await aiDeleteKey();
      toast(t('ai.settings.apiKeyRemoved'));
      setNavItemVisible('insights', isRelayFeatureAvailable());
      refreshAiEntryPoints();
      refreshAll();
    } catch (err) {
      console.error(err);
      removeBtn.disabled = false;
      toast(t('ai.error.generic'));
    }
  });

  // Async load of current status. The card is already mounted; just
  // populate fields once the response lands.
  aiGetKeyStatus().then((s) => {
    if (s.serverEncryption === 'aes-256-gcm') {
      encOk.style.display = 'block';
      encOk.textContent = t('ai.settings.apiKeyEncryptionOk');
    } else {
      warn.style.display = 'block';
      warn.textContent = t('ai.settings.apiKeyEncryptionWarning');
    }
    if (s.hasKey) {
      status.replaceChildren();
      const strong = document.createElement('strong');
      strong.textContent = t('ai.settings.apiKeyConfigured');
      status.append(strong, ` · …${s.preview || ''}`);
      if (s.setAt) {
        const dateStr = s.setAt.slice(0, 10);
        const sep = document.createTextNode(' · ');
        const date = document.createElement('span');
        date.style.color = 'var(--muted)';
        date.textContent = dateStr;
        status.append(sep, date);
      }
      removeBtn.style.display = '';
      input.placeholder = t('ai.settings.apiKeyPlaceholderReplace');
    } else {
      status.style.color = 'var(--muted)';
      status.textContent = t('ai.settings.apiKeyNotSet');
    }
  }).catch((err) => {
    console.error(err);
    status.style.color = 'var(--danger, #c0392b)';
    status.textContent = t('ai.error.generic');
  });
}

// ── Public render ─────────────────────────────────────────────────────────

export async function render(container) {
  const restoreTabFocus = container.contains(document.activeElement) && document.activeElement?.getAttribute('role') === 'tab';
  const tabs = [
    ['budget',    t('settings.budgetTab')],
    ['cleanup',   t('settings.cleanupTab')],
    ['help',      t('settings.helpTab')],
    ['info',      t('settings.infoTab')],
  ];
  // The AI tab is where a static-mode user enters their key, so it has to be
  // reachable before AI is available — gating it on isAiAvailable() would make
  // it impossible to ever turn on. Only a cloud guest is excluded: they have
  // no authenticated session for the relay to use.
  if (!isCloudMode() || !isGuestSession()) tabs.push(['ai', t('ai.settings.tab')]);
  tabs.push(['security', t('settings.dataSecurity.tab')]);
  const validTabs = new Set(tabs.map(([k]) => k));
  // navigate('settings', { tab }) opens a given tab (the status-bar badge's
  // sheet links to Clean-up). Consumed once, like other deep links.
  const wantedTab = state.pendingFilter?.tab;
  if (wantedTab) {
    state.pendingFilter = null;
    if (validTabs.has(wantedTab)) activeTab = wantedTab;
  }
  if (!validTabs.has(activeTab)) activeTab = 'budget';

  // eslint-disable-next-line no-restricted-syntax -- values are escHtml-wrapped
  container.innerHTML = `
    <div class="page">
      <div class="page-head">
        <div>
          <h1>${escHtml(t('settings.title'))}</h1>
        </div>
      </div>

    </div>
  `;

  addPageHelp(container.querySelector('.page-head h1'), 'tour.steps.settings.body');

  const panels = tabs.map(([key, text]) => [key, text, document.createElement('section')]);
  const show = key => {
    activeTab = key;
    for (const [panelKey,,panel] of panels) {
      // Old asynchronous render work remains attached to its detached content.
      panel.replaceChildren();
      if (panelKey !== key) continue;
      const body = document.createElement('div'); body.id = 'settings-body';
      panel.append(body); renderTab(body);
    }
  };
  const strip = contentTabs(panels, activeTab, { label: t('settings.title'), onSelect: show });
  container.querySelector('.page').append(strip, ...panels.map(entry => entry[2]));
  show(activeTab);
  strip.restoreSelectedTab({ focus: restoreTabFocus });
}
