// @vitest-environment jsdom
// Stress page: the live controls (cut slider, per-row reset, category popover)
// queue budgetItem.update through the debounced dispatch
// (js/ui/debounced-dispatch.js) into the real browser session
// (tests/_fakes/pageApp.js), and "Expand flat cuts" sends one batch. The fixture
// items are deep frozen: the page must never edit a stored item in place.
import { describe, it, expect, beforeEach, vi } from 'vitest';

// The page reads the lens through stress.runway (the session's lensRows), so
// a Forecast-view figure is what the app would show.
vi.mock('../js/app.js', async () => (await import('./_fakes/pageApp.js')).appStub);

import { render } from '../js/pages/stress.js';
import { t } from '../js/ui/i18n.js';
import { fmt, fmtNum } from '../js/utils.js';
import { moneyEl } from '../js/ui/money.js';
import { adjustedAnnual } from '../js/engine/stress.js';
import { lensTransactions } from '../js/engine/lens.js';
import { computeAccountBalances } from '../js/engine/balances.js';
import { setItemFields, dropItem } from '../js/ui/plan-item-live.js';
import {
  state, prefs, session, writeBatch, navigate, resetState, mountHosts, flush, setValue,
  topOverlay, dialogOk, toastTexts, FIXED_NOW,
} from './_fakes/pageApp.js';

const dispatchSpy = vi.spyOn(session, 'dispatch');
const batchSpy = vi.spyOn(session, 'dispatchBatch');
const querySpy = vi.spyOn(session, 'query');
const updates = () => dispatchSpy.mock.calls.filter(([name]) => name === 'budgetItem.update').map(([, input]) => input);
const stored = (id) => state.budgetItems.find(i => i.id === id);
const settle = async () => { await new Promise(r => setTimeout(r, 450)); await flush(); };

const deepFreeze = (o) => {
  for (const v of Object.values(o)) if (v && typeof v === 'object') deepFreeze(v);
  return Object.freeze(o);
};
const setItems = (...items) => { state.budgetItems = items.map(deepFreeze); };

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const every = () => Object.fromEntries(MONTHS.map(m => [m, true]));

let groceries, cinema;

async function openPage() {
  mountHosts();
  await render(document.getElementById('app-root'));
}
const scenarioRow = (s) => document.querySelector(`.stress-row[data-scenario="${s}"]`);
const detailRow = (id) => document.querySelector(`.stress-detail-trow[data-item-id="${id}"]`);
async function expand(s) { scenarioRow(s).click(); await flush(); }
const dragTo = (slider, v) => setValue(slider, String(v), ['input']);
const release = (slider) => slider.dispatchEvent(new Event('change', { bubbles: true }));
const optionFor = (row, startsWith) => [...row.querySelectorAll('.stress-cat-opt')].find(b => b.textContent.startsWith(startsWith));
// A drag left mid-way stays in the page's drafts across tests: end it, and
// forget the cuts it queued, so the next test starts from the stored items.
const endDrag = (slider) => { release(slider); dropItem(slider.closest('[data-item-id]').dataset.itemId); };

beforeEach(async () => {
  document.body.click();
  sessionStorage.clear();
  resetState();
  groceries = { id: 'g', kind: 'expense', envelope_id: 'food', description: 'Weekly shop', default_amount: -100, extra_buffer: 0, include: true, monthly_schedule: every(), as_schedule: false, stress_category: 'B', stress_cut_pct: 0, stress_cut_pcts: { A: 0.5, B: 0.2 } };
  cinema = { id: 'c', kind: 'expense', envelope_id: 'fun', description: 'Cinema', default_amount: -20, extra_buffer: 0, include: true, monthly_schedule: every(), as_schedule: false, stress_category: 'B', stress_cut_pct: 0.3, stress_cut_pcts: { A: 0.3, B: 0.3 } };
  setItems(groceries, cinema);
  writeBatch.mockReset();
  writeBatch.mockImplementation(async () => {});
  dispatchSpy.mockClear();
  batchSpy.mockClear();
  querySpy.mockClear();
  await openPage();
  await expand('A');
});

