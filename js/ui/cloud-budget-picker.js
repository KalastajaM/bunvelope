// js/ui/cloud-budget-picker.js — cloud equivalent of load-budget-dialog.
// Lists the signed-in user's budgets, lets them create / open / rename /
// delete / import / export, then hands the chosen budget to
// loadBudgetIntoState().

import { openSheet } from './sheet.js';
import { alertDialog, confirmDialog, promptDialog } from './dialog.js';
import { toast } from './toast.js';
import { t } from './i18n.js';
import { downloadBudgetZip, sanitiseFilename } from './download.js';
import { skeletonCard } from './skeleton.js';
import { state, now } from '../app.js';
import { isoDate } from '../core/context.js';
import { flushWrites } from '../data.js';
import { loadBudgetIntoState } from '../state/load-budget.js';
import {
  listCloudBudgets,
  createCloudBudget,
  renameCloudBudget,
  deleteCloudBudget,
  logout,
  loadBudgetData as apiLoadBudgetData,
} from '../storage/api-adapter.js';
import {
  openBudgetFolder,
  loadBudgetData as fsapiLoadBudgetData,
} from '../storage/fsapi-adapter.js';
import { readBudgetFile, BUDGET_FILE_ACCEPT } from './read-budget-file.js';
import { offerBudgetImportRetry } from './budget-import-error.js';
import {
  importBundleAsNewBudget,
  exportBudgetAsBundle,
} from '../storage/transfer.js';

function makeCloudRef(b) {
  return { kind: 'cloud', budgetId: b.id, version: b.version, name: b.name };
}

async function openBudget(b, closeHost) {
  try {
    // Drain the outgoing budget's queued writes before its state is cleared:
    // a debounced save still in flight would otherwise be lost, or land after
    // the switch. Same step the local folder swap takes.
    if (state.budgetFolder) await flushWrites();
    closeHost?.();
    state.transactions = [];
    state.envelopes = [];
    state.budgetItems = [];
    state.accounts = [];
    state.envelopeTemplates = [];
    state.meta = null;
    const ref = makeCloudRef(b);
    const result = await loadBudgetIntoState(ref);
    if (!result.loaded && result.wizard) {
      const appContainer = document.getElementById('app');
      const { runSetupWizard } = await import('../setup.js');
      await runSetupWizard(appContainer, ref, result.session);
    }
  } catch (err) {
    const msg = err?.message || String(err);
    await alertDialog(t('cloudPicker.openFailed')(msg), { title: t('cloudPicker.openTitle') });
  }
}

async function promptCreate(onDone) {
  // The setup wizard collects the budget name in Step 1, so a second
  // prompt here is redundant. Create with a placeholder that doFinish
  // renames once the user has picked a real name.
  try {
    const b = await createCloudBudget(t('cloudPicker.placeholderName'));
    onDone?.(b);
  } catch (err) {
    await alertDialog(t('cloudPicker.createFailed')(err?.message || err), { title: t('cloudPicker.createTitle') });
  }
}

async function promptRename(b, onDone) {
  const next = window.prompt(t('cloudPicker.renamePrompt'), b.name);
  if (!next || !next.trim() || next.trim() === b.name) return;
  try {
    const upd = await renameCloudBudget(b.id, next.trim());
    onDone?.(upd);
  } catch (err) {
    await alertDialog(t('cloudPicker.renameFailed')(err?.message || err), { title: t('cloudPicker.rename') });
  }
}

// Two steps, since nothing brings a deleted budget back from the UI: the
// first offers to export it (the same JSON file Export saves) and can be run
// again after the export; the second asks for the budget's name typed out.
export async function confirmDelete(b, onDone) {
  const title = t('cloudPicker.deleteConfirmTitle');
  for (;;) {
    const choice = await confirmDialog(t('cloudPicker.deleteConfirm')(b.name), {
      title,
      okLabel: t('cloudPicker.deleteContinue'),
      dismissLabel: t('cloudPicker.deleteExportFirst'),
      danger: true,
    });
    if (choice === null) {
      if (await exportBudget(b)) toast(t('cloudPicker.deleteExported'));
      continue;
    }
    if (!choice) return;
    break;
  }
  const typed = await promptDialog(t('cloudPicker.deleteTypeName')(b.name), {
    title,
    okLabel: t('cloudPicker.deleteTitle'),
    placeholder: b.name,
  });
  if (typed === null) return;
  if (typed.trim() !== String(b.name).trim()) {
    await alertDialog(t('cloudPicker.deleteNameMismatch'), { title });
    return;
  }
  try {
    await deleteCloudBudget(b.id);
    onDone?.();
  } catch (err) {
    await alertDialog(t('cloudPicker.deleteFailed')(err?.message || err), { title: t('cloudPicker.deleteTitle') });
  }
}

