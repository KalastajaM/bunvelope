// js/ui/load-budget-dialog.js — Load / swap active budget UI.
// Lets the user pick a new folder or jump to a recently opened budget.
// Used in two places:
//   - Status bar budget-name button → shown as a sheet.
//   - Welcome screen on startup → mounted inline into the welcome card.
// Before swapping an already-loaded budget it drains pending writes so the
// outgoing budget is safely persisted, then replaces in-memory state via
// loadBudgetIntoState.

import { openSheet } from './sheet.js';
import { alertDialog } from './dialog.js';
import { openBudgetFolder, flushWrites } from '../data.js';
import { state } from '../app.js';
import { listRecentBudgets, removeRecentBudget } from '../state/recent-budgets.js';
import { loadBudgetIntoState } from '../state/load-budget.js';
import { t, fmtDateLang } from './i18n.js';
import { skeletonCard } from './skeleton.js';

// Show the 5 most recent at a time; scroll for the rest (cap in
// recent-budgets.js guards total storage).
const VISIBLE_ROWS = 5;
const ROW_HEIGHT_PX = 56; // ~row height including margin

async function ensureReadwrite(handle) {
  if (typeof handle.queryPermission !== 'function') return true;
  const opts = { mode: 'readwrite' };
  const current = await handle.queryPermission(opts);
  if (current === 'granted') return true;
  const asked = await handle.requestPermission(opts);
  return asked === 'granted';
}

async function runWizardIfNeeded(handle, session) {
  const appContainer = document.getElementById('app');
  if (!appContainer) return;
  const { runSetupWizard } = await import('../setup.js');
  await runSetupWizard(appContainer, handle, session);
}

async function performSwap(newHandle, closeHost) {
  try {
    const ok = await ensureReadwrite(newHandle);
    if (!ok) {
      await alertDialog(t('loadBudget.permissionDenied'), { title: t('loadBudget.title') });
      return;
    }
    if (state.budgetFolder) await flushWrites();
    closeHost?.();

    // Clear outgoing state so a mid-load failure can't leave mixed data on
    // screen. loadBudgetIntoState() reassigns these with the new budget.
    state.transactions = [];
    state.envelopes = [];
    state.budgetItems = [];
    state.accounts = [];
    state.envelopeTemplates = [];
    state.meta = null;

    const result = await loadBudgetIntoState(newHandle);
    if (!result.loaded && result.wizard) {
      await runWizardIfNeeded(newHandle, result.session);
    }
  } catch (err) {
    if (err && err.name === 'AbortError') return;
    const msg = err && err.message ? err.message : String(err);
    await alertDialog(
      t('loadBudget.loadFailed').replace('{msg}', msg),
      { title: t('loadBudget.title') },
    );
  }
}

async function isCurrentFolder(handle) {
  if (!state.budgetFolder || !handle) return false;
  try { return await state.budgetFolder.isSameEntry(handle); }
  catch { return false; }
}

function makeOpenFolderButton(onSwap) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn btn-accent';
  btn.style.cssText = 'width:100%;justify-content:center;margin-bottom:16px;';
  btn.textContent = t('loadBudget.openFolder');
  btn.addEventListener('click', async () => {
    try {
      const handle = await openBudgetFolder();
      await onSwap(handle);
    } catch (err) {
      if (err && err.name === 'AbortError') return;
      const msg = err && err.message ? err.message : String(err);
      await alertDialog(
        t('loadBudget.loadFailed').replace('{msg}', msg),
        { title: t('loadBudget.title') },
      );
    }
  });
  return btn;
}

async function buildRecentList(container, onSwap) {
  // Placeholder while the IndexedDB read resolves — the container was
  // cleared and then left empty across the await.
  container.innerHTML = '';
  const placeholder = skeletonCard({ lineWidth: '35%', blockHeight: 44 });
  container.append(placeholder);

  const recents = await listRecentBudgets();
  placeholder.remove();
  if (recents.length === 0) return;

  const header = document.createElement('div');
  header.textContent = t('loadBudget.recent');
  header.style.cssText = 'font-size:12px;text-transform:uppercase;letter-spacing:0.08em;color:var(--muted);margin:8px 0 8px;';
  container.append(header);

  const scroll = document.createElement('div');
  if (recents.length > VISIBLE_ROWS) {
    scroll.style.cssText = `max-height:${VISIBLE_ROWS * ROW_HEIGHT_PX}px;overflow-y:auto;padding-right:4px;`;
  }
  container.append(scroll);

  for (const entry of recents) {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:10px 12px;border:1px solid var(--border);border-radius:10px;margin-bottom:8px;';

    const isCurrent = await isCurrentFolder(entry.handle);

    const main = document.createElement('button');
    main.type = 'button';
    main.style.cssText = 'flex:1;display:flex;flex-direction:column;align-items:flex-start;gap:2px;background:transparent;border:none;padding:0;text-align:left;cursor:pointer;font:inherit;color:var(--ink);';
    if (isCurrent) {
      main.disabled = true;
      main.style.cursor = 'default';
      main.style.opacity = '0.6';
    }

    const name = document.createElement('span');
    name.textContent = entry.name + (isCurrent ? ' ' + t('loadBudget.current') : '');
    name.style.cssText = 'font-weight:600;';
    main.append(name);

    const sub = document.createElement('span');
    sub.textContent = fmtDateLang(new Date(entry.lastOpenedAt).toISOString());
    sub.style.cssText = 'font-size:12px;color:var(--muted);';
    main.append(sub);

    if (!isCurrent) {
      main.addEventListener('click', () => onSwap(entry.handle));
    }
    row.append(main);

    const rm = document.createElement('button');
    rm.type = 'button';
    rm.className = 'btn btn-ghost';
    rm.style.cssText = 'padding:4px 10px;font-size:14px;';
    rm.textContent = '×';
    rm.title = t('loadBudget.remove');
    rm.setAttribute('aria-label', t('loadBudget.remove'));
    rm.addEventListener('click', async (e) => {
      e.stopPropagation();
      await removeRecentBudget(entry.id);
      await buildRecentList(container, onSwap);
    });
    row.append(rm);

    scroll.append(row);
  }
}

/**
 * Build the load-budget content (primary button + recent list) into an
 * existing container. Used by the welcome screen, where the layout frames
 * the content directly rather than via a sheet.
 */
export function renderLoadBudgetInto(container, { onClose } = {}) {
  container.innerHTML = '';
  const onSwap = (handle) => performSwap(handle, onClose);
  container.append(makeOpenFolderButton(onSwap));
  const list = document.createElement('div');
  container.append(list);
  buildRecentList(list, onSwap);
}

export function openLoadBudgetDialog() {
  const content = document.createElement('div');
  let sheetHandle;
  const closeDialog = () => sheetHandle?.close();
  const onSwap = (handle) => performSwap(handle, closeDialog);

  content.append(makeOpenFolderButton(onSwap));
  const list = document.createElement('div');
  content.append(list);
  buildRecentList(list, onSwap);

  sheetHandle = openSheet({ title: t('loadBudget.title'), content });
}
