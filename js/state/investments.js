// js/state/investments.js — meta-backed prices + holding overrides for the
// Investments page. The meta object lives at `state.meta.investments` with
// shape `{ prices: { [SYMBOL]: { price, asOf, fx? } }, holdingOverrides: {
// [accountId]: { [SYMBOL]: { units, costBasis, name? } } },
// priceHistory: { [SYMBOL]: [{ date, price }] } }`.
//
// `prices` is the latest price per symbol; `priceHistory` keeps every price
// ever set, one point per day, oldest first. Nothing reads the history yet:
// it is recorded now because a past price cannot be recovered later, and it
// is what a holding's value over time or a time-weighted return needs.
//
// Holding overrides provide standalone positions without transaction history.
// When transaction or manual rows exist they determine units and cost basis;
// the override contributes display metadata only. Correct a computed position
// with dated adjustment rows, so subsequent trades remain effective.
//
// `tx.symbol` accepts either an exchange ticker (e.g. `AAPL.US`,
// `NOKIA.HE`) or a 12-character ISIN (e.g. `FI0009000681`) when no ticker
// is known. Both shapes are resolved to a tradeable symbol via Yahoo
// Finance's search API and then quoted via Yahoo's chart API (proxied
// through the server — see `fetchYahooQuote`). Mutual funds + funds
// without an exchange listing won't resolve and surface as a per-symbol
// "No quote" error.
//
// This module reads and fetches; it writes nothing. Every change to
// `meta.investments` is an investment.* command (js/core/commands/investment-*.js)
// dispatched through the session.

import { getInvestmentsMeta, getPayeeRules } from '../core/investments-meta.js';
import { normalisePayeeKey, isMappablePayee, appendPricePoint } from '../core/investment-fields.js';

/**
 * Today's local calendar date as YYYY-MM-DD. `toISOString()` is the UTC
 * date, which east of UTC is still yesterday after local midnight (until
 * 03:00 in Helsinki), so a price fetched then was dated a day early.
 */
function localToday() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ISO 6166: 2 country letters + 9 alphanumerics + 1 numeric check digit.
// We don't validate the checksum — format match is enough to distinguish
// ISINs from broker tickers.
const ISIN_RE = /^[A-Z]{2}[A-Z0-9]{9}\d$/;

export function isISIN(s) {
  return ISIN_RE.test(String(s || '').trim().toUpperCase());
}

// The meta readers and the pure field rules live in core, where the payee and
// investment commands use them.
export { getInvestmentsMeta, getPayeeRules, normalisePayeeKey, isMappablePayee, appendPricePoint };

// The tracked holdings and their valuation live in core, where the queries
// use them.
export { trackedInvestmentAccounts, trackedHoldings, portfolioByAccount, portfolioSummary } from '../core/portfolio.js';

export function lookupSymbolForPayee(meta, payee) {
  const key = normalisePayeeKey(payee);
  if (!key) return '';
  const rules = getPayeeRules(meta);
  return rules[key] || '';
}

export function listKnownSymbols(state) {
  const set = new Set();
  for (const tx of state?.transactions || []) {
    if (tx?.symbol) {
      const sym = String(tx.symbol).trim().toUpperCase();
      if (sym) set.add(sym);
    }
  }
  const inv = getInvestmentsMeta(state?.meta);
  for (const accId of Object.keys(inv.holdingOverrides)) {
    for (const sym of Object.keys(inv.holdingOverrides[accId] || {})) {
      const norm = String(sym).trim().toUpperCase();
      if (norm) set.add(norm);
    }
  }
  return [...set].sort();
}

// Returns [{sym, name}] sorted by sym. `name` comes from holdingOverrides; empty string when unknown.
export function listKnownSymbolsWithNames(state) {
  const set = new Set();
  for (const tx of state?.transactions || []) {
    if (tx?.symbol) {
      const sym = String(tx.symbol).trim().toUpperCase();
      if (sym) set.add(sym);
    }
  }
  const inv = getInvestmentsMeta(state?.meta);
  const names = {};
  for (const accId of Object.keys(inv.holdingOverrides)) {
    for (const [sym, override] of Object.entries(inv.holdingOverrides[accId] || {})) {
      const norm = String(sym).trim().toUpperCase();
      if (norm) {
        set.add(norm);
        if (override?.name && !names[norm]) names[norm] = String(override.name).trim();
      }
    }
  }
  return [...set].sort().map(sym => ({ sym, name: names[sym] || '' }));
}

