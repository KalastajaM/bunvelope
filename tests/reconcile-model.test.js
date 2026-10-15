// The reconcile dialogs' money decisions, now that they live outside the DOM
// builders that used to own them (js/reconcile.js was 1140 lines with zero
// test coverage while being one of the few modules that writes money).
import { describe, it, expect } from 'vitest';
import {
  isAccountTx,
  splitByCleared,
  reconcileTotals,
  applyReconcile,
  markReconciled,
  scheduledRowsForAccount,
  scheduledRowKey,
  txFromScheduledRow,
  txsFromScheduledRow,
  scheduledRowDelta,
  untaggedMatchesForScheduledRow,
  buildManualTx,
  transferCounterpartOptions,
} from '../js/reconcile-model.js';
import { txAccountDelta, isPostedTx, forecastScheduledTransactions } from '../js/engine.js';
import { takenOccurrenceKeys } from '../js/core/effective-txs.js';
import { registry } from '../js/core/index.js';
import { runCommand } from '../js/core/pipeline.js';
import { makeCtx } from '../js/core/context.js';

const acct = { id: 'chk', name: 'Checking', initialBalance: 100 };

const expense = (id, date, amount, cleared = false) => ({
  id, date, type: 'expense', amount, account: 'chk', envelope: 'e1', cleared,
});
const income = (id, date, amount, cleared = false) => ({
  id, date, type: 'income', amount, account: 'chk', cleared,
});
const elsewhere = (id, date, amount) => ({
  id, date, type: 'expense', amount, account: 'other', envelope: 'e1',
});

describe('isAccountTx', () => {
  it('is true only for rows that move money on the account', () => {
    expect(isAccountTx(expense('a', '2026-01-05', 10), 'chk')).toBe(true);
    expect(isAccountTx(elsewhere('b', '2026-01-05', 10), 'chk')).toBe(false);
  });

  it('sees both legs of a transfer', () => {
    const tr = {
      id: 't', date: '2026-01-05', type: 'account_transfer', amount: 50,
      from_account: 'chk', to_account: 'sav',
    };
    expect(isAccountTx(tr, 'chk')).toBe(true);
    expect(isAccountTx(tr, 'sav')).toBe(true);
    expect(isAccountTx(tr, 'other')).toBe(false);
  });
});

describe('splitByCleared', () => {
  const txs = [
    expense('a', '2026-01-05', 10, true),
    income('b', '2026-01-10', 200, true),
    expense('c', '2026-01-12', 25),
    expense('d', '2026-01-20', 40),          // after the reconcile date
    elsewhere('e', '2026-01-12', 999),
  ];

  it('seeds the baseline with the opening balance, so a first reconcile has no phantom gap', () => {
    const { clearedBaseline } = splitByCleared(acct, [], 'chk', '2026-01-15');
    expect(clearedBaseline).toBe(100);
  });

  it('adds cleared rows to the baseline and leaves the rest outstanding', () => {
    const { clearedBaseline, uncleared } = splitByCleared(acct, txs, 'chk', '2026-01-15');
    expect(clearedBaseline).toBe(100 - 10 + 200);
    expect(uncleared.map(u => u.tx.id)).toEqual(['c']);
    expect(uncleared[0].delta).toBe(-25);
  });

  it('excludes rows dated after the reconcile date — they are not on the statement', () => {
    const later = splitByCleared(acct, txs, 'chk', '2026-01-31');
    expect(later.uncleared.map(u => u.tx.id)).toEqual(['d', 'c']); // newest first
  });

  it('ignores other accounts entirely', () => {
    const { clearedBaseline, uncleared } = splitByCleared(acct, txs, 'chk', '2026-01-31');
    expect(uncleared.some(u => u.tx.id === 'e')).toBe(false);
    expect(clearedBaseline).toBe(290);
  });

  it('treats a missing initialBalance as zero', () => {
    const { clearedBaseline } = splitByCleared({ id: 'chk' }, [], 'chk', '2026-01-15');
    expect(clearedBaseline).toBe(0);
  });
});

