// @vitest-environment jsdom
// Envelopes list: the writes its row actions make. Array order IS display
// order, so a reorder (drag, drop, Alt+Arrow, whole-category move) dispatches
// envelope.reorder with the spliced order; the favourite star dispatches
// envelope.update, and the view / collapse toggles are the other things this
// page persists. Drives the real js/pages/envelopes.js through the real browser
// session; the storage boundary (writeBatch) is the fake that records writes.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../js/app.js', async () => (await import('./_fakes/pageApp.js')).appStub);

import { render } from '../js/pages/envelopes.js';
import { t } from '../js/ui/i18n.js';
import {
  state, session, updateStatusBar, writeBatch, savePrefs, prefs, resetState, mountHosts, flush, sheetIsOpen, toastTexts,
} from './_fakes/pageApp.js';

const root = () => document.getElementById('app-root');
const cards = () => [...root().querySelectorAll('[data-env-id]')];
const card = (id) => root().querySelector(`[data-env-id="${id}"]`);
const order = () => cards().map(c => c.dataset.envId);
const savedEnvelopes = () => writeBatch.mock.calls.at(-1)?.[1].find(i => i.filename === 'envelopes.json')?.data;
const savedIds = () => savedEnvelopes()?.map(e => e.id);
const envelopeWrites = () => writeBatch.mock.calls.filter(c => c[1].some(i => i.filename === 'envelopes.json'));
const groupHead = (cat) => root().querySelector(`[data-group-cat="${cat}"] > div`);
const groupToggle = (cat) => root().querySelector(`[data-group-cat="${cat}"] .group-toggle`);

function dragEvent(el, type) {
  const ev = new Event(type, { bubbles: true, cancelable: true });
  ev.dataTransfer = { effectAllowed: '', dropEffect: '' };
  el.dispatchEvent(ev);
  return ev;
}
const drag = (from, onto) => { dragEvent(from, 'dragstart'); dragEvent(onto, 'dragover'); dragEvent(onto, 'drop'); dragEvent(from, 'dragend'); };
const altKey = (el, key) => el.dispatchEvent(new KeyboardEvent('keydown', { key, altKey: true, bubbles: true, cancelable: true }));

async function openPage() {
  mountHosts();
  await render(root());
}

beforeEach(async () => {
  vi.stubGlobal('requestAnimationFrame', (cb) => setTimeout(cb, 0));
  // jsdom has no CSS.escape; the keyboard moves use it to re-focus the card.
  vi.stubGlobal('CSS', { escape: (s) => String(s) });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  resetState({
    transactions: [
      { id: 'i1', type: 'income', date: '2026-09-01', payee: 'Job', amount: 300, envelope_id: 'food', account: 'chk', status: 'posted' },
    ],
  });
  state.envelopes = [
    { id: 'food', name: 'Food', category: 'living' },
    { id: 'fun', name: 'Fun', category: 'living' },
    { id: 'rent', name: 'Rent', category: 'housing' },
    { id: 'gym', name: 'Gym', category: 'living' },
  ];
  await openPage();
});

