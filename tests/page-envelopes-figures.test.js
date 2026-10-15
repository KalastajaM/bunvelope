// @vitest-environment jsdom
// The Envelopes page's figures read queries: `envelopes.month` (balance,
// todayBalance, planned, spent, spare, fundsTemplates, goal, funding) for
// every listed envelope (the active ones, or all when archived are shown)
// and `balances` (Unallocated), asked once per data change; the search, the
// category filter and the grouping work on that answer locally. The head and
// category totals are sums of the rows shown. The emergency card's breakdown
// is `emergency.requirement`, asked on click.
//
// Every figure is pinned against the page's old composition (the engine calls
// it made, copied below verbatim), under the Today, Booked and Forecast
// lenses: a card is compared whole with the card the old figures build. One
// deliberate change: spare and fill % used to be computed over the SEARCHED
// list, so typing a search could change an envelope's spare (a set-mode
// template's target is looked up in that list); they are now the full list's,
// whatever the search or category.
//
// The page stub's viewTxs ignores the lens; here it is the real lens over the
// fake state, as js/app.js resolves it. Budget: tests/_fakes/envelopesBudget.js.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../js/app.js', async () => {
  const fake = await import('./_fakes/pageApp.js');
  const { lensTransactions } = await import('../js/engine/lens.js');
  const source = (o) => (o ? { ...fake.state, transactions: o } : fake.state);
  return {
    ...fake.appStub,
    viewTxs: vi.fn((o) => {
      const { lens, horizon } = fake.appStub.activeLensInput();
      return lensTransactions(source(o), { lens, horizon, today: new Date(fake.FIXED_NOW) });
    }),
    todayTxs: vi.fn((o) => lensTransactions(source(o), { lens: 'today', today: new Date(fake.FIXED_NOW) })),
  };
});

import { viewTxs, todayTxs, datedPlanItems, getPrefs } from '../js/app.js';
import { render } from '../js/pages/envelopes.js';
import { render as renderDashboard } from '../js/pages/dashboard.js';
import {
  computeEnvelopeBalances, computeMonthlyPlanByEnvelope, computeAccountBalances, computeUnallocated,
  computeEmergencyFundRequirement, computeSpareByEnvelope, computeTemplateSourceDraws,
  computeSpentThisMonthByEnvelope, computeItemFundingByEnvelope, computeEnvelopeGoalProgress, LENS_TODAY, LENS_BOOKED,
} from '../js/engine.js';
import { envelopeCard, fundsLabel } from '../js/ui/envelope-card.js';
import { openEmergencyCalcDialog } from '../js/ui/emergency-calc-dialog.js';
import { moneyEl } from '../js/ui/money.js';
import { t, fmtDateShortLang } from '../js/ui/i18n.js';
import { fmt } from '../js/utils.js';
import { state, prefs, session, mountHosts, setValue, flush, FIXED_NOW } from './_fakes/pageApp.js';
import { seedEnvelopesBudget } from './_fakes/envelopesBudget.js';
import { stubResizeObserver } from './_fakes/resizeObserver.js';

const LENSES = [
  { name: 'today', set: { lens: 'today' }, input: { lens: 'today' } },
  { name: 'booked', set: { lens: 'booked' }, input: { lens: 'booked' } },
  { name: 'forecast (eom)', set: { lens: 'forecast', lensHorizon: 'eom' }, input: { lens: 'forecast', horizon: 'eom' } },
];
const ACTIVE = ['food', 'fun', 'rent', 'trip', 'car', 'house', 'savings', 'emerg'];

const root = () => document.getElementById('app-root');
const cardOf = (id) => root().querySelector(`[data-env-id="${id}"]`);
const squash = (s) => s.replace(/\s/g, '');
const moneyText = (v, size) => moneyEl(v, { size }).textContent;
const search = (text) => setValue(root().querySelector('.search input'), text, ['input']);
const pickCategory = (cat) => setValue(root().querySelector('.filters select'), cat, ['change']);

