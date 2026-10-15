import { featureEnabled } from './ui/features.js';
import { backups } from './state/backup-service.js';
import { updateBackupIndicator } from './ui/backup-status.js';
import { writeBatch } from './data.js';
import { lensTransactions, normalizeLens, normalizeHorizon, DEFAULT_LENS, DEFAULT_HORIZON, LENS_TODAY, LENS_FORECAST, resolveHorizonDate, txAbsAmount, planItemsAsOf } from './engine.js';
import { escHtml, fmt } from './utils.js';
import { openSheet, hasOpenSheet, requestCloseTopSheet } from './ui/sheet.js';
import { moneyEl } from './ui/money.js';
import { generateId } from './import.js';
// Dashboard is the landing page on every load, so it stays eager. The other
// eleven pages are lazy — see the page registry below.
import { render as renderDashboard, renderDetailedInsights } from './pages/dashboard.js';
import { openFillEnvelopes } from './pages/fill-envelopes.js';
import { skeletonCard } from './ui/skeleton.js';
import { buildShell, highlightActive, applyPrefs, relabelShell } from './ui/shell.js';
import { observeScrollCues } from './ui/scroll-cue.js';
import { setNoBudgetChrome } from './ui/no-budget-chrome.js';
import { syncLensControls } from './ui/lens-control.js';
import { icon } from './ui/icon.js';
import { setLang, t, loadLocale, isLocaleLoaded, fmtDateLang } from './ui/i18n.js';
import { startTour } from './ui/tour.js';
import { renderTweaks } from './ui/tweaks.js';
import { markPayeeIndexStale } from './state/payee-index.js';
import { installUnloadGuard } from './state/unload-guard.js';
import { notifyStateChanged } from './state/events.js';
import { currentBudgetSession, budgetHeld } from './state/budget-session.js';
import { updateMeta, runMetaExclusive } from './state/meta-writes.js';
import { createBrowserSession } from './session/browser-session.js';
import { registry } from './core/index.js';
import { describeError } from './core/errors.js';
import { toast } from './ui/toast.js';
import { isVersionConflict, showVersionConflictDialog, reportDispatchFailure } from './ui/save-error.js';
import { mark } from './perf.js';
import { loadServerKeyStatus } from './ai/key-status.js';
import { parseRoute, serializeRoute, historyActionFor, startupPage, DEFAULT_ROUTE } from './ui/router.js';

export { subscribeState } from './state/events.js';

// ── State ──────────────────────────────────────────────────────────────────
export const state = {
  budgetFolder: null,   // FileSystemDirectoryHandle
  meta: null,
  envelopes: [],        // envelope buckets: { id, name, category, description?, archived? }
  budgetItems: [],      // regular expenses: { id, envelope_id, description?, default_amount, monthly_schedule, ... }
  transactions: [],
  accounts: [],
  envelopeTemplates: [],// reusable allocation rules: { id, name, lines:[{envelope_id,mode,amount}] }
  currentPage: 'dashboard',
  pendingFilter: null,
};

// The single writer for pages moved to the command layer (js/core). Pages not
// yet moved still save directly; the ESLint ratchet in eslint.config.js lists
// them. Spec: docs/superpowers/specs/2026-10-01-api-first-core-design.md.
export const session = createBrowserSession({
  state,
  registry,
  writeBatch,
  updateMeta,
  runMetaExclusive,
  currentGeneration: currentBudgetSession,
  notify: notifyStateChanged,
  clock: now,
  newId: generateId,
  onTransactionsPublished: markPayeeIndexStale,
  isVersionConflict,
  isLoading: budgetHeld,
});

// ── Page registry ──────────────────────────────────────────────────────────
//
// Pages are registered as loaders, not as render functions, so the twelve
// page modules stay out of the boot graph. They are the heaviest files in
// the repo (transactions.js, budget-plan.js, settings.js, reconcile.js are
// all 50 KB+) and eagerly importing them meant paying for every page to
// paint the first one. `navigate()` resolves a loader on first use and
// caches the result, so the cost is paid once per page actually visited.
//
// `dashboard` is registered eagerly: it is always the first page rendered,
// so deferring it would only add a round trip.
const pages = {};        // name -> resolved render fn
const pageLoaders = {};  // name -> () => Promise<{ render }>

/**
 * @param {string} name
 * @param {Function} loaderOrRender  either `() => import('./pages/x.js')`
 *                                   or a render function registered eagerly.
 */
export function registerPage(name, loaderOrRender) {
  pageLoaders[name] = loaderOrRender;
}

/** Register an already-imported render function (no lazy load). */
function registerEagerPage(name, renderFn) {
  pages[name] = renderFn;
  pageLoaders[name] = null;
}

async function resolvePage(name) {
  if (pages[name]) return pages[name];
  const loader = pageLoaders[name];
  if (!loader) return null;
  const mod = await loader();
  const renderFn = typeof mod === 'function' ? mod : mod?.render;
  if (typeof renderFn !== 'function') {
    throw new Error(`page module "${name}" has no render export`);
  }
  pages[name] = renderFn;
  return renderFn;
}

// ── Prefs ──────────────────────────────────────────────────────────────────
const PREFS_KEY = 'bv-prefs-v1';

function readStoredPrefs() {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (err) {
    console.warn('bunvelope: prefs read failed, using defaults', err);
    return {};
  }
}

const prefs = Object.assign(
  {
    nav: 'rail', statusbarPosition: 'bottom', density: 'comfy', accent: 'mint', lang: 'en', tourSeen: false,
    // Balance lens. Like every preference it follows a signed-in user across
    // devices (see syncPrefsWithServer); it used to be per device by design,
    // reversed by the owner on 2026-09-24 once preferences had a server home.
    lens: DEFAULT_LENS, lensHorizon: DEFAULT_HORIZON,
  },
  readStoredPrefs()
);
prefs.lens = normalizeLens(prefs.lens);
prefs.lensHorizon = normalizeHorizon(prefs.lensHorizon);
mark('modules-evaluated');
// Top-level await: the active locale's dictionary must be in place before
// the first render. English is inlined; this only fetches for fi.
await loadLocale(prefs.lang);
mark('locale-loaded');
setLang(prefs.lang);
applyPrefs(prefs);

function storePrefsLocally() {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch (err) {
    // Safari private mode throws on setItem; prefs still apply in-memory.
    console.warn('bunvelope: prefs save failed', err);
  }
}

// ── Preferences on the server (cloud mode, signed in) ───────────────────────
// localStorage is the cache and, in local and guest mode, the only store.
// Once a signed-in session has read the server copy, every change is also
// PATCHed there, batched briefly so a burst of toggles is one request.
let prefsSyncOn = false;
let prefsPatch = null;
let prefsPatchTimer = null;

// What the server accepts (server/routes/budgets.js, validPrefsPatch).
function syncablePref(v) {
  return v === null || ['boolean', 'string'].includes(typeof v)
    || (typeof v === 'number' && Number.isFinite(v))
    || (Array.isArray(v) && v.every(x => typeof x === 'string'));
}

function queuePrefsPush(keys) {
  if (!prefsSyncOn) return;
  prefsPatch = prefsPatch || {};
  for (const k of keys) if (syncablePref(prefs[k])) prefsPatch[k] = prefs[k];
  clearTimeout(prefsPatchTimer);
  prefsPatchTimer = setTimeout(async () => {
    const patch = prefsPatch;
    prefsPatch = null;
    if (!patch || !Object.keys(patch).length) return;
    try {
      const { patchUserPrefs } = await import('./storage/api-adapter.js');
      await patchUserPrefs(patch);
    } catch (err) {
      // Not worth interrupting anyone for: the change is applied and cached
      // here, and the next change sends its own key again.
      console.warn('bunvelope: prefs sync failed', err);
    }
  }, 400);
}

/**
 * Adopt the signed-in user's server preferences, then keep them in sync.
 * With nothing stored yet (first sign-in since preferences moved to the
 * server), this browser's settings become the user's.
 */