describe('reconcileTotals', () => {
  it('adds the ticked rows to the baseline', () => {
    const r = reconcileTotals({ clearedBaseline: 290, selectedDeltas: [-25, -40], target: 225 });
    expect(r.newly).toBe(-65);
    expect(r.total).toBe(225);
    expect(r.gap).toBe(0);
    expect(r.balanced).toBe(true);
  });

  it('reports the distance left to the statement, signed toward the statement', () => {
    // Statement says more than the book: the gap is positive, and an
    // adjustment for it credits the account.
    const r = reconcileTotals({ clearedBaseline: 100, selectedDeltas: [], target: 150 });
    expect(r.gap).toBe(50);
    expect(r.balanced).toBe(false);
  });

  it('is not balanced when no statement figure has been entered', () => {
    const r = reconcileTotals({ clearedBaseline: 100, selectedDeltas: [-25] });
    expect(r.total).toBe(75);
    expect(r.gap).toBeNull();
    expect(r.balanced).toBe(false);
  });

  it('calls a sub-cent gap balanced', () => {
    const r = reconcileTotals({ clearedBaseline: 100, selectedDeltas: [], target: 100.004 });
    expect(r.balanced).toBe(true);
  });

  it('skips deltas it cannot read instead of poisoning the total with NaN', () => {
    const r = reconcileTotals({ clearedBaseline: 100, selectedDeltas: [-25, undefined, NaN], target: 75 });
    expect(r.total).toBe(75);
    expect(r.balanced).toBe(true);
  });
});

describe('applyReconcile', () => {
  const existing = [expense('a', '2026-01-05', 10), expense('b', '2026-01-06', 20)];
  const added = [income('n1', '2026-01-07', 30)];

  it('marks the ticked rows cleared and leaves the rest alone', () => {
    const next = applyReconcile({ transactions: existing, selectedIds: ['a'] });
    expect(next[0].cleared).toBe(true);
    expect(next[1].cleared).toBe(false);
  });

  it('never mutates a row in place — the balance cache keys on identity', () => {
    const next = applyReconcile({ transactions: existing, selectedIds: ['a'] });
    expect(existing[0].cleared).toBe(false);
    expect(next[0]).not.toBe(existing[0]);
    expect(next[1]).toBe(existing[1]);
  });

  it('appends session-added rows, honouring their ticks', () => {
    const next = applyReconcile({ transactions: existing, newlyAdded: added, selectedIds: ['n1'] });
    expect(next).toHaveLength(3);
    expect(next[2].cleared).toBe(true);
  });

  it('appends the adjustment last, and nothing when there is none', () => {
    const adj = { id: 'x', type: 'adjustment', target: 'account', target_id: 'chk', amount: 5 };
    expect(applyReconcile({ transactions: existing, selectedIds: [], adjustmentTx: adj })).toHaveLength(3);
    expect(applyReconcile({ transactions: existing, selectedIds: [] })).toHaveLength(2);
  });

  it('accepts a Set or an array of ids', () => {
    const fromSet = applyReconcile({ transactions: existing, selectedIds: new Set(['b']) });
    expect(fromSet[1].cleared).toBe(true);
  });

  it('posts a ticked scheduled row, so the Today lens counts what the statement shows', () => {
    const sched = { ...income('s', '2026-09-30', 11920.18), status: 'scheduled' };
    const [ticked] = applyReconcile({ transactions: [sched], selectedIds: ['s'] });
    expect(ticked.cleared).toBe(true);
    expect(isPostedTx(ticked)).toBe(true);
    expect(sched.status).toBe('scheduled');
  });

  it('leaves an unticked scheduled row scheduled', () => {
    const sched = { ...income('s', '2026-09-30', 50), status: 'scheduled' };
    const [row] = applyReconcile({ transactions: [sched], selectedIds: [] });
    expect(row).toBe(sched);
  });
});

