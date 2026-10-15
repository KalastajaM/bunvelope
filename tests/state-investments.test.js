// js/state/investments.js: the readers and the price fetches. The writers it
// had are the investment.* commands now (tests/core-investment-commands.test.js).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  normalisePayeeKey,
  isMappablePayee,
  lookupSymbolForPayee,
  getInvestmentsMeta,
  isISIN,
  listKnownSymbols,
  getManualRows,
  listAllManualRows,
  collectPriceUrls,
  fetchYahooQuote,
  fetchPriceByUrl,
  fetchPrices,
  appendPricePoint,
} from '../js/state/investments.js';

describe('normalisePayeeKey', () => {
  it('trims and lowercases', () => {
    expect(normalisePayeeKey('  Avanza Pro  ')).toBe('avanza pro');
  });
  it('returns empty for nullish', () => {
    expect(normalisePayeeKey(undefined)).toBe('');
    expect(normalisePayeeKey(null)).toBe('');
    expect(normalisePayeeKey('   ')).toBe('');
  });
});

describe('isMappablePayee', () => {
  it('rejects empty / placeholder defaults', () => {
    expect(isMappablePayee('')).toBe(false);
    expect(isMappablePayee('Investment')).toBe(false);
    expect(isMappablePayee('investment sale')).toBe(false);
    expect(isMappablePayee('  INVESTMENT  ')).toBe(false);
  });
  it('accepts real payee strings', () => {
    expect(isMappablePayee('Avanza Pro')).toBe(true);
  });
});

describe('isISIN', () => {
  it('accepts well-formed ISINs', () => {
    expect(isISIN('FI0009000681')).toBe(true);
    expect(isISIN('US0378331005')).toBe(true);
    expect(isISIN(' fi0009000681 ')).toBe(true);
  });
  it('rejects tickers and malformed strings', () => {
    expect(isISIN('AAPL')).toBe(false);
    expect(isISIN('AAPL.US')).toBe(false);
    expect(isISIN('NOKIA.HE')).toBe(false);
    expect(isISIN('')).toBe(false);
    expect(isISIN('FI000900068')).toBe(false); // 11 chars
    expect(isISIN('FI00090006811')).toBe(false); // 13 chars
    expect(isISIN('1I0009000681')).toBe(false); // first char not a letter
    expect(isISIN('FI000900068A')).toBe(false); // last char not a digit
  });
});

describe('getInvestmentsMeta defaults', () => {
  it('returns an empty payeeRules object when meta is empty', () => {
    expect(getInvestmentsMeta(undefined).payeeRules).toEqual({});
    expect(getInvestmentsMeta({}).payeeRules).toEqual({});
  });
});

describe('listKnownSymbols', () => {
  it('returns empty when state is empty', () => {
    expect(listKnownSymbols({})).toEqual([]);
    expect(listKnownSymbols({ transactions: [], meta: {} })).toEqual([]);
  });

  it('unions tx symbols with override keys, uppercased and sorted', () => {
    const state = {
      transactions: [
        { type: 'investment_transfer', symbol: 'aapl.us' },
        { type: 'investment_transfer', symbol: 'NOKIA.HE' },
        { type: 'investment_transfer', symbol: 'aapl.us' }, // duplicate
        { type: 'expense', payee: 'Coffee' }, // no symbol — ignored
      ],
      meta: {
        investments: {
          holdingOverrides: {
            acc1: { 'AAPL.US': { units: 1, costBasis: 100 } },
            acc2: { 'FI0009000681': { units: 5, costBasis: 50 } },
          },
        },
      },
    };
    expect(listKnownSymbols(state)).toEqual(['AAPL.US', 'FI0009000681', 'NOKIA.HE']);
  });

  it('skips blank symbols', () => {
    const state = {
      transactions: [
        { type: 'investment_transfer', symbol: '   ' },
        { type: 'investment_transfer', symbol: '' },
        { type: 'investment_transfer', symbol: 'AAPL.US' },
      ],
    };
    expect(listKnownSymbols(state)).toEqual(['AAPL.US']);
  });
});

