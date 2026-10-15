// account.reconcile with the reconcile sheet's inputs (clear, link, adjust),
// the date check and the ledger stamp. The equivalence test feeds the sheet's
// own path (js/reconcile.js: splitByCleared + reconcileTotals, then
// applyReconcile + markReconciled + the adjustment row the sheet built) and the command
// the same choices. The basic command tests live in core-balance.test.js.

import { describe, it, expect } from 'vitest';
import { registry } from '../js/core/index.js';
import { runCommand } from '../js/core/pipeline.js';
import { makeCtx } from '../js/core/context.js';
import { round2 } from '../js/utils.js';
import {
  isAccountTx, splitByCleared, reconcileTotals, applyReconcile, markReconciled, SETTLED_EPSILON,
} from '../js/reconcile-model.js';

function deepFreeze(o) { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); Object.values(o).forEach(deepFreeze); } return o; }
const NOW = new Date(2026, 9, 2, 10, 0, 0);
const ctx = () => makeCtx({ now: NOW, newId: (() => { let n = 0; return () => `r${++n}`; })() });

// chk was last reconciled on 2026-09-15. Reconciling to 2026-09-30:
// - c1 and t1 were cleared before (opening 1000 - 50 - 100 = 850);
// - u1, the scheduled s1 and l1 (linked to a plan key) are ticked: -95;
// - u2 stays outstanding; c2 is cleared but after the reconcile date (yet
//   before today, so today's basis would count it and the sheet does not);
// - x1 is on another account.
// Statement 750 against 755 leaves a gap of -5.
const data = () => deepFreeze({
  meta: {}, budgetItems: [], envelopes: [], envelopeTemplates: [],
  accounts: [
    { id: 'chk', name: 'Checking', initialBalance: 1000, lastReconciledAt: '2026-09-15', lastReconciledBalance: 950, lastReconciledLedger: 950 },
    { id: 'sav', name: 'Savings', initialBalance: 0 },
  ],
  transactions: [
    { id: 'c1', type: 'expense', date: '2026-09-10', payee: 'A', amount: 50, account: 'chk', cleared: true, status: 'posted' },
    { id: 'u1', type: 'expense', date: '2026-09-20', payee: 'B', amount: 30, account: 'chk', cleared: false, status: 'posted' },
    { id: 'l1', type: 'expense', date: '2026-09-22', payee: 'Rent', amount: 25, account: 'chk', status: 'posted' },
    { id: 'u2', type: 'income', date: '2026-09-25', payee: 'Pay', amount: 200, account: 'chk', status: 'posted' },
    { id: 't1', type: 'account_transfer', date: '2026-09-26', payee: 'Save', amount: 100, from_account: 'chk', to_account: 'sav', cleared: true, status: 'posted' },
    { id: 's1', type: 'expense', date: '2026-09-28', payee: 'Phone', amount: 40, account: 'chk', status: 'scheduled' },
    { id: 'c2', type: 'expense', date: '2026-10-01', payee: 'C', amount: 7, account: 'chk', cleared: true, status: 'posted' },
    { id: 'x1', type: 'expense', date: '2026-09-21', payee: 'X', amount: 9, account: 'sav', status: 'posted' },
  ],
});
const run = (input, d = data()) => runCommand(registry, d, 'account.reconcile', input, ctx());

const REC_DATE = '2026-09-30';
const TICKED = ['u1', 's1', 'l1'];
const LINK = { id: 'l1', fromBudget: 'rent:2026-09' };
const NOTE = 'Reconciliation adjustment';

// The sheet's save handler (js/reconcile.js), with the user's choices.
function sheetPath(d, { target, adjust }) {
  const accountId = 'chk';
  const account = d.accounts.find(a => a.id === accountId);
  const { clearedBaseline, uncleared } = splitByCleared(account, d.transactions.filter(tx => isAccountTx(tx, accountId)), accountId, REC_DATE);
  const visibleDeltas = new Map(uncleared.map(({ tx, delta }) => [tx.id, delta]));
  const { gap } = reconcileTotals({ clearedBaseline, selectedDeltas: TICKED.map(id => visibleDeltas.get(id)), target });
  let adjustmentTx = null;
  if (Math.abs(gap) >= SETTLED_EPSILON && adjust) {
    adjustmentTx = { id: 'sheet-id', date: REC_DATE, type: 'adjustment', target: 'account', target_id: accountId, amount: round2(gap), note: NOTE, cleared: true };
  }
  const transactions = applyReconcile({
    transactions: d.transactions, newlyAdded: [], selectedIds: new Set(TICKED), adjustmentTx,
    linkKeys: new Map([[LINK.id, LINK.fromBudget]]),
  });
  const accounts = markReconciled(d.accounts, accountId, REC_DATE, target, transactions, NOW.toISOString());
  return { transactions, accounts };
}

