// js/ui/guest-budget-picker.js — picker shown to guest-session users.
// Offers: Load example project / Start empty / Leave guest mode. Writes the
// chosen data into the in-memory guest adapter, then loads it through
// loadBudgetIntoState() so the dashboard appears.

import { openSheet } from './sheet.js';
import { alertDialog, confirmDialog } from './dialog.js';
import { toast } from './toast.js';
import { t } from './i18n.js';
import { state, now } from '../app.js';
import { loadBudgetIntoState } from '../state/load-budget.js';
import { beginBudgetSession, holdBudget, releaseBudget } from '../state/budget-session.js';
import {
  GUEST_FOLDER,
  resetGuestMemory,
  replaceGuestMemory,
  monthsToShift,
  shiftBudgetFiles,
} from '../storage/guest-adapter.js';
import { migrateBundle } from '../storage/bundle-migrations.js';
import { readBudgetFile, BUDGET_FILE_ACCEPT } from './read-budget-file.js';
import { offerBudgetImportRetry } from './budget-import-error.js';

const EXAMPLE_FILES = [
  'envelopes.json',
  'budget-items.json',
  'transactions.json',
  'accounts.json',
  'budget-meta.json',
  'envelope-templates.json',
];

function resetAppState() {
  state.transactions = [];
  state.envelopes = [];
  state.budgetItems = [];
  state.accounts = [];
  state.envelopeTemplates = [];
  state.meta = null;
}

async function loadExampleIntoGuestMemory() {
  const fetched = await Promise.all(EXAMPLE_FILES.map(async (filename) => {
    const res = await fetch(`/budgets/example-project/${filename}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`${filename}: ${res.status} ${res.statusText}`);
    const data = await res.json();
    return { filename, data };
  }));
  // The example is a dated snapshot; move it forward so the demo's latest
  // activity is in the current month instead of showing an empty month.
  const txFile = fetched.find(f => f.filename === 'transactions.json');
  const shifted = shiftBudgetFiles(fetched, monthsToShift(txFile?.data, now()));
  // Guest memory is replaced here, while `state` still holds the old guest
  // budget under the same folder object. Only the session tells them apart, so
  // end the old one now: a command still queued for it is then refused instead
  // of writing the old rows into the example (js/session/browser-session.js).
  // Held as well, so no new command does either, until the load that follows
  // (with a session of its own) publishes the example.
  beginBudgetSession();
  const held = holdBudget();
  try {
    replaceGuestMemory(shifted);
  } catch (err) {
    releaseBudget(held);
    throw err;
  }
}

async function confirmIfHasData() {
  if (!state.meta) return true;
  return confirmDialog(t('guestPicker.replaceConfirm'), {
    title: t('loadBudget.title'),
    confirmText: t('guestPicker.replaceConfirmCta'),
  });
}

async function startEmpty(closeHost) {
  if (!(await confirmIfHasData())) return;
  closeHost?.();
  resetGuestMemory();
  resetAppState();
  const result = await loadBudgetIntoState(GUEST_FOLDER);
  if (!result.loaded && result.wizard) {
    const appContainer = document.getElementById('app');
    const { runSetupWizard } = await import('../setup.js');
    await runSetupWizard(appContainer, GUEST_FOLDER, result.session);
  }
  toast(t('loadBudget.guestToast'));
}

async function loadExample(closeHost) {
  if (!(await confirmIfHasData())) return;
  try {
    await loadExampleIntoGuestMemory();
  } catch (err) {
    await alertDialog(
      t('guestPicker.loadExampleFailed')(err?.message || String(err)),
      { title: t('guestPicker.loadExample') },
    );
    return;
  }
  closeHost?.();
  resetAppState();
  await loadBudgetIntoState(GUEST_FOLDER);
  toast(t('guestPicker.loadExampleSuccess'));
}

// Open an export (the JSON bundle or the Settings ZIP) into the guest tab,
// the same files the cloud picker imports (owner decision 5, 2026-10-05).
const FILE_OF_KIND = {
  envelopes: 'envelopes.json',
  budgetItems: 'budget-items.json',
  transactions: 'transactions.json',
  accounts: 'accounts.json',
  envelopeTemplates: 'envelope-templates.json',
  meta: 'budget-meta.json',
};

function pickFile() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = BUDGET_FILE_ACCEPT;
  input.style.display = 'none';
  document.body.append(input);
  return new Promise((resolve) => {
    input.addEventListener('change', () => { resolve(input.files?.[0] || null); input.remove(); }, { once: true });
    input.addEventListener('cancel', () => { resolve(null); input.remove(); }, { once: true });
    input.click();
  });
}

async function openExportFile(closeHost) {
  const file = await pickFile();
  if (!file) return;
  let items;
  try {
    const read = await readBudgetFile(file);
    if (!read.ok) {
      if (await offerBudgetImportRetry(read)) return openExportFile(closeHost);
      return;
    }
    // Never carry the exporter's AI consent into this tab (as the cloud import).
    const { bundle } = migrateBundle(read.bundle);
    const { ai: _dropped, ...meta } = bundle.meta || {};
    items = Object.entries(FILE_OF_KIND).map(([kind, filename]) => ({
      filename, data: kind === 'meta' ? meta : (Array.isArray(bundle[kind]) ? bundle[kind] : []),
    }));
  } catch (err) {
    await alertDialog(t('cloudPicker.importFailed')(err?.message || String(err)), { title: t('guestPicker.openFile') });
    return;
  }
  if (!(await confirmIfHasData())) return;
  beginBudgetSession();
  const held = holdBudget();
  try {
    replaceGuestMemory(items);
  } catch (err) {
    releaseBudget(held);
    await alertDialog(t('cloudPicker.importFailed')(err?.message || String(err)), { title: t('guestPicker.openFile') });
    return;
  }
  closeHost?.();
  resetAppState();
  await loadBudgetIntoState(GUEST_FOLDER);
  toast(t('guestPicker.openFileSuccess'));
}

function makeButton(label, cls, onClick) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = `btn ${cls}`;
  btn.style.cssText = 'width:100%;justify-content:center;margin-bottom:8px;';
  btn.textContent = label;
  btn.addEventListener('click', onClick);
  return btn;
}

export function openGuestBudgetPicker() {
  const content = document.createElement('div');
  let sheetHandle;
  const close = () => sheetHandle?.close();

  const hint = document.createElement('p');
  hint.style.cssText = 'color:var(--muted);font-size:13px;margin:0 0 16px;line-height:1.5;';
  hint.textContent = t('guestPicker.hint');
  content.append(hint);

  content.append(makeButton(
    t('guestPicker.loadExample'), 'btn-accent',
    () => loadExample(close),
  ));
  content.append(makeButton(
    t('guestPicker.startEmpty'), 'btn-ghost',
    () => startEmpty(close),
  ));
  content.append(makeButton(
    t('guestPicker.openFile'), 'btn-ghost',
    () => openExportFile(close),
  ));
  const formats = document.createElement('p');
  formats.className = 'muted';
  formats.textContent = t('budgetImport.formats');
  content.append(formats);

  const leaveGuest = makeButton(t('guestPicker.leaveGuest'), 'btn-ghost', () => {
    window.location.assign('/');
  });
  leaveGuest.style.marginTop = '16px';
  content.append(leaveGuest);

  sheetHandle = openSheet({ title: t('loadBudget.title'), content });
}