describe('manual correction rows', () => {
  const meta = {
    investments: {
      manualRows: {
        acc1: { AAPL: [{ id: 'm1', date: '2026-04-01', direction: 'buy', units: 1, amount: 100 }] },
        acc2: { 'NOKIA.HE': [{ id: 'm2', date: '2026-04-02', direction: 'sell', units: 2, amount: 50 }] },
      },
    },
  };

  it('getManualRows reads one holding\'s rows, matching the symbol ignoring case', () => {
    expect(getManualRows(meta, 'acc1', ' aapl ')).toEqual(meta.investments.manualRows.acc1.AAPL);
    expect(getManualRows(meta, 'acc1', 'NOKIA.HE')).toEqual([]);
    expect(getManualRows(meta, '', 'AAPL')).toEqual([]);
  });

  it('listAllManualRows flattens to {accountId, symbol, …} entries', () => {
    const flat = listAllManualRows(meta);
    expect(flat).toHaveLength(2);
    expect(flat.map(r => r.accountId).sort()).toEqual(['acc1', 'acc2']);
    expect(flat.find(r => r.accountId === 'acc1')).toMatchObject({ id: 'm1', symbol: 'AAPL' });
  });
});

describe('payee rules', () => {
  it('lookupSymbolForPayee is case-insensitive', () => {
    const meta = { investments: { payeeRules: { 'avanza pro': 'AAPL.US' } } };
    expect(lookupSymbolForPayee(meta, 'AVANZA PRO')).toBe('AAPL.US');
    expect(lookupSymbolForPayee(meta, '  avanza pro ')).toBe('AAPL.US');
    expect(lookupSymbolForPayee(meta, 'Other')).toBe('');
    expect(lookupSymbolForPayee(meta, '')).toBe('');
  });
});

describe('collectPriceUrls', () => {
  it('returns a Map of symbol → URL across all accounts, uppercased', () => {
    const meta = {
      investments: {
        holdingOverrides: {
          acc1: { 'AAPL.US': { units: 1, costBasis: 100 } },
          acc2: { 'NOKIA.HE': { units: 1, costBasis: 50, priceUrl: 'https://markets.ft.com/n' } },
          acc3: { 'fund.fi': { units: 1, costBasis: 50, priceUrl: '  https://danskeinvest.fi/x  ' } },
        },
      },
    };
    const out = collectPriceUrls(meta);
    expect(out.get('NOKIA.HE')).toBe('https://markets.ft.com/n');
    expect(out.get('FUND.FI')).toBe('https://danskeinvest.fi/x');
    expect(out.has('AAPL.US')).toBe(false);
    expect(out.size).toBe(2);
  });

  it('returns an empty Map when meta is undefined', () => {
    expect(collectPriceUrls(undefined).size).toBe(0);
  });
});

describe('fetchYahooQuote', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns price/asOf/symbol on a successful server response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ price: 97.35, asOf: '2026-05-01', symbol: 'AGG', currency: 'USD' }),
      { status: 200 },
    )));
    const out = await fetchYahooQuote('US4642872265');
    expect(out).toEqual({ price: 97.35, asOf: '2026-05-01', symbol: 'AGG', fx: null });
  });

  it('sends the budget currency and returns the conversion the server applied', async () => {
    const fakeFetch = vi.fn(async () => new Response(
      JSON.stringify({ price: 135, currency: 'EUR', quoteCurrency: 'USD', quotePrice: 150, fxRate: 0.9, asOf: '2026-05-01', symbol: 'AAPL' }),
      { status: 200 },
    ));
    vi.stubGlobal('fetch', fakeFetch);
    const out = await fetchYahooQuote('AAPL', { base: 'EUR' });
    expect(JSON.parse(fakeFetch.mock.calls[0][1].body)).toEqual({ query: 'AAPL', base: 'EUR' });
    expect(out.price).toBe(135);
    expect(out.fx).toEqual({ currency: 'USD', price: 150, rate: 0.9 });
  });

  it('surfaces the server error code on a non-2xx response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ error: 'no_symbol' }),
      { status: 422 },
    )));
    const out = await fetchYahooQuote('BOGUS');
    expect(out).toEqual({ error: 'no_symbol' });
  });

  it('returns a network-error entry when the endpoint is unreachable (e.g. local mode)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    const out = await fetchYahooQuote('AAPL');
    expect(out.error).toBe('Failed to fetch');
  });

  it('returns an error for an empty query without calling fetch', async () => {
    const fakeFetch = vi.fn();
    vi.stubGlobal('fetch', fakeFetch);
    const out = await fetchYahooQuote('   ');
    expect(out).toEqual({ error: 'Empty query' });
    expect(fakeFetch).not.toHaveBeenCalled();
  });
});