async function syncPrefsWithServer(api) {
  let server;
  try {
    ({ prefs: server } = await api.getUserPrefs());
  } catch (err) {
    console.warn('bunvelope: could not read server prefs; using this browser\'s', err);
    return;
  }
  prefsSyncOn = true;
  if (!server || !Object.keys(server).length) {
    queuePrefsPush(Object.keys(prefs));
    return;
  }
  const langBefore = prefs.lang;
  Object.assign(prefs, server);
  prefs.lens = normalizeLens(prefs.lens);
  prefs.lensHorizon = normalizeHorizon(prefs.lensHorizon);
  storePrefsLocally();
  if (prefs.lang !== langBefore) {
    await loadLocale(prefs.lang).catch((err) => console.error('locale load failed:', err));
    setLang(prefs.lang);
    relabelShell();
  }
  applyPrefs(prefs);
  syncLensControls();
  const tw = document.getElementById('tweaks');
  if (tw) renderTweaks(tw);
}

export function savePrefs(partial) {
  Object.assign(prefs, partial);
  if ('lens' in partial) prefs.lens = normalizeLens(prefs.lens);
  if ('lensHorizon' in partial) prefs.lensHorizon = normalizeHorizon(prefs.lensHorizon);
  storePrefsLocally();
  queuePrefsPush(Object.keys(partial));
  if ('lang' in partial) {
    setLang(partial.lang);
    if (!isLocaleLoaded(partial.lang)) {
      // Dictionary still loading — re-apply labels and repaint once it lands.
      // relabelShell() has to run here too: the caller already ran it, but
      // synchronously, while t() was still falling back to English, so the
      // rail, top nav and status bar would otherwise stay English until a
      // reload even though the page body switched.
      loadLocale(partial.lang).then(() => {
        applyPrefs(prefs);
        relabelShell();
        updateStatusBar();
        if (state.budgetFolder && state.currentPage) navigate(state.currentPage);
      }).catch((err) => console.error('locale load failed:', err));
    }
  }
  applyPrefs(prefs);
}
/**
 * The balance lens in force. Simple mode hides the switcher, so it pins the
 * default rather than applying a choice the user can no longer see or undo;
 * the stored choice is kept for when they switch back to full mode.
 */
function activeLens() {
  return !featureEnabled(prefs, 'balance-views')
    ? { lens: DEFAULT_LENS, horizon: DEFAULT_HORIZON }
    : { lens: prefs.lens, horizon: prefs.lensHorizon };
}

/**
 * The active lens as the `balances` query takes it. `horizon` only goes along
 * with the forecast lens: the query refuses it for the other two.
 * @returns {{ lens: string, horizon?: string }}
 */
export function activeLensInput() {
  const { lens, horizon } = activeLens();
  return lens === LENS_FORECAST ? { lens, horizon } : { lens };
}

export function getPrefs() {
  const { lens, horizon } = activeLens();
  return { ...prefs, lens, lensHorizon: horizon };
}

/**
 * The transaction array every balance on screen should walk, resolved through
 * the active lens. Pages call this instead of reading `state.transactions`
 * directly — a remaining raw `state.transactions` in `js/pages/` now means
 * "this surface is deliberately lens-pinned" (reconcile, Age of Money, the
 * invariant check, Monthly Review, the AI context builder).
 *
/**
 * The app's clock.
 *
 * The engine reads no wall clock: every function there that needs "now" takes
 * it as a required parameter, because a default clock is untestable by
 * omission — a caller that forgets silently gets wall time, and the answer
 * then depends on when and where the process ran. This is the impure edge
 * where the read belongs, and pages import it from here rather than calling
 * `new Date()` in the middle of a calculation.
 *
 * @returns {Date}
 */
export function now() {
  return new Date();
}

// The last dated view, keyed by the list it was made from and the month.
let datedMemo = { items: /** @type {any[] | null} */ (null), month: '', value: /** @type {any[]} */ ([]) };

/**
 * The plan items as the coming 12 months see them (`planItemsAsOf`): months
 * outside an item's start/end month are off, and an ended item counts
 * nothing. Feed this, not `state.budgetItems`, to every reader that sums the
 * twelve months as "a year" (tests/dated-plan-readers.test.js). Pass the live
 * view (stored items with pending edits) where a page shows one. A view: never
 * store its rows.
 */
export function datedPlanItems(items = state.budgetItems) {
  const today = now();
  const month = `${today.getFullYear()}-${today.getMonth()}`;
  if (datedMemo.items !== items || datedMemo.month !== month) {
    datedMemo = { items, month, value: planItemsAsOf(items || [], today) };
  }
  return datedMemo.value;
}

/**
 * The transactions through the active lens. The before/after previews in
 * Add-tx and Edit-tx read core queries, so nothing resolves the lens over a
 * hypothetical array any more.
 */
export function viewTxs() {
  const { lens, horizon } = activeLens();
  return lensTransactions(state, { lens, horizon, today: now() });
}

/**
 * Transactions through the Today lens, whatever the active lens is. Cards
 * that show a "incl. X upcoming" secondary line use this as the baseline: the
 * hint is always `displayed − cleared`, so the adjacent number stays legible
 * without switching modes.
 */
export function todayTxs(txsOverride) {
  const source = txsOverride ? { ...state, transactions: txsOverride } : state;
  return lensTransactions(source, { lens: LENS_TODAY, today: now() });
}

// ── Shell ──────────────────────────────────────────────────────────────────
// Wide tables and tab strips that scroll sideways on a phone fade the edge
// that hides more content (js/ui/scroll-cue.js).
observeScrollCues();
buildShell({
  onRailGroupsChange: (collapsedRailGroups) => savePrefs({ collapsedRailGroups }),
  onNavigate: (page) => {
    if (state.budgetFolder) navigate(page);
  },
  onNewTransaction: async () => {
    if (!state.budgetFolder) return;
    try {
      await (await import('./pages/add-tx.js')).openAddTx();
    } catch (err) {
      console.error('Could not open transaction editor:', err);
      toast(t('common.moduleLoadFailed'), { assertive: true });
    }
  },
  onBudgetClick: async () => {
    try {
      if (state.budgetFolder?.__guest) {
        await (await import('./ui/guest-budget-picker.js')).openGuestBudgetPicker();
      } else if (window.__BUNVELOPE_MODE?.kind === 'cloud') {
        await (await import('./ui/cloud-budget-picker.js')).openCloudBudgetPicker();
      } else {
        await (await import('./ui/load-budget-dialog.js')).openLoadBudgetDialog();
      }
    } catch (err) {
      console.error('Could not open budget picker:', err);
      toast(t('common.moduleLoadFailed'), { assertive: true });
    }
  },
  // The pill is the money still to assign, so it opens the sheet that assigns
  // it, as the dashboard hero's Assign button does. It used to open the
  // Budget plan, which neither shows nor moves unallocated money.
  onUnallocatedClick: () => {
    if (state.budgetFolder) openFillEnvelopes({ onSubmitted: () => navigate(state.currentPage) });
  },
  onTweaksToggle: () => {
    const tw = document.getElementById('tweaks');
    if (!tw) return;
    tw.hidden = false;
    tw.classList.toggle('open');
  },
  onHelpClick: () => { startTour(); },
  lens: {
    read: activeLens,
    onChange: (patch) => {
      savePrefs(patch);
      syncLensControls();
      // Re-render the current page so every balance on it is recomputed
      // through the new lens; navigate() ends by refreshing the status bar,
      // so the unallocated chip follows with no extra wiring.
      if (state.budgetFolder && state.currentPage) navigate(state.currentPage);
      else updateStatusBar();
    },
  },
});

// Populate the tweaks panel once the shell is built.
{
  const tw = document.getElementById('tweaks');
  if (tw) renderTweaks(tw);
}
// Mark the active rail item on the initial render.
highlightActive(state.currentPage || 'overview');