// ── Manual correction rows ───────────────────────────────────────────────
// Manual rows live entirely in `state.meta.investments.manualRows[acct][sym]`
// and are *not* mirrored in `state.transactions`. They contribute to the
// holding aggregation (units + cost basis + realized) via `listHoldings`,
// but they don't affect account balances or show up in any transactions
// view. Use them when broker history disagrees with what the budget
// captured (a fee that wasn't ledgered, a corporate-action share split,
// etc.) and you'd rather correct the holding than the source rows.
//
// Row shape: { id, date, direction: 'buy'|'sell'|'adjust', units, amount, note? }
//   - For buy/sell: `units` and `amount` are positive magnitudes;
//     direction encodes the sign. `amount` is the cash side, including
//     any fee, matching the add-tx sign convention so it can be summed
//     alongside real `investment_transfer` rows.
//   - For adjust: `units` and `amount` are *signed deltas* applied
//     directly to the holding's units / cost basis without any cash
//     leg. Used for share splits (units delta only), bonus issues
//     (units up, cost flat), or fund-management fees deducted from NAV
//     (cost down, units flat). Realised P/L is untouched.

export function getManualRows(meta, accountId, symbol) {
  if (!accountId || !symbol) return [];
  const sym = String(symbol).trim().toUpperCase();
  const inv = getInvestmentsMeta(meta);
  return inv.manualRows?.[accountId]?.[sym] || [];
}

export function listAllManualRows(meta) {
  const out = [];
  const inv = getInvestmentsMeta(meta);
  for (const [accountId, bySym] of Object.entries(inv.manualRows || {})) {
    for (const [symbol, rows] of Object.entries(bySym || {})) {
      for (const r of rows || []) out.push({ ...r, accountId, symbol });
    }
  }
  return out;
}

// Returns Map<symbol, priceUrl> for every holding override that has a
// non-empty `priceUrl`. When the same symbol appears under multiple
// accounts with different URLs, the first encountered wins — symbols
// are global keys in the meta store, so multiple URLs for the same
// symbol shouldn't happen in practice.
export function collectPriceUrls(meta) {
  const out = new Map();
  const inv = getInvestmentsMeta(meta);
  for (const acctId of Object.keys(inv.holdingOverrides || {})) {
    for (const [sym, ov] of Object.entries(inv.holdingOverrides[acctId] || {})) {
      const url = ov && typeof ov.priceUrl === 'string' ? ov.priceUrl.trim() : '';
      if (!url) continue;
      const key = String(sym).trim().toUpperCase();
      if (key && !out.has(key)) out.set(key, url);
    }
  }
  return out;
}

// The conversion the server applied, when the quote was in another currency
// than `base`: `{ currency, price, rate }` in the quote's own terms, or null.
function fxFromResponse(json) {
  if (typeof json?.quoteCurrency !== 'string') return null;
  const price = Number(json.quotePrice);
  const rate = Number(json.fxRate);
  if (!Number.isFinite(price) || !Number.isFinite(rate)) return null;
  return { currency: json.quoteCurrency, price, rate };
}

// Whether a failed price request means the price service could not be
// reached (the browser's fetch threw, the server's fetch of the quote host
// failed or timed out, or the server answered 5xx without a code of its own),
// as opposed to the service answering that it has no quote for the symbol
// (`no_symbol`, `no_close`, `price_not_found`, a 422). The Investments page
// words the two differently: one is a network problem, the other the symbol.
const UNREACHABLE_CODES = new Set(['fetch_failed', 'timeout', 'upstream_error', 'bad_upstream_json', 'too_many_redirects', 'bad_redirect', 'too_large']);
function unreachableResponse(status, code) {
  if (code) return UNREACHABLE_CODES.has(code);
  return status >= 500;
}

// ── Per-URL price fetch (cloud and desktop) ────────────────────────────────
// Posts the URL to the server-side `/api/price-fetch` endpoint, which
// applies a host whitelist + per-host adapter. Returns the same
// `{ price, asOf }` shape as `fetchYahooQuote` for a single symbol so it
// can be merged into the unified result. Fails closed (returns an error
// entry) when the endpoint isn't reachable, e.g. in local mode.
async function priceRequest(path, options) {
  if (!globalThis.bunvelopeDesktop) return fetch(path, options);
  const result = await globalThis.bunvelopeDesktop.price(path.endsWith('/quote') ? 'quote' : 'url', JSON.parse(options.body));
  return { ok: result.status >= 200 && result.status < 300, status: result.status, json: async () => result.body };
}

export async function fetchPriceByUrl(symbol, url, opts = {}) {
  const sym = String(symbol || '').trim().toUpperCase();
  const u = String(url || '').trim();
  if (!sym || !u) return { error: 'Empty URL' };
  let res;
  try {
    res = await priceRequest('/api/price-fetch', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: u, ...(opts.debug ? { debug: true } : {}), ...(opts.base ? { base: opts.base } : {}) }),
    });
  } catch (err) {
    return { error: err.message || 'Network error', unreachable: true };
  }
  if (!res.ok) {
    let body;
    try { body = await res.json(); } catch { /* ignore */ }
    const out = { error: body?.error || `HTTP ${res.status}`, debug: body?.debug || null };
    return unreachableResponse(res.status, body?.error) ? { ...out, unreachable: true } : out;
  }
  let json;
  try { json = await res.json(); } catch { return { error: 'Bad response' }; }
  const price = Number(json?.price);
  if (!Number.isFinite(price) || price <= 0) return { error: json?.error || 'No price', debug: json?.debug || null };
  const asOf = typeof json?.asOf === 'string' && json.asOf
    ? json.asOf
    : localToday();
  return { price, asOf, fx: fxFromResponse(json), debug: json?.debug || null };
}

