// js/ai/proposal.js — the object every AI surface produces and the review UI
// consumes, plus the guards that stand between a model's output and the
// ledger.
//
// Nothing in the AI layer writes. A propose tool builds one of these; the user
// approves it; only then does `proposalToRecordSteps` hand its rows to the
// session (one transaction.import). That ordering is the whole safety model, so the
// validation here is the load-bearing part of the feature — not a formality.
//
// Three guards, in `validateProposal`:
//
//   1. Ids are validated, not trusted. An envelope_id or account_id that is
//      not in this budget drops to null with a warning rather than being
//      written through.
//   2. Sign is never the model's output. Rows carry a positive magnitude and a
//      type; direction comes from the type. `proposalToRecordSteps` sends
//      only magnitudes, and the command records them by type.
//   3. The row sum is cross-checked against the document's own printed total
//      where one was read. A receipt's line items versus its printed total is
//      a genuinely verifiable invariant, and it is the check that catches a
//      misread digit.
//
// Pure functions. No DOM, no I/O.

import { round2, validateAmount, parseDate } from '../utils.js';
import { t } from '../ui/i18n.js';
import { formatAiText } from './money-text.js';

/** Transaction types a proposal is allowed to emit. */
const ALLOWED_TYPES = new Set(['expense', 'income', 'account_transfer', 'envelope_transfer']);

/** Tolerance for the declared-total cross-check, in currency units. */
const TOTAL_EPSILON = 0.011;

/**
 * Build an unvalidated proposal. Callers normally follow this with
 * `validateProposal`; kept separate so tests can construct a bad one.
 *
 * @param {object} opts
 * @param {'transactions'|'envelope-edit'} opts.kind
 * @param {Array} opts.rows
 * @param {Array=} opts.warnings
 * @param {object=} opts.meta
 */
export function makeProposal({ kind, rows, warnings = [], meta = {} }) {
  return {
    kind,
    rows: (rows || []).map((row) => ({ warnings: [], ...row })),
    warnings: [...warnings],
    meta: { ...meta },
  };
}

function warn(code, message, extra) {
  return extra ? { code, message, ...extra } : { code, message };
}

/**
 * Validate and repair a proposal against the live budget.
 *
 * Returns a new proposal — the input is not mutated, so a caller can show a
 * diff or fall back to the raw model output when debugging.
 *
 * @param {object} proposal
 * @param {object} state  app state (envelopes, accounts, transactions)
 * @returns {object} validated proposal
 */
