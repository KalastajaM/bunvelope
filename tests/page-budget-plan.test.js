// @vitest-environment jsdom
// Budget Plan page: the totals rendered for a known plan, the grouping and
// filters, and the updates the row chips dispatch (include toggle, emergency
// toggle, schedule popover, stress popover and its cut sliders). Drives the
// real js/pages/budget-plan.js, whose live controls queue budgetItem.update
// through the debounced dispatch (js/ui/debounced-dispatch.js) into the real
// browser session (tests/_fakes/pageApp.js); the session's write (writeBatch)
// is the fake that records what would be written. The fixture items are deep
// frozen: the page must never edit a stored item in place. The item editor has
// its own file (page-budget-plan-editor).
//
// There is no reorder UI on this page: items are grouped by category and the
// array order is only the order within a group, so "reorder" has nothing to
// drive here.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../js/app.js', async () => (await import('./_fakes/pageApp.js')).appStub);

import { render } from '../js/pages/budget-plan.js';
import { t, fmtMonthLang } from '../js/ui/i18n.js';
import { fmt } from '../js/utils.js';
import {
  state, session, writeBatch, runDueScheduled, resetState, mountHosts, flush, setValue, sheetIsOpen, topOverlay,
} from './_fakes/pageApp.js';

const rows = () => [...document.querySelectorAll('.bp-list-row')];
const rowFor = (needle) => rows().find(r => r.textContent.includes(needle));
const rowOfEnvelope = (id, needle) => rows().find(r => r.dataset.envelopeId === id && (!needle || r.textContent.includes(needle)));
const heads = () => [...document.querySelectorAll('.bp-list-section-head')].map(h => [...h.children].map(c => c.textContent));
// The plan items the session last wrote.
const written = () => writeBatch.mock.calls.at(-1)?.[1].find(i => i.filename === 'budget-items.json')?.data;
const stored = (id) => state.budgetItems.find(i => i.id === id);
// The budgetItem.update inputs the page dispatched.
const dispatchSpy = vi.spyOn(session, 'dispatch');
const updates = () => dispatchSpy.mock.calls.filter(([name]) => name === 'budgetItem.update').map(([, input]) => input);
// Live edits go out after 400 ms of quiet; then the write lands.
const settle = async () => { await new Promise(r => setTimeout(r, 450)); await flush(); };

const deepFreeze = (o) => {
  for (const v of Object.values(o)) if (v && typeof v === 'object') deepFreeze(v);
  return Object.freeze(o);
};
const setItems = (...items) => { state.budgetItems = items.map(deepFreeze); };

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const every = () => Object.fromEntries(MONTHS.map(m => [m, true]));

let groceries, cinema, rent, salary, paused, transfer;

async function openPage() {
  mountHosts();
  await render(document.getElementById('app-root'));
}

beforeEach(async () => {
  // A row popover left open by the last test listens on the document and
  // would swallow this test's first click: dismiss it.
  document.body.click();
  vi.stubGlobal('requestAnimationFrame', (cb) => setTimeout(cb, 0));
  sessionStorage.clear();
  resetState();
  groceries = { id: 'g', kind: 'expense', envelope_id: 'food', description: 'Weekly shop', default_amount: -100, extra_buffer: 0, include: true, monthly_schedule: every(), as_schedule: false };
  cinema = { id: 'c', kind: 'expense', envelope_id: 'fun', description: 'Cinema', default_amount: -20, extra_buffer: 10, include: true, monthly_schedule: { Jan: true, Feb: true, Mar: 45 }, as_schedule: false };
  rent = { id: 'r', kind: 'expense', envelope_id: 'rent', description: '', default_amount: -700, extra_buffer: 0, include: true, monthly_schedule: every(), as_schedule: false, include_in_emergency_budget: true };
  salary = { id: 's', kind: 'income', envelope_id: null, description: 'Salary', default_amount: 3000, extra_buffer: 0, include: true, monthly_schedule: every(), as_schedule: false };
  paused = { id: 'p', kind: 'expense', envelope_id: 'fun', description: 'Gym', default_amount: -30, extra_buffer: 0, include: false, monthly_schedule: every(), as_schedule: false };
  transfer = { id: 't', kind: 'account_transfer', envelope_id: null, description: 'Move to savings', default_amount: 200, extra_buffer: 0, include: true, monthly_schedule: every(), as_schedule: false };
  setItems(groceries, cinema, rent, salary, paused, transfer);
  writeBatch.mockReset();
  writeBatch.mockImplementation(async () => {});
  dispatchSpy.mockClear();
  runDueScheduled.mockClear();
  await openPage();
});