describe('markReconciled', () => {
  const accounts = [{ id: 'chk', name: 'Checking' }, { id: 'sav', name: 'Savings' }];

  it('stamps the statement balance, not the computed total', () => {
    const next = markReconciled(accounts, 'chk', '2026-01-15', 225.5);
    expect(next[0]).toMatchObject({ lastReconciledAt: '2026-01-15', lastReconciledBalance: 225.5 });
  });

  it('records the ledger side too, which differs when the adjustment was declined', () => {
    const txs = [
      { id: 'a', type: 'income', account: 'chk', amount: 220, date: '2026-01-10', cleared: true },
      { id: 'b', type: 'expense', account: 'chk', amount: 5, date: '2026-01-20', cleared: true },
    ];
    const next = markReconciled([{ id: 'chk', initialBalance: 0 }], 'chk', '2026-01-15', 225.5, txs);
    expect(next[0]).toMatchObject({ lastReconciledBalance: 225.5, lastReconciledLedger: 220 });
  });

  it('leaves the other accounts untouched, by identity', () => {
    const next = markReconciled(accounts, 'chk', '2026-01-15', 225.5);
    expect(next[1]).toBe(accounts[1]);
    expect(accounts[0].lastReconciledAt).toBeUndefined();
  });
});

describe('the reconcile flow end to end', () => {
  it('ticking every outstanding row and posting the gap lands on the statement figure', () => {
    const txs = [
      expense('a', '2026-01-05', 10, true),
      income('b', '2026-01-10', 200, true),
      expense('c', '2026-01-12', 25),
    ];
    const statement = 270; // bank says 270; the book says 265
    const { clearedBaseline, uncleared } = splitByCleared(acct, txs, 'chk', '2026-01-15');
    const { gap } = reconcileTotals({
      clearedBaseline,
      selectedDeltas: uncleared.map(u => u.delta),
      target: statement,
    });
    expect(gap).toBe(5);

    const adj = { id: 'adj', date: '2026-01-15', type: 'adjustment', target: 'account', target_id: 'chk', amount: gap, cleared: true };
    const next = applyReconcile({
      transactions: txs,
      selectedIds: uncleared.map(u => u.tx.id),
      adjustmentTx: adj,
    });

    // Reconciling again the next day finds nothing outstanding and no gap.
    const after = splitByCleared(acct, next, 'chk', '2026-01-16');
    expect(after.uncleared).toEqual([]);
    expect(after.clearedBaseline).toBe(statement);
    expect(reconcileTotals({
      clearedBaseline: after.clearedBaseline,
      selectedDeltas: [],
      target: statement,
    }).balanced).toBe(true);
  });
});


// ─── Scheduled rows, Post and the add panel (lifted out of reconcile.js) ──

const billRow = {
  type: 'expense', date: '2026-09-06', amount: 183.6, payee: 'Property tax', account: 'chk',
  envelope_id: 'tax', forecast_budget_item_id: 'bi-tax', forecast_month_key: '2026-09',
};
const transferRow = {
  type: 'account_transfer', date: '2026-09-25', amount: 1500, payee: 'Move to card',
  from_account: 'chk', to_account: 'card',
  forecast_budget_item_id: 'tr1', forecast_month_key: '2026-09',
};

describe('scheduledRowsForAccount', () => {
  it('lists this account\'s rows and a transfer on both of its accounts, minus taken keys', () => {
    const other = { ...billRow, account: 'card', forecast_budget_item_id: 'bi-other' };
    const fill = { type: 'fill', date: '2026-09-01', amount: 50, forecast_budget_item_id: 'f', forecast_month_key: '2026-09' };
    const all = [billRow, transferRow, other, fill];
    expect(scheduledRowsForAccount(all, 'chk', new Set())).toEqual([billRow, transferRow]);
    expect(scheduledRowsForAccount(all, 'card', new Set())).toEqual([transferRow, other]);
    expect(scheduledRowsForAccount(all, 'chk', new Set(['bi-tax:2026-09']))).toEqual([transferRow]);
  });
});

