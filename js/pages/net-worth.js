// js/pages/net-worth.js — Net worth: its history, and a long-horizon
// projection from per-account growth assumptions (owner request 2026-09-24).
//
// The projection is deliberately NOT part of the Forecast lens: the lens
// projects booked and scheduled money over months, where growth rates are
// noise; here the horizon is years, where they are the point, and every
// assumption is on screen next to the result.

import { renderForecastReadiness } from '../ui/forecast-readiness.js';
import { icon } from '../ui/icon.js';
import { addPageHelp } from '../ui/info-button.js';
import { state, now, navigate } from '../app.js';
import { netWorthPartOf, normalizeScenarios } from '../engine.js';
import { mountChart } from '../ui/charts/index.js';
import { fmt, fmtNum, round2 } from '../utils.js';
import { t, fmtMonthLang } from '../ui/i18n.js';
import { ask } from '../ui/query.js';
import { parseAmountInput } from '../ui/amount-input.js';
import { confirmDialog, promptDialog, alertDialog } from '../ui/dialog.js';
import { reportSaveError } from '../ui/save-error.js';
import { updateMeta } from '../state/meta-writes.js';
import { simulationCard } from './net-worth-simulation.js';
import { loadPageFilter, savePageFilter, exclusionCount, budgetKeyOf } from '../ui/page-filter.js';
import { openExcludePicker, exclusionChip } from '../ui/exclude-picker.js';
import { loadChartPrefs, saveChartPrefs } from '../ui/charts/persist.js';
import { readContributionSource } from './net-worth-contribution.js';
import { currentBudgetSession } from '../state/budget-session.js';
import { registerPending } from '../state/unload-guard.js';
import { assetGroupQuickLabels } from './net-worth-quick-groups.js';
import { generateId } from '../import.js';
import { ASSUMPTION_FIELDS, simulationConfigs, editedAssumptions, simulationOverrides } from './net-worth-simulations.js';
import { openWhatIfEditor } from './whatif-editor.js';

const HORIZONS = [5, 10, 20];
// The low and high lines move every rate that is set by this much (the
// projection query's band; the simulation card asks for the same shift).
const SHIFT_PCT = 2;
let horizon = 10;
// Keep simulations when navigating within this budget; never carry them into
// a different load, including a guest reset that reuses the folder handle.
let draftState;
registerPending(() => !!draftState && draftState.folder === state.budgetFolder
  && draftState.generation === currentBudgetSession() && !!draftState.isDirty?.());

const pad = n => String(n).padStart(2, '0');
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

function card(titleText, subText) {
  const el = document.createElement('section');
  el.className = 'card';
  el.style.marginBottom = '16px';
  const head = document.createElement('div');
  head.className = 'card-title';
  const h3 = document.createElement('h3');
  h3.textContent = titleText;
  head.append(h3);
  if (subText) {
    const sub = document.createElement('span');
    sub.className = 'sub';
    sub.textContent = subText;
    head.append(sub);
  }
  el.append(head);
  return el;
}

