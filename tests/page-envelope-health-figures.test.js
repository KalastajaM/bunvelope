// @vitest-environment jsdom
// The envelope health sheet reads `envelope.health` (the projection, the
// recommendations, the item funding, the lens balance), asked once when it
// opens. Every figure is pinned against the sheet's old composition (the
// engine calls it made, copied below verbatim) under the Today, Booked and
// Forecast lenses: the fill line, the four tiles, the item-funding section,
// the chart, the recommendations' text and the month table.
//
// The page stub's viewTxs ignores the lens; here it is the real lens over the
// fake state, as js/app.js resolves it. Budget: tests/_fakes/envelopesBudget.js.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../js/app.js', async () => {
  const fake = await import('./_fakes/pageApp.js');
  const { lensTransactions } = await import('../js/engine/lens.js');
  return {
    ...fake.appStub,
    viewTxs: vi.fn((o) => {
      const { lens, horizon } = fake.appStub.activeLensInput();
      return lensTransactions(o ? { ...fake.state, transactions: o } : fake.state, { lens, horizon, today: new Date(fake.FIXED_NOW) });
    }),
  };
});

import { viewTxs } from '../js/app.js';
import { openEnvelopeHealth } from '../js/pages/envelope-health.js';
import { projectEnvelopeBalance, recommendEnvelopeActions, computeEnvelopeBalances, computeItemFunding } from '../js/engine.js';
import { healthChart } from '../js/ui/health-chart.js';
import { itemFundingSection } from '../js/ui/item-funding-view.js';
import { moneyEl } from '../js/ui/money.js';
import { t } from '../js/ui/i18n.js';
import { fmt } from '../js/utils.js';
import { state, prefs, session, mountHosts, FIXED_NOW } from './_fakes/pageApp.js';
import { seedEnvelopesBudget } from './_fakes/envelopesBudget.js';

const LENSES = [
  { name: 'today', set: { lens: 'today' }, input: { lens: 'today' } },
  { name: 'booked', set: { lens: 'booked' }, input: { lens: 'booked' } },
  { name: 'forecast (eom)', set: { lens: 'forecast', lensHorizon: 'eom' }, input: { lens: 'forecast', horizon: 'eom' } },
];
const IDS = ['food', 'fun', 'rent', 'trip', 'car', 'house', 'savings', 'emerg'];