describe('cut slider', () => {
  it('follows the drag at once, sends nothing until it is released, then dispatches the cuts after the quiet window', async () => {
    const before = state.budgetItems;
    const slider = detailRow('g').querySelector('.stress-slider');
    dragTo(slider, 80);
    // The scenario totals follow the hand while nothing is stored yet.
    expect(detailRow('g').querySelector('.stress-slider-pct').textContent).toBe('80%');
    expect(detailRow('g').querySelector('[data-role="adj"]').textContent).toBe(fmt(adjustedAnnual({ ...groceries, stress_cut_pcts: { A: 0.8, B: 0.2 } }, 'A')));
    expect(updates()).toEqual([]);
    release(slider);
    expect(updates()).toEqual([]);
    await settle();
    expect(updates()).toEqual([{ id: 'g', fields: { stress_cut_pcts: { A: 0.8, B: 0.2 } } }]);
    expect(state.budgetItems).not.toBe(before);
    expect(stored('g').stress_cut_pcts).toEqual({ A: 0.8, B: 0.2 });
    expect(groceries.stress_cut_pcts).toEqual({ A: 0.5, B: 0.2 });
  });

  it('coalesces a second release inside the window into one update', async () => {
    const slider = detailRow('g').querySelector('.stress-slider');
    dragTo(slider, 60); release(slider);
    dragTo(slider, 90); release(slider);
    await settle();
    expect(updates()).toEqual([{ id: 'g', fields: { stress_cut_pcts: { A: 0.9, B: 0.2 } } }]);
  });

  it('seeds the whole map from a legacy scalar and clamps a legacy whole percent', async () => {
    setItems({ ...cinema, stress_cut_pct: 15, stress_cut_pcts: undefined });
    await openPage();
    await expand('A');
    const slider = detailRow('c').querySelector('.stress-slider');
    dragTo(slider, 40); release(slider);
    await settle();
    expect(updates()).toEqual([{ id: 'c', fields: { stress_cut_pcts: { A: 0.4, B: 1 } } }]);
  });

  it('the reset button restores the cut the page opened with and queues it', async () => {
    const slider = detailRow('g').querySelector('.stress-slider');
    dragTo(slider, 80); release(slider);
    await settle();
    dispatchSpy.mockClear();
    const reset = detailRow('g').querySelector('.stress-slider-reset');
    expect(reset.disabled).toBe(false);
    reset.click();
    expect(slider.value).toBe('50');
    await settle();
    expect(updates()).toEqual([{ id: 'g', fields: { stress_cut_pcts: { A: 0.5, B: 0.2 } } }]);
    expect(stored('g').stress_cut_pcts).toEqual({ A: 0.5, B: 0.2 });
  });

  it('a failed update repaints from state and toasts', async () => {
    writeBatch.mockImplementationOnce(async () => { throw new Error('disk full'); });
    const before = state.budgetItems;
    dragTo(detailRow('g').querySelector('.stress-slider'), 80);
    release(detailRow('g').querySelector('.stress-slider'));
    await settle();
    expect(state.budgetItems).toBe(before);
    expect(detailRow('g').querySelector('.stress-slider').value).toBe('50');
    expect(toastTexts().some(m => m.includes('disk full'))).toBe(true);
  });
});

describe('category popover', () => {
  it('sets a category and queues only that field', async () => {
    detailRow('g').querySelector('.stress-cat-btn').click();
    optionFor(detailRow('g'), 'C ').click();
    await settle();
    expect(updates()).toEqual([{ id: 'g', fields: { stress_category: 'C' } }]);
    expect(stored('g').stress_category).toBe('C');
  });

  it('clearing the category also clears the cuts (parity with the Plan page)', async () => {
    detailRow('g').querySelector('.stress-cat-btn').click();
    [...detailRow('g').querySelectorAll('.stress-cat-opt')].find(b => b.textContent === t('stress.clearCat')).click();
    // The item leaves the A hit list at once, from the pending overlay.
    expect(detailRow('g')).toBeNull();
    await settle();
    expect(updates()).toEqual([{ id: 'g', fields: { stress_category: null, stress_cut_pcts: null, stress_cut_pct: 0 } }]);
    expect(stored('g').stress_category).toBeNull();
    expect(stored('g').stress_cut_pct).toBe(0);
    expect(stored('g')).not.toHaveProperty('stress_cut_pcts');
  });

  it('setting Z clears the cuts too', async () => {
    detailRow('c').querySelector('.stress-cat-btn').click();
    optionFor(detailRow('c'), 'Z ').click();
    await settle();
    expect(updates()).toEqual([{ id: 'c', fields: { stress_category: 'Z', stress_cut_pcts: null, stress_cut_pct: 0 } }]);
  });
});

// As on the Plan page: a control opened after an edit starts from the item as
// it is now, never from the row as it was painted.
describe('controls start from the current item', () => {
  it('a second cut edit after the first committed keeps the first', async () => {
    const slider = detailRow('g').querySelector('.stress-slider');
    dragTo(slider, 80); release(slider);
    await settle();
    expect(stored('g').stress_cut_pcts).toEqual({ A: 0.8, B: 0.2 });
    await expand('A'); // collapse
    await expand('B');
    const b = detailRow('g').querySelector('.stress-slider');
    dragTo(b, 10); release(b);
    await settle();
    expect(stored('g').stress_cut_pcts).toEqual({ A: 0.8, B: 0.1 });
  });

  it('the category popover marks the current category, not the painted one', async () => {
    expect((await session.dispatch('budgetItem.update', { id: 'g', fields: { stress_category: 'C' } })).ok).toBe(true);
    detailRow('g').querySelector('.stress-cat-btn').click();
    expect(detailRow('g').querySelector('.stress-cat-opt--active').textContent.startsWith('C ')).toBe(true);
  });
});

