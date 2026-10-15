// js/import/csv-parse-generic.js
// Generic CSV parser for bank transaction exports.
// Pure functions — no DOM, no I/O, no state.

import { txAbsAmount, txAccountDelta } from '../engine.js';
import { round2 } from '../utils.js';
import { payeesSimilar } from '../core/payee-cluster.js';
import { resolvePayeeAlias } from '../core/payee-fields.js';

// ── Separator detection ───────────────────────────────────────────────────────


export function detectSeparator(text) {
  const firstLine = text.split(/\r?\n/)[0] || '';
  const counts = {
    ',':  (firstLine.match(/,/g)  || []).length,
    ';':  (firstLine.match(/;/g)  || []).length,
    '\t': (firstLine.match(/\t/g) || []).length,
  };
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
}

/**
 * Why a file cannot be a bank CSV, or null: 'empty' for no text at all,
 * 'notCsv' for binary content (control characters a text export never
 * holds) or a header with fewer than two columns. `rows` is `parseCsv`'s
 * output for the text.
 *
 * @param {string} text
 * @param {unknown[][]} rows
 * @returns {'empty' | 'notCsv' | null}
 */
export function csvShapeProblem(text, rows) {
  if (!String(text || '').replace(/\uFEFF/g, '').trim() || !rows.length) return 'empty';
  // eslint-disable-next-line no-control-regex -- detecting binary content is the point
  if (/[\u0000-\u0008\u000E-\u001F]/.test(String(text).slice(0, 4096))) return 'notCsv';
  if ((rows[0] || []).length < 2) return 'notCsv';
  return null;
}

// ── CSV parser ────────────────────────────────────────────────────────────────
// Handles quoted fields, embedded commas/newlines, escaped double-quotes ("").

export function parseCsv(text, sep) {
  const rows = [];
  let field = '';
  let record = [];
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') { inQuotes = true; continue; }

    if (ch === sep) { record.push(field); field = ''; continue; }

    if (ch === '\r') {
      if (text[i + 1] === '\n') i++;
      record.push(field); rows.push(record); record = []; field = '';
      continue;
    }

    if (ch === '\n') {
      record.push(field); rows.push(record); record = []; field = '';
      continue;
    }

    field += ch;
  }

  if (field || record.length) { record.push(field); rows.push(record); }

  // Drop trailing blank rows
  while (rows.length && rows[rows.length - 1].every(c => !String(c).trim())) rows.pop();

  return rows;
}

// ── Column auto-detection ─────────────────────────────────────────────────────

const RE_DATE   = /date|datum|pvm|päivä|booking|buchung|fecha|dato/i;
const RE_PAYEE  = /descri|payee|beneficiary|merchant|name|reference|saaja|kuvaus|viite|memo|narrative|detail|text|empfänger/i;
// Amount headers in two tiers. The strong words name an amount and nothing
// else. The weak ones ("value", "arvo", "total") are also the first half of
// date headers: OP and Nordea both put "Arvopäivä" (value date) before
// "Määrä", and English exports carry "Value date". Matching `arvo` as a bare
// substring picked the date column, and parseAmount then read 05.01.2026 as
// 5 012 026. So the weak words only count as a whole word, and never on a
// header that already reads as a date.
const RE_AMOUNT_STRONG = /amount|beløp|belopp|betrag|bedrag|summa|määrä|\bsum\b|importe|montant/i;
const RE_AMOUNT_WEAK   = /\b(?:total|value|arvo)\b/i;
const RE_DEBIT  = /debit|out|withdrawal|expense|utgift|menot|belastung/i;
const RE_CREDIT = /credit|deposit|income|inntekt|tulot|gutschrift/i;

