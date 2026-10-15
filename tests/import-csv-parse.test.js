// tests/import-csv-parse.test.js — the generic bank-CSV parsing layer.
// A silent misparse here corrupts every transaction in an import batch,
// so the locale-format cases are pinned exhaustively.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  detectSeparator, parseCsv, detectColumns,
  parseDate, parseAmount, parseRow, rowProblem, csvShapeProblem, columnHasValues,
  txFingerprint, matchCsvRows, detectDecimalSeparator, withDecimalHint,
} from '../js/import/csv-parse-generic.js';
import { payeesSimilar } from '../js/core/payee-cluster.js';

describe('detectSeparator', () => {
  it('picks the most frequent of comma / semicolon / tab on the first line', () => {
    expect(detectSeparator('a,b,c\n1,2,3')).toBe(',');
    expect(detectSeparator('a;b;c')).toBe(';');
    expect(detectSeparator('a\tb\tc')).toBe('\t');
    expect(detectSeparator('Date;Payee, Inc;Amount')).toBe(';');
  });
});

describe('parseCsv', () => {
  it('handles quoted fields with embedded separators, newlines and "" escapes', () => {
    const text = 'date,payee,amount\n"2026-01-02","Bob ""The Builder"", Ltd",-5\n"a\nb",x,1';
    expect(parseCsv(text, ',')).toEqual([
      ['date', 'payee', 'amount'],
      ['2026-01-02', 'Bob "The Builder", Ltd', '-5'],
      ['a\nb', 'x', '1'],
    ]);
  });

  it('handles CRLF endings and drops trailing blank rows', () => {
    expect(parseCsv('a;b\r\n1;2\r\n;\r\n\r\n', ';')).toEqual([['a', 'b'], ['1', '2']]);
  });
});

describe('detectColumns', () => {
  it('maps localized headers and prefers debit/credit over a generic amount', () => {
    const cols = detectColumns(['Kirjauspäivä', 'Saaja', 'Summa', 'Menot', 'Tulot']);
    expect(cols.dateCol).toBe(0);
    expect(cols.payeeCol).toBe(1);
    expect(cols.debitCol).toBe(3);
    expect(cols.creditCol).toBe(4);
    expect(cols.amountCol).toBe(-1); // suppressed when debit/credit exist
  });

  it('falls back to the generic amount column', () => {
    const cols = detectColumns(['Date', 'Description', 'Amount']);
    expect(cols).toMatchObject({ dateCol: 0, payeeCol: 1, amountCol: 2 });
  });
});

describe('parseDate', () => {
  it('accepts ISO and rejects impossible ISO dates', () => {
    expect(parseDate('2026-01-15')).toBe('2026-01-15');
    expect(parseDate('2026-02-30')).toBe(null);
  });

  it('parses European D.M.Y / D/M/Y with 2- or 4-digit years', () => {
    expect(parseDate('15.1.2026')).toBe('2026-01-15');
    expect(parseDate('15/01/26')).toBe('2026-01-15');
    expect(parseDate('1-2-2026')).toBe('2026-02-01');
  });

  it('falls back to US M/D/Y only when day-first is impossible', () => {
    expect(parseDate('01/15/2026')).toBe('2026-01-15'); // month 15 impossible → US order
    // Ambiguous dates resolve day-first (documented European bias).
    expect(parseDate('02/03/2026')).toBe('2026-03-02');
  });

  it('strips a BOM and rejects garbage', () => {
    expect(parseDate('﻿2026-01-15')).toBe('2026-01-15');
    expect(parseDate('yesterday')).toBe(null);
    expect(parseDate('')).toBe(null);
  });
});