describe('totals for a known plan', () => {
  it('footer is the annual expense total of the included items; transfers and paused items do not count', () => {
    // groceries 1200 + cinema (20+20+45+10 buffer = 95) + rent 8400. Paused gym and the transfer are out.
    expect(document.querySelector('#bp-annual-total').textContent).toBe(fmt(1200 + 95 + 8400));
  });

  it('an ended item counts nothing and an ending one only its months still to come', async () => {
    // The fake clock is 15 Sep 2026: groceries runs Sep–Dec (4 × 100), rent ended in August.
    setItems({ ...groceries, end_month: '2026-12' }, { ...rent, end_month: '2026-08' });
    await openPage();
    expect(document.querySelector('#bp-annual-total').textContent).toBe(fmt(400));
  });

  it('header shows income, budget, the surplus and the included item count', () => {
    const stats = [...document.querySelectorAll('#bp-stats .bp-stat')].map(e => e.textContent);
    const income = 36000;
    const budget = 9695;
    expect(stats[1]).toBe(t('budgetPlan.income')(fmt(income)));
    expect(stats[2]).toBe(t('budgetPlan.budget')(fmt(budget)));
    const pill = document.querySelector('#bp-stats .bp-diff-pill');
    expect(pill.classList.contains('is-pos')).toBe(true);
    expect(pill.textContent).toBe(t('budgetPlan.underBudget')(fmt(income - budget)));
    // Five of six are included (the paused one is not).
    expect(stats[0]).toBe(t('budgetPlan.itemsCount')(5));
  });

  it('a plan spending more than it earns reads over budget', async () => {
    setItems(rent);
    await openPage();
    const pill = document.querySelector('#bp-stats .bp-diff-pill');
    expect(pill.classList.contains('is-neg')).toBe(true);
    expect(pill.textContent).toBe(t('budgetPlan.overBudget')(fmt(8400)));
  });

  it('groups: Income first, Transfers next, then categories alphabetically, each with its own total', () => {
    expect(heads()).toEqual([
      [t('budgetPlan.incomeGroup'), `${t('budgetPlan.sectionCount')(1)} · ${fmt(36000)}`],
      [t('budgetPlan.transfersGroup'), `${t('budgetPlan.sectionCount')(1)} · ${fmt(2400)}`],
      ['housing', `${t('budgetPlan.sectionCount')(1)} · ${fmt(8400)}`],
      // living: groceries 1200 + cinema 95 (the paused gym is listed but adds nothing)
      ['living', `${t('budgetPlan.sectionCount')(3)} · ${fmt(1295)}`],
    ]);
  });

  it('a row shows its annual figure and per-occurrence default', () => {
    const row = rowFor('Cinema');
    expect(row.querySelector('.bp-row-annual').textContent).toBe(fmt(95));
    expect(row.querySelector('.bp-row-default').textContent).toBe(t('budgetPlan.rowDefault')(fmt(20)));
  });

  it('an empty plan says so and totals zero', async () => {
    state.budgetItems = [];
    await openPage();
    expect(document.querySelector('.empty-state').textContent).toBe(t('budgetPlan.emptyNoItems'));
    expect(document.querySelector('#bp-annual-total').textContent).toBe(fmt(0));
    expect(document.querySelector('#bp-stats .bp-diff-pill').textContent).toBe(t('budgetPlan.onBudget'));
  });
});