// Finnish banks name the counterparty in more than one column, and leave
// the others empty: Nordea writes "Maksaja" and "Maksunsaaja" (often blank)
// and the name in "Nimi"; OP writes "Saaja/Maksaja". These are asked for
// first, in this order, and the first one holding any value wins.
const RE_PAYEE_PREFERRED = [/^nimi$/i, /^saaja\s*\/\s*maksaja$/i, /^maksaja$/i, /^saaja$/i];
// Columns whose text goes into the imported row's note: the message
// ("Viesti"), the bank's description ("Selitys", "Otsikko"), then the
// archive id or reference ("Arkistointitunnus", "Viite"/"Viitenumero"),
// which is labelled so it reads as an id. In this order.
const RE_NOTE_TEXT = [/^viesti$/i, /^otsikko$/i, /^selitys$/i];
const RE_NOTE_REF  = [/^arkistointitunnus$/i, /^viite(?:numero)?$/i];

/**
 * Guess the columns of a bank CSV from its headers. `rows` (the data rows,
 * optional) lets the guess prefer a payee column that holds something: a
 * mapping to an empty column imported every payee as "—".
 *
 * @param {unknown[]} headers
 * @param {unknown[][]} [rows]
 */
export function detectColumns(headers, rows = []) {
  /** @param {RegExp} re @param {RegExp|null} skip */
  const find = (re, skip = null) => {
    const idx = headers.findIndex((h) => {
      const s = String(h).trim();
      return re.test(s) && !(skip && skip.test(s));
    });
    return idx;
  };
  const hasValue = (idx) => (rows || []).some(r => Array.isArray(r) && String(r[idx] ?? '').trim() !== '');

  const dateCol   = find(RE_DATE);
  const payeeCol  = detectPayeeColumn(headers, hasValue, dateCol);
  const debitCol  = find(RE_DEBIT);
  const creditCol = find(RE_CREDIT);
  // Only use generic amount if no explicit debit/credit columns found
  let amountCol = -1;
  if (debitCol < 0 && creditCol < 0) {
    amountCol = find(RE_AMOUNT_STRONG, RE_DATE);
    if (amountCol < 0) amountCol = find(RE_AMOUNT_WEAK, RE_DATE);
  }

  // Note columns: never one already used for something else.
  const used = new Set([dateCol, payeeCol, amountCol, debitCol, creditCol]);
  const noteCols = [];
  for (const re of [...RE_NOTE_TEXT, ...RE_NOTE_REF]) {
    const idx = find(re);
    if (idx >= 0 && !used.has(idx) && !noteCols.includes(idx)) noteCols.push(idx);
  }

  return { dateCol, payeeCol, amountCol, debitCol, creditCol, noteCols };
}

/** The payee column: the preferred names first, then any payee-ish header; among them the first that holds a value. */
function detectPayeeColumn(headers, hasValue, dateCol) {
  const names = headers.map(h => String(h).trim());
  const candidates = [];
  for (const re of RE_PAYEE_PREFERRED) {
    const idx = names.findIndex(s => re.test(s));
    if (idx >= 0 && !candidates.includes(idx)) candidates.push(idx);
  }
  names.forEach((s, idx) => {
    if (idx !== dateCol && RE_PAYEE.test(s) && !RE_NOTE_REF.some(re => re.test(s))
      && !RE_NOTE_TEXT.some(re => re.test(s)) && !candidates.includes(idx)) candidates.push(idx);
  });
  if (!candidates.length) return -1;
  return candidates.find(hasValue) ?? candidates[0];
}

/**
 * Whether a column holds any non-blank value in `rows`. The import sheet
 * says so when the chosen payee column is empty.
 *
 * @param {unknown[][]} rows
 * @param {number} idx
 */
export function columnHasValues(rows, idx) {
  if (!(idx >= 0)) return false;
  return (rows || []).some(r => Array.isArray(r) && String(r[idx] ?? '').trim() !== '');
}

// ── Date parsing ──────────────────────────────────────────────────────────────

