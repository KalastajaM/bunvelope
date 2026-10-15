// js/import/statement-balance.js — compare an account against the closing
// balance printed on the statement that was just imported.
//
// Why this exists rather than "import adjusts the balance":
//
// Banks re-date rows. A card payment appears as pending on the 1st and is
// re-exported as booked on the 4th, and if the second export slips past the
// duplicate matcher you now hold the same payment twice. The account quietly
// drifts from the bank by that amount, and nothing says so — the discovery is
// months later, by which point the offending pair is buried.
//
// The tempting fix is to have import post an adjustment so the balance always
// agrees. That is exactly wrong. The adjustment would cover the duplicate on
// the ACCOUNT side while the duplicate expense keeps draining its ENVELOPE, so
// the books balance and the budget silently doesn't. Worse, the drift is the
// only evidence the duplicate exists; papering over it destroys the signal and
// makes the error permanent.
//
// So this only ever compares and reports. Closing a real gap stays a
// deliberate act through Reconcile, which shows the transactions, lets the
// user find the duplicate, and writes an auditable adjustment only if they
// still want one.

import { computeAccountBalances } from '../engine.js';
import { round2 } from '../utils.js';

/**
 * The latest transaction date in a set of imported rows — the statement's
 * effective "as of". Rows carry either an ISO string or a Date.
 */
export function statementEndDate(rows) {
  let latest = '';
  for (const row of rows || []) {
    const raw = row && row.date;
    let iso = '';
    if (raw instanceof Date && !Number.isNaN(raw.getTime())) {
      const pad = n => String(n).padStart(2, '0');
      iso = `${raw.getFullYear()}-${pad(raw.getMonth() + 1)}-${pad(raw.getDate())}`;
    } else if (typeof raw === 'string') {
      iso = raw.slice(0, 10);
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(iso) && iso > latest) latest = iso;
  }
  return latest || null;
}

/**
 * Compare an account's ledger balance against the statement's closing figure.
 *
 * Compared on the bank's own terms: posted rows only, dated on or before the
 * statement's last day. A scheduled row or a transaction you entered for next
 * week has not reached the bank and must not count against a figure the bank
 * printed.
 *
 * Returns null when there is nothing to compare — no account, no figure, or no
 * usable date — so callers can skip silently rather than report a false match.
 * Otherwise { expected, actual, difference, matches, asOf }, where `difference`
 * is what the ledger is missing: positive means the statement holds more than
 * the ledger accounts for.
 */
export function checkStatementBalance({ accounts, transactions, accountId, statementBalance, rows }) {
  if (!accountId) return null;
  if (!Number.isFinite(statementBalance)) return null;
  const asOf = statementEndDate(rows);
  if (!asOf) return null;

  const balances = computeAccountBalances(accounts || [], transactions || [], {
    onlyPosted: true,
    asOf,
  });
  const actual = round2(balances.get(accountId) ?? 0);
  const expected = round2(statementBalance);
  const difference = round2(expected - actual);

  return { expected, actual, difference, matches: Math.abs(difference) < 0.005, asOf };
}