describe('filters', () => {
  it('shows upcoming scheduled items from the upcoming query and clears the view', async () => {
    const real = session.query.bind(session);
    const spy = vi.spyOn(session, 'query').mockImplementation((name, input) => name === 'upcoming'
      ? {ok:true,value:{coming:[{forecast_budget_item_id:'g',date:'2026-09-20'}],overdue:[]}}
      : real(name,input));
    try {
      await openPage();
      [...document.querySelectorAll('.workspace-task-filters button')].find(b => b.textContent === t('workspace.upcoming')).click();
      expect(rows()).toHaveLength(1);
      expect(rows()[0].textContent).toContain('2026-09-20');
      document.querySelector('#bp-filter-clear').click();
      expect(rows().length).toBeGreaterThan(1);
    } finally { spy.mockRestore(); }
  });
  it('"disabled only" shows just the paused item and "enabled only" hides it', () => {
    const sel = document.querySelector('#bp-filter-enabled');
    setValue(sel, 'disabled', ['change']);
    expect(rows()).toHaveLength(1);
    expect(rows()[0].classList.contains('bp-list-row--excluded')).toBe(true);
    setValue(sel, 'enabled', ['change']);
    expect(rows()).toHaveLength(5);
    expect(rows().some(r => r.classList.contains('bp-list-row--excluded'))).toBe(false);
  });

  it('filters by category, and the clear button resets everything', () => {
    setValue(document.querySelector('#bp-filter-cat'), 'housing', ['change']);
    expect(rows()).toHaveLength(1);
    expect(document.querySelector('#bp-filter-clear').style.display).toBe('');
    document.querySelector('#bp-filter-clear').click();
    expect(rows()).toHaveLength(6);
    expect(document.querySelector('#bp-filter-clear').style.display).toBe('none');
  });

  it('search matches the description; a search with no match shows the empty state', async () => {
    const search = document.querySelector('#bp-search');
    setValue(search, 'shop', ['input']);
    await new Promise(r => setTimeout(r, 200));
    expect(rows()).toHaveLength(1);
    setValue(search, 'zzz', ['input']);
    await new Promise(r => setTimeout(r, 200));
    expect(rows()).toHaveLength(0);
    expect(document.querySelector('.empty-state').textContent).toBe(t('budgetPlan.emptyNoMatch'));
  });

  it('emergency filter keeps only the flagged items', () => {
    setValue(document.querySelector('#bp-filter-emergency'), 'yes', ['change']);
    expect(rows()).toHaveLength(1);
    expect(rows()[0].dataset.envelopeId).toBe('rent');
  });
});

