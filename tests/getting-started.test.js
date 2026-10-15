// @vitest-environment jsdom
// The Overview's getting-started checklist (js/pages/getting-started.js):
// which steps a budget has done, which card it gets in simple and full mode,
// and where each button sends the user. Also the two other pieces of the
// first-run path: the wizard's starter envelopes and the simple-mode tour.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../js/app.js', async () => (await import('./_fakes/pageApp.js')).appStub);
vi.mock('../js/state/meta-writes.js', () => ({
  StaleBudgetError: class extends Error {},
  updateMeta: vi.fn(async (state, patch) => { state.meta = await patch(state.meta || {}); return state.meta; }),
}));

import { gettingStartedSteps, gettingStartedCardKind, buildGettingStartedCard, greetingKey } from '../js/pages/getting-started.js';
import { buildStarterEnvelopes, STARTER_ENVELOPES } from '../js/state/starter-envelopes.js';
import { tourSteps } from '../js/ui/tour.js';
import { updateMeta } from '../js/state/meta-writes.js';
import { t } from '../js/ui/i18n.js';
import { state, prefs, navigate, savePrefs, resetState, mountHosts, flush } from './_fakes/pageApp.js';

const empty = () => ({ accounts: [], envelopes: [], budgetItems: [], transactions: [], meta: {} });
const doneKeys = (budget) => gettingStartedSteps(budget).filter(s => s.done).map(s => s.key);

describe('gettingStartedSteps', () => {
  it('has nothing done on a new budget', () => {
    expect(doneKeys(empty())).toEqual([]);
  });

  it('reads each step off the budget itself', () => {
    const b = {
      ...empty(),
      accounts: [{ id: 'chk' }],
      envelopes: [{ id: 'food' }],
      transactions: [{ type: 'income' }, { type: 'expense' }],
    };
    expect(doneKeys(b)).toEqual(['account', 'envelopes', 'expense']);
    b.budgetItems = [{ id: 'sal' }];
    b.transactions.push({ type: 'fill', lines: [] });
    expect(doneKeys(b)).toEqual(['account', 'envelopes', 'plan', 'fill', 'expense']);
  });
});

describe('gettingStartedCardKind', () => {
  const complete = () => ({
    ...empty(),
    accounts: [{ id: 'chk' }], envelopes: [{ id: 'food' }], budgetItems: [{ id: 'sal' }],
    transactions: [{ type: 'fill' }, { type: 'expense' }],
  });

  it('shows the checklist while a step is open, in either mode', () => {
    expect(gettingStartedCardKind(empty(), { simple: true })).toBe('checklist');
    expect(gettingStartedCardKind(empty(), { simple: false })).toBe('checklist');
  });

  it('offers full mode once everything is done in simple mode, and shows nothing in full mode', () => {
    expect(gettingStartedCardKind(complete(), { simple: true })).toBe('done');
    expect(gettingStartedCardKind(complete(), { simple: false })).toBeNull();
  });

  it('shows nothing once hidden for this budget', () => {
    const b = { ...empty(), meta: { getting_started_dismissed: true } };
    expect(gettingStartedCardKind(b, { simple: true })).toBeNull();
  });
});