/**
 * Y/M/D → ISO, or null when that day does not exist. Round-trips through
 * Date.UTC: a range check alone (d ≤ 31) let "31.02.2026" through as
 * 2026-02-31, a string the rest of the app then reads as 3 March.
 */
export function isoFromYmd(y, m, d) {
  if (![y, m, d].every(Number.isInteger)) return null;
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

export function parseDate(str) {
  if (!str) return null;
  const s = String(str).trim().replace(/\uFEFF/, '');

  // Year first: YYYY-MM-DD, YYYY/MM/DD, YYYY.MM.DD
  const ymd = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (ymd) return isoFromYmd(+ymd[1], +ymd[2], +ymd[3]);

  // DD.MM.YYYY or DD/MM/YYYY or D.M.YY etc.
  const dmy = s.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})$/);
  if (dmy) {
    const rawY = parseInt(dmy[3], 10);
    const y = rawY < 100 ? 2000 + rawY : rawY;
    const iso = isoFromYmd(y, parseInt(dmy[2], 10), parseInt(dmy[1], 10));
    if (iso) return iso;
  }

  // MM/DD/YYYY (US), only when day-first was impossible because the "month"
  // was over 12. A day-first date that failed for being 31 February must not
  // be rescued as a US date.
  const mdy = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (mdy && parseInt(mdy[2], 10) > 12) {
    return isoFromYmd(parseInt(mdy[3], 10), parseInt(mdy[1], 10), parseInt(mdy[2], 10));
  }

  return null;
}

// ── Amount parsing ────────────────────────────────────────────────────────────
// Handles both European (1.234,56) and US/ISO (1,234.56) formats.

// Single-separator rule (owner decision, 2026-10-02): amounts are written
// without thousands separators, so ONE separator, comma or dot, is the
// decimal point: "1,234" and "1.234" are both 1.234. A separator that repeats
// ("1.234.567") can only be grouping, and two different ones ("1.234,56")
// are grouping plus decimal, the last being the decimal.
//
// The one exception is evidence from the file itself: `decimal` is the
// column's decimal separator when other values in it prove it
// (`detectDecimalSeparator`). A European export that writes "2.345,67" on one
// row and "1.000" on another means a thousand by the second; reading it as
// 1.0 would be a silent thousandfold error. Without such evidence the rule
// above stands. (It used to guess: a lone separator before exactly three
// digits was taken as grouping, so the same "1,234" meant 1234 in an import
// and 1.234 when typed.)
function _isThousandsSep(s, sep, count, decimal) {
  if (count > 1) return true;
  return !!decimal && decimal !== sep && _validGrouping(s, sep);
}

/**
 * The decimal separator a column of amounts proves, or undefined. A value
 * with both separators proves the last one; a value whose separator repeats
 * ("1.234.567") proves the other one. Conflicting evidence proves nothing.
 *
 * @param {Iterable<unknown>} values
 * @returns {',' | '.' | undefined}
 */
export function detectDecimalSeparator(values) {
  const seen = new Set();
  for (const v of values) {
    if (v == null) continue;
    const s = String(v).replace(/[^\d.,]/g, '');
    const dots = (s.match(/\./g) || []).length;
    const commas = (s.match(/,/g) || []).length;
    if (dots && commas) seen.add(s.lastIndexOf(',') > s.lastIndexOf('.') ? ',' : '.');
    else if (dots > 1) seen.add(',');
    else if (commas > 1) seen.add('.');
  }
  return seen.size === 1 ? /** @type {',' | '.'} */ ([...seen][0]) : undefined;
}

// Dates are the one thing a mis-mapped column hands us that otherwise parses:
// "05.01.2026" reads as three thousands groups. Refuse the shape outright.
const RE_DATE_SHAPED = /^(?:\d{1,2}[./-]\d{1,2}[./-]\d{2,4}|\d{4}[./-]\d{1,2}[./-]\d{1,2})$/;