// ── The page's old composition, verbatim (envelopes.js before 4d) ───────────
// `listed` is the set the old page projected: its filtered rows. Pinned here
// with the full listed set (no search), which is what the page now asks for.
function oldFigures(listed) {
  const appNow = () => new Date(FIXED_NOW);
  const now = appNow();
  const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const templateDraws = computeTemplateSourceDraws(state.envelopeTemplates, { asOf: todayStr });
  const balances = computeEnvelopeBalances(viewTxs());
  const todayBalances = computeEnvelopeBalances(todayTxs());
  const acctBalances = computeAccountBalances(state.accounts, viewTxs());
  const unallocated = computeUnallocated(acctBalances, balances, state.accounts);
  const planMap = computeMonthlyPlanByEnvelope(datedPlanItems());
  const planByEnv = {};
  for (const [id, v] of planMap) planByEnv[id] = v;
  const spareByEnv = computeSpareByEnvelope({
    transactions: state.transactions,
    budgetItems: state.budgetItems,
    envelopeTemplates: state.envelopeTemplates,
    accounts: state.accounts,
    envelopes: listed,
    today: appNow(),
    months: 12,
    country: state.meta?.country ?? 'FI',
    tombstones: state.meta?.scheduledTombstones || [],
  });
  const itemFundingByEnv = computeItemFundingByEnvelope({
    envelopes: listed,
    budgetItems: state.budgetItems || [],
    transactions: state.transactions,
    balances: computeEnvelopeBalances(state.transactions, { asOf: appNow() }),
    today: appNow(),
    country: state.meta?.country ?? 'FI',
    tombstones: state.meta?.scheduledTombstones || [],
    dailyByEnvelope: new Map([...spareByEnv].map(([id, sp]) => [id, sp.daily])),
  });
  const spentByEnv = computeSpentThisMonthByEnvelope(state.transactions, appNow());
  const showCoveredDate = getPrefs().lens !== LENS_TODAY;
  const showBalanceCovered = getPrefs().lens === LENS_BOOKED;
  const of = (env) => ({
    balance: balances.get(env.id) || 0,
    upcomingDelta: (balances.get(env.id) || 0) - (todayBalances.get(env.id) || 0),
    planned: planByEnv[env.id] || 0,
    spent: spentByEnv.get(env.id) || 0,
    spare: spareByEnv.get(env.id) || null,
    fundsTemplates: templateDraws.get(env.id) || null,
    itemFunding: itemFundingByEnv.get(env.id) || null,
    // envelope-card.js before 4d computed this itself, with the app clock.
    goal: computeEnvelopeGoalProgress(env, balances.get(env.id) || 0, appNow()),
    showCoveredDate,
    showBalanceCovered,
  });
  return { balances, unallocated, of };
}
// envelopes.js before 4d, the emergency card's click, verbatim.
function oldEmergencyCalc() {
  const now = new Date(FIXED_NOW);
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  return computeEmergencyFundRequirement({
    envelopes: state.envelopes,
    budgetItems: state.budgetItems,
    transactions: viewTxs(),
    month,
    meta: state.meta,
  });
}

/** The grid card the old figures build, as the page decorates it. */
function expectedCard(env, f) {
  const fn = () => {};
  const emergencyId = state.meta?.emergency_envelope_id || null;
  const card = envelopeCard({
    envelope: env, ...f,
    isEmergency: env.id === emergencyId,
    onClick: fn, onToggleFavorite: fn, onEdit: fn,
    onHealthCheck: env.archived ? null : fn,
    onShowCalculation: env.id === emergencyId ? fn : null,
  });
  if (env.archived) card.classList.add('env--archived');
  card.draggable = true;
  card.dataset.envId = env.id;
  return card;
}

let querySpy;
const asked = (name) => querySpy.mock.calls.filter(([n]) => n === name).map(([, input]) => input);

async function openPage() {
  mountHosts();
  await render(root());
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.stubGlobal('requestAnimationFrame', () => 0);
  vi.stubGlobal('CSS', { escape: (s) => String(s) });
  seedEnvelopesBudget();
  querySpy = vi.spyOn(session, 'query');
});

