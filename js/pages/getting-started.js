// js/pages/getting-started.js — the Overview's getting-started checklist.
//
// Five steps from an empty budget to a working one. Each is read off the
// budget itself (an account exists, a fill has been made, ...), so there is
// no progress to store and a budget set up some other way, by import or by
// hand, ticks its steps the same. The only stored bit is the per-budget
// `meta.getting_started_dismissed`, set by Hide.
//
// Once every step is done the card disappears in full mode. In simple mode it
// turns into the offer to switch to full mode, since the basics being in
// place is the point at which the rest of the app starts to be useful.

import { state, navigate, getPrefs } from '../app.js';
import { t } from '../ui/i18n.js';
import { icon } from '../ui/icon.js';
import { toast } from '../ui/toast.js';
import { updateMeta, StaleBudgetError } from '../state/meta-writes.js';
import { setUiMode } from '../ui/tweaks.js';

/**
 * The checklist, in the order a new budget needs it: money has to be in an
 * account before it can go into envelopes.
 *
 * @param {{ accounts?: any[], envelopes?: any[], budgetItems?: any[], transactions?: any[] }} budget
 * @returns {{ key: string, done: boolean }[]}
 */
export function gettingStartedSteps(budget) {
  const txs = budget.transactions || [];
  return [
    { key: 'account',   done: (budget.accounts || []).length > 0 },
    { key: 'envelopes', done: (budget.envelopes || []).length > 0 },
    { key: 'plan',      done: (budget.budgetItems || []).length > 0 },
    { key: 'fill',      done: txs.some(tx => tx.type === 'fill') },
    { key: 'expense',   done: txs.some(tx => tx.type === 'expense') },
  ];
}

/**
 * What the Overview shows: the checklist while a step is open, the offer to
 * switch to full mode once all are done in simple mode, otherwise nothing.
 *
 * @param {{ accounts?: any[], envelopes?: any[], budgetItems?: any[], transactions?: any[], meta?: any }} budget
 * @param {{ simple: boolean }} opts
 * @returns {'checklist' | 'done' | null}
 */
export function gettingStartedCardKind(budget, { simple }) {
  if (budget.meta?.getting_started_dismissed) return null;
  if (gettingStartedSteps(budget).some(s => !s.done)) return 'checklist';
  return simple ? 'done' : null;
}

/**
 * The Overview subtitle's greeting: "welcome back" only for a budget that is
 * past its first steps. Someone who has just set one up, or who is trying
 * the app as a guest, has not been here before.
 *
 * @param {{ accounts?: any[], envelopes?: any[], budgetItems?: any[], transactions?: any[] }} budget
 * @param {{ guest: boolean }} opts
 * @returns {'dashboard.welcome' | 'dashboard.welcomeNew'}
 */
export function greetingKey(budget, { guest }) {
  if (guest || gettingStartedSteps(budget).some(s => !s.done)) return 'dashboard.welcomeNew';
  return 'dashboard.welcome';
}

const ACTIONS = {
  account:   () => import('./account-edit.js').then(m => m.openAccountEdit(null)),
  envelopes: () => import('./envelope-edit.js').then(m => m.openEnvelopeEdit(null)),
  plan:      () => navigate('budget-plan'),
  fill:      () => import('./fill-envelopes.js').then(m => m.openFillEnvelopes({ onSubmitted: () => navigate('dashboard') })),
  expense:   () => import('./add-tx.js').then(m => m.openAddTx()),
};

/** The Overview card, or null when there is nothing to show. */
export function buildGettingStartedCard() {
  const simple = getPrefs().uiMode === 'simple';
  const kind = gettingStartedCardKind(state, { simple });
  if (!kind) return null;
  return kind === 'checklist' ? buildChecklist(simple) : buildDone();
}

