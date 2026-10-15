// @vitest-environment jsdom
// Investments page: the holdings and value figures a known set of buys and
// sells must produce, and the page's writes, all dispatched through the real
// browser session (_fakes/pageApp.js): the inline price edit and "refresh
// prices" (investment.setPrice, the refresh as ONE batch), manual correction
// rows, the holding dialog (rename + override + price as ONE batch), and the
// unmapped-transactions card (payee rule and tagged rows in one commit), and
// the value-update dialog (balance.adjust). The session's writeBatch is
// asserted on; saveMeta and data.js's writeBatch must stay
// untouched. Where a flow used to be several writes, a test pins what the
// old writers stored on the same fixture.
//
// Ledger (chk opens at 1000, brk is the investment account, opening 0):
//   1 Aug   buy  VWCE 10 units for 1000
//   15 Aug  buy  VWCE  5 units for  600
//   20 Aug  buy  AAPL  2 units for  300     (no price on record)
//   1 Sep   sell VWCE  3 units for  400
//   VWCE prices at 120.
// Worked out:
//   VWCE: 15 units / 1600 cost, avg 106.67; the sell removes 3 at that
//     average (cost 320), leaving 12 units / 1280 cost, realized 80
//   value of VWCE = 12 * 120 = 1440; AAPL has no price so it counts at cost
//   total cost 1580; market value (priced only) 1440; unrealised 1440-1280 = 160 (12.5%)
//   brk cash balance = 1000 + 600 + 300 - 400 = 1500, against 1740 of
//     holdings at value (1440 + 300): holdings exceed the balance by 240
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../js/app.js', async () => {
  const { appStub } = await import('./_fakes/pageApp.js');
  return { ...appStub, now: vi.fn(appStub.now) };
});
vi.mock('../js/data.js', async (importOriginal) => ({
  ...(await importOriginal()),
  saveMeta: vi.fn(async () => {}),
  writeBatch: vi.fn(async () => {}),
}));

import { now as appNow } from '../js/app.js';
import { saveMeta, writeBatch } from '../js/data.js';
import { render } from '../js/pages/investments.js';
import { t, fmtMonthLang } from '../js/ui/i18n.js';
import { fmt, fmtPct } from '../js/utils.js';
import { describeError } from '../js/core/errors.js';
import {
  state, navigate, updateStatusBar, resetState, mountHosts, flush, setValue,
  sheetIsOpen, topOverlay, toastTexts, dialogOk, session, FIXED_NOW,
  writeBatch as sessionWrite,
} from './_fakes/pageApp.js';
import { stubResizeObserver, resizeCharts } from './_fakes/resizeObserver.js';

const root = () => document.getElementById('app-root');
const page = () => root().querySelector('.page');
const norm = (s) => s.replace(/\s/g, '');
const has = (text, figure) => norm(text).includes(norm(figure));
const cardWithTitle = (title) => [...root().querySelectorAll('.card')].find(c => c.querySelector('.card-title')?.textContent === title);
// The detail row under each holding has a single cell, so "more than one cell" picks the holding row.
const holdingRow = (accountName, symbol) => [...cardWithTitle(accountName).querySelectorAll('tbody tr')]
  .find(tr => tr.children.length > 1 && tr.children[0].textContent.includes(symbol));
const cells = (tr) => [...tr.children].map(td => td.textContent);
const unmappedCard = () => cardWithTitle(t('investments.unmapped.title'));
const unmappedRows = () => [...unmappedCard().querySelectorAll('tbody tr')];
const rowFor = (payee) => unmappedRows().find(tr => tr.children[1].textContent.startsWith(payee));
// What the session committed: its last writeBatch, by file.
const batchFile = (name) => sessionWrite.mock.calls.at(-1)?.[1].find(f => f.filename === name)?.data;
const batchMeta = () => batchFile('budget-meta.json');
const batchTxs = () => batchFile('transactions.json');
// session.dispatch's (name, input), without the options argument.
const dispatched = () => session.dispatch.mock.calls.map(c => c.slice(0, 2));
// A failure is checked by its toasts, not by navigate: a sheet closed in an
// earlier test can still call navigate when its slide-out timer fires.
const saveFailedToast = () => toastTexts().some(m => m.startsWith(t('common.saveFailed')('')));
// What the session stamps: its injected clock, and that clock's local day.
const AT = FIXED_NOW.toISOString();
const TODAY = '2026-09-15';
// A commit validates the whole meta, so the fixture carries a schemaVersion.
const META = { schemaVersion: 8, investments: { prices: { VWCE: { price: 120, asOf: '2026-09-14' } } } };

async function openPage() {
  mountHosts();
  await render(root());
  await flush();
}

const buy = (id, date, symbol, units, amount, extra = {}) => ({
  id, type: 'investment_transfer', direction: 'buy', date, symbol, units, amount,
  from_account: 'chk', to_account: 'brk', payee: 'Vanguard', status: 'posted', ...extra,
});

let ledger;