export function validateProposal(proposal, state) {
  const envelopeIds = new Set((state?.envelopes || []).map((e) => e.id));
  const accountIds = new Set((state?.accounts || []).map((a) => a.id));

  const warnings = [...(proposal.warnings || [])];
  let droppedIds = 0;
  let droppedRows = 0;

  const rows = [];
  for (const raw of (proposal.rows || [])) {
    const rowWarnings = [...(raw.warnings || [])];

    // A row without a usable date or amount is not repairable — the model
    // could not read it, and inventing a value here would be exactly the
    // failure the guards exist to prevent.
    const date = normaliseDate(raw.date);
    const amount = validateAmount(raw.amount);
    if (!date || amount === null || amount === 0) {
      droppedRows += 1;
      continue;
    }

    let type = ALLOWED_TYPES.has(raw.type) ? raw.type : null;
    // Rows read from a bank file carry the bank's own sign (`bankSigned`, set
    // by js/import/build-proposal.js). That sign is a fact; the model's type
    // is a guess. Model-proposed dialog rows are positive magnitudes whose
    // sign means nothing, so only bank rows are checked.
    const bankSigned = raw.bankSigned === true;
    const inflow = amount > 0;
    if (!type) {
      // Fall back on the importer's own convention: a negative parsed amount
      // means money out. This is the one place a sign carries meaning, and it
      // is the parser's sign, not the model's.
      type = amount < 0 ? 'expense' : 'income';
    } else if (bankSigned) {
      const fits = type === 'account_transfer' || type === (inflow ? 'income' : 'expense');
      if (!fits) {
        // Trusting the model here turned a +15 refund typed "expense" into a
        // debit: the account moved 30 the wrong way and nothing said so. Take
        // the sign-consistent type and flag the row so it is reviewed first.
        const applied = inflow ? 'income' : 'expense';
        rowWarnings.push(warn('sign_mismatch', String(raw.type), { applied }));
        type = applied;
      }
    }

    let envelopeId = raw.envelope_id || null;
    if (envelopeId && !envelopeIds.has(envelopeId)) {
      rowWarnings.push(warn('unknown_envelope', String(raw.envelope_id)));
      envelopeId = null;
      droppedIds += 1;
    }

    let accountId = raw.account_id || null;
    if (accountId && !accountIds.has(accountId)) {
      rowWarnings.push(warn('unknown_account', String(raw.account_id)));
      accountId = null;
      droppedIds += 1;
    }

    // Transfer rows name their two sides in separate fields. Those need the
    // same treatment as envelope_id — a hallucinated `from_envelope_id` would
    // otherwise sail straight through to the ledger.
    const sides = {};
    for (const [field, known] of [
      ['from_envelope_id', envelopeIds], ['to_envelope_id', envelopeIds],
      ['from_account', accountIds], ['to_account', accountIds],
      ['counter_account', accountIds], ['import_account_id', accountIds],
    ]) {
      const value = raw[field] || null;
      if (!value) { sides[field] = null; continue; }
      if (known.has(value)) { sides[field] = value; continue; }
      rowWarnings.push(warn(
        known === envelopeIds ? 'unknown_envelope' : 'unknown_account',
        String(value),
      ));
      sides[field] = null;
      droppedIds += 1;
    }

    // An account transfer is one account (`account_id`, the one the review
    // shows) and the account on the other side (`counter_account`), with a
    // direction. For a bank row the direction is the bank's sign and "our"
    // side is the account being imported into; the model often names the
    // other account in account_id, so that is taken as the counterparty. A
    // transfer without both sides is not written: it is excluded by default
    // and proposalToRecordSteps refuses it, rather than landing half a
    // transfer with a null to_account.
    let transfer = {};
    if (type === 'account_transfer') {
      let own;
      let other;
      let direction;
      if (bankSigned) {
        own = sides.import_account_id || accountId;
        other = sides.counter_account
          || (accountId && accountId !== own ? accountId : null);
        direction = inflow ? 'in' : 'out';
      } else {
        own = sides.from_account || accountId;
        other = sides.to_account || sides.counter_account;
        direction = 'out';
      }
      if (other && other === own) other = null;
      accountId = own || null;
      transfer = {
        transfer_direction: direction,
        counter_account: other || null,
        from_account: direction === 'in' ? (other || null) : (own || null),
        to_account: direction === 'in' ? (own || null) : (other || null),
      };
      if (!own || !other) {
        rowWarnings.push(warn('transfer_needs_account', ''));
        transfer.excluded = true;
      }
    }

    rows.push({
      ...raw,
      ...sides,
      ...transfer,
      date,
      // Magnitude only. Direction lives in `type`.
      amount: round2(Math.abs(amount)),
      type,
      envelope_id: envelopeId,
      account_id: accountId,
      // Model-authored text. The prompts ask for ⟦amt:…⟧ tokens in all prose;
      // resolve them here so the review shows, and approval stores, the same
      // formatted text and no token ever reaches budget data.
      payee: formatAiText(raw.payee || '').trim(),
      ...(typeof raw.note === 'string' ? { note: formatAiText(raw.note) } : {}),
      confidence: clampConfidence(raw.confidence),
      rationale: raw.rationale ? formatAiText(raw.rationale) : '',
      duplicateOf: raw.duplicateOf || null,
      warnings: rowWarnings,
    });
  }

  if (droppedRows > 0) warnings.push(warn('rows_dropped', String(droppedRows)));
  if (droppedIds > 0) warnings.push(warn('unknown_ids', String(droppedIds)));

  // Guard 3: the document's own total against the sum of what was read.
  // Only meaningful for rows the model transcribed — duplicates are excluded
  // from the commit but were still printed on the document, so they count.
  const declared = validateAmount(proposal.meta?.declaredTotal);
  const computed = round2(rows.reduce((sum, r) => sum + r.amount, 0));
  if (declared !== null && Math.abs(Math.abs(declared) - computed) > TOTAL_EPSILON) {
    warnings.push(warn('total_mismatch', String(computed), { expected: Math.abs(declared) }));
  }

  return {
    kind: proposal.kind,
    rows,
    warnings,
    meta: {
      ...(proposal.meta || {}),
      ...(typeof proposal.meta?.summary === 'string' ? { summary: formatAiText(proposal.meta.summary) } : {}),
      computedTotal: computed,
    },
  };
}