// ── Balance View chip ─────────────────────────────────────────────────────
// The Balance View changes every balance on these pages (Today vs Booked
// could differ sevenfold on the owner's budget), and the only sign of which
// one was active sat in the sidebar. So the page says it, under its title
// (ux-review U1). Review is pinned to today's balances whatever the switch
// says (U6), except that a past month shows as it stood on its last day, so
// Review draws its own chip (js/pages/review.js). Reports' totals ignore the
// view by design and get no chip.
const VIEW_CHIP_PAGES = new Set(['dashboard', 'detailed-insights', 'envelopes', 'accounts', 'transactions', 'investments', 'stress']);

function addViewChip(container, page) {
  if (!VIEW_CHIP_PAGES.has(page)) return;
  const h1 = container.querySelector('.page-head h1');
  if (!h1) return;
  const active = activeLens();
  const lens = active.lens;
  let detail;
  if (lens === LENS_FORECAST) detail = t('lens.chipForecast')(fmtDateLang(resolveHorizonDate(active.horizon, now())));
  else detail = t(`lens.chip_${lens}`);
  const chip = document.createElement('div');
  chip.className = `view-chip view-chip--${lens}`;
  chip.title = t(`lens.${lens}Hint`);
  const name = document.createElement('strong');
  name.textContent = t(`lens.${lens}`);
  chip.append(name, document.createTextNode(` · ${detail}`));
  const summary = h1.parentElement.querySelector('.page-head-sub');
  const row = document.createElement('div');
  row.className = 'page-head-meta';
  row.append(chip);
  if (summary) row.append(summary);
  h1.after(row);
}

// ── Navigation ─────────────────────────────────────────────────────────────
// Hash routing: the URL names the current page (`#/transactions`), so Back
// and Forward move between pages, a refresh stays put and a page can be
// linked to. See js/ui/router.js for the rules; this is the side-effect half.
let routeRestored = false; // false until the first render after a budget load

function knownPages() {
  return Object.keys(pageLoaders);
}

function syncLocation(page, first) {
  if (typeof window === 'undefined' || !window.history) return;
  const action = historyActionFor({ page, currentHash: window.location.hash, first });
  if (action === 'none') return;
  // A fragment-only URL keeps the path and query (cloud mode's ?auth=…).
  const url = serializeRoute(page);
  try {
    if (action === 'push') window.history.pushState({ page }, '', url);
    else window.history.replaceState({ page }, '', url);
  } catch (err) {
    console.warn('bunvelope: history update failed', err);
  }
}

// Back/Forward, or a hand-edited hash. Both events can fire for one
// traversal; the currentPage check makes the second a no-op.
//
// With a sheet open, Back dismisses the sheet (through its unsaved-changes
// guard) instead of swapping the page out underneath it, and the URL is put
// back on the page still showing. Both events can fire for one traversal, so
// a dismissal in progress swallows the second.
let dismissingSheet = false;
async function onLocationChange() {
  if (!state.budgetFolder || !routeRestored || dismissingSheet) return;
  const page = parseRoute(window.location.hash, knownPages()) || DEFAULT_ROUTE;
  if (page === state.currentPage) return;
  if (hasOpenSheet()) {
    dismissingSheet = true;
    try {
      window.history.pushState({ page: state.currentPage }, '', serializeRoute(state.currentPage));
      await requestCloseTopSheet();
    } catch (err) {
      console.warn('bunvelope: dismissing sheet on Back failed', err);
    } finally {
      dismissingSheet = false;
    }
    return;
  }
  navigate(page);
}
if (typeof window !== 'undefined') {
  window.addEventListener('popstate', onLocationChange);
  window.addEventListener('hashchange', onLocationChange);
  // Warn before closing or reloading while a save is still in flight.
  installUnloadGuard(window);
}

// Bumped by every navigate() call. A page's module can take a while to land on
// first visit; if the user has moved on by then, the slow call must not paint
// its page into the shared #app over the newer one.
let navGeneration = 0;

/**
 * Show a page. Resolves `true` when the page rendered, `false` when its render
 * threw (the error card is showing) or when a later navigate() call superseded
 * this one before it finished: the newer call owns the container and the
 * outcome, so a superseded call touches nothing. Resolves `undefined` for an
 * unknown page. No caller reads the value today.
 */
export async function navigate(page, filter) {
  // The budget loaders all land on the overview; the first render after a
  // load goes to the page the URL names instead, so a refresh or a deep link
  // keeps its place.
  const first = !routeRestored && !!state.budgetFolder;
  if (first) {
    routeRestored = true;
    page = startupPage({ requested: page, filter, hash: window.location.hash, known: knownPages() });
  }
  const gen = ++navGeneration;
  if (state.budgetFolder) {
    syncLocation(page, first);
    setNoBudgetChrome(false);
  }
  state.currentPage = page;
  state.pendingFilter = filter;
  highlightActive(page);

  const container = document.getElementById('app');
  container.innerHTML = '';

  let renderFn = pages[page];
  if (!renderFn && !pageLoaders[page]) {
    // eslint-disable-next-line no-restricted-syntax -- values are escHtml-wrapped
    container.innerHTML = `<div class="card"><p class="muted">Page "${escHtml(page)}" not found.</p></div>`;
    return;
  }

  let renderOk = true;
  try {
    if (!renderFn) {
      // First visit to this page — its module is still on the network.
      // Paint placeholders so the container isn't blank while it lands.
      container.append(skeletonCard({ blockHeight: 120 }));
      container.append(skeletonCard({ lineWidth: '24%', blockHeight: 160 }));
      renderFn = await resolvePage(page);
      if (gen !== navGeneration) return false;
      container.innerHTML = '';
    }
    await renderFn(container);
    // A renderer that awaits internally may have been overtaken mid-render;
    // its container is not ours any more, so don't decorate it.
    if (gen !== navGeneration) return false;
    addViewChip(container, page);
  } catch (err) {
    if (gen !== navGeneration) return false;
    renderOk = false;
    console.error(`Error rendering page "${page}":`, err);
    // eslint-disable-next-line no-restricted-syntax -- values are escHtml-wrapped
    container.innerHTML = `<div class="card"><p style="color:var(--danger-text)">Error loading page: ${escHtml(err.message)}</p></div>`;
  }

  // updateStatusBar reads state directly, so it stays accurate even if the
  // page render threw. Still wrap it so a status-bar bug can't blank the page.
  try {
    updateStatusBar();
  } catch (err) {
    console.error('Error updating status bar:', err);
  }
  return renderOk;
}

// ── Status bar ─────────────────────────────────────────────────────────────
let backupObservedFolder = null;
export function updateStatusBar() {
  if (!budgetHeld() && state.budgetFolder !== backupObservedFolder) {
    backupObservedFolder = state.budgetFolder;
    void backups.tick(backupObservedFolder);
  }
  updateBackupIndicator(state.budgetFolder, () => navigate('settings', { tab: 'security' }));
  const unallocatedEl = document.getElementById('status-unallocated');
  const invariantsBtn = document.getElementById('status-invariants');

  if (!state.budgetFolder) {
    if (unallocatedEl) unallocatedEl.textContent = `${t('status.unalloc')} —`;
    if (unallocatedEl) { unallocatedEl.disabled = true; unallocatedEl.classList.remove('neg'); }
    if (invariantsBtn) invariantsBtn.hidden = true;
    return;
  }

  // Unallocated follows the lens, and the `balances` query reads BOTH sides
  // through the same one: it is `accounts − envelopes`, so a mixed pair stops
  // reconciling, the one thing this figure exists to do. The query never
  // fails on a loaded budget; if it ever does, the bar shows no figure rather
  // than one computed some other way.
  const r = session.query('balances', activeLensInput());
  if (!r.ok) console.warn('[bunvelope] balances query failed:', r.error.code);
  const unallocated = r.ok ? r.value.unallocated : null;
  const shown = unallocated == null ? '—' : fmt(unallocated);

  const path = document.getElementById('status-path');
  if (path) {
    const name = state.budgetFolder?.name || t('status.budgetFallbackName');
    path.textContent = name;
    path.title = `${t('status.budgetTitle')(name)} — ${t('status.selectBudget')}`;
  }

  if (unallocatedEl) {
    unallocatedEl.textContent = `${t('status.unalloc')} ${shown}`;
    unallocatedEl.title = t('status.unallocTip');
    unallocatedEl.disabled = false;
    unallocatedEl.classList.toggle('neg', unallocated != null && unallocated <= -0.01);
  }
  if (invariantsBtn) updateInvariantBadge();
}

