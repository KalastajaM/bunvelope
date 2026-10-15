// js/engine/card-settlement.js — credit cards paid off in the forecast.
//
// A credit card the household clears every month should not accumulate the
// plan's spending in a forecast: in reality the debt is paid from a current
// account, which is where the spending ends up. Without that, a 10-year
// projection walks a card down to hundreds of thousands owed while the
// account that really pays it looks rich (owner decision 2026-10-05).
//
// The rule is Budget's step 6, which `forecast.balances` has offered as its
// `cards: 'settle-15th'` assumption since 2026-10-01: from today's month to
// the horizon, on the 15th (or the month's last day when shorter), a card owes
// minus its balance on the previous month's last day, and that is paid from
// the funding account as an `account_transfer`. A month in which any transfer
// or debt payment into the card is already dated is skipped: the user pays it
// by hand. Under a cent is nothing owed; a card in credit owes nothing.
//
// Which cards settle, and from where: `settledFrom` on a credit card — or on
// a bank or cash account used as one, such as a debit-card account topped up
// from the main account — names the account that pays it (`cardFundingFor`).
// The rule is the same: what the account is below zero at a month-end is
// paid in on the 15th. The Forecast lens adds those cards' settlements to
// its rows (`withCardSettlements`), so every forecast surface — the Accounts page under Forecast, the projection walk
// (simulation.js) and the long net-worth line built on its last year — sees
// the paying account carry the spending and the card stay at about a month's
// spending. Without `settledFrom` nothing changes.
//
// Pure. The dates are parameters; no clock is read. Balances are walked in
// whole cents, the rule `computeAccountBalances` uses, so a settlement is
// exactly the balance that function reports at the month-end.

import { computeScheduledOccurrences } from './scheduling.js';
import { isTargetTransfer, resolveTargetTransfers } from './target-transfers.js';
import { round2 } from '../utils.js';
import { applyAccountEffects } from './balances.js';

const SETTLE_DAY = 15;
const CENT = 0.005;

/** The account types `settledFrom` applies to: the ones a card is kept as. */
export const SETTLED_TYPES = Object.freeze(['credit_card', 'bank', 'cash']);

// The account types that cannot pay a card off: another card, and money that
// is not cash (investments, assets, loans).
const NON_PAYER_TYPES = Object.freeze(['credit_card', 'investment', 'asset', 'loan', 'loan_given']);

/**
 * Whether an account's type can pay a card off: cash-like money (bank, cash,
 * savings, or a legacy type such as checking), not a card, an investment, an
 * asset or a loan. Archived or not is the caller's question.
 *
 * @param {any} account
 * @returns {boolean}
 */
export function canPayCards(account) {
  return !!account && !NON_PAYER_TYPES.includes(account.type);
}

/**
 * @typedef {{
 *   id: string, type: 'account_transfer', date: string, amount: number,
 *   from_account: string, to_account: string, is_forecast: true,
 *   status: 'scheduled', forecast_kind: 'card-settlement',
 * }} CardSettlementRow
 */

const pad2 = (/** @type {number} */ n) => String(n).padStart(2, '0');

/**
 * Days in month `m` (1-12) of year `y`, by arithmetic: no Date, no zone.
 * @param {number} y @param {number} m
 */
function daysInMonth(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return [4, 6, 9, 11].includes(m) ? 30 : 31;
}

/**
 * The account a card is settled from, or null when it is not settled in the
 * forecast: the card is archived or not of a `SETTLED_TYPES` type, it names
 * no account, or the account it names is missing, archived, itself or not of
 * a type that can pay one (`canPayCards`). Settling stops (the card accumulates again) rather
 * than failing.
 *
 * @param {any} card
 * @param {any[]} accounts
 * @returns {string | null}
 */
export function cardFundingFor(card, accounts) {
  if (!card || card.archived || !SETTLED_TYPES.includes(card.type)) return null;
  const id = card.settledFrom;
  if (typeof id !== 'string' || !id || id === card.id) return null;
  const payer = (accounts || []).find(a => a && a.id === id);
  if (!payer || payer.archived || !canPayCards(payer)) return null;
  return id;
}

/**
 * The settlements, month by month from today's month through `endIso`, for
 * every non-archived account `fundingFor` gives a funding account (a "card"
 * below). Each month reads the
 * balances with the earlier months' settlements in, so a chain settles what
 * is left after the previous one. `rows` is not mutated.
 *
 *   - the settlement date is day min(15, last day of the month), after
 *     `todayIso` and on or before `endIso`;
 *   - a card owes -(its balance on the previous month's last day), its
 *     `initialBalance` and every row dated then or earlier (undated rows
 *     too) counted; under a cent is nothing owed;
 *   - a month in which an account_transfer or debt_payment into the card is
 *     already dated is skipped. The whole month counts, not only up to
 *     `endIso`, so the real rows (`booked`, any date) are checked as well as
 *     `rows`, which a lens caps at its horizon.
 *
 * @param {any[]} accounts
 * @param {any[]} rows  the rows the balances are computed over
 * @param {{ fundingFor: (card: any) => string | null, todayIso: string, endIso: string, booked?: any[], budgetItems?: any[], country?: string }} opts
 * @returns {CardSettlementRow[]} the settlement rows, in date order
 */