describe('txFromScheduledRow', () => {
  it('posts a bill on this account with its envelope, a positive amount and its key', () => {
    const tx = txFromScheduledRow({ ...billRow, amount: -183.6 }, 'chk', 'n1');
    expect(tx).toEqual({
      id: 'n1', type: 'expense', date: '2026-09-06', amount: 183.6, payee: 'Property tax',
      account: 'chk', envelope_id: 'tax', from_budget: 'bi-tax:2026-09',
    });
    expect(txAccountDelta(tx, 'chk')).toBe(-183.6);
  });

  it('posts a transfer by from/to with no account and no envelope, signed per side', () => {
    const tx = txFromScheduledRow(transferRow, 'card', 'n2');
    expect(tx).toEqual({
      id: 'n2', type: 'account_transfer', date: '2026-09-25', amount: 1500, payee: 'Move to card',
      from_account: 'chk', to_account: 'card', envelope_id: null, from_budget: 'tr1:2026-09',
    });
    expect(txAccountDelta(tx, 'chk')).toBe(-1500);
    expect(txAccountDelta(tx, 'card')).toBe(1500);
  });

  it('gives income no envelope', () => {
    const tx = txFromScheduledRow({ ...billRow, type: 'income', envelope_id: 'tax' }, 'chk', 'n3');
    expect(tx.envelope_id).toBeNull();
    expect(scheduledRowKey(billRow)).toBe('bi-tax:2026-09');
  });
});

describe('untaggedMatchesForScheduledRow', () => {
  const handBill = { id: 'h1', type: 'expense', date: '2026-09-02', amount: 183.6, account: 'chk', envelope_id: 'tax' };
  const handTransfer = { id: 'h2', type: 'account_transfer', date: '2026-09-20', amount: 1500, from_account: 'chk', to_account: 'card' };

  it('finds a hand-recorded bill paid before its due date', () => {
    expect(untaggedMatchesForScheduledRow(billRow, [handBill], 'chk')).toEqual([handBill]);
  });

  it('finds a hand-recorded transfer on the same route only', () => {
    expect(untaggedMatchesForScheduledRow(transferRow, [handTransfer], 'chk')).toEqual([handTransfer]);
    const reversed = { ...handTransfer, from_account: 'card', to_account: 'chk' };
    expect(untaggedMatchesForScheduledRow(transferRow, [reversed], 'chk')).toEqual([]);
  });

  it('ignores tagged rows, forecasts, other envelopes, other amounts and far dates', () => {
    const no = [
      { ...handBill, id: 'a', from_budget: 'bi-tax:2026-08' },
      { ...handBill, id: 'b', is_forecast: true },
      { ...handBill, id: 'c', envelope_id: 'food' },
      { ...handBill, id: 'd', amount: 190 },
      { ...handBill, id: 'e', date: '2026-08-20' },
      { ...handBill, id: 'f', account: 'card' },
      { ...handBill, id: 'g', type: 'income' },
    ];
    expect(untaggedMatchesForScheduledRow(billRow, no, 'chk')).toEqual([]);
  });

  it('matches a split expense that touches the envelope', () => {
    const split = { ...handBill, envelope_id: null, envelope_splits: [{ envelope_id: 'food', amount: 10 }, { envelope_id: 'tax', amount: 173.6 }] };
    expect(untaggedMatchesForScheduledRow(billRow, [split], 'chk')).toEqual([split]);
  });
});