describe('expand flat cuts', () => {
  const legacy = () => ({ ...cinema, id: 'l1', stress_cut_pct: 0.4, stress_cut_pcts: undefined });
  const legacy2 = () => ({ ...groceries, id: 'l2', stress_cut_pct: 0.25, stress_cut_pcts: undefined, stress_category: 'C' });

  async function openWithLegacy() {
    setItems(groceries, legacy(), legacy2());
    await openPage();
  }
  const expandButton = () => [...document.querySelectorAll('#stress-flat button')].find(b => b.textContent === t('stress.expandFlatCutsBtn'));

  it('does not expand after a failed pending edit flush', async () => {
    await openWithLegacy();
    writeBatch.mockRejectedValueOnce(new Error('offline'));
    setItemFields('g', { include: false });
    expandButton().click();
    await flush();
    expect(batchSpy).not.toHaveBeenCalled();
    expect(topOverlay()).toBeUndefined();
    expect(toastTexts().some(text => text.includes('offline'))).toBe(true);
  });

  it('excludes loans and exempt items from the category and flat-ladder review queues', async () => {
    setItems({ ...cinema, id: 'loan', description: 'Loan without category', kind: 'loan_payment', stress_category: null },
      { ...cinema, id: 'flatloan', description: 'Flat loan', kind: 'loan_payment' },
      { ...cinema, id: 'exempt', description: 'Exempt', stress_category: 'Z' });
    await openPage();
    expect(document.querySelectorAll('.stress-missing-row')).toHaveLength(0);
    expect(document.querySelector('#stress-flat-card')).toBeNull();
  });

  it('is one batch of budgetItem.update steps, one per affected item, sent at once', async () => {
    await openWithLegacy();
    expandButton().click();
    await flush();
    dialogOk().click();
    await flush();
    expect(batchSpy).toHaveBeenCalledTimes(1);
    expect(batchSpy.mock.calls[0][0]).toEqual([
      // The map only: the stored scalar is left as it is.
      { name: 'budgetItem.update', input: { id: 'l1', fields: { stress_cut_pcts: { A: 0.4, B: 0.4 } } } },
      { name: 'budgetItem.update', input: { id: 'l2', fields: { stress_cut_pcts: { A: 0.25, B: 0.25, C: 0.25 } } } },
    ]);
    expect(stored('l1').stress_cut_pcts).toEqual({ A: 0.4, B: 0.4 });
    expect(stored('l2').stress_cut_pcts).toEqual({ A: 0.25, B: 0.25, C: 0.25 });
    expect(stored('l1').stress_cut_pct).toBe(0.4);
    expect(stored('g')).toBe(state.budgetItems[0]);
    expect(writeBatch).toHaveBeenCalledTimes(1);
    expect(toastTexts()).toContain(t('stress.expandFlatCutsDone').replace('{count}', '2'));
    expect(navigate).toHaveBeenCalledWith('stress');
  });

  it('a loan payment with a legacy category shows no cut controls and is left out of the batch', async () => {
    // A loan payment takes no stress fields (the editor nulls them on save), so
    // a legacy one is shown as it is, without a control that would zero it.
    const loan = { ...cinema, id: 'loan', kind: 'loan_payment', envelope_id: 'rent', to_account_id: 'sav', description: 'Mortgage', stress_cut_pct: 0.4, stress_cut_pcts: undefined };
    setItems(groceries, legacy(), loan);
    const loanRow = stored('loan');
    await openPage();
    await expand('A');
    expect(detailRow('loan')).not.toBeNull();
    expect(detailRow('loan').querySelector('.stress-slider')).toBeNull();
    expect(detailRow('loan').querySelector('.stress-slider-reset')).toBeNull();
    expect(detailRow('loan').querySelector('button.stress-cat-btn')).toBeNull();
    expect(detailRow('l1').querySelector('.stress-slider')).not.toBeNull();
    expandButton().click();
    await flush();
    expect(topOverlay().textContent).toContain(t('stress.expandFlatCutsConfirm').replace('{count}', '1'));
    dialogOk().click();
    await flush();
    expect(batchSpy.mock.calls[0][0].map(step => step.input.id)).toEqual(['l1']);
    // The loan's row is the very object it was: not touched.
    expect(stored('loan')).toBe(loanRow);
    expect(stored('loan').stress_cut_pct).toBe(0.4);
  });

  it('a loan payment alone does not offer the expansion', async () => {
    setItems(groceries, { ...cinema, id: 'loan', kind: 'loan_payment', envelope_id: 'rent', to_account_id: 'sav', stress_cut_pct: 0.4, stress_cut_pcts: undefined });
    await openPage();
    expect(expandButton()).toBeUndefined();
  });

  it('cancelling the confirm sends nothing', async () => {
    await openWithLegacy();
    expandButton().click();
    await flush();
    [...topOverlay().querySelectorAll('button')].find(b => !b.classList.contains('btn-accent')).click();
    await flush();
    expect(batchSpy).not.toHaveBeenCalled();
  });

  it('a refused batch toasts, changes nothing and does not claim success', async () => {
    await openWithLegacy();
    const before = state.budgetItems;
    writeBatch.mockImplementationOnce(async () => { throw new Error('disk full'); });
    expandButton().click();
    await flush();
    dialogOk().click();
    await flush();
    expect(state.budgetItems).toBe(before);
    expect(toastTexts().some(m => m.includes('disk full'))).toBe(true);
    expect(toastTexts()).not.toContain(t('stress.expandFlatCutsDone').replace('{count}', '2'));
    expect(navigate).not.toHaveBeenCalled();
  });
});

