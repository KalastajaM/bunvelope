import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  normalisePriceString, parseFt, parseDanske, buildDebugInfo, collectKeywordHits,
  fetchTextLimited, extractYahooSymbol, extractYahooQuote, resolveYahooSymbol,
  normalizeQuoteCurrency, convertQuoteToBase, fetchFxRate, parseBaseCurrency, _resetFxCache,
} from '../server/routes/prices.js';

describe('normalisePriceString', () => {
  it('parses English-formatted numbers', () => {
    expect(normalisePriceString('1,234.56')).toBeCloseTo(1234.56, 2);
    expect(normalisePriceString('  42.5 ')).toBeCloseTo(42.5, 2);
    expect(normalisePriceString('1234567')).toBe(1234567);
  });

  it('parses Finnish-formatted numbers (comma decimal, space thousands)', () => {
    expect(normalisePriceString('7,5489')).toBeCloseTo(7.5489, 4);
    expect(normalisePriceString('1 234,56')).toBeCloseTo(1234.56, 2);
    expect(normalisePriceString('12,3')).toBeCloseTo(12.3, 2);
  });

  it('handles mixed thousands+decimal formats', () => {
    expect(normalisePriceString('1.234,56')).toBeCloseTo(1234.56, 2);
    expect(normalisePriceString('1,234.567')).toBeCloseTo(1234.567, 3);
  });

  it('returns NaN for non-numeric', () => {
    expect(Number.isNaN(normalisePriceString(''))).toBe(true);
    expect(Number.isNaN(normalisePriceString('abc'))).toBe(true);
    expect(Number.isNaN(normalisePriceString(null))).toBe(true);
  });
});

describe('parseFt adapter', () => {
  it('extracts price from the tearsheet overview block', () => {
    const html = `
      <html><body>
        <div class="mod-tearsheet-overview__quote__price">
          <span class="mod-ui-data-list__value">123.45</span>
        </div>
        <span class="mod-ui-data-list__label">Price (EUR)</span>
      </body></html>`;
    const out = parseFt(html);
    expect(out).not.toBeNull();
    expect(out.price).toBeCloseTo(123.45, 2);
    expect(out.currency).toBe('EUR');
  });

  it('extracts price from the modern label/value pair layout', () => {
    const html = `
      <ul class="mod-ui-data-list mod-ui-data-list--vertical">
        <li class="mod-ui-data-list__item">
          <span class="mod-ui-data-list__label">Price (EUR)</span>
          <span class="mod-ui-data-list__value">88.12</span>
        </li>
      </ul>`;
    const out = parseFt(html);
    expect(out).not.toBeNull();
    expect(out.price).toBeCloseTo(88.12, 2);
    expect(out.currency).toBe('EUR');
  });

  it('extracts price from JSON-LD Product block', () => {
    const ld = JSON.stringify({ '@type': 'Product', price: 55.5, priceCurrency: 'USD' });
    const html = `<script type="application/ld+json">${ld}</script>`;
    const out = parseFt(html);
    expect(out.price).toBeCloseTo(55.5, 2);
    expect(out.currency).toBe('USD');
  });

  it('extracts price from __NEXT_DATA__ on a Next.js tearsheet', () => {
    const data = { props: { pageProps: { tearsheet: { lastPrice: 42.99, currency: 'EUR' } } } };
    const html = `<script id="__NEXT_DATA__">${JSON.stringify(data)}</script>`;
    const out = parseFt(html);
    expect(out.price).toBeCloseTo(42.99, 2);
    expect(out.currency).toBe('EUR');
  });

  it('returns null when no price markers present', () => {
    expect(parseFt('<html><body><p>nothing here</p></body></html>')).toBeNull();
  });
});

