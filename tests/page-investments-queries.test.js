// @vitest-environment jsdom
// Investments page over the investment queries: the tax card reads
// `investments.tax` and the holdings, totals and each account's gap read
// `investments.holdings`. The figures are pinned against the page's old
// composition (the engine calls it made, copied below), so the switch to the
// queries changes nothing on screen.
//
// The page stub's viewTxs is always booked; here it is the real lens over the
// fake state (as js/app.js resolves it), so the per-account gap is measured
// on the lens the page shows in the app, before and after the switch.
//
// Ledger (chk opens at 5000; brk and isk are investment accounts, isk is
// tax-wrapped; VWCE 120, ZZZ 10, ABC 25; AAPL has no price):
//   2025  buy VWCE 10 for 1000, sell 2 for 300 (a gain, proceeds ≤ 1000);
//         ZZZ bought 4 for 80 and sold out for 60 (a zero holding)
//   2026  buy VWCE 5 for 600, sell 4 for 380 + 5 fee (a loss); AAPL 2 for 300;
//         XYZ sold without a buy on record (no cost: oversold, a zero holding);
//         isk buys ABC and sells half (tax-wrapped: not on the tax card);
//         a scheduled VWCE buy on 1 Oct (after today: the Today lens drops it)
//   a planned monthly VWCE buy of 250 from 1 Sep (the forecast lens adds it)
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../js/app.js', async () => {
  const fake = await import('./_fakes/pageApp.js');
  const { lensTransactions } = await import('../js/engine/lens.js');
  return {
    ...fake.appStub,
    viewTxs: (o) => {
      const { lens, horizon } = fake.appStub.activeLensInput();
      return lensTransactions(o ? { ...fake.state, transactions: o } : fake.state, { lens, horizon, today: fake.FIXED_NOW });
    },
  };
});

import { render } from '../js/pages/investments.js';
import { resetPickedTaxYear } from '../js/pages/investments-tax.js';
import {
  computeRealizedSales, summarizeTaxYear, listHoldings, holdingValue, computeAccountBalances, lensTransactions,
} from '../js/engine.js';
import { getInvestmentsMeta } from '../js/core/investments-meta.js';
import { moneyEl } from '../js/ui/money.js';
import { t, fmtDateLang } from '../js/ui/i18n.js';
import { fmt, fmtNum } from '../js/utils.js';
import { state, prefs, session, navigate, resetState, mountHosts, flush, FIXED_NOW } from './_fakes/pageApp.js';
import { stubResizeObserver } from './_fakes/resizeObserver.js';

const ALL_MONTHS = { Jan: true, Feb: true, Mar: true, Apr: true, May: true, Jun: true, Jul: true, Aug: true, Sep: true, Oct: true, Nov: true, Dec: true };
const trade = (id, direction, date, acct, symbol, units, amount, extra = {}) => ({
  id, type: 'investment_transfer', direction, date, symbol, units, amount, payee: 'Broker', status: 'posted',
  ...(direction === 'buy' ? { from_account: 'chk', to_account: acct } : { from_account: acct, to_account: 'chk' }),
  ...extra,
});
const buy = (id, ...rest) => trade(id, 'buy', ...rest);
const sell = (id, ...rest) => trade(id, 'sell', ...rest);

const LEDGER = [
  buy('b1', '2025-02-01', 'brk', 'VWCE', 10, 1000),
  sell('s1', '2025-06-01', 'brk', 'VWCE', 2, 300),
  buy('b2', '2026-03-01', 'brk', 'VWCE', 5, 600),
  sell('s2', '2026-08-01', 'brk', 'VWCE', 4, 380, { fee: 5 }),
  buy('b3', '2025-01-10', 'brk', 'ZZZ', 4, 80),
  sell('s3', '2025-03-10', 'brk', 'ZZZ', 4, 60),
  buy('b4', '2026-04-20', 'brk', 'AAPL', 2, 300),
  sell('s4', '2026-08-15', 'brk', 'XYZ', 1, 50),
  buy('b5', '2026-01-05', 'isk', 'ABC', 10, 200),
  sell('s5', '2026-07-01', 'isk', 'ABC', 5, 150),
  buy('b6', '2026-10-01', 'brk', 'VWCE', 1, 125, { status: 'scheduled' }),
  trade('d1', 'dividend', '2026-06-30', 'brk', 'VWCE', 0, 42.5),
];