async function importFromFolder(onDone) {
  let bundle;
  try {
    const folder = await openBudgetFolder();
    bundle = await fsapiLoadBudgetData(folder);
  } catch (err) {
    if (err?.name === 'AbortError') return; // user closed the picker
    await alertDialog(t('cloudPicker.importFailed')(err?.message || err),
      { title: t('cloudPicker.importFolder') });
    return;
  }
  await uploadBundle(bundle, bundle?.meta?.name, onDone);
}

// The JSON bundle Export saves, or the ZIP the Settings export saves (owner
// decision 5, 2026-10-05): one button, the file's first bytes decide.
async function importFromFile(onDone) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = BUDGET_FILE_ACCEPT;
  input.style.display = 'none';
  document.body.append(input);
  const file = await new Promise((resolve) => {
    input.addEventListener('change', () => resolve(input.files?.[0] || null),
      { once: true });
    input.addEventListener('cancel', () => resolve(null), { once: true });
    input.click();
  });
  input.remove();
  if (!file) return;

  let read;
  try {
    read = await readBudgetFile(file);
  } catch (err) {
    read = { ok: false, reason: 'unreadable', errors: [err?.message || String(err)] };
  }
  if (!read.ok) {
    if (await offerBudgetImportRetry(read)) return importFromFile(onDone);
    return;
  }

  await uploadBundle(read.bundle, read.bundle?.meta?.name, onDone);
}

async function uploadBundle(bundle, defaultName, onDone) {
  const suggested = (defaultName && String(defaultName).trim())
    || t('cloudPicker.importDefaultName');
  const name = await promptDialog(t('cloudPicker.importPromptName'), {
    title: t('cloudPicker.importFile'),
    defaultValue: suggested,
  });
  if (!name || !name.trim()) return;

  try {
    const created = await importBundleAsNewBudget(bundle, name.trim());
    const n = Array.isArray(bundle.transactions) ? bundle.transactions.length : 0;
    toast(t('cloudPicker.importSuccess')(n, created.name));
    onDone?.(created);
  } catch (err) {
    await alertDialog(t('cloudPicker.importFailed')(err?.message || err),
      { title: t('cloudPicker.importFolder') });
  }
}

/** Save the budget as a compressed, self-contained ZIP; true when the file was handed over. */
async function exportBudget(b) {
  try {
    const bundle = await exportBudgetAsBundle(b.id);
    const today = isoDate(now());
    const filename = `bunvelope-${sanitiseFilename(b.name)}-${today}.zip`;
    await downloadBudgetZip(filename, bundle);
    return true;
  } catch (err) {
    await alertDialog(t('cloudPicker.exportFailed')(err?.message || err),
      { title: t('cloudPicker.export') });
    return false;
  }
}

async function duplicateBudget(b, onDone) {
  const suggested = t('cloudPicker.duplicateDefaultName')(b.name);
  const name = window.prompt(t('cloudPicker.duplicatePromptName'), suggested);
  if (!name || !name.trim()) return;
  try {
    // Go through the adapter so encrypted blobs are decrypted before we
    // hand them to importBundleAsNewBudget (which re-encrypts on write).
    // loadBudgetData also validates the schema, which a duplicate needs;
    // exportBudgetAsBundle decrypts too but is meant for file backups.
    const bundle = await apiLoadBudgetData(makeCloudRef(b));
    const created = await importBundleAsNewBudget(bundle, name.trim());
    toast(t('cloudPicker.duplicateSuccess')(created.name));
    onDone?.(created);
  } catch (err) {
    await alertDialog(t('cloudPicker.duplicateFailed')(err?.message || err),
      { title: t('cloudPicker.duplicate') });
  }
}

function fmtDate(iso) {
  try { return new Date(iso).toLocaleString(); } catch { return iso; }
}