describe('row toggles dispatch plan-item updates', () => {
  it('pausing an item shows at once and dispatches include:false after the quiet window', async () => {
    const before = state.budgetItems;
    const row = rowOfEnvelope('food');
    row.querySelector('.bp-toggle-chip--on').click();
    expect(row.classList.contains('bp-list-row--excluded')).toBe(true);
    expect(updates()).toEqual([]);
    await settle();
    expect(updates()).toEqual([{ id: 'g', fields: { include: false } }]);
    // The session publishes a new array with a new row; the stored one is untouched.
    expect(state.budgetItems).not.toBe(before);
    expect(stored('g').include).toBe(false);
    expect(groceries.include).toBe(true);
    expect(written()).toEqual(state.budgetItems);
    expect(document.querySelector('.bp-toast').textContent).toBe(t('budgetPlan.savedToast'));
    expect(runDueScheduled).not.toHaveBeenCalled();
  });

  it('re-enabling a paused scheduled item stamps it and posts what is due, only once the update lands', async () => {
    setItems(groceries, { ...paused, as_schedule: true, account_id: 'chk', payment_day: 10 });
    await openPage();
    const row = rows().find(r => r.classList.contains('bp-list-row--excluded'));
    row.querySelector('.bp-toggle-chip--off').click();
    expect(runDueScheduled).not.toHaveBeenCalled();
    await settle();
    expect(updates()).toEqual([{ id: 'p', fields: { include: true } }]);
    // The command stamps as_schedule_since: a resumed item starts from today.
    expect(stored('p')).toMatchObject({ include: true, as_schedule_since: '2026-09-15' });
    expect(runDueScheduled).toHaveBeenCalledTimes(1);
  });

  it('re-enabling an unscheduled item posts nothing', async () => {
    rows().find(r => r.classList.contains('bp-list-row--excluded')).querySelector('.bp-toggle-chip--off').click();
    await settle();
    expect(stored('p').include).toBe(true);
    expect(runDueScheduled).not.toHaveBeenCalled();
  });

  it('a failed update repaints from state, says why and posts nothing', async () => {
    setItems(groceries, { ...paused, as_schedule: true, account_id: 'chk', payment_day: 10 });
    await openPage();
    writeBatch.mockImplementationOnce(async () => { throw new Error('disk full'); });
    const before = state.budgetItems;
    rowFor('Gym').querySelector('.bp-toggle-chip--off').click();
    expect(rowFor('Gym').classList.contains('bp-list-row--excluded')).toBe(false);
    await settle();
    expect(state.budgetItems).toBe(before);
    // Repainted from state: the row is paused again and its chip says so.
    const row = rowFor('Gym');
    expect(row.classList.contains('bp-list-row--excluded')).toBe(true);
    expect(row.querySelector('.bp-toggle-chip--off')).toBeTruthy();
    expect(document.querySelector('.bp-toast').textContent).toContain('disk full');
    expect(runDueScheduled).not.toHaveBeenCalled();
  });

  it('quick clicks coalesce into one update, the last value winning', async () => {
    const chip = rowOfEnvelope('food').querySelector('.bp-toggle-chip');
    chip.click();
    chip.click();
    chip.click();
    await settle();
    expect(updates()).toEqual([{ id: 'g', fields: { include: false } }]);
    expect(stored('g').include).toBe(false);
  });

  it('the emergency chip dispatches include_in_emergency_budget', async () => {
    rowOfEnvelope('rent').querySelector('.bp-toggle-chip--emerg-on').click();
    await settle();
    expect(updates()).toEqual([{ id: 'r', fields: { include_in_emergency_budget: false } }]);
    expect(stored('r').include_in_emergency_budget).toBe(false);
  });

  it('income and transfer rows have no emergency chip', () => {
    for (const r of [rowFor('Salary'), rowFor('Move to savings')]) {
      expect(r.querySelector('.bp-toggle-chip--emerg-on, .bp-toggle-chip--emerg-off')).toBeNull();
    }
  });

  it('toggling the chip does not open the editor sheet', async () => {
    rowOfEnvelope('food').querySelector('.bp-toggle-chip--on').click();
    await settle();
    expect(sheetIsOpen()).toBe(false);
  });

  it('a pending edit is sent before the editor opens, so the editor sees it', async () => {
    rowOfEnvelope('rent').querySelector('.bp-toggle-chip--emerg-on').click();
    rowOfEnvelope('rent').click();
    await flush();
    await flush();
    // Sent at once, not after the quiet window.
    expect(updates()).toEqual([{ id: 'r', fields: { include_in_emergency_budget: false } }]);
    expect(stored('r').include_in_emergency_budget).toBe(false);
    expect(sheetIsOpen()).toBe(true);
  });

  it('a second row click while the pending edits are still being sent opens one editor', async () => {
    let release;
    writeBatch.mockImplementationOnce(() => new Promise((r) => { release = r; }));
    rowOfEnvelope('rent').querySelector('.bp-toggle-chip--emerg-on').click();
    rowOfEnvelope('rent').click();
    await flush();
    rowOfEnvelope('rent').click();
    await flush();
    release();
    for (let i = 0; i < 5; i++) await flush();
    expect(document.querySelectorAll('#sheet-host .sheet-overlay[data-sheet-open]')).toHaveLength(1);
  });
});

