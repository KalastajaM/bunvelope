// Stand-in for js/app.js in the jsdom page tests.
//
// The real app.js boots the whole shell (router, storage facade, status bar)
// on import, which a page test neither wants nor can run. The pages only need
// a handful of its exports, so a test mocks the module with this stub:
//
//   vi.mock('../js/app.js', async () => (await import('./_fakes/pageApp.js')).appStub);
//
// The stub keeps the two contracts the pages rely on:
//   - session is the real browser session over this fake state: a page that
//     dispatches commands runs the real pipeline, and `await`ing the dispatch
//     leaves the result in state.transactions. writeBatch records what would
//     have been written (it resolves, so the write "lands");
//   - now() is a fixed local date, so nothing here depends on wall time or TZ.
//
// The mocks are vi.fn()s so a test asserts on what would have been written.
import { vi } from 'vitest';
import { createBrowserSession } from '../../js/session/browser-session.js';
import { registry } from '../../js/core/index.js';
import { isVersionConflict } from '../../js/ui/save-error.js';
import { planItemsAsOf } from '../../js/engine/item-dates.js';
import { budgetHeld } from '../../js/state/budget-session.js';

export const state = {
  accounts: [],
  envelopes: [],
  transactions: [],
  budgetItems: [],
  envelopeTemplates: [],
  meta: {},
  budgetFolder: { name: 'test-budget' },
  currentPage: 'transactions',
};

export const FIXED_NOW = new Date(2026, 8, 15, 12, 0, 0); // 15 Sep 2026, local

export const writeBatch = vi.fn(async () => {});
export const updateMetaFake = vi.fn(async (st, patch) => { st.meta = await patch(st.meta); return st.meta; });
// The meta queue's runExclusive, minus the queueing: the session's meta-primary
// commits write meta inside their writeBatch, then the queue assigns it.
export const runMetaExclusiveFake = vi.fn(async (st, fn) => {
  const { meta, write } = await fn(st.meta || {});
  await write();
  st.meta = meta;
  return meta;
});
let idSeq = 0;
export const session = createBrowserSession({
  state, registry, writeBatch,
  currentGeneration: () => 1,
  notify: () => {},
  clock: () => new Date(FIXED_NOW),
  newId: () => `test-id-${++idSeq}`,
  updateMeta: updateMetaFake,
  runMetaExclusive: runMetaExclusiveFake,
  isVersionConflict, // as js/app.js wires it: a 409 is a version_conflict, not a write_failed
  isLoading: budgetHeld, // as js/app.js wires it: no writes while a load or the wizard holds the budget
});

export const navigate = vi.fn();
export const updateStatusBar = vi.fn();
export const runDueScheduled = vi.fn(async () => {});
export const runLoanPlanUpkeep = vi.fn(async () => ({ updated: 0 }));
// Page prefs (view mode, collapsed groups, ...). getPrefs reads this;
// savePrefs merges into it. Reset by resetState().
export const prefs = {};
export const savePrefs = vi.fn((patch) => { Object.assign(prefs, patch); });

export const appStub = {
  state,
  session,
  navigate,
  updateStatusBar,
  runDueScheduled,
  runLoanPlanUpkeep,
  viewTxs: () => state.transactions,
  // The Today lens: nothing dated after the fixed "now".
  todayTxs: (txsOverride) => (txsOverride || state.transactions).filter(tx => String(tx.date || '').slice(0, 10) <= '2026-09-15'),
  // The lens as the balances query takes it (a horizon only for forecast).
  activeLensInput: () => (prefs.lens === 'forecast' ? { lens: 'forecast', horizon: prefs.lensHorizon } : { lens: prefs.lens ?? 'booked' }),
  getPrefs: () => ({ lens: 'budget', lensHorizon: 'all', ...prefs }),
  savePrefs,
  now: () => new Date(FIXED_NOW),
  // The real dated view at the fixed "now".
  datedPlanItems: (items = state.budgetItems) => planItemsAsOf(items || [], new Date(FIXED_NOW)),
};

/** Fresh budget for each test: two accounts, three envelopes. */
export function resetState({ transactions = [] } = {}) {
  Object.assign(state, {
    accounts: [
      { id: 'chk', name: 'Checking', type: 'bank', initialBalance: 1000 },
      { id: 'sav', name: 'Savings', type: 'savings', initialBalance: 500 },
    ],
    envelopes: [
      { id: 'food', name: 'Food', category: 'living' },
      { id: 'fun', name: 'Fun', category: 'living' },
      { id: 'rent', name: 'Rent', category: 'housing' },
    ],
    transactions,
    budgetItems: [],
    envelopeTemplates: [],
    meta: {},
    budgetFolder: { name: 'test-budget' },
    currentPage: 'transactions',
  });
  for (const k of Object.keys(prefs)) delete prefs[k];
  savePrefs.mockClear();
  writeBatch.mockClear();
  updateMetaFake.mockClear();
  runMetaExclusiveFake.mockClear();
  idSeq = 0;
  navigate.mockClear();
  updateStatusBar.mockClear();
}

/** The hosts index.html provides; sheets and toasts render into them. */
export function mountHosts() {
  document.body.replaceChildren();
  for (const id of ['app-root', 'sheet-host', 'toast-host']) {
    const el = document.createElement('div');
    el.id = id;
    document.body.append(el);
  }
}

/** Let queued microtasks (async submit handlers) and 0ms timers run. */
export async function flush() {
  for (let i = 0; i < 5; i++) await Promise.resolve();
  await new Promise(r => setTimeout(r, 0));
}

/** Set a control's value the way typing would, firing the events pages listen to. */
export function setValue(el, value, events = ['input', 'change']) {
  el.value = value;
  for (const ev of events) el.dispatchEvent(new Event(ev, { bubbles: true }));
}

/** Whether a sheet is open (close() drops the marker at once; removal waits for the slide-out). */
export function sheetIsOpen() {
  return document.querySelector('#sheet-host .sheet-overlay[data-sheet-open]') !== null;
}

/** The topmost open sheet overlay: a confirm/alert dialog stacks above the page's own sheet. */
export function topOverlay() {
  return [...document.querySelectorAll('#sheet-host .sheet-overlay[data-sheet-open]')].at(-1);
}

/** The accent (OK) button of the topmost dialog. */
export const dialogOk = () => topOverlay().querySelector('.btn-accent');

/** A button of the topmost dialog, by its label. */
export const dialogButton = (label) => [...topOverlay().querySelectorAll('button')].find(b => b.textContent === label);

/** Messages of the toasts currently on screen (without an action button's label). */
export const toastTexts = () => [...document.querySelectorAll('#toast-host .toast')]
  .map(el => el.querySelector('.toast-msg')?.textContent ?? el.textContent);