function buildChecklist(simple) {
  const steps = gettingStartedSteps(state);
  const doneCount = steps.filter(s => s.done).length;
  const card = document.createElement('div');
  card.className = 'card getting-started';

  const head = document.createElement('div');
  head.className = 'card-title';
  const left = document.createElement('div');
  const h3 = document.createElement('h3');
  h3.textContent = t('gettingStarted.title');
  const sub = document.createElement('div');
  sub.className = 'sub';
  sub.textContent = `${t('gettingStarted.progress')(doneCount, steps.length)} · ${t('gettingStarted.intro')}`;
  left.append(h3, sub);
  head.append(left, hideButton());
  card.append(head);

  // The first open step is the one to do next: it alone gets the accent button.
  const nextKey = steps.find(s => !s.done)?.key;
  const list = document.createElement('ol');
  list.className = 'gs-list';
  for (const step of steps) {
    const li = document.createElement('li');
    li.className = 'gs-step' + (step.done ? ' done' : '') + (step.key === nextKey ? ' next' : '');
    li.dataset.step = step.key;

    const mark = document.createElement('span');
    mark.className = 'gs-mark';
    if (step.done) {
      mark.append(icon('check', 14));
      mark.setAttribute('role', 'img');
      mark.setAttribute('aria-label', t('gettingStarted.doneLabel'));
    } else {
      mark.setAttribute('aria-hidden', 'true');
      mark.textContent = String(steps.indexOf(step) + 1);
    }

    const text = document.createElement('div');
    text.className = 'gs-text';
    const title = document.createElement('div');
    title.className = 'gs-title';
    title.textContent = t(`gettingStarted.steps.${step.key}.title`);
    const body = document.createElement('div');
    body.className = 'gs-body';
    body.textContent = t(`gettingStarted.steps.${step.key}.body`);
    text.append(title, body);
    li.append(mark, text);

    if (!step.done) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn btn-sm ' + (step.key === nextKey ? 'btn-accent' : 'btn-ghost');
      btn.textContent = t(`gettingStarted.steps.${step.key}.action`);
      btn.addEventListener('click', () => {
        Promise.resolve(ACTIONS[step.key]()).catch(err => console.error(`getting started: ${step.key} failed:`, err));
      });
      li.append(btn);
    }
    list.append(li);
  }
  card.append(list);

  if (simple) {
    const note = document.createElement('div');
    note.className = 'gs-note';
    note.textContent = t('gettingStarted.simpleNote');
    card.append(note);
  }
  return card;
}

function buildDone() {
  const card = document.createElement('div');
  card.className = 'card getting-started gs-complete';
  const head = document.createElement('div');
  head.className = 'card-title';
  const left = document.createElement('div');
  const h3 = document.createElement('h3');
  h3.textContent = t('gettingStarted.doneTitle');
  const sub = document.createElement('div');
  sub.className = 'sub';
  sub.textContent = t('gettingStarted.doneBody');
  left.append(h3, sub);
  head.append(left);
  card.append(head);

  const actions = document.createElement('div');
  actions.className = 'gs-actions';
  const full = document.createElement('button');
  full.type = 'button';
  full.className = 'btn btn-accent btn-sm';
  full.textContent = t('gettingStarted.switchFull');
  full.addEventListener('click', () => setUiMode('full'));
  const keep = document.createElement('button');
  keep.type = 'button';
  keep.className = 'btn btn-ghost btn-sm';
  keep.textContent = t('gettingStarted.keepSimple');
  keep.addEventListener('click', () => dismiss(card));
  actions.append(full, keep);
  card.append(actions);
  return card;
}

function hideButton() {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn btn-ghost btn-sm';
  btn.textContent = t('gettingStarted.hide');
  btn.title = t('gettingStarted.hideTitle');
  btn.addEventListener('click', () => dismiss(btn.closest('.card')));
  return btn;
}

async function dismiss(card) {
  card?.remove();
  try {
    await updateMeta(state, (meta) => ({ ...meta, getting_started_dismissed: true }));
  } catch (err) {
    // Another budget was opened meanwhile: the Hide was for one no longer shown.
    if (err instanceof StaleBudgetError) return;
    console.error('getting started: dismiss failed:', err);
    toast(t('gettingStarted.dismissFailed'));
  }
}