describe('parseAmount', () => {
  it('parses European decimal-comma format', () => {
    expect(parseAmount('1.234,56')).toBe(1234.56);
    expect(parseAmount('-12,5')).toBe(-12.5);
  });

  it('parses US/ISO decimal-dot format', () => {
    expect(parseAmount('1,234.56')).toBe(1234.56);
    expect(parseAmount('1234.56')).toBe(1234.56);
  });

  it('handles spaces, NBSP thousands separators and a leading plus', () => {
    expect(parseAmount(' 1 234,56 ')).toBe(1234.56);
    expect(parseAmount('1 234,56')).toBe(1234.56);
    expect(parseAmount('+5,00')).toBe(5);
  });

  // Owner decision 2026-10-02: one separator, comma or dot, is the decimal,
  // the same rule as typing an amount (parseAmountInput).
  it('reads a single separator as the decimal point, whatever follows it', () => {
    expect(parseAmount('-1,000')).toBe(-1);
    expect(parseAmount('1.000')).toBe(1);
    expect(parseAmount('1,234')).toBe(1.234);
    expect(parseAmount('1.234')).toBe(1.234);
    expect(parseAmount('0,125')).toBe(0.125);
    expect(parseAmount('1234,567')).toBe(1234.567);
    expect(parseAmount('12,50')).toBe(12.5);
  });

  it('reads a repeated separator as grouping', () => {
    expect(parseAmount('1.234.567')).toBe(1234567);
    expect(parseAmount('1,234,567')).toBe(1234567);
  });

  it('reads a lone separator as grouping only when the column proves the other one is the decimal', () => {
    expect(parseAmount('1.000', { decimal: ',' })).toBe(1000);
    expect(parseAmount('-1,000', { decimal: '.' })).toBe(-1000);
    expect(parseAmount('1,000', { decimal: ',' })).toBe(1);
    // Not a valid grouping shape, so still the decimal.
    expect(parseAmount('12.50', { decimal: ',' })).toBe(12.5);
  });

  it('returns NaN for empty or non-numeric input', () => {
    expect(parseAmount('')).toBeNaN();
    expect(parseAmount(null)).toBeNaN();
    expect(parseAmount('abc')).toBeNaN();
  });
});

describe('detectDecimalSeparator', () => {
  it('takes the last of two different separators, or the one a repeated grouping leaves', () => {
    expect(detectDecimalSeparator(['-12,50', '2.345,67', '1.000'])).toBe(',');
    expect(detectDecimalSeparator(['12.50', '2,345.67'])).toBe('.');
    expect(detectDecimalSeparator(['1.234.567'])).toBe(',');
  });

  it('proves nothing from lone separators or conflicting values', () => {
    expect(detectDecimalSeparator(['12,50', '1.000'])).toBeUndefined();
    expect(detectDecimalSeparator(['1.234,56', '1,234.56'])).toBeUndefined();
    expect(detectDecimalSeparator([])).toBeUndefined();
  });

  it('withDecimalHint reads the amount columns of every row', () => {
    const rows = [['2026-01-02', 'A', '1.000'], ['2026-01-03', 'B', '2.345,67']];
    const m = withDecimalHint(rows, { dateCol: 0, payeeCol: 1, amountCol: 2, debitCol: -1, creditCol: -1 });
    expect(m.decimal).toBe(',');
    expect(parseRow(rows[0], m).amount).toBe(1000);
    expect(parseRow(rows[0], { ...m, decimal: undefined }).amount).toBe(1);
  });
});

describe('parseRow', () => {
  const cols = { dateCol: 0, payeeCol: 1, amountCol: 2, debitCol: -1, creditCol: -1 };

  it('returns a normalized row for valid input', () => {
    expect(parseRow(['15.1.2026', 'Grocer', '-12,50'], cols))
      .toEqual({ date: '2026-01-15', payee: 'Grocer', amount: -12.5 });
  });

  it('signs amounts from debit/credit columns', () => {
    const dc = { dateCol: 0, payeeCol: 1, amountCol: -1, debitCol: 2, creditCol: 3 };
    expect(parseRow(['2026-01-15', 'Shop', '12,50', ''], dc).amount).toBe(-12.5);
    expect(parseRow(['2026-01-15', 'Employer', '', '1000'], dc).amount).toBe(1000);
  });

  it('rejects rows with bad dates or zero/NaN amounts', () => {
    expect(parseRow(['??', 'x', '5'], cols)).toBe(null);
    expect(parseRow(['2026-01-15', 'x', '0'], cols)).toBe(null);
    expect(parseRow(['2026-01-15', 'x', 'n/a'], cols)).toBe(null);
  });

  it('rejects a row whose amount rounds to zero, like a zero row (one sub-cent row must not refuse the whole import)', () => {
    expect(parseRow(['2026-01-15', 'x', '0.004'], cols)).toBe(null);
    expect(parseRow(['2026-01-15', 'x', '-0.004'], cols)).toBe(null);
    expect(parseRow(['2026-01-15', 'x', '0.005'], cols).amount).toBe(0.005);
    const dc = { dateCol: 0, payeeCol: 1, amountCol: -1, debitCol: 2, creditCol: 3 };
    expect(parseRow(['2026-01-15', 'Shop', '0.001', ''], dc)).toBe(null);
  });
});