// ── The sheet's old composition, verbatim (envelope-health.js before 4d) ─────
function oldSheet(envelope) {
  const input = {
    envelopeId: envelope.id,
    transactions: state.transactions,
    budgetItems: state.budgetItems,
    envelopeTemplates: state.envelopeTemplates,
    accounts: state.accounts,
    envelopes: state.envelopes,
    today: new Date(FIXED_NOW),
    months: 12,
    country: state.meta?.country ?? 'FI',
    tombstones: state.meta?.scheduledTombstones || [],
  };
  const projection = projectEnvelopeBalance(input);
  const recs = recommendEnvelopeActions(input, projection);
  const lensBalance = computeEnvelopeBalances(viewTxs()).get(envelope.id) ?? 0;
  const funding = computeItemFunding({
    envelopeId: envelope.id,
    budgetItems: state.budgetItems || [],
    transactions: state.transactions,
    balance: computeEnvelopeBalances(state.transactions, { asOf: input.today }).get(envelope.id) ?? 0,
    today: input.today,
    country: input.country,
    tombstones: input.tombstones,
    daily: projection.daily,
  });
  return { projection, recs, lensBalance, funding };
}
// envelope-health.js recommendationText before 4d, verbatim.
function recommendationText(rec, projection) {
  const money = v => fmt(v);
  const T = t('health.rec');
  const isSet = rec.meta && rec.meta.fillMode === 'set';
  switch (rec.kind) {
    case 'shortfall-topup':
      return rec.amount === null
        ? { text: T.shortfallTopupUnsolvable, action: null }
        : { text: T.shortfallTopup(money(rec.amount), rec.date), action: 'fill', amount: rec.amount };
    case 'shortfall-monthly':
      if (rec.amount === null) {
        return { text: isSet ? T.shortfallTargetUnsolvable : T.shortfallMonthlyUnsolvable, action: null };
      }
      return {
        text: (isSet ? T.shortfallTarget : T.shortfallMonthly)(money(rec.amount), money(projection.monthlyFill + rec.amount)),
        action: 'template',
      };
    case 'overfunded-trim':
      return {
        text: (isSet ? T.overfundedTrimTarget : T.overfundedTrim)(money(rec.amount), money(projection.monthlyFill - rec.amount)),
        action: 'template',
      };
    case 'goal-on-track':
      return {
        text: rec.date
          ? T.goalOnTrack(money(rec.meta.goalAmount), rec.date)
          : T.goalOnTrackNoDate(money(rec.meta.goalAmount)),
        action: null,
      };
    case 'goal-shortfall': {
      const by = rec.date || rec.meta.cutoff;
      if (rec.amount === null) {
        return { text: T.goalShortfallUnsolvable(money(rec.meta.goalAmount), by), action: null };
      }
      if (rec.meta.fillMode === 'one-time') {
        return {
          text: T.goalShortfallTopup(money(rec.meta.goalAmount), by, money(rec.amount)),
          action: 'fill',
          amount: rec.amount,
        };
      }
      return {
        text: (isSet ? T.goalShortfallTarget : T.goalShortfall)(money(rec.meta.goalAmount), by, money(rec.amount)),
        action: 'template',
      };
    }
    case 'warn-fill-from-history': return { text: T.warnFillFromHistory, action: null };
    case 'warn-no-fill': return { text: T.warnNoFill, action: null };
    case 'warn-irregular-fill': return { text: T.warnIrregularFill, action: null };
    case 'warn-drain-only-fill': return { text: T.warnDrainOnlyFill, action: null };
    case 'warn-no-scheduled-expenses': return { text: T.warnNoScheduledExpenses, action: null };
    case 'warn-unresolved-envelope': return { text: T.warnUnresolvedEnvelope, action: null };
    default: return { text: '', action: null };
  }
}

const sheet = () => document.querySelector('#sheet-host .sheet');
const squash = (s) => s.replace(/\s/g, '');
const tiles = () => [...sheet().querySelectorAll('.card')].filter(c => c.style.minWidth === '150px');
const moneyText = (v, size) => moneyEl(v, { size }).textContent;

let querySpy;
const asked = (name) => querySpy.mock.calls.filter(([n]) => n === name).map(([, input]) => input);

beforeEach(() => {
  vi.restoreAllMocks();
  vi.stubGlobal('requestAnimationFrame', () => 0);
  seedEnvelopesBudget();
  mountHosts();
  querySpy = vi.spyOn(session, 'query');
});