describe('debug helpers', () => {
  it('collectKeywordHits returns offset + sanitised snippet for each match', () => {
    const html = '<div class="mod-ui-data-list__label">Price (EUR)</div><span>42.5</span>';
    const hits = collectKeywordHits(html, ['Price (', 'mod-ui-data-list__label']);
    expect(hits.length).toBe(2);
    for (const h of hits) {
      expect(typeof h.offset).toBe('number');
      expect(h.snippet).not.toMatch(/<[^>]+>/);
      expect(h.snippet.length).toBeLessThanOrEqual(200);
    }
  });

  it('buildDebugInfo reports flags + page size + hit list', () => {
    const html = '<script type="application/ld+json">{}</script><span>NAV 12,3</span>';
    const out = buildDebugInfo(html);
    expect(out.bytes).toBe(html.length);
    expect(out.hasJsonLd).toBe(true);
    expect(out.hasNextData).toBe(false);
    expect(Array.isArray(out.hits)).toBe(true);
    expect(out.hits.some(h => h.keyword === 'NAV')).toBe(true);
  });

  it('buildDebugInfo handles empty input', () => {
    const out = buildDebugInfo('');
    expect(out.bytes).toBe(0);
    expect(out.hits).toEqual([]);
  });
});

describe('parseDanske adapter', () => {
  it('does not turn Finnish currency-risk prose into an FX request', async () => {
    // Both the heading and the risk sentence are from fund 4315's page.
    const quote = parseDanske(`
      <h1>Global AC Restricted, osuuslaji EUR W</h1>
      <p>37,94</p><p>Osuuden arvo 05.10.2026</p>
      <p>Rahaston sijoituksia ei ole suojattu valuuttakurssimuutoksilta.</p>`);
    expect(quote).toEqual({ price: 37.94, asOf: '2026-10-05', currency: 'EUR' });
    const getRate = vi.fn(() => { throw new Error('unexpected FX request'); });
    await expect(convertQuoteToBase(quote, 'EUR', getRate)).resolves.toEqual({ price: 37.94, currency: 'EUR' });
    expect(getRate).not.toHaveBeenCalled();
  });

  it.each(['valuuttakurssimuutoksilta', 'valuutta voi muuttua', 'Currency exposure'])('does not infer a currency from prose: %s', prose => {
    expect(parseDanske(`<p>37,94</p><p>Osuuden arvo 05.10.2026</p><p>${prose}</p>`).currency).toBeNull();
  });

  it.each(['Valuutta: CHF', 'currency: CHF', 'VALUUTTA CHF'])('keeps an explicit currency label ahead of other currency mentions: %s', label => {
    const quote = parseDanske(`<h1>EUR comparison</h1><p>37,94</p><p>Osuuden arvo 05.10.2026</p><p>valuutta voi muuttua</p><p>${label}</p>`);
    expect(quote.currency).toBe('CHF');
  });

  // Minimal reconstruction of the public fund 4315 summary's text order
  // observed on 2026-10-06; not a captured raw HTML response.
  it('reads the value before the dated Finnish NAV label, ignoring returns and cookies', () => {
    const html = `
      <script>const banner = '999 Osuuden arvo 29.9.2026';</script>
      <aside>Accept cookies</aside>
      <h1>Global AC Restricted, osuuslaji EUR W</h1>
      <div><strong>37,94</strong><span>Osuuden arvo <time>05.10.2026</time></span></div>
      <div>+0,00% Päivätuotto</div><div>+2,73% Tuotto 1 kuukausi</div>`;
    expect(parseDanske(html)).toEqual({ price: 37.94, asOf: '2026-10-05', currency: 'EUR' });
  });

  it('handles whitespace entities and single-digit valuation dates', () => {
    expect(parseDanske('<p>1&nbsp;234,5678</p><p>Osuuden&nbsp;arvo 5.10.2026</p> EUR'))
      .toEqual({ price: 1234.5678, asOf: '2026-10-05', currency: 'EUR' });
  });

  it.each(['', 'n/a', '0', '-37,94', '+2,73%'])('rejects missing or invalid NAV %j instead of using the date or return', value => {
    expect(parseDanske(`<div>${value}</div><p>Osuuden arvo 05.10.2026</p><p>Tuotto 2,73%</p>`)).toBeNull();
  });

  it('rejects an impossible valuation date', () => {
    expect(parseDanske('<p>37,94</p><p>Osuuden arvo 31.2.2026</p>')).toBeNull();
  });

  it('does not treat a cookie-only response as a price', () => {
    expect(parseDanske('<aside>Accept cookies <button>Accept all</button></aside>')).toBeNull();
  });

  it('extracts price from __NEXT_DATA__ JSON', () => {
    const data = {
      props: {
        pageProps: {
          fund: {
            navPerShare: 7.5489,
            currency: 'EUR',
            asOfDate: '2026-04-30',
          },
        },
      },
    };
    const html = `<html><body><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(data)}</script></body></html>`;
    const out = parseDanske(html);
    expect(out).not.toBeNull();
    expect(out.price).toBeCloseTo(7.5489, 4);
    expect(out.currency).toBe('EUR');
    expect(out.asOf).toBe('2026-04-30');
  });

  it('falls back to data-price attribute', () => {
    const html = '<html><body><div data-price="7,5489">...</div></body></html>';
    const out = parseDanske(html);
    expect(out).not.toBeNull();
    expect(out.price).toBeCloseTo(7.5489, 4);
  });

  it('falls back to label-proximity regex for Finnish copy', () => {
    const html = '<html><body><p>Päivän hinta: 12,345 EUR</p></body></html>';
    const out = parseDanske(html);
    expect(out).not.toBeNull();
    expect(out.price).toBeCloseTo(12.345, 3);
    expect(out.currency).toBe('EUR');
  });

  it('returns null when nothing matches', () => {
    expect(parseDanske('<html><body><p>error</p></body></html>')).toBeNull();
  });

  it('parses a stringified numeric in the JSON blob', () => {
    const data = { props: { pageProps: { lastPrice: '7,5489', currency: 'EUR' } } };
    const html = `<script id="__NEXT_DATA__">${JSON.stringify(data)}</script>`;
    const out = parseDanske(html);
    expect(out.price).toBeCloseTo(7.5489, 4);
  });

  it('parses a JSON-LD block', () => {
    const ld = JSON.stringify({ '@type': 'Product', price: 12.34, priceCurrency: 'EUR' });
    const html = `<script type="application/ld+json">${ld}</script>`;
    const out = parseDanske(html);
    expect(out.price).toBeCloseTo(12.34, 2);
    expect(out.currency).toBe('EUR');
  });

  it('parses a classic <table> layout (label cell + value cell)', () => {
    const html = `
      <html><body>
        <table>
          <tr><th>Päivän kurssi</th><td>7,5489</td></tr>
          <tr><th>Päivämäärä</th><td>30.04.2026</td></tr>
          <tr><th>Valuutta</th><td>EUR</td></tr>
        </table>
      </body></html>`;
    const out = parseDanske(html);
    expect(out).not.toBeNull();
    expect(out.price).toBeCloseTo(7.5489, 4);
    expect(out.asOf).toBe('2026-04-30');
    expect(out.currency).toBe('EUR');
  });

  it('parses a <dl> definition-list layout', () => {
    const html = `
      <dl>
        <dt>Osuuden arvo</dt><dd>123,45</dd>
        <dt>Arvopäivä</dt><dd>2026-04-29</dd>
      </dl>`;
    const out = parseDanske(html);
    expect(out.price).toBeCloseTo(123.45, 2);
    expect(out.asOf).toBe('2026-04-29');
  });

  it('parses "label: value" plain text', () => {
    const html = '<p>Yksikön arvo: 9,876 EUR</p>';
    const out = parseDanske(html);
    expect(out.price).toBeCloseTo(9.876, 3);
    expect(out.currency).toBe('EUR');
  });

  it('extracts dd.mm.yyyy dates from a "Päivätty" label', () => {
    const html = `
      <table>
        <tr><th>Lunastusarvo</th><td>50,1234</td></tr>
        <tr><th>Päivätty</th><td>1.5.2026</td></tr>
      </table>`;
    const out = parseDanske(html);
    expect(out.price).toBeCloseTo(50.1234, 4);
    expect(out.asOf).toBe('2026-05-01');
  });

  it('skips when no recognised label appears', () => {
    const html = '<html><body><p>Random text 12,34 EUR somewhere</p></body></html>';
    expect(parseDanske(html)).toBeNull();
  });
});

