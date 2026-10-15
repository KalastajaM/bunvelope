// js/state/load-budget.js — load a budget (folder handle OR cloud ref)
// into app state. Shared between the welcome screen (first open) and the
// Load-budget dialog (swap active budget).
//
// `ref` is either a FileSystemDirectoryHandle (FSAPI / local mode) or a
// `{ kind:'cloud', budgetId, version, name }` object produced by the
// cloud budget picker. The storage adapter dispatches automatically.

import { state, navigate, updateStatusBar, runDueScheduled, runLoanPlanUpkeep, session, now as appNow } from '../app.js';
import { offerToCloseLastMonth } from '../ui/close-month-offer.js';
import { fileExists, loadBudgetData, saveMeta } from '../data.js';
import { budgetKeyOf } from '../ui/page-filter.js';
import { setChartBudgetKey } from '../ui/charts/persist.js';
import { rebuildPayeeIndex } from './payee-index.js';
import { normalizeTemplates } from './normalize-templates.js';
import { repairEnvelopeTransferIds } from './repair-envelope-transfer-ids.js';
import { recordRecentBudget } from './recent-budgets.js';
import { setFormatDefaults } from '../utils.js';
import { maybeAutoStartTour } from '../ui/tour.js';
import { findInvalidTxSplits, normalizeTransactionsForWrite } from '../engine.js';
import { isRelayFeatureAvailable } from '../ai/client.js';
import { setNavItemVisible, refreshAiEntryPoints } from '../ui/shell.js';
import { resetAgentConversation } from '../ai/agent/conversation.js';
import { openLoadProgress } from '../ui/load-progress.js';
import { toast } from '../ui/toast.js';
import { reportMetaFailure } from '../ui/save-error.js';
import { t } from '../ui/i18n.js';
import { mark, report, perfCounters } from '../perf.js';
import { beginBudgetSession, currentBudgetSession, holdBudget, releaseBudget } from './budget-session.js';

// Returned by a load that a newer load replaced while it was awaiting.
const SUPERSEDED = Object.freeze({ loaded: false, superseded: true });

function isCloudRef(ref) {
  return !!ref && typeof ref === 'object' && ref.kind === 'cloud';
}

function isGuestRef(ref) {
  return !!ref && typeof ref === 'object' && ref.__guest === true;
}

/**
 * Load a budget into `state` and navigate to the dashboard.
 *
 * Returns:
 *   { loaded: true }                   on success
 *   { loaded: false, wizard: true, session }
 *                                      if budget-meta is missing and the
 *                                      caller must run the setup wizard; the
 *                                      budget stays held for it, and
 *                                      `session` is what the caller passes to
 *                                      runSetupWizard (js/setup.js)
 *   { loaded: false, superseded: true } if another load started before this
 *                                      one finished; nothing was published
 *
 * Throws on any other failure; callers decide how to surface the error.
 *
 * Loads can overlap (two picks in quick succession, a slow network read).
 * Each claims a budget session up front, and after every await checks it
 * still owns it. A superseded load stops there: it does not publish its
 * collections, write, toast or navigate. Without this, the older load
 * finishing last left budget B's handle paired with budget A's data, and the
 * next save wrote A's rows into B.
 */
export async function loadBudgetIntoState(ref) {
  const session = beginBudgetSession();
  const superseded = () => currentBudgetSession() !== session;
  // No writes until this load publishes: until then `state` is cleared (or
  // the previous budget's) under the new handle (js/state/budget-session.js).
  holdBudget();
  let published = false;
  const release = () => { published = true; releaseBudget(session); };
  let result;
  try {
    result = await loadOwned(ref, superseded, release);
    return result.wizard ? { ...result, session } : result;
  } catch (err) {
    // A failure in a load the user has already moved on from is not theirs
    // to see: the error dialog would describe a budget that isn't open.
    if (superseded()) {
      console.warn('[bunvelope] superseded budget load failed:', err);
      return SUPERSEDED;
    }
    // Failed before it published: the handle is this budget's, the
    // collections are cleared. Leave no budget open (as the cloud picker's
    // reopen does), or the next write would put rows computed on nothing
    // over this budget's files.
    if (!published) state.budgetFolder = null;
    throw err;
  } finally {
    // A load that ends without publishing lets go too (a failure, a
    // superseded load, which releases nothing once a newer one holds).
    // The setup wizard keeps the hold until it publishes (js/setup.js).
    if (!result?.wizard) release();
  }
}

/**
 * @param {any} ref
 * @param {() => boolean} superseded  true once a newer load has started
 * @param {() => void} release  ends this load's hold on the budget
 */