describe('dated plan items', () => {
  it('an ended item is not asked for a stress category', async () => {
    setItems({ ...groceries, stress_category: null, stress_cut_pcts: undefined, end_month: '2026-08' }, cinema);
    await openPage();
    expect(document.querySelector('.stress-unconfigured:not(#stress-flat-card)').textContent).toContain(t('stress.noStressEmpty'));
  });

  it('an ended item leaves the same-cut-in-every-scenario list', async () => {
    const flat = { ...groceries, stress_cut_pcts: { A: 0.2, B: 0.2 } };
    setItems(flat, cinema);
    await openPage();
    const withIt = document.querySelectorAll('#stress-flat-card .stress-missing-row').length;
    setItems({ ...flat, end_month: '2026-08' }, cinema);
    await openPage();
    expect(document.querySelectorAll('#stress-flat-card .stress-missing-row').length).toBe(withIt - 1);
  });

  it('an item that has ended leaves the scenario totals', async () => {
    setItems(cinema);
    await openPage();
    const cinemaOnly = scenarioRow('Baseline').textContent;
    setItems({ ...groceries, end_month: '2026-08' }, cinema);
    await openPage();
    expect(scenarioRow('Baseline').textContent).toBe(cinemaOnly);
  });
});

// The figures: chk (bank, 1000) and sav (savings, 500) are both crisis cash,
// so the cash is 1500 with no transactions. groceries is 1200 a year (cut
// A 50 %, B 20 %), cinema 240 (cut 30 % in A and B):
//   Baseline 1440 (120 a month), A 600 + 168 = 768 (64), B 960 + 168 = 1128 (94),
//   C..E 1440.
describe('scenario figures', () => {
  const cells = (s) => scenarioRow(s).querySelectorAll('.stress-cell');
  const money = (v, opts = {}) => moneyEl(v, { size: 'md', ...opts }).textContent;
  const monthsLabel = (mo) => `${fmtNum(mo, { decimals: 1 })} ${t('stress.months')}`;
  const runway = (s) => {
    const cell = cells(s)[5];
    const bar = cell.querySelector('.stress-runway-bar');
    return {
      label: cell.querySelector('.stress-runway-label').textContent,
      cls: [...bar.classList].find(c => c.startsWith('stress-runway--')),
      width: cell.querySelector('.stress-runway-fill').style.width,
    };
  };
  const reserved = () => document.getElementById('stress-reserved');

  it('shows income, expense and net per scenario, and the runway of the whole cash without a buffer', async () => {
    await openPage();
    expect(cells('Baseline')[1].textContent).toBe(money(0));
    expect(cells('Baseline')[2].textContent).toBe(money(1440));
    expect(cells('A')[2].textContent).toBe(money(768));
    expect(cells('B')[2].textContent).toBe(money(1128));
    expect(cells('C')[2].textContent).toBe(money(1440));
    expect(cells('A')[3].textContent).toBe(money(-768, { signed: true }));
    expect(document.getElementById('stress-cash').textContent).toBe(fmt(1500));
    expect(reserved().hidden).toBe(true);
    expect(runway('Baseline')).toEqual({ label: monthsLabel(12.5), cls: 'stress-runway--ok', width: '100%' });
    expect(runway('A')).toEqual({ label: monthsLabel(1500 / 64), cls: 'stress-runway--ok', width: '100%' });
    expect(runway('B')).toEqual({ label: monthsLabel(1500 / 94), cls: 'stress-runway--ok', width: '100%' });
  });

  it('a buffer floor is reserved out of the cash and shortens every runway (bad below 3 months, mid below 6)', async () => {
    setItems({ ...groceries, extra_buffer: 1200 }, cinema);
    await openPage();
    expect(document.getElementById('stress-cash').textContent).toBe(fmt(300));
    expect(reserved().hidden).toBe(false);
    expect(reserved().querySelector('strong').textContent).toBe(fmt(1200));
    expect(runway('Baseline')).toEqual({ label: monthsLabel(2.5), cls: 'stress-runway--bad', width: `${(2.5 / 12) * 100}%` });
    expect(runway('A')).toEqual({ label: monthsLabel(300 / 64), cls: 'stress-runway--mid', width: `${(300 / 64 / 12) * 100}%` });
    expect(runway('B')).toEqual({ label: monthsLabel(300 / 94), cls: 'stress-runway--mid', width: `${(300 / 94 / 12) * 100}%` });
    expect(runway('E')).toEqual({ label: monthsLabel(2.5), cls: 'stress-runway--bad', width: `${(2.5 / 12) * 100}%` });
  });

  it('a buffer floor larger than the cash leaves none: 0 months, bad, the narrowest bar', async () => {
    setItems({ ...groceries, extra_buffer: 2000 }, cinema);
    await openPage();
    expect(document.getElementById('stress-cash').textContent).toBe(fmt(0));
    expect(reserved().querySelector('strong').textContent).toBe(fmt(2000));
    expect(runway('Baseline')).toEqual({ label: monthsLabel(0), cls: 'stress-runway--bad', width: '2%' });
  });

  it('a plan that burns nothing has an unlimited runway', async () => {
    const salary = { id: 's', kind: 'income', envelope_id: null, description: 'Salary', default_amount: 1000, extra_buffer: 0, include: true, monthly_schedule: every(), as_schedule: false, stress_category: null, stress_cut_pct: 0 };
    setItems(groceries, cinema, salary);
    await openPage();
    expect(cells('Baseline')[1].textContent).toBe(money(12000));
    expect(runway('Baseline')).toEqual({ label: t('workspace.noBurn'), cls: 'stress-runway--ok', width: '100%' });
    expect(runway('A')).toEqual({ label: t('workspace.noBurn'), cls: 'stress-runway--ok', width: '100%' });
  });

  it('colours the net and the difference from Baseline by their sign', async () => {
    await openPage();
    // No income: every net is negative.
    for (const s of ['Baseline', 'A', 'C']) expect(cells(s)[3].classList.contains('stress-negative')).toBe(true);
    expect(cells('Baseline')[4].textContent).toBe('—');
    expect([...cells('Baseline')[4].classList]).toEqual(['stress-cell', 'stress-cell--num', 'muted']);
    // Cuts lower the expense: A is better than Baseline by 672.
    expect(cells('A')[4].textContent).toBe(money(672, { signed: true }));
    expect([...cells('A')[4].classList]).toEqual(['stress-cell', 'stress-cell--num', 'stress-positive']);
    expect([...cells('C')[4].classList]).toEqual(['stress-cell', 'stress-cell--num']);

    // A cut salary makes C worse than Baseline, and the nets positive.
    const salary = { id: 's', kind: 'income', envelope_id: null, description: 'Salary', default_amount: 1000, extra_buffer: 0, include: true, monthly_schedule: every(), as_schedule: false, stress_category: 'C', stress_cut_pct: 0, stress_cut_pcts: { A: 0.5, B: 0.5, C: 0.5 } };
    setItems(groceries, cinema, salary);
    await openPage();
    expect(cells('C')[4].textContent).toBe(money(-6000, { signed: true }));
    expect([...cells('C')[4].classList]).toEqual(['stress-cell', 'stress-cell--num', 'stress-negative']);
    expect(cells('C')[3].classList.contains('stress-negative')).toBe(false);
    expect([...cells('D')[4].classList]).toEqual(['stress-cell', 'stress-cell--num']);
  });

  it('the cash follows the forecast lens', async () => {
    // A bill entered for November: Booked counts it, Forecast through the end
    // of this month does not (and adds the plan's rows up to then).
    state.transactions = [{ id: 'nov', type: 'expense', date: '2026-11-05', payee: 'Insurer', amount: 400, account: 'chk', envelope_id: 'rent', status: 'scheduled' }];
    await openPage();
    expect(document.getElementById('stress-cash').textContent).toBe(fmt(1100));
    Object.assign(prefs, { lens: 'forecast', lensHorizon: 'eom' });
    await openPage();
    const rows = lensTransactions(state, { lens: 'forecast', horizon: 'eom', today: new Date(FIXED_NOW) });
    const bal = computeAccountBalances(state.accounts, rows);
    const forecast = bal.get('chk') + bal.get('sav');
    expect(forecast).not.toBe(1100);
    expect(document.getElementById('stress-cash').textContent).toBe(fmt(forecast));
    expect(runway('Baseline').label).toBe(monthsLabel(forecast / 120));
  });

  it('a drag updates the totals, the difference and the runway at once', async () => {
    // beforeEach opened scenario A.
    const slider = detailRow('g').querySelector('.stress-slider');
    dragTo(slider, 80);
    // A: 1200 * 0.2 + 168 = 408 (34 a month).
    expect(cells('A')[2].textContent).toBe(money(408));
    expect(cells('A')[3].textContent).toBe(money(-408, { signed: true }));
    expect(cells('A')[4].textContent).toBe(money(1032, { signed: true }));
    expect(runway('A').label).toBe(monthsLabel(1500 / 34));
    expect(cells('Baseline')[2].textContent).toBe(money(1440));
    expect(detailRow('g').querySelector('[data-role="base"]').textContent).toBe(fmt(1200));
    expect(detailRow('g').querySelector('[data-role="adj"]').textContent).toBe(fmt(240));
    const impact = detailRow('g').querySelector('[data-role="impact"]');
    expect(impact.textContent).toBe(fmt(-960));
    expect(impact.classList.contains('stress-negative')).toBe(true);
    expect(updates()).toEqual([]);
    endDrag(slider);
  });

  it('a tick repaints the classes too: the net and difference signs, Baseline\'s dash, the runway band', async () => {
    // A buffer leaves 300 usable: A's runway is 300 / 64 = 4.7 months (mid).
    setItems({ ...groceries, extra_buffer: 1200 }, cinema);
    await openPage();
    await expand('A');
    expect(runway('A').cls).toBe('stress-runway--mid');
    const slider = detailRow('g').querySelector('.stress-slider');
    // A 100 % cut: A spends 168 a year (14 a month), 21.4 months.
    dragTo(slider, 100);
    expect(runway('A')).toEqual({ label: monthsLabel(300 / 14), cls: 'stress-runway--ok', width: '100%' });
    expect(cells('A')[3].classList.contains('stress-negative')).toBe(true);
    expect([...cells('A')[4].classList]).toEqual(['stress-cell', 'stress-cell--num', 'stress-positive']);
    expect(cells('Baseline')[4].textContent).toBe('—');
    expect([...cells('Baseline')[4].classList]).toEqual(['stress-cell', 'stress-cell--num', 'muted']);
    expect([...cells('C')[4].classList]).toEqual(['stress-cell', 'stress-cell--num']);
    // No cut on groceries in A: 1200 + 168 = 1368 (114 a month), 2.6 months;
    // still 72 better than Baseline through cinema's cut.
    dragTo(slider, 0);
    expect(runway('A').cls).toBe('stress-runway--bad');
    expect([...cells('A')[4].classList]).toEqual(['stress-cell', 'stress-cell--num', 'stress-positive']);
    endDrag(slider);
  });

  it('an edit still queued from the Plan page is in the figures', async () => {
    setItemFields('c', { include: false });
    setItemFields('g', { monthly_schedule: { ...every(), Jan: false } });
    try {
      await openPage();
      expect(cells('Baseline')[2].textContent).toBe(money(1100));
    } finally {
      dropItem('c');
      dropItem('g');
    }
  });

  it('lists the items without a category with their year', async () => {
    const rent = { id: 'r', kind: 'expense', envelope_id: 'rent', description: 'Flat', default_amount: -500, extra_buffer: 0, include: true, monthly_schedule: every(), as_schedule: false, stress_category: null, stress_cut_pct: 0 };
    const off = { ...rent, id: 'off', include: false };
    setItems(groceries, rent, off, cinema);
    await openPage();
    const rows = [...document.querySelectorAll('#stress-nostress .stress-missing-row')];
    expect(rows).toHaveLength(1);
    expect(rows[0].querySelector('.muted').textContent).toBe(`${fmt(6000)} ${t('stress.perYear')}`);
  });

  it('keeps cancellations and minimum-cost cuts in a collapsed optional reference', async () => {
    setItems({ ...cinema, stress_category: 'C', stress_cut_pcts: { A: 1, B: 1, C: 1 } },
      { ...groceries, stress_cut_pcts: { A: 0.2, B: 0.2 } });
    await openPage();
    const section = document.querySelector('#stress-flat-card');
    expect(section.tagName).toBe('DETAILS');
    expect(section.open).toBe(false);
    expect(section.classList.contains('stress-unconfigured')).toBe(false);
    expect(section.querySelectorAll('.stress-missing-row')).toHaveLength(2);
    section.open = true;
    scenarioRow('A').click();
    expect(document.querySelector('#stress-flat-card').open).toBe(true);
  });

  it('the flat-ladder card lists the largest year first, with its cut and year', async () => {
    setItems(cinema, { ...groceries, stress_cut_pcts: { A: 0.2, B: 0.2 } });
    await openPage();
    const rows = [...document.querySelectorAll('#stress-flat-card .stress-missing-row')];
    expect(rows.map(r => r.querySelector('.muted').textContent)).toEqual([
      t('stress.flatLadderRow')(20, 'A–B') + ' · ' + fmt(1200) + ' ' + t('stress.perYear'),
      t('stress.flatLadderRow')(30, 'A–B') + ' · ' + fmt(240) + ' ' + t('stress.perYear'),
    ]);
  });

  it('the equal-cuts reference leaves out a €0/yr item and explains valid equal cuts', async () => {
    setItems(cinema, { ...groceries, id: 'nil', default_amount: 0, stress_cut_pcts: { A: 0.2, B: 0.2 } });
    await openPage();
    const rows = [...document.querySelectorAll('#stress-flat-card .stress-missing-row')];
    expect(rows).toHaveLength(1);
    expect(document.querySelector('#stress-flat-card .stress-flat-note').textContent).toBe(t('stress.flatLadderNote'));
  });
});