describe('row popovers dispatch plan-item updates', () => {
  it('the schedule popover turns a month off and dispatches the new schedule', async () => {
    const row = rowOfEnvelope('food');
    row.querySelector('.bp-freq-btn').click();
    const cell = row.querySelector('.bp-sched-popover .bp-mcell[data-mon="Dec"]');
    expect(cell).toBeTruthy();
    cell.click();
    await settle();
    const { Dec, ...rest } = every();
    expect(Dec).toBe(true);
    expect(updates()).toEqual([{ id: 'g', fields: { monthly_schedule: rest } }]);
    expect(stored('g').monthly_schedule).toEqual(rest);
    expect(sheetIsOpen()).toBe(false);
  });

  it('the stress popover sets a category', async () => {
    setItems({ ...cinema, stress_category: 'A' });
    await openPage();
    const row = rowOfEnvelope('fun', 'Cinema');
    row.querySelector('.stress-cat-btn').click();
    [...row.querySelectorAll('.stress-cat-opt')].find(b => b.textContent.startsWith('C ')).click();
    await settle();
    expect(updates()).toEqual([{ id: 'c', fields: { stress_category: 'C' } }]);
    expect(stored('c').stress_category).toBe('C');
  });

  it('clearing the category clears the cuts with it', async () => {
    setItems({ ...cinema, stress_category: 'B', stress_cut_pct: 0.3, stress_cut_pcts: { A: 0.3, B: 0.5 } });
    await openPage();
    const row = rowOfEnvelope('fun', 'Cinema');
    row.querySelector('.stress-cat-btn').click();
    [...row.querySelectorAll('.stress-cat-opt')].find(b => b.textContent === t('bp.stressPopover.clear')).click();
    await settle();
    expect(updates()).toEqual([{ id: 'c', fields: { stress_category: null, stress_cut_pcts: null, stress_cut_pct: 0 } }]);
    expect(stored('c').stress_category).toBeNull();
    expect(stored('c').stress_cut_pct).toBe(0);
    expect(stored('c')).not.toHaveProperty('stress_cut_pcts');
  });

  it('Z (never cut) clears the cuts too', async () => {
    setItems({ ...cinema, stress_category: 'B', stress_cut_pct: 0.3 });
    await openPage();
    const row = rowOfEnvelope('fun', 'Cinema');
    row.querySelector('.stress-cat-btn').click();
    [...row.querySelectorAll('.stress-cat-opt')].find(b => b.textContent.startsWith('Z ')).click();
    await settle();
    expect(updates()).toEqual([{ id: 'c', fields: { stress_category: 'Z', stress_cut_pcts: null, stress_cut_pct: 0 } }]);
  });

  it('a cut slider follows the hand on input and dispatches the cuts on change', async () => {
    setItems({ ...cinema, stress_category: 'B', stress_cut_pct: 0.2 });
    await openPage();
    const row = rowOfEnvelope('fun', 'Cinema');
    row.querySelector('.stress-cat-btn').click();
    const sliders = [...row.querySelectorAll('.stress-slider')];
    expect(sliders).toHaveLength(2); // A and B
    setValue(sliders[1], '40', ['input']);
    expect(sliders[1].parentElement.querySelector('.stress-slider-pct').textContent).toBe('40%');
    await settle();
    expect(updates()).toEqual([]);
    setValue(sliders[1], '40', ['change']);
    await settle();
    // The map is seeded from the flat cut, so moving B leaves A where it was.
    expect(updates()).toEqual([{ id: 'c', fields: { stress_cut_pcts: { A: 0.2, B: 0.4 } } }]);
    expect(stored('c').stress_cut_pcts).toEqual({ A: 0.2, B: 0.4 });
  });

  it('a legacy whole-percent cut is sent as the fraction the engine reads', async () => {
    setItems({ ...cinema, stress_category: 'B', stress_cut_pct: 15 });
    await openPage();
    const row = rowOfEnvelope('fun', 'Cinema');
    row.querySelector('.stress-cat-btn').click();
    setValue(row.querySelectorAll('.stress-slider')[1], '40');
    await settle();
    expect(updates()).toEqual([{ id: 'c', fields: { stress_cut_pcts: { A: 1, B: 0.4 } } }]);
    expect(stored('c').stress_cut_pcts).toEqual({ A: 1, B: 0.4 });
  });
});

