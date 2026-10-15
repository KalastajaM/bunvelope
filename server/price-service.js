const ALLOWED_HOSTS = new Set([
  'www.danskeinvest.fi',
  'danskeinvest.fi',
  'www.danskeinvest.com',
  'danskeinvest.com',
  'markets.ft.com',
  'query1.finance.yahoo.com',
  'query2.finance.yahoo.com',
]);

const YAHOO_SEARCH = 'https://query1.finance.yahoo.com/v1/finance/search';
const YAHOO_CHART = 'https://query1.finance.yahoo.com/v8/finance/chart';

const FETCH_TIMEOUT_MS = 8_000;
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const UA = 'Mozilla/5.0 (compatible; Bunvelope/1.0; +https://github.com/KalastajaM/bunvelope)';

// Transport-independent handlers shared by cloud and desktop.
export async function lookupPrice(kind, body) {
  let status = 200;
  const res = { status(value) { status = value; return this; }, json(value) { return { status, body: value }; } };
  if (kind === 'url') return priceUrl({ body }, res);
  if (kind === 'quote') return priceQuote({ body }, res);
  return { status: 400, body: { error: 'invalid_price_request' } };
}

async function priceUrl(req, res) {
    const url = typeof req.body?.url === 'string' ? req.body.url.trim() : '';
    const debug = req.body?.debug === true;
    if (!url) return res.status(400).json({ error: 'missing_url' });

    let parsed;
    try { parsed = new URL(url); } catch { return res.status(400).json({ error: 'invalid_url' }); }
    if (parsed.protocol !== 'https:') return res.status(400).json({ error: 'https_required' });
    const host = parsed.hostname.toLowerCase();
    if (!ALLOWED_HOSTS.has(host)) return res.status(400).json({ error: 'host_not_allowed', host });
    const adapter = adapterFor(host);
    if (!adapter) return res.status(400).json({ error: 'no_adapter', host });

    let text;
    try {
      text = await fetchTextLimited(parsed.toString());
    } catch (err) {
      const code = err?.code || 'fetch_failed';
      const status = err?.status || (code === 'timeout' ? 504 : 502);
      return res.status(status).json({ error: code, message: err?.message });
    }

    const result = adapter(text);
    if (!result || !Number.isFinite(result.price) || result.price <= 0) {
      const body = { error: 'price_not_found' };
      if (debug) body.debug = buildDebugInfo(text);
      return res.status(422).json(body);
    }
    let converted;
    try {
      converted = await convertQuoteToBase(
        { price: result.price, currency: result.currency || null },
        parseBaseCurrency(req.body?.base), fetchFxRate,
      );
    } catch (err) {
      return upstreamError(res, err, 'bad_upstream_json');
    }
    const body = {
      ...converted,
      asOf: result.asOf || new Date().toISOString().slice(0, 10),
    };
    if (debug) body.debug = buildDebugInfo(text);
    return res.json(body);
}

async function priceQuote(req, res) {
    const query = typeof req.body?.query === 'string' ? req.body.query.trim() : '';
    if (!query) return res.status(400).json({ error: 'missing_query' });

    let symbol;
    try {
      symbol = await resolveYahooSymbol(query);
    } catch (err) {
      return upstreamError(res, err, 'bad_upstream_json');
    }
    if (!symbol) return res.status(422).json({ error: 'no_symbol' });

    let chartJson;
    try {
      const chartText = await fetchTextLimited(
        `${YAHOO_CHART}/${encodeURIComponent(symbol)}?range=5d&interval=1d`,
        { accept: 'application/json' },
      );
      chartJson = JSON.parse(chartText);
    } catch (err) {
      return upstreamError(res, err, 'bad_upstream_json');
    }
    const quote = extractYahooQuote(chartJson);
    if (!quote) return res.status(422).json({ error: 'no_close' });

    let converted;
    try {
      converted = await convertQuoteToBase(quote, parseBaseCurrency(req.body?.base), fetchFxRate);
    } catch (err) {
      return upstreamError(res, err, 'bad_upstream_json');
    }
    return res.json({
      ...converted,
      asOf: quote.asOf || new Date().toISOString().slice(0, 10),
      symbol,
    });
}

