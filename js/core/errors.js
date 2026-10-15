// js/core/errors.js — the catalogue of DomainError codes. The text for each
// lives in the i18n dictionaries under `coreError.*`, so the UI and the CLI
// show the same words. `describeError` takes `t` as a parameter: core never
// imports UI code.

export const ERROR_CODES = Object.freeze([
  'unknown_command',
  'unknown_query',
  'unknown_policy',
  'bad_input',
  'code_invalid',
  'code_taken',
  'code_exhausted',
  'ref_not_found',
  'ref_ambiguous',
  'unknown_tx_type',
  'invalid_collection',
  'diff_conflict',
  'undo_stale',
  'no_budget',
  'budget_switched',
  'budget_loading',
  'write_failed',
  'version_conflict',
  'ledger_set_line',
  'ledger_future_posted',
  'ledger_history_locked',
  'field_required',
  'field_not_allowed',
  'same_account',
  'same_envelope',
  'sell_needs_units',
  'split_invalid',
  'tx_not_found',
  'not_scheduled',
  'already_reversed',
  'reverse_unsupported',
  'note_required',
  'target_required',
  'reconcile_investment',
  'reconcile_gap_changed',
  'funding_preview_changed',
  'reconcile_undated',
  'holding_has_history',
  'fill_needs_lines_or_template',
  'fill_already_this_month',
  'occurrence_tombstoned',
  'fill_source_conflict',
  'fill_nothing_to_fund',
  'in_use',
  'name_taken',
  'not_permutation',
  'not_found',
  'import_review_changed',
  'month_not_ended',
]);

/** @param {string} code */
export function errorKey(code) {
  return `coreError.${code.replace(/_([a-z])/g, (_, c) => c.toUpperCase())}`;
}

/**
 * @param {{ code: string, params?: Record<string, any> }} error
 * @param {(key: string) => any} t
 * @returns {string}
 */
export function describeError(error, t) {
  const key = error.code === 'undo_stale' && error.params?.reason === 'budget_changed'
    ? 'coreError.undoBudgetChanged' : errorKey(error.code);
  const entry = t(key);
  if (typeof entry === 'function') return String(entry(error.params || {}));
  if (typeof entry === 'string' && entry !== key) return entry;
  return error.code;
}