function clampConfidence(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.min(1, Math.max(0, n));
}

function normaliseDate(value) {
  if (!value) return null;
  // parseRow (js/import/csv-parse-generic.js) hands back a Date, not a string.
  // Stringifying one first produces "Mon Aug 03 2026 …", which parseDate does
  // not accept — that silently dropped every row from a real CSV import.
  const d = value instanceof Date ? value : parseDate(String(value));
  if (!d || Number.isNaN(d.getTime())) return null;
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Rows the user would actually commit: everything not marked as a duplicate
 * of an existing transaction and not explicitly excluded in the review UI.
 */
export function committableRows(proposal) {
  return (proposal.rows || []).filter((r) => !r.duplicateOf && !r.excluded);
}

/**
 * Turn an approved proposal into `transaction.record` steps. This is the
 * boundary: the import sheet and the dialog send the steps' inputs as one
 * `transaction.import`, and the command builds and checks each row exactly as
 * `transaction.record` would. Every amount is a positive magnitude with a
 * type, so the model never gets to express a sign; the command supplies id,
 * timestamps and rounding.
 *
 * @param {object} proposal
 * @param {object} state
 * @returns {Array<{ name: 'transaction.record', input: object }>}
 */
export function proposalToRecordSteps(proposal, state) {
  const fallbackAccount = (state?.accounts || []).find((a) => !a.archived)?.id || null;

  return committableRows(proposal).map((row) => {
    const input = {
      type: row.type,
      amount: Math.abs(validateAmount(row.amount) ?? 0),
      date: row.date,
      // Resolved again at the write boundary: the review UI edits rows after
      // validateProposal, and stored data must never carry a ⟦amt:…⟧ token.
      payee: formatAiText(row.payee || ''),
      note: row.note ? formatAiText(row.note) : null,
      // Provenance: an imported row that later looks wrong should be traceable
      // back to the surface that produced it.
      source: proposal.meta?.source || 'ai-import',
    };

    if (row.type === 'account_transfer') {
      // Read from account_id + counter_account + direction rather than the
      // from/to validateProposal derived, because the review edits
      // account_id (and a counterparty picker edits counter_account) after
      // validation.
      const own = row.account_id || null;
      const other = row.counter_account || null;
      let from;
      let to;
      if (row.transfer_direction === 'in') { from = other; to = own; }
      else if (row.transfer_direction === 'out') { from = own; to = other; }
      else { from = row.from_account || own; to = row.to_account || null; }
      if (!from || !to || from === to) {
        const err = new Error(t('ai.proposal.warn.transfer_needs_account'));
        err.code = 'transfer_needs_account';
        throw err;
      }
      input.fromAccount = from;
      input.toAccount = to;
    } else if (row.type === 'envelope_transfer') {
      input.fromEnvelope = row.from_envelope_id || null;
      input.toEnvelope = row.to_envelope_id || row.envelope_id || null;
    } else {
      input.account = row.account_id || fallbackAccount;
      input.envelope = row.envelope_id || null;
      if (Array.isArray(row.envelope_splits) && row.envelope_splits.length > 1) {
        input.splits = row.envelope_splits.map((s) => ({
          envelope: s.envelope_id,
          amount: round2(Math.abs(validateAmount(s.amount) ?? 0)),
        }));
        input.envelope = null;
      }
    }

    return { name: 'transaction.record', input };
  });
}

/**
 * Rows whose confidence is low enough to deserve the user's attention first.
 * Anything without a confidence score counts as needing review — an absent
 * score is not a high one.
 */
export function needsReview(row) {
  return row.confidence === null || row.confidence < 0.7 || (row.warnings || []).length > 0;
}

/** Sort a copy of the rows so the ones needing attention come first. */
export function sortForReview(rows) {
  return [...rows].sort((a, b) => {
    const aNeeds = needsReview(a) ? 0 : 1;
    const bNeeds = needsReview(b) ? 0 : 1;
    if (aNeeds !== bNeeds) return aNeeds - bNeeds;
    const aConf = a.confidence === null ? -1 : a.confidence;
    const bConf = b.confidence === null ? -1 : b.confidence;
    if (aConf !== bConf) return aConf - bConf;
    return String(a.date).localeCompare(String(b.date));
  });
}