describe('extractYahooSymbol', () => {
  it('returns the first resolved symbol', () => {
    const json = { quotes: [{ symbol: 'AGG', exchange: 'PCX' }] };
    expect(extractYahooSymbol(json)).toBe('AGG');
  });

  it('returns null when no quotes resolved', () => {
    expect(extractYahooSymbol({ quotes: [] })).toBeNull();
    expect(extractYahooSymbol({})).toBeNull();
    expect(extractYahooSymbol(null)).toBeNull();
  });
});

describe('extractYahooQuote', () => {
  it('returns the latest finite close with its date and currency', () => {
    const json = {
      chart: {
        result: [{
          meta: { currency: 'USD' },
          timestamp: [1700000000, 1700086400],
          indicators: { quote: [{ close: [97.1, 97.35] }] },
        }],
      },
    };
    const out = extractYahooQuote(json);
    expect(out).not.toBeNull();
    expect(out.price).toBe(97.35);
    expect(out.currency).toBe('USD');
    expect(out.asOf).toBe('2023-11-15');
  });

  it('walks backward past a trailing null close (no trades yet today)', () => {
    const json = {
      chart: {
        result: [{
          meta: { currency: 'EUR' },
          timestamp: [1700000000, 1700086400],
          indicators: { quote: [{ close: [42.5, null] }] },
        }],
      },
    };
    const out = extractYahooQuote(json);
    expect(out.price).toBe(42.5);
  });

  it('returns null when there is no usable close', () => {
    expect(extractYahooQuote({ chart: { result: [{ indicators: { quote: [{ close: [] }] } }] } })).toBeNull();
    expect(extractYahooQuote({})).toBeNull();
  });
});