describe('txFingerprint', () => {
  it('is stable across sign and payee case', () => {
    const a = txFingerprint({ date: '2026-01-15', amount: -12.5, payee: 'Grocer AB' });
    const b = txFingerprint({ date: '2026-01-15', amount: 12.5, payee: 'GROCER ab' });
    expect(a).toBe('2026-01-15|1250|grocer ab');
    expect(a).toBe(b);
  });
});

describe('matchCsvRows', () => {
  const txs = [
    { id: 't1', type: 'expense', amount: 12.5, date: '2026-01-15', payee: 'xxx' },
    { id: 't2', type: 'income', amount: 12.5, date: '2026-01-15', payee: 'xxx' },
    { id: 't3', type: 'expense', amount: 99, date: '2026-01-02', payee: 'xxx' },
  ];

  it('matches by amount with sign compatibility and date proximity', () => {
    const out = matchCsvRows(
      [{ date: '2026-01-15', payee: 'xxx', amount: -12.5 }],
      txs,
    );
    expect(out[0].match.id).toBe('t1'); // not the income t2
    expect(out[0].matchType).toBe('exact');
  });

  it('matches when given the Date objects parseRow actually returns', () => {
    // The live import path feeds Dates, not ISO strings. The day-distance
    // helper used to string-concatenate them into an invalid date, so every
    // comparison came back NaN and nothing ever matched.
    const out = matchCsvRows(
      [{ date: new Date(2026, 0, 15), payee: 'xxx', amount: -12.5 }],
      txs,
    );
    expect(out[0].match?.id).toBe('t1');
    expect(out[0].matchType).toBe('exact');
  });

  it('reports no match rather than NaN when a date is unusable', () => {
    const out = matchCsvRows(
      [{ date: 'not a date', payee: 'x', amount: -12.5 }],
      txs,
    );
    expect(out[0].matchType).toBe('none');
  });

  it('grades matches by day distance and claims each tx once', () => {
    const out = matchCsvRows(
      [
        { date: '2026-01-04', payee: 'xxx', amount: -99 }, // 2 days off → possible
        { date: '2026-01-04', payee: 'y', amount: -99 }, // t3 already claimed → none
        { date: '2026-01-30', payee: 'z', amount: -99 }, // 28 days off → none
      ],
      txs,
    );
    expect(out[0]).toMatchObject({ matchType: 'possible', days: 2, payeeMatch: true });
    expect(out[1]).toMatchObject({ matchType: 'none', match: null });
    expect(out[2]).toMatchObject({ matchType: 'none' });
  });

  it('matches positive csv amounts to income, not expenses', () => {
    const out = matchCsvRows(
      [{ date: '2026-01-15', payee: 'x', amount: 12.5 }],
      txs,
    );
    expect(out[0].match.id).toBe('t2');
  });
});