// Existing holdings store symbols in Stooq's suffix convention (`AAPL.US`,
// `VOO.US`, `NOKIA.HE`), inherited from when Stooq was the ticker source.
// Yahoo's own convention matches Stooq for non-US markets (`.HE`, `.DE`,
// ...) but has no suffix at all for US-listed tickers — `VOO.US` resolves
// zero quotes while `VOO` resolves fine. Try the query as given first,
// then retry with a trailing `.US` stripped before giving up.
export async function resolveYahooSymbol(query) {
  const symbol = await searchYahooSymbol(query);
  if (symbol) return symbol;
  if (/\.us$/i.test(query)) return searchYahooSymbol(query.slice(0, -3));
  return null;
}

async function searchYahooSymbol(query) {
  const searchText = await fetchTextLimited(
    `${YAHOO_SEARCH}?q=${encodeURIComponent(query)}&quotesCount=1&newsCount=0`,
    { accept: 'application/json' },
  );
  return extractYahooSymbol(JSON.parse(searchText));
}

function upstreamError(res, err, jsonParseCode) {
  if (err instanceof SyntaxError) return res.status(502).json({ error: jsonParseCode });
  const code = err?.code || 'fetch_failed';
  const status = err?.status || (code === 'timeout' ? 504 : 502);
  return res.status(status).json({ error: code, message: err?.message });
}

// Pulls the first resolved ticker symbol out of a Yahoo `/v1/finance/search`
// response — the same lookup works for ISINs, tickers, and free-text names.
export function extractYahooSymbol(searchJson) {
  const symbol = searchJson?.quotes?.[0]?.symbol;
  return typeof symbol === 'string' && symbol ? symbol : null;
}

// Walks a Yahoo `/v8/finance/chart` response backward from the most recent
// bar to find the latest finite close (the last bar or two can be null on
// a day with no trades yet).
export function extractYahooQuote(chartJson) {
  const result = chartJson?.chart?.result?.[0];
  const closes = result?.indicators?.quote?.[0]?.close || [];
  const stamps = result?.timestamp || [];
  const currency = typeof result?.meta?.currency === 'string' ? result.meta.currency : null;
  for (let i = closes.length - 1; i >= 0; i--) {
    if (Number.isFinite(closes[i]) && closes[i] > 0) {
      const asOf = stamps[i] ? new Date(stamps[i] * 1000).toISOString().slice(0, 10) : null;
      return { price: closes[i], asOf, currency };
    }
  }
  return null;
}

// ── Currency conversion ──────────────────────────────────────────────────
// A quote is in whatever currency its market trades in: Yahoo prices a US
// listing in USD and a London one in pence. The budget has one currency, and
// a holding's value is units × price in it, so a $150 quote stored as-is was
// read as €150. With `base` in the request, a foreign quote is converted at
// the latest Yahoo FX close and the original is returned beside it; when no
// rate can be had the route fails closed rather than store a wrong price.

// Quote currencies Yahoo reports in hundredths of the major unit.
const MINOR_UNITS = {
  GBp: ['GBP', 100],
  GBX: ['GBP', 100],
  ZAc: ['ZAR', 100],
  ILA: ['ILS', 100],
};

/**
 * The quote in its major currency: pence become pounds. `currency` is null
 * when the source did not say.
 * @param {number} price
 * @param {string | null | undefined} currency
 * @returns {{ price: number, currency: string | null }}
 */
export function normalizeQuoteCurrency(price, currency) {
  if (typeof currency !== 'string' || !currency.trim()) return { price, currency: null };
  const minor = MINOR_UNITS[currency.trim()];
  if (minor) return { price: price / minor[1], currency: minor[0] };
  return { price, currency: currency.trim().toUpperCase() };
}

/** A request's `base` as an upper-case ISO 4217 code, or null. */
export function parseBaseCurrency(value) {
  if (typeof value !== 'string') return null;
  const v = value.trim().toUpperCase();
  return /^[A-Z]{3}$/.test(v) ? v : null;
}

