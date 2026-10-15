// ── Number formatting defaults (overridable by app.js via setFormatDefaults) ──

let _defaultLocale = 'fi-FI';
let _defaultCurrencySymbol = '€';
// Where the symbol goes. The number format (locale) picks the separators
// only; the symbol's side follows the UI language: Finnish writes
// "8 531,97 €", English and Dutch "€ 8 531,97". i18n.js's setLang sets it.
let _currencyAfter = false;

/**
 * Put the currency symbol after the amount (Finnish) or before it (the
 * default). Called by setLang whenever the UI language changes.
 *
 * @param {boolean} after
 */
export function setCurrencyAfterAmount(after) {
  _currencyAfter = !!after;
}

/** Whether fmt() and moneyEl() put the currency symbol after the amount. */
export function currencyAfterAmount() {
  return _currencyAfter;
}

// Reasonable locale guess when only a currency code is known.
const CURRENCY_LOCALE_HINT = {
  EUR: 'fi-FI',
  USD: 'en-US',
  GBP: 'en-GB',
  SEK: 'sv-SE',
  NOK: 'nb-NO',
  DKK: 'da-DK',
  CHF: 'de-CH',
  JPY: 'ja-JP',
  AUD: 'en-AU',
  CAD: 'en-CA',
};

/**
 * Set defaults for fmt(). Call once after meta is loaded.
 * Both fields are optional; pass whatever you have.
 *
 * @param {{ currency?: string, locale?: string }} [opts]
 *   currency: ISO 4217 code (e.g. "EUR", "USD")
 *   locale:   BCP 47 tag   (e.g. "fi-FI", "en-US")
 */
export function setFormatDefaults({ currency, locale } = {}) {
  if (currency) {
    try {
      const parts = new Intl.NumberFormat('en-US', { style: 'currency', currency }).formatToParts(0);
      const sym = parts.find(p => p.type === 'currency');
      _defaultCurrencySymbol = sym ? sym.value : currency;
    } catch {
      _defaultCurrencySymbol = currency;
    }
    if (!locale && CURRENCY_LOCALE_HINT[currency]) {
      _defaultLocale = CURRENCY_LOCALE_HINT[currency];
    }
  }
  if (locale) _defaultLocale = locale;
}

/** The locale numbers take from `currency` when the budget names none. */
export function localeForCurrency(currency) {
  return CURRENCY_LOCALE_HINT[currency] || 'fi-FI';
}

/**
 * Number formats offered in Settings, as BCP 47 tags: a choice of separators,
 * not of language. `en-US` writes 1,234.56; `fi-FI` 1 234,56; `de-DE`
 * 1.234,56; `de-CH` 1’234.56.
 */
export const NUMBER_FORMAT_LOCALES = Object.freeze(['fi-FI', 'de-DE', 'en-US', 'de-CH']);

