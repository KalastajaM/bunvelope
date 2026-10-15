// Shared preparation for rows staged in a reconciliation.
import { matchCsvRows } from './csv-parse-generic.js';
import { payeeHistoryDefault } from './payee-defaults.js';
import { isoDate } from '../core/context.js';
import { getPayeeAliases } from '../core/payee-fields.js';

const accountKey = value => String(value || '').replace(/\s/g, '').toLowerCase();

// Deliberately only owner-account headers, never a recipient/counterparty IBAN.
export function csvSourceAccountColumn(headers) {
  return headers.findIndex(h => /^(account|account name|account number|own account|statement account|iban|tili|tilinumero|oma tili|rekening|rekeningnummer)$/i.test(String(h).trim()));
}

export function filterImportAccount(rows, accounts, accountId) {
  let excluded = 0;
  const unknown = new Set();
  const kept = rows.filter(row => {
    const key = accountKey(row.sourceAccount);
    const matches = key ? accounts.filter(a => [a.id, a.name, a.iban, a.accountNumber].some(v => v && accountKey(v) === key)) : [];
    if (matches.length !== 1) { unknown.add(row.sourceAccount || ''); return true; }
    if (matches[0].id === accountId) return true;
    excluded++;
    return false;
  });
  return { rows: kept, excluded, unknown: [...unknown], needsConfirmation: unknown.size > 0 };
}

export function prepareReconcileImport({ state, accountId, rows, filename = '' }) {
  const matched = matchCsvRows(rows, state.transactions || [], { accountId, aliases: getPayeeAliases(state.meta) });
  const prepared = [];
  matched.forEach(entry => {
    const row = entry.csvRow;
    if (entry.matchType === 'exact' && !row.importReviewed) return;
    if (row.bankStatus === 'pending' && !row.importReviewed) return;
    const historical = payeeHistoryDefault(state, row.payee, row.amount);
    const envelope = historical?.envelope_id || null;
    const tx = {
      date: row.date instanceof Date ? isoDate(row.date) : row.date, payee: row.payee || '', amount: Math.abs(row.amount),
      type: row.amount < 0 ? 'expense' : 'income', account: accountId,
      envelope_id: state.envelopes.some(e => e.id === envelope && !e.archived) ? envelope : null,
      note: row.note || null, source: 'reconcile-import', importFilename: filename,
      importMatch: row.importMatch || (entry.matchType === 'possible' ? entry.match : null),
    };
    prepared.push(tx);
  });
  return { rows: prepared, duplicates: matched.length - prepared.length };
}