describe('fetchPrices tells an unreachable price service from a missing quote', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('a fetch that throws marks every symbol unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    const out = await fetchPrices(['AAPL', 'FUND'], new Map([['FUND', 'https://example.test/fund']]));
    expect(out.prices).toEqual({});
    expect(out.errors.map(e => [e.symbol, e.unreachable])).toEqual([['FUND', true], ['AAPL', true]]);
  });

  it('the server failing to reach the quote host (502 fetch_failed, 504 timeout) is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      const q = JSON.parse(init.body).query;
      return q === 'A'
        ? new Response(JSON.stringify({ error: 'fetch_failed' }), { status: 502 })
        : new Response(JSON.stringify({ error: 'timeout' }), { status: 504 });
    }));
    const out = await fetchPrices(['A', 'B']);
    expect(out.errors.every(e => e.unreachable === true)).toBe(true);
  });

  it('a 5xx with no body code (a proxy page) is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('Bad gateway', { status: 502 })));
    const out = await fetchPrices(['A']);
    expect(out.errors[0]).toMatchObject({ symbol: 'A', message: 'HTTP 502', unreachable: true });
  });

  it('no quote for the symbol (422 no_symbol / no_close) and a missing FX rate are not', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      const q = JSON.parse(init.body).query;
      if (q === 'A') return new Response(JSON.stringify({ error: 'no_symbol' }), { status: 422 });
      if (q === 'B') return new Response(JSON.stringify({ error: 'no_close' }), { status: 422 });
      return new Response(JSON.stringify({ error: 'fx_unavailable' }), { status: 502 });
    }));
    const out = await fetchPrices(['A', 'B', 'C']);
    expect(out.errors.map(e => e.unreachable)).toEqual([undefined, undefined, undefined]);
  });
});

describe('default price dates use the local calendar day', () => {
  // 00:30 local on 15 June. In any zone east of UTC, toISOString() still
  // says 14 June, which stamped every price fetched after midnight as
  // yesterday's (00:00-03:00 in Helsinki). npm run test:tz covers the zones.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 5, 15, 0, 30));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('fetchYahooQuote when the server sends no asOf', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ price: 5 }), { status: 200 })));
    expect((await fetchYahooQuote('AAPL')).asOf).toBe('2026-06-15');
  });

  it('fetchPriceByUrl when the server sends no asOf', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ price: 5 }), { status: 200 })));
    expect((await fetchPriceByUrl('FUND', 'https://example.test/fund')).asOf).toBe('2026-06-15');
  });
});

describe('price history', () => {
  it('appendPricePoint keeps one point per day, date-ordered', () => {
    let h = appendPricePoint(undefined, '2026-09-02', 11);
    h = appendPricePoint(h, '2026-09-01', 10);
    h = appendPricePoint(h, '2026-09-02', 12);
    expect(h).toEqual([{ date: '2026-09-01', price: 10 }, { date: '2026-09-02', price: 12 }]);
  });

  it('appendPricePoint keeps the newest points once over the cap', () => {
    let h = [];
    for (let i = 0; i < 3665; i++) {
      const d = new Date(Date.UTC(2016, 0, 1 + i)).toISOString().slice(0, 10);
      h.push({ date: d, price: i });
    }
    const out = appendPricePoint(h, '2030-01-01', 1);
    expect(out).toHaveLength(3660);
    expect(out.at(-1)).toEqual({ date: '2030-01-01', price: 1 });
    expect(out[0].price).toBe(6);
  });
});