describe('matchCsvRows compares the payee (owner decision 6, 2026-10-05)', () => {
  const existing = [
    { id: 'lidl', type: 'expense', amount: 20, date: '2026-01-05', payee: 'Lidl', account: 'chk' },
    { id: 'alepa', type: 'expense', amount: 20, date: '2026-01-05', payee: 'Alepa Kamppi', account: 'chk' },
    { id: 'gym', type: 'expense', amount: 30, date: '2026-01-07', payee: 'Gym', account: 'chk' },
  ];

  it('calls a match exact only with the same day, amount and a similar payee', () => {
    const out = matchCsvRows([
      { date: '2026-01-05', payee: 'LIDL HELSINKI 1234', amount: -20 },
      { date: '2026-01-05', payee: 'ALEPA KAMPPI', amount: -20 },
    ], existing, { accountId: 'chk' });
    expect(out.map((r) => [r.match?.id, r.matchType])).toEqual([['lidl', 'exact'], ['alepa', 'exact']]);
  });

  it('leaves another payee on the same day a possible match', () => {
    const out = matchCsvRows([{ date: '2026-01-07', payee: 'Spotify', amount: -30 }], existing, { accountId: 'chk' });
    expect(out[0]).toMatchObject({ matchType: 'possible', days: 0, payeeMatch: false });
    expect(out[0].match.id).toBe('gym');
  });

  it('leaves the same payee on another day a possible match', () => {
    const out = matchCsvRows([{ date: '2026-01-08', payee: 'GYM OY', amount: -30 }], existing, { accountId: 'chk' });
    expect(out[0]).toMatchObject({ matchType: 'possible', days: 1, payeeMatch: true });
  });

  it('does not let a loose fit earlier in the file take the row an exact one needs', () => {
    const out = matchCsvRows([
      { date: '2026-01-05', payee: 'K-Market', amount: -20 },
      { date: '2026-01-05', payee: 'Lidl', amount: -20 },
      { date: '2026-01-05', payee: 'Alepa Kamppi', amount: -20 },
    ], existing, { accountId: 'chk' });
    expect(out[1]).toMatchObject({ matchType: 'exact' });
    expect(out[1].match.id).toBe('lidl');
    expect(out[2].match.id).toBe('alepa');
    // Both existing rows claimed by exact matches: the third is new.
    expect(out[0]).toMatchObject({ matchType: 'none', match: null });
  });
});

describe('payeesSimilar', () => {
  it('folds case, accents, store numbers and legal suffixes', () => {
    expect(payeesSimilar('Lidl', 'LIDL 1234')).toBe(true);
    expect(payeesSimilar('Café Regatta', 'CAFE REGATTA OY')).toBe(true);
    expect(payeesSimilar('K-Market Kamppi', 'K MARKET KAMPPI HELSINKI')).toBe(true);
    expect(payeesSimilar('Verkkokauppa.com', 'VERKKOKAUPA COM')).toBe(true);
  });
  it('keeps different payees apart and never matches an empty one', () => {
    expect(payeesSimilar('Lidl', 'Alepa')).toBe(false);
    expect(payeesSimilar('Prisma', 'Pirkko Return')).toBe(false);
    expect(payeesSimilar('', '')).toBe(false);
    expect(payeesSimilar('Lidl', null)).toBe(false);
    // A two-letter key is not a word-part match.
    expect(payeesSimilar('AB', 'AB Kauppa')).toBe(false);
  });
});

// ── QA 2026-09-23 ──────────────────────────────────────────────────────────

const fixture = (name) => readFileSync(
  fileURLToPath(new URL(`./fixtures/bank-csv/${name}`, import.meta.url)), 'utf8',
);

function parseExport(text) {
  const rows = parseCsv(text, detectSeparator(text));
  const headers = rows[0].map((h) => String(h).trim());
  const cols = { ...detectColumns(headers, rows.slice(1)), headers };
  return { cols, headers, rows: rows.slice(1).map((r) => parseRow(r, cols)) };
}