describe.each(LENSES)('Envelopes page figures, $name lens', ({ set }) => {
  beforeEach(() => { Object.assign(prefs, set); });

  it('every grid card is the card the old figures build (balance, spare, planned, spent, upcoming, funds, fill %, goal)', async () => {
    await openPage();
    const active = state.envelopes.filter(e => !e.archived);
    const old = oldFigures(active);
    expect([...root().querySelectorAll('[data-env-id]')].map(c => c.dataset.envId)).toEqual(ACTIVE);
    for (const env of active) {
      expect(cardOf(env.id).outerHTML, env.id).toBe(expectedCard(env, old.of(env)).outerHTML);
    }
  });

  it('with archived shown, the archived card too (no spare, no fill %)', async () => {
    state.meta = { ...state.meta, show_archived_envelopes: true };
    await openPage();
    const old = oldFigures(state.envelopes);
    for (const env of state.envelopes) {
      expect(cardOf(env.id).outerHTML, env.id).toBe(expectedCard(env, old.of(env)).outerHTML);
    }
    expect(cardOf('gone').classList.contains('env--archived')).toBe(true);
  });

  it('the head: active count and the sum of the active balances; the header button reads Unallocated', async () => {
    await openPage();
    const active = state.envelopes.filter(e => !e.archived);
    const old = oldFigures(active);
    const totalBal = active.reduce((s, e) => s + (old.balances.get(e.id) || 0), 0);
    expect(root().querySelector('.page-head-sub').textContent)
      .toBe(`${t('envelopes.countN')(active.length)} · ${moneyText(totalBal, 'sm')}`);
    const btn = root().querySelector('.page-head .actions .btn:not(#env-new):not(.view-toggle-btn)');
    const u = old.unallocated;
    if (u > 0.005) {
      expect(btn.className).toBe('btn btn-accent');
      expect(btn.textContent).toBe(t('dashboard.heroActionAssign')(fmt(u)));
    } else if (u < -0.005) {
      expect(btn.className).toBe('btn btn-danger');
      expect(btn.textContent).toBe(t('dashboard.heroActionCorrect')(fmt(Math.abs(u))));
    } else {
      expect(btn.className).toBe('btn btn-ghost');
    }
  });

  it('with archived shown, the head counts and sums every listed envelope', async () => {
    state.meta = { ...state.meta, show_archived_envelopes: true };
    await openPage();
    const all = state.envelopes;
    const archivedN = all.filter(e => e.archived).length;
    expect(archivedN).toBeGreaterThan(0);
    const old = oldFigures(all);
    const totalBal = all.reduce((s, e) => s + (old.balances.get(e.id) || 0), 0);
    expect(root().querySelector('.page-head-sub').textContent)
      .toBe(`${t('envelopes.countWithArchived')(all.length, archivedN)} · ${moneyText(totalBal, 'sm')}`);
  });

  it('each category head: the count and the sum of the rows shown in it', async () => {
    state.meta = { ...state.meta, show_archived_envelopes: true };
    await openPage();
    const old = oldFigures(state.envelopes);
    const check = (byCat) => {
      for (const [cat, ids] of Object.entries(byCat)) {
        if (!ids.length) { expect(root().querySelector(`[data-group-cat="${cat}"]`), cat).toBeNull(); continue; }
        const right = root().querySelector(`[data-group-cat="${cat}"] > div:first-child > div:last-child`);
        const sum = ids.reduce((s, id) => s + (old.balances.get(id) || 0), 0);
        expect(right.textContent, cat).toBe(`${t('envelopes.countN')(ids.length)}${moneyText(sum, 'md')}`);
      }
    };
    // The archived envelope ('gone') heads its own Archived group, the last one.
    const archivedHead = () => [...root().querySelectorAll('[data-group-cat]')].at(-1)
      .querySelector(':scope > div:first-child > div:last-child');
    const archivedText = `${t('envelopes.countN')(1)}${moneyText(old.balances.get('gone') || 0, 'md')}`;
    check({ living: ['food', 'fun'], housing: ['rent'], leisure: ['trip'], transport: ['car'], saving: ['house', 'savings', 'emerg'] });
    expect(archivedHead().textContent).toBe(archivedText);
    search('o');
    check({ living: ['food'], housing: [], leisure: [], transport: [], saving: ['house', 'savings'] });
    expect(archivedHead().textContent).toBe(archivedText);
  });

  it('the list view rows: balance, spare, spent of planned and the funds line', async () => {
    prefs.envView = 'list';
    await openPage();
    const active = state.envelopes.filter(e => !e.archived);
    const old = oldFigures(active);
    for (const env of active) {
      const f = old.of(env);
      const row = cardOf(env.id);
      const bal = row.querySelector('.env-list-bal');
      expect(bal.firstElementChild.textContent, env.id).toBe(moneyText(f.balance, 'sm'));
      const spareEl = row.querySelector('.env-list-spare');
      const isShort = f.spare.spare < -0.005;
      expect(spareEl.className, env.id).toBe('env-list-spare' + (isShort ? ' is-short' : ''));
      const coveredDate = f.showCoveredDate && isShort ? f.spare.coveredDate || null : null;
      expect(spareEl.textContent, env.id).toBe(moneyText(f.spare.spare, 'sm') + ' ' + (coveredDate
        ? t('envelopes.shortUntilSuffix')(fmtDateShortLang(coveredDate))
        : t(isShort ? 'envelopes.shortSuffix' : 'envelopes.spareSuffix')));
      expect(row.querySelector('.env-list-spent')?.textContent ?? null, env.id).toBe(f.planned > 0
        ? t('envelopes.spentOfPlanned')({ spent: fmt(f.spent), amt: fmt(f.planned) }) : null);
      expect(row.querySelector('.env-list-funds')?.textContent ?? null, env.id)
        .toBe(f.fundsTemplates ? fundsLabel(f.fundsTemplates) : null);
    }
  });

  it('the emergency card\'s calculation is the old breakdown over the lens rows', async () => {
    await openPage();
    const env = state.envelopes.find(e => e.id === 'emerg');
    cardOf('emerg').querySelector(`[title="${t('envelopes.emergencyCalcTitle')}"]`).click();
    const shown = document.getElementById('sheet-host').innerHTML;
    mountHosts();
    openEmergencyCalcDialog(oldEmergencyCalc(), env);
    expect(shown.replace(/sheet-title-[\w-]+/g, 'T')).toBe(document.getElementById('sheet-host').innerHTML.replace(/sheet-title-[\w-]+/g, 'T'));
  });
});

