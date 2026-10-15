// Shared discovery only: queries never apply a proposed repair.
import { findDuplicateGroups, getDismissedPairs } from './duplicate-finder.js';
import { findUnlinkedScheduledPayments } from '../engine/envelope-forecast.js';

// Evidence can contain optional/malformed stored fields. Normalize it to the
// JSON transport shape and detach it so callers cannot mutate the ledger.
export const diagnosticAnswer = (value) => JSON.parse(JSON.stringify(value));

export function duplicateGroups(data, includeDismissed = false) {
  return diagnosticAnswer(findDuplicateGroups({
    transactions: data.transactions || [],
    dismissed: includeDismissed ? new Set() : getDismissedPairs(data.meta),
  }).map(group => ({ ...group, ids: group.rows.map(row => row.id) })));
}

export function unlinkedPayments(data, today, envelopeId = null) {
  return diagnosticAnswer(findUnlinkedScheduledPayments({
    budgetItems: data.budgetItems || [], envelopes: data.envelopes || [],
    transactions: data.transactions || [], accounts: data.accounts || [],
    tombstones: data.meta?.scheduledTombstones || [],
    country: data.meta?.country ?? 'FI', today, envelopeId,
  }));
}