/**
 * Convert a quote to `base`. Unchanged when no base was asked for, when the
 * quote is already in it, or when the quote's currency is unknown (the
 * scraped fund pages often do not say, and those are the budget's own
 * funds). Throws `fx_unavailable` when a conversion is needed and
 * `getRate(from, to)` has no rate.
 *
 * @param {{ price: number, currency: string | null }} quote
 * @param {string | null} base
 * @param {(from: string, to: string) => Promise<number | null>} getRate
 */
export async function convertQuoteToBase(quote, base, getRate) {
  const { price, currency } = normalizeQuoteCurrency(quote.price, quote.currency);
  if (!base || !currency || currency === base) return { price, currency };
  const rate = await getRate(currency, base);
  if (!Number.isFinite(rate) || rate <= 0) {
    throw Object.assign(new Error(`no ${currency}/${base} rate`), { code: 'fx_unavailable', status: 502 });
  }
  return { price: price * rate, currency: base, quoteCurrency: currency, quotePrice: price, fxRate: rate };
}

const FX_TTL_MS = 10 * 60_000;
/** @type {Map<string, { rate: number, at: number }>} */
const fxCache = new Map();

/** Test hook: forget cached rates. */
export function _resetFxCache() { fxCache.clear(); }

/**
 * Latest close of one unit of `from` in `to`, from Yahoo's `FROMTO=X` pair,
 * or null. Cached for ten minutes: a refresh of a dozen US holdings needs one
 * rate, not a dozen.
 * @param {string} from
 * @param {string} to
 * @returns {Promise<number | null>}
 */
export async function fetchFxRate(from, to) {
  const key = `${from}${to}`;
  const hit = fxCache.get(key);
  if (hit && Date.now() - hit.at < FX_TTL_MS) return hit.rate;
  const text = await fetchTextLimited(
    `${YAHOO_CHART}/${encodeURIComponent(`${key}=X`)}?range=5d&interval=1d`,
    { accept: 'application/json' },
  );
  const quote = extractYahooQuote(JSON.parse(text));
  if (!quote) return null;
  fxCache.set(key, { rate: quote.price, at: Date.now() });
  return quote.price;
}

// Walk redirects manually so the allowlist is enforced on every hop, not
// just the original URL. fetch's redirect:'follow' would happily chase a
// 30x response into a private IP / unrelated host, defeating the SSRF
// guard the route does at request time.
export async function fetchTextLimited(url, opts = {}) {
  const ctrl = new AbortController();
  // One deadline covers headers, every redirect, and the complete body.
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    let current = url;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      assertAllowedUrl(current);
      const res = await fetchOneHop(current, opts, ctrl.signal);
      if (res.status >= 300 && res.status < 400) {
        await res.body?.cancel();
        const loc = res.headers.get('location');
        if (!loc) throwUpstream('bad_redirect', 'redirect with no Location', 502);
        current = new URL(loc, current).toString();
        continue;
      }
      if (!res.ok) {
        await res.body?.cancel();
        throwUpstream('upstream_error', `upstream HTTP ${res.status}`, 502);
      }
      return await readBodyCapped(res);
    }
    throwUpstream('too_many_redirects', 'exceeded redirect limit', 502);
  } catch (err) {
    if (ctrl.signal.aborted) throwUpstream('timeout', 'upstream timeout', 504);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function assertAllowedUrl(u) {
  let parsed;
  try { parsed = new URL(u); }
  catch { throwUpstream('invalid_redirect', 'malformed URL', 502); }
  if (parsed.username || parsed.password || parsed.port) throwUpstream('invalid_url', 'credentials and custom ports are not allowed', 400);
  if (parsed.protocol !== 'https:') {
    throwUpstream('invalid_redirect', `non-https URL (${parsed.protocol})`, 502);
  }
  if (!ALLOWED_HOSTS.has(parsed.hostname.toLowerCase())) {
    throwUpstream('redirect_not_allowed', `redirect to disallowed host ${parsed.hostname}`, 502);
  }
}

async function fetchOneHop(url, opts, signal) {
  return await fetch(url, {
    redirect: 'manual',
    signal,
    headers: {
      'User-Agent': UA,
      // Yahoo's JSON endpoints need a JSON Accept header.
      'Accept': opts.accept || 'text/html,application/xhtml+xml',
      'Accept-Language': 'en;q=0.9, fi;q=0.8',
    },
  });
}

async function readBodyCapped(res) {
  const reader = res.body?.getReader?.();
  if (!reader) return await res.text();
  const decoder = new TextDecoder('utf-8', { fatal: false });
  let total = 0;
  let out = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BYTES) {
      try { await reader.cancel(); } catch { /* ignore */ }
      throwUpstream('too_large', 'upstream payload too large', 502);
    }
    out += decoder.decode(value, { stream: true });
  }
  out += decoder.decode();
  return out;
}

