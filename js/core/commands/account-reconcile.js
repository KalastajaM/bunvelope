// account.reconcile — match an account to a bank statement. The ledger side is
// the CLEARED rows up to today (a statement shows only what has happened); any
// difference becomes an adjustment, and the account is stamped with when and
// to what it was last reconciled. Matches Budget's `reconcile`.
//
// The reconcile sheet (js/reconcile.js) does more, and the optional inputs
// cover it: `clear` ticks rows (cleared, and a scheduled one posted), `link`
// sets plan keys, `adjust: false` declines the adjustment. With `clear` the
// gap is the sheet's own: the reconcile-model functions, on the cleared rows
// up to the reconcile date plus the ticked ones. An empty `clear` array still
// selects that basis (the sheet always sends one, ticks or not); only an
// absent `clear` measures on today's cleared balance. `expectGap` is the gap
// the user approved in the sheet's dialog: when it no longer matches, nothing
// is written, so the adjustment posted is always the one the user saw. The
// account is always stamped as the sheet stamps it (markReconciled, with the
// ledger side).

import { ok, fail } from '../result.js';
import { computeAccountBalances } from '../../engine/balances.js';
import { adjustmentRow } from '../balance-fields.js';
import { round2 } from '../../utils.js';
import {
  isAccountTx, splitByCleared, reconcileTotals, applyReconcile, markReconciled, SETTLED_EPSILON,
} from '../../reconcile-model.js';

/** @param {string} path @param {string} message */
const badInput = (path, message) => fail('bad_input', { errors: [{ path, message }] });

export default {
  name: 'account.reconcile',
  summary: 'Reconcile an account to a statement balance on the cleared basis (up to today). A difference of a cent or more is posted as an adjustment, unless adjust is false; the account is always stamped with the reconciliation. With clear, the given rows are marked cleared (a scheduled one becomes posted) and the difference is measured as the reconcile sheet does, on the cleared rows up to the reconcile date. Not for investment accounts unless forced. Returns { diff, adjusted }.',
  input: {
    type: 'object',
    required: ['account', 'balance'],
    properties: {
      account: { type: 'ref', kind: 'account' },
      balance: { type: 'money', description: 'The statement balance' },
      date: { type: 'date', description: 'Reconciliation date, YYYY-MM-DD (default today); not before the last reconciliation' },
      note: { type: 'string', description: 'Note for the adjustment, if one is needed' },
      clear: { type: 'array', items: { type: 'string' }, description: 'Transaction ids the statement shows: rows of this account dated on or before the reconciliation date. They are marked cleared, and a scheduled one becomes posted. Given at all (even empty), the difference is measured on the cleared rows up to the reconciliation date plus these, as the reconcile sheet does; absent, on the cleared balance today' },
      link: {
        type: 'array', description: 'Rows of this account to link to a planned occurrence',
        items: {
          type: 'object', required: ['id', 'fromBudget'],
          properties: {
            id: { type: 'string', description: 'Transaction id' },
            fromBudget: { type: 'string', description: 'The occurrence key (from_budget)' },
          },
        },
      },
      adjust: { type: 'boolean', default: true, description: 'Post an adjustment for a difference; false declines it and only stamps the account' },
      expectGap: { type: 'money', description: 'The difference the user approved; with adjust, refused (nothing written) when the difference is now another amount' },
      force: { type: 'boolean', description: 'Reconcile an investment account anyway; also bypasses strict-ledger rules' },
    },
  },
  execute(data, input, ctx) {
    const acc = data.accounts.find(a => a.id === input.account);
    if (acc.type === 'investment' && !input.force) return fail('reconcile_investment', { id: acc.id });
    const statement = round2(input.balance);
    const recDate = input.date ?? ctx.todayIso;
    if (acc.lastReconciledAt && recDate < acc.lastReconciledAt) {
      return badInput('date', `must not be before the last reconciliation (${acc.lastReconciledAt})`);
    }

    const undated = splitByCleared(acc, data.transactions, acc.id, recDate).undated;
    if (undated.length) return fail('reconcile_undated', { ids: undated.map(t => t.id) });

    const byId = new Map(data.transactions.map(t => [t.id, t]));
    const clear = input.clear ?? null;
    const link = input.link ?? [];
    for (const [i, id] of (clear ?? []).entries()) {
      const tx = byId.get(id);
      if (!tx || !isAccountTx(tx, acc.id)) return badInput(`clear[${i}]`, 'is not a transaction of this account');
      if (tx.date && tx.date > recDate) return badInput(`clear[${i}]`, 'is dated after the reconciliation date');
    }
    for (const [i, { id }] of link.entries()) {
      const tx = byId.get(id);
      if (!tx || !isAccountTx(tx, acc.id)) return badInput(`link[${i}].id`, 'is not a transaction of this account');
    }

    let gap;
    if (clear) {
      // The sheet's figure (js/reconcile.js save handler): what had cleared by
      // the reconcile date, plus the rows ticked now.
      const { clearedBaseline, uncleared } = splitByCleared(acc, data.transactions, acc.id, recDate);
      const deltas = new Map(uncleared.map(({ tx, delta }) => [tx.id, delta]));
      gap = reconcileTotals({ clearedBaseline, selectedDeltas: [...new Set(clear)].map(id => deltas.get(id)), target: statement }).gap ?? 0;
    } else {
      const today = ctx.today;
      const noon = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 12);
      const bal = computeAccountBalances([acc], data.transactions.filter(t => t.cleared), { asOf: noon }).get(acc.id) ?? 0;
      gap = statement - bal;
    }
    const diff = round2(gap);
    if (input.adjust !== false && input.expectGap !== undefined && Math.abs(diff - input.expectGap) >= 0.005) {
      return fail('reconcile_gap_changed');
    }
    const adjusted = input.adjust !== false && (clear ? Math.abs(gap) >= SETTLED_EPSILON : Math.abs(diff) >= 0.01);

    const row = adjusted
      ? adjustmentRow(ctx, {
        date: recDate, payee: 'Reconciliation adjustment', amount: diff, target: 'account', targetId: acc.id,
        note: input.note ?? `Reconcile ${acc.name} to statement balance ${statement}`,
      })
      : null;
    /** @type {Record<string, any>} */
    const changes = {};
    if (row || clear?.length || link.length) {
      changes.transactions = applyReconcile({
        transactions: data.transactions,
        selectedIds: new Set(clear ?? []),
        linkKeys: new Map(link.map(l => [l.id, l.fromBudget])),
        adjustmentTx: row,
      });
    }
    changes.accounts = markReconciled(data.accounts, acc.id, recDate, statement, changes.transactions ?? data.transactions,
      ctx.now.toISOString());
    return ok({ changes, value: { diff, adjusted } });
  },
};