describe('resolveYahooSymbol', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function jsonResponse(body) {
    return new Response(JSON.stringify(body), { status: 200 });
  }

  it('resolves on the first search when the query matches Yahoo directly', async () => {
    const fakeFetch = vi.fn(async () => jsonResponse({ quotes: [{ symbol: 'NOKIA.HE' }] }));
    vi.stubGlobal('fetch', fakeFetch);
    await expect(resolveYahooSymbol('NOKIA.HE')).resolves.toBe('NOKIA.HE');
    expect(fakeFetch).toHaveBeenCalledTimes(1);
  });

  it('retries with a trailing .US stripped when the first search finds nothing (Stooq-suffix tickers)', async () => {
    let call = 0;
    const fakeFetch = vi.fn(async () => {
      call++;
      return call === 1 ? jsonResponse({ quotes: [] }) : jsonResponse({ quotes: [{ symbol: 'VOO' }] });
    });
    vi.stubGlobal('fetch', fakeFetch);
    await expect(resolveYahooSymbol('VOO.US')).resolves.toBe('VOO');
    expect(fakeFetch).toHaveBeenCalledTimes(2);
    expect(fakeFetch.mock.calls[1][0]).toContain('q=VOO&');
  });

  it('returns null without retrying when the query has no .US suffix to strip', async () => {
    const fakeFetch = vi.fn(async () => jsonResponse({ quotes: [] }));
    vi.stubGlobal('fetch', fakeFetch);
    await expect(resolveYahooSymbol('BOGUSXYZ')).resolves.toBeNull();
    expect(fakeFetch).toHaveBeenCalledTimes(1);
  });
});