beforeEach(async () => {
  appNow.mockImplementation(() => new Date(FIXED_NOW));
  vi.stubGlobal('requestAnimationFrame', (cb) => setTimeout(cb, 0));
  stubResizeObserver();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  ledger = [
    buy('b1', '2026-08-01', 'VWCE', 10, 1000),
    buy('b2', '2026-08-15', 'VWCE', 5, 600),
    buy('b3', '2026-08-20', 'AAPL', 2, 300, { payee: 'Broker' }),
    { id: 's1', type: 'investment_transfer', direction: 'sell', date: '2026-09-01', symbol: 'VWCE', units: 3, amount: 400,
      from_account: 'brk', to_account: 'chk', payee: 'Vanguard', status: 'posted' },
  ];
  resetState({ transactions: ledger });
  state.accounts = [
    { id: 'chk', name: 'Checking', type: 'bank', initialBalance: 1000 },
    { id: 'brk', name: 'Broker', type: 'investment', initialBalance: 0 },
  ];
  state.meta = structuredClone(META);
  saveMeta.mockReset();
  saveMeta.mockImplementation(async () => {});
  writeBatch.mockReset();
  writeBatch.mockImplementation(async () => {});
  sessionWrite.mockReset();
  sessionWrite.mockImplementation(async () => {});
  vi.spyOn(session, 'dispatch').mockClear();
  vi.spyOn(session, 'dispatchBatch').mockClear();
  await openPage();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('holdings and value figures', () => {
  it('keeps holdings first and separates contribution history from tax and allocation', async () => {
    const panels = [...root().querySelectorAll('.workspace-panel')];
    const tabs = [...root().querySelectorAll('.content-tabs button')];
    expect(panels.map(p => p.hidden)).toEqual([false,true,true,true,true]);
    tabs.find(b => b.textContent === t('workspace.activity')).click();
    expect(panels.map(p => p.hidden)).toEqual([true,true,false,true,true]);
    expect(panels[2].textContent).toContain(t('workspace.contributionsHint'));
    await openPage();
    expect(root().querySelectorAll('.workspace-panel')[2].hidden).toBe(false);
    [...root().querySelectorAll('.content-tabs button')].find(b => b.textContent === t('workspace.holdings')).click();
  });
  it('the header counts the holdings and shows total cost and market value', () => {
    expect(norm(root().querySelector('.page-head-sub').textContent))
      .toBe(norm(t('investments.subtitle')(2, fmt(1580), fmt(1440))));
  });

  it('the summary card shows value (priced holdings only), cost and unrealised gain', () => {
    const summary = [...root().querySelectorAll('.card')].find(c => c.textContent.includes(t('investments.statUnrealized')));
    expect(has(summary.textContent, fmt(1440))).toBe(true);
    expect(has(summary.textContent, fmt(1580))).toBe(true);
    expect(has(summary.textContent, fmt(160, { signed: true }))).toBe(true);
    expect(has(summary.textContent, fmtPct(12.5, { decimals: 2, signed: true }))).toBe(true);
    // AAPL has no price, and the card says so rather than counting it at cost.
    expect(summary.textContent).toContain(t('investments.missingPrices')(1));
  });

  it('a holding row carries units, average cost, cost, price, value and profit', () => {
    const vwce = cells(holdingRow('Broker', 'VWCE'));
    expect(vwce[1]).toBe('12');
    expect(norm(vwce[2])).toBe(norm(fmt(1280 / 12)));
    expect(norm(vwce[3])).toBe(norm(fmt(1280)));
    expect(norm(vwce[5])).toBe(norm(fmt(1440)));
    expect(norm(vwce[6])).toContain(norm(fmt(160)));
  });

  it('a holding with no price shows a dash for the price and profit, and its cost as value', () => {
    const aapl = cells(holdingRow('Broker', 'AAPL'));
    expect(aapl[1]).toBe('2');
    expect(norm(aapl[3])).toBe(norm(fmt(300)));
    expect(aapl[4]).toContain('—');
    expect(norm(aapl[5])).toBe(norm(fmt(300)));
    expect(aapl[6]).toBe('—');
  });

  it('the account card totals its holdings and flags that they exceed the recorded balance', () => {
    const card = cardWithTitle('Broker');
    expect(has(card.firstElementChild.textContent, fmt(1740))).toBe(true);
    expect(card.textContent).toContain(t('investments.holdingsExceedBalance'));
    expect(has(card.textContent, fmt(240))).toBe(true);
  });

  it('with nothing held after a sale above cost, the gap reads as gains not yet in the balance', async () => {
    // Bought 10 for 1000, sold all 10 for 1200: the cash ledger leaves the
    // balance at −200 with no holdings, so "holdings worth more" would be false.
    state.transactions = [
      buy('b1', '2026-08-01', 'VWCE', 10, 1000),
      { id: 's1', type: 'investment_transfer', direction: 'sell', date: '2026-09-01', symbol: 'VWCE', units: 10, amount: 1200,
        from_account: 'brk', to_account: 'chk', payee: 'Vanguard', status: 'posted' },
    ];
    await openPage();
    const card = cardWithTitle('Broker');
    expect(card.textContent).toContain(t('investments.gainsNotInBalance'));
    expect(card.textContent).toContain(t('investments.gainsNotInBalanceHint'));
    expect(card.textContent).not.toContain(t('investments.holdingsExceedBalance'));
    expect(has(card.textContent, fmt(200))).toBe(true);
  });

  it('holdings above the balance keep the price-gains wording', () => {
    const card = cardWithTitle('Broker');
    expect(card.textContent).toContain(t('investments.holdingsExceedHint'));
    expect(card.textContent).not.toContain(t('investments.gainsNotInBalance'));
  });

  it('the allocation legend splits the priced holdings (only VWCE has a price)', () => {
    resizeCharts();
    const card = cardWithTitle(t('investments.allocation'));
    const labels = [...card.querySelectorAll('.bv-chart-item-label')].map(e => e.textContent);
    expect(labels).toEqual(['VWCE']);
    expect(card.querySelector('.bv-chart-item-value').textContent).toContain(fmtPct(100));
  });

  it('invested over time runs from the first buy to this month, net of sells', () => {
    const card = cardWithTitle(t('investments.investedOverTime'));
    const chart = card.querySelector('.bv-chart--line');
    [...chart.querySelectorAll('.bv-chart-toolbar button')].find(b => b.textContent === t('chart.table')).click();
    const rows = [...chart.querySelectorAll('tbody tr')].map(tr => [...tr.children].map(c => c.textContent));
    // Aug: 1000 + 600 + 300 bought; Sep: 400 sold.
    expect(rows).toEqual([
      [fmtMonthLang('2026-08'), fmt(1900)],
      [fmtMonthLang('2026-09'), fmt(1500)],
    ]);
  });

  it('expanding a holding shows its rows, and the state is kept per holding', () => {
    const row = holdingRow('Broker', 'VWCE');
    const chevron = row.querySelector('button');
    expect(chevron.getAttribute('aria-expanded')).toBe('false');
    chevron.click();
    expect(chevron.getAttribute('aria-expanded')).toBe('true');
    expect(row.nextElementSibling.style.display).toBe('');
    chevron.click();
    expect(row.nextElementSibling.style.display).toBe('none');
  });

  it('with no investment account it says so and offers the accounts page', async () => {
    state.accounts = state.accounts.filter(a => a.type !== 'investment');
    await openPage();
    expect(page().textContent).toContain(t('investments.empty'));
    [...page().querySelectorAll('button')].find(b => b.textContent === t('investments.emptyAction')).click();
    expect(navigate).toHaveBeenCalledWith('accounts');
  });

  it('a fully sold holding is hidden until "show zero" is toggled', async () => {
    state.transactions = [
      ...ledger,
      buy('o1', '2026-07-01', 'OLD', 1, 100),
      { id: 'o2', type: 'investment_transfer', direction: 'sell', date: '2026-07-02', symbol: 'OLD', units: 1, amount: 100, from_account: 'brk', to_account: 'chk', status: 'posted' },
    ];
    await openPage();
    expect(cardWithTitle('Broker').textContent).not.toContain('OLD');
    const zeroBtn = [...page().querySelectorAll('.actions button')].find(b => b.textContent === t('investments.showZero')(1));
    expect(zeroBtn).toBeTruthy();
    zeroBtn.click();
    expect(navigate).toHaveBeenCalledWith('investments');
    await openPage();
    expect(cardWithTitle('Broker').textContent).toContain('OLD');
    // Leave the module-level toggle as it was found.
    [...page().querySelectorAll('.actions button')].find(b => b.textContent === t('investments.hideZero')).click();
  });
});

describe('price edit', () => {
  const priceInput = (symbol) => holdingRow('Broker', symbol).querySelector('input.form-input');

  it.each([0, 23])('dates inline prices on the app clock’s local day at hour %s', async hour => {
    appNow.mockImplementation(() => new Date(2026, 8, 15, hour, 45));
    setValue(priceInput('VWCE'), '130.5', ['change']);
    await flush();
    expect(batchMeta().investments.prices.VWCE.asOf).toBe(TODAY);
  });

  it('typing a new price dispatches investment.setPrice: one meta commit, then the page refreshes', async () => {
    const input = priceInput('VWCE');
    setValue(input, '130.5', ['change']);
    await flush();
    expect(dispatched()).toEqual([['investment.setPrice', { symbol: 'VWCE', price: 130.5, asOf: TODAY }]]);
    expect(sessionWrite).toHaveBeenCalledTimes(1);
    const prices = batchMeta().investments.prices;
    expect(prices.VWCE.price).toBe(130.5);
    expect(prices.VWCE.asOf).toBe(TODAY);
    expect(state.meta.investments.prices.VWCE.price).toBe(130.5);
    expect(saveMeta).not.toHaveBeenCalled();
    expect(toastTexts()).toContain(t('investments.priceSaved'));
    expect(navigate).toHaveBeenCalledWith('investments');
  });

  it('giving a symbol its first price adds it next to the existing ones', async () => {
    setValue(priceInput('AAPL'), '150', ['change']);
    await flush();
    expect(Object.keys(batchMeta().investments.prices).sort()).toEqual(['AAPL', 'VWCE']);
    expect(batchMeta().investments.prices.VWCE).toEqual({ price: 120, asOf: '2026-09-14' });
  });

  it('an unchanged price writes nothing, and a negative one is refused', async () => {
    setValue(priceInput('VWCE'), '120', ['change']);
    await flush();
    expect(session.dispatch).not.toHaveBeenCalled();
    setValue(priceInput('VWCE'), '-5', ['change']);
    await flush();
    expect(session.dispatch).not.toHaveBeenCalled();
    expect(sessionWrite).not.toHaveBeenCalled();
    expect(toastTexts()).toContain(t('investments.dialog.invalidNumbers'));
  });

  it('a budget switched under the write says nothing, as the old writer was silent', async () => {
    vi.spyOn(session, 'dispatch').mockResolvedValueOnce({ ok: false, error: { code: 'budget_switched', params: {} } });
    setValue(priceInput('VWCE'), '130.5', ['change']);
    await flush();
    expect(sessionWrite).not.toHaveBeenCalled();
    expect(toastTexts()).toEqual([]);
  });

  it('a failed write keeps the old price, reverts the input and says so', async () => {
    sessionWrite.mockImplementation(async () => { throw new Error('disk full'); });
    const input = priceInput('VWCE');
    setValue(input, '130.5', ['change']);
    await flush();
    expect(state.meta.investments.prices.VWCE).toEqual({ price: 120, asOf: '2026-09-14' });
    expect(input.value).toBe('120');
    expect(saveFailedToast()).toBe(true);
    expect(toastTexts()).not.toContain(t('investments.priceSaved'));
  });
});

describe('refresh prices', () => {
  const refreshBtn = () => [...page().querySelectorAll('.actions button')].find(b => b.textContent === t('investments.refreshPrices'));
  // The quote endpoint, per symbol. AAPL comes back in dollars, converted,
  // and with a date that is no calendar day (30 February).
  const QUOTES = {
    VWCE: { price: 125, asOf: '2026-09-14', symbol: 'VWCE' },
    AAPL: { price: 160, asOf: '2026-02-30', symbol: 'AAPL', quoteCurrency: 'USD', quotePrice: 175, fxRate: 0.914 },
  };
  const AAPL_FX = { currency: 'USD', price: 175, rate: 0.914 };
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      const body = QUOTES[JSON.parse(init.body).query];
      return { ok: true, status: 200, json: async () => body };
    }));
  });

  it('stores every fetched price in ONE batch of investment.setPrice; a date that is no calendar day becomes today', async () => {
    refreshBtn().click();
    await flush();
    expect(session.dispatchBatch).toHaveBeenCalledTimes(1);
    expect(session.dispatch).not.toHaveBeenCalled();
    const steps = session.dispatchBatch.mock.calls[0][0];
    expect([...steps].sort((a, b) => a.input.symbol.localeCompare(b.input.symbol))).toEqual([
      { name: 'investment.setPrice', input: { symbol: 'AAPL', price: 160, fx: AAPL_FX } },
      { name: 'investment.setPrice', input: { symbol: 'VWCE', price: 125, asOf: '2026-09-14' } },
    ]);
    expect(sessionWrite).toHaveBeenCalledTimes(1);
    const inv = batchMeta().investments;
    expect(inv.prices).toEqual({
      VWCE: { price: 125, asOf: '2026-09-14' },
      AAPL: { price: 160, asOf: TODAY, fx: AAPL_FX },
    });
    // What the old one-write-per-symbol loop stored, given the same dates:
    // all five parts, and a history point per price.
    expect(inv).toEqual({
      prices: inv.prices, holdingOverrides: {}, payeeRules: {}, manualRows: {},
      priceHistory: { VWCE: [{ date: '2026-09-14', price: 125 }], AAPL: [{ date: TODAY, price: 160 }] },
    });
    expect(saveMeta).not.toHaveBeenCalled();
    expect(toastTexts()).toContain(t('investments.refreshOk')(2));
    expect(navigate).toHaveBeenCalledWith('investments');
  });

  it('a failed write stores none of the prices and says so', async () => {
    sessionWrite.mockImplementation(async () => { throw new Error('disk full'); });
    refreshBtn().click();
    await flush();
    expect(state.meta.investments).toEqual(META.investments);
    expect(saveFailedToast()).toBe(true);
    expect(toastTexts()).not.toContain(t('investments.refreshOk')(2));
    expect(refreshBtn().disabled).toBe(false);
  });

  it('with the price service unreachable it says so, and blames no symbol', async () => {
    fetch.mockImplementation(async () => { throw new TypeError('Failed to fetch'); });
    refreshBtn().click();
    await flush();
    expect(toastTexts()).toContain(t('investments.refreshUnreachable'));
    expect(toastTexts().some(m => m.startsWith(t('investments.refreshNone')))).toBe(false);
    expect(session.dispatchBatch).not.toHaveBeenCalled();
  });

  it('a symbol with no quote is still named, and unreachable ones are counted apart', async () => {
    fetch.mockImplementation(async (_url, init) => (JSON.parse(init.body).query === 'VWCE'
      ? { ok: false, status: 422, json: async () => ({ error: 'no_symbol' }) }
      : { ok: false, status: 502, json: async () => ({ error: 'fetch_failed' }) }));
    refreshBtn().click();
    await flush();
    const msg = t('investments.refreshNone')
      + ` · ${t('investments.refreshFailedSome')(1, 'VWCE', 0)}`
      + ` · ${t('investments.refreshUnreachableSome')(1)}`;
    expect(toastTexts()).toContain(msg);
  });

  it('a failed holdings query says the refresh failed and why, not that there are no symbols', async () => {
    const real = session.query.bind(session);
    const q = vi.spyOn(session, 'query').mockImplementation((name, input) => (name === 'investments.holdings'
      ? { ok: false, error: { code: 'bad_input', params: { errors: [] } } }
      : real(name, input)));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      refreshBtn().click();
      await flush();
      const failure = { code: 'bad_input', params: { errors: [] } };
      expect(toastTexts()).toContain(`${t('investments.refreshFailed')}: ${describeError(failure, t)}`);
      expect(toastTexts()).not.toContain(t('investments.noSymbols'));
      expect(fetch).not.toHaveBeenCalled();
      expect(session.dispatchBatch).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      q.mockRestore();
    }
  });
});

