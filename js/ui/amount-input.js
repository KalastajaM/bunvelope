// Lightweight helper: turn an amount input into one that accepts simple
// arithmetic expressions ("1000-750" → 250). The expression is evaluated
// on blur and on Enter. While typing, the raw string is preserved so the
// user can edit freely.
//
// The helper switches `type="number"` to `type="text"` so operator keys
// can be typed; min/max are preserved as data attributes for clamping.
//
// Evaluation uses an in-house recursive-descent parser rather than
// `Function()` / `eval()`, since the app's CSP forbids `'unsafe-eval'`.

import { round2 } from '../utils.js';
import { t } from './i18n.js';

const SAFE_EXPR = /^[\d\s+\-*/().,]+$/;
const PCT_RE = /^\s*(-?\d+(?:[.,]\d+)?)\s*%\s*$/;

// Pure: read a live amount-field value as a number, accepting comma as the
// decimal separator ("50,34" → 50.34) — the same normalization `evaluate`
// applies on blur/Enter. Handlers that run *before* that normalization
// (input-time clamping, change-time auto-add, validation sums) must parse
// through this instead of bare parseFloat, which silently truncates at the
// comma ("50,34" → 50). Returns NaN when no number can be read; stays as
// lenient as parseFloat on partial input ("50," → 50) so mid-typing reads
// keep working.
//
// Grouped input is the case this used to get wrong, and get wrong SILENTLY:
// the app renders "€ 1 234,56", and pasting that straight back into an
// amount field read 1 — a thousandfold error that looked like a typo. The
// rules now:
//
//   • Whitespace (including the no-break space fi-FI groups with) and
//     currency symbols are dropped wherever they appear, and U+2212 — the
//     minus sign the app prints — is accepted as a minus.
//   • When BOTH ',' and '.' are present, the LAST one is the decimal
//     separator and the other is grouping. That reads "1,234.56" and
//     "1.234,56" correctly, which matters for a three-locale app.
//   • A separator that repeats is grouping: "1.234.567" is a million.
//   • A separator that appears once stays the decimal point, which is the
//     only genuinely ambiguous case ("1,234") and keeps its old meaning.
// Submit-time validation opts into strict parsing so trailing junk cannot
// silently become a smaller valid amount; live callers keep partial reads.
export function parseAmountInput(value, { strict = false } = {}) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : NaN;
  if (typeof value !== 'string') return NaN;
  let s = value
    .replace(/\s/gu, '')
    .replace(/\p{Sc}/gu, '')
    .replace(/\u2212/gu, '-');
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  if (lastComma >= 0 && lastDot >= 0) {
    const decimal = lastComma > lastDot ? ',' : '.';
    const grouping = decimal === ',' ? '.' : ',';
    s = s.split(grouping).join('').replace(decimal, '.');
  } else if (lastComma >= 0 && s.indexOf(',') !== lastComma) {
    s = s.split(',').join('');
  } else if (lastDot >= 0 && s.indexOf('.') !== lastDot) {
    s = s.split('.').join('');
  } else {
    s = s.replace(',', '.');
  }
  const n = strict ? (s ? Number(s) : NaN) : parseFloat(s);
  return Number.isFinite(n) ? n : NaN;
}

// Recursive-descent parser for: + - * / unary-minus parentheses.
// Throws on malformed input; caller catches and leaves the value alone.
// Exported for direct unit testing — `enableFormulaInput` is the public API.
export function evalExpression(src) {
  let i = 0;
  const peek = () => src[i];
  const eat = () => src[i++];
  const skipWs = () => { while (i < src.length && /\s/.test(src[i])) i++; };

  function parseNumber() {
    skipWs();
    const start = i;
    while (i < src.length && /[\d.]/.test(src[i])) i++;
    if (start === i) throw new Error('expected number');
    const n = Number(src.slice(start, i));
    if (!Number.isFinite(n)) throw new Error('bad number');
    return n;
  }

  function parseFactor() {
    skipWs();
    const c = peek();
    if (c === '(') {
      eat();
      const v = parseExpr();
      skipWs();
      if (peek() !== ')') throw new Error('unbalanced paren');
      eat();
      return v;
    }
    if (c === '-') { eat(); return -parseFactor(); }
    if (c === '+') { eat(); return  parseFactor(); }
    return parseNumber();
  }

  function parseTerm() {
    let v = parseFactor();
    skipWs();
    while (peek() === '*' || peek() === '/') {
      const op = eat();
      const rhs = parseFactor();
      v = op === '*' ? v * rhs : v / rhs;
      skipWs();
    }
    return v;
  }

  function parseExpr() {
    let v = parseTerm();
    skipWs();
    while (peek() === '+' || peek() === '-') {
      const op = eat();
      const rhs = parseTerm();
      v = op === '+' ? v + rhs : v - rhs;
      skipWs();
    }
    return v;
  }

  const result = parseExpr();
  skipWs();
  if (i !== src.length) throw new Error('trailing input');
  return result;
}