/** 1234.56 as `locale` writes it, the example beside each number format. */
export function numberFormatExample(locale) {
  try {
    return new Intl.NumberFormat(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(1234.56);
  } catch {
    return String(locale);
  }
}

/** Current currency symbol, as configured by setFormatDefaults(). */
export function getCurrencySymbol() {
  return _defaultCurrencySymbol;
}

/** Current locale, as configured by setFormatDefaults(). */
export function getLocale() {
  return _defaultLocale;
}

// The locale's decimal separator, cached per locale. Needed because the
// split-parts renderer has to cut the number at its decimal point, and that
// character is ',' in fi-FI but '.' in en-US — `moneyEl` used to hardcode a
// comma, so a USD budget rendered "$ 1" with ",234.56" in the small type.
const _decimalSep = new Map();
function decimalSeparator(locale) {
  if (!_decimalSep.has(locale)) {
    const part = new Intl.NumberFormat(locale, { minimumFractionDigits: 1 })
      .formatToParts(1.1)
      .find(x => x.type === 'decimal');
    _decimalSep.set(locale, part ? part.value : '.');
  }
  return _decimalSep.get(locale);
}

/**
 * The pieces of a formatted money amount, for renderers that style them
 * separately — `moneyEl` sets the currency symbol and the cents in their own
 * spans. Returns `null` for anything that is not a finite number, which is
 * what makes `fmt` able to answer '—' and `moneyEl` able to show a dash
 * instead of the word "NaN".
 *
 * `{ currency, prefix, whole, frac, decimal }`, where `frac` is '' when
 * `decimals` is 0 and `decimal` is the locale's separator between the two.
 * The sign lives in `prefix` — negatives always carry U+2212, positives carry
 * '+' only when `signed`.
 *
 * This is the ONE implementation. `js/ui/money.js` used to carry a second one
 * with the same name and differently-spelled options (`sign` for `signed`),
 * so a page picked its rounding, its NaN behaviour and its sign convention by
 * which module it happened to import from.
 *
 * @param {unknown} value
 * @param {{ signed?: boolean, decimals?: number, currency?: string }} [opts]
 * @returns {{ currency: string, prefix: string, whole: string, frac: string, decimal: string } | null}
 */
export function fmtParts(value, { signed = false, decimals = 2, currency } = {}) {
  const num = Number(value);
  if (value === null || value === undefined || value === '' || !Number.isFinite(num)) return null;
  const abs = Math.abs(num);
  const formatted = new Intl.NumberFormat(_defaultLocale, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(abs);
  const decimal = decimals > 0 ? decimalSeparator(_defaultLocale) : '';
  const cut = decimal ? formatted.lastIndexOf(decimal) : -1;
  return {
    currency: currency ?? _defaultCurrencySymbol,
    // Rounding happens inside Intl, so the threshold that decides the sign
    // has to match it: −0.004 formats as "0,00" and must not wear a minus.
    prefix: num < -0.005 ? '\u2212' : (signed && num > 0.005 ? '+' : ''),
    whole: cut === -1 ? formatted : formatted.slice(0, cut),
    frac: cut === -1 ? '' : formatted.slice(cut + decimal.length),
    decimal,
  };
}

/**
 * Format a number as currency using the canonical app style: "€ 1 234,56",
 * or "1 234,56 €" when the UI language is Finnish (setCurrencyAfterAmount).
 * The symbol is separated by a space; thousands separator follows
 * the configured locale. Negative values render with a U+2212 minus sign,
 * and anything that is not a finite number renders as '—'.
 *
 * Options:
 *   signed   — when true, positive values are prefixed with '+'.
 *   decimals — decimal places (default 2). Pass 0 for rounded presentation:
 *              "€ 1 234" — still format #1, just whole-euro.
 */
export function fmt(value, opts) {
  const p = fmtParts(value, opts);
  if (!p) return '—';
  const num = `${p.prefix}${p.whole}${p.frac ? p.decimal + p.frac : ''}`;
  return _currencyAfter ? `${num} ${p.currency}` : `${p.currency} ${num}`;
}

/** @param {number} num  @param {number} decimals  @param {boolean} signed */
function signPrefix(num, decimals, signed) {
  // Same rule as fmtParts: the sign follows the ROUNDED value, so −0.04 at one
  // decimal is "0,0" with no minus.
  const half = 0.5 * 10 ** -decimals;
  return num <= -half ? '−' : (signed && num >= half ? '+' : '');
}

/**
 * Format a plain (non-money) number in the budget's locale, the same grouping
 * and decimal separator as fmt(): "1 234,5" in fi-FI, "1,234.5" in en-US.
 * Pages used `toFixed`, which always writes a dot, so a unit count or a
 * runway read "227.203677" next to "€ 4 000,00".
 *
 * `decimals` fixes the number of places; without it up to `maxDecimals` are
 * shown and trailing zeros dropped. Anything not finite renders as '—'.
 *
 * @param {unknown} value
 * @param {{ decimals?: number, maxDecimals?: number, signed?: boolean }} [opts]
 * @returns {string}
 */
export function fmtNum(value, { decimals, maxDecimals = 2, signed = false } = {}) {
  const num = Number(value);
  if (value === null || value === undefined || value === '' || !Number.isFinite(num)) return '—';
  const min = decimals ?? 0;
  const max = decimals ?? maxDecimals;
  const body = new Intl.NumberFormat(_defaultLocale, {
    minimumFractionDigits: min,
    maximumFractionDigits: max,
  }).format(Math.abs(num));
  return signPrefix(num, max, signed) + body;
}

/**
 * Format a percentage given in percent units (13.12 → "13,1 %" in fi-FI,
 * "13.1%" in en-US), using the locale's own spacing and separator.
 * Negatives carry U+2212 like every other number; `signed` adds '+'.
 * Anything not finite renders as '—'.
 *
 * @param {unknown} value
 * @param {{ decimals?: number, signed?: boolean }} [opts]
 * @returns {string}
 */
export function fmtPct(value, { decimals = 1, signed = false } = {}) {
  const num = Number(value);
  if (value === null || value === undefined || value === '' || !Number.isFinite(num)) return '—';
  const body = new Intl.NumberFormat(_defaultLocale, {
    style: 'percent',
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(Math.abs(num) / 100);
  return signPrefix(num, decimals, signed) + body;
}

/**
 * Format current month as YYYY-MM
 */
export function currentMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/**
 * Round a number to 2 decimal places (money) to contain float drift.
 * Returns 0 for NaN/Infinity so accidental bad input doesn't propagate.
 */
export function round2(n) {
  if (typeof n !== 'number' || !isFinite(n)) return 0;
  const r = Math.round(n * 100) / 100;
  // `n * 100` can overflow to Infinity for a finite but enormous input, so a
  // finite argument could still leave here non-finite — which is exactly what
  // the guard above exists to prevent. Found by the property suite; not
  // reachable through `validateAmount`, which caps at 1e12.
  return Number.isFinite(r) ? r : 0;
}

/**
 * Filter a list of accounts/envelopes for display in a <select>, honouring a
 * "show archived" setting. Archived items are dropped unless `showArchived` is
 * true or the item's id is in `keepIds` (e.g. an item already referenced by the
 * transaction being edited, so it stays selectable and isn't silently lost on
 * save). The array order (= display order) is preserved.
 */
export function filterArchivedForSelect(items, showArchived, keepIds = []) {
  const keep = keepIds instanceof Set ? keepIds : new Set(keepIds);
  return (items || []).filter(it => !it.archived || showArchived || keep.has(it.id));
}

/**
 * Parse a date string in YYYY-MM-DD or DD/MM/YY(YY) into a Date.
 * Returns null on failure. Two-digit years are treated as 2000+yy
 * (budget data is modern; 1900s would be wrong for this app).
 */
export function parseDate(str) {
  if (!str || typeof str !== 'string') return null;
  const s = str.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const d = new Date(s + 'T00:00:00');
    return isNaN(d.getTime()) ? null : d;
  }
  const parts = s.split('/');
  if (parts.length !== 3) return null;
  const [dd, mm, yy] = parts.map(Number);
  if ([dd, mm, yy].some(n => !Number.isFinite(n))) return null;
  const yr = yy < 100 ? 2000 + yy : yy;
  const d = new Date(yr, mm - 1, dd);
  return isNaN(d.getTime()) ? null : d;
}

/**
 * Whole calendar days from `from` to `to`, counting the days themselves and
 * ignoring the time of day. Signed: negative when `to` is the earlier date.
 *
 * Use this for every day-count in the app instead of dividing a millisecond
 * difference by 86 400 000. Both operands here are almost always LOCAL
 * midnights — a date-only string parsed as `T00:00:00`, or a Date pushed
 * through `setHours(0,0,0,0)` — and the span between two local midnights is
 * a whole number of days only while no clock change falls between them. Over
 * a spring-forward it is a day short of one; over a fall-back, an hour long.
 * `Math.floor` then loses a day in March and `Math.ceil` gains one in
 * October, which is how an age of money of 50 days reported 49 on every
 * DST-observing machine while CI, running UTC, saw nothing.
 *
 * Reading the local Y/M/D components back out and re-anchoring them to UTC
 * removes the offset from both sides, so the subtraction lands on an exact
 * multiple of a day whatever the zone does in between.
 */
export function wholeDaysBetween(from, to) {
  if (!(from instanceof Date) || !(to instanceof Date)) return NaN;
  const a = Date.UTC(from.getFullYear(), from.getMonth(), from.getDate());
  const b = Date.UTC(to.getFullYear(), to.getMonth(), to.getDate());
  return Math.round((b - a) / 86400000);
}

/**
 * HTML-escape a value for safe interpolation into innerHTML
 * (both text content and double-quoted attribute values).
 */
export function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * URL-safe slug: lowercase, a-z0-9 and hyphens. Trims leading/trailing
 * hyphens. Returns '' for empty input — callers decide the fallback.
 */
export function slugify(str) {
  return String(str ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Produce a unique id based on `base` that doesn't collide with any id
 * already in `taken` (a Set<string>). Appends -2, -3, … on collision,
 * and falls back to a timestamp-random suffix for pathological cases.
 * Does NOT mutate `taken`; the caller should add the returned id if desired.
 */
export function uniqueId(base, taken) {
  const b = base && String(base).length ? String(base) : 'item';
  if (!taken.has(b)) return b;
  for (let n = 2; n < 9999; n++) {
    const candidate = `${b}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${b}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Coerce a value to a safe money number. Returns null if:
 *   - not a finite number after Number() coercion
 *   - booleans, objects, arrays, empty strings
 *   - magnitude ≥ 1e12 (far beyond any real budget amount)
 * Use at every boundary where amounts enter the engine (disk, user input).
 */
export function validateAmount(x) {
  if (typeof x === 'boolean') return null;
  if (x === null || x === undefined) return null;
  if (typeof x === 'object') return null;
  if (typeof x === 'string' && x.trim() === '') return null;
  const n = Number(x);
  if (!Number.isFinite(n)) return null;
  if (Math.abs(n) >= 1e12) return null;
  return n;
}