describe('fetchTextLimited (SSRF guard)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // Returns a fake fetch that hands out the next pre-built Response per call.
  function fetchSequence(responses) {
    let i = 0;
    return vi.fn(async (_url) => {
      if (i >= responses.length) throw new Error(`unexpected fetch call #${i + 1}`);
      const r = responses[i++];
      return typeof r === 'function' ? r() : r;
    });
  }

  it('returns the body when an allowlisted URL responds 200', async () => {
    const fakeFetch = fetchSequence([new Response('<html>OK</html>', { status: 200 })]);
    vi.stubGlobal('fetch', fakeFetch);
    const out = await fetchTextLimited('https://markets.ft.com/data/funds/tearsheet/summary?s=ABC');
    expect(out).toBe('<html>OK</html>');
    expect(fakeFetch).toHaveBeenCalledTimes(1);
  });

  it('follows a 302 to another allowlisted host and returns the body', async () => {
    const fakeFetch = fetchSequence([
      new Response(null, { status: 302, headers: { Location: 'https://www.danskeinvest.fi/funds/123' } }),
      new Response('<html>OK</html>', { status: 200 }),
    ]);
    vi.stubGlobal('fetch', fakeFetch);
    const out = await fetchTextLimited('https://markets.ft.com/redirect-me');
    expect(out).toBe('<html>OK</html>');
    expect(fakeFetch).toHaveBeenCalledTimes(2);
  });

  it('rejects a 302 to a host not in the allowlist', async () => {
    const fakeFetch = fetchSequence([
      new Response(null, { status: 302, headers: { Location: 'https://evil.example.com/x' } }),
    ]);
    vi.stubGlobal('fetch', fakeFetch);
    await expect(fetchTextLimited('https://markets.ft.com/redirect-me'))
      .rejects.toMatchObject({ code: 'redirect_not_allowed' });
    expect(fakeFetch).toHaveBeenCalledTimes(1);
  });

  it('rejects a 302 to an http:// URL', async () => {
    const fakeFetch = fetchSequence([
      new Response(null, { status: 302, headers: { Location: 'http://markets.ft.com/x' } }),
    ]);
    vi.stubGlobal('fetch', fakeFetch);
    await expect(fetchTextLimited('https://markets.ft.com/redirect-me'))
      .rejects.toMatchObject({ code: 'invalid_redirect' });
    expect(fakeFetch).toHaveBeenCalledTimes(1);
  });

  it('throws too_many_redirects after exceeding MAX_REDIRECTS hops', async () => {
    const redirect = () => new Response(null, {
      status: 302, headers: { Location: 'https://markets.ft.com/again' },
    });
    const fakeFetch = fetchSequence([redirect, redirect, redirect, redirect, redirect]);
    vi.stubGlobal('fetch', fakeFetch);
    await expect(fetchTextLimited('https://markets.ft.com/start'))
      .rejects.toMatchObject({ code: 'too_many_redirects' });
    // Initial hop + MAX_REDIRECTS=3 follow-ups = 4 calls before giving up.
    expect(fakeFetch).toHaveBeenCalledTimes(4);
  });
});

describe('price fetch resource deadline', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

  it('keeps the deadline active while a response body stalls', async () => {
    vi.useFakeTimers();
    let controller;
    vi.stubGlobal('fetch', async (_url, { signal }) => new Response(new ReadableStream({
      start(c) {
        controller = c;
        signal.addEventListener('abort', () => c.error(new DOMException('aborted', 'AbortError')));
      },
    })));
    const result = fetchTextLimited('https://markets.ft.com/start').then(
      () => 'completed', (error) => error.code,
    );
    await vi.advanceTimersByTimeAsync(8001);
    try { controller.close(); } catch { /* already aborted */ }
    expect(await result).toBe('timeout');
  });

  it('uses one deadline for the entire redirect chain', async () => {
    vi.useFakeTimers();
    let calls = 0;
    vi.stubGlobal('fetch', (_url, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      setTimeout(() => resolve(++calls === 1
        ? new Response(null, { status: 302, headers: { location: '/next' } })
        : new Response('late')), 5000);
    }));
    const result = fetchTextLimited('https://markets.ft.com/start').then(
      () => 'completed', (error) => error.code,
    );
    await vi.advanceTimersByTimeAsync(10001);
    expect(await result).toBe('timeout');
  });

  it.each([302, 503])('cancels an unused HTTP %s body', async (status) => {
    let cancelled = false;
    const response = new Response(new ReadableStream({ cancel() { cancelled = true; } }), {
      status, headers: { location: 'https://evil.example.com/' },
    });
    vi.stubGlobal('fetch', async () => response);
    await expect(fetchTextLimited('https://markets.ft.com/start')).rejects.toHaveProperty('code');
    expect(cancelled).toBe(true);
  });
});

describe('normalizeQuoteCurrency', () => {
  it('turns a minor-unit quote into its major currency', () => {
    expect(normalizeQuoteCurrency(1234, 'GBp')).toEqual({ price: 12.34, currency: 'GBP' });
    expect(normalizeQuoteCurrency(1234, 'GBX')).toEqual({ price: 12.34, currency: 'GBP' });
    expect(normalizeQuoteCurrency(5000, 'ZAc')).toEqual({ price: 50, currency: 'ZAR' });
    expect(normalizeQuoteCurrency(250, 'ILA')).toEqual({ price: 2.5, currency: 'ILS' });
  });

  it('upper-cases an ordinary code and leaves the price alone', () => {
    expect(normalizeQuoteCurrency(150.25, 'usd')).toEqual({ price: 150.25, currency: 'USD' });
  });

  it('reports an unknown currency as null', () => {
    expect(normalizeQuoteCurrency(10, null)).toEqual({ price: 10, currency: null });
    expect(normalizeQuoteCurrency(10, '')).toEqual({ price: 10, currency: null });
  });
});