describe('the figures, worked out (Booked)', () => {
  beforeEach(async () => { prefs.lens = 'booked'; await openPage(); });

  it('food: 180 in it, short 70 until the window\'s end, 120 of 360 spent, both items short', () => {
    const food = cardOf('food');
    expect(squash(food.querySelector('.env-fig--balance').textContent)).toContain(squash(fmt(180)));
    expect(squash(food.querySelector('.env-fig--spare').textContent)).toContain(squash(fmt(-70)));
    expect(food.querySelector('.env-fig--spare').classList.contains('is-short')).toBe(true);
    expect(food.querySelector('.env-spent-line').textContent).toBe(t('envelopes.spentOfPlanned')({ spent: fmt(120), amt: fmt(360) }));
    expect(food.querySelector('.env-items').textContent).toBe(t('itemFunding.cardLine')(0, 2));
  });

  it('fun: Booked -10 is covered on 1 Oct; the 50 bill is upcoming', () => {
    const fun = cardOf('fun');
    expect(fun.querySelector('.env-fig--balance .env-fig-lbl').textContent)
      .toBe(`${t('envelopes.headInEnvelope')} ${t('envelopes.coveredSuffix')(fmtDateShortLang('2026-10-01'))}`);
    expect(fun.querySelector('.env-upcoming').textContent).toBe(t('envelopes.upcomingHint')(fmt(-50, { signed: true })));
  });

  it('the goal lines: trip behind at 25 % needing 105.77 a month, car reached, house without a deadline', () => {
    const trip = cardOf('trip').querySelector('.env-goal-line');
    expect(trip.querySelector('.env-goal-dot').className).toBe('env-goal-dot env-goal-dot--behind');
    expect(trip.textContent).toBe(`${t('envelopes.goalProgressShort')(25)} · ${t('envelopes.goalNeed')(fmt(105.77))}${t('envelopes.goalBehind')}`);
    expect(cardOf('car').querySelector('.env-goal-line').textContent).toBe(t('envelopes.goalReachedTag'));
    expect(cardOf('house').querySelector('.env-goal-line').textContent).toBe(t('envelopes.goalProgressShort')(4));
    expect(cardOf('food').querySelector('.env-goal-line')).toBeNull();
  });

  it('savings: funds the trip top-up, 800 spare once the top-up lands', () => {
    const savings = cardOf('savings');
    expect(savings.querySelector('.env-funds').textContent).toBe(t('envelopes.fundsTemplate')('Trip top-up'));
    expect(squash(savings.querySelector('.env-fig--spare').textContent)).toContain(squash(fmt(800)));
  });
});