function throwUpstream(code, message, status) {
  const e = new Error(message);
  e.code = code;
  if (status != null) e.status = status;
  throw e;
}

function adapterFor(host) {
  if (host === 'markets.ft.com') return parseFt;
  if (host.endsWith('danskeinvest.fi') || host.endsWith('danskeinvest.com')) return parseDanske;
  return null;
}

// Normalises a price string in either Finnish (1 234,5678) or
// English (1,234.5678) format. Returns NaN when the string can't be
// parsed as a positive number.
export function normalisePriceString(raw) {
  const s = String(raw || '').trim().replace(/\s+/g, '');
  if (!s) return NaN;
  const hasComma = s.includes(',');
  const hasDot = s.includes('.');
  let cleaned = s;
  if (hasComma && hasDot) {
    cleaned = s.lastIndexOf(',') > s.lastIndexOf('.')
      ? s.replace(/\./g, '').replace(',', '.')
      : s.replace(/,/g, '');
  } else if (hasComma) {
    cleaned = s.replace(',', '.');
  }
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : NaN;
}

// FT tearsheet pages. Modern (2024+) tearsheets render the price as a
// `mod-ui-data-list__value` span next to a "Price (CCY)"
// `mod-ui-data-list__label` sibling; older variants put it inside a
// `mod-tearsheet-overview__quote__price` block. Some sections also
// emit Next.js `__NEXT_DATA__` or schema.org JSON-LD. Tries the
// structured sources first, then the modern label/value pair, then
// the old quote-price block, then a `data-mod-config` JSON snippet.
export function parseFt(html) {
  const text = String(html || '');

  const nextDataMatch = text.match(/<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (nextDataMatch) {
    try {
      const data = JSON.parse(nextDataMatch[1]);
      const found = findNumericIn(data, /^(lastPrice|price|sharePrice|nav|navPerShare)$/i);
      if (found && Number.isFinite(found.value) && found.value > 0) {
        return { price: found.value, asOf: found.asOf || extractFtAsOf(text), currency: found.currency || extractFtCurrency(text) };
      }
    } catch { /* ignore */ }
  }

  for (const m of text.matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const data = JSON.parse(m[1]);
      const found = findNumericIn(data, /^(price|sharePrice|nav|navPerShare|lastPrice)$/i);
      if (found && Number.isFinite(found.value) && found.value > 0) {
        return { price: found.value, asOf: found.asOf || extractFtAsOf(text), currency: found.currency || extractFtCurrency(text) };
      }
    } catch { /* ignore */ }
  }

  // Modern tearsheet: <span class="mod-ui-data-list__label">Price (EUR)</span>
  // ... <span class="mod-ui-data-list__value">12.34</span>
  const dataListPair = text.match(
    /class="[^"]*mod-ui-data-list__label[^"]*"[^>]*>\s*Price[^<]*<\/span>\s*<span[^>]*class="[^"]*mod-ui-data-list__value[^"]*"[^>]*>\s*([^<]+?)\s*</i,
  );
  if (dataListPair) {
    const price = normalisePriceString(dataListPair[1]);
    if (Number.isFinite(price) && price > 0) {
      return { price, asOf: extractFtAsOf(text), currency: extractFtCurrency(text) };
    }
  }

  // Older layout: dedicated quote-price block.
  const blockMatch = text.match(/class="[^"]*mod-tearsheet-overview__quote__price[^"]*"[\s\S]{0,400}?<span[^>]*>([^<]+)<\/span>/i);
  if (blockMatch) {
    const price = normalisePriceString(blockMatch[1]);
    if (Number.isFinite(price) && price > 0) {
      return { price, asOf: extractFtAsOf(text), currency: extractFtCurrency(text) };
    }
  }

  // `data-mod-config` JSON snippet seen on some tearsheet widgets.
  const dataPriceMatch = text.match(/data-mod-config="[^"]*"[^>]*>([\s\S]{0,2000}?)<\/div>/i);
  if (dataPriceMatch) {
    const inner = dataPriceMatch[1];
    const priceMatch = inner.match(/"lastPrice"\s*:\s*"?([\d.,]+)"?/);
    if (priceMatch) {
      const price = normalisePriceString(priceMatch[1]);
      if (Number.isFinite(price) && price > 0) {
        return { price, asOf: extractFtAsOf(text), currency: extractFtCurrency(text) };
      }
    }
  }

  return null;
}