// Currency symbols and ISO-ish codes banks print beside the number.
// Codes are upper-case three-letter ISO or the Nordic "kr", so trailing junk
// like "12abc" still fails rather than being quietly trimmed to 12.
const RE_CURRENCY = /[€$£¥₹₽¢]|^(?:[A-Z]{3}|[Kk]r\.?)(?=[-+(\d.,])|(?<=[\d)])(?:[A-Z]{3}|[Kk]r\.?)$/g;

// Every dash a spreadsheet or bank might use as a minus sign.
const RE_MINUS = /[−‒–—﹣－]/g;

/**
 * Pull the sign off a cleaned amount string: a leading "-"/"+", a trailing
 * "-" (SAP-style "12,50-"), or accounting parentheses "(12.50)". Returns the
 * unsigned body and whether it was negative, or null for a malformed sign.
 */
function _splitSign(s) {
  let neg = false;
  let body = s;
  if (/^\(.*\)$/.test(body)) { neg = !neg; body = body.slice(1, -1); }
  if (/^[-+]/.test(body)) { if (body[0] === '-') neg = !neg; body = body.slice(1); }
  if (/[-+]$/.test(body)) { if (body.endsWith('-')) neg = !neg; body = body.slice(0, -1); }
  if (!body || /[-+()]/.test(body)) return null;
  return { neg, body };
}

function _validGrouping(intPart, sep) {
  const esc = sep === '.' ? '\\.' : sep;
  return new RegExp(`^\\d{1,3}(?:${esc}\\d{3})*$`).test(intPart) || /^\d+$/.test(intPart);
}

/**
 * @param {unknown} str
 * @param {{ decimal?: ',' | '.' }} [opts]  the column's proven decimal separator
 */
