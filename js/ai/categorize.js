// js/ai/categorize.js — decide which account and envelope each imported row
// belongs to.
//
// This runs on every row regardless of how it arrived: a cleanly parsed bank
// CSV gets categorized exactly like a photographed receipt, because choosing
// the envelope is the manual work worth removing, and it is unrelated to
// whether the file was machine-readable.
//
// The strongest input is not the model's world knowledge — it is how *this*
// user has booked *this* payee before. `buildPayeeDigest` computes that
// client-side, deterministically and for free, and it goes in the prompt
// rather than behind a tool call because every row needs it.

import { sendMessages } from './transport.js';
import { formatAiText } from './money-text.js';
import { currencySymbolFor } from './context-builder.js';

/** How many historical payees to include beyond those in the current batch. */
const TOP_PAYEES = 50;

/** Rows per request. Keeps any single response well inside its token budget. */
const BATCH_SIZE = 40;

const ASSIGN_ROWS_TOOL = {
  name: 'assign_rows',
  description: 'Assign an account and envelope to every row, in the order given.',
  input_schema: {
    type: 'object',
    properties: {
      assignments: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            index: { type: 'integer', description: 'The row index you were given.' },
            type: {
              type: 'string',
              enum: ['expense', 'income', 'account_transfer'],
              description: 'Direction of the transaction.',
            },
            account_id: { type: ['string', 'null'], description: 'Must be an id from the accounts list.' },
            transfer_account_id: {
              type: ['string', 'null'],
              description: 'account_transfer only: the account on the OTHER side of the transfer '
                + '(where money came from for direction "in", went to for "out"). An id from the '
                + 'accounts list, or null if you cannot tell.',
            },
            envelope_id: { type: ['string', 'null'], description: 'Must be an id from the envelopes list. Null if none fits.' },
            confidence: { type: 'number', description: '0 to 1. Be honest — the user reviews low scores first.' },
            rationale: { type: 'string', description: 'One short clause. Cite the payee history when that is why.' },
          },
          required: ['index', 'type', 'envelope_id', 'confidence'],
        },
      },
    },
    required: ['assignments'],
  },
};

// The user's calendar day, not UTC's. toISOString() is UTC, so a row dated
// 00:30 on 5 January in Helsinki went to the model as 4 January.
function localIsoDate(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function normalisePayee(payee) {
  return String(payee || '').trim().toLowerCase();
}

/**
 * How this user has historically booked each payee.
 *
 * Deterministic and pure — no network, no model. Includes every payee present
 * in `payees` (so the current batch is always covered even for a payee seen
 * once a year) plus the most frequent payees overall.
 *
 * @param {object} state
 * @param {Array<string>=} payees payees appearing in the batch being categorized
 * @returns {Array<{payee: string, envelope_id: string, account_id: string|null, count: number}>}
 */
export function buildPayeeDigest(state, payees = []) {
  const wanted = new Set(payees.map(normalisePayee).filter(Boolean));
  const byPayee = new Map();

  for (const tx of (state?.transactions || [])) {
    if (tx.is_forecast) continue;
    const key = normalisePayee(tx.payee);
    if (!key) continue;
    const envelopeId = tx.envelope_id
      || (Array.isArray(tx.envelope_splits) && tx.envelope_splits.length === 1
        ? tx.envelope_splits[0].envelope_id
        : null);
    if (!envelopeId) continue;

    let entry = byPayee.get(key);
    if (!entry) {
      entry = { payee: String(tx.payee).trim(), envelopes: new Map(), accounts: new Map(), total: 0 };
      byPayee.set(key, entry);
    }
    entry.total += 1;
    entry.envelopes.set(envelopeId, (entry.envelopes.get(envelopeId) || 0) + 1);
    const acct = tx.account || tx.from_account || null;
    if (acct) entry.accounts.set(acct, (entry.accounts.get(acct) || 0) + 1);
  }

  const pickTop = (map) => {
    let best = null;
    let bestCount = 0;
    for (const [id, count] of map) {
      // Ties break on id so the digest is stable between runs — an unstable
      // prompt would defeat prompt caching for no benefit.
      if (count > bestCount || (count === bestCount && best !== null && id < best)) {
        best = id;
        bestCount = count;
      }
    }
    return best;
  };

  const all = [...byPayee.entries()].map(([key, entry]) => ({
    key,
    payee: entry.payee,
    envelope_id: pickTop(entry.envelopes),
    account_id: pickTop(entry.accounts),
    count: entry.total,
  }));

  const inBatch = all.filter((e) => wanted.has(e.key));
  const rest = all
    .filter((e) => !wanted.has(e.key))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))
    .slice(0, TOP_PAYEES);

  return [...inBatch, ...rest]
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))
    .map(({ key, ...rest2 }) => { void key; return rest2; });
}