function extractFtAsOf(text) {
  const m = text.match(/As of[^<]*?(\d{1,2}\s+\w+\s+\d{4})/i)
    || text.match(/Data\s+(?:as\s+of|delayed[^<]*?)\s+(\d{4}-\d{2}-\d{2})/i);
  if (!m) return null;
  const d = new Date(m[1]);
  return Number.isFinite(d.getTime()) ? d.toISOString().slice(0, 10) : null;
}

function extractFtCurrency(text) {
  const labelM = text.match(/class="[^"]*mod-ui-data-list__label[^"]*"[^>]*>\s*Price\s*\(([A-Z]{3})\)/);
  if (labelM) return labelM[1];
  const tokenM = text.match(/\b(EUR|USD|GBP|SEK|NOK|DKK|CHF|JPY|CAD|AUD)\b/);
  return tokenM ? tokenM[1] : null;
}

// Danske Invest fund pages. The site has both a modern Next.js portal
// (`/fund/...` paths with `__NEXT_DATA__`) and a classic server-rendered
// "show_funds" portal (`/w/show_funds.product?p_nFund=...`) where the
// price is a plain number inside a table cell or definition list.
// Tries the structured sources first, then HTML layouts, then a final
// label-proximity regex covering several Finnish + English label
// variants. The site sometimes blocks unknown user agents — we send a
// browser-ish UA in fetchTextLimited to compensate.
const DANSKE_LABEL_ALTS = [
  // Finnish labels seen on Danske Invest fund pages
  'Päivän\\s*hinta', 'Päivän\\s*kurssi', 'Päiväkurssi',
  'Osuuden\\s*arvo', 'Osuuden\\s*hinta', 'Yksikön\\s*arvo',
  'Lunastusarvo', 'Merkintähinta', 'Kurssi',
  // English fallbacks
  'NAV', 'Share\\s*price', 'Unit\\s*price', 'Last\\s*price',
];
const DANSKE_LABEL_RE = '(?:' + DANSKE_LABEL_ALTS.join('|') + ')';
const DANSKE_NUM_RE = '([0-9][0-9 \\u00a0.,]{1,20})';
const DANSKE_CCY_RE = '([A-Z]{3})?';

