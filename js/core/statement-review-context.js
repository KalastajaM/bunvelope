import { txAccountDelta, txAbsAmount } from '../engine.js';
import { getPayeeAliases } from './payee-fields.js';

// Only the inputs that affect this account's matching and balance. Explicit
// tuples make object-key order immaterial and avoid copying notes/history.
export function statementReviewContext(data, accountId) {
  const account = (data.accounts || []).find(a => a.id === accountId);
  return JSON.stringify([accountId, account?.initialBalance ?? 0, account?.type, !!account?.archived,
    (data.transactions || []).filter(tx => txAccountDelta(tx, accountId) !== 0).map(tx => [
      tx.id, tx.date, tx.type, txAbsAmount(tx), txAccountDelta(tx, accountId), tx.payee || '',
      tx.status || '', !!tx.cleared, !!tx.is_forecast,
    ]), Object.entries(getPayeeAliases(data.meta)).sort(([a], [b]) => a.localeCompare(b)),
  ]);
}