// Ruling 2's deliberate difference: the command's row has the core shape.
const withoutCoreFields = ({ id: _id, payee: _payee, status: _status, created_at: _createdAt, modified_at: _modifiedAt, ...rest }) => rest;

describe('account.reconcile with the sheet inputs', () => {
  it('leaves the same transactions and accounts as the sheet, apart from the adjustment row\'s core fields', () => {
    const d = data();
    const sheet = sheetPath(d, { target: 750, adjust: true });
    const r = run({ account: 'chk', balance: 750, date: REC_DATE, clear: TICKED, link: [LINK], note: NOTE });
    expect(r.ok).toBe(true);
    expect(r.value.value).toEqual({ diff: -5, adjusted: true });

    const txs = r.value.changes.transactions;
    expect(txs).toHaveLength(sheet.transactions.length);
    expect(txs.slice(0, -1)).toEqual(sheet.transactions.slice(0, -1));
    expect(withoutCoreFields(txs.at(-1))).toEqual(withoutCoreFields(sheet.transactions.at(-1)));
    expect(txs.at(-1)).toMatchObject({ id: 'r1', payee: 'Reconciliation adjustment', status: 'posted', amount: -5, note: NOTE });
    expect(r.value.changes.accounts).toEqual(sheet.accounts);

    // The choices landed: ticked rows cleared, the scheduled one posted, the key linked.
    const byId = new Map(txs.map(t => [t.id, t]));
    expect(byId.get('u1').cleared).toBe(true);
    expect(byId.get('s1')).not.toHaveProperty('status');
    expect(byId.get('s1').cleared).toBe(true);
    expect(byId.get('l1')).toMatchObject({ cleared: true, from_budget: 'rent:2026-09' });
    expect(byId.get('u2').cleared).toBeUndefined();
    expect(r.value.changes.accounts[0]).toMatchObject({ lastReconciledAt: REC_DATE, lastReconciledBalance: 750, lastReconciledLedger: 750 });
    // When it was done, so a later drift can name the changes made after it.
    expect(r.value.changes.accounts[0].lastReconciledStamp).toBe(NOW.toISOString());
  });

  it('adjust: false declines the adjustment but still stamps, as the sheet does', () => {
    const d = data();
    const sheet = sheetPath(d, { target: 750, adjust: false });
    const r = run({ account: 'chk', balance: 750, date: REC_DATE, clear: TICKED, link: [LINK], adjust: false });
    expect(r.ok).toBe(true);
    expect(r.value.value).toEqual({ diff: -5, adjusted: false });
    expect(r.value.changes.transactions).toEqual(sheet.transactions);
    expect(r.value.changes.transactions.some(t => t.type === 'adjustment')).toBe(false);
    expect(r.value.changes.accounts).toEqual(sheet.accounts);
    expect(r.value.changes.accounts[0]).toMatchObject({ lastReconciledAt: REC_DATE, lastReconciledBalance: 750, lastReconciledLedger: 755 });
  });

  it('adjust: false without clear stamps without a row', () => {
    const r = run({ account: 'chk', balance: 1, adjust: false });
    expect(r.ok).toBe(true);
    expect(r.value.value.adjusted).toBe(false);
    expect(r.value.changes).not.toHaveProperty('transactions');
    expect(r.value.changes.accounts[0]).toMatchObject({ lastReconciledAt: '2026-10-02', lastReconciledBalance: 1 });
  });

  it('links without clearing when only link is given', () => {
    const r = run({ account: 'chk', balance: 843, link: [LINK] });
    expect(r.ok).toBe(true);
    const l1 = r.value.changes.transactions.find(t => t.id === 'l1');
    expect(l1).toEqual({ ...data().transactions[2], from_budget: 'rent:2026-09' });
  });

  it('counts a repeated clear id once, as the sheet\'s tick set does', () => {
    const r = run({ account: 'chk', balance: 755, date: REC_DATE, clear: [...TICKED, 'u1'] });
    expect(r.value.value).toEqual({ diff: 0, adjusted: false });
  });

  it('refuses a date before the last reconcile', () => {
    const r = run({ account: 'chk', balance: 750, date: '2026-09-14' });
    expect(r.error).toEqual({ code: 'bad_input', params: { errors: [{ path: 'date', message: expect.any(String) }] } });
  });

  it('accepts the date of the last reconcile itself', () => {
    expect(run({ account: 'chk', balance: 950, date: '2026-09-15' }).ok).toBe(true);
  });

  it('refuses a clear id that is not a row of this account', () => {
    const r = run({ account: 'chk', balance: 750, date: REC_DATE, clear: ['u1', 'x1'] });
    expect(r.error).toEqual({ code: 'bad_input', params: { errors: [{ path: 'clear[1]', message: expect.any(String) }] } });
    expect(run({ account: 'chk', balance: 750, clear: ['nope'] }).error.code).toBe('bad_input');
  });

  it('refuses a clear id dated after the reconcile date', () => {
    const d = data();
    const later = { id: 'u3', type: 'expense', date: '2026-10-01', payee: 'D', amount: 3, account: 'chk', status: 'posted' };
    const r = run({ account: 'chk', balance: 750, date: REC_DATE, clear: ['u3'] }, deepFreeze({ ...d, transactions: [...d.transactions, later] }));
    expect(r.error).toEqual({ code: 'bad_input', params: { errors: [{ path: 'clear[0]', message: expect.any(String) }] } });
  });

  describe('expectGap: the adjustment is the gap the user approved', () => {
    it('posts when the recomputed gap is the approved one', () => {
      const r = run({ account: 'chk', balance: 750, date: REC_DATE, clear: TICKED, link: [LINK], note: NOTE, expectGap: -5 });
      expect(r.ok).toBe(true);
      expect(r.value.value).toEqual({ diff: -5, adjusted: true });
    });

    it('refuses, writing nothing, when the balance moved since the user confirmed', () => {
      const r = run({ account: 'chk', balance: 750, date: REC_DATE, clear: TICKED, link: [LINK], note: NOTE, expectGap: -4.99 });
      expect(r.error).toEqual({ code: 'reconcile_gap_changed', params: {} });
      // The default basis checks the same way (gap 750 - 843 = -93).
      expect(run({ account: 'chk', balance: 750, expectGap: -5 }).error.code).toBe('reconcile_gap_changed');
      expect(run({ account: 'chk', balance: 750, expectGap: -93 }).ok).toBe(true);
    });

    it('refuses when the gap the user approved has since closed', () => {
      const r = run({ account: 'chk', balance: 755, date: REC_DATE, clear: TICKED, expectGap: -5 });
      expect(r.error.code).toBe('reconcile_gap_changed');
    });

    it('is ignored when the adjustment is declined', () => {
      const r = run({ account: 'chk', balance: 750, date: REC_DATE, clear: TICKED, adjust: false, expectGap: 12 });
      expect(r.ok).toBe(true);
      expect(r.value.value).toEqual({ diff: -5, adjusted: false });
    });
  });

  describe('an empty clear array selects the sheet\'s gap basis', () => {
    // c2 (-7, cleared, dated 2026-10-01) is after the reconcile date but
    // before today: today's basis counts it, the sheet's does not.
    it('clear: [] measures the gap on the cleared rows up to the reconcile date, as the sheet does', () => {
      const r = run({ account: 'chk', balance: 850, date: REC_DATE, clear: [] });
      expect(r.value.value).toEqual({ diff: 0, adjusted: false });
      const d = data();
      const { clearedBaseline } = splitByCleared(d.accounts[0], d.transactions, 'chk', REC_DATE);
      expect(clearedBaseline).toBe(850);
    });

    it('no clear uses the default basis: the cleared rows up to today', () => {
      const r = run({ account: 'chk', balance: 850, date: REC_DATE });
      expect(r.value.value).toEqual({ diff: 7, adjusted: true });
    });
  });

  it('refuses a link id that is not a row of this account', () => {
    const r = run({ account: 'chk', balance: 750, link: [{ id: 'x1', fromBudget: 'k' }] });
    expect(r.error).toEqual({ code: 'bad_input', params: { errors: [{ path: 'link[0].id', message: expect.any(String) }] } });
  });
});