describe('real Finnish bank exports (QA 2026-09-23 #5)', () => {
  it('OP: reads Määrä, not the Arvopäivä value-date column', () => {
    const { cols, headers, rows } = parseExport(fixture('op.csv'));
    expect(headers[cols.amountCol]).toBe('Määrä EUROA');
    expect(headers[cols.dateCol]).toBe('Kirjauspäivä');
    expect(rows[0]).toMatchObject({ date: '2026-01-05', payee: 'LIDL HELSINKI KAMPPI', amount: -12.5 });
    // Viesti, Selitys and the archive id go into the note (UX 2026-10-05).
    expect(rows[0].note).toBe("'Viesti: 412345******1234' · KORTTIOSTO · Arkistointitunnus 20260105/5ABCDE/123456");
    expect(rows[1].amount).toBe(2450);
  });

  it('Nordea: reads Määrä, not Arvopäivä or Maksupäivä', () => {
    const { cols, headers, rows } = parseExport(fixture('nordea.csv'));
    expect(headers[cols.amountCol]).toBe('Määrä');
    expect(rows[0]).toMatchObject({ date: '2026-01-05', payee: 'LIDL HELSINKI', amount: -12.5 });
    expect(rows[1].amount).toBe(2450);
  });

  it('English "Value date" is a date, not an amount', () => {
    const cols = detectColumns(['Booking date', 'Value date', 'Amount', 'Description']);
    expect(cols.amountCol).toBe(2);
  });

  it('still accepts a column named exactly "Arvo" / "Value"', () => {
    expect(detectColumns(['Pvm', 'Kuvaus', 'Arvo']).amountCol).toBe(2);
    expect(detectColumns(['Date', 'Memo', 'Value']).amountCol).toBe(2);
  });

  it('parseAmount rejects date-shaped strings', () => {
    expect(parseAmount('05.01.2026')).toBeNaN();
    expect(parseAmount('2026-01-05')).toBeNaN();
    expect(parseAmount('5/1/2026')).toBeNaN();
    const cols = { dateCol: 0, payeeCol: 1, amountCol: 2, debitCol: -1, creditCol: -1 };
    expect(parseRow(['05.01.2026', 'x', '05.01.2026'], cols)).toBe(null);
  });
});

describe('parseAmount sign and currency forms (QA 2026-09-23 #7)', () => {
  it('reads a trailing minus as negative', () => {
    expect(parseAmount('12,50-')).toBe(-12.5);
    expect(parseAmount('1.234,50-')).toBe(-1234.5);
  });

  it('reads the Unicode minus sign', () => {
    expect(parseAmount('−12,50')).toBe(-12.5);
  });

  it('reads accounting parentheses as negative', () => {
    expect(parseAmount('(12.50)')).toBe(-12.5);
    expect(parseAmount('(1,234.50)')).toBe(-1234.5);
  });

  it('strips currency symbols and codes', () => {
    expect(parseAmount('€12,50')).toBe(12.5);
    expect(parseAmount('-€12,50')).toBe(-12.5);
    expect(parseAmount('12,50 €')).toBe(12.5);
    expect(parseAmount('EUR -12,50')).toBe(-12.5);
    expect(parseAmount('$1,234.56')).toBe(1234.56);
    expect(parseAmount('12,50 kr')).toBe(12.5);
  });

  it('handles NBSP and narrow-NBSP thousands separators', () => {
    expect(parseAmount('1 234,56')).toBe(1234.56);
    expect(parseAmount('-1 234,56')).toBe(-1234.56);
  });

  it('does not accept trailing garbage', () => {
    expect(parseAmount('12abc')).toBeNaN();
    expect(parseAmount('n/a')).toBeNaN();
  });
});

describe('parseDate impossible dates (QA 2026-09-23 #8)', () => {
  it('rejects day-first dates that do not exist', () => {
    expect(parseDate('31.02.2026')).toBe(null);
    expect(parseDate('31/04/2026')).toBe(null);
    expect(parseDate('29.02.2025')).toBe(null);
    expect(parseDate('29.02.2024')).toBe('2024-02-29');
  });

  it('rejects month-first dates that do not exist', () => {
    expect(parseDate('02/31/2026')).toBe(null);
    expect(parseDate('12/25/2025')).toBe('2025-12-25');
  });

  it('reads year-first slashed and dotted dates', () => {
    expect(parseDate('2026/01/05')).toBe('2026-01-05');
    expect(parseDate('2026.01.05')).toBe('2026-01-05');
    expect(parseDate('2026/02/30')).toBe(null);
  });
});