// ── Schema-invariant badge ────────────────────────────────────────────────
// Runs on every status-bar refresh — same cadence as the unallocated chip
// — so the badge reflects the latest data automatically. Hidden when clean.
let lastInvariantReport = null;
// Issues that are not schema violations, folded into the same badge with
// neutral wording: paid bills not linked to their plan item, and future
// rows still on an archived account or envelope.
let lastExtras = { unlinked: 0, postedDuplicates: 0, archivedFuture: [] };

function queryDiagnostics() {
  const result = session.query('budget.diagnostics', {});
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
}

const neutralCount = (extras) => (extras?.unlinked || 0) + (extras?.postedDuplicates || 0)
  + (extras?.archivedFuture?.length || 0);

// runInvariantCheck walks the whole transaction list (one pass, every
// validator per row), and the badge also scans for unlinked bills,
// duplicates and future rows on archived items; updateStatusBar() fires
// after every page render — so running it inline
// put that cost on the paint path every single navigation. Defer it to an
// idle slot and coalesce repeat calls: the badge lands a beat after the
// page instead of holding it up. The contract in AGENTS.md (badge always
// reflects the latest data) still holds — the deferred run reads `state`
// when it fires, so the last scheduled run always wins.
const scheduleIdle = (fn) => (
  typeof requestIdleCallback === 'function'
    ? requestIdleCallback(fn, { timeout: 500 })
    : setTimeout(fn, 0)
);
let invariantJobScheduled = false;

function updateInvariantBadge() {
  if (invariantJobScheduled) return;
  invariantJobScheduled = true;
  scheduleIdle(() => {
    invariantJobScheduled = false;
    // The button is a fixed element in index.html, but re-read it so a
    // stale reference can't survive a DOM swap.
    const el = document.getElementById('status-invariants');
    if (el) {
      paintInvariantBadge(el).catch((err) => console.error('invariant badge update failed:', err));
    }
  });
}

// js/repair-links.js imports `state` and the session from this module,
// so a static import here would be a cycle. Load it lazily — once, cached —
// for opening the review sheet. Discovery itself is a synchronous core query.
let repairLinksModulePromise = null;
function loadRepairLinks() {
  if (!repairLinksModulePromise) repairLinksModulePromise = import('./repair-links.js');
  return repairLinksModulePromise;
}
// Same reason, same cache, for the duplicate finder's sheet.
let duplicatesModulePromise = null;
function loadDuplicates() {
  if (!duplicatesModulePromise) duplicatesModulePromise = import('./duplicates-sheet.js');
  return duplicatesModulePromise;
}

async function paintInvariantBadge(btn, diagnostics = null) {
  // The budget may have been closed between scheduling and firing —
  // updateStatusBar's no-budget branch hides the badge, and we must not
  // resurrect it here.
  if (!state.budgetFolder) {
    btn.hidden = true;
    return;
  }
  // No async module load between reading the budget and painting: a budget
  // switch cannot interleave this snapshot. The scheduled job reads fresh data.
  const { report, extras } = diagnostics ?? queryDiagnostics();
  lastInvariantReport = report;
  lastExtras = extras;
  const totalCount = report.totalProblems + neutralCount(extras);
  if (totalCount === 0) {
    btn.hidden = true;
    return;
  }
  btn.hidden = false;
  const label = document.createElement('span');
  label.textContent = t('invariants.badge').replace('{count}', String(totalCount));
  btn.replaceChildren(icon('warn', 12), label);
  // Sign-convention, split, coercion and unknown-type busts corrupt money math directly —
  // escalate the badge from amber to red for those; dangling refs and
  // unlinked bills stay amber.
  btn.classList.toggle('status-invariants--danger',
    (report.byCategory.signs || 0)
    + (report.byCategory.splits || 0)
    + (report.byCategory.coercions || 0)
    + (report.byCategory.conservation || 0)
    // A row of an unknown type drops its money from every balance.
    + (report.byCategory.unknownTypes || 0) > 0);
  // Neither extra is a schema problem (see the comment above) — when they
  // are the only thing raising the badge, "schema invariants" / "breaks the
  // data-shape rules" would be actively wrong, so the tooltip (and the
  // dialog's title/intro below) uses neutral wording instead.
  const onlyNeutral = report.totalProblems === 0 && neutralCount(extras) > 0;
  btn.title = onlyNeutral ? t('invariants.badgeHintNeutral') : t('invariants.badgeHint');
  // Idempotent listener attach: the marker prevents stacking duplicates
  // every render (updateStatusBar fires after every page-render).
  if (!btn.dataset.listening) {
    btn.dataset.listening = '1';
    btn.addEventListener('click', () => openInvariantsDialog(lastInvariantReport, lastExtras));
  }
}

const PROBLEM_CODE_TO_I18N = {
  splitNoAmount: 'invariants.problemSplitNoAmount',
  splitNotObject: 'invariants.problemSplitNotObject',
  splitMissingEnvelope: 'invariants.problemSplitMissingEnvelope',
  splitInvalidAmount: 'invariants.problemSplitInvalidAmount',
  splitSumMismatch: 'invariants.problemSplitSumMismatch',
  splitBothEnvelopeAndSplits: 'invariants.problemSplitBothEnvelopeAndSplits',
  unknownAccount: 'invariants.problemUnknownAccount',
  unknownEnvelope: 'invariants.problemUnknownEnvelope',
  negativeAmount: 'invariants.problemNegativeAmount',
  duplicateFromBudget: 'invariants.problemDuplicateFromBudget',
  futureOnArchived: 'invariants.problemFutureOnArchived',
  invalidDate: 'invariants.problemInvalidDate',
  selfTransferAccount: 'invariants.problemSelfTransferAccount',
  selfTransferEnvelope: 'invariants.problemSelfTransferEnvelope',
  transferMissingEndpoints: 'invariants.problemTransferMissingEndpoints',
  duplicateTxId: 'invariants.problemDuplicateTxId',
  staleFromBudgetLink: 'invariants.problemStaleFromBudgetLink',
  nonFiniteAmount: 'invariants.problemNonFiniteAmount',
  conservationGap: 'invariants.problemConservationGap',
  unknownTxType: 'invariants.problemUnknownTxType',
  budgetItemOtherEnvelope: 'invariants.problemBudgetItemOtherEnvelope',
  reconciledDrift: 'invariants.problemReconciledDrift',
  clearedScheduled: 'invariants.problemClearedScheduled',
};

const INVARIANT_CATEGORIES = [
  ['accountRefs', 'invariants.categoryAccountRefs', 'invariants.howToFixAccountRefs'],
  ['envelopeRefs', 'invariants.categoryEnvelopeRefs', 'invariants.howToFixEnvelopeRefs'],
  ['splits', 'invariants.categorySplits', 'invariants.howToFixSplits'],
  ['signs', 'invariants.categorySigns', 'invariants.howToFixSigns'],
  ['duplicateKeys', 'invariants.categoryDuplicateKeys', 'invariants.howToFixDuplicateKeys'],
  ['staleKeys', 'invariants.categoryStaleKeys', 'invariants.howToFixStaleKeys'],
  ['dates', 'invariants.categoryDates', 'invariants.howToFixDates'],
  ['selfTransfers', 'invariants.categorySelfTransfers', 'invariants.howToFixSelfTransfers'],
  ['duplicateIds', 'invariants.categoryDuplicateIds', 'invariants.howToFixDuplicateIds'],
  ['coercions', 'invariants.categoryCoercions', 'invariants.howToFixCoercions'],
  ['conservation', 'invariants.categoryConservation', 'invariants.howToFixConservation'],
  ['unknownTypes', 'invariants.categoryUnknownTypes', 'invariants.howToFixUnknownTypes'],
  ['itemLinks', 'invariants.categoryItemLinks', 'invariants.howToFixItemLinks'],
  ['reconciled', 'invariants.categoryReconciled', 'invariants.howToFixReconciled'],
  ['clearedScheduled', 'invariants.categoryClearedScheduled', 'invariants.howToFixClearedScheduled'],
];