describe('applyReconcile: linking an existing row', () => {
  it('writes the key on the linked row and ticks it without touching the others', () => {
    const txs = [expense('x', '2026-09-02', 183.6), expense('y', '2026-09-03', 5)];
    const next = applyReconcile({
      transactions: txs, newlyAdded: [], selectedIds: new Set(['x']),
      linkKeys: new Map([['x', 'bi-tax:2026-09']]),
    });
    expect(next[0]).toMatchObject({ id: 'x', cleared: true, from_budget: 'bi-tax:2026-09' });
    expect(next[1]).toBe(txs[1]);
    expect(txs[0].from_budget).toBeUndefined();
  });
});

describe('buildManualTx', () => {
  const common = { accountId: 'chk', date: '2026-09-10', payee: 'P', amount: 20, id: 'm' };
  it('maps out/in onto from/to for transfers and investments', () => {
    expect(buildManualTx({ ...common, type: 'transfer_out', otherAccountId: 'card' }))
      .toMatchObject({ type: 'account_transfer', from_account: 'chk', to_account: 'card' });
    expect(buildManualTx({ ...common, type: 'transfer_in', otherAccountId: 'card' }))
      .toMatchObject({ type: 'account_transfer', from_account: 'card', to_account: 'chk' });
    expect(buildManualTx({ ...common, type: 'investment_out', otherAccountId: 'inv' }))
      .toMatchObject({ type: 'investment_transfer', direction: 'buy', from_account: 'chk', to_account: 'inv' });
    expect(buildManualTx({ ...common, type: 'investment_in', otherAccountId: 'inv' }))
      .toMatchObject({ type: 'investment_transfer', direction: 'sell', from_account: 'inv', to_account: 'chk' });
  });

  it('refuses a transfer with no other account; books an expense on this account', () => {
    expect(buildManualTx({ ...common, type: 'transfer_out', otherAccountId: '' })).toBeNull();
    expect(buildManualTx({ ...common, type: 'expense', envelopeId: 'food' }))
      .toEqual({ id: 'm', date: '2026-09-10', payee: 'P', amount: 20, type: 'expense', note: null, envelope_id: 'food', account: 'chk' });
  });
});

describe('transferCounterpartOptions', () => {
  const accounts = [
    { id: 'chk', name: 'Checking' },
    { id: 'card', name: 'Card' },
    { id: 'old', name: 'Old bank', archived: true },
    { id: 'house', name: 'House', type: 'asset' },
  ];
  it('offers active non-asset accounts other than this one', () => {
    expect(transferCounterpartOptions(accounts, 'chk').map(a => a.id)).toEqual(['card']);
  });
  it('keeps a prefilled archived or asset counterpart, flagged', () => {
    expect(transferCounterpartOptions(accounts, 'chk', 'old'))
      .toEqual([
        { id: 'card', name: 'Card', archived: false, asset: false, kept: false },
        { id: 'old', name: 'Old bank', archived: true, asset: false, kept: true },
      ]);
    expect(transferCounterpartOptions(accounts, 'chk', 'house').map(a => a.id)).toEqual(['card', 'house']);
  });
});