describe('manual correction rows', () => {
  const MANUAL = { id: 'm1', date: '2026-09-02', direction: 'buy', units: 1, amount: 100 };
  const detail = (symbol) => {
    const row = holdingRow('Broker', symbol);
    if (row.nextElementSibling.style.display === 'none') row.querySelector('button').click();
    return row.nextElementSibling;
  };
  const submitForm = async (form) => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await flush();
  };
  const detailButton = (el, label) => [...el.querySelectorAll('button')].find(b => b.textContent === label);

  it('adding a correction dispatches investment.addManualRow', async () => {
    const form = detail('VWCE').querySelector('form');
    const [date, units, cash] = form.querySelectorAll('input');
    expect(date.value).toBe(TODAY);
    setValue(date, '2026-09-10');
    setValue(units, '2');
    setValue(cash, '50');
    await submitForm(form);
    expect(dispatched()).toEqual([['investment.addManualRow', {
      account: 'brk', symbol: 'VWCE', row: { date: '2026-09-10', direction: 'buy', units: 2, amount: 50, note: '' },
    }]]);
    expect(sessionWrite).toHaveBeenCalledTimes(1);
    expect(batchMeta().investments.manualRows.brk.VWCE).toEqual([
      { id: expect.stringMatching(/^m-/), date: '2026-09-10', direction: 'buy', units: 2, amount: 50 },
    ]);
    expect(toastTexts()).toContain(t('investments.detail.added'));
    expect(navigate).toHaveBeenCalledWith('investments');
  });

  describe('an existing row', () => {
    beforeEach(async () => {
      state.meta = { ...META, investments: { ...META.investments, manualRows: { brk: { VWCE: [MANUAL] } } } };
      await openPage();
    });

    it('Edit then save dispatches investment.updateManualRow', async () => {
      const el = detail('VWCE');
      detailButton(el, t('investments.detail.edit')).click();
      const form = el.querySelector('form');
      setValue(form.querySelectorAll('input')[1], '3');
      await submitForm(form);
      expect(dispatched()).toEqual([['investment.updateManualRow', {
        account: 'brk', symbol: 'VWCE', id: 'm1', row: { date: '2026-09-02', direction: 'buy', units: 3, amount: 100, note: '' },
      }]]);
      expect(batchMeta().investments.manualRows.brk.VWCE).toEqual([{ ...MANUAL, units: 3 }]);
      expect(toastTexts()).toContain(t('investments.detail.updated'));
    });

    it('Remove dispatches investment.removeManualRow, pruning the emptied keys', async () => {
      detailButton(detail('VWCE'), t('investments.detail.remove')).click();
      await flush();
      expect(dispatched()).toEqual([['investment.removeManualRow', { account: 'brk', symbol: 'VWCE', id: 'm1' }]]);
      expect(batchMeta().investments.manualRows).toEqual({});
      expect(toastTexts()).toContain(t('investments.detail.removed'));
    });

    it('a failed remove keeps the row and says so', async () => {
      sessionWrite.mockImplementation(async () => { throw new Error('disk full'); });
      detailButton(detail('VWCE'), t('investments.detail.remove')).click();
      await flush();
      expect(state.meta.investments.manualRows.brk.VWCE).toEqual([MANUAL]);
      expect(saveFailedToast()).toBe(true);
      expect(toastTexts()).not.toContain(t('investments.detail.removed'));
    });
  });
});

