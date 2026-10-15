// js/import/ai-parse.js — read transactions out of a receipt photo, a scanned
// statement, or a CSV the deterministic parser could not make sense of.
//
// Output is the same `{ date, payee, amount }` shape `parseRow` emits
// (js/import/csv-parse-generic.js), with a signed amount — negative is money
// out — so everything downstream is blind to how the rows arrived.
//
// The model is also asked for the document's own printed total. That is not
// decoration: comparing it against the sum of the rows is the check that
// catches a misread digit, and it is applied in js/ai/proposal.js.

import { isoDate } from '../core/context.js';
import { sendMessages } from '../ai/transport.js';
import { parseDate, validateAmount, round2 } from '../utils.js';
import { fileToContentBlock } from './downscale.js';
import { getLang } from '../ui/i18n.js';
import { formatAiText } from '../ai/money-text.js';

const RECORD_ROWS_TOOL = {
  name: 'record_rows',
  description: 'Record the transactions transcribed from the document.',
  input_schema: {
    type: 'object',
    properties: {
      rows: {
        type: 'array',
        description: 'One entry per transaction line in the document, in document order.',
        items: {
          type: 'object',
          properties: {
            source_account: { type: ['string', 'null'], description: 'The statement owner account name or IBAN printed for this row, only if different from the document account. Never the payee or recipient account. Null if unknown.' },
            date: { type: 'string', description: 'ISO yyyy-mm-dd.' },
            payee: { type: 'string', description: 'Merchant, counterparty, or description.' },
            amount: {
              type: 'number',
              description: 'Negative for money out, positive for money in. Plain number, period decimal point.',
            },
          },
          required: ['date', 'payee', 'amount'],
        },
      },
      declared_total: {
        type: ['number', 'null'],
        description: 'The total printed on the document, verbatim. Null if it prints none. Do not compute this yourself.',
      },
      source_account: { type: ['string', 'null'], description: 'The statement owner account name or IBAN as printed. Never a recipient or counterparty account. Null if absent or the document covers multiple accounts.' },
      currency: { type: ['string', 'null'], description: 'ISO currency code if the document states one.' },
      notes: {
        type: ['string', 'null'],
        description: 'Anything that could not be read, or that the user should know about this document.',
      },
    },
    required: ['rows'],
  },
};

function userPrompt({ fallbackDate, locale, currency }) {
  return [
    'Transcribe every transaction in this document.',
    '',
    `The user's locale is ${locale}. Dates in this document are most likely day-first`,
    '(dd/mm/yyyy) and amounts may use a comma as the decimal separator.',
    currency ? `Their budget is in ${currency}.` : '',
    '',
    'A single receipt is usually one transaction — the total paid — not one row per',
    'line item, unless the user is clearly splitting it. A bank statement is one row',
    'per posted line.',
    '',
    `If a row has no date of its own, use the document's date. If the document has no`,
    `date at all, use ${fallbackDate}.`,
    '',
    'Call record_rows exactly once. Do not write any prose.',
  ].filter(Boolean).join('\n');
}

/**
 * Parse a picked file into importer rows.
 *
 * @param {File} file
 * @param {object} opts
 * @param {object} opts.state
 * @param {() => Date} opts.clock  required app clock, read once before file conversion
 * @param {AbortSignal=} opts.signal
 * @returns {Promise<{rows: Array, declaredTotal: number|null, currency: string|null, notes: string|null}>}
 */
export async function parseFileWithAi(file, { state, clock, signal } = {}) {
  if (typeof clock !== 'function') throw new TypeError('parseFileWithAi: a clock is required');
  const fallbackDate = isoDate(clock());
  const block = await fileToContentBlock(file);

  const message = await sendMessages({
    intent: 'parse_document',
    tools: [RECORD_ROWS_TOOL],
    signal,
    messages: [{
      role: 'user',
      content: [
        block,
        {
          type: 'text',
          text: userPrompt({
            fallbackDate,
            locale: getLang(),
            currency: state?.meta?.currency || null,
          }),
        },
      ],
    }],
  });

  return normaliseParseResult(message);
}

/**
 * Pull the tool call out of a Message and coerce it into importer rows.
 * Exported for tests — this is where a malformed model response has to fail
 * safely rather than produce plausible-looking nonsense.
 *
 * @param {object} message
 */
export function normaliseParseResult(message) {
  // Checked first: a refusal can carry a partial tool call, and reading that
  // would import rows from an answer the model did not finish.
  if (message?.stop_reason === 'refusal') {
    const err = new Error('The model declined to read this document.');
    err.code = 'ai_refused';
    throw err;
  }
  const block = (message?.content || [])
    .find((b) => b.type === 'tool_use' && b.name === 'record_rows');

  if (!block || !block.input || typeof block.input !== 'object') {
    const err = new Error('The document could not be read.');
    err.code = 'ai_bad_response';
    throw err;
  }

  const rows = [];
  for (const raw of (block.input.rows || [])) {
    const date = parseDate(String(raw?.date || ''));
    const amount = validateAmount(raw?.amount);
    // A row missing either is not repairable here. Dropping it is correct:
    // the proposal layer reports the count so the user knows something was
    // left out, which is recoverable. A guessed amount is not. A sub-cent
    // amount (0.004) rounds to zero as money: dropped like a zero row (as the
    // CSV parser does), or transaction.import would refuse every row for it.
    if (!date || amount === null || round2(Math.abs(amount)) === 0) continue;
    rows.push({
      date,
      payee: formatAiText(raw?.payee || '').trim(),
      amount: round2(amount),
      ...(raw.source_account || block.input.source_account ? { sourceAccount: String(raw.source_account || block.input.source_account).trim() } : {}),
    });
  }

  const declared = validateAmount(block.input.declared_total);

  return {
    rows,
    declaredTotal: declared,
    currency: block.input.currency ? String(block.input.currency) : null,
    notes: block.input.notes ? formatAiText(block.input.notes) : null,
    skipped: (block.input.rows || []).length - rows.length,
  };
}