function setup({ transactions = LEDGER, currency } = {}) {
  resetState({ transactions: structuredClone(transactions) });
  state.accounts = [
    { id: 'chk', name: 'Checking', type: 'bank', initialBalance: 5000 },
    { id: 'brk', name: 'Broker', type: 'investment', initialBalance: 0 },
    { id: 'isk', name: 'Equity savings', type: 'investment', initialBalance: 0, taxWrapped: true },
  ];
  state.envelopes = [...state.envelopes, { id: 'inv', name: 'Investing', category: 'Saving' }];
  state.budgetItems = [{
    id: 'monthlyBuy', kind: 'investment_transfer', direction: 'buy', description: 'Monthly VWCE', default_amount: -250,
    account_id: 'chk', investment_account_id: 'brk', envelope_id: 'inv', payment_day: 20, schedule_day_type: 'exact',
    include: true, as_schedule: true, as_schedule_since: '2026-09-01', monthly_schedule: ALL_MONTHS,
  }];
  state.meta = {
    schemaVersion: 8,
    ...(currency ? { currency } : {}),
    investments: { prices: {
      VWCE: { price: 120, asOf: '2026-09-14' }, ZZZ: { price: 10, asOf: '2026-09-14' }, ABC: { price: 25, asOf: '2026-09-01' },
    } },
  };
}

// ── The page's old composition (js/pages/investments-tax.js L27-49 and
// js/pages/investments.js L50-53, L83-87, L185-192, L441-451) ─────────────
function oldTax(pickedYear = null) {
  const inv = getInvestmentsMeta(state.meta);
  const exempt = new Set(state.accounts.filter(a => a.pensionInsurance === true || a.taxWrapped === true).map(a => a.id));
  const sales = computeRealizedSales(state.transactions, { manualRows: inv.manualRows, excludeAccountIds: exempt });
  if (!sales.length) return null;
  const newest = Number(sales[sales.length - 1].date.slice(0, 4));
  const allYears = summarizeTaxYear(sales, newest).years;
  const year = pickedYear !== null && allYears.includes(pickedYear) ? pickedYear : newest;
  return { allYears, year, summary: summarizeTaxYear(sales, year) };
}
function oldGap(accountId, { lens, horizon }, showZero = false) {
  const inv = getInvestmentsMeta(state.meta);
  const isZero = (h) => Math.abs(holdingValue(h, inv.prices)) < 0.005 && Math.abs(h.units) < 1e-6;
  const rows = listHoldings(state.transactions, inv.holdingOverrides, inv.manualRows)
    .filter(h => h.accountId === accountId)
    .filter(h => showZero || !isZero(h));
  let value = 0;
  for (const h of rows) value += holdingValue(h, inv.prices);
  const balance = computeAccountBalances(state.accounts, lensTransactions(state, { lens, horizon, today: FIXED_NOW })).get(accountId) || 0;
  return { value, gap: balance - value };
}

const root = () => document.getElementById('app-root');
const norm = (s) => s.replace(/\s/g, '');
const cardWithTitle = (title) => [...root().querySelectorAll('.card')].find(c => c.querySelector('.card-title')?.textContent === title);
const taxCard = () => cardWithTitle(t('investments.tax.title'));
const yearSelect = () => taxCard().querySelector('select');
const button = (text) => [...root().querySelectorAll('button')].find(b => b.textContent === text);
// The session's own query, kept to answer every name a test does not fail.
const realQuery = session.query;
const queried = (name) => session.query.mock.calls.filter(c => c[0] === name).map(c => c[1]);

async function open() {
  mountHosts();
  await render(root());
  await flush();
}
async function pickYear(y) {
  yearSelect().value = String(y);
  yearSelect().dispatchEvent(new Event('change'));
  expect(navigate).toHaveBeenLastCalledWith('investments');
  await open();
}

beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', (cb) => setTimeout(cb, 0));
  stubResizeObserver();
  vi.spyOn(session, 'query');
  setup();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('tax card', () => {
  // The picked year is a module variable: every test starts on the newest,
  // whatever an earlier one (or a failed one) picked.
  beforeEach(() => resetPickedTaxYear());
  afterEach(() => resetPickedTaxYear());

  it('reads investments.tax: no year until one is picked', async () => {
    await open();
    expect(queried('investments.tax')).toEqual([{}]);
  });

  it('the year picker lists every year with a sale, newest first, with the newest picked', async () => {
    await open();
    const old = oldTax();
    const options = [...yearSelect().options];
    expect(options.map(o => o.value)).toEqual(old.allYears.map(String));
    expect(options.map(o => o.value)).toEqual(['2026', '2025']);
    expect(yearSelect().value).toBe('2026');
  });

  it('the totals are the picked year\'s proceeds, deducted cost, gains, losses and net', async () => {
    await open();
    const { summary } = oldTax();
    const stats = [...taxCard().children[1].children].map(w => [w.children[0].textContent, w.children[1].textContent]);
    const money = (v, signed = false) => fmt(v, { signed });
    expect(stats).toEqual([
      [t('investments.tax.proceeds'), money(summary.grossProceeds)],
      [t('investments.tax.deductedCost'), money(summary.deductedCost)],
      [t('investments.tax.gains'), money(summary.gains)],
      [t('investments.tax.losses'), money(summary.losses, true)],
      [t('investments.tax.net'), money(summary.net, true)],
    ]);
    // Not vacuous: 2026 has a loss.
    expect(summary.losses).toBeLessThan(0);
  });

  it('a row per sale of the year, tax-wrapped accounts left out', async () => {
    await open();
    const { summary } = oldTax();
    const rows = [...taxCard().querySelectorAll('tbody tr')];
    expect(rows.map(tr => tr.children[1].children[0].textContent)).toEqual(['VWCE', 'XYZ']);
    expect(rows).toHaveLength(summary.sales.length);
    summary.sales.forEach((s, i) => {
      const td = [...rows[i].children];
      expect(td[0].textContent).toBe(fmtDateLang(s.date));
      expect(td[1].children[1].textContent).toBe('Broker');
      expect(td[2].textContent).toBe(fmtNum(s.units, { maxDecimals: 6 }));
      expect(norm(td[3].textContent)).toBe(norm(fmt(s.grossProceeds)));
      expect(norm(td[4].textContent)).toBe(norm(fmt(s.acquisitionCost + s.fee)));
      expect(td[4].title).toBe(t('investments.tax.costHint')(fmt(s.acquisitionCost), fmt(s.fee)));
      expect(norm(td[5].textContent)).toBe(s.actualGain === null ? '—' : norm(fmt(s.actualGain, { signed: true })));
      expect(norm(td[6].textContent)).toBe(norm(fmt(s.deemedGain, { signed: true })));
      expect(norm(td[7].textContent)).toBe(norm(fmt(s.taxableGain, { signed: true })
        + (s.method === 'deemed' ? t('investments.tax.methodDeemed') : t('investments.tax.methodActual'))));
    });
    // The fee is in the cost cell: VWCE's sale carries one.
    expect(summary.sales[0].fee).toBe(5);
  });

  const notes = () => [...taxCard().children].slice(3).map(p => p.textContent);

  it('notes: gains exempt, losses not deductible and the sales without a cost, in euros', async () => {
    await open();
    const { summary } = oldTax();
    expect(summary.salesWithoutCost).toBe(1);
    expect(notes()).toEqual([
      t('investments.tax.noteExempt'),
      t('investments.tax.noteLossesNotDeductible'),
      t('investments.tax.noteNoCost')(1),
      t('investments.tax.noteRules'),
    ]);
  });

  it('picking a year shows that year and keeps it across renders', async () => {
    await open();
    await pickYear(2025);
    expect(queried('investments.tax').at(-1)).toEqual({ year: 2025 });
    expect(yearSelect().value).toBe('2025');
    const { summary } = oldTax(2025);
    expect(norm(taxCard().children[1].children[0].children[1].textContent)).toBe(norm(fmt(summary.grossProceeds)));
    expect([...taxCard().querySelectorAll('tbody tr')]).toHaveLength(summary.sales.length);
    // 2025: VWCE's gain and ZZZ's loss, both under the thresholds.
    expect(notes()).toEqual([t('investments.tax.noteExempt'), t('investments.tax.noteLossesNotDeductible'), t('investments.tax.noteRules')]);
    await open();
    expect(yearSelect().value).toBe('2025');
  });

  it('in another currency the euro thresholds say nothing', async () => {
    setup({ currency: 'USD' });
    await open();
    expect(notes()).toEqual([t('investments.tax.noteNoCost')(1), t('investments.tax.noteRules')]);
    await pickYear(2025);
    expect(notes()).toEqual([t('investments.tax.noteRules')]);
  });

  it('there is no card without a taxable sale', async () => {
    setup({ transactions: LEDGER.filter(tx => tx.direction !== 'sell' || tx.from_account === 'isk') });
    await open();
    expect(taxCard()).toBeUndefined();
  });

  it('a failed query leaves the card off (warned), the rest of the page stays', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    session.query.mockImplementation((name, input) => (name === 'investments.tax'
      ? { ok: false, error: { code: 'bad_input' } }
      : realQuery.call(session, name, input)));
    await open();
    expect(taxCard()).toBeUndefined();
    expect(cardWithTitle('Broker')).toBeTruthy();
    expect(warn).toHaveBeenCalledWith('[bunvelope] investments.tax query failed:', 'bad_input');
  });
});