function friendlyProblemText(problem) {
  const i18nKey = PROBLEM_CODE_TO_I18N[problem.code];
  const params = { ...(problem.params || {}) };
  // Money-style params formatted via the same fmt() the rest of the UI uses.
  if (problem.code === 'splitSumMismatch') {
    const sum = Number(params.sum); const total = Number(params.total);
    if (isFinite(sum)) params.sum = fmt(sum);
    if (isFinite(total)) params.total = fmt(total);
  } else if (problem.code === 'splitInvalidAmount' || problem.code === 'negativeAmount') {
    const n = Number(params.amount);
    if (isFinite(n)) params.amount = fmt(n);
  } else if (problem.code === 'conservationGap') {
    for (const k of ['account', 'envelope', 'gap']) {
      const n = Number(params[k]);
      if (isFinite(n)) params[k] = fmt(n);
    }
  } else if (problem.code === 'reconciledDrift') {
    for (const k of ['expected', 'actual']) {
      const n = Number(params[k]);
      if (isFinite(n)) params[k] = fmt(n);
    }
    const gap = Number(params.gap);
    if (isFinite(gap)) params.gap = fmt(gap, { signed: true });
    params.date = fmtDateLang(params.date);
  }
  let text = i18nKey ? t(i18nKey) : t('invariants.problemUnknown');
  if (!i18nKey) params.message = problem.message;
  for (const [k, v] of Object.entries(params)) {
    text = text.split(`{${k}}`).join(String(v));
  }
  return text;
}

function buildProblemRow(problem) {
  const tx = problem.id ? state.transactions.find((x) => x.id === problem.id) : null;
  const row = document.createElement(tx ? 'button' : 'div');
  const baseStyle = 'display:flex;flex-direction:column;gap:6px;text-align:left;width:100%;padding:10px 12px;background:var(--surface-2);border:1px solid var(--border);border-radius:6px;color:inherit;font:inherit;';
  row.style.cssText = baseStyle + (tx ? 'cursor:pointer;' : 'cursor:default;');
  if (tx) {
    row.type = 'button';
    row.title = t('invariants.openTransaction');
    row.addEventListener('click', () => {
      import('./pages/edit-tx.js').then((m) => m.openEditTx(tx)).catch((err) => console.error(err));
    });
  }

  const topLine = document.createElement('div');
  topLine.style.cssText = 'display:flex;justify-content:space-between;gap:12px;align-items:baseline;font-size:13px;';
  if (tx) {
    const left = document.createElement('span');
    left.style.cssText = 'font-weight:500;';
    const date = (tx.date || '').slice(0, 10);
    const payee = tx.payee || tx.note || t('invariants.txContextNoPayee');
    left.textContent = date ? `${date} · ${payee}` : payee;
    const right = document.createElement('span');
    right.append(moneyEl(txAbsAmount(tx)));
    topLine.append(left, right);
  } else if (problem.code === 'reconciledDrift') {
    // An account problem, not a row one: name the account.
    const left = document.createElement('span');
    left.style.cssText = 'font-weight:500;';
    const acct = state.accounts.find((a) => a.id === problem.params?.accountId);
    left.textContent = acct?.name || String(problem.params?.accountId || '');
    topLine.append(left);
  } else {
    const left = document.createElement('span');
    left.style.cssText = 'font-style:italic;color:var(--muted);';
    if (!problem.id) {
      left.textContent = t('invariants.txMissingId');
    } else {
      left.textContent = `${problem.id} — ${t('invariants.txMissing')}`;
    }
    topLine.append(left);
  }
  row.append(topLine);

  const detail = document.createElement('div');
  detail.style.cssText = 'font-size:12px;color:var(--muted);line-height:1.4;';
  detail.textContent = friendlyProblemText(problem);
  row.append(detail);
  if (problem.code === 'reconciledDrift') row.append(buildDriftChanges(problem.params || {}));

  return row;
}

/**
 * Under a reconciliation drift: the changes since the reconciliation that
 * moved it (reconciledDriftChanges), each a link to its row, or why the data
 * cannot tell.
 */
function buildDriftChanges(params) {
  const wrap = document.createElement('div');
  wrap.className = 'drift-changes';
  const changes = Array.isArray(params.changes) ? params.changes : [];
  const head = document.createElement('div');
  head.style.cssText = 'color:var(--muted);line-height:1.4;';
  head.textContent = changes.length ? t('invariants.driftChangesHead') : t('invariants.driftChangesNone');
  wrap.append(head);
  for (const c of changes) {
    const tx = c.exists ? state.transactions.find((x) => x.id === c.id) : null;
    const line = document.createElement(tx ? 'button' : 'div');
    line.className = 'drift-change';
    const label = document.createElement('span');
    label.className = 'drift-change-label';
    const title = document.createElement('span');
    title.className = 'drift-change-title';
    title.textContent = `${c.date ? fmtDateLang(c.date) : '—'} · ${c.payee || t('invariants.txContextNoPayee')}`;
    const detail = document.createElement('span');
    detail.className = 'drift-change-detail';
    const kind = t(`invariants.driftKind.${c.kind}`);
    const when = c.at ? ` · ${t('invariants.driftChangedOn')(fmtDateLang(String(c.at).slice(0, 10)))}` : '';
    detail.textContent = `${kind}${when}`;
    label.append(title, detail);
    const amt = document.createElement('span');
    amt.className = 'drift-change-amount';
    amt.textContent = fmt(Number(c.shift) || 0, { signed: true });
    line.append(label, amt);
    if (tx) {
      line.type = 'button';
      line.title = t('invariants.openTransaction');
      line.addEventListener('click', (e) => {
        e.stopPropagation();
        import('./pages/edit-tx.js').then((m) => m.openEditTx(tx)).catch((err) => console.error(err));
      });
    }
    wrap.append(line);
  }
  if (params.timingKnown === false) {
    const note = document.createElement('div');
    note.style.cssText = 'color:var(--muted);line-height:1.4;';
    note.textContent = t('invariants.driftTimingUnknown');
    wrap.append(note);
  }
  return wrap;
}

