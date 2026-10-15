// transactions.transferPairs — the Clean-up check "expenses that are really
// transfers" (owner decision 7, 2026-10-05). Finds an expense on one of the
// budget's accounts and an income of the same amount on another, a few days
// apart at most, with the same payee: money moved between two own accounts
// but booked as spending and earning (a card bill paid from the bank, a
// savings withdrawal, a deposit returned). Each pair can be merged into one
// account transfer with transaction.mergeTransfer. Discovery only.
//
// Which rows count:
//   - posted rows only (no scheduled row), dated on or before `date`, and
//     both on or after `since` (default: twelve months before `date`);
//   - an `account` that is one of the budget's accounts, archived included,
//     and a different account on each side;
//   - not part of a reversal (`reverses` / `reversed_by`): a reversed row and
//     its reversal are an undo, not a move;
//   - payees that payeesSimilar calls the same, unless `anyPayee`. Without
//     that rule, refunds and reimbursements (a shop on the card, "Insurance
//     return" into the bank) outnumber the real transfers several times over;
//   - and not a refund: when only one payee says return / refund / payback
//     (or palautus, hyvitys, terugbetaling, retour), "Prisma" and "Prisma
//     return" are a purchase and its refund, however alike they read.
// Transfers are never a candidate: they are already what this proposes.
// Each row is in at most one pair: the same payee and the closest dates win,
// then the most recent.
//
// A pair the user marked "Not a transfer" is stored by its id
// (`incomeId|expenseId`) in `meta.transferPairDismissed`, UI state written by
// js/transfer-pairs-sheet.js. It is left out before the rows are paired, so
// either row may still pair with another partner, and is returned under
// `dismissed` instead (when it would otherwise be found), so the sheet can
// restore it. The CLI reads the same meta, so both list the same pairs.

import { ok } from '../result.js';
import { refDate } from '../lens-input.js';
import { isoDate } from '../context.js';
import { txAbsAmount } from '../../engine/tx-amounts.js';
import { payeesSimilar } from '../payee-cluster.js';
import { diagnosticAnswer } from '../diagnostics.js';

export const DEFAULT_PAIR_DAYS = 3;
export const DEFAULT_PAIR_LOOKBACK_MONTHS = 12;

const REFUND = /\b(returns?|refunds?|refunded|payback|paid back|palautus|hyvitys|terugbetaling|retour)\b/i;
const isRefundOf = (a, b) => REFUND.test(a || '') !== REFUND.test(b || '');

const dayNumber = (iso) => {
  const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number);
  return Date.UTC(y, m - 1, d) / 86_400_000;
};

/** @param {any} tx */
function leg(tx) {
  return {
    id: tx.id, date: tx.date, payee: tx.payee || '', account: tx.account,
    amount: txAbsAmount(tx), note: tx.note || null, cleared: !!tx.cleared,
    envelope_id: tx.envelope_id || null,
  };
}

export const DISMISSED_META_KEY = 'transferPairDismissed';

/**
 * `meta.transferPairDismissed` as a Set of pair ids, dropping anything malformed.
 * @param {any} meta
 * @returns {Set<string>}
 */
export function getDismissedTransferPairs(meta) {
  const raw = meta?.[DISMISSED_META_KEY];
  return new Set(Array.isArray(raw) ? raw.filter((x) => typeof x === 'string') : []);
}

/** @param {any} c */
function pairOf(c) {
  const date = c.income.date < c.expense.date ? c.income.date : c.expense.date;
  return {
    id: `${c.income.id}|${c.expense.id}`,
    incomeId: c.income.id,
    expenseId: c.expense.id,
    date,
    amount: txAbsAmount(c.income),
    days: c.apart,
    payeeMatch: c.payeeMatch,
    fromAccount: c.expense.account,
    toAccount: c.income.account,
    payee: c.income.payee || c.expense.payee || '',
    income: leg(c.income),
    expense: leg(c.expense),
  };
}

/** Newest first, then by id. */
const byDateDesc = (a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : (a.id < b.id ? -1 : 1));