describe('parseBaseCurrency', () => {
  it('accepts a three-letter code, any case', () => {
    expect(parseBaseCurrency('eur')).toBe('EUR');
    expect(parseBaseCurrency('SEK')).toBe('SEK');
  });
  it('rejects anything else as null', () => {
    expect(parseBaseCurrency(undefined)).toBeNull();
    expect(parseBaseCurrency('EURO')).toBeNull();
    expect(parseBaseCurrency('E1R')).toBeNull();
    expect(parseBaseCurrency(42)).toBeNull();
  });
});

describe('convertQuoteToBase', () => {
  it('leaves a quote already in the base currency unconverted', async () => {
    const rate = vi.fn();
    const out = await convertQuoteToBase({ price: 10, currency: 'EUR' }, 'EUR', rate);
    expect(out).toEqual({ price: 10, currency: 'EUR' });
    expect(rate).not.toHaveBeenCalled();
  });

  it('converts a foreign quote with the FX rate and keeps the original', async () => {
    const rate = vi.fn(async () => 0.9);
    const out = await convertQuoteToBase({ price: 150, currency: 'USD' }, 'EUR', rate);
    expect(rate).toHaveBeenCalledWith('USD', 'EUR');
    expect(out.price).toBeCloseTo(135, 6);
    expect(out).toMatchObject({ currency: 'EUR', quoteCurrency: 'USD', quotePrice: 150, fxRate: 0.9 });
  });

  it('converts pence through pounds', async () => {
    const rate = vi.fn(async () => 1.2);
    const out = await convertQuoteToBase({ price: 1000, currency: 'GBp' }, 'EUR', rate);
    expect(rate).toHaveBeenCalledWith('GBP', 'EUR');
    expect(out.price).toBeCloseTo(12, 6);
    expect(out).toMatchObject({ quoteCurrency: 'GBP', quotePrice: 10 });
  });

  it('passes a quote with no known currency through, flagged as unknown', async () => {
    const rate = vi.fn();
    const out = await convertQuoteToBase({ price: 7.5, currency: null }, 'EUR', rate);
    expect(out).toEqual({ price: 7.5, currency: null });
    expect(rate).not.toHaveBeenCalled();
  });

  it('leaves the quote alone when no base currency was asked for', async () => {
    const rate = vi.fn();
    const out = await convertQuoteToBase({ price: 150, currency: 'USD' }, null, rate);
    expect(out).toEqual({ price: 150, currency: 'USD' });
    expect(rate).not.toHaveBeenCalled();
  });

  it('fails closed when no FX rate can be had', async () => {
    const rate = vi.fn(async () => null);
    await expect(convertQuoteToBase({ price: 150, currency: 'USD' }, 'EUR', rate))
      .rejects.toMatchObject({ code: 'fx_unavailable' });
  });
});

describe('fetchFxRate', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    _resetFxCache();
  });

  function chart(close) {
    return new Response(JSON.stringify({ chart: { result: [{
      meta: { currency: 'EUR' }, timestamp: [1727740800], indicators: { quote: [{ close: [close] }] },
    }] } }), { status: 200 });
  }

  it('quotes the Yahoo FROMTO=X pair and caches it', async () => {
    const fakeFetch = vi.fn(async () => chart(0.92));
    vi.stubGlobal('fetch', fakeFetch);
    await expect(fetchFxRate('USD', 'EUR')).resolves.toBeCloseTo(0.92, 6);
    await expect(fetchFxRate('USD', 'EUR')).resolves.toBeCloseTo(0.92, 6);
    expect(fakeFetch).toHaveBeenCalledTimes(1);
    expect(String(fakeFetch.mock.calls[0][0])).toContain('/USDEUR%3DX?');
  });

  it('returns null when Yahoo has no close for the pair', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ chart: { result: [] } }), { status: 200 })));
    await expect(fetchFxRate('XXX', 'EUR')).resolves.toBeNull();
  });
});