function renderInvariantsBody(content, report, extras, onReview) {
  content.replaceChildren();
  const unlinkedCount = extras?.unlinked || 0;
  const archivedFuture = extras?.archivedFuture || [];

  // Neither extra is a schema-invariant break (see paintInvariantBadge) —
  // when they are the only issues, the schema wording below would be wrong,
  // so the intro goes neutral (the sheet's title, "Things to check", always is).
  const onlyNeutral = report.totalProblems === 0 && neutralCount(extras) > 0;
  const intro = document.createElement('p');
  intro.style.cssText = 'margin:0 0 16px 0;color:var(--muted);line-height:1.5;';
  intro.textContent = onlyNeutral ? t('invariants.dialogLedeNeutral') : t('invariants.dialogLede');
  content.append(intro);

  if (report.totalProblems === 0 && !neutralCount(extras)) {
    const allClear = document.createElement('p');
    allClear.style.cssText = 'margin:0;padding:14px;background:var(--surface-2);border-radius:6px;color:var(--muted);';
    allClear.textContent = t('invariants.allClear');
    content.append(allClear);
    return;
  }

  if (unlinkedCount > 0) {
    const section = document.createElement('section');
    section.style.cssText = 'margin:0 0 18px 0;';
    const heading = document.createElement('h3');
    heading.style.cssText = 'font-size:14px;font-weight:600;margin:0 0 8px 0;';
    heading.textContent = t('invariants.unlinkedBills')(unlinkedCount);
    section.append(heading);
    const reviewBtn = document.createElement('button');
    reviewBtn.type = 'button';
    reviewBtn.className = 'btn btn-ghost btn-sm';
    reviewBtn.textContent = t('invariants.reviewUnlinked');
    reviewBtn.addEventListener('click', () => {
      onReview?.();
      loadRepairLinks()
        .then(({ openRepairLinksSheet }) => {
          // openSheet (js/ui/sheet.js) restores focus to whatever has focus
          // when it opens. By now the invariants dialog is closing and this
          // Review button is gone from the DOM, so document.activeElement
          // would otherwise fall back to <body> — refocus the status badge
          // (re-queried: paintInvariantBadge may have repainted it) so
          // closing the repair-links sheet returns focus there instead of
          // the page body.
          document.getElementById('status-invariants')?.focus();
          return openRepairLinksSheet({ onAfterChange: updateStatusBar });
        })
        .catch((err) => console.error('failed to open the repair-links sheet:', err));
    });
    section.append(reviewBtn);
    content.append(section);
  }

  const postedDuplicates = extras?.postedDuplicates || 0;
  if (postedDuplicates > 0) {
    const section = document.createElement('section');
    section.style.cssText = 'margin:0 0 18px 0;';
    const heading = document.createElement('h3');
    heading.style.cssText = 'font-size:14px;font-weight:600;margin:0 0 8px 0;';
    heading.textContent = t('invariants.postedDuplicates')(postedDuplicates);
    const reviewBtn = document.createElement('button');
    reviewBtn.type = 'button';
    reviewBtn.className = 'btn btn-ghost btn-sm';
    reviewBtn.textContent = t('invariants.reviewUnlinked');
    reviewBtn.addEventListener('click', () => {
      onReview?.();
      loadDuplicates()
        .then(({ openDuplicatesSheet }) => {
          // Same focus hand-off as the unlinked-bills Review above.
          document.getElementById('status-invariants')?.focus();
          return openDuplicatesSheet({ onAfterChange: updateStatusBar });
        })
        .catch((err) => console.error('failed to open the duplicates sheet:', err));
    });
    section.append(heading, reviewBtn);
    content.append(section);
  }

  if (archivedFuture.length > 0) {
    const section = document.createElement('section');
    section.style.cssText = 'margin:0 0 18px 0;';
    const heading = document.createElement('h3');
    heading.style.cssText = 'font-size:14px;font-weight:600;margin:0 0 4px 0;';
    heading.textContent = t('invariants.futureOnArchived')(archivedFuture.length);
    const fix = document.createElement('p');
    fix.style.cssText = 'margin:0 0 10px 0;color:var(--muted);font-size:13px;line-height:1.45;';
    fix.textContent = t('invariants.futureOnArchivedFix');
    const nameOf = (list, id) => list.find((x) => x && x.id === id)?.name || id;
    const ul = document.createElement('ul');
    ul.style.cssText = 'list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:6px;';
    for (const r of archivedFuture.slice(0, 20)) {
      const names = [
        ...r.accountIds.map((id) => nameOf(state.accounts || [], id)),
        ...r.envelopeIds.map((id) => nameOf(state.envelopes || [], id)),
      ].join(', ');
      const li = document.createElement('li');
      li.append(buildProblemRow({ id: r.id, code: 'futureOnArchived', params: { names } }));
      ul.append(li);
    }
    section.append(heading, fix, ul);
    content.append(section);
  }

  if (report.totalProblems === 0) return;

  const counts = document.createElement('ul');
  counts.style.cssText = 'list-style:none;padding:0;margin:0 0 22px 0;display:flex;flex-direction:column;gap:6px;';
  for (const [key, labelKey] of INVARIANT_CATEGORIES) {
    const n = report.byCategory[key] || 0;
    if (n === 0) continue;
    const li = document.createElement('li');
    li.style.cssText = 'display:flex;justify-content:space-between;gap:12px;border-bottom:1px solid var(--border);padding:6px 0;';
    const lbl = document.createElement('span'); lbl.textContent = t(labelKey);
    const num = document.createElement('strong'); num.textContent = String(n);
    li.append(lbl, num);
    counts.append(li);
  }
  if (counts.children.length > 1) content.append(counts);

  const byCat = new Map();
  for (const p of report.problems) {
    if (!byCat.has(p.category)) byCat.set(p.category, []);
    byCat.get(p.category).push(p);
  }

  for (const [catKey, labelKey, fixKey] of INVARIANT_CATEGORIES) {
    const list = byCat.get(catKey);
    if (!list?.length) continue;

    const section = document.createElement('section');
    section.style.cssText = 'margin:0 0 18px 0;';

    const heading = document.createElement('h3');
    heading.style.cssText = 'font-size:14px;font-weight:600;margin:0 0 4px 0;';
    heading.textContent = t(labelKey);
    section.append(heading);

    const fix = document.createElement('p');
    fix.style.cssText = 'margin:0 0 10px 0;color:var(--muted);font-size:13px;line-height:1.45;';
    fix.textContent = t(fixKey);
    section.append(fix);

    const ul = document.createElement('ul');
    ul.style.cssText = 'list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:6px;';
    for (const p of list) {
      const li = document.createElement('li');
      li.style.cssText = 'padding:0;margin:0;';
      li.append(buildProblemRow(p));
      ul.append(li);
    }
    section.append(ul);

    content.append(section);
  }
}

/**
 * Settings' Clean-up tab: the badge's check, run now rather than read from
 * the last idle pass, so the tab's count is never a navigation behind.
 */
export async function runDataCheck() {
  const { report, extras } = queryDiagnostics();
  return { report, extras };
}

/** Open the badge's sheet from elsewhere; `onClose` runs once it has closed. */
export function openDataCheckSheet({ report, extras }, { onClose = null } = {}) {
  // Opened from the Clean-up tab, so no "Open Clean-up" link back to it.
  openInvariantsDialog(report, extras, onClose, { cleanupLink: false });
}

function openInvariantsDialog(report, extras = { unlinked: 0, postedDuplicates: 0, archivedFuture: [] }, onClose = null, { cleanupLink = true } = {}) {
  if (!report) return;
  // Refresh repaints `body` only, so the footer below survives it.
  const content = document.createElement('div');
  content.className = 'data-check-content';
  const body = document.createElement('div');
  content.append(body);
  let closeDialog = () => {};
  renderInvariantsBody(body, report, extras, () => closeDialog());

  // The badge is where a problem gets noticed; Settings → Clean-up is where
  // the rest of the checks live (duplicate payees, investment transfers
  // without a symbol), so point there from here.
  if (cleanupLink) {
    const footer = document.createElement('div');
    footer.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:8px;padding-top:14px;border-top:1px solid var(--border);';
    const note = document.createElement('p');
    note.style.cssText = 'margin:0;color:var(--muted);font-size:13px;line-height:1.45;';
    note.textContent = t('invariants.cleanupHint');
    const openBtn = document.createElement('button');
    openBtn.type = 'button';
    openBtn.className = 'btn btn-ghost btn-sm';
    openBtn.style.flexShrink = '0';
    openBtn.textContent = t('invariants.openCleanup');
    openBtn.addEventListener('click', () => {
      closeDialog();
      navigate('settings', { tab: 'cleanup' });
    });
    footer.append(note, openBtn);
    content.append(footer);
  }

  const refreshBtn = document.createElement('button');
  refreshBtn.type = 'button';
  refreshBtn.className = 'btn btn-ghost btn-sm';
  refreshBtn.textContent = t('common.refresh');
  refreshBtn.title = t('common.refresh');
  refreshBtn.addEventListener('click', async () => {
    const diagnostics = queryDiagnostics();
    const { report: fresh, extras: freshExtras } = diagnostics;
    lastInvariantReport = fresh;
    lastExtras = freshExtras;
    renderInvariantsBody(body, fresh, freshExtras, () => closeDialog());
    const badgeBtn = document.getElementById('status-invariants');
    if (badgeBtn) await paintInvariantBadge(badgeBtn, diagnostics);
  });

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'btn btn-ghost btn-sm';
  closeBtn.textContent = t('common.close');
  const sheet = openSheet({
    // One user-facing title whatever the dialog holds; the lede below says
    // whether these are rows to fix or only things worth a look.
    title: t('invariants.dialogTitle'),
    wide: true,
    content,
    headerActions: [refreshBtn, closeBtn],
    onClose,
  });
  closeDialog = sheet.close;
  closeBtn.addEventListener('click', () => sheet.close());
}