/**
 * @param {{ transactions?: any[], accounts?: any[] }} data
 * @param {{ today: string, since: string, days: number, anyPayee: boolean, dismissed?: Set<string> }} opts
 * @returns {{ pairs: any[], dismissed: any[] }}
 */
export function findTransferPairs(data, { today, since, days, anyPayee, dismissed = new Set() }) {
  const own = new Set((data.accounts || []).map(a => a?.id).filter(Boolean));
  const usable = (data.transactions || []).filter(tx => tx
    && (tx.type === 'income' || tx.type === 'expense')
    && tx.status !== 'scheduled'
    && tx.account && own.has(tx.account)
    && typeof tx.date === 'string' && tx.date >= since && tx.date <= today
    && !tx.reverses && !tx.reversed_by
    && txAbsAmount(tx) > 0);

  const expensesByCents = new Map();
  for (const tx of usable) {
    if (tx.type !== 'expense') continue;
    const cents = Math.round(txAbsAmount(tx) * 100);
    if (!expensesByCents.has(cents)) expensesByCents.set(cents, []);
    expensesByCents.get(cents).push(tx);
  }

  const candidates = [];
  for (const income of usable) {
    if (income.type !== 'income') continue;
    const cents = Math.round(txAbsAmount(income) * 100);
    for (const expense of expensesByCents.get(cents) || []) {
      if (expense.account === income.account) continue;
      const apart = Math.abs(dayNumber(income.date) - dayNumber(expense.date));
      if (!(apart <= days)) continue;
      const payeeMatch = payeesSimilar(income.payee, expense.payee) && !isRefundOf(income.payee, expense.payee);
      if (!payeeMatch && !anyPayee) continue;
      candidates.push({ income, expense, apart, payeeMatch, id: `${income.id}|${expense.id}` });
    }
  }

  const dismissedPairs = candidates.filter(c => dismissed.has(c.id)).map(pairOf).sort(byDateDesc);
  const open = candidates.filter(c => !dismissed.has(c.id));

  open.sort((a, b) => (Number(b.payeeMatch) - Number(a.payeeMatch))
    || (a.apart - b.apart)
    || (a.income.date < b.income.date ? 1 : a.income.date > b.income.date ? -1 : 0));

  const used = new Set();
  const pairs = [];
  for (const c of open) {
    if (used.has(c.income.id) || used.has(c.expense.id)) continue;
    used.add(c.income.id);
    used.add(c.expense.id);
    pairs.push(pairOf(c));
  }
  pairs.sort(byDateDesc);
  return { pairs, dismissed: dismissedPairs };
}

export default {
  name: 'transactions.transferPairs',
  summary: 'Expenses that are really transfers: pairs of an expense and an income of equal amount on two different own accounts, at most `days` apart, with the same payee (normalised), neither scheduled nor part of a reversal. Each pair names incomeId and expenseId for transaction.mergeTransfer. Pairs dismissed as "Not a transfer" (meta.transferPairDismissed) are left out of pairs and listed under dismissed. Discovery only; nothing is merged.',
  input: { type: 'object', properties: {
    date: { type: 'date', description: 'As-of date: rows after it are left out (YYYY-MM-DD, default query clock)' },
    since: { type: 'date', description: `Earliest date either row may have (default ${DEFAULT_PAIR_LOOKBACK_MONTHS} months before date)` },
    days: { type: 'integer', minimum: 0, maximum: 10, description: `Most days between the two rows (default ${DEFAULT_PAIR_DAYS})` },
    anyPayee: { type: 'boolean', description: 'Also pair rows whose payees differ (many more refunds and reimbursements; default false)' },
  } },
  run(data, input, ctx) {
    const ref = refDate(input, ctx);
    const today = isoDate(ref);
    const since = input.since
      ?? isoDate(new Date(ref.getFullYear(), ref.getMonth() - DEFAULT_PAIR_LOOKBACK_MONTHS, ref.getDate(), 12));
    const days = input.days ?? DEFAULT_PAIR_DAYS;
    const { pairs, dismissed } = findTransferPairs(data, {
      today, since, days, anyPayee: input.anyPayee === true, dismissed: getDismissedTransferPairs(data.meta),
    });
    return ok(diagnosticAnswer({ pairs, dismissed, since, days }));
  },
};