describe('holding dialog', () => {
  const sheet = () => topOverlay().querySelector('.sheet');
  const dlgInput = (label) => [...sheet().querySelectorAll('.field')]
    .find(f => f.querySelector('label')?.textContent === label).querySelector('input');
  const dlgButton = (label) => [...sheet().querySelectorAll('button')].find(b => b.textContent === label);
  const openEdit = async (symbol) => {
    holdingRow('Broker', symbol).querySelector(`button[aria-label="${t('investments.edit')}"]`).click();
    await flush();
  };
  it('saves an inherited item without a purchase cost and hides the warning and gains', async () => {
    [...page().querySelectorAll('button')].find(b => b.textContent === t('investments.addHolding')).click();
    await flush();
    setValue(dlgInput(t('investments.dialog.symbol')), 'NECKLACE');
    setValue(dlgInput(t('investments.dialog.units')), '10');
    setValue(dlgInput(t('investments.dialog.price')), '20');
    const mode = sheet().querySelector('select[aria-label="' + t('investments.dialog.costTracking') + '"]');
    setValue(mode, 'value');
    expect(dlgInput(t('investments.dialog.costBasis')).disabled).toBe(true);
    dlgButton(t('investments.dialog.save')).click();
    await flush();
    expect(batchMeta().investments.holdingOverrides.brk.NECKLACE)
      .toEqual({ units: 10, costBasis: 0, valuationOnly: true });
    await openPage();
    const row = holdingRow('Broker', 'NECKLACE');
    expect(cells(row)[3]).toBe(t('investments.dialog.costNotTracked'));
    expect(has(cells(row)[5], fmt(200))).toBe(true);
    expect(cells(row)[6]).toBe('—');
    expect(page().textContent).not.toContain('NECKLACE · Broker · ' + t('workspace.zeroBasis'));
    await openEdit('NECKLACE');
    expect(sheet().querySelector('select[aria-label="' + t('investments.dialog.costTracking') + '"]').value).toBe('value');
  });

  const renameVwce = async () => {
    await openEdit('VWCE');
    setValue(dlgInput(t('investments.dialog.symbol')), 'vwce.de');
    setValue(dlgInput(t('investments.dialog.units')), '12');
    setValue(dlgInput(t('investments.dialog.costBasis')), '1280');
    dlgButton(t('investments.dialog.save')).click();
    await flush();
    expect(topOverlay().textContent).toContain(t('investments.dialog.renameConfirm')('VWCE', 'VWCE.DE'));
    dialogOk().click();
    await flush();
  };

  it.each([0, 23])('uses the local date for a holding’s default and cleared date at hour %s', async hour => {
    appNow.mockImplementation(() => new Date(2026, 8, 15, hour, 45));
    await openEdit('AAPL');
    const date = dlgInput(t('investments.dialog.asOf'));
    expect(date.value).toBe(TODAY);
    setValue(date, '');
    setValue(dlgInput(t('investments.dialog.price')), '50');
    dlgButton(t('investments.dialog.save')).click();
    await flush();
    expect(batchMeta().investments.prices.AAPL.asOf).toBe(TODAY);
  });

  it('a rename, the override and the price are ONE batch: one commit of rows and meta', async () => {
    await renameVwce();
    expect(session.dispatchBatch).toHaveBeenCalledTimes(1);
    expect(session.dispatchBatch.mock.calls[0][0]).toEqual([
      { name: 'investment.renameSymbol', input: { from: 'VWCE', to: 'VWCE.DE' } },
      { name: 'investment.setHolding', input: { account: 'brk', symbol: 'VWCE.DE', units: 12, costBasis: 1280, name: '', priceUrl: '' } },
      { name: 'investment.setPrice', input: { symbol: 'VWCE.DE', price: 120, asOf: '2026-09-14' } },
    ]);
    expect(sessionWrite).toHaveBeenCalledTimes(1);
    expect(sessionWrite.mock.calls[0][1].map(f => f.filename).sort()).toEqual(['budget-meta.json', 'transactions.json']);
    expect(saveMeta).not.toHaveBeenCalled();

    // What the three writes the dialog used to make left, one after another:
    // the price (and its history) moved to the new symbol, the override and
    // the price set on it, and the rows renamed without a modified_at stamp.
    expect(batchMeta().investments).toEqual({
      prices: { 'VWCE.DE': { price: 120, asOf: '2026-09-14' } },
      priceHistory: { 'VWCE.DE': [{ date: '2026-09-14', price: 120 }] },
      holdingOverrides: { brk: { 'VWCE.DE': { units: 12, costBasis: 1280 } } },
      payeeRules: {}, manualRows: {},
    });
    expect(batchTxs()).toEqual(ledger.map(x => (x.symbol === 'VWCE' ? { ...x, symbol: 'VWCE.DE' } : x)));
    expect(state.transactions.filter(x => x.symbol === 'VWCE.DE').map(x => x.id)).toEqual(['b1', 'b2', 's1']);

    expect(toastTexts()).toContain(t('investments.dialog.saved'));
    expect(sheetIsOpen()).toBe(false);
    expect(navigate).toHaveBeenCalledWith('investments');
  });

  it('a failed write leaves nothing half-written: no rename, no override, no price; the sheet stays', async () => {
    sessionWrite.mockImplementation(async () => { throw new Error('disk full'); });
    await renameVwce();
    expect(sessionWrite).toHaveBeenCalledTimes(1);
    expect(state.transactions).toBe(ledger);
    expect(state.meta.investments).toEqual(META.investments);
    expect(saveFailedToast()).toBe(true);
    expect(sheetIsOpen()).toBe(true);
    expect(toastTexts()).not.toContain(t('investments.dialog.saved'));
  });

  it('declining the rename writes nothing', async () => {
    await openEdit('VWCE');
    setValue(dlgInput(t('investments.dialog.symbol')), 'vwce.de');
    dlgButton(t('investments.dialog.save')).click();
    await flush();
    topOverlay().querySelector('.btn:not(.btn-accent)').click();
    await flush();
    expect(session.dispatchBatch).not.toHaveBeenCalled();
    expect(sessionWrite).not.toHaveBeenCalled();
  });

  it('Clear override dispatches investment.removeHolding', async () => {
    // An override with no rows behind it: the holding is the override.
    state.meta = { ...META, investments: { ...META.investments, holdingOverrides: { brk: { FUND: { units: 3, costBasis: 30 } } } } };
    await openPage();
    await openEdit('FUND');
    dlgButton(t('investments.dialog.clearOverride')).click();
    await flush();
    dialogOk().click();
    await flush();
    expect(dispatched()).toEqual([['investment.removeHolding', { account: 'brk', symbol: 'FUND' }]]);
    expect(batchMeta().investments.holdingOverrides).toEqual({});
    expect(toastTexts()).toContain(t('investments.dialog.cleared'));
  });
});