describe('envelopes list', () => {
  it('distinguishes a positive balance with a projected gap from a negative balance', async () => {
    const real = session.query.bind(session);
    const spy = vi.spyOn(session, 'query').mockImplementation((name,input) => {
      const result = real(name,input);
      if (name !== 'envelopes.month' || !result.ok) return result;
      return {ok:true,value:{...result.value,envelopes:result.value.envelopes.map(row => ({...row,
        balance:row.id === 'fun' ? -10 : 300,
        spare:{...row.spare,spare:row.id === 'food' ? -20 : 30},
      }))}};
    });
    try {
      await openPage();
      const filter = root().querySelector('select[aria-label="' + t('workspace.views') + '"]');
      filter.value = 'gap'; filter.dispatchEvent(new Event('change'));
      expect(order()).toEqual(['food']);
      filter.value = 'negative'; filter.dispatchEvent(new Event('change'));
      expect(order()).toEqual(['fun']);
      expect(writeBatch).not.toHaveBeenCalled();
    } finally { spy.mockRestore(); }
  });
  it('shows one card per active envelope, grouped by category in array order', () => {
    expect(order()).toEqual(['food', 'fun', 'gym', 'rent']);
  });

  it('archived envelopes are hidden unless the setting shows them', async () => {
    state.envelopes = state.envelopes.map(e => (e.id === 'gym' ? { ...e, archived: true } : e));
    await openPage();
    expect(order()).toEqual(['food', 'fun', 'rent']);
    state.meta = { show_archived_envelopes: true };
    await openPage();
    // Shown archived envelopes sit together in one Archived group at the end.
    expect(order()).toEqual(['food', 'fun', 'rent', 'gym']);
  });

  it('shown archived envelopes get one Archived group and the head counts them', async () => {
    state.envelopes = [
      ...state.envelopes,
      { id: 'available', name: 'Available', category: 'Unallocated', archived: true },
    ];
    await openPage();
    const sub = () => root().querySelector('.page-head-sub').textContent;
    expect(sub()).toContain(t('envelopes.countN')(4));
    expect(root().querySelector('[data-group-cat="Unallocated"]')).toBeNull();

    state.meta = { show_archived_envelopes: true };
    await openPage();
    expect(sub()).toContain(t('envelopes.countWithArchived')(5, 1));
    // No group named after the archived envelope's own category.
    expect(root().querySelector('[data-group-cat="Unallocated"]')).toBeNull();
    const groups = [...root().querySelectorAll('[data-group-cat]')];
    const last = groups.at(-1);
    expect(last.querySelector('h3').textContent).toBe(t('envelopes.archivedGroup'));
    expect([...last.querySelectorAll('[data-env-id]')].map(c => c.dataset.envId)).toEqual(['available']);
    // The Archived group is not a drag source for the category order.
    expect(last.firstElementChild.draggable).toBe(false);
  });

  it('the New button opens the editor for a new envelope', () => {
    root().querySelector('#env-new').click();
    expect(sheetIsOpen()).toBe(true);
  });

  it('a card\'s edit button opens the editor', () => {
    card('fun').querySelector('button[aria-label="' + t('envelopes.editTitle') + '"], .btn-icon').click();
    expect(sheetIsOpen()).toBe(true);
  });
});