export function parseDanske(html) {
  const text = String(html || '');

  const nextDataMatch = text.match(/<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (nextDataMatch) {
    try {
      const data = JSON.parse(nextDataMatch[1]);
      const found = findNumericIn(data, /^(navPerShare|lastPrice|sharePrice|price|nav)$/i);
      if (found && Number.isFinite(found.value) && found.value > 0) {
        return { price: found.value, asOf: found.asOf || null, currency: found.currency || null };
      }
    } catch { /* ignore */ }
  }

  for (const m of text.matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const data = JSON.parse(m[1]);
      const found = findNumericIn(data, /^(price|sharePrice|nav|navPerShare|lastPrice)$/i);
      if (found && Number.isFinite(found.value) && found.value > 0) {
        return { price: found.value, asOf: found.asOf || null, currency: found.currency || null };
      }
    } catch { /* ignore */ }
  }

  const dataAttrMatch = text.match(/data-(?:price|nav|share-price|nav-per-share)="([^"]+)"/i);
  if (dataAttrMatch) {
    const price = normalisePriceString(dataAttrMatch[1]);
    if (Number.isFinite(price) && price > 0) {
      return { price, asOf: extractDanskeAsOf(text), currency: extractDanskeCurrency(text) };
    }
  }

  // The Finnish product summary puts the value BEFORE "Osuuden arvo",
  // followed by its valuation date. Read the pair together: a forward
  // label search otherwise consumes the date (or a neighbouring return).
  const visible = text
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(?:nbsp|#160|#xA0);/gi, ' ');
  const datedNav = visible.match(/Osuuden\s+arvo\s+(\d{1,2})\.(\d{1,2})\.(\d{4})\b/i);
  if (datedNav) {
    const before = visible.slice(0, datedNav.index);
    const value = before.match(/(?:^|\s)([0-9]+(?:[ \u00a0][0-9]{3})*(?:[.,][0-9]+)?)\s*$/);
    const price = value ? normalisePriceString(value[1]) : NaN;
    const [, day, month, year] = datedNav;
    const asOf = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
    const date = new Date(`${asOf}T00:00:00Z`);
    if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(date.getTime())
      || date.toISOString().slice(0, 10) !== asOf) return null;
    return { price, asOf, currency: extractDanskeCurrency(visible) };
  }

  // Layouts in order of specificity. First match wins.
  const patterns = [
    // <td>label</td><td>value</td>  (also handles label/number on adjacent rows)
    new RegExp(
      '<t[hd][^>]*>\\s*' + DANSKE_LABEL_RE + '[^<]*<\\/t[hd]>\\s*'
      + '(?:<\\/tr>\\s*<tr[^>]*>\\s*)?'
      + '<t[hd][^>]*>\\s*' + DANSKE_NUM_RE + '\\s*' + DANSKE_CCY_RE,
      'i',
    ),
    // <dt>label</dt><dd>value</dd>
    new RegExp(
      '<dt[^>]*>\\s*' + DANSKE_LABEL_RE + '[^<]*<\\/dt>\\s*<dd[^>]*>\\s*' + DANSKE_NUM_RE + '\\s*' + DANSKE_CCY_RE,
      'i',
    ),
    // "label: value" plain text
    new RegExp(DANSKE_LABEL_RE + '\\s*[:：]\\s*' + DANSKE_NUM_RE + '\\s*' + DANSKE_CCY_RE, 'i'),
    // label followed by a number within ~120 chars (last-resort proximity)
    new RegExp(DANSKE_LABEL_RE + '[^0-9]{0,120}' + DANSKE_NUM_RE + '\\s*' + DANSKE_CCY_RE, 'i'),
  ];

  for (const re of patterns) {
    const m = text.match(re);
    if (!m) continue;
    const price = normalisePriceString(m[1]);
    if (Number.isFinite(price) && price > 0) {
      return {
        price,
        asOf: extractDanskeAsOf(text),
        currency: m[2] || extractDanskeCurrency(text),
      };
    }
  }

  return null;
}

// Pulls a yyyy-mm-dd or dd.mm.yyyy date out of the page near a typical
// "valuation date" label. Returns ISO yyyy-mm-dd or null.
function extractDanskeAsOf(text) {
  const labelRe = '(?:Päivämäärä|Päivätty|Arvopäivä|Päivän\\s*arvo[ a-zäö]{0,20}|As\\s*of|Valuation\\s*date|Date)';
  const isoRe = new RegExp(labelRe + '[^0-9]{0,40}(\\d{4}-\\d{2}-\\d{2})', 'i');
  const fiRe = new RegExp(labelRe + '[^0-9]{0,40}(\\d{1,2})\\.(\\d{1,2})\\.(\\d{4})', 'i');
  const isoM = text.match(isoRe);
  if (isoM) return isoM[1];
  const fiM = text.match(fiRe);
  if (fiM) {
    const [, d, m, y] = fiM;
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }
  return null;
}