// ── Scheduled budget-item materialiser ────────────────────────────────────
/**
 * Keep loan plan items in step with their loans (engine `loanPlanUpdates`,
 * owner decision 2026-10-02): a repaid loan's item is disabled, the months
 * after a payoff in the coming year are switched off, and a calculated
 * payment stays current, so no plan figure goes on budgeting a loan that is
 * paid. Run after the due rows are in state (load-budget, after the
 * scheduled write settles). It dispatches the internal `budgetItem.loanUpkeep`
 * through the session, which writes first and only then publishes, so a
 * failed write leaves `state` as it was. A budget switched in the meantime is
 * left alone: the session publishes nothing into it, and nothing is said.
 * Resolves `{ updated }`.
 */
export async function runLoanPlanUpkeep() {
  if (!state.budgetFolder || !Array.isArray(state.budgetItems)) return { updated: 0 };
  const budgetGeneration = currentBudgetSession();
  const folder = state.budgetFolder;
  const switchedAway = () => currentBudgetSession() !== budgetGeneration || state.budgetFolder !== folder;
  let r;
  try {
    r = await session.dispatch('budgetItem.loanUpkeep', {});
  } catch (err) {
    r = { ok: false, error: { code: 'write_failed', params: { message: String(err?.message || err) } } };
  }
  if (switchedAway()) return { updated: 0 };
  if (!r.ok) {
    console.error('loan plan upkeep:', r.error);
    reportDispatchFailure(r.error);
    return { updated: 0 };
  }
  if (r.value.published !== true) return { updated: 0 };
  const { updated, repaid } = r.value.value;
  for (const item of repaid) {
    const loanName = state.accounts.find(a => a.id === item.toAccountId)?.name || '';
    toast(t('loanSchedule.repaidToast')(item.description || loanName));
  }
  return { updated };
}

/**
 * Run the on-load maintenance: roll envelopes over for the month just closed,
 * then post every scheduled budget item and template fill that has come due
 * (`month.start`; see js/core/commands/month-start.js for how the two interleave).
 * Called on folder open and after a plan or template is saved.
 *
 * The session owns the write: it checks and writes the new rows, and only then
 * publishes them into `state`, so a failed write leaves `state` untouched (the
 * old code assigned first and rolled back). The payee index is marked stale by
 * the session's `onTransactionsPublished` hook (`markPayeeIndexStale`), which
 * replaces the old explicit `rebuildPayeeIndex`. The clock is the session's.
 *
 * `deferWrite` does not await the dispatch, so the load path is not held up by
 * a write that in cloud mode is a network PUT. The rows reach `state` when the
 * write lands, not synchronously, and this function never repaints: the caller
 * owns the first paint (a repaint here could consume the deep-link route
 * restore before load-budget's own navigate). It returns `settled`, a promise
 * of `{ posted, adjusted, published }` (or the same zeros plus `error` on a
 * failure, whose conflict dialog / toast has already fired, unless the budget
 * was switched in the meantime (then both are skipped), and which left
 * `state` unchanged), for the caller to repaint from. budget-plan.js does not
 * defer, because there the user just hit save and the await means "persisted".
 *
 * Resolves `{ emitted, posted }` (rows posted plus rows adjusted, and the
 * rows posted alone, which the Templates save toast reports), `{ emitted: 0,
 * error }` when the awaited write fails, or `{ emitted: 0, pendingWrite: true,
 * settled }` when deferred. No caller reads `emitted`.
 */
export async function runDueScheduled({ deferWrite = false } = {}) {
  if (!state.budgetFolder) return { emitted: 0 };
  // Which budget this run belongs to, captured before the dispatch. A failure
  // that settles after the user opened another budget (or reopened this one)
  // is not theirs to see: a toast or conflict dialog would land in the budget
  // now open. The session already declines to publish
  // into a switched budget; this keeps the failure report quiet the same way.
  const budgetGeneration = currentBudgetSession();
  const folder = state.budgetFolder;
  const switchedAway = () => currentBudgetSession() !== budgetGeneration || state.budgetFolder !== folder;
  // A throw from the session (a bug, not a domain error) is folded into the
  // same failure shape so the callers never see a rejection from here.
  const dispatched = session.dispatch('month.start', {}).catch((err) => ({
    ok: false, error: { code: 'write_failed', params: { message: String(err?.message || err) } },
  }));

  const warnSwitched = (error) => console.warn(
    '[bunvelope] scheduled-transaction save failed for a budget that is no longer open:', error,
  );
  const reportFailure = (error) => {
    console.error('runDueScheduled failed:', error);
    // Surface the failure — silently dropping it leaves the user believing
    // the scheduled transactions were posted when nothing hit disk.
    if (error.code === 'version_conflict') { showVersionConflictDialog(); return; }
    toast(t('common.scheduledPostFailed')(error.params?.message || describeError(error, t)), { assertive: true });
  };

  if (deferWrite) {
    const settled = dispatched.then((r) => {
      if (!r.ok) {
        const error = r.error.params?.message || r.error.code;
        if (switchedAway()) warnSwitched(r.error);
        else {
          try { reportFailure(r.error); } catch (e) { console.error('reporting the scheduled write failure failed:', e); }
        }
        return { posted: 0, adjusted: 0, published: false, error };
      }
      const { posted, adjusted } = r.value.value;
      return { posted, adjusted, published: r.value.published === true };
    });
    return { emitted: 0, pendingWrite: true, settled };
  }

  const r = await dispatched;
  if (!r.ok) {
    if (switchedAway()) warnSwitched(r.error);
    else reportFailure(r.error);
    return { emitted: 0, error: r.error.params?.message || r.error.code };
  }
  return { emitted: r.value.value.posted + r.value.value.adjusted, posted: r.value.value.posted };
}

// ── Guest session ──────────────────────────────────────────────────────────
async function startGuestSession() {
  const { openGuestBudgetPicker } = await import('./ui/guest-budget-picker.js');
  openGuestBudgetPicker();
}

function appendGuestButton(slot) {
  const wrap = document.createElement('div');
  wrap.style.cssText = 'margin-top:12px; display:flex; flex-direction:column; gap:6px;';

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn btn-ghost';
  btn.style.cssText = 'width:100%; justify-content:center;';
  btn.textContent = t('loadBudget.guestButton');
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    try { await startGuestSession(); }
    catch (err) {
      console.error('guest session failed:', err);
      btn.disabled = false;
    }
  });

  const hint = document.createElement('p');
  hint.style.cssText = 'margin:0;font-size:12px;color:var(--muted);text-align:center;';
  hint.textContent = t('loadBudget.guestHint');

  wrap.append(btn, hint);
  slot.append(wrap);
}