export function enableFormulaInput(input, { decimals = 2 } = {}) {
  if (!input || input.dataset.formulaWired === '1') return input;
  input.dataset.formulaWired = '1';
  // Evaluation precision: 2dp for money, higher for unit/price/rate fields.
  const factor = 10 ** decimals;

  if (input.type === 'number') {
    if (input.min !== '') input.dataset.min = input.min;
    if (input.max !== '') input.dataset.max = input.max;
    input.removeAttribute('step');
    input.removeAttribute('min');
    input.removeAttribute('max');
    input.type = 'text';
    if (!input.inputMode) input.inputMode = 'decimal';
  }
  input.autocomplete = input.autocomplete || 'off';
  input.title = input.title || t('common.formulaTip');

  const clamp = (n) => {
    const min = input.dataset.min !== undefined ? Number(input.dataset.min) : NaN;
    const max = input.dataset.max !== undefined ? Number(input.dataset.max) : NaN;
    if (Number.isFinite(min) && n < min) n = min;
    if (Number.isFinite(max) && n > max) n = max;
    return n;
  };

  const evaluate = () => {
    const raw = input.value.trim();
    if (!raw) return;
    if (!SAFE_EXPR.test(raw)) return;
    const tail = raw.startsWith('-') ? raw.slice(1) : raw;
    const hasOperator = /[+\-*/]/.test(tail);
    const expr = raw.replace(/,/g, '.');
    // Plain dot-decimal with no operator — leave it alone.
    if (!hasOperator && expr === raw) return;
    let result;
    try {
      result = hasOperator ? evalExpression(expr) : Number(expr);
    } catch {
      return;
    }
    if (typeof result !== 'number' || !Number.isFinite(result)) return;
    const rounded = clamp(Math.round(result * factor) / factor);
    if (String(rounded) === input.value) return;
    input.value = String(rounded);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  };

  input.addEventListener('blur', evaluate);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') evaluate();
  });
  return input;
}

export function looksLikeFormula(str) {
  if (!str) return false;
  const tail = String(str).trim().replace(/^-/, '');
  return /[+\-*/]/.test(tail);
}

export function looksLikePercentage(str) {
  if (!str) return false;
  return PCT_RE.test(String(str));
}

// Pure: returns the numeric amount represented by "X%" of `base`, or null when
// `raw` doesn't match the percentage syntax or `base` isn't a positive finite
// number. Does not clamp — callers apply their own bounds (e.g. the split-row
// input handler already clamps to remaining via its `maxVal` check).
export function evalPercent(raw, base) {
  if (typeof raw !== 'string') return null;
  const m = raw.match(PCT_RE);
  if (!m) return null;
  if (!Number.isFinite(base) || base <= 0) return null;
  const pct = Number(m[1].replace(',', '.'));
  if (!Number.isFinite(pct)) return null;
  return round2((pct / 100) * base);
}

// Wires blur + Enter so that "X%" is converted in-place to its numeric
// equivalent. `getBase` returns the value the percentage is taken of; it is
// invoked lazily so callers can read live DOM state. After conversion the
// helper dispatches `input` + `change` so existing row listeners (clamping,
// auto-add-next-row) react exactly as they would for a typed number.
export function enablePercentageInput(input, getBase) {
  if (!input || input.dataset.percentWired === '1') return input;
  input.dataset.percentWired = '1';
  const tip = 'type 50% to take 50% of the remaining amount';
  input.title = input.title && input.title.includes('formula')
    ? input.title.replace(/\.$/, '') + `, or ${tip}.`
    : `Tip: ${tip}.`;

  const evaluate = () => {
    const result = evalPercent(input.value, Number(getBase()));
    if (result === null) return;
    const out = result.toFixed(2);
    if (out === input.value) return;
    input.value = out;
    input.dispatchEvent(new Event('input',  { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  };

  input.addEventListener('blur', evaluate);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') evaluate(); });
  return input;
}