describe('reorder', () => {
  it('dropping a card on another in its category splices the array and saves it', async () => {
    drag(card('gym'), card('food'));
    await flush();
    // gym takes food's slot in the underlying array; the rest shift down.
    expect(savedIds()).toEqual(['gym', 'food', 'fun', 'rent']);
    expect(state.envelopes.map(e => e.id)).toEqual(['gym', 'food', 'fun', 'rent']);
    expect(order()).toEqual(['gym', 'food', 'fun', 'rent']);
    expect(envelopeWrites()).toHaveLength(1);
    expect(writeBatch.mock.calls[0][0]).toBe(state.budgetFolder);
    expect(updateStatusBar).toHaveBeenCalled();
  });

  it('dropping onto a card of another category is ignored', async () => {
    drag(card('food'), card('rent'));
    await flush();
    expect(envelopeWrites()).toHaveLength(0);
    expect(state.envelopes.map(e => e.id)).toEqual(['food', 'fun', 'rent', 'gym']);
  });

  it('dropping a card on itself is ignored', async () => {
    drag(card('food'), card('food'));
    await flush();
    expect(envelopeWrites()).toHaveLength(0);
  });

  it('Alt+ArrowDown moves the focused card past its neighbour', async () => {
    altKey(card('food'), 'ArrowDown');
    await flush();
    expect(savedIds()).toEqual(['fun', 'food', 'rent', 'gym']);
  });

  it('Alt+ArrowUp on the first card of a group writes nothing', async () => {
    altKey(card('food'), 'ArrowUp');
    await flush();
    expect(envelopeWrites()).toHaveLength(0);
  });

  it('dragging a category header before another moves the whole group, keeping inner order', async () => {
    dragEvent(groupHead('housing'), 'dragstart');
    dragEvent(groupHead('living'), 'dragover');
    dragEvent(groupHead('living'), 'drop');
    dragEvent(groupHead('housing'), 'dragend');
    await flush();
    expect(savedIds()).toEqual(['rent', 'food', 'fun', 'gym']);
  });

  it('Alt+ArrowDown on a category toggle moves the group below the next one', async () => {
    altKey(groupToggle('living'), 'ArrowDown');
    await flush();
    expect(savedIds()).toEqual(['rent', 'food', 'fun', 'gym']);
  });

  it('repaints at once, before the dispatch settles', async () => {
    let release;
    writeBatch.mockImplementationOnce(() => new Promise(r => { release = r; }));
    drag(card('gym'), card('food'));
    await flush();
    expect(order()).toEqual(['gym', 'food', 'fun', 'rent']);
    expect(state.envelopes.map(e => e.id)).toEqual(['food', 'fun', 'rent', 'gym']);
    release();
    await flush();
    expect(state.envelopes.map(e => e.id)).toEqual(['gym', 'food', 'fun', 'rent']);
  });

  it('a second move while one is pending is computed from the page-local order and lands after it', async () => {
    let release;
    writeBatch.mockImplementationOnce(() => new Promise(r => { release = r; }));
    drag(card('gym'), card('food'));                     // gym, food, fun, rent
    altKey(groupToggle('housing'), 'ArrowUp');           // housing group above the living group
    await flush();
    expect(order()).toEqual(['rent', 'gym', 'food', 'fun']);
    expect(envelopeWrites()).toHaveLength(1);            // only the first has reached storage; the second waits
    release();
    await flush();
    expect(envelopeWrites()).toHaveLength(2);
    expect(savedIds()).toEqual(['rent', 'gym', 'food', 'fun']);
    expect(state.envelopes.map(e => e.id)).toEqual(['rent', 'gym', 'food', 'fun']);
  });

  it('a failed reorder is reported, leaves state.envelopes alone and repaints the old order', async () => {
    const before = state.envelopes;
    writeBatch.mockImplementationOnce(async () => { throw new Error('offline'); });
    altKey(card('food'), 'ArrowDown');
    await flush();
    expect(toastTexts().some(x => x.includes('offline'))).toBe(true);
    expect(state.envelopes).toBe(before);
    expect(order()).toEqual(['food', 'fun', 'gym', 'rent']);
  });

  it('a failed reorder with a favourite pending behind it: the page ends showing state, not the rejected order', async () => {
    let fail;
    writeBatch.mockImplementationOnce(() => new Promise((_, rej) => { fail = rej; }));
    altKey(card('food'), 'ArrowDown');                   // reorder A, held in storage
    await flush();
    card('rent').querySelector('.env-fav').click();      // favourite B, queued behind A
    await flush();
    fail(new Error('offline'));
    await flush();
    expect(toastTexts().some(x => x.includes('offline'))).toBe(true);
    expect(state.envelopes.map(e => e.id)).toEqual(['food', 'fun', 'rent', 'gym']);
    expect(state.envelopes.find(e => e.id === 'rent').favorite).toBe(true);
    expect(order()).toEqual(['food', 'fun', 'gym', 'rent']);
    expect(card('rent').querySelector('.env-fav').classList.contains('is-on')).toBe(true);
  });

  it('after a budget switch a failed dispatch does not repaint over the other budget', async () => {
    let fail;
    writeBatch.mockImplementationOnce(() => new Promise((_, rej) => { fail = rej; }));
    altKey(card('food'), 'ArrowDown');
    await flush();
    const painted = root().innerHTML;
    state.budgetFolder = { name: 'budget-B' };
    state.envelopes = [{ id: 'b-only', name: 'B env', category: 'x' }];
    fail(new Error('offline'));
    await flush();
    expect(root().innerHTML).toBe(painted);
  });

  it('the order handed to envelope.reorder is a full permutation, archived included', async () => {
    state.envelopes = state.envelopes.map(e => (e.id === 'gym' ? { ...e, archived: true } : e));
    await openPage();
    drag(card('fun'), card('food'));
    await flush();
    expect(savedIds()).toEqual(['fun', 'food', 'rent', 'gym']);
    expect(savedEnvelopes().find(e => e.id === 'gym').archived).toBe(true);
  });

  it('with archived envelopes shown, a reorder repaints their new order', async () => {
    state.meta = { show_archived_envelopes: true };
    state.envelopes = state.envelopes.map(e => (e.id === 'gym' || e.id === 'rent' ? { ...e, archived: true } : e));
    await openPage();
    expect(order()).toEqual(['food', 'fun', 'rent', 'gym']);
    drag(card('gym'), card('rent'));
    await flush();
    expect(order()).toEqual(['food', 'fun', 'gym', 'rent']);
    // An archived card does not drop into an active category.
    const writes = envelopeWrites().length;
    drag(card('gym'), card('food'));
    await flush();
    expect(envelopeWrites()).toHaveLength(writes);
  });
});