describe('a search or a category no longer changes the figures (the deliberate fix)', () => {
  beforeEach(() => { prefs.lens = 'booked'; });
  const spareOf = (id) => squash(cardOf(id).querySelector('.env-fig--spare').textContent);

  it('savings keeps its 800 spare when a search hides the trip it tops up (the old page showed 1,000)', async () => {
    await openPage();
    const full = spareOf('savings');
    expect(full).toContain(squash(fmt(800)));
    search('sav');
    expect(cardOf('trip')).toBeNull();
    expect(spareOf('savings')).toBe(full);
    // What the old page projected for the searched list.
    const old = oldFigures(state.envelopes.filter(e => e.id === 'savings'));
    expect(old.of(state.envelopes.find(e => e.id === 'savings')).spare.spare).toBe(1000);
  });

  it('and when the category filter hides it', async () => {
    await openPage();
    const full = cardOf('savings').outerHTML;
    pickCategory('saving');
    expect(cardOf('trip')).toBeNull();
    expect(cardOf('savings').outerHTML).toBe(full);
  });
});

describe('the clock and the failure paths', () => {
  const headerBtn = () => root().querySelector('.page-head .actions button:not(#env-new):not(.view-toggle-btn)');

  it.each([['23:45', 23, 45], ['00:10', 0, 10]])('at %s the page asks for the same day it shows and its head equals the old figures', async (_n, h, m) => {
    const saved = FIXED_NOW.getTime();
    FIXED_NOW.setTime(new Date(2026, 8, 15, h, m, 0).getTime());
    try {
      prefs.lens = 'booked';
      await openPage();
      expect(asked('envelopes.month')[0].date).toBe('2026-09-15');
      const active = state.envelopes.filter(e => !e.archived);
      const old = oldFigures(active);
      const totalBal = active.reduce((s, e) => s + (old.balances.get(e.id) || 0), 0);
      expect(root().querySelector('.page-head-sub').textContent)
        .toBe(`${t('envelopes.countN')(active.length)} · ${moneyText(totalBal, 'sm')}`);
    } finally { FIXED_NOW.setTime(saved); }
  });

  it('a failed balances query leaves the header button off, never a 0 fallback', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    querySpy.mockRestore();
    const real = session.query.bind(session);
    querySpy = vi.spyOn(session, 'query').mockImplementation((n, input) => (n === 'balances' ? { ok: false, error: { code: 'bad_input', params: {} } } : real(n, input)));
    prefs.lens = 'booked';
    await openPage();
    expect(headerBtn().hidden).toBe(true);
    // The grid still renders from envelopes.month.
    expect(root().querySelectorAll('[data-env-id]').length).toBeGreaterThan(0);
  });

  it('a failed envelope query shows an unavailable state without a false zero and can retry', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    querySpy.mockRestore();
    const real = session.query.bind(session);
    querySpy = vi.spyOn(session, 'query').mockImplementation((n, input) => (n === 'envelopes.month' ? { ok: false, error: { code: 'bad_input', params: {} } } : real(n, input)));
    prefs.lens = 'booked';
    await openPage();
    expect(root().querySelector('.page-head-sub').textContent).toBe(t('envelopes.countN')(state.envelopes.filter(e => !e.archived).length));
    expect(root().querySelector('.empty-title').textContent).toBe(t('envelopes.loadFailed'));
    expect(root().textContent).not.toContain(t('envelopes.emptyBody'));
    search('food');
    expect(root().querySelector('.search-count').textContent).toBe('');
    expect(root().querySelector('.empty-title').textContent).toBe(t('envelopes.loadFailed'));
    querySpy.mockImplementation(real);
    root().querySelector('.empty-action').click();
    expect(cardOf('food')).not.toBeNull();
    expect(root().querySelector('.empty-state')).toBeNull();
    expect(root().querySelector('.page-head-sub').textContent).toContain('€');
  });
});