export function parseAmount(str, { decimal } = {}) {
  if (str == null || str === '') return NaN;
  // \s covers NBSP (U+00A0) and narrow NBSP (U+202F), the thousands
  // separators Finnish and French locales emit; apostrophes are the Swiss one.
  const raw = String(str).trim()
    .replace(RE_MINUS, '-')
    .replace(/[\s'’]/g, '');
  if (!raw || RE_DATE_SHAPED.test(raw)) return NaN;
  const signed = _splitSign(raw.replace(RE_CURRENCY, ''));
  if (!signed) return NaN;
  const s = signed.body;
  if (!/^[\d.,]+$/.test(s) || !/\d/.test(s)) return NaN;

  const dots   = (s.match(/\./g) || []).length;
  const commas = (s.match(/,/g)  || []).length;
  const lastDot   = s.lastIndexOf('.');
  const lastComma = s.lastIndexOf(',');

  let cleaned;
  if (dots && commas) {
    // Both present: whichever comes last is the decimal separator, and the
    // other must be a real thousands grouping ahead of it.
    const dec = lastComma > lastDot ? ',' : '.';
    const grp = dec === ',' ? '.' : ',';
    const cut = s.lastIndexOf(dec);
    if (!_validGrouping(s.slice(0, cut), grp)) return NaN;
    cleaned = s.slice(0, cut).split(grp).join('') + '.' + s.slice(cut + 1);
  } else if (commas > 1 && !_validGrouping(s, ',')) {
    return NaN;
  } else if (dots > 1 && !_validGrouping(s, '.')) {
    return NaN;
  } else if (commas) {
    cleaned = _isThousandsSep(s, ',', commas, decimal)
      ? s.replace(/,/g, '')                      // "1,000" → "1000"
      : s.replace(',', '.');                     // "12,50" → "12.50"
  } else if (dots) {
    cleaned = _isThousandsSep(s, '.', dots, decimal)
      ? s.replace(/\./g, '')                     // "1.000" → "1000"
      : s;                                       // "12.50"
  } else {
    cleaned = s;
  }

  // Whatever the separator reading, what is left must be one number. This is
  // what rejects "1.2.3,4" and friends instead of parseFloat taking a prefix.
  if (!/^\d+(?:\.\d+)?$/.test(cleaned)) return NaN;
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return NaN;
  return signed.neg ? -n : n;
}

// ── Row parsing ───────────────────────────────────────────────────────────────
// Returns { date, payee, amount } (plus `note` when the mapping names note
// columns that hold text) or null if mandatory fields are missing/invalid.

/**
 * Why `row` does not parse under `mapping`, or null when it does:
 * `{ reason: 'date' | 'amount' | 'zero', value }`, the value being the cell
 * that failed. The import sheet lists the first few to the user.
 */
export function rowProblem(row, mapping) {
  if (parseRow(row, mapping)) return null;
  const get = (idx) => (Array.isArray(row) && idx >= 0 && idx < row.length ? String(row[idx]).trim() : '');
  if (!parseDate(get(mapping.dateCol))) return { reason: 'date', value: get(mapping.dateCol) };
  const cells = mapping.amountCol >= 0 ? [get(mapping.amountCol)]
    : [get(mapping.debitCol), get(mapping.creditCol)].filter(Boolean);
  const nums = cells.map(c => parseAmount(c, { decimal: mapping.decimal }));
  if (nums.length && nums.some(n => Number.isFinite(n))) return { reason: 'zero', value: cells.join(' / ') };
  return { reason: 'amount', value: cells.join(' / ') };
}

// `decimal` is the file's proven decimal separator (`withDecimalHint`).
export function parseRow(row, { dateCol, payeeCol, amountCol, debitCol, creditCol, noteCols, headers, decimal }) {
  const get = (idx) => (idx >= 0 && idx < row.length ? String(row[idx]).trim() : '');

  const date = parseDate(get(dateCol));
  if (!date) return null;

  const payee = payeeCol >= 0 ? get(payeeCol) : '';

  let amount;
  if (amountCol >= 0) {
    amount = parseAmount(get(amountCol), { decimal });
  } else {
    const debit  = debitCol  >= 0 ? parseAmount(get(debitCol), { decimal })  : NaN;
    const credit = creditCol >= 0 ? parseAmount(get(creditCol), { decimal }) : NaN;
    const dVal = Number.isFinite(debit)  ? Math.abs(debit)  : 0;
    const cVal = Number.isFinite(credit) ? Math.abs(credit) : 0;
    if (dVal > 0) amount = -dVal;          // debit = money out
    else if (cVal > 0) amount = cVal;      // credit = money in
    else amount = NaN;
  }

  // A sub-cent amount (0.004) rounds to zero as money: skip it like a zero
  // row, rather than let it reach transaction.import and refuse the file.
  if (!Number.isFinite(amount) || round2(Math.abs(amount)) === 0) return null;

  const note = noteFromColumns(row, noteCols, headers, payee);
  const result = note ? { date, payee, amount, note } : { date, payee, amount };
  const statusCol = (headers || []).findIndex(h => /^(status|tila|tilanne)$/i.test(String(h).trim()));
  const balanceCol = (headers || []).findIndex(h => /^(balance|saldo|running balance|kirjattu saldo)$/i.test(String(h).trim()));
  const status = get(statusCol).toLowerCase();
  if (/^(pending|reservation|reserved|katevaraus|varaus|odottaa|gereserveerd)$/.test(status)) result.bankStatus = 'pending';
  else if (/^(executed|booked|posted|completed|kirjattu|toteutunut|geboekt)$/.test(status)) result.bankStatus = 'booked';
  const balance = get(balanceCol) ? parseAmount(get(balanceCol), { decimal }) : NaN;
  if (Number.isFinite(balance)) result.bankBalance = round2(balance);
  return result;
}

/**
 * The note an imported row carries: the text of its note columns joined
 * with " · ", a reference column prefixed with its header so the id reads
 * as one. Blank cells and a cell repeating the payee are left out.
 */
function noteFromColumns(row, noteCols, headers, payee) {
  if (!Array.isArray(noteCols) || !noteCols.length) return '';
  const parts = [];
  for (const idx of noteCols) {
    const v = idx >= 0 && idx < row.length ? String(row[idx]).trim() : '';
    if (!v || v === payee || parts.includes(v)) continue;
    const header = Array.isArray(headers) ? String(headers[idx] ?? '').trim() : '';
    parts.push(header && RE_NOTE_REF.some(re => re.test(header)) ? `${header} ${v}` : v);
  }
  return parts.join(' · ');
}

/**
 * `mapping` plus the decimal separator its amount columns prove across all
 * `rows` (`detectDecimalSeparator`), for `parseRow`.
 *
 * @template {{ amountCol: number, debitCol: number, creditCol: number }} M
 * @param {unknown[][]} rows
 * @param {M} mapping
 * @returns {M & { decimal?: ',' | '.' }}
 */
export function withDecimalHint(rows, mapping) {
  const cols = [mapping.amountCol, mapping.debitCol, mapping.creditCol].filter(c => c >= 0);
  const values = [];
  for (const r of rows || []) for (const c of cols) if (Array.isArray(r) && c < r.length) values.push(r[c]);
  return { ...mapping, decimal: detectDecimalSeparator(values) };
}

// ── Dedup fingerprint ─────────────────────────────────────────────────────────

// One expression, used by BOTH sides of the match: the fingerprint of an
// incoming row, and the index built over the existing ones. It was the same
// hand-written expression written out twice, which is the shape that
// duplicates an entire import batch the day one of the two changes.
const amountCents = (tx) => Math.round(txAbsAmount(tx) * 100);

export function txFingerprint(tx) {
  const payee = (tx.payee || '').toLowerCase().slice(0, 40);
  const cents  = amountCents(tx);
  return `${tx.date}|${cents}|${payee}`;
}

// ── Template persistence (stored in state.meta.csvTemplates) ──────────────────

export function getTemplates(meta) {
  return Array.isArray(meta?.csvTemplates) ? meta.csvTemplates : [];
}

// `updateMeta` is the shared meta-write queue (js/state/meta-writes.js),
// injected so this module stays free of storage imports. The patch reads the
// meta the previous queued write produced, not a snapshot taken here.

export async function addTemplate(state, template, updateMeta) {
  await updateMeta(state, meta => ({
    ...meta,
    csvTemplates: [...getTemplates(meta).filter(t => t.id !== template.id), template],
  }));
}

export async function removeTemplate(state, id, updateMeta) {
  await updateMeta(state, meta => ({
    ...meta,
    csvTemplates: getTemplates(meta).filter(t => t.id !== id),
  }));
}

// ── CSV-to-budget matching ────────────────────────────────────────────────────
// Matches parsed CSV rows against existing budget transactions by amount, date
// and payee. Each existing tx can be claimed by at most one CSV row.
//
// matchType (owner decision 2026-10-05):
//   'exact'    same amount, same day and a similar payee (payeesSimilar, the
//              normalised comparison in js/core/payee-cluster.js). Skipped by
//              default: this is the re-imported statement.
//   'possible' same amount within 10 days, but another day or another payee.
//              Imported by default and marked, so the user can untick it.
//   'none'     nothing comparable.
// Each result also carries `days` (the day distance) and `payeeMatch`.
//
// Claims are made best tier first across the whole file (exact, then a
// similar payee on another day, then any payee), so a row whose only fit is
// a loose one cannot take the transaction an exact row needed.

// Accepts either an ISO string or a Date. parseRow() returns Dates, and the
// old string-only form concatenated one into "Tue Feb 03 2026 …T12:00:00Z",
// which parses as NaN — so every candidate silently failed the `diff > 10`
// test and no CSV row ever matched an existing transaction.
function _asNoonUtc(value) {
  if (value instanceof Date) {
    return Date.UTC(value.getFullYear(), value.getMonth(), value.getDate(), 12);
  }
  return new Date(`${value}T12:00:00Z`).getTime();
}

function _absDaysDiff(a, b) {
  const ms = _asNoonUtc(a) - _asNoonUtc(b);
  if (Number.isNaN(ms)) return Infinity;
  return Math.abs(Math.round(ms / 86_400_000));
}

function _signCompatible(csvAmount, txType) {
  // Prefer directional match; fall through to true for ambiguous types
  if (csvAmount < 0) return !['income', 'fill'].includes(txType);
  if (csvAmount > 0) return !['expense', 'debt_payment'].includes(txType);
  return true;
}

/**
 * @param {Array} csvRows
 * @param {Array} existingTxs
 * @param {{accountId?: string|null, aliases?: Record<string, string>}=} opts  the account being imported into.
 *   When given, a candidate must have moved THAT account in the row's
 *   direction. Without it, a −20 Lidl row on checking was an exact duplicate
 *   of the same purchase on the credit card, and a −200 row matched a
 *   transfer INTO checking, and both rows were skipped by default. The
 *   type-only check below is the fallback for callers with no account
 *   (the assistant's attachment import).
 * @returns {Array<{csvRow: any, match: any, matchType: 'exact'|'possible'|'none', days?: number, payeeMatch?: boolean}>}
 */
export function matchCsvRows(csvRows, existingTxs, { accountId = null, aliases = {} } = {}) {
  const compatible = accountId
    ? (row, tx) => {
      const delta = txAccountDelta(tx, accountId);
      return delta !== 0 && Math.sign(delta) === Math.sign(row.amount);
    }
    : (row, tx) => _signCompatible(row.amount, tx.type);

  // Index by cents for fast candidate lookup
  const byAmount = new Map();
  for (const tx of existingTxs) {
    if (tx.is_forecast || tx.status === 'scheduled') continue;
    const cents = amountCents(tx);
    if (!byAmount.has(cents)) byAmount.set(cents, []);
    byAmount.get(cents).push(tx);
  }

  // Every usable (row, tx) pairing with its tier: 0 exact, 1 similar payee on
  // another day, 2 another payee.
  const options = csvRows.map((csvRow) => {
    const cents = Math.round(Math.abs(csvRow.amount) * 100);
    const out = [];
    for (const tx of byAmount.get(cents) || []) {
      if (!compatible(csvRow, tx)) continue;
      const days = _absDaysDiff(csvRow.date, tx.date);
      if (days > 10) continue;
      const payeeMatch = payeesSimilar(resolvePayeeAlias(csvRow.payee, aliases), tx.payee);
      const tier = payeeMatch ? (days === 0 ? 0 : 1) : 2;
      out.push({ tx, days, payeeMatch, tier });
    }
    return out;
  });

  const claimed = new Set();
  /** @type {Array<{ csvRow: any, match: any, matchType: 'exact'|'possible'|'none', days?: number, payeeMatch?: boolean }|null>} */
  const results = csvRows.map(() => null);
  for (const tier of [0, 1, 2]) {
    // Nearest pairs across the whole file first. A newest-first statement
    // must not consume an older same-amount purchase's same-day match.
    const pairs = options.flatMap((opts, i) => opts.filter(o => o.tier === tier).map(o => ({ ...o, i })))
      .sort((a, b) => a.days - b.days || a.i - b.i);
    for (const best of pairs) {
      const i = best.i;
      if (results[i] || claimed.has(best.tx.id)) continue;
      claimed.add(best.tx.id);
      results[i] = {
        csvRow: csvRows[i], match: best.tx, matchType: tier === 0 ? 'exact' : 'possible',
        days: best.days, payeeMatch: best.payeeMatch,
      };
    }
  }
  return results.map((r, i) => r || { csvRow: csvRows[i], match: null, matchType: 'none' });
}