// ── Welcome screen ─────────────────────────────────────────────────────────
async function renderWelcome(container, { cloud = false, user = null, pickerModule = null } = {}) {
  setNoBudgetChrome(true);
  container.innerHTML = '';
  const page = document.createElement('div');
  page.className = 'page';
  page.style.cssText = 'display:flex; align-items:center; justify-content:center; min-height: calc(100vh - 100px);';

  const card = document.createElement('div');
  card.className = 'card';
  card.style.cssText = 'max-width:420px; padding:40px 32px;';

  const emoji = document.createElement('div');
  emoji.style.cssText = 'font-size:48px; margin-bottom:16px; text-align:center;';
  emoji.textContent = cloud ? '☁️' : '💰';
  card.append(emoji);

  const h1 = document.createElement('h1');
  h1.style.cssText = 'font-size:22px; font-weight:700; margin-bottom:10px; text-align:center;';
  // Not "welcome back": a new account lands here too, with no budget yet.
  h1.textContent = cloud && user
    ? t('loadBudget.welcomeUser')(user.name || user.email)
    : t('loadBudget.welcomeTitle');
  card.append(h1);

  const lede = document.createElement('p');
  lede.style.cssText = 'color:var(--muted); margin-bottom:24px; line-height:1.5; text-align:center;';
  lede.textContent = cloud
    ? t('loadBudget.ledeCloud')
    : t('loadBudget.ledeLocal');
  card.append(lede);

  const slot = document.createElement('div');
  card.append(slot);

  const footer = document.createElement('p');
  footer.style.cssText = 'margin-top:16px; font-size:12px; color:var(--muted); text-align:center;';
  footer.textContent = cloud
    ? t('loadBudget.footerCloud')
    : t('loadBudget.footerLocal');
  card.append(footer);

  page.append(card);
  container.append(page);

  if (cloud) {
    // init() starts this import alongside /api/me so the module is usually
    // already resolved by the time we get here; fall back for other callers.
    const { renderCloudPickerInto } = await (pickerModule || import('./ui/cloud-budget-picker.js'));
    renderCloudPickerInto(slot);
  } else {
    const { renderLoadBudgetInto } = await import('./ui/load-budget-dialog.js');
    renderLoadBudgetInto(slot);
  }
  // A signed-in cloud user has real budgets here; "continue as guest" would
  // only drop them into a throwaway demo. The auth screen still offers it.
  if (!(cloud && user)) appendGuestButton(slot);
}

// ── Encryption unlock ─────────────────────────────────────────────────────
async function promptAndUnlock(cfg) {
  const { promptUnlock } = await import('./ui/passphrase-prompt.js');
  const { unlockDataKey } = await import('./storage/encryption-config.js');
  const { setEncryptionKey } = await import('./storage/api-adapter.js');
  const { alertDialog } = await import('./ui/dialog.js');
  const { t } = await import('./ui/i18n.js');
  for (;;) {
    const pass = await promptUnlock();
    if (pass == null) return false;
    const key = await unlockDataKey(cfg, pass);
    if (key) {
      setEncryptionKey(key, cfg.verifier.keyId || cfg.salt);
      return true;
    }
    await alertDialog(t('security.err.wrongPassphrase'));
  }
}

// ── Init ───────────────────────────────────────────────────────────────────
/** Show the app chrome that index.html hides behind `data-gate="auth"`. */
function liftAuthGate() {
  delete document.documentElement.dataset.gate;
}

export async function init() {
  mark('init-start');
  // Register all page modules
  registerEagerPage('dashboard', renderDashboard);
  registerEagerPage('detailed-insights', renderDetailedInsights);
  registerPage('envelopes',    () => import('./pages/envelopes.js'));
  registerPage('transactions', () => import('./pages/transactions.js'));
  registerPage('budget-plan',  () => import('./pages/budget-plan.js'));
  registerPage('recurring-costs', () => import('./pages/recurring-costs.js'));
  registerPage('templates',    () => import('./pages/templates.js'));
  registerPage('review',       () => import('./pages/review.js'));
  registerPage('stress',       () => import('./pages/stress.js'));
  registerPage('settings',     () => import('./pages/settings.js'));
  registerPage('reports',      () => import('./pages/reports.js'));
  registerPage('flow',         () => import('./pages/flow.js'));
  registerPage('accounts',     () => import('./pages/accounts.js'));
  registerPage('insights',     () => import('./pages/insights.js'));
  registerPage('investments',  () => import('./pages/investments.js'));
  registerPage('net-worth',    () => import('./pages/net-worth.js'));

  const container = document.getElementById('app');
  const mode = (typeof window !== 'undefined' && window.__BUNVELOPE_MODE) || null;

  if (mode?.kind === 'cloud') {
    // Cloud mode: require a signed-in session before anything else.
    const api = await import('./storage/api-adapter.js');

    // /api/me and /api/user/encryption are independent, and the budget
    // picker module is needed in the common (signed-in) case regardless —
    // so start all three together instead of serialising three round
    // trips. getCurrentUser() already maps 401 to null; getEncryptionConfig
    // does not, so swallow its failure here and let the existing catch
    // below own the error path.
    const userP   = api.getCurrentUser();
    const encP    = api.getEncryptionConfig().catch((err) => ({ __error: err }));
    const pickerP = import('./ui/cloud-budget-picker.js');
    // Nothing rejects unhandled if we bail early on the auth branch.
    pickerP.catch(() => {});

    const user = await userP;
    mark('me-resolved');
    if (!user) {
      const { renderAuthScreen } = await import('./ui/auth-screen.js');
      const params = new URLSearchParams(window.location.search);
      renderAuthScreen(container, { authFailed: params.get('auth') === 'failed' });
      updateStatusBar();
      return;
    }
    // If this user has encryption enabled, require a passphrase before
    // letting them reach the budget picker. The derived key stays in memory
    // for the session and is used by the api-adapter to wrap/unwrap blobs.
    try {
      const cfg = await encP;
      if (cfg?.__error) throw cfg.__error;
      const { setEncryptionRequired } = await import('./storage/api-adapter.js');
      setEncryptionRequired(!!cfg?.enabled);
      if (cfg?.enabled) {
        const ok = await promptAndUnlock(cfg);
        if (!ok) {
          try { await api.logout(); } catch { /* session may already be gone */ }
          const { renderAuthScreen } = await import('./ui/auth-screen.js');
          renderAuthScreen(container, { authFailed: false });
          updateStatusBar();
          return;
        }
      }
    } catch (err) {
      // Fail closed. Swallowing this used to let the session continue with no
      // key: an existing budget then failed to load (loudly), but a brand-new
      // one has no encrypted blobs to trip over, so the setup wizard ran and
      // wrote it in PLAINTEXT for a user whose account says encrypted.
      console.error('encryption unlock flow failed:', err);
      try { await api.logout(); } catch { /* session may already be gone */ }
      const { renderAuthScreen } = await import('./ui/auth-screen.js');
      renderAuthScreen(container, { authFailed: false, encryptionError: true });
      updateStatusBar();
      return;
    }
    liftAuthGate();
    // Whether this user has an Anthropic key on the server, read before the
    // first page renders: without one the AI entry points stay hidden instead
    // of firing requests that answer 412 (js/ai/key-status.js).
    const aiKeyP = loadServerKeyStatus();
    // Before anything renders: the Balance View, language and layout the
    // first page uses are the user's, not this browser's.
    await syncPrefsWithServer(api);
    await aiKeyP;
    if (!state.budgetFolder) {
      // Straight back into the budget opened last; the picker only when
      // there is none to reopen. "Select budget" stays in the page header.
      const { reopenLastBudget } = await pickerP;
      if (!(await reopenLastBudget())) {
        await renderWelcome(container, { cloud: true, user, pickerModule: pickerP });
      }
    } else {
      await navigate('dashboard');
    }
  } else {
    // Local / FSAPI mode: no sign-in, so nothing to gate.
    liftAuthGate();
    if (!state.budgetFolder) {
      renderWelcome(container);
    } else {
      await navigate('dashboard');
    }
  }

  updateStatusBar();
}

// Auto-init when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

// Browser timers run only while the app is open; a resumed app catches up.
function pollBackups() {
  if (!budgetHeld()) void backups.tick(state.budgetFolder);
  updateBackupIndicator(state.budgetFolder, () => navigate('settings', { tab: 'security' }));
}
setInterval(pollBackups, 60_000);
globalThis.addEventListener?.('bunvelope-backup-status', () =>
  updateBackupIndicator(state.budgetFolder, () => navigate('settings', { tab: 'security' })));
globalThis.addEventListener?.('focus', pollBackups);