// A stable colour per budget, picked from its id, so two budgets with
// similar names (a real one and its test copy) differ at a glance.
const BUDGET_TINTS = ['--mint', '--sky', '--peach', '--lilac', '--butter', '--rose'];
function budgetTint(id) {
  let h = 0;
  for (const ch of String(id)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return `var(${BUDGET_TINTS[h % BUDGET_TINTS.length]})`;
}

async function buildList(container, closeHost) {
  // Placeholder rows while the list fetch is in flight — this container
  // was previously left untouched (and so empty on first paint) until
  // listCloudBudgets() resolved.
  container.innerHTML = '';
  container.append(skeletonCard({ lineWidth: '40%', blockHeight: 44 }));
  container.append(skeletonCard({ lineWidth: '32%', blockHeight: 44 }));

  let budgets = [];
  try {
    budgets = await listCloudBudgets();
    if (!Array.isArray(budgets)) budgets = [];
  } catch (err) {
    container.innerHTML = '';
    const p = document.createElement('p');
    p.style.color = 'var(--danger)';
    p.textContent = t('cloudPicker.listFailed')(err?.message || err);
    container.append(p);
    return;
  }

  container.innerHTML = '';

  if (budgets.length === 0) {
    const empty = document.createElement('p');
    empty.style.cssText = 'color:var(--muted); text-align:center; padding:16px 0;';
    empty.textContent = t('cloudPicker.empty');
    container.append(empty);
    return;
  }

  for (const b of budgets) {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;flex-direction:column;gap:8px;padding:10px 12px;border:1px solid var(--border);border-radius:10px;margin-bottom:8px;';
    row.style.borderLeft = `6px solid ${budgetTint(b.id)}`;
    const isOpen = state.budgetFolder?.kind === 'cloud' && state.budgetFolder.budgetId === b.id;

    const main = document.createElement('button');
    main.type = 'button';
    main.style.cssText = 'display:flex;flex-direction:column;align-items:flex-start;gap:2px;background:transparent;border:none;padding:0;text-align:left;cursor:pointer;font:inherit;color:var(--ink);width:100%;';
    const name = document.createElement('span');
    name.style.cssText = 'font-weight:600;';
    name.textContent = b.name;
    if (isOpen) {
      const chip = document.createElement('span');
      chip.className = 'chip';
      chip.style.cssText = 'margin-left:8px;font-size:11px;font-weight:500;';
      chip.textContent = t('cloudPicker.openNow');
      name.append(chip);
    }
    main.append(name);
    const sub = document.createElement('span');
    sub.style.cssText = 'font-size:12px;color:var(--muted);';
    sub.textContent = t('cloudPicker.lastOpened')(fmtDate(b.last_opened_at));
    main.append(sub);
    main.addEventListener('click', () => openBudget(b, closeHost));
    row.append(main);

    const actions = document.createElement('div');
    actions.style.cssText = 'display:flex;flex-wrap:wrap;align-items:center;gap:6px;';

    // Delete sits apart on the left, spelled out, so it is never the button
    // next to Rename; confirmDelete still asks before anything happens.
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'btn btn-ghost';
    del.style.cssText = 'padding:4px 10px;font-size:13px;color:var(--danger-text);margin-right:auto;';
    del.textContent = t('cloudPicker.deleteButton');
    del.title = t('cloudPicker.deleteTitle');
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      confirmDelete(b, () => buildList(container, closeHost));
    });
    actions.append(del);

    const exp = document.createElement('button');
    exp.type = 'button';
    exp.className = 'btn btn-ghost';
    exp.style.cssText = 'padding:4px 10px;font-size:14px;';
    exp.textContent = t('cloudPicker.export');
    exp.addEventListener('click', (e) => {
      e.stopPropagation();
      exportBudget(b);
    });
    actions.append(exp);

    const dup = document.createElement('button');
    dup.type = 'button';
    dup.className = 'btn btn-ghost';
    dup.style.cssText = 'padding:4px 10px;font-size:14px;';
    dup.textContent = t('cloudPicker.duplicate');
    dup.addEventListener('click', (e) => {
      e.stopPropagation();
      duplicateBudget(b, () => buildList(container, closeHost));
    });
    actions.append(dup);

    const ren = document.createElement('button');
    ren.type = 'button';
    ren.className = 'btn btn-ghost';
    ren.style.cssText = 'padding:4px 10px;font-size:14px;';
    ren.textContent = t('cloudPicker.rename');
    ren.addEventListener('click', (e) => {
      e.stopPropagation();
      promptRename(b, () => buildList(container, closeHost));
    });
    actions.append(ren);

    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'btn btn-accent';
    open.style.cssText = 'padding:4px 12px;font-size:14px;';
    open.textContent = t('cloudPicker.open');
    open.addEventListener('click', (e) => {
      e.stopPropagation();
      openBudget(b, closeHost);
    });
    actions.append(open);
    row.append(actions);

    container.append(row);
  }
}