describe('matchCsvRows respects the import account (QA 2026-09-23 #6)', () => {
  const existing = [
    // Same Lidl purchase, but on the credit card, not checking.
    { id: 'cc', type: 'expense', amount: 20, date: '2026-01-05', account: 'acc-card' },
    // Money moved INTO checking: cannot be a −200 row on checking.
    { id: 'in', type: 'account_transfer', amount: 200, date: '2026-01-05', from_account: 'acc-sav', to_account: 'acc-chk' },
    // Money moved OUT of checking: a genuine −150 duplicate.
    { id: 'out', type: 'account_transfer', amount: 150, date: '2026-01-05', from_account: 'acc-chk', to_account: 'acc-sav' },
    { id: 'chk', type: 'expense', amount: 30, date: '2026-01-05', account: 'acc-chk' },
  ];

  it("does not match a row against another account's transaction", () => {
    const out = matchCsvRows([{ date: '2026-01-05', payee: 'Lidl', amount: -20 }], existing, { accountId: 'acc-chk' });
    expect(out[0]).toMatchObject({ matchType: 'none', match: null });
  });

  it('does not match an outflow against a transfer into the account', () => {
    const out = matchCsvRows([{ date: '2026-01-05', payee: 'x', amount: -200 }], existing, { accountId: 'acc-chk' });
    expect(out[0].matchType).toBe('none');
  });

  it('matches when the account moved the same way', () => {
    const out = matchCsvRows([
      { date: '2026-01-05', payee: 'x', amount: -150 },
      { date: '2026-01-05', payee: 'y', amount: -30 },
    ], existing, { accountId: 'acc-chk' });
    expect(out[0].match?.id).toBe('out');
    expect(out[1].match?.id).toBe('chk');
  });

  it('matches an inflow against the incoming transfer', () => {
    const out = matchCsvRows([{ date: '2026-01-05', payee: 'x', amount: 200 }], existing, { accountId: 'acc-chk' });
    expect(out[0].match?.id).toBe('in');
  });
});

describe('CSV template writers', () => {
  // A stand-in for the shared meta queue: runs the patch on the current meta.
  const fakeQueue = async (state, patch) => { state.meta = await patch(state.meta || {}); return state.meta; };

  it('addTemplate replaces a same-id template and keeps the rest of meta', async () => {
    const { addTemplate } = await import('../js/import/csv-parse-generic.js');
    const state = { meta: { currency: 'EUR', csvTemplates: [{ id: 'a', name: 'old' }, { id: 'b', name: 'B' }] } };
    await addTemplate(state, { id: 'a', name: 'new' }, fakeQueue);
    expect(state.meta.currency).toBe('EUR');
    expect(state.meta.csvTemplates).toEqual([{ id: 'b', name: 'B' }, { id: 'a', name: 'new' }]);
  });

  it('removeTemplate drops only that id', async () => {
    const { removeTemplate } = await import('../js/import/csv-parse-generic.js');
    const state = { meta: { csvTemplates: [{ id: 'a' }, { id: 'b' }] } };
    await removeTemplate(state, 'a', fakeQueue);
    expect(state.meta.csvTemplates).toEqual([{ id: 'b' }]);
  });
});

// ── UX 2026-10-05: Finnish payee and note columns, unreadable rows ─────────