// A popover closed by opening another chip leaves the row as it was painted;
// the next popover on that row must still start from the item as it is now,
// or its whole-map edit sends the old values back and reverts a committed one.
describe('a reopened popover starts from the current item', () => {
  it('cut A set to 80%, another chip opened, the cuts reopened and B edited: A stays 80%', async () => {
    setItems({ ...cinema, stress_category: 'B', stress_cut_pct: 0.2 });
    await openPage();
    let row = rowOfEnvelope('fun', 'Cinema');
    row.querySelector('.stress-cat-btn').click();
    setValue(row.querySelectorAll('.stress-slider')[0], '80');
    await settle();
    expect(stored('c').stress_cut_pcts).toEqual({ A: 0.8, B: 0.2 });
    // Another chip closes the cut popover quietly (no repaint).
    row.querySelector('.bp-freq-btn').click();
    row = rowOfEnvelope('fun', 'Cinema');
    row.querySelector('.stress-cat-btn').click();
    const sliders = [...row.querySelectorAll('.stress-slider')];
    expect(sliders[0].value).toBe('80');
    setValue(sliders[1], '10');
    await settle();
    expect(stored('c').stress_cut_pcts).toEqual({ A: 0.8, B: 0.1 });
  });

  it('December turned off, the chip reopened after another row\'s and November turned off: December stays off', async () => {
    let row = rowOfEnvelope('food');
    row.querySelector('.bp-freq-btn').click();
    row.querySelector('.bp-sched-popover .bp-mcell[data-mon="Dec"]').click();
    await settle();
    expect(stored('g').monthly_schedule.Dec).toBeUndefined();
    rowOfEnvelope('rent').querySelector('.bp-freq-btn').click();
    row = rowOfEnvelope('food');
    row.querySelector('.bp-freq-btn').click();
    row.querySelector('.bp-sched-popover .bp-mcell[data-mon="Nov"]').click();
    await settle();
    expect(stored('g').monthly_schedule.Dec).toBeUndefined();
    expect(stored('g').monthly_schedule.Nov).toBeUndefined();
    expect(stored('g').monthly_schedule.Oct).toBe(true);
  });

  it('the category popover marks the current category, not the painted one', async () => {
    setItems({ ...cinema, stress_category: 'B', stress_cut_pct: 0.2 });
    await openPage();
    const row = rowOfEnvelope('fun', 'Cinema');
    // Committed without a repaint of the row.
    expect((await session.dispatch('budgetItem.update', { id: 'c', fields: { stress_category: 'C' } })).ok).toBe(true);
    row.querySelector('.stress-cat-btn').click();
    const active = row.querySelector('.stress-cat-opt--active');
    expect(active.textContent.startsWith('C ')).toBe(true);
    // C hits A, B and C: one slider each, from the current item.
    expect(row.querySelectorAll('.stress-slider')).toHaveLength(3);
  });
});

describe('add', () => {
  it('opens the editor sheet when envelopes exist', () => {
    document.querySelector('#bp-add').click();
    expect(sheetIsOpen()).toBe(true);
  });

  it('with no envelopes, explains why instead of opening the editor', async () => {
    state.envelopes = [];
    await openPage();
    expect(document.querySelector('[data-go-envelopes]')).toBeTruthy();
    document.querySelector('#bp-add').click();
    await flush();
    expect(topOverlay().textContent).toContain(t('budgetPlan.needEnvelopeFirst'));
    expect(writeBatch).not.toHaveBeenCalled();
  });
});