describe('the queries the page asks', () => {
  it('envelopes.month for every active envelope and balances, once at open, through the lens', async () => {
    Object.assign(prefs, { lens: 'forecast', lensHorizon: 'eom' });
    await openPage();
    expect(asked('envelopes.month')).toEqual([{ lens: 'forecast', horizon: 'eom', date: '2026-09-15', envelopes: ACTIVE }]);
    expect(asked('balances')).toEqual([{ lens: 'forecast', horizon: 'eom' }]);
  });

  it('every envelope when archived are shown', async () => {
    prefs.lens = 'today';
    state.meta = { ...state.meta, show_archived_envelopes: true };
    await openPage();
    expect(asked('envelopes.month')).toEqual([{ lens: 'today', date: '2026-09-15', envelopes: state.envelopes.map(e => e.id) }]);
  });

  it('a search, a category or the view toggle repaints without asking again; a data change asks again', async () => {
    prefs.lens = 'booked';
    await openPage();
    search('s'); search('sa'); search('sav'); search('');
    pickCategory('living'); pickCategory('');
    root().querySelector('.view-toggle-btn:last-child').click();
    expect(asked('envelopes.month')).toHaveLength(1);
    expect(asked('balances')).toHaveLength(1);
    // A write replaces an array: the next repaint asks again.
    state.transactions = [...state.transactions];
    root().querySelector('.view-toggle-btn:first-child').click();
    expect(asked('envelopes.month')).toHaveLength(2);
    expect(asked('balances')).toHaveLength(2);
  });

  it('the emergency calculation is asked on click, for this month through the lens', async () => {
    Object.assign(prefs, { lens: 'forecast', lensHorizon: 'eom' });
    await openPage();
    expect(asked('emergency.requirement')).toEqual([]);
    cardOf('emerg').querySelector(`[title="${t('envelopes.emergencyCalcTitle')}"]`).click();
    expect(asked('emergency.requirement')).toEqual([{ lens: 'forecast', horizon: 'eom', month: '2026-09' }]);
  });
});

describe('the Dashboard\'s envelope tiles carry the goal line', () => {
  beforeEach(() => { stubResizeObserver(); });
  const tiles = () => [...document.querySelectorAll('.card')]
    .find(c => c.querySelector(':scope > .card-title h3')?.textContent === t('dashboard.envelopes'));

  it.each(LENSES)('$name: the favourites\' goal lines as the old card computed them', async ({ set }) => {
    Object.assign(prefs, set);
    state.envelopes = state.envelopes.map(e => (['trip', 'car', 'house'].includes(e.id) ? { ...e, favorite: true } : e));
    mountHosts();
    await renderDashboard(root());
    await flush();
    const balances = computeEnvelopeBalances(viewTxs());
    const lines = [...tiles().querySelectorAll('.overview-envelope-row')].map(c => c.querySelector('.env-goal-line')?.outerHTML ?? null);
    const expected = ['trip', 'car', 'house'].map((id) => {
      const env = state.envelopes.find(e => e.id === id);
      const card = envelopeCard({ envelope: env, balance: balances.get(id) || 0, planned: 0, spent: 0,
        goal: computeEnvelopeGoalProgress(env, balances.get(id) || 0, new Date(FIXED_NOW)) });
      return card.querySelector('.env-goal-line')?.outerHTML ?? null;
    });
    expect(lines).toEqual(expected);
    expect(lines.every(Boolean)).toBe(true);
  });
});


it('remembers supporting details across visits without hiding the main envelope figures', async () => {
  mountHosts();
  await render(root());
  const toggle = root().querySelector('.env-details-toggle');
  expect(toggle).not.toBeNull();
  expect(toggle.getAttribute('aria-pressed')).toBe('false');
  toggle.click();
  expect(root().querySelector('.working-money').classList.contains('show-envelope-details')).toBe(true);
  expect(cardOf('food').querySelector('.env-fig--balance')).not.toBeNull();
  mountHosts();
  await render(root());
  expect(root().querySelector('.env-details-toggle').getAttribute('aria-pressed')).toBe('true');
});