describe('Finnish payee and note columns (UX 2026-10-05)', () => {
  const NORDEA = [
    'Kirjauspäivä;Määrä;Maksaja;Maksunsaaja;Nimi;Otsikko;Viitenumero;Valuutta',
    '2026/10/05;-112,95;;;Claude Max;Kortti;;EUR',
    '2026/10/03;25,00;;;Palautus Zalando;Hyvitys;;EUR',
  ].join('\n');
  const OP = [
    'Kirjauspäivä;Arvopäivä;Määrä EUROA;Laji;Selitys;Saaja/Maksaja;Saajan tilinumero;Viite;Viesti;Arkistointitunnus',
    '05.10.2026;05.10.2026;-564,70;101;Tilisiirto;Vastike Oy;FI1234567890123456;;Vastike lokakuu;20261005/001',
    '30.09.2026;30.09.2026;-2,50;101;Verkkomaksu;Lähitapiola;;;;20260930/008',
  ].join('\n');

  it('Nordea: payee is "Nimi", not the empty "Maksunsaaja"', () => {
    const { cols, headers, rows } = parseExport(NORDEA);
    expect(headers[cols.payeeCol]).toBe('Nimi');
    expect(rows[0]).toEqual({ date: '2026-10-05', payee: 'Claude Max', amount: -112.95, note: 'Kortti' });
    expect(rows[1].payee).toBe('Palautus Zalando');
  });

  it('OP: payee is "Saaja/Maksaja"; Viesti, Selitys and the archive id make the note', () => {
    const { cols, headers, rows } = parseExport(OP);
    expect(headers[cols.payeeCol]).toBe('Saaja/Maksaja');
    expect(cols.noteCols.map(i => headers[i])).toEqual(['Viesti', 'Selitys', 'Arkistointitunnus', 'Viite']);
    expect(rows[0].note).toBe('Vastike lokakuu · Tilisiirto · Arkistointitunnus 20261005/001');
    // A blank message leaves the other parts.
    expect(rows[1].note).toBe('Verkkomaksu · Arkistointitunnus 20260930/008');
  });

  it('prefers a payee column that holds something over an empty one', () => {
    const headers = ['Date', 'Payee', 'Description', 'Amount'];
    const rows = [['2026-01-01', '', 'Shop', '-1'], ['2026-01-02', ' ', 'Cafe', '-2']];
    expect(detectColumns(headers, rows).payeeCol).toBe(2);
    // Without rows (or with every candidate empty) the first candidate stays.
    expect(detectColumns(headers).payeeCol).toBe(1);
  });

  it('Maksaja and Saaja are payee columns, after Nimi, and an empty one gives way', () => {
    expect(detectColumns(['Pvm', 'Saaja', 'Maksaja', 'Summa']).payeeCol).toBe(2);
    const rows = [['1.1.2026', 'Shop', '', '-5']];
    expect(detectColumns(['Pvm', 'Saaja', 'Maksaja', 'Summa'], rows).payeeCol).toBe(1);
    expect(detectColumns(['Pvm', 'Saaja', 'Nimi', 'Summa'], [['1.1.2026', 'x', 'y', '-1']]).payeeCol).toBe(2);
  });

  it('a mapping without note columns returns the plain row', () => {
    const cols = { dateCol: 0, payeeCol: 1, amountCol: 2, debitCol: -1, creditCol: -1, noteCols: [] };
    expect(parseRow(['2026-01-01', 'x', '-1'], cols)).toEqual({ date: '2026-01-01', payee: 'x', amount: -1 });
  });

  it('columnHasValues', () => {
    expect(columnHasValues([['a', ''], ['b', ' ']], 1)).toBe(false);
    expect(columnHasValues([['a', ''], ['b', 'x']], 1)).toBe(true);
    expect(columnHasValues([['a']], -1)).toBe(false);
  });
});

describe('unreadable rows and files (UX 2026-10-05)', () => {
  const cols = { dateCol: 0, payeeCol: -1, amountCol: 1, debitCol: -1, creditCol: -1 };

  it('names why a row does not parse', () => {
    expect(rowProblem(['05.10.2026', 'abc'], cols)).toEqual({ reason: 'amount', value: 'abc' });
    expect(rowProblem(['31.02.2026', '-5,00'], cols)).toEqual({ reason: 'date', value: '31.02.2026' });
    expect(rowProblem(['unterminated;1\n'], cols)).toMatchObject({ reason: 'date' });
    expect(rowProblem(['05.10.2026', '0,00'], cols)).toEqual({ reason: 'zero', value: '0,00' });
    expect(rowProblem(['05.10.2026', '-5,00'], cols)).toBe(null);
  });

  it('debit/credit rows report both cells', () => {
    const dc = { dateCol: 0, payeeCol: -1, amountCol: -1, debitCol: 1, creditCol: 2 };
    expect(rowProblem(['05.10.2026', 'x', 'y'], dc)).toEqual({ reason: 'amount', value: 'x / y' });
  });

  it('tells a non-CSV or empty file from a CSV', () => {
    const shape = (text) => csvShapeProblem(text, parseCsv(text, detectSeparator(text)));
    expect(shape('this is not csv at all\u0000\u0001')).toBe('notCsv');
    expect(shape('just one column\nno separators here')).toBe('notCsv');
    expect(shape('')).toBe('empty');
    expect(shape('\uFEFF  \n')).toBe('empty');
    expect(shape('Date;Amount\n05.10.2026;-1')).toBe(null);
  });
});