export async function render(container) {
  const page = document.createElement('div');
  page.className = 'page';

  const head = document.createElement('div');
  head.className = 'page-head';
  const left = document.createElement('div');
  const h1 = document.createElement('h1');
  h1.textContent = t('netWorth.title');
  addPageHelp(h1, 'netWorth.intro');
  left.append(h1);
  head.append(left);
  const headActions = document.createElement('div');
  headActions.className = 'net-worth-head-actions';
  left.append(headActions);
  page.append(head);

  const prefs = loadChartPrefs('nw-projection');
  const listConfigs = (meta = state.meta) => simulationConfigs(meta, state.accounts || [], t('netWorth.previousSimulation'), prefs);
  const generation = currentBudgetSession();
  if (!draftState || draftState.folder !== state.budgetFolder || draftState.generation !== generation) {
    const configs = listConfigs();
    const id = Object.hasOwn(prefs, 'simulationId') ? prefs.simulationId : configs[0]?.id;
    const initial = configs.find(config => config.id === id);
    draftState = { folder: state.budgetFolder, generation, edits: new Map(), raw: new Map(), collapsed: new Set(), saving: false,
      selectedId: initial?.id ?? null, source: initial?.contribution ?? 'plan', whatIf: initial?.whatIf ?? null, newProfile: false };
  }
  const draft = draftState;
  const selectedConfig = () => listConfigs().find(config => config.id === draft.selectedId) || null;
  // A configuration removed elsewhere falls back to the actual budget.
  if (draftState.selectedId && !selectedConfig()) {
    draftState.selectedId = null;
    draftState.source = 'plan';
    draftState.whatIf = null;
    draftState.edits.clear();
    draftState.raw.clear();
  }
  for (const key of draft.raw.keys()) if (!draft.edits.has(key)) draft.raw.delete(key);
  // An explicit save may finish after navigation away and back. Refresh the
  // latest instance of this page, rather than its detached predecessor.
  draft.repaint = paintAll;
  const isCurrent = () => state.budgetFolder === draft.folder && currentBudgetSession() === generation;
  const editKey = (id, field) => JSON.stringify([id, field]);
  const savedValue = (id, field) => selectedConfig()?.accounts.find(a => a.id === id)?.[field] ?? null;
  const currentAssumptions = (edits = [...draft.edits.values()]) => editedAssumptions(selectedConfig()?.accounts || [], edits);
  const overrides = () => simulationOverrides(state.accounts || [], currentAssumptions());
  const settingsDirty = () => draft.source !== (selectedConfig()?.contribution ?? 'plan')
    || draft.whatIf !== (selectedConfig()?.whatIf ?? null);
  const isDirty = () => draft.edits.size > 0 || settingsDirty() || draft.newProfile;
  draft.isDirty = isDirty;

  const today = now();
  const todayIso = ymd(today);
  // Page filter: accounts left out of every number on this page (saved per
  // budget). They are left out of the totals, not simulated away: the walk
  // still runs over every account, so its dates to act on do too.
  const active = (state.accounts || []).filter(a => !a.archived);
  const budgetName = budgetKeyOf(state.budgetFolder);
  const excluded = loadPageFilter('netWorth', budgetName, { accounts: new Set(active.map(a => a.id)) });
  const exAcc = new Set(excluded.accounts);
  const nExcluded = exclusionCount(excluded);
  // CSV downloads say when the page filter shaped them.
  const csvNameOf = title => (nExcluded ? `${title} ${t('pageFilter.filtered')}` : title);
  // What every query on this page is asked about: one day for the whole
  // render, the accounts the page filter leaves in and, for the simulations
  // and the projection, the unsaved edits.
  const filterInput = { date: todayIso, ...(nExcluded ? { excludeAccounts: [...exAcc] } : {}) };
  const scope = () => {
    const edits = overrides();
    return edits.length ? { ...filterInput, accountOverrides: edits } : { ...filterInput };
  };

  // ── What if ──────────────────────────────────────────────────────────────
  // Scenarios are saved per budget (meta.whatIfScenarios); the selection is a
  // per-browser view preference, alongside the projection chart's other
  // prefs. This list is what the selector offers and the editor edits; the
  // queries look the selected scenario up by its id.
  const listScenarios = () => normalizeScenarios(state.meta?.whatIfScenarios, { accounts: state.accounts, budgetItems: state.budgetItems });
  let scenarios = listScenarios();
  let whatIfId = draft.whatIf;
  if (whatIfId && !scenarios.some(s => s.id === whatIfId)) whatIfId = draft.whatIf = null;
  const selectedScenario = () => scenarios.find(s => s.id === whatIfId) || null;

  // The selected scenario can be deleted elsewhere while this page is open
  // (another tab, the AI): the queries then fail not_found on its id. The
  // page drops the selection, as it drops an unknown id at load, and lists
  // the scenarios as they are now. `ask`'s onFail: true when that was it.
  function dropMissingWhatIf(error) {
    if (error.code !== 'not_found' || error.params?.kind !== 'whatIf') return false;
    whatIfId = draft.whatIf = null;
    scenarios = listScenarios();
    paintWhatIfRow();
    return true;
  }

  // Writes one scenario (upsert) or removes one by id, applied to the STORED
  // list rather than the cleaned `scenarios` shown here: a saved scenario the
  // cleanup currently hides (say its account is archived) must not be erased
  // by saving or deleting a different one; it comes back once it is valid.
  async function saveScenarios({ upsert = null, removeId = null }) {
    const ok = await persistConfigurationList('whatIfScenarios', { upsert, removeId });
    if (!ok) return false;
    scenarios = listScenarios();
    return true;
  }

  async function persistConfigurationList(key, { upsert = null, removeId = null }) {
    if (!isCurrent()) return false;
    const sameId = (entry, id) => entry && typeof entry.id === 'string' && entry.id.trim() === id;
    try {
      await updateMeta(state, meta => {
        const raw = Array.isArray(meta[key]) ? meta[key]
          : key === 'netWorthSimulations' ? listConfigs(meta) : [];
        let next = removeId ? raw.filter(entry => !sameId(entry, removeId)) : raw;
        if (upsert) next = next.some(entry => sameId(entry, upsert.id))
          ? next.map(entry => sameId(entry, upsert.id) ? upsert : entry) : [...next, upsert];
        return { ...meta, [key]: next };
      });
      return isCurrent();
    } catch (err) {
      reportSaveError(err, 'net worth: save configuration');
      return false;
    }
  }

  function openEditor(sc) {
    openWhatIfEditor({
      scenario: sc,
      accounts: state.accounts,
      budgetItems: state.budgetItems,
      today,
      onSave: async (normalized) => {
        const ok = await saveScenarios({ upsert: normalized });
        if (!ok) return false;
        whatIfId = draft.whatIf = normalized.id;
        paintWhatIfRow();
        paintAll();
        return true;
      },
    });
  }

  // ── History: the last 24 month-ends, and today ──────────────────────────
  const history = ask('netWorth.history', { ...filterInput })?.points ?? null;
  if (nExcluded) {
    const sub = document.createElement('div');
    sub.className = 'page-head-sub';
    left.insertBefore(sub, headActions);
    const filteredTag = document.createElement('span');
    filteredTag.className = 'muted';
    filteredTag.textContent = ` ${t('pageFilter.filtered')}`;
    sub.append(filteredTag);
  }
  const saveExcluded = async sel => {
    savePageFilter('netWorth', budgetName, sel);
    await render(container);
    container.querySelector('.net-worth-head-actions .btn')?.focus();
  };
  const excludeBtn = document.createElement('button');
  excludeBtn.type = 'button';
  excludeBtn.className = 'btn btn-sm btn-ghost';
  excludeBtn.textContent = t('pageFilter.exclude');
  excludeBtn.addEventListener('click', () => {
    const PART_ORDER = ['spending', 'savings', 'investment', 'pension', 'assets', 'loansGiven', 'debts', 'other'];
    const partLabel = part => (part === 'other' ? t('pageFilter.otherAccounts') : t(`netWorth.part.${part}`));
    /** @type {Map<string, any[]>} */
    const byPart = new Map();
    for (const a of active) {
      const part = netWorthPartOf(a);
      if (!byPart.has(part)) byPart.set(part, []);
      byPart.get(part).push(a);
    }
    const parts = PART_ORDER.filter(p => byPart.has(p));
    /** @type {Map<string, string[]>} */
    const assetGroups = new Map();
    for (const a of active) {
      if (netWorthPartOf(a) !== 'assets' || !a.group) continue;
      if (!assetGroups.has(a.group)) assetGroups.set(a.group, []);
      assetGroups.get(a.group).push(a.id);
    }
    const partLabels = parts.map(partLabel);
    const assetGroupQuick = assetGroupQuickLabels(
      [...assetGroups].map(([label, ids]) => ({ label, ids })),
      partLabels,
      t('netWorth.type.asset'),
    );
    openExcludePicker({
      title: t('pageFilter.netWorthTitle'),
      sections: [{
        id: 'accounts',
        label: t('pageFilter.accounts'),
        quick: [
          ...parts.map(p => ({ label: partLabel(p), ids: byPart.get(p).map(a => a.id) })),
          ...assetGroupQuick,
        ],
        groups: parts.map(p => ({
          label: partLabel(p),
          items: byPart.get(p).map(a => ({ id: a.id, label: a.name || a.id })),
        })),
      }],
      selected: excluded,
      onApply: saveExcluded,
    });
  });
  headActions.append(excludeBtn);
  if (nExcluded) headActions.append(exclusionChip({ count: nExcluded, onClear: () => saveExcluded({ accounts: [] }) }));

  const histCard = card(t('netWorth.historyTitle'), t('netWorth.historySub'));
  if (history) {
    histCard.append(mountChart({
      id: 'nw-history', kind: 'line', title: t('netWorth.historyTitle'), height: 260,
      csvName: csvNameOf(t('netWorth.historyTitle')),
      format: v => fmt(v, { decimals: 0 }),
      x: history.map((p, i) => ({
        key: p.date,
        label: i === history.length - 1 ? t('netWorth.today') : fmtMonthLang(p.date.slice(0, 7)),
      })),
      series: [{ id: 'total', name: t('netWorth.title'), values: history.map(p => p.total) }],
    }));
  }
  page.append(histCard);

  // ── Next 24 months ───────────────────────────────────────────────────────
  const simSlot = document.createElement('div');
  page.append(simSlot);
  const readinessSlot = document.createElement('div');
  page.append(readinessSlot);

  async function readinessAction({kind,id}) {
    if (!isCurrent()) return;
    if (kind === 'plan') { navigate('budget-plan'); return; }
    if (kind === 'budgetItem') {
      const {openEditBudgetItem} = await import('./budget-plan.js');
      if (isCurrent() && state.budgetItems.some(i => i.id === id)) openEditBudgetItem(id,{onChange:()=>{if(isCurrent()) navigate('net-worth');}});
      return;
    }
    if (kind === 'envelope') {
      const {openEnvelopeEdit} = await import('./envelope-edit.js');
      const envelope = state.envelopes.find(e => e.id === id);
      if (isCurrent() && envelope) openEnvelopeEdit(envelope);
      return;
    }
    if (!state.accounts.some(a => a.id === id)) return;
    if (kind === 'transactions') { navigate('transactions','account:'+id); return; }
    if (kind === 'reconcile') {
      const {openReconcileModal} = await import('../reconcile.js');
      if (isCurrent() && state.accounts.some(a => a.id === id)) openReconcileModal(id,()=>{if(isCurrent()) navigate('net-worth');});
    } else if (kind === 'account') {
      const {openAccountEdit} = await import('./account-edit.js');
      const account = state.accounts.find(a => a.id === id);
      if (isCurrent() && account) openAccountEdit(account);
    }
  }

  const openReadinessDetails = new Set();
  function paintReadiness() {
    for (const detail of readinessSlot.querySelectorAll('[data-readiness-detail]')) {
      if (detail.open) openReadinessDetails.add(detail.dataset.readinessDetail);
      else openReadinessDetails.delete(detail.dataset.readinessDetail);
    }
    const sc = selectedScenario();
    const answer = ask('forecast.readiness',{...scope(),months:24,contribution:contributionSource,...(sc?{whatIf:sc.id}:{})});
    const panel = renderForecastReadiness({answer,unavailable:!answer,onAction:readinessAction,draftAssumptions:isDirty()});
    for (const detail of panel.querySelectorAll('[data-readiness-detail]')) {
      detail.open = openReadinessDetails.has(detail.dataset.readinessDetail);
    }
    readinessSlot.replaceChildren(panel);
  }
  // Three runs of the same walk; only growth differs between them, and only
  // the base run's dates to act on are shown, so the band skips them. The
  // engine caches each run on its inputs, so repainting after an edit
  // re-walks only what changed (and the projection below reuses them). A
  // failed run leaves the card off, not showing the last paint's figures.
  function paintSimulation() {
    const base = ask('forecast.simulation', scope());
    const low = ask('forecast.simulation', { ...scope(), shiftPct: -SHIFT_PCT, alerts: false });
    const high = ask('forecast.simulation', { ...scope(), shiftPct: SHIFT_PCT, alerts: false });
    if (!base || !low || !high) {
      simSlot.replaceChildren();
      return;
    }
    const sc = selectedScenario();
    const whatIf = sc ? ask('forecast.simulation', { ...scope(), whatIf: sc.id }, dropMissingWhatIf) : null;
    simSlot.replaceChildren(simulationCard({
      sims: { base, low, high }, accounts: state.accounts, filtered: nExcluded > 0,
      envelopes: state.envelopes, todayIso, card,
      whatIf: whatIf ? { name: whatIf.whatIf.name, alertsDiff: whatIf.alertsDiff } : null,
    }));
  }

  // ── Projection ───────────────────────────────────────────────────────────
  const projCard = card(t('netWorth.projectionTitle'), t('netWorth.projectionSub'));
  const configRow = document.createElement('div');
  configRow.className = 'net-worth-config-row';
  const whatIfRow = document.createElement('div');
  whatIfRow.className = 'net-worth-whatif-row';
  // A plain row, not the `.filters` bar: that one is sticky and paints a
  // background block above itself, which covered the history card here.
  const controls = document.createElement('div');
  controls.className = 'net-worth-horizons';
  const sourceSlot = document.createElement('div');
  const topRow = document.createElement('div');
  topRow.className = 'net-worth-projection-top';
  topRow.append(whatIfRow, sourceSlot);
  const bulkActions = document.createElement('div');
  bulkActions.className = 'net-worth-bulk-actions';
  const projChart = document.createElement('div');
  projChart.className = 'net-worth-projection-chart';
  const table = document.createElement('table');
  table.className = 'tx-table net-worth-table';
  // The plan-based contribution can differ a lot from recent months (income
  // not scheduled in the plan); say so where it shows on touch, not only in
  // a tooltip.
  const planNote = document.createElement('p');
  planNote.className = 'net-worth-plan-note';
  const assumptions = document.createElement('ul');
  assumptions.className = 'net-worth-assumptions';
  for (const key of ['assumeStart', 'assumeContribution', 'assumeLoans', 'assumeInterest', 'assumeLaterBooked', 'assumeBand']) {
    const li = document.createElement('li');
    li.textContent = key === 'assumeBand' ? t('netWorth.assumeBand')(SHIFT_PCT) : t(`netWorth.${key}`);
    assumptions.append(li);
  }
  // Scrolls sideways inside the card on a phone rather than widening the
  // page; focusable so the scroll works from the keyboard too.
  const tableWrap = document.createElement('div');
  tableWrap.className = 'net-worth-table-wrap';
  tableWrap.setAttribute('data-scroll-cue', 'sticky');
  tableWrap.tabIndex = 0;
  tableWrap.setAttribute('role', 'region');
  tableWrap.setAttribute('aria-label', t('netWorth.projectionTitle'));
  tableWrap.append(table);
  projCard.append(configRow, topRow, projChart, tableWrap, planNote, assumptions);
  page.append(projCard);

  function paintWhatIfRow() {
    whatIfRow.replaceChildren();
    const labelEl = document.createElement('span');
    labelEl.className = 'net-worth-source-label';
    labelEl.id = 'nw-whatif-label';
    labelEl.textContent = t('netWorth.whatIfLabel');
    // The app's input look (.form-input), compact to sit beside the small
    // Edit/Delete buttons — not a bare browser select.
    const sel = document.createElement('select');
    sel.className = 'form-input';
    sel.style.cssText = 'width:auto;padding:6px 10px;font-size:13px;';
    sel.setAttribute('aria-labelledby', labelEl.id);
    const noneOpt = document.createElement('option');
    noneOpt.value = '';
    noneOpt.textContent = t('netWorth.whatIfNone');
    sel.append(noneOpt);
    for (const s of scenarios) {
      const o = document.createElement('option');
      o.value = s.id;
      o.textContent = s.name;
      sel.append(o);
    }
    const newOpt = document.createElement('option');
    newOpt.value = '__new__';
    newOpt.textContent = t('netWorth.whatIfNewOption');
    sel.append(newOpt);
    sel.value = whatIfId || '';
    sel.addEventListener('change', () => {
      if (sel.value === '__new__') {
        sel.value = whatIfId || '';
        openEditor(null);
        return;
      }
      whatIfId = draft.whatIf = sel.value || null;
      paintWhatIfRow();
      paintAll();
    });
    whatIfRow.append(labelEl, sel);
    const sc = selectedScenario();
    if (sc) {
      const editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.className = 'btn btn-sm btn-ghost';
      editBtn.textContent = t('netWorth.whatIfEdit');
      editBtn.addEventListener('click', () => openEditor(sc));
      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'btn btn-sm btn-ghost';
      delBtn.textContent = t('netWorth.whatIfDelete');
      delBtn.addEventListener('click', async () => {
        if (!await confirmDialog(t('netWorth.whatIfDeleteConfirm')(sc.name), { title: t('netWorth.whatIfDelete'), danger: true, okLabel: t('common.delete') })) return;
        const ok = await saveScenarios({ removeId: sc.id });
        if (!ok) return;
        whatIfId = draft.whatIf = null;
        paintWhatIfRow();
        paintAll();
      });
      whatIfRow.append(editBtn, delBtn);
    }
  }

  // Plan (the simulation's last year) or the last 12 months' actual average,
  // for every account without a typed amount. Saved with the simulation.
  let contributionSource = readContributionSource({ contributionSource: draft.source });

  function paintControls() {
    controls.replaceChildren();
    const toggle = (label, on, onClick) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `btn btn-sm ${on ? 'btn-accent' : 'btn-ghost'}`;
      b.textContent = label;
      b.setAttribute('aria-pressed', String(on));
      b.disabled = draft.saving;
      b.addEventListener('click', onClick);
      return b;
    };
    for (const y of HORIZONS) {
      controls.append(toggle(t('netWorth.horizon')(y), y === horizon, () => { horizon = y; paintControls(); paintProjection(); }));
    }
    const sourceGroup = document.createElement('div');
    sourceGroup.className = 'net-worth-source';
    sourceGroup.setAttribute('role', 'group');
    const sourceLabel = document.createElement('span');
    sourceLabel.className = 'net-worth-source-label';
    sourceLabel.id = 'nw-source-label';
    sourceLabel.textContent = t('netWorth.sourceLabel');
    sourceGroup.setAttribute('aria-labelledby', sourceLabel.id);
    sourceGroup.append(sourceLabel);
    for (const [src, key] of [['plan', 'sourcePlan'], ['history', 'sourceHistory']]) {
      sourceGroup.append(toggle(t(`netWorth.${key}`), contributionSource === src, () => {
        contributionSource = /** @type {'plan' | 'history'} */ (src);
        draft.source = src;
        paintControls();
        paintProjection();
      }));
    }
    sourceSlot.replaceChildren(sourceGroup);
  }

  function paintProjection() {
    paintConfigRow();
    let sc = selectedScenario();
    const input = { ...scope(), years: horizon, contribution: contributionSource };
    let proj = ask('netWorth.projection', sc ? { ...input, whatIf: sc.id } : input, dropMissingWhatIf);
    if (!proj && sc && !selectedScenario()) {
      // The scenario was dropped: the card above still lists it, and the
      // projection is drawn without it.
      sc = null;
      paintSimulation();
      proj = ask('netWorth.projection', input);
    }
    paintReadiness();
    // A failed query leaves the projection off, not showing the last paint.
    if (!proj) {
      paintBulkActions();
      projChart.replaceChildren(controls, bulkActions);
      table.replaceChildren();
      planNote.replaceChildren();
      return;
    }
    const values = pts => pts.map(p => p.total);
    const series = [
      { id: 'base', name: t('netWorth.base'), values: values(proj.base) },
      { id: 'low', name: t('netWorth.low'), values: values(proj.low) },
      { id: 'high', name: t('netWorth.high'), values: values(proj.high) },
    ];
    // A fourth line for the selected what-if scenario: same growth/account
    // set as the base line, but its own run's contributions (its last
    // simulated year under the Plan source) — the band stays on
    // Expected/Lower/Higher, none of which the scenario touches.
    const whatIfShown = Boolean(sc && proj.whatIf);
    if (whatIfShown) {
      series.push({ id: 'whatif', name: t('netWorth.whatIfSeries')(sc.name), values: values(proj.whatIf) });
    }
    paintBulkActions();
    projChart.replaceChildren(mountChart({
      toolbarStart: controls, summaryActions: bulkActions,
      id: 'nw-projection', kind: 'line', scaleControl: true, title: t('netWorth.projectionTitle'), height: 280,
      csvName: csvNameOf(t('netWorth.projectionTitle')),
      format: v => fmt(v, { decimals: 0 }),
      x: proj.base.map(p => ({ key: String(p.year), label: String(today.getFullYear() + p.year) })),
      series,
      band: { low: 'low', high: 'high', around: 'base' },
    }));
    paintTable(proj.accounts);
    paintPlanNote(proj.table, whatIfShown ? sc.name : null);
  }

  /**
   * @param {{ used: number, plan: number, actual: number, gap: boolean }} totals
   *   over the table's accounts: what the projection adds, the plan and
   *   history figures it chose between, and whether the plan adds far less
   *   than recent months did
   * @param {string | null} whatIfName  the what-if scenario drawn, if any
   */
  function paintPlanNote({ used, plan, actual }, whatIfName) {
    const money = v => fmt(v, { signed: true, decimals: 0 });
    planNote.replaceChildren(contributionSource === 'history'
      ? t('netWorth.historyNote')(money(used), money(plan))
      : t('netWorth.planNote')(money(used), money(actual)));
    // With "Last 12 months" selected, the history average above doesn't (and
    // can't) include a what-if scenario: say so, so the line and the note
    // don't look like they disagree.
    if (whatIfName && contributionSource === 'history') {
      planNote.append(` ${t('netWorth.whatIfHistoryNote')(whatIfName)}`);
    }
  }

  function numberInput({ id, field, value, placeholder, title, label, suffix = '' }) {
    const key = editKey(id, field);
    const edit = draft.edits.get(key);
    const wrap = document.createElement('div');
    wrap.className = 'net-worth-edit';
    const input = document.createElement('input');
    input.type = 'text';
    input.inputMode = 'decimal';
    input.className = 'net-worth-num';
    input.dataset.editKey = key;
    input.setAttribute('aria-label', label);
    input.value = draft.raw.has(key) ? draft.raw.get(key) : value === null ? '' : fmtNum(value, { maxDecimals: 2 });
    input.placeholder = placeholder;
    input.title = title;
    input.disabled = draft.saving;
    input.setAttribute('aria-invalid', String(!!edit && !edit.valid));
    input.setCustomValidity(edit && !edit.valid ? t('netWorth.invalidNumber') : '');
    const update = () => {
      if (!isCurrent() || draft.saving) return;
      const raw = input.value;
      if (draft.raw.get(key) === raw) return;
      draft.raw.set(key, raw);
      const parsed = raw.trim() === '' ? null : parseAmountInput(raw, { strict: true });
      const valid = parsed === null || Number.isFinite(parsed);
      const value = parsed === null ? null : round2(parsed);
      if (valid && value === savedValue(id, field)) draft.edits.delete(key);
      else draft.edits.set(key, { id, field, raw, value, valid });
      paintAll();
    };
    input.addEventListener('input', update);
    input.addEventListener('change', update);
    wrap.append(input);
    if (suffix) {
      const unit = document.createElement('span');
      unit.textContent = suffix;
      wrap.append(unit);
    }
    for (const action of ['reset', 'save']) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `btn btn-sm btn-icon ${action === 'save' && edit ? 'btn-accent' : 'btn-ghost'}`;
      btn.append(icon(action === 'save' ? 'save' : 'undo', 16));
      btn.title = t(`netWorth.${action}`);
      btn.setAttribute('aria-label', `${t(`netWorth.${action}`)}: ${label}`);
      btn.dataset.action = action;
      btn.disabled = draft.saving || !edit || (action === 'save' && !edit.valid);
      btn.addEventListener('click', () => {
        if (action === 'save') void saveEdits([key]);
        else if (isCurrent() && !draft.saving) { draft.edits.delete(key); draft.raw.delete(key); paintAll(); }
      });
      // The wrapper also exposes the tooltip when the button is disabled.
      const actionWrap = document.createElement('span');
      actionWrap.className = 'net-worth-action';
      actionWrap.title = btn.title;
      actionWrap.append(btn);
      wrap.append(actionWrap);
    }
    return wrap;
  }

  function paintBulkActions() {
    bulkActions.replaceChildren();
    const status = document.createElement('span');
    status.className = 'net-worth-draft-status';
    status.setAttribute('role', 'status');
    const count = draft.edits.size + (settingsDirty() || draft.newProfile ? 1 : 0);
    status.textContent = count ? t('netWorth.unsaved')(count) : '';
    bulkActions.append(status);
    const defaults = document.createElement('button');
    defaults.type = 'button';
    defaults.className = 'btn btn-sm btn-ghost';
    defaults.textContent = t('netWorth.useDefaults');
    defaults.title = t('netWorth.useDefaultsTip');
    defaults.dataset.action = 'use-defaults';
    defaults.disabled = draft.saving || (currentAssumptions().length === 0 && draft.edits.size === 0
      && contributionSource === 'plan' && !whatIfId);
    defaults.addEventListener('click', () => {
      if (!isCurrent() || draft.saving) return;
      draft.edits.clear();
      draft.raw.clear();
      for (const row of selectedConfig()?.accounts || []) {
        for (const field of ASSUMPTION_FIELDS) {
          if (row[field] == null) continue;
          const key = editKey(row.id, field);
          draft.edits.set(key, { id: row.id, field, raw: '', value: null, valid: true });
          draft.raw.set(key, '');
        }
      }
      contributionSource = draft.source = 'plan';
      whatIfId = draft.whatIf = null;
      paintControls();
      paintWhatIfRow();
      paintAll();
    });
    bulkActions.append(defaults);
    for (const action of ['reset', 'save']) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `btn btn-sm ${action === 'save' && isDirty() ? 'btn-accent' : 'btn-ghost'}`;
      btn.textContent = t(`netWorth.${action}All`);
      btn.dataset.action = `${action}-all`;
      btn.disabled = draft.saving || !isDirty()
        || (action === 'save' && [...draft.edits.values()].some(e => !e.valid));
      btn.addEventListener('click', () => {
        if (action === 'save') void saveEdits([...draft.edits.keys()]);
        else if (isCurrent() && !draft.saving) restoreSavedConfig();
      });
      bulkActions.append(btn);
    }
  }

  /** Paints the per-account table from the projection's `accounts` rows. */
  function paintTable(projected) {
    const focused = document.activeElement;
    const focusKey = focused?.dataset?.editKey;
    const selection = focusKey ? [focused.selectionStart, focused.selectionEnd] : null;
    table.replaceChildren();
    const thead = document.createElement('thead');
    const hr = document.createElement('tr');
    for (const txt of [t('netWorth.colAccount'), t('netWorth.colNow'), t('netWorth.colGrowth'),
      t('netWorth.colContribution'), t('netWorth.colAt')(horizon)]) {
      const th = document.createElement('th');
      th.textContent = txt;
      hr.append(th);
    }
    thead.append(hr);
    table.append(thead);
    const groups = new Map();
    const byId = new Map((state.accounts || []).map(a => [a.id, a]));
    // A row without a balance, a contribution or a rate is not shown (nor
    // counted in the note's sums).
    for (const row of projected) {
      // Keep a row visible while editing even if its draft makes it zero.
      if (!row.shown && ![...draft.edits.values()].some(e => e.id === row.id)) continue;
      const a = byId.get(row.id);
      const name = a?.name || row.id;
      const type = a?.type || 'bank';
      if (!groups.has(type)) groups.set(type, []);
      const tr = document.createElement('tr');
      tr.dataset.accountId = row.id;
      groups.get(type).push(tr);

      const nameTd = document.createElement('td');
      nameTd.textContent = name;

      const nowTd = document.createElement('td');
      nowTd.textContent = fmt(row.balance, { decimals: 0 });

      const gTd = document.createElement('td');
      gTd.append(numberInput({
        id: row.id, field: 'expectedGrowth', suffix: '%',
        value: row.growthSource === 'set' ? row.growthPct : null,
        placeholder: row.growthSource === 'interest' ? fmtNum(row.growthPct, { maxDecimals: 2 }) : '0',
        title: row.growthSource === 'interest' ? t('netWorth.fromInterest') : t('netWorth.growthTitle'),
        label: t('netWorth.growthLabel')(name),
      }));

      // The placeholder is what is used when nothing is typed; the tooltip
      // always gives the past year's average, the suggestion's source.
      const cTd = document.createElement('td');
      cTd.append(numberInput({
        id: row.id, field: 'plannedMonthly',
        value: row.contributionSource === 'set' ? row.contribution : null,
        placeholder: fmtNum(row.contribution, { decimals: 0 }),
        title: t('netWorth.contributionTitle')(fmt(row.plan, { signed: true, decimals: 0 }), fmt(row.history, { signed: true, decimals: 0 })),
        label: t('netWorth.contributionLabel')(name),
      }));

      const atTd = document.createElement('td');
      atTd.textContent = fmt(row.atHorizon, { decimals: 0 });

      if (row.loan) {
        // Past the simulated years this loan follows its repayment schedule;
        // a growth rate or contribution typed here would not be used.
        const sTd = document.createElement('td');
        sTd.colSpan = 2;
        sTd.className = 'muted';
        sTd.style.fontSize = '12.5px';
        sTd.textContent = row.loan.payoffDate
          ? t('netWorth.followsScheduleTo')(fmtMonthLang(row.loan.payoffDate.slice(0, 7)))
          : t('netWorth.followsSchedule');
        tr.append(nameTd, nowTd, sTd, atTd);
      } else {
        tr.append(nameTd, nowTd, gTd, cTd, atTd);
      }
    }
    for (const [type, rows] of groups) {
      const tbody = document.createElement('tbody');
      const groupRow = document.createElement('tr');
      groupRow.className = 'net-worth-account-group';
      const th = document.createElement('th');
      th.colSpan = 5;
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'btn btn-sm btn-ghost';
      toggle.dataset.accountType = type;
      const ids = new Set(rows.map(row => row.dataset.accountId));
      const dirty = [...draft.edits.values()].filter(e => ids.has(e.id)).length;
      const label = `${t(`netWorth.type.${type}`)} (${rows.length})${dirty ? ` · ${t('netWorth.unsaved')(dirty)}` : ''}`;
      const sync = () => {
        const collapsed = draft.collapsed.has(type);
        toggle.setAttribute('aria-expanded', String(!collapsed));
        toggle.textContent = `${collapsed ? '▸' : '▾'} ${label}`;
        rows.forEach(row => { row.hidden = collapsed; });
      };
      toggle.addEventListener('click', () => {
        if (draft.collapsed.has(type)) draft.collapsed.delete(type);
        else draft.collapsed.add(type);
        sync();
      });
      sync();
      th.append(toggle);
      groupRow.append(th);
      tbody.append(groupRow, ...rows);
      table.append(tbody);
    }
    // Repainting a live preview must not interrupt typing or move the caret.
    if (focusKey) {
      const again = [...table.querySelectorAll('input')].find(el => el.dataset.editKey === focusKey);
      if (again && !again.disabled) {
        again.focus({ preventScroll: true });
        again.setSelectionRange(...selection);
      }
    }
  }

  function rememberConfig() {
    saveChartPrefs('nw-projection', { ...loadChartPrefs('nw-projection'), simulationId: draft.selectedId });
  }

  function restoreSavedConfig() {
    draft.edits.clear();
    draft.raw.clear();
    draft.newProfile = false;
    contributionSource = draft.source = selectedConfig()?.contribution ?? 'plan';
    whatIfId = draft.whatIf = selectedConfig()?.whatIf ?? null;
    if (whatIfId && !listScenarios().some(sc => sc.id === whatIfId)) whatIfId = draft.whatIf = null;
    paintControls();
    paintWhatIfRow();
    paintAll();
  }

  async function requestConfigName(initial = '', exceptId = null) {
    let value = initial;
    while (isCurrent()) {
      const raw = await promptDialog(t('netWorth.simulationName'), {
        title: t('netWorth.saveSimulation'), defaultValue: value, okLabel: t('netWorth.save'),
      });
      if (raw === null || !isCurrent()) return null;
      value = raw.trim();
      if (value && !listConfigs().some(config => config.id !== exceptId && config.name.toLowerCase() === value.toLowerCase())) return value;
      await alertDialog(t('netWorth.simulationNameRequired'));
    }
    return null;
  }

  async function saveEdits(keys, asCopy = false) {
    if (!isCurrent() || draft.saving) return;
    const edits = keys.map(key => draft.edits.get(key)).filter(Boolean);
    if (edits.some(edit => !edit.valid) || (!edits.length && !settingsDirty() && !draft.newProfile && !asCopy)) return;
    const saved = selectedConfig();
    // Lock before the naming dialog too: one click cannot start two saves.
    draft.saving = true;
    paintAll();
    const name = saved && !asCopy ? saved.name : await requestConfigName(asCopy && saved ? t('netWorth.copySimulationName')(saved.name) : '');
    if (!name || !isCurrent()) {
      draft.saving = false;
      if (isCurrent()) draft.repaint();
      return;
    }
    const config = { id: saved && !asCopy ? saved.id : generateId(), name,
      accounts: editedAssumptions(saved?.accounts || [], edits), contribution: draft.source, whatIf: draft.whatIf };
    const result = await persistConfigurationList('netWorthSimulations', { upsert: config });
    draft.saving = false;
    if (!isCurrent()) return;
    if (result) {
      draft.selectedId = config.id;
      draft.newProfile = false;
      keys.forEach(key => { draft.edits.delete(key); draft.raw.delete(key); });
      rememberConfig();
    }
    draft.repaint();
  }

  function paintConfigRow() {
    configRow.replaceChildren();
    const label = document.createElement('label');
    label.className = 'net-worth-source-label';
    label.textContent = t('netWorth.simulation');
    label.htmlFor = 'nw-simulation-config';
    const select = document.createElement('select');
    select.id = label.htmlFor;
    select.className = 'form-input';
    const choices = [{ id: '', name: t('netWorth.actualBudget') }, ...listConfigs()];
    if (!draft.selectedId && isDirty()) choices.push({ id: '__draft__', name: t('netWorth.unsavedSimulation') });
    for (const config of choices) {
      const option = document.createElement('option');
      option.value = config.id;
      option.textContent = config.name;
      select.append(option);
    }
    select.value = draft.selectedId ?? (isDirty() ? '__draft__' : '');
    select.disabled = draft.saving;
    select.addEventListener('change', async () => {
      const id = select.value;
      if (id === '__draft__') return;
      if (isDirty() && !await confirmDialog(t('common.discardConfirm'))) { paintConfigRow(); return; }
      if (!isCurrent() || draft.saving) return;
      draft.selectedId = id || null;
      rememberConfig();
      restoreSavedConfig();
    });
    configRow.append(label, select);
    const action = (key, fn, disabled = false) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'btn btn-sm btn-ghost';
      button.textContent = t(`netWorth.${key}`);
      button.disabled = draft.saving || disabled;
      button.addEventListener('click', fn);
      configRow.append(button);
    };
    action('newSimulation', async () => {
      if (isDirty() && !await confirmDialog(t('common.discardConfirm'))) return;
      if (!isCurrent() || draft.saving) return;
      draft.selectedId = null;
      restoreSavedConfig();
      draft.newProfile = true;
      paintAll();
    });
    action('duplicateSimulation', () => saveEdits([...draft.edits.keys()], true), [...draft.edits.values()].some(edit => !edit.valid));
    action('renameSimulation', async () => {
      const saved = selectedConfig();
      if (!saved || !isCurrent() || draft.saving) return;
      draft.saving = true;
      paintAll();
      const name = await requestConfigName(saved.name, saved.id);
      if (name && isCurrent()) await persistConfigurationList('netWorthSimulations', { upsert: { ...saved, name } });
      draft.saving = false;
      if (isCurrent()) draft.repaint();
    }, !selectedConfig());
    action('deleteSimulation', async () => {
      const saved = selectedConfig();
      if (!saved || !await confirmDialog(t('netWorth.deleteSimulationConfirm')(saved.name), { danger: true, okLabel: t('common.delete') })) return;
      if (!isCurrent() || draft.saving) return;
      draft.saving = true;
      paintAll();
      const ok = await persistConfigurationList('netWorthSimulations', { removeId: saved.id });
      draft.saving = false;
      if (!isCurrent()) return;
      if (ok) { draft.selectedId = null; rememberConfig(); restoreSavedConfig(); }
      else draft.repaint();
    }, !selectedConfig());
  }

  function paintAll() {
    for (const control of [...whatIfRow.querySelectorAll('select, button'), ...sourceSlot.querySelectorAll('button'), ...controls.querySelectorAll('button')]) control.disabled = draft.saving;
    paintSimulation();
    paintProjection();
  }

  paintControls();
  paintWhatIfRow();
  paintAll();
  container.replaceChildren(page);
}