function extractDanskeCurrency(text) {
  // First try a "Valuutta: EUR" or "Currency: EUR" pair. Falls back to
  // any standalone EUR/USD/SEK/NOK/DKK/GBP token in the document.
  // Match a complete label and an uppercase currency token, not Finnish
  // prose such as "valuuttakurssimuutoksilta" (which used to yield KUR)
  // or "valuutta voi" (VOI). A bogus code triggers a failing FX lookup.
  for (const labelM of text.matchAll(/\b(?:Valuutta|Currency)\b\s*[:：]?\s*([A-Z]{3})\b/gi)) {
    if (/^[A-Z]{3}$/.test(labelM[1])) return labelM[1];
  }
  const tokenM = text.match(/\b(EUR|USD|SEK|NOK|DKK|GBP|CHF|JPY)\b/);
  return tokenM ? tokenM[1] : null;
}

function findNumericIn(node, keyRe, depth = 0) {
  if (depth > 8 || node == null) return null;
  if (Array.isArray(node)) {
    for (const item of node) {
      const r = findNumericIn(item, keyRe, depth + 1);
      if (r) return r;
    }
    return null;
  }
  if (typeof node !== 'object') return null;
  for (const [k, v] of Object.entries(node)) {
    if (keyRe.test(k)) {
      if (typeof v === 'number' && Number.isFinite(v) && v > 0) {
        return { value: v, asOf: pickAsOfNear(node), currency: pickCurrencyNear(node) };
      }
      if (typeof v === 'string') {
        const parsed = normalisePriceString(v);
        if (Number.isFinite(parsed) && parsed > 0) {
          return { value: parsed, asOf: pickAsOfNear(node), currency: pickCurrencyNear(node) };
        }
      }
    }
  }
  for (const v of Object.values(node)) {
    const r = findNumericIn(v, keyRe, depth + 1);
    if (r) return r;
  }
  return null;
}

function pickAsOfNear(obj) {
  for (const k of ['asOf', 'asOfDate', 'priceDate', 'date', 'valuationDate']) {
    const v = obj?.[k];
    if (typeof v === 'string' && /\d{4}-\d{2}-\d{2}/.test(v)) return v.slice(0, 10);
  }
  return null;
}

function pickCurrencyNear(obj) {
  for (const k of ['currency', 'currencyCode', 'priceCurrency']) {
    const v = obj?.[k];
    if (typeof v === 'string' && /^[A-Z]{3}$/.test(v)) return v;
  }
  return null;
}

// Diagnostic context for an opt-in `{ debug: true }` request body. Lets
// us iterate on adapters without a round-trip: surface page size,
// whether a Next.js / JSON-LD blob exists, and small text snippets
// around price-flavoured keywords. All snippets are stripped of HTML
// tags and capped so the response stays small.
const DEBUG_KEYWORDS = [
  'lastPrice', 'sharePrice', 'navPerShare', 'priceCurrency',
  'mod-tearsheet-overview', 'mod-ui-data-list__value', 'mod-ui-data-list__label',
  'Price (', 'Last Price', 'Last price',
  'NAV', 'Päivän hinta', 'Päivän kurssi', 'Osuuden arvo', 'Yksikön arvo',
  'data-price', 'data-nav',
];

export function buildDebugInfo(text) {
  const t = String(text || '');
  const out = {
    bytes: t.length,
    hasNextData: /<script[^>]*id="__NEXT_DATA__"/i.test(t),
    hasJsonLd: /<script[^>]*type="application\/ld\+json"/i.test(t),
    hits: collectKeywordHits(t),
  };
  return out;
}

export function collectKeywordHits(text, keywords = DEBUG_KEYWORDS, contextChars = 120, maxHits = 24) {
  const hits = [];
  for (const kw of keywords) {
    const re = new RegExp(kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    const m = text.match(re);
    if (!m) continue;
    const i = m.index;
    const start = Math.max(0, i - 20);
    const end = Math.min(text.length, i + kw.length + contextChars);
    const slice = text.slice(start, end);
    hits.push({
      keyword: kw,
      offset: i,
      snippet: stripTags(slice),
    });
    if (hits.length >= maxHits) break;
  }
  return hits;
}

function stripTags(s) {
  return String(s || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
}