describe('the Overview card', () => {
  beforeEach(() => {
    resetState();
    mountHosts();
    updateMeta.mockClear();
  });

  it('is absent for a budget that has every step done (the page test ledger)', () => {
    state.budgetItems = [{ id: 'sal' }];
    state.transactions = [{ type: 'fill' }, { type: 'expense' }];
    expect(buildGettingStartedCard()).toBeNull();
  });

  it('lists the steps, ticks the done ones and makes the first open one the accent button', () => {
    // resetState gives two accounts and three envelopes, nothing else.
    const card = buildGettingStartedCard();
    const steps = [...card.querySelectorAll('.gs-step')];
    expect(steps.map(s => s.dataset.step)).toEqual(['account', 'envelopes', 'plan', 'fill', 'expense']);
    expect(steps.filter(s => s.classList.contains('done')).map(s => s.dataset.step)).toEqual(['account', 'envelopes']);
    expect(card.querySelector('.card-title .sub').textContent).toContain(t('gettingStarted.progress')(2, 5));

    const next = card.querySelector('.gs-step.next');
    expect(next.dataset.step).toBe('plan');
    expect(next.querySelector('button').className).toContain('btn-accent');
    // Done steps have no button; later open ones are ghost buttons.
    expect(steps[0].querySelector('button')).toBeNull();
    expect(steps[3].querySelector('button').className).toContain('btn-ghost');
  });

  it('sends the plan step to the Budget plan page', () => {
    const card = buildGettingStartedCard();
    card.querySelector('.gs-step[data-step="plan"] button').click();
    expect(navigate).toHaveBeenCalledWith('budget-plan');
  });

  it('opens the new-account sheet for the account step', async () => {
    state.accounts = [];
    document.getElementById('app-root').append(buildGettingStartedCard());
    document.querySelector('.gs-step[data-step="account"] button').click();
    await vi.waitFor(() => expect(document.querySelector('#sheet-host input[name="initialBalance"]')).not.toBeNull());
  });

  it('Hide removes the card and records it on this budget', async () => {
    const card = buildGettingStartedCard();
    document.getElementById('app-root').append(card);
    [...card.querySelectorAll('button')].find(b => b.textContent === t('gettingStarted.hide')).click();
    await flush();
    expect(card.isConnected).toBe(false);
    expect(updateMeta).toHaveBeenCalledTimes(1);
    expect(state.meta.getting_started_dismissed).toBe(true);
  });

  it('notes simple mode only while in it', () => {
    expect(buildGettingStartedCard().querySelector('.gs-note')).toBeNull();
    prefs.uiMode = 'simple';
    expect(buildGettingStartedCard().querySelector('.gs-note').textContent).toBe(t('gettingStarted.simpleNote'));
  });

  describe('with every step done in simple mode', () => {
    beforeEach(() => {
      prefs.uiMode = 'simple';
      state.budgetItems = [{ id: 'sal' }];
      state.transactions = [{ type: 'fill' }, { type: 'expense' }];
    });

    it('offers full mode, which switches the preference', () => {
      const card = buildGettingStartedCard();
      expect(card.querySelector('h3').textContent).toBe(t('gettingStarted.doneTitle'));
      [...card.querySelectorAll('button')].find(b => b.textContent === t('gettingStarted.switchFull')).click();
      expect(savePrefs).toHaveBeenCalledWith({ uiMode: 'full' });
    });

    it('Keep simple mode hides the card for this budget', async () => {
      const card = buildGettingStartedCard();
      document.getElementById('app-root').append(card);
      [...card.querySelectorAll('button')].find(b => b.textContent === t('gettingStarted.keepSimple')).click();
      await flush();
      expect(card.isConnected).toBe(false);
      expect(state.meta.getting_started_dismissed).toBe(true);
      expect(savePrefs).not.toHaveBeenCalled();
    });
  });
});

describe('buildStarterEnvelopes', () => {
  const all = STARTER_ENVELOPES.map(s => s.key);

  it('builds the picked envelopes in offer order with the Envelopes page id rule', () => {
    const out = buildStarterEnvelopes(['fun', 'housing']);
    expect(out).toEqual([
      { id: 'essentials-housing', name: 'Housing', category: 'Essentials', archived: false },
      { id: 'lifestyle-fun-money', name: 'Fun money', category: 'Lifestyle', archived: false },
    ]);
  });

  it('gives every envelope a distinct id, clear of existing ones', () => {
    const out = buildStarterEnvelopes(all, [{ id: 'essentials-groceries', name: 'Food' }]);
    expect(out).toHaveLength(all.length);
    const ids = out.map(e => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain('essentials-groceries-2');
  });

  it('skips a name the budget already has, whatever its case', () => {
    const out = buildStarterEnvelopes(all, [{ id: 'x', name: 'groceries' }]);
    expect(out.map(e => e.name)).not.toContain('Groceries');
    expect(out).toHaveLength(all.length - 1);
  });

  it('builds nothing when everything is unticked', () => {
    expect(buildStarterEnvelopes([])).toEqual([]);
  });
});

describe('tourSteps', () => {
  const keys = (opts) => tourSteps(opts).map(s => s.key);

  it('teaches the first budgeting cycle independently of AI availability', () => {
    const core = ['welcome', 'rail', 'accounts', 'envelopes', 'budget',
      'unallocated', 'transactions', 'dashboard', 'finish'];
    expect(keys({ aiOn: false, simple: false })).toEqual(core);
    expect(keys({ aiOn: true, simple: false })).toEqual(core);
  });

  it('simple mode skips the pages it hides and says where they went', () => {
    expect(keys({ aiOn: true, simple: true })).toEqual([
      'welcome', 'rail', 'accounts', 'envelopes', 'budget', 'unallocated',
      'transactions', 'dashboard', 'simpleMode', 'finish',
    ]);
  });
});

// BACKLOG 2026-10-05: a brand-new user's first Overview said "welcome back".
describe('greetingKey', () => {
  const complete = () => ({
    ...empty(),
    accounts: [{ id: 'chk' }], envelopes: [{ id: 'food' }], budgetItems: [{ id: 'sal' }],
    transactions: [{ type: 'fill' }, { type: 'expense' }],
  });
  it('greets a budget still on its first steps, or a guest, without "back"', () => {
    expect(greetingKey(empty(), { guest: false })).toBe('dashboard.welcomeNew');
    expect(greetingKey(complete(), { guest: true })).toBe('dashboard.welcomeNew');
    expect(t('dashboard.welcomeNew')).not.toMatch(/back/i);
  });
  it('says welcome back to an established budget', () => {
    expect(greetingKey(complete(), { guest: false })).toBe('dashboard.welcome');
  });
});
