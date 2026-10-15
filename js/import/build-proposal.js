// js/import/build-proposal.js — combine parsed rows, deterministic duplicate
// matches, and AI categorizations into one proposal.
//
// Kept separate from the sheet so the assembly is a pure function with tests
// rather than something only reachable by clicking through a file picker.

import { makeProposal, validateProposal } from '../ai/proposal.js';
import { payeeHistoryDefault } from './payee-defaults.js';

/**
 * Rows that still need categorizing: every row that will be imported, i.e.
 * all but the exact matches (same day, amount and payee). Re-importing a
 * statement therefore spends nothing on rows already in the budget; a
 * possible match is imported by default, so it is categorized too.
 *
 * @param {Array<{csvRow: object, match: object|null, matchType: string}>} matched
 */
export function rowsNeedingCategorization(matched) {
  return matched
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => entry.matchType !== 'exact')
    .map(({ entry, index }) => ({ ...entry.csvRow, __sourceIndex: index }));
}

/**
 * Assemble the proposal.
 *
 * @param {object} opts
 * @param {Array} opts.matched            output of matchCsvRows
 * @param {Array} opts.categorized        rowsNeedingCategorization order, may hold nulls
 * @param {Array} opts.needing            the array rowsNeedingCategorization returned
 * @param {object} opts.state
 * @param {string|null=} opts.defaultAccountId  account picked in the sheet
 * @param {number|null=} opts.declaredTotal
 * @param {string=} opts.source           'csv' | 'receipt' | 'statement' | 'dialog'
 * @param {number=} opts.skipped          rows the parser could not read
 * @returns {object} a validated proposal
 */
export function buildImportProposal({
  matched, categorized = [], needing = [], state,
  defaultAccountId = null, declaredTotal = null, source = 'csv', skipped = 0,
}) {
  // Map each categorization back to the row it belongs to. Going through the
  // recorded source index rather than positional order means a short or
  // reordered model response cannot silently shift every booking by one.
  const bySourceIndex = new Map();
  needing.forEach((row, i) => {
    const assignment = categorized[i];
    if (assignment) bySourceIndex.set(row.__sourceIndex, assignment);
  });

  const rows = matched.map((entry, index) => {
    const csvRow = entry.csvRow;
    const assignment = bySourceIndex.get(index) || null;
    // Only an exact match (same day, amount and payee) is left out. A
    // possible one is imported by default but carries a warning, so it sits
    // under "Needs a look" with the existing row named, to untick if it is
    // the same (owner decision 2026-10-05).
    const isDuplicate = entry.matchType === 'exact';
    const isPossible = entry.matchType === 'possible' && !!entry.match;
    // The model's categorization wins; a row it did not categorize (no key,
    // a failed batch, a short answer) defaults from the payee's history, as
    // a CSV import without AI does.
    const fromHistory = !assignment && !isDuplicate
      ? payeeHistoryDefault(state, csvRow.payee, csvRow.amount) : null;

    const row = {
      importSource: { key: `row:${index}`, payee: csvRow.payee, amount: csvRow.amount, account: defaultAccountId || null },
      date: csvRow.date,
      payee: csvRow.payee,
      amount: csvRow.amount,
      type: assignment?.type || fromHistory?.type || null,
      account_id: assignment?.account_id || defaultAccountId || null,
      envelope_id: assignment?.envelope_id || fromHistory?.envelope_id || null,
      ...(csvRow.note ? { note: csvRow.note } : {}),
      confidence: assignment ? assignment.confidence : null,
      rationale: assignment?.rationale || '',
      duplicateOf: isDuplicate ? (entry.match?.id || null) : null,
      // The amount is the bank's signed figure, not a model magnitude, so
      // validateProposal may hold the model's type to it (QA 2026-09-23 #1).
      bankSigned: true,
      import_account_id: defaultAccountId || null,
      counter_account: assignment?.transfer_account_id || null,
    };

    if (isDuplicate && entry.match) {
      row.duplicateMatch = {
        date: entry.match.date,
        payee: entry.match.payee || '',
        matchType: entry.matchType,
      };
      // A duplicate is not going to be written, so an absent categorization
      // is not a gap the user needs to see flagged.
      row.confidence = 1;
    }
    if (isPossible) {
      row.possibleDuplicateOf = entry.match.id;
      row.warnings = [{
        code: 'possible_duplicate',
        message: entry.match.date,
        payee: entry.match.payee || '',
        days: entry.days ?? null,
      }];
    }

    return row;
  });

  const warnings = [];
  if (skipped > 0) warnings.push({ code: 'rows_unreadable', message: String(skipped) });

  return validateProposal(
    makeProposal({
      kind: 'transactions',
      rows,
      warnings,
      meta: { source, declaredTotal },
    }),
    state,
  );
}
