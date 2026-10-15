// @vitest-environment jsdom
// The Plan and Stress pages share one live-edit queue for plan items
// (js/ui/plan-item-live.js): an edit made on one page and still inside its
// quiet window is part of what the other page shows and sends, and the item
// editor, opened from either page, waits for it. Drives both real pages over
// the real browser session (tests/_fakes/pageApp.js).
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../js/app.js', async () => (await import('./_fakes/pageApp.js')).appStub);

import { render as renderPlan } from '../js/pages/budget-plan.js';
import { render as renderStress } from '../js/pages/stress.js';
import { beginBudgetSession } from '../js/state/budget-session.js';
import {
  state, session, writeBatch, runDueScheduled, resetState, mountHosts, flush, setValue, sheetIsOpen,
} from './_fakes/pageApp.js';

const dispatchSpy = vi.spyOn(session, 'dispatch');
const updates = () => dispatchSpy.mock.calls.filter(([name]) => name === 'budgetItem.update').map(([, input]) => input);
const stored = (id) => state.budgetItems.find(i => i.id === id);
const settle = async () => { await new Promise(r => setTimeout(r, 450)); await flush(); };

const deepFreeze = (o) => {
  for (const v of Object.values(o)) if (v && typeof v === 'object') deepFreeze(v);
  return Object.freeze(o);
};
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const every = () => Object.fromEntries(MONTHS.map(m => [m, true]));

const root = () => document.getElementById('app-root');
async function openStress() { mountHosts(); await renderStress(root()); }
async function openPlan() { mountHosts(); await renderPlan(root()); }
const planRow = () => [...document.querySelectorAll('.bp-list-row')].find(r => r.dataset.envelopeId === 'food');

/** On Stress: open scenario A and move the groceries cut to `v`% (released). */
async function stressCutA(v) {
  await openStress();
  document.querySelector('.stress-row[data-scenario="A"]').click();
  await flush();
  const slider = document.querySelector('.stress-detail-trow[data-item-id="g"] .stress-slider');
  setValue(slider, String(v), ['input', 'change']);
}

beforeEach(() => {
  document.body.click();
  vi.stubGlobal('requestAnimationFrame', (cb) => setTimeout(cb, 0));
  sessionStorage.clear();
  resetState();
  state.budgetItems = [deepFreeze({
    id: 'g', kind: 'expense', envelope_id: 'food', description: 'Weekly shop', default_amount: -100, extra_buffer: 0,
    include: true, monthly_schedule: every(), as_schedule: false,
    stress_category: 'B', stress_cut_pct: 0, stress_cut_pcts: { A: 0.5, B: 0.2 },
  })];
  writeBatch.mockReset();
  writeBatch.mockImplementation(async () => {});
  dispatchSpy.mockClear();
  runDueScheduled.mockClear();
});

describe('one live-edit queue for Plan and Stress', () => {
  it('a Stress cut, then a Plan toggle of the same item inside the window: both land, in one update', async () => {
    await stressCutA(80);
    await openPlan();
    planRow().querySelector('.bp-toggle-chip--emerg-off').click();
    await settle();
    expect(updates()).toEqual([{ id: 'g', fields: { stress_cut_pcts: { A: 0.8, B: 0.2 }, include_in_emergency_budget: true } }]);
    expect(stored('g').stress_cut_pcts).toEqual({ A: 0.8, B: 0.2 });
    expect(stored('g').include_in_emergency_budget).toBe(true);
  });

  it('a Stress cut, then the Plan cut popover inside the window: it shows the Stress cut and keeps it', async () => {
    await stressCutA(80);
    await openPlan();
    const row = planRow();
    row.querySelector('.stress-cat-btn').click();
    const sliders = [...row.querySelectorAll('.stress-slider')];
    expect(sliders[0].value).toBe('80');
    setValue(sliders[1], '10');
    await settle();
    expect(stored('g').stress_cut_pcts).toEqual({ A: 0.8, B: 0.1 });
  });

  it('the editor opened from Plan waits for a pending Stress edit', async () => {
    await stressCutA(80);
    await openPlan();
    planRow().click();
    for (let i = 0; i < 5 && !sheetIsOpen(); i++) await flush();
    expect(sheetIsOpen()).toBe(true);
    // Sent at once, not after the quiet window, and committed before the editor read it.
    expect(updates()).toEqual([{ id: 'g', fields: { stress_cut_pcts: { A: 0.8, B: 0.2 } } }]);
    expect(stored('g').stress_cut_pcts).toEqual({ A: 0.8, B: 0.2 });
  });
});

// Ids such as `g` repeat across budgets. Work queued for budget A is dropped
// when another budget is loaded (or the guest budget reset, which keeps its
// folder object): it is never shown over B's item, and never sent to B.
describe('a budget switch drops the pending edits', () => {
  const otherBudget = (over = {}) => deepFreeze({
    id: 'g', kind: 'expense', envelope_id: 'food', description: 'Budget B shop', default_amount: -300, extra_buffer: 0,
    include: true, monthly_schedule: every(), as_schedule: true,
    stress_category: 'B', stress_cut_pct: 0, stress_cut_pcts: { A: 0.1, B: 0.1 }, ...over,
  });
  function switchTo(items, folder = { name: 'budget-b' }) {
    beginBudgetSession();
    state.budgetFolder = folder;
    state.budgetItems = items;
  }

  it('B, with an item of the same id, shows its own value, and nothing reaches it', async () => {
    await openPlan();
    planRow().querySelector('.bp-toggle-chip--on').click(); // pause g in A
    switchTo([otherBudget()]);
    await openPlan();
    expect(planRow().classList.contains('bp-list-row--excluded')).toBe(false);
    await settle();
    expect(updates()).toEqual([]);
    expect(stored('g').include).toBe(true);
  });

  it('a guest reset, which keeps the folder object, drops them too', async () => {
    await openPlan();
    planRow().querySelector('.bp-toggle-chip--on').click();
    switchTo([otherBudget()], state.budgetFolder);
    await openPlan();
    expect(planRow().classList.contains('bp-list-row--excluded')).toBe(false);
    await settle();
    expect(updates()).toEqual([]);
  });

  it('a re-enable queued in A does not post B\'s due occurrences', async () => {
    state.budgetItems = [deepFreeze({ ...state.budgetItems[0], include: false, as_schedule: true })];
    await openPlan();
    planRow().querySelector('.bp-toggle-chip--off').click(); // re-enable g in A
    switchTo([otherBudget()]);
    await openPlan();
    planRow().querySelector('.bp-toggle-chip--emerg-off').click(); // B's own edit of g
    await settle();
    expect(updates()).toEqual([{ id: 'g', fields: { include_in_emergency_budget: true } }]);
    expect(runDueScheduled).not.toHaveBeenCalled();
  });

  it('a Stress drag in A is not shown over B\'s cuts', async () => {
    await openStress();
    document.querySelector('.stress-row[data-scenario="A"]').click();
    await flush();
    setValue(document.querySelector('.stress-detail-trow[data-item-id="g"] .stress-slider'), '90', ['input']);
    switchTo([otherBudget()]);
    await openStress();
    document.querySelector('.stress-row[data-scenario="A"]').click();
    await flush();
    expect(document.querySelector('.stress-detail-trow[data-item-id="g"] .stress-slider').value).toBe('10');
  });
});