describe('value-update dialog', () => {
  const openDialog = async () => {
    [...cardWithTitle('Broker').querySelectorAll('button')].find(b => b.textContent === t('investments.updateValue')).click();
    await flush();
  };
  const sheet = () => topOverlay().querySelector('.sheet');
  const saveBtn = () => [...sheet().querySelectorAll('button')].find(b => b.textContent === t('addTx.save'));

  it('opens prefilled with the holdings value and posts the difference through one balance.adjust', async () => {
    await openDialog();
    const newValue = sheet().querySelector('#invval-new');
    expect(newValue.value).toBe('1740.00');
    const date = sheet().querySelector('#invval-date').value;
    saveBtn().click();
    await flush();

    // The delta is against the balance the dialog shows (the active lens).
    expect(dispatched()).toEqual([['balance.adjust', {
      account: 'brk', amount: 240, note: t('investmentValue.defaultNote'), date,
    }]]);
    expect(writeBatch).not.toHaveBeenCalled();
    expect(sessionWrite).toHaveBeenCalledTimes(1);
    const txs = batchTxs();
    expect(txs).toHaveLength(ledger.length + 1);
    expect(txs.slice(0, ledger.length)).toEqual(ledger);
    // balance.adjust's row: payee 'Adjustment' and cleared, like every other adjustment.
    expect(txs.at(-1)).toEqual({
      id: expect.any(String), type: 'adjustment', date, payee: 'Adjustment', amount: 240,
      target: 'account', target_id: 'brk', note: t('investmentValue.defaultNote'),
      cleared: true, status: 'posted', created_at: AT, modified_at: AT,
    });
    expect(state.transactions).toBe(txs);
    expect(updateStatusBar).toHaveBeenCalled();
    expect(toastTexts()).toContain(t('investmentValue.toastSaved'));
    expect(sheetIsOpen()).toBe(false);
  });

  it('the row reaches state only once the write has landed', async () => {
    let release;
    sessionWrite.mockImplementationOnce(() => new Promise(res => { release = res; }));
    await openDialog();
    const save = saveBtn();
    save.click();
    await flush();
    expect(sessionWrite).toHaveBeenCalledTimes(1);
    expect(state.transactions).toBe(ledger);
    // Busy while the write is pending, so a second click cannot post twice.
    expect(save.disabled).toBe(true);
    save.click();
    release();
    await flush();
    expect(session.dispatch).toHaveBeenCalledTimes(1);
    expect(state.transactions).toHaveLength(ledger.length + 1);
    expect(toastTexts()).toContain(t('investmentValue.toastSaved'));
  });

  it('a value below the tracked balance posts a negative adjustment with the typed note', async () => {
    await openDialog();
    setValue(sheet().querySelector('#invval-new'), '1400', ['input']);
    setValue(sheet().querySelector('#invval-note'), 'Statement 30 Sep', ['input']);
    saveBtn().click();
    await flush();
    expect(dispatched()[0][1]).toMatchObject({ account: 'brk', amount: -100, note: 'Statement 30 Sep' });
    expect(batchTxs().at(-1)).toMatchObject({ target_id: 'brk', amount: -100, note: 'Statement 30 Sep' });
  });

  it('a value equal to the tracked balance cannot be saved', async () => {
    await openDialog();
    setValue(sheet().querySelector('#invval-new'), '1500', ['input']);
    expect(saveBtn().disabled).toBe(true);
    saveBtn().click();
    await flush();
    expect(session.dispatch).not.toHaveBeenCalled();
    expect(sessionWrite).not.toHaveBeenCalled();
  });

  it('a refused write leaves the ledger untouched and reports it in an alert', async () => {
    sessionWrite.mockImplementation(async () => { throw new Error('disk full'); });
    await openDialog();
    saveBtn().click();
    await flush();
    expect(state.transactions).toBe(ledger);
    // Titled reconcile.saveFailed, with the refusal described as the text.
    expect(topOverlay().textContent).toContain(t('reconcile.saveFailed'));
    expect(topOverlay().textContent).toContain(describeError({ code: 'write_failed', params: { message: 'disk full' } }, t));
    expect(toastTexts()).not.toContain(t('investmentValue.toastSaved'));
    // The alert stacks over the dialog, which stays open for another try.
    expect(document.querySelector('#invval-new')).not.toBeNull();
  });

  it('a version conflict shows the reload dialog, not the alert', async () => {
    sessionWrite.mockImplementation(async () => { throw Object.assign(new Error('conflict'), { status: 409 }); });
    await openDialog();
    saveBtn().click();
    await flush();
    expect(state.transactions).toBe(ledger);
    expect(topOverlay().textContent).toContain(t('saveError.versionConflictTitle'));
    expect(topOverlay().textContent).not.toContain('conflict:');
  });

  it('a budget switch says nothing', async () => {
    vi.spyOn(session, 'dispatch').mockResolvedValueOnce({ ok: false, error: { code: 'budget_switched', params: {} } });
    await openDialog();
    saveBtn().click();
    await flush();
    expect(topOverlay().textContent).not.toContain(t('reconcile.saveFailed'));
    expect(toastTexts()).toEqual([]);
    // Nothing was written or published, and the dialog stays open.
    expect(sessionWrite).not.toHaveBeenCalled();
    expect(state.transactions).toBe(ledger);
    expect(document.querySelector('#invval-new')).not.toBeNull();
  });

  it('a dispatch that throws says so in the alert, titled reconcile.saveFailed, and keeps the dialog', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(session, 'dispatch').mockRejectedValueOnce(new Error('boom'));
    await openDialog();
    saveBtn().click();
    await flush();
    expect(topOverlay().textContent).toContain(`${t('reconcile.saveFailed')}: boom`);
    expect(console.error).toHaveBeenCalledWith(expect.objectContaining({ message: 'boom' }));
    expect(state.transactions).toBe(ledger);
    expect(toastTexts()).not.toContain(t('investmentValue.toastSaved'));
    expect(document.querySelector('#invval-new')).not.toBeNull();
  });
});

