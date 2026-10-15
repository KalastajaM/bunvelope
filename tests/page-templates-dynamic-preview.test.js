// @vitest-environment jsdom
// Templates page, the dynamic template sheet's live preview: each row's
// "= x / mo" and the footer total, pinned against the sheet's old composition
// copied verbatim from js/pages/templates.js (L484 the monthly plan per
// envelope over the dated plan, L555-575 the row amount and the total), on a
// plan with an ended item, one starting later, a paused one, income, a
// transfer, buffers and a third of a cent, and an archived envelope still
// assigned. And the sheet asks `envelopes.month` once at open, without the
// projections, for every envelope it can pick.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../js/app.js', async () => (await import('./_fakes/pageApp.js')).appStub);

import { render } from '../js/pages/templates.js';
import { parseAmountInput } from '../js/ui/amount-input.js';
import { fmt } from '../js/utils.js';
import { t } from '../js/ui/i18n.js';
import { computeMonthlyPlanByEnvelope, computeDynamicTemplateLines } from '../js/engine/monthly-review.js';
import { planItemsAsOf } from '../js/engine/item-dates.js';
import { state, session, resetState, mountHosts, flush, setValue, topOverlay, FIXED_NOW } from './_fakes/pageApp.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const every = () => Object.fromEntries(MONTHS.map(m => [m, true]));
const sheet = () => topOverlay()?.querySelector('.sheet') ?? null;
const rows = () => [...sheet().querySelectorAll('.split-row')];
const addAssignmentBtn = () => [...sheet().querySelectorAll('button')].find(b => b.textContent === t('templatesPage.addAssignment'));
const querySpy = vi.spyOn(session, 'query');
const monthAsks = () => querySpy.mock.calls.filter(([name]) => name === 'envelopes.month').map(([, input]) => input);

// ── The sheet's old composition, copied from js/pages/templates.js ─────────
function oldPreview() {
  const monthlyPlan = computeMonthlyPlanByEnvelope(planItemsAsOf(state.budgetItems, FIXED_NOW));
  function computeRowMonthly(envId, pct) {
    const base = monthlyPlan.get(envId) || 0;
    const p = parseAmountInput(pct);
    if (!envId || !Number.isFinite(p) || p <= 0) return 0;
    return base * (p / 100);
  }
  let sum = 0;
  const previews = rows().map(r => {
    const envId = r.querySelector('.split-env').value;
    const pct = r.querySelector('.split-pct').value;
    const amt = computeRowMonthly(envId, pct);
    sum += amt;
    return envId ? `= ${fmt(amt)} / mo` : '';
  });
  return { previews, total: t('templatesPage.monthlyTotal')(fmt(sum)) };
}

function expectAsBefore() {
  const want = oldPreview();
  expect(rows().map(r => r.querySelector('.split-preview').textContent)).toEqual(want.previews);
  expect(sheet().textContent).toContain(want.total);
  return want;
}

const pick = (row, envId, pct) => {
  setValue(row.querySelector('.split-env'), envId, ['change']);
  if (pct != null) setValue(row.querySelector('.split-pct'), String(pct));
};

async function openPage() {
  mountHosts();
  await render(document.getElementById('app-root'));
}

beforeEach(async () => {
  vi.stubGlobal('requestAnimationFrame', (cb) => setTimeout(cb, 0));
  resetState();
  state.envelopes = [
    { id: 'food', name: 'Food', category: 'living' },
    { id: 'fun', name: 'Fun', category: 'living' },
    { id: 'rent', name: 'Rent', category: 'housing' },
    { id: 'old', name: 'Old', category: 'living', archived: true },
  ];
  const item = (id, envelope_id, amt, over = {}) => ({
    id, kind: 'expense', envelope_id, description: id, default_amount: -amt, extra_buffer: 0,
    include: true, monthly_schedule: every(), as_schedule: false, ...over,
  });
  state.budgetItems = [
    item('groc', 'food', 100.333, { extra_buffer: 40 }),
    item('market', 'food', 12, { monthly_schedule: { Jan: true, Mar: 30.5 } }),
    item('rent', 'rent', 800),
    item('ended', 'rent', 500, { end_month: '2026-08' }),
    item('later', 'fun', 60, { start_month: '2027-03' }),
    item('paused', 'fun', 999, { include: false }),
    item('olditem', 'old', 45),
    { id: 'pay', kind: 'income', envelope_id: 'food', default_amount: 3000, extra_buffer: 0, include: true, monthly_schedule: every() },
    { id: 'move', kind: 'account_transfer', envelope_id: null, default_amount: -200, include: true, monthly_schedule: every() },
  ];
  state.envelopeTemplates = [{
    id: 'plan-share', name: 'Plan share', description: '', kind: 'dynamic',
    assignments: [
      { envelope_id: 'food', mode: 'add', percent: 50 },
      { envelope_id: 'old', mode: 'add', percent: 33.3 },
      { envelope_id: 'rent', mode: 'set', percent: 100 },
    ],
  }];
  querySpy.mockClear();
  await openPage();
});