export function cardSettlementRows(accounts, rows, { fundingFor, todayIso, endIso, booked = [], budgetItems = [], country = 'FI' }) {
  /** @type {Map<string, string>} card id -> funding account id */
  const funding = new Map();
  for (const a of accounts || []) {
    if (!a || a.archived) continue;
    const from = fundingFor(a);
    if (from) funding.set(a.id, from);
  }
  /** @type {CardSettlementRow[]} */
  const added = [];
  if (!funding.size || typeof todayIso !== 'string' || typeof endIso !== 'string') return added;

  // Each card's movements in date order (undated first, as `filterTransactions`
  // keeps an undated row under any cut-off), and the months already paid.
  /** @type {Array<{ d: string, id: string, cents: number }>} */
  const moves = [];
  /** @type {Set<string>} `${card}|${YYYY-MM}` */
  const paid = new Set();
  const notePaid = (/** @type {any} */ tx) => {
    if (!tx || (tx.type !== 'account_transfer' && tx.type !== 'debt_payment')) return;
    if (!funding.has(tx.to_account) || typeof tx.date !== 'string') return;
    paid.add(`${tx.to_account}|${tx.date.slice(0, 7)}`);
  };
  for (const tx of rows || []) {
    if (!tx) continue;
    notePaid(tx);
    const d = typeof tx.date === 'string' ? tx.date.slice(0, 10) : '';
    applyAccountEffects(tx, (id, delta) => {
      if (funding.has(id)) moves.push({ d, id, cents: Math.round(delta * 100) });
    });
  }
  for (const tx of booked || []) notePaid(tx);
  // A custom target later this month also owns the payment when the forecast
  // horizon stops before its date. Otherwise shortening the horizon would
  // reintroduce the default 15th payment and change earlier balances.
  const lastYear = Number(endIso.slice(0, 4));
  const lastMonth = Number(endIso.slice(5, 7));
  const throughMonth = `${endIso.slice(0, 7)}-${pad2(daysInMonth(lastYear, lastMonth))}`;
  const accountIds = new Set(accounts.filter(Boolean).map(a => a.id));
  for (const item of budgetItems) {
    if (!isTargetTransfer(item) || item.include === false || !item.as_schedule
      || !accountIds.has(item.account_id) || !accountIds.has(item.to_account_id)
      || item.account_id === item.to_account_id) continue;
    for (const occurrence of computeScheduledOccurrences(item, `${todayIso.slice(0, 7)}-01`, throughMonth,
      { dayType: item.schedule_day_type, country })) {
      paid.add(`${item.to_account_id}|${occurrence.date.slice(0, 7)}`);
    }
  }

  moves.sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0));

  /** @type {Map<string, number>} running balance in cents */
  const bal = new Map();
  for (const a of accounts || []) {
    if (a && funding.has(a.id)) bal.set(a.id, Math.round((Number(a.initialBalance) || 0) * 100));
  }
  let k = 0;

  let y = Number(todayIso.slice(0, 4));
  let m = Number(todayIso.slice(5, 7));
  const endYm = endIso.slice(0, 7);
  for (let ym = `${y}-${pad2(m)}`; ym <= endYm; ym = `${y}-${pad2(m)}`) {
    const date = `${ym}-${pad2(Math.min(SETTLE_DAY, daysInMonth(y, m)))}`;
    if (date > todayIso && date <= endIso) {
      const py = m === 1 ? y - 1 : y;
      const pm = m === 1 ? 12 : m - 1;
      const prevEndIso = `${py}-${pad2(pm)}-${pad2(daysInMonth(py, pm))}`;
      while (k < moves.length && moves[k].d <= prevEndIso) {
        const mv = moves[k++];
        bal.set(mv.id, (bal.get(mv.id) ?? 0) + mv.cents);
      }
      for (const [cardId, from] of funding) {
        const owed = round2(-(bal.get(cardId) ?? 0) / 100);
        if (owed < CENT) continue;
        if (paid.has(`${cardId}|${ym}`)) continue;
        added.push({
          id: `forecast:card:${cardId}:${ym}`,
          type: 'account_transfer',
          date,
          amount: owed,
          from_account: from,
          to_account: cardId,
          is_forecast: true,
          status: 'scheduled',
          forecast_kind: 'card-settlement',
        });
        // Dated after this month-end and on or before the next one, so it
        // counts from the next month on.
        bal.set(cardId, (bal.get(cardId) ?? 0) + Math.round(owed * 100));
      }
    }
    if (m === 12) { y += 1; m = 1; } else { m += 1; }
  }
  // Within a month the cards follow `accounts`' order; across months, dates ascend.
  return added;
}

/**
 * `rows` with the settlements of every card that names a `settledFrom`
 * account (`cardFundingFor`) appended, or `rows` itself when there are none,
 * so a budget without settled cards keeps every downstream memo warm.
 *
 * @param {any[]} accounts
 * @param {any[]} rows
 * @param {{ todayIso: string, endIso: string, booked?: any[], budgetItems?: any[], country?: string }} opts
 * @returns {any[]}
 */
export function withCardSettlements(accounts, rows, { todayIso, endIso, booked = [], budgetItems = [], country = 'FI' }) {
  rows = resolveTargetTransfers(accounts, rows);
  if (!(accounts || []).some(a => a && a.settledFrom)) return rows;
  const added = cardSettlementRows(accounts, rows, {
    fundingFor: card => cardFundingFor(card, accounts), todayIso, endIso, booked, budgetItems, country,
  });
  return added.length ? resolveTargetTransfers(accounts, rows.concat(added)) : rows;
}