describe.each(LENSES)('health sheet figures, $name lens', ({ set }) => {
  beforeEach(() => { Object.assign(prefs, set); });

  it.each(IDS)('%s: the fill line, the tiles, funding, chart, recommendations and month table', (id) => {
    const env = state.envelopes.find(e => e.id === id);
    openEnvelopeHealth(env);
    const { projection, recs, lensBalance, funding } = oldSheet(env);

    // Fill line.
    const fillLine = projection.fillSource === 'scheduled' ? t('health.fillScheduled')(fmt(projection.monthlyFill))
      : projection.fillSource === 'scheduled-set' ? t('health.fillSet')(fmt(projection.monthlyFill))
        : projection.fillSource === 'scheduled-irregular' ? t('health.fillIrregular')
          : projection.fillSource === 'history' ? t('health.fillHistory')(fmt(projection.monthlyFill))
            : t('health.fillNone');
    expect(sheet().querySelector('.muted').textContent).toBe(`${t('health.subtitle')} · ${fillLine}`);

    // Tiles: lens balance (and where the projection starts), low, high, closing.
    const [bal, low, high, closing] = tiles();
    const lens = prefs.lens;
    const startsElsewhere = Math.abs(lensBalance - projection.opening) >= 0.005;
    expect(bal.textContent).toBe(t('health.balanceLabel')(t(`lens.${lens}`)) + moneyText(lensBalance, 'lg')
      + (startsElsewhere ? t('health.projectionStartsFrom')(fmt(projection.opening)) : ''));
    expect(low.textContent).toBe(t('health.lowLabel') + moneyText(projection.low.balance, 'lg') + t('health.onDate')(projection.low.date));
    expect(high.textContent).toBe(t('health.highLabel') + moneyText(projection.high.balance, 'lg') + t('health.onDate')(projection.high.date));
    expect(closing.textContent).toBe(t('health.closingLabel') + moneyText(projection.closing, 'lg'));

    // Item funding.
    const section = sheet().querySelector('section.item-funding');
    if (funding.items.length) expect(section.outerHTML).toBe(itemFundingSection(funding).outerHTML);
    else expect(section).toBeNull();

    // Chart (its data: the daily walk, the low and the high).
    expect(sheet().querySelector('svg').outerHTML).toBe(healthChart({
      daily: projection.daily, low: projection.low, high: projection.high,
      ariaLabel: t('health.chartLabel')(fmt(projection.low.balance), fmt(projection.high.balance)),
    }).outerHTML);

    // Recommendations.
    const recsBox = [...sheet().querySelectorAll('h3')].find(h => h.textContent === t('health.recsTitle')).parentElement;
    const texts = [...recsBox.querySelectorAll('.card > p:first-child')].map(p => p.textContent);
    expect(texts).toEqual(recs.map(r => recommendationText(r, projection).text).filter(Boolean));
    if (!recs.length) expect(recsBox.querySelector('p.muted').textContent).toBe(t('health.recsNone'));

    // Month table.
    const rows = [...sheet().querySelectorAll('tbody tr')].map(tr => [...tr.children].map(td => td.textContent));
    expect(rows).toEqual(projection.months.map(m => [m.partial ? `${m.key} ~` : m.key,
      ...[m.opening, m.in, m.out, m.low, m.closing].map(v => moneyText(v, 'inline'))]));
  });
});

describe('the health sheet, worked out (Booked)', () => {
  beforeEach(() => { prefs.lens = 'booked'; });

  it('rent: short, low −9,600 on 20 Aug 2027; a top-up of 9,606 by tomorrow and an unsolvable monthly rise', () => {
    openEnvelopeHealth(state.envelopes.find(e => e.id === 'rent'));
    expect(squash(tiles()[1].textContent)).toContain(squash(fmt(-9600)));
    expect(tiles()[1].textContent).toContain(t('health.onDate')('2027-08-20'));
    const T = t('health.rec');
    const texts = [...sheet().querySelectorAll('.card > p:first-child')].map(p => p.textContent);
    expect(texts).toEqual([T.shortfallTopup(fmt(9606), '2026-09-16'), T.shortfallMonthlyUnsolvable]);
  });

  it('trip: the set-mode goal shortfall names its target and the cutoff', () => {
    openEnvelopeHealth(state.envelopes.find(e => e.id === 'trip'));
    const T = t('health.rec');
    const first = sheet().querySelector('.card > p:first-child');
    expect(first.textContent).toBe(T.goalShortfallTarget(fmt(1200), '2027-06-01', fmt(700)));
  });
});

describe('the query the sheet asks', () => {
  it('envelope.health once at open, for this envelope through the lens', () => {
    Object.assign(prefs, { lens: 'forecast', lensHorizon: 'eom' });
    openEnvelopeHealth(state.envelopes.find(e => e.id === 'food'));
    expect(asked('envelope.health')).toEqual([{ envelope: 'food', months: 12, lens: 'forecast', horizon: 'eom', date: '2026-09-15' }]);
  });
});