// The figures come from one `stress.runway` query per paint and per tick.
describe('the stress.runway query', () => {
  const runwayCalls = () => querySpy.mock.calls.filter(([name]) => name === 'stress.runway').map(([, input]) => input);
  const cells = (s) => scenarioRow(s).querySelectorAll('.stress-cell');
  const money = (v, opts = {}) => moneyEl(v, { size: 'md', ...opts }).textContent;

  it('is asked once per tick, with the lens, the date and the unsaved edits', async () => {
    querySpy.mockClear();
    const slider = detailRow('g').querySelector('.stress-slider');
    dragTo(slider, 80);
    expect(runwayCalls()).toEqual([{
      lens: 'booked', date: '2026-09-15', detail: true,
      itemOverrides: [{ id: 'g', fields: { stress_cut_pcts: { A: 0.8, B: 0.2 } } }],
    }]);
    endDrag(slider);
  });

  it('is asked once per paint, in the forecast lens with its horizon', async () => {
    Object.assign(prefs, { lens: 'forecast', lensHorizon: 'eom' });
    querySpy.mockClear();
    await openPage();
    expect(runwayCalls()).toEqual([{ lens: 'forecast', horizon: 'eom', date: '2026-09-15', detail: true, itemOverrides: [] }]);
  });

  it('a queued edit goes first, the drag over it', async () => {
    setItemFields('g', { stress_category: 'B', monthly_schedule: { ...every(), Jan: false } });
    try {
      querySpy.mockClear();
      const slider = detailRow('g').querySelector('.stress-slider');
      dragTo(slider, 80);
      release(slider);
      expect(runwayCalls()[0].itemOverrides).toEqual([
        { id: 'g', fields: { stress_category: 'B', monthly_schedule: { ...every(), Jan: false } } },
        { id: 'g', fields: { stress_cut_pcts: { A: 0.8, B: 0.2 } } },
      ]);
    } finally {
      dropItem('g');
    }
  });

  // The query refuses a cut map key outside A..E (its schema is strict), and
  // no scenario reads one: a stored map holding one must not freeze the page.
  it('a stored cut map with a key outside A..E is sent with the scenario keys only', async () => {
    setItems({ ...groceries, stress_cut_pcts: { A: 0.5, B: 0.2, Z: 0.4 } }, cinema);
    await openPage();
    await expand('A');
    expect(cells('A')[2].textContent).toBe(money(768));
    querySpy.mockClear();
    const slider = detailRow('g').querySelector('.stress-slider');
    dragTo(slider, 80);
    expect(runwayCalls()[0].itemOverrides).toEqual([{ id: 'g', fields: { stress_cut_pcts: { A: 0.8, B: 0.2 } } }]);
    expect(cells('A')[2].textContent).toBe(money(408));
    release(slider);
    // Queued: the next tick's override comes from the queue's pending fields.
    querySpy.mockClear();
    const other = detailRow('c').querySelector('.stress-slider');
    dragTo(other, 30);
    expect(runwayCalls()[0].itemOverrides[0]).toEqual({ id: 'g', fields: { stress_cut_pcts: { A: 0.8, B: 0.2 } } });
    endDrag(other);
    dropItem('g');
  });

  it('a queued cut map with a key outside A..E still paints the figures', async () => {
    setItemFields('g', { stress_cut_pcts: { A: 0.8, B: 0.2, X: 1 } });
    try {
      await openPage();
      expect(runwayCalls().at(-1).itemOverrides).toEqual([{ id: 'g', fields: { stress_cut_pcts: { A: 0.8, B: 0.2 } } }]);
      expect(cells('A')[2].textContent).toBe(money(408));
    } finally {
      dropItem('g');
    }
  });

  it('a failed query leaves the figures as they were and warns', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const before = scenarioRow('A').textContent;
      const adj = detailRow('g').querySelector('[data-role="adj"]').textContent;
      querySpy.mockReturnValueOnce({ ok: false, error: { code: 'bad_input', params: {} } });
      const slider = detailRow('g').querySelector('.stress-slider');
      dragTo(slider, 80);
      endDrag(slider);
      expect(scenarioRow('A').textContent).toBe(before);
      expect(detailRow('g').querySelector('[data-role="adj"]').textContent).toBe(adj);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('stress.runway'), 'bad_input');
    } finally {
      warn.mockRestore();
    }
  });

  it('a query that throws leaves the figures as they were and warns', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const before = scenarioRow('A').textContent;
      querySpy.mockImplementationOnce(() => { throw new Error('boom'); });
      const slider = detailRow('g').querySelector('.stress-slider');
      expect(() => dragTo(slider, 80)).not.toThrow();
      endDrag(slider);
      expect(scenarioRow('A').textContent).toBe(before);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('stress.runway query threw'), expect.any(Error));
    } finally {
      warn.mockRestore();
    }
  });

  it('a failed query on a repaint leaves the table as it was', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const before = document.getElementById('stress-table').innerHTML;
      querySpy.mockReturnValueOnce({ ok: false, error: { code: 'bad_input', params: {} } });
      scenarioRow('B').click();
      expect(document.getElementById('stress-table').innerHTML).toBe(before);
      expect(document.getElementById('stress-cash').textContent).toBe(fmt(1500));
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('stress.runway'), 'bad_input');
      // A is still the open scenario: the next click on it closes it.
      scenarioRow('A').click();
      expect(document.querySelector('.stress-detail')).toBeNull();
    } finally {
      warn.mockRestore();
    }
  });
});