function makeCreateButton(onAfter) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn btn-accent';
  btn.style.cssText = 'width:100%;justify-content:center;margin-bottom:8px;';
  btn.textContent = t('cloudPicker.newBudget');
  btn.addEventListener('click', () => promptCreate(onAfter));
  return btn;
}

function makeImportRow(onAfter) {
  const wrap = document.createElement('div');
  wrap.style.cssText = 'display:flex;gap:8px;margin-bottom:16px;';

  const fsapiAvailable = typeof window !== 'undefined'
    && 'showDirectoryPicker' in window;

  const folderBtn = document.createElement('button');
  folderBtn.type = 'button';
  folderBtn.className = 'btn btn-ghost';
  folderBtn.style.cssText = 'flex:1;justify-content:center;font-size:13px;';
  folderBtn.textContent = t('cloudPicker.importFolder');
  if (!fsapiAvailable) {
    folderBtn.disabled = true;
    folderBtn.title = t('cloudPicker.importFolderUnavailable');
    folderBtn.style.opacity = '0.5';
    folderBtn.style.cursor = 'not-allowed';
  } else {
    folderBtn.addEventListener('click', () => importFromFolder(onAfter));
  }
  wrap.append(folderBtn);

  const fileBtn = document.createElement('button');
  fileBtn.type = 'button';
  fileBtn.className = 'btn btn-ghost';
  fileBtn.style.cssText = 'flex:1;justify-content:center;font-size:13px;';
  fileBtn.textContent = t('cloudPicker.importFile');
  fileBtn.title = t('budgetImport.formats');
  fileBtn.addEventListener('click', () => importFromFile(onAfter));
  wrap.append(fileBtn);

  return wrap;
}

function makeSignOutButton() {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn btn-ghost';
  btn.style.cssText = 'width:100%;justify-content:center;margin-top:16px;font-size:13px;';
  btn.textContent = t('cloudPicker.signOut');
  btn.addEventListener('click', async () => {
    try { await logout(); } catch { /* still reload */ }
    window.location.assign('/');
  });
  return btn;
}

/**
 * Reopen the budget this user opened last, so a reload or a new tab lands
 * back in it instead of on the picker. The server stamps `last_opened_at` on
 * every open, so this needs no client-side memory and follows the user across
 * browsers.
 *
 * Returns true when a budget was loaded. On false the caller shows the
 * picker: no budgets yet, a budget that still needs the setup wizard (the
 * picker is where that starts), or any failure, which also gets a toast.
 */
export async function reopenLastBudget() {
  let budgets;
  try {
    budgets = await listCloudBudgets();
  } catch {
    return false;
  }
  const opened = (budgets || []).filter(b => b?.last_opened_at);
  if (!opened.length) return false;
  const last = opened.reduce((a, b) =>
    (Date.parse(b.last_opened_at) > Date.parse(a.last_opened_at) ? b : a));
  try {
    const result = await loadBudgetIntoState(makeCloudRef(last));
    if (result.loaded) return true;
  } catch (err) {
    console.warn('[bunvelope] could not reopen the last budget:', err);
    toast(t('cloudPicker.reopenFailed')(last.name));
  }
  state.budgetFolder = null;
  return false;
}

/**
 * Render the cloud picker into an existing container (welcome-screen path).
 */
export function renderCloudPickerInto(container, { onClose } = {}) {
  container.innerHTML = '';
  const list = document.createElement('div');
  const refreshList = () => buildList(list, onClose);
  container.append(makeCreateButton((b) => openBudget(b, onClose)));
  container.append(makeImportRow(refreshList));
  container.append(list);
  container.append(makeSignOutButton());
  buildList(list, onClose);
}

/**
 * Open the cloud picker as a sheet (used from the dashboard header).
 */
export function openCloudBudgetPicker() {
  const content = document.createElement('div');
  let sheetHandle;
  const closeDialog = () => sheetHandle?.close();
  const list = document.createElement('div');
  const refreshList = () => buildList(list, closeDialog);
  content.append(makeCreateButton((b) => openBudget(b, closeDialog)));
  content.append(makeImportRow(refreshList));
  content.append(list);
  content.append(makeSignOutButton());
  buildList(list, closeDialog);
  sheetHandle = openSheet({ title: t('loadBudget.title'), content });
}
