import { afterEach, it, expect, vi } from 'vitest';
import { getLocalKey, setLocalKey, clearLocalKey } from '../js/ai/keystore.js';
import { fetchYahooQuote, fetchPriceByUrl } from '../js/state/investments.js';
afterEach(() => vi.unstubAllGlobals());
it('moves a legacy key only after secure storage succeeds and never falls back on failure', () => {
  const data = new Map([['bv.ai.key', 'legacy']]);
  vi.stubGlobal('localStorage', { getItem: k => data.get(k), removeItem: k => data.delete(k) });
  const bridge = { getKey: () => null, setKey: vi.fn(() => { throw new Error('locked'); }) };
  vi.stubGlobal('bunvelopeDesktop', bridge);
  expect(getLocalKey()).toBe(null); expect(data.get('bv.ai.key')).toBe('legacy');
  bridge.setKey = vi.fn(); expect(getLocalKey()).toBe('legacy');
  expect(bridge.setKey).toHaveBeenCalledWith('legacy'); expect(data.has('bv.ai.key')).toBe(false);
  setLocalKey('new'); clearLocalKey(); expect(bridge.setKey).toHaveBeenLastCalledWith('');
});
it('uses native quote/URL services with base currency and retains response semantics', async () => {
  const price = vi.fn(async () => ({ status: 200, body: { price: 12, asOf: '2026-10-06', quoteCurrency: 'USD', quotePrice: 15, fxRate: 0.8 } }));
  vi.stubGlobal('bunvelopeDesktop', { price });
  expect(await fetchYahooQuote('AAPL', { base: 'EUR' })).toMatchObject({ price: 12, fx: { currency: 'USD', rate: 0.8 } });
  expect(price).toHaveBeenCalledWith('quote', { query: 'AAPL', base: 'EUR' });
  await fetchPriceByUrl('FUND', 'https://www.danskeinvest.fi/test', { base: 'EUR' });
  expect(price).toHaveBeenLastCalledWith('url', { url: 'https://www.danskeinvest.fi/test', base: 'EUR' });
  price.mockResolvedValue({ status: 504, body: { error: 'timeout' } });
  expect(await fetchYahooQuote('AAPL')).toMatchObject({ unreachable: true });
});

it('shared service executes URL parsing, ticker lookup and currency conversion', async () => {
  const { lookupPrice, _resetFxCache } = await import('../server/price-service.js');
  _resetFxCache();
  vi.stubGlobal('fetch', vi.fn(async url => {
    if (url.includes('danskeinvest')) return new Response('<script type="application/ld+json">{"price":12.5}</script>');
    if (url.includes('/search')) return new Response(JSON.stringify({ quotes: [{ symbol: 'AAPL' }] }));
    return new Response(JSON.stringify({ chart: { result: [{ meta: { currency: 'USD' }, timestamp: [1791244800],
      indicators: { quote: [{ close: [url.includes('USDEUR') ? 0.8 : 100] }] } }] } }));
  }));
  const url = await lookupPrice('url', { url: 'https://www.danskeinvest.fi/fund' });
  expect(url.status).toBe(200); expect(url.body.price).toBe(12.5);
  const quote = await lookupPrice('quote', { query: 'AAPL', base: 'EUR' });
  expect(quote).toMatchObject({ status: 200, body: { price: 80, quotePrice: 100, fxRate: 0.8 } });
  expect((await lookupPrice('url', { url: 'https://127.0.0.1/' })).status).toBe(400);
  expect((await lookupPrice('url', { url: 'https://www.danskeinvest.fi:444/fund' })).status).toBe(400);
});