async function editDynamic() {
  const card = [...document.querySelectorAll('.tpl-card')].find(c => c.querySelector('.tpl-name').textContent === 'Plan share');
  card.querySelectorAll('.tpl-actions button')[0].click();
  await flush();
}

async function newDynamic() {
  document.querySelector('.page-head .btn-accent').click();
  await flush();
  sheet().querySelectorAll('.tpl-kind-card')[1].click();
  await flush();
}

describe('the dynamic preview as before', () => {
  it('an existing template, an archived envelope among its rows', async () => {
    await editDynamic();
    expect(rows()).toHaveLength(3);
    const want = expectAsBefore();
    // Not vacuous: every row has an amount.
    expect(want.previews.every(p => p && p !== `= ${fmt(0)} / mo`)).toBe(true);
  });

  it('typing percents, a formula, a blank and a zero; another envelope; a row added and left empty', async () => {
    await editDynamic();
    setValue(rows()[0].querySelector('.split-pct'), '12.5');
    expectAsBefore();
    setValue(rows()[0].querySelector('.split-pct'), '1,5');
    expectAsBefore();
    setValue(rows()[1].querySelector('.split-pct'), '');
    expectAsBefore();
    setValue(rows()[2].querySelector('.split-pct'), '0');
    expectAsBefore();
    pick(rows()[2], 'fun', 150);
    expectAsBefore();
    addAssignmentBtn().click();
    expectAsBefore();
  });

  it('a new template', async () => {
    await newDynamic();
    pick(rows()[0], 'food', 50);
    expectAsBefore();
    addAssignmentBtn().click();
    pick(rows()[1], 'rent', 25);
    expectAsBefore();
  });
});

describe('the preview is what the fill posts', () => {
  it('500 spread over 12 months at 50% previews the amount computeDynamicTemplateLines posts', async () => {
    // 500 once a year is 41.666.../mo; half of it is 20.8433, posted as 20.84.
    state.envelopes.push({ id: 'yearly', name: 'Yearly', category: 'living' });
    state.budgetItems = [{
      id: 'y', kind: 'expense', envelope_id: 'yearly', description: 'y', default_amount: -500, extra_buffer: 0,
      include: true, monthly_schedule: { Jan: true }, as_schedule: false,
    }];
    state.envelopeTemplates = [{ id: 'yr', name: 'Plan share', description: '', kind: 'dynamic', assignments: [{ envelope_id: 'yearly', mode: 'add', percent: 50 }] }];
    await openPage();
    await editDynamic();
    const posted = computeDynamicTemplateLines(state.envelopeTemplates[0], planItemsAsOf(state.budgetItems, FIXED_NOW));
    expect(posted).toEqual([{ envelope_id: 'yearly', mode: 'add', amount: 20.84 }]);
    expect(rows()[0].querySelector('.split-preview').textContent).toBe(`= ${fmt(20.84)} / mo`);
    expect(sheet().textContent).toContain(t('templatesPage.monthlyTotal')(fmt(20.84)));
  });
});

describe('the sheet asks envelopes.month', () => {
  it('once at open, without the projections, for every envelope it can pick', async () => {
    querySpy.mockClear();
    await editDynamic();
    expect(monthAsks()).toEqual([{ date: '2026-09-15', spare: false, envelopes: ['food', 'fun', 'rent', 'old'] }]);
    setValue(rows()[0].querySelector('.split-pct'), '12.5');
    expect(monthAsks()).toHaveLength(1);
  });
});