// BACKLOG 2026-10-05 [bug]: the due list posted a loan payment's interest leg
// under the occurrence key (`${item}:${month}`, the principal's), so the
// scheduler took the occurrence as paid and never posted the principal. The
// legs are now one entry, posted together, each under its own key.
describe('the due list and a loan payment', () => {
  const ALL = { Jan: true, Feb: true, Mar: true, Apr: true, May: true, Jun: true, Jul: true, Aug: true, Sep: true, Oct: true, Nov: true, Dec: true };
  // A flat-month day count: 120 000 at 3 % is 300 interest and 700 principal.
  const loanBudget = (transactions = [], extra = {}) => ({
    meta: {}, envelopeTemplates: [], transactions,
    accounts: [{ id: 'chk', name: 'Checking', type: 'bank', initialBalance: 5000 },
      { id: 'mtg', name: 'Mortgage', type: 'loan', initialBalance: -120000, interestDayCount: '30/360' }],
    envelopes: [{ id: 'housing', name: 'Housing' }],
    budgetItems: [{
      id: 'mortgage', kind: 'loan_payment', description: 'Mortgage', envelope_id: 'housing', account_id: 'chk', to_account_id: 'mtg',
      loan_rate: 3, default_amount: -1000, monthly_schedule: ALL, payment_day: 5, as_schedule: true,
      as_schedule_since: '2026-10-01', include: true, schedule_day_type: 'exact', ...extra,
    }],
  });
  // reconcile.js's buildScheduledForecasts for a 2026-10-10 reconcile date.
  const dueList = (d, accountId) => scheduledRowsForAccount(
    forecastScheduledTransactions(d.budgetItems, d.accounts, d.envelopes, new Date(2026, 8, 30), '2026-10-10', null, 'FI', { transactions: d.transactions }),
    accountId, takenOccurrenceKeys(d.transactions, []));
  const ids = () => { let n = 0; return () => `p${++n}`; };
  const postDue = (d) => runCommand(registry, d, 'month.postDue', {}, makeCtx({ now: new Date(2026, 9, 10, 12), newId: ids() }));

  it('lists the payment once, on the paying account and on the loan, with its whole amount', () => {
    const d = loanBudget();
    const [entry, ...rest] = dueList(d, 'chk');
    expect(rest).toEqual([]);
    expect(entry.legs.map(l => l.forecast_loan_leg)).toEqual(['principal', 'interest']);
    expect(scheduledRowDelta(entry, 'chk')).toBe(-1000);
    expect(dueList(d, 'mtg').map(e => scheduledRowDelta(e, 'mtg'))).toEqual([700]);
  });

  it('posts every leg under its own key, and the forecast and month.postDue then see the occurrence paid', () => {
    const d = loanBudget();
    const posted = txsFromScheduledRow(dueList(d, 'chk')[0], 'chk', ids());
    expect(posted.map(r => [r.type, r.amount, r.from_budget])).toEqual([
      ['debt_payment', 700, 'mortgage:2026-10'], ['expense', 300, 'mortgage:2026-10:interest'],
    ]);
    expect(posted[0]).toMatchObject({ from_account: 'chk', to_account: 'mtg', envelope_id: 'housing' });
    expect(posted[1]).toMatchObject({ account: 'chk', envelope_id: 'housing' });
    // Posting from the loan's own reconcile writes the same rows on the same accounts.
    expect(txsFromScheduledRow(dueList(d, 'mtg')[0], 'mtg', ids())).toEqual(posted);

    const after = loanBudget(posted.map(r => ({ ...r, status: 'posted' })));
    expect(dueList(after, 'chk')).toEqual([]);
    expect(dueList(after, 'mtg')).toEqual([]);
    const r = postDue(after);
    expect(r.ok).toBe(true);
    expect(r.value.value.posted).toBe(0);
  });

  it('a leg already posted leaves the others, under their own keys (never the principal\'s)', () => {
    // The principal paid by the scheduler; the interest leg still due.
    const principal = { id: 'p0', type: 'debt_payment', date: '2026-10-05', amount: 700, from_account: 'chk', to_account: 'mtg',
      envelope_id: 'housing', status: 'posted', from_budget: 'mortgage:2026-10' };
    const d = loanBudget([principal]);
    const [entry] = dueList(d, 'chk');
    expect(entry.legs.map(l => l.forecast_loan_leg)).toEqual(['interest']);
    expect(scheduledRowKey(entry)).toBe('mortgage:2026-10:interest');
    expect(txsFromScheduledRow(entry, 'chk', ids()).map(r => r.from_budget)).toEqual(['mortgage:2026-10:interest']);
  });

  it('month.postDue posts both legs when the due list posted nothing', () => {
    const r = postDue(loanBudget());
    expect(r.value.value.rows.map(x => x.from_budget)).toEqual(['mortgage:2026-10', 'mortgage:2026-10:interest']);
  });
});