// ── Yahoo Finance quote fetch (cloud and desktop) ──────────────────────────
// Posts a ticker or ISIN to the server-side `/api/price-fetch/quote`
// endpoint, which resolves it via Yahoo's search API and quotes it via
// Yahoo's chart API. Proxied server-side because Yahoo doesn't serve CORS
// headers to arbitrary origins — a direct browser fetch fails outright.
// (Stooq, the previous ticker-only source, retired its CSV endpoint and
// gated the rest behind a JS proof-of-work anti-bot challenge that no
// server-side fetch can pass either, so it's no longer usable at all.)
//
// Limitations: Yahoo doesn't carry many EU mutual-fund NAVs (most
// Danske/Nordnet/etc. retail funds), so a "no_symbol" or "no_close" error
// is the expected outcome for those — the user falls back to entering the
// price manually via the Edit holding dialog, or configuring a per-holding
// price URL (see `fetchPriceByUrl` above). Fails closed (returns an error
// entry) when the endpoint isn't reachable, e.g. in local/static mode.
export async function fetchYahooQuote(query, opts = {}) {
  const q = String(query || '').trim();
  if (!q) return { error: 'Empty query' };
  let res;
  try {
    res = await priceRequest('/api/price-fetch/quote', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(opts.base ? { query: q, base: opts.base } : { query: q }),
    });
  } catch (err) {
    return { error: err.message || 'Network error', unreachable: true };
  }
  if (!res.ok) {
    let body;
    try { body = await res.json(); } catch { /* ignore */ }
    const out = { error: body?.error || `HTTP ${res.status}` };
    return unreachableResponse(res.status, body?.error) ? { ...out, unreachable: true } : out;
  }
  let json;
  try { json = await res.json(); } catch { return { error: 'Bad response' }; }
  const price = Number(json?.price);
  if (!Number.isFinite(price) || price <= 0) return { error: json?.error || 'No price' };
  const asOf = typeof json?.asOf === 'string' && json.asOf
    ? json.asOf
    : localToday();
  return { price, asOf, symbol: json?.symbol, fx: fxFromResponse(json) };
}

// Unified entry point. Symbols with a configured `priceUrl` (in the
// `urlMap` arg) go through the server-side `/api/price-fetch` scraping
// proxy; everything else (tickers and ISINs alike) is resolved via Yahoo
// through `/api/price-fetch/quote`. Result shape:
// `{ prices: { [SYMBOL]: { price, asOf, fx } }, errors: [{ symbol, message, unreachable? }] }`;
// `unreachable` marks a symbol whose request never got an answer from the
// price service (network or server failure), not one the service has no quote for.
// `opts.base` is the budget's currency: a quote in any other is converted to
// it server-side (`fx` then records the original), and refused when no rate
// is available, so a dollar price is never stored as euros.
// Each input symbol is keyed in `prices` by its uppercase form (the same
// shape the meta store uses), so callers can look up by the original input.
export async function fetchPrices(symbols, urlMap = null, opts = {}) {
  const list = Array.from(new Set((symbols || []).map(s => String(s || '').trim()).filter(Boolean)));
  const out = { prices: {}, errors: [] };

  const urls = urlMap instanceof Map ? urlMap : new Map();
  const viaUrl = list.filter(s => urls.has(s.toUpperCase()));
  const remaining = list.filter(s => !urls.has(s.toUpperCase()));

  if (viaUrl.length) {
    const results = await Promise.all(
      viaUrl.map(async (s) => {
        const sym = s.toUpperCase();
        return { sym, r: await fetchPriceByUrl(sym, urls.get(sym), { debug: !!opts.debug, base: opts.base }) };
      }),
    );
    for (const { sym, r } of results) {
      if (r && Number.isFinite(r.price)) out.prices[sym] = { price: r.price, asOf: r.asOf, fx: r.fx ?? null };
      else out.errors.push({ symbol: sym, message: r?.error || 'No price', debug: r?.debug || null, ...(r?.unreachable ? { unreachable: true } : {}) });
    }
  }

  if (remaining.length) {
    const results = await Promise.all(
      remaining.map(async (s) => {
        const sym = s.toUpperCase();
        return { sym, r: await fetchYahooQuote(sym, { base: opts.base }) };
      }),
    );
    for (const { sym, r } of results) {
      if (r && Number.isFinite(r.price)) out.prices[sym] = { price: r.price, asOf: r.asOf, fx: r.fx ?? null };
      else out.errors.push({ symbol: sym, message: r?.error || 'No quote', ...(r?.unreachable ? { unreachable: true } : {}) });
    }
  }
  return out;
}