describe('fill %: not on track', () => {
  // Rent is due on the 20th and the envelope holds nothing: short by the bill.
  // Food holds this month's groceries in full: on track.
  const foodFunded = { id: 'ff', type: 'fill', date: '2026-09-01', status: 'posted', lines: [{ envelope_id: 'food', mode: 'add', amount: 100 }] };
  const setup = async (extra = {}) => {
    setItems({ ...rent, payment_day: 20 }, groceries);
    state.transactions = [foodFunded];
    Object.assign(state, extra);
    await openPage();
  };

  it('a short item carries a chip with the amount and date; an on-track one none', async () => {
    await setup();
    const chip = rowOfEnvelope('rent').querySelector('.bp-funding-chip');
    expect(chip.textContent).toContain(t('itemFunding.short')(fmt(700)));
    expect(rowOfEnvelope('food').querySelector('.bp-funding-chip')).toBeNull();
  });

  it('the chip opens the envelope health check, not the item editor', async () => {
    await setup();
    rowOfEnvelope('rent').querySelector('.bp-funding-chip').click();
    await flush();
    expect(topOverlay().textContent).toContain(t('itemFunding.title'));
  });

  it('the Not on track filter keeps only those, and Clear brings the rest back', async () => {
    await setup();
    setValue(document.querySelector('#bp-filter-funding'), 'attention');
    expect(rows().map(r => r.dataset.envelopeId)).toEqual(['rent']);
    document.querySelector('#bp-filter-clear').click();
    expect(rows().map(r => r.dataset.envelopeId).sort()).toEqual(['food', 'rent']);
  });

  it('the Overview link opens the page already filtered', async () => {
    await setup({ pendingFilter: { funding: 'attention' } });
    expect(document.querySelector('#bp-filter-funding').value).toBe('attention');
    expect(rows().map(r => r.dataset.envelopeId)).toEqual(['rent']);
    expect(document.querySelector('#bp-filter-clear').style.display).toBe('');
  });

  it('spent past its plan but covered by the envelope: no chip, not in the filter', async () => {
    // Groceries plan 100 a month; 150 spent this month out of an envelope that
    // was given 1000 leaves 850, so nothing goes unpaid (owner report,
    // 2026-10-05: an overspent but well-funded item read "will not be covered").
    setItems(groceries);
    state.transactions = [
      { id: 'big', type: 'fill', date: '2026-01-01', status: 'posted', lines: [{ envelope_id: 'food', mode: 'add', amount: 1000 }] },
      { id: 'shop', type: 'expense', date: '2026-09-10', status: 'posted', amount: 150, account: 'chk', envelope_id: 'food' },
    ];
    await openPage();
    expect(rowOfEnvelope('food').querySelector('.bp-funding-chip')).toBeNull();
    setValue(document.querySelector('#bp-filter-funding'), 'attention');
    expect(document.querySelector('#bp-list').textContent).toBe(t('budgetPlan.fundingAllOnTrack'));
  });

  it('with nothing short, the filter says everything is on track', async () => {
    setItems(groceries);
    state.transactions = [foodFunded];
    await openPage();
    setValue(document.querySelector('#bp-filter-funding'), 'attention');
    expect(document.querySelector('#bp-list').textContent).toBe(t('budgetPlan.fundingAllOnTrack'));
  });
});

describe('start / end month chips', () => {
  // The fake clock is 15 Sep 2026.
  it('an ended item is dimmed and says when it ended', async () => {
    setItems({ ...groceries, end_month: '2026-08' });
    await openPage();
    const row = rowFor('Weekly shop');
    expect(row.classList.contains('bp-list-row--excluded')).toBe(true);
    expect(row.textContent).toContain(t('budgetPlan.endedChip')(fmtMonthLang('2026-08')));
  });

  it('an item not started yet says from when', async () => {
    setItems({ ...groceries, start_month: '2026-11' });
    await openPage();
    const row = rowFor('Weekly shop');
    expect(row.classList.contains('bp-list-row--excluded')).toBe(false);
    expect(row.textContent).toContain(t('budgetPlan.fromChip')(fmtMonthLang('2026-11')));
  });

  it('a running item with an end says until when', async () => {
    setItems({ ...groceries, end_month: '2026-12' });
    await openPage();
    expect(rowFor('Weekly shop').textContent).toContain(t('budgetPlan.untilChip')(fmtMonthLang('2026-12')));
  });

  it('an undated item has no date chip', async () => {
    setItems(groceries);
    await openPage();
    expect(rowFor('Weekly shop').querySelector('.bp-date-chip')).toBe(null);
  });
});