describe('unmapped transactions', () => {
  const byId = (txs, id) => txs.find(x => x.id === id);
  const old = (id) => byId(ledger, id);
  const bulkSelectAll = () => {
    const all = unmappedCard().querySelector('thead input[type="checkbox"]');
    all.checked = true;
    all.dispatchEvent(new Event('change', { bubbles: true }));
  };

  beforeEach(async () => {
    ledger = [
      ...ledger,
      buy('u1', '2026-09-05', undefined, 0, 200, { payee: 'Nordnet', symbol: undefined }),
      buy('u2', '2026-09-08', undefined, 0, 100, { payee: 'Nordnet', symbol: undefined }),
      buy('u3', '2026-09-09', undefined, 0, 50, { payee: 'Investment', symbol: undefined }),
    ];
    state.transactions = ledger;
    await openPage();
  });

  it('groups the untagged rows by payee, biggest group first, with count, dates and cash', () => {
    const rows = unmappedRows();
    expect(rows).toHaveLength(2);
    const nordnet = cells(rows[0]);
    expect(nordnet[1]).toContain('Nordnet');
    expect(nordnet[2]).toBe('2');
    expect(nordnet[3]).toBe('2026-09-05 – 2026-09-08');
    expect(norm(nordnet[4])).toBe(norm(fmt(300)));
    // A placeholder payee is grouped as "no payee" and has no per-row Apply.
    expect(cells(rows[1])[1]).toContain(t('investments.unmapped.noPayee'));
    expect(rows[1].querySelector('.btn-accent')).toBeNull();
  });

  it('there is no unmapped card when every row has a symbol', async () => {
    state.transactions = ledger.slice(0, 4);
    await openPage();
    expect(unmappedCard()).toBeUndefined();
  });

  it('Apply dispatches investment.setPayeeRule with the payee\'s rows: rule and tags in one commit', async () => {
    const row = rowFor('Nordnet');
    setValue(row.querySelector('input[type="text"]'), 'xyz', ['input']);
    row.querySelector('.btn-accent').click();
    await flush();

    expect(dispatched()).toEqual([['investment.setPayeeRule', { payee: 'Nordnet', symbol: 'XYZ', applyTo: ['u1', 'u2'] }]]);
    expect(sessionWrite).toHaveBeenCalledTimes(1);
    expect(batchMeta().investments.payeeRules).toEqual({ nordnet: 'XYZ' });
    // The rows the page used to write itself: symbol and modified_at, nothing else.
    const next = batchTxs();
    expect(byId(next, 'u1')).toEqual({ ...old('u1'), symbol: 'XYZ', modified_at: AT });
    expect(byId(next, 'u2')).toEqual({ ...old('u2'), symbol: 'XYZ', modified_at: AT });
    expect(byId(next, 'u3')).toEqual(old('u3'));
    expect(byId(next, 'b1')).toEqual(old('b1'));
    expect(saveMeta).not.toHaveBeenCalled();
    expect(toastTexts()).toContain(t('investments.unmapped.applied')(2));
    expect(navigate).toHaveBeenCalledWith('investments');
  });

  it('Apply without a symbol only says so', async () => {
    rowFor('Nordnet').querySelector('.btn-accent').click();
    await flush();
    expect(session.dispatch).not.toHaveBeenCalled();
    expect(sessionWrite).not.toHaveBeenCalled();
    expect(toastTexts()).toContain(t('investments.dialog.symbolRequired'));
  });

  it('a failed write keeps neither the rule nor the tags', async () => {
    sessionWrite.mockImplementation(async () => { throw new Error('disk full'); });
    const row = rowFor('Nordnet');
    setValue(row.querySelector('input[type="text"]'), 'xyz', ['input']);
    row.querySelector('.btn-accent').click();
    await flush();
    expect(state.transactions).toBe(ledger);
    expect(state.meta.investments).toEqual(META.investments);
    expect(saveFailedToast()).toBe(true);
    expect(toastTexts()).not.toContain(t('investments.unmapped.applied')(2));
  });

  it('ticking rows reveals the bulk bar; bulk apply is ONE batch: a rule per payee, a symbol-only tag for the no-payee rows', async () => {
    const bar = () => unmappedCard().lastElementChild;
    expect(bar().style.display).toBe('none');
    bulkSelectAll();
    expect(bar().style.display).toBe('flex');
    expect(bar().textContent).toContain(t('investments.unmapped.bulkSelected')(2));

    setValue(bar().querySelector('input'), 'fund', ['input']);
    [...bar().querySelectorAll('button')].find(b => b.textContent === t('investments.unmapped.bulkApply')(2)).click();
    await flush();

    expect(session.dispatchBatch).toHaveBeenCalledTimes(1);
    expect(session.dispatchBatch.mock.calls[0][0]).toEqual([
      { name: 'investment.setPayeeRule', input: { payee: 'Nordnet', symbol: 'FUND', applyTo: ['u1', 'u2'] } },
      // A placeholder payee has no rule key: its rows only take the symbol.
      { name: 'investment.tagSymbol', input: { ids: ['u3'], symbol: 'FUND' } },
    ]);
    expect(sessionWrite).toHaveBeenCalledTimes(1);
    const next = batchTxs();
    expect(next.filter(x => x.symbol === 'FUND').map(x => x.id).sort()).toEqual(['u1', 'u2', 'u3']);
    expect(byId(next, 'u1')).toEqual({ ...old('u1'), symbol: 'FUND', modified_at: AT });
    // Every tagged row is the page's old {...row, symbol, modified_at}.
    expect(byId(next, 'u2')).toEqual({ ...old('u2'), symbol: 'FUND', modified_at: AT });
    expect(byId(next, 'u3')).toEqual({ ...old('u3'), symbol: 'FUND', modified_at: AT });
    // What the old per-bucket rule writes stored.
    expect(batchMeta().investments).toEqual({ ...META.investments, holdingOverrides: {}, payeeRules: { nordnet: 'FUND' }, manualRows: {}, priceHistory: {} });
    expect(saveMeta).not.toHaveBeenCalled();
    expect(toastTexts()).toContain(t('investments.unmapped.bulkApplied')(2, 3));
  });

  it('a legacy row the engine accepts (a sell without units) is tagged as it is and does not fail the bulk apply', async () => {
    ledger = ledger.map(x => (x.id === 'u3' ? { ...x, direction: 'sell' } : x));
    state.transactions = ledger;
    await openPage();
    bulkSelectAll();
    const bar = unmappedCard().lastElementChild;
    setValue(bar.querySelector('input'), 'fund', ['input']);
    [...bar.querySelectorAll('button')].find(b => b.textContent === t('investments.unmapped.bulkApply')(2)).click();
    await flush();
    expect(sessionWrite).toHaveBeenCalledTimes(1);
    expect(byId(batchTxs(), 'u3')).toEqual({ ...old('u3'), symbol: 'FUND', modified_at: AT });
    expect(batchMeta().investments.payeeRules).toEqual({ nordnet: 'FUND' });
    expect(saveFailedToast()).toBe(false);
    expect(toastTexts()).toContain(t('investments.unmapped.bulkApplied')(2, 3));
  });

  it('clearing the selection hides the bulk bar again', () => {
    bulkSelectAll();
    const all = unmappedCard().querySelector('thead input[type="checkbox"]');
    const bar = unmappedCard().lastElementChild;
    [...bar.querySelectorAll('button')].find(b => b.textContent === t('investments.unmapped.clearSelection')).click();
    expect(bar.style.display).toBe('none');
    expect(all.checked).toBe(false);
  });

  it('"map all existing" is ONE batch: a symbol-only tag of the rows whose payee has a rule, and nothing else', async () => {
    state.meta = { ...state.meta, investments: { ...state.meta.investments, payeeRules: { nordnet: 'NDA' } } };
    await openPage();
    [...unmappedCard().querySelectorAll('button')].find(b => b.textContent === t('investments.unmapped.mapAllExisting')).click();
    await flush();
    expect(session.dispatchBatch).toHaveBeenCalledTimes(1);
    expect(session.dispatchBatch.mock.calls[0][0]).toEqual([
      { name: 'investment.tagSymbol', input: { ids: ['u1', 'u2'], symbol: 'NDA' } },
    ]);
    expect(sessionWrite).toHaveBeenCalledTimes(1);
    expect(batchTxs().filter(x => x.symbol === 'NDA').map(x => x.id)).toEqual(['u1', 'u2']);
    expect(byId(batchTxs(), 'u1')).toEqual({ ...old('u1'), symbol: 'NDA', modified_at: AT });
    expect(byId(batchTxs(), 'u3').symbol).toBeUndefined();
    expect(state.meta.investments.payeeRules).toEqual({ nordnet: 'NDA' });
    expect(saveMeta).not.toHaveBeenCalled();
    expect(toastTexts()).toContain(t('investments.unmapped.mapAllExistingApplied')(2));
  });

  it('"map all existing" with no matching rule says so and writes nothing', async () => {
    [...unmappedCard().querySelectorAll('button')].find(b => b.textContent === t('investments.unmapped.mapAllExisting')).click();
    await flush();
    expect(session.dispatchBatch).not.toHaveBeenCalled();
    expect(sessionWrite).not.toHaveBeenCalled();
    expect(toastTexts()).toContain(t('investments.unmapped.mapAllExistingNone'));
  });
});