describe('holdings and each account\'s gap', () => {
  const gapRow = (name) => {
    const card = cardWithTitle(name);
    const row = card.children[1];
    return row?.tagName === 'DIV' && row.children.length === 2 ? [row.children[0].textContent, row.children[1].textContent] : null;
  };
  const expectedGap = (gap, value) => (Math.abs(gap) < 0.005 ? null
    : [gap > 0 ? t('investments.uninvestedCash')
      : Math.abs(value) < 0.005 ? t('investments.gainsNotInBalance') : t('investments.holdingsExceedBalance'), fmt(Math.abs(gap))]);

  for (const [name, patch, lens] of [
    ['booked', {}, { lens: 'booked' }],
    ['today', { lens: 'today' }, { lens: 'today' }],
    ['forecast 3m', { lens: 'forecast', lensHorizon: '3m' }, { lens: 'forecast', horizon: '3m' }],
    ['forecast 12m', { lens: 'forecast', lensHorizon: '12m' }, { lens: 'forecast', horizon: '12m' }],
  ]) {
    it(`${name} lens: each account card's value and gap equal the old composition`, async () => {
      Object.assign(prefs, patch);
      await open();
      expect(queried('investments.holdings')).toEqual([{ ...lens, includeZero: false }]);
      for (const [id, title] of [['brk', 'Broker'], ['isk', 'Equity savings']]) {
        const old = oldGap(id, lens);
        expect(norm(cardWithTitle(title).firstElementChild.lastElementChild.textContent))
          .toBe(norm(moneyEl(old.value, { size: 'md' }).textContent));
        expect(gapRow(title)).toEqual(expectedGap(old.gap, old.value));
      }
    });
  }

  it('is not vacuous: the lenses move the broker\'s gap', () => {
    const gaps = [{ lens: 'booked' }, { lens: 'today' }, { lens: 'forecast', horizon: '3m' }]
      .map(l => fmt(oldGap('brk', l).gap));
    expect(new Set(gaps).size).toBe(3);
  });

  it('the zero toggle asks for the zero holdings and counts them in the account; the oversold one says so', async () => {
    await open();
    expect(cardWithTitle('Broker').textContent).not.toContain('XYZ');
    button(t('investments.showZero')(2)).click();
    await open();
    expect(queried('investments.holdings').at(-1)).toEqual({ lens: 'booked', includeZero: true });
    const card = cardWithTitle('Broker');
    const old = oldGap('brk', { lens: 'booked' }, true);
    expect(norm(card.firstElementChild.lastElementChild.textContent)).toBe(norm(moneyEl(old.value, { size: 'md' }).textContent));
    expect(gapRow('Broker')).toEqual(expectedGap(old.gap, old.value));
    const xyz = [...card.querySelectorAll('tbody tr')].find(tr => tr.children.length > 1 && tr.children[0].textContent.includes('XYZ'));
    expect(xyz.children[0].textContent).toContain(t('investments.oversoldBadge'));
    button(t('investments.hideZero')).click();
    await open();
    expect(cardWithTitle('Broker').textContent).not.toContain('XYZ');
  });

  it('a failed holdings query leaves the figures off (warned), the tax card stays', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    session.query.mockImplementation((name, input) => (name === 'investments.holdings'
      ? { ok: false, error: { code: 'bad_input' } }
      : realQuery.call(session, name, input)));
    await open();
    expect(cardWithTitle('Broker')).toBeUndefined();
    expect(cardWithTitle(t('investments.allocation'))).toBeUndefined();
    expect(root().querySelector('.page-head-sub').textContent).toBe('');
    expect(taxCard()).toBeTruthy();
    expect(warn).toHaveBeenCalledWith('[bunvelope] investments.holdings query failed:', 'bad_input');
  });
});