function buildContext(state, rows, today) {
  return {
    currency: state?.meta?.currency || 'EUR',
    currency_symbol: currencySymbolFor(state?.meta?.currency || 'EUR'),
    today,
    accounts: (state?.accounts || [])
      .filter((a) => !a.archived)
      .map((a) => ({ id: a.id, name: a.name, type: a.type || null })),
    envelopes: (state?.envelopes || [])
      .filter((e) => !e.archived)
      .map((e) => ({ id: e.id, name: e.name, category: e.category || null })),
    payee_history: buildPayeeDigest(state, rows.map((r) => r.payee)),
  };
}

/**
 * Categorize rows. Returns one entry per input row, aligned by index, with
 * nulls where the model declined or the response was short.
 *
 * @param {Array<{date: string, payee: string, amount: number}>} rows
 * @param {object} opts
 * @param {object} opts.state
 * @param {() => Date} opts.clock  required: where the prompt's `today` is
 *   read (the app's `now`), once for every batch; none reads the wall clock
 * @param {AbortSignal=} opts.signal
 * @param {(done: number, total: number) => void=} opts.onProgress
 * @returns {Promise<Array<object|null>>}
 */
export async function categorizeRows(rows, { state, clock, signal, onProgress } = {}) {
  if (typeof clock !== 'function') throw new TypeError('categorizeRows: a clock is required');
  const out = new Array(rows.length).fill(null);
  if (!rows.length) return out;
  const today = localIsoDate(clock());

  for (let start = 0; start < rows.length; start += BATCH_SIZE) {
    const slice = rows.slice(start, start + BATCH_SIZE);
    const assignments = await categorizeBatch(slice, { state, signal, today });
    for (const entry of assignments) {
      const globalIndex = start + entry.index;
      if (globalIndex >= 0 && globalIndex < out.length) out[globalIndex] = entry;
    }
    if (onProgress) onProgress(Math.min(start + BATCH_SIZE, rows.length), rows.length);
  }
  return out;
}

async function categorizeBatch(rows, { state, signal, today }) {
  const context = buildContext(state, rows, today);
  const payload = rows.map((r, index) => ({
    index,
    date: r.date instanceof Date ? localIsoDate(r.date) : String(r.date),
    payee: r.payee || '',
    // The model sees the magnitude and is told the direction separately, so it
    // never has to reason about our sign convention.
    amount: Math.abs(Number(r.amount) || 0),
    direction: Number(r.amount) < 0 ? 'out' : 'in',
  }));

  const message = await sendMessages({
    intent: 'categorize',
    tools: [ASSIGN_ROWS_TOOL],
    signal,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: `Budget:\n${JSON.stringify(context)}` },
        { type: 'text', text: `Rows to assign:\n${JSON.stringify(payload)}` },
        {
          type: 'text',
          text: 'Call assign_rows once with exactly one assignment per row, using the index given.',
        },
      ],
    }],
  });

  return readAssignments(message, rows.length, context);
}

/**
 * Extract and sanity-check the tool call. Exported for tests.
 *
 * Ids are re-checked here as well as in js/ai/proposal.js — belt and braces,
 * because this is where a bad id can still be attributed to the wrong row and
 * silently look plausible.
 */
export function readAssignments(message, rowCount, context) {
  const block = (message?.content || [])
    .find((b) => b.type === 'tool_use' && b.name === 'assign_rows');
  if (!block || !block.input) return [];

  const envelopeIds = new Set((context?.envelopes || []).map((e) => e.id));
  const accountIds = new Set((context?.accounts || []).map((a) => a.id));

  const seen = new Set();
  const out = [];
  for (const raw of (block.input.assignments || [])) {
    const index = Number(raw?.index);
    if (!Number.isInteger(index) || index < 0 || index >= rowCount) continue;
    // A repeated index means the model lost track of the list; the first
    // answer for a row is the one it reasoned about, so keep that.
    if (seen.has(index)) continue;
    seen.add(index);

    const envelopeId = envelopeIds.has(raw?.envelope_id) ? raw.envelope_id : null;
    const accountId = accountIds.has(raw?.account_id) ? raw.account_id : null;

    out.push({
      index,
      type: ['expense', 'income', 'account_transfer'].includes(raw?.type) ? raw.type : null,
      envelope_id: envelopeId,
      account_id: accountId,
      transfer_account_id: accountIds.has(raw?.transfer_account_id) ? raw.transfer_account_id : null,
      confidence: clamp01(raw?.confidence),
      rationale: raw?.rationale ? formatAiText(raw.rationale) : '',
    });
  }
  return out;
}

function clamp01(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.min(1, Math.max(0, n));
}