async function loadOwned(ref, superseded, release) {
  state.budgetFolder = ref;
  // Charts (js/ui/charts/persist.js) keep their remembered hidden series/prefs
  // per budget, the same scoping page-filter.js uses for Reports/Net worth
  // exclusions; this is the one place a budget switch is known early enough.
  setChartBudgetKey(budgetKeyOf(ref));

  // Progress card: the awaits below are the long ones, and #app would
  // otherwise sit empty for all of them. Painted into #app; whichever
  // render runs next (navigate/renderWelcome) clears it.
  const progress = openLoadProgress(document.getElementById('app'), {
    name: ref?.name || state.meta?.name || '',
  });
  mark('load-start');
  await progress.step('reading');
  if (superseded()) return SUPERSEDED;

  const hasData = await fileExists(ref, 'budget-meta.json');
  if (superseded()) return SUPERSEDED;
  if (!hasData) {
    progress.close();
    return { loaded: false, wizard: true };
  }

  const data = await loadBudgetData(ref);
  mark('data-fetched');
  await progress.step('preparing');
  if (superseded()) return SUPERSEDED;
  // Published in one synchronous block, handle included, so no await can
  // observe this budget's handle with another budget's collections.
  state.budgetFolder      = ref;
  state.envelopes         = data.envelopes;
  state.budgetItems       = data.budgetItems ?? [];
  // Apply the canonical sign convention to transactions on read so the
  // in-memory shape is consistent regardless of which legacy code path
  // saved the row. The matching write-side normalization in the session's
  // commit checks (js/session/commit-checks.js) flushes the change to disk on
  // the next save.
  state.transactions      = normalizeTransactionsForWrite(data.transactions);
  state.accounts          = data.accounts;
  state.envelopeTemplates = normalizeTemplates(data.envelopeTemplates);
  state.meta              = data.meta;

  // Reconcile the picker's name with the meta blob's name. In cloud mode
  // budgets.name (canonical for the picker) and meta.name (canonical for
  // the settings tab) are two stores that drift if either side is
  // renamed without the other. settings.js writes both on rename;
  // cloud-budget-picker.js writes only budgets.name. Self-heal here so
  // the next load after a picker-only rename brings meta into line.
  if (isCloudRef(ref) && state.meta && ref.name && ref.name !== state.meta.name) {
    const synced = { ...state.meta, name: ref.name };
    try {
      await saveMeta(ref, synced);
      if (!superseded()) state.meta = synced;
    } catch (err) {
      console.warn('[bunvelope] budget name sync failed:', err);
    }
    if (superseded()) return SUPERSEDED;
  }
  // Published, meta name included: the load-time dispatches below may write.
  release();

  setNavItemVisible('insights', isRelayFeatureAvailable());
  refreshAiEntryPoints();
  // A conversation is about one budget. Carrying it across a load would leave
  // the agent reasoning from a skeleton of envelopes that no longer exist.
  resetAgentConversation();
  rebuildPayeeIndex(state);
  setFormatDefaults({ currency: state.meta?.currency, locale: state.meta?.locale });

  // Repair envelope transfers written with the pre-v3 endpoint names. Until
  // 2026-08-26 the AI proposal path wrote `from_envelope` / `to_envelope`,
  // which the engine does not read — so those transfers moved no money and
  // said nothing about it. Runs before the invariant scan below so the scan
  // sees the repaired shape, and before any balance is computed so the numbers
  // on first paint are already right. The pure check decides whether there is
  // anything to do, so the common load dispatches nothing; when there is, the
  // internal command writes it through the session, awaited ahead of every
  // other load-time dispatch. It is forced: a key rename is not a history
  // edit, so a strict-ledger budget must not refuse it on every load.
  const transferRepair = repairEnvelopeTransferIds(state.transactions, {
    envelopes: state.envelopes,
  });
  if (transferRepair.repaired > 0) {
    let r;
    try {
      r = await session.dispatch('transaction.repairTransferEndpoints', { force: true });
    } catch (err) {
      r = { ok: false, error: err };
    }
    if (superseded()) return SUPERSEDED;
    if (r.ok) {
      reportMetaFailure(r);
      const { repaired, rows, unresolved } = r.value.value;
      console.warn(
        `[bunvelope] repaired ${repaired} envelope-transfer endpoint(s) `
        + `on ${rows} row(s) written with pre-v3 field names`,
      );
      if (unresolved.length) {
        // Renamed onto a canonical key but pointing at an envelope that no
        // longer exists. Left in place deliberately: the invariant badge can
        // now see it, which is the point.
        console.warn('[bunvelope] repaired endpoints referencing unknown envelopes:', unresolved);
      }
      toast(t('transfers.repaired')(rows));
    } else {
      // The session publishes only what it wrote, so state still holds the
      // rows as loaded: nothing to roll back. The repair is idempotent, so the
      // next load simply retries.
      console.warn('[bunvelope] envelope-transfer repair could not be saved:', r.error);
      toast(t('transfers.repairFailed'));
    }
  }

  // Schema invariants: malformed envelope_splits silently misallocate funds.
  // Warn so developers/users notice; don't block load.
  const splitProblems = findInvalidTxSplits(state.transactions);
  if (splitProblems.length) {
    console.warn(`[bunvelope] ${splitProblems.length} transaction(s) have invalid envelope_splits:`, splitProblems);
  }

  // Envelope templates used to fire only as a leg of a scheduled income
  // occurrence, via `template_id` on the income item. They carry their own
  // schedule now, and the income-linked runtime is gone — so an unconverted
  // budget would simply stop allocating. A session command, dispatched first:
  // the session runs dispatches one at a time in call order, so the archive and
  // `month.start` below (the first thing to read `tpl.schedule`) run after the
  // conversion has been written, and materialise against the new schedule and
  // the rewritten fill keys. Not awaited before the first paint; the repaint
  // below covers it. A failed write leaves state unconverted and is retried on
  // the next load.
  const converted = session.dispatch('template.convertIncomeLinked', {})
    .then((r) => {
      if (superseded()) return false;
      if (!r.ok) {
        console.error('income-template conversion save failed:', r.error);
        toast(t('templatesPage.convertFailed'));
        return false;
      }
      if (r.value.published !== true) return false;
      reportMetaFailure(r);
      const { notes } = r.value.value;
      for (const note of notes) console.warn('[bunvelope] template conversion:', note);
      toast(t(notes.length ? 'templatesPage.convertedWithNotes' : 'templatesPage.converted'));
      return true;
    })
    .catch((err) => {
      if (superseded()) return false;
      console.error('income-template conversion save failed:', err);
      toast(t('templatesPage.convertFailed'));
      return false;
    });

  mark('state-prepared');
  await progress.step('scheduled');
  if (superseded()) return SUPERSEDED;
  // The legacy "(deleted: …)" archive, now a session command. Dispatched
  // after the conversion and before `month.start` (which runDueScheduled
  // dispatches synchronously, so the session serialises the three in this
  // order) and not awaited, like them: the write settles in the background and
  // the repaint below covers it. A failure only warns, as the old inline save
  // did.
  const archived = session.dispatch('envelope.archiveDeleted', {})
    .then((r) => {
      if (!r.ok) { console.warn('auto-archive failed:', r.error); return false; }
      return r.value.published === true && r.value.value.archived > 0;
    })
    .catch((err) => { console.warn('auto-archive failed:', err); return false; });
  // deferWrite: the scheduled write settles in the background instead of
  // blocking first paint; the rows reach state when it lands (see the repaint
  // after the first navigate below).
  const due = await runDueScheduled({ deferWrite: true });

  mark('scheduled-done');
  await progress.step('rendering');
  if (superseded()) return SUPERSEDED;
  updateStatusBar();
  await navigate('dashboard');
  if (superseded()) return SUPERSEDED;
  mark('dashboard-painted');
  progress.close();
  // The deferred write publishes its rows after it lands, which is after (or
  // at best alongside) the first paint, so repaint once it has. Never awaited:
  // nothing waits on a write. Skipped when nothing was published (a failed
  // write left state unchanged) or a newer load owns the screen. Done after
  // the first navigate: that one consumes the deep-link route restore. The
  // conversion and the auto-archive publish the same way, so any one repaints.
  Promise.all([converted, archived, due?.settled]).then(([convertedTemplates, archivedEnvelopes, r]) => {
    const scheduled = Boolean(r?.published) && r.posted + r.adjusted > 0;
    if (superseded() || !(convertedTemplates || archivedEnvelopes || scheduled)) return;
    updateStatusBar();
    return navigate(state.currentPage);
  }).catch(err => console.error('repaint after the load-time writes failed:', err));
  // Then keep loan plan items in step with their loans (paid off, the year's
  // months after a payoff, a calculated payment), on the rows just posted.
  Promise.resolve(due?.settled).then(async () => {
    if (superseded()) return;
    const r = await runLoanPlanUpkeep();
    if (r.updated && !superseded()) await navigate(state.currentPage);
    // On the first open of a new month, offer to close the one that ended,
    // after month.start has swept it. Asked once per month and budget.
    if (superseded() || isGuestRef(ref)) return;
    const closed = await offerToCloseLastMonth({ state, session, now: appNow(), stillCurrent: () => !superseded() });
    if (closed && !superseded()) await navigate(state.currentPage);
  }).catch(err => console.error('loan plan upkeep failed:', err));
  report('budget load', perfCounters(state));

  // Recent-budgets tracking is local-only (IndexedDB persists
  // FileSystemDirectoryHandles). In cloud mode the server's budget list
  // replaces this.
  if (!isCloudRef(ref) && !isGuestRef(ref)) {
    recordRecentBudget(ref);
  }

  // The first-run tour is for someone new to the app. A budget that already
  // has history belongs to someone who is not, even in a browser that has
  // never recorded `tourSeen`, so it no longer greets them with 15 steps.
  // Guests always get it: the example budget has history but they are new.
  if (isGuestRef(ref) || !state.transactions.length) maybeAutoStartTour();

  return { loaded: true };
}