describe('favourite, view and collapse', () => {
  it('the star writes favorite: true on just that envelope, and again to clear it', async () => {
    card('fun').querySelector('.env-fav').click();
    await flush();
    const first = savedEnvelopes();
    expect(first.filter(e => e.favorite).map(e => e.id)).toEqual(['fun']);
    expect(first.map(e => e.id)).toEqual(['food', 'fun', 'rent', 'gym']);

    card('fun').querySelector('.env-fav').click();
    await flush();
    expect(savedEnvelopes().find(e => e.id === 'fun').favorite).toBe(false);
  });

  it('the star changes only favorite: a legacy goal keeps no goal_start, its amount and rollover as stored', async () => {
    const car = { id: 'car', name: 'Car', category: 'goals', goal_amount: 999.999, goal_date: '2027-06-01', rollover: 'carry' };
    state.envelopes = [...state.envelopes, car];
    await openPage();
    card('car').querySelector('.env-fav').click();
    await flush();
    expect(savedEnvelopes().find(e => e.id === 'car')).toEqual({ ...car, favorite: true });
    expect(state.envelopes.find(e => e.id === 'car')).not.toHaveProperty('goal_start');
  });

  it('a failed favourite is reported and the star goes back', async () => {
    const before = state.envelopes;
    writeBatch.mockImplementationOnce(async () => { throw new Error('offline'); });
    card('fun').querySelector('.env-fav').click();
    await flush();
    expect(toastTexts().some(x => x.includes('offline'))).toBe(true);
    expect(state.envelopes).toBe(before);
    expect(state.envelopes.find(e => e.id === 'fun').favorite).toBeUndefined();
    expect(card('fun').querySelector('.env-fav').classList.contains('is-on')).toBe(false);
  });

  it('the list toggle is a pref, not an envelope write', async () => {
    root().querySelectorAll('.view-toggle-btn')[1].click();
    await flush();
    expect(savePrefs).toHaveBeenCalledWith({ envView: 'list' });
    expect(envelopeWrites()).toHaveLength(0);
    expect(root().querySelector('.env-list')).toBeTruthy();
  });

  it('the list view has an edit button that opens the editor', async () => {
    prefs.envView = 'list';
    await openPage();
    root().querySelector('.env-list-row .env-list-actions button').click();
    expect(sheetIsOpen()).toBe(true);
  });

  it('collapsing a group stores it in prefs', () => {
    groupToggle('housing').click();
    expect(savePrefs).toHaveBeenCalledWith({ envGroupsCollapsed: ['housing'] });
    expect(envelopeWrites()).toHaveLength(0);
  });
});