describe('scenario-only expense editor', () => {
  const form = () => document.querySelector('[data-sheet-open] [data-stress-expense-form]');
  const openNew = async () => {
    state.meta = { ...state.meta, schemaVersion: 8 };
    await openPage();
    [...document.querySelectorAll('#stress-expenses button')].find(b => b.textContent === t('stressExpenses.add')).click();
  };
  const save = async () => { form().dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await flush(); };
  it('saves an extra cost, repaints the totals, and supports editing and deletion', async () => {
    await openNew();
    setValue(form().elements.name, 'Private healthcare'); setValue(form().elements.A, '100');
    const ledger = state.transactions, items = state.budgetItems;
    await save();
    expect(state.meta.stressExpenses, JSON.stringify(toastTexts())).toMatchObject([{ name: 'Private healthcare', amounts: { A: 100 } }]);
    expect(state.transactions).toBe(ledger); expect(state.budgetItems).toBe(items);
    expect(document.querySelector('#stress-expenses').textContent).toContain(fmt(1200));
    [...document.querySelectorAll('#stress-expenses button')].find(b => b.textContent === 'Private healthcare').click();
    setValue(form().elements.A, '200'); await save();
    expect(state.meta.stressExpenses[0].amounts.A).toBe(200);
    [...document.querySelectorAll('#stress-expenses button')].find(b => b.textContent === 'Private healthcare').click();
    [...form().closest('.sheet').querySelectorAll('button')].find(b => b.textContent === t('common.delete')).click();
    await flush(); dialogOk().click(); await flush();
    expect(state.meta.stressExpenses).toEqual([]);
  });
  it('keeps invalid input and failed writes in the sheet', async () => {
    await openNew(); await save();
    expect(form().textContent).toContain(t('stressExpenses.invalid'));
    setValue(form().elements.name, 'Medical'); setValue(form().elements.A, '100');
    writeBatch.mockRejectedValueOnce(new Error('disk full')); await save();
    expect(form().elements.name.value).toBe('Medical');
    expect(state.meta.stressExpenses).toBeUndefined();
  });
  it('does not save an old editor into a newly selected budget', async () => {
    await openNew(); setValue(form().elements.name, 'Medical'); setValue(form().elements.A, '100');
    state.budgetFolder = { name: 'new-budget' }; await save();
    expect(state.meta.stressExpenses).toBeUndefined();
    expect(writeBatch).not.toHaveBeenCalled();
  });
});
