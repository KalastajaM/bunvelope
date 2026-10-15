import { describe, it, expect } from 'vitest';
import { registry } from '../js/core/index.js';
import { runCommand } from '../js/core/pipeline.js';
import { makeCtx } from '../js/core/context.js';
import { ERROR_CODES, describeError } from '../js/core/errors.js';
import { t as tr } from '../js/ui/i18n.js';
import { round2 } from '../js/utils.js';

function deepFreeze(o) { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); Object.values(o).forEach(deepFreeze); } return o; }
const NOW = new Date(2026, 9, 2, 10, 0, 0);
const AT = NOW.toISOString();
const ctx = () => makeCtx({ now: NOW, newId: (() => { let n = 0; return () => `b${++n}`; })() });

// chk: opening 1000, cleared expense 100, uncleared expense 50 -> 850 in the
// budget view, 900 on the cleared basis. Envelope groc holds a 300 fill.
const data = (extra = {}) => deepFreeze({
  meta: {}, budgetItems: [], envelopeTemplates: [],
  accounts: [{ id: 'chk', name: 'Checking', initialBalance: 1000 }, { id: 'inv', name: 'Brokerage', type: 'investment', initialBalance: 500 }],
  envelopes: [{ id: 'groc', name: 'Groceries' }],
  transactions: [
    { id: 'e1', type: 'expense', date: '2026-09-01', payee: 'A', amount: 100, account: 'chk', cleared: true, status: 'posted' },
    { id: 'e2', type: 'expense', date: '2026-09-02', payee: 'B', amount: 50, account: 'chk', cleared: false, status: 'posted' },
    { id: 'f1', type: 'fill', date: '2026-09-01', payee: 'Fill', amount: 300, lines: [{ envelope_id: 'groc', amount: 300 }], status: 'posted' },
  ],
  ...extra,
});
const run = (name, input, d = data()) => runCommand(registry, d, name, input, ctx());

describe('balance.adjust', () => {
  it('appends a signed adjustment row', () => {
    const r = run('balance.adjust', { envelope: 'groc', amount: -12.346, note: 'lost' });
    expect(r.ok).toBe(true);
    const row = r.value.value;
    expect(row).toEqual({
      id: 'b1', type: 'adjustment', date: '2026-10-02', payee: 'Adjustment', amount: -12.35,
      target: 'envelope', target_id: 'groc', note: 'lost', cleared: true, status: 'posted',
      created_at: AT, modified_at: AT,
    });
    expect(r.value.changes.transactions.at(-1)).toBe(row);
    expect(r.value.changes.transactions).toHaveLength(4);
  });

  it('an empty payee falls back to the default, like Budget', () => {
    const r = run('balance.adjust', { account: 'chk', amount: 5, note: 'found', payee: '' });
    expect(r.value.value.payee).toBe('Adjustment');
  });

  it('targets an account, with a payee and date', () => {
    const r = run('balance.adjust', { account: 'chk', amount: 5, note: 'found', payee: 'Cash', date: '2026-09-30' });
    expect(r.value.value).toMatchObject({ target: 'account', target_id: 'chk', payee: 'Cash', date: '2026-09-30', amount: 5 });
  });

  it('refuses a zero amount', () => {
    const r = run('balance.adjust', { account: 'chk', amount: 0, note: 'x' });
    expect(r.error).toEqual({ code: 'bad_input', params: { errors: [{ path: 'amount', message: 'must be non-zero' }] } });
  });

  it('needs exactly one target', () => {
    expect(run('balance.adjust', { amount: 5, note: 'x' }).error.code).toBe('target_required');
    expect(run('balance.adjust', { envelope: 'groc', account: 'chk', amount: 5, note: 'x' }).error.code).toBe('target_required');
  });

  it('needs a note', () => {
    expect(run('balance.adjust', { account: 'chk', amount: 5, note: '   ' }).error.code).toBe('note_required');
    expect(run('balance.adjust', { account: 'chk', amount: 5 }).error.code).toBe('bad_input');
  });
});

describe('balance.set', () => {
  it('sets an envelope by the delta from its current balance', () => {
    const r = run('balance.set', { envelope: 'groc', balance: 250, note: 'recount' });
    expect(r.ok).toBe(true);
    const { delta, row } = r.value.value;
    expect(delta).toBe(-50);
    expect(row).toMatchObject({
      type: 'adjustment', payee: 'Set envelope balance', amount: -50, target: 'envelope', target_id: 'groc',
      note: 'Set Groceries to 250.00 (budget view was 300.00, delta -50.00) — recount', cleared: true, status: 'posted',
    });
    expect(r.value.changes.transactions.at(-1)).toBe(row);
  });

  it('sets an account against the all-inclusive budget view', () => {
    const r = run('balance.set', { account: 'chk', balance: 900, note: 'bank says', payee: 'Fix' });
    expect(r.value.value.delta).toBe(50);
    expect(r.value.value.row).toMatchObject({ payee: 'Fix', amount: 50, target: 'account', target_id: 'chk' });
    expect(r.value.value.row.note).toBe('Set Checking to 900.00 (budget view was 850.00, delta 50.00) — bank says');
  });

  it('is a no-op when already at the target', () => {
    const r = run('balance.set', { account: 'chk', balance: 850, note: 'x' });
    expect(r.value.changes).toEqual({});
    expect(r.value.value).toEqual({ delta: 0, balance: 850 });
    expect(run('balance.set', { envelope: 'groc', balance: 300.004, note: 'x' }).value.value).toEqual({ delta: 0, balance: 300 });
  });

  it('treats an envelope nothing has touched as 0', () => {
    const d = data({ envelopes: [{ id: 'groc', name: 'Groceries' }, { id: 'new', name: 'New' }] });
    expect(run('balance.set', { envelope: 'new', balance: 20, note: 'seed' }, d).value.value.delta).toBe(20);
  });

  it('needs exactly one target and a note', () => {
    expect(run('balance.set', { balance: 1, note: 'x' }).error.code).toBe('target_required');
    expect(run('balance.set', { account: 'chk', envelope: 'groc', balance: 1, note: 'x' }).error.code).toBe('target_required');
    expect(run('balance.set', { account: 'chk', balance: 1, note: ' ' }).error.code).toBe('note_required');
  });
});

describe('balance.set money parity with Budget', () => {
  it('rounds the target first, then takes the difference', () => {
    // 900.015 against a budget view of 850: round2(900.015 - 850) is 50.01,
    // round2(round2(900.015) - 850) is 50.02. The latter is Budget's number.
    const r = run('balance.set', { account: 'chk', balance: 900.015, note: 'bank' });
    expect(r.value.value.delta).toBe(round2(round2(900.015) - 850));
    expect(r.value.value.delta).not.toBe(round2(900.015 - 850));
    expect(r.value.value.row.amount).toBe(round2(round2(900.015) - 850));
    expect(r.value.value.row.note).toContain(`to ${round2(900.015).toFixed(2)} (`);
  });

  it('an empty payee falls back to the default', () => {
    const r = run('balance.set', { envelope: 'groc', balance: 250, note: 'recount', payee: '' });
    expect(r.value.value.row.payee).toBe('Set envelope balance');
  });
});

describe('account.reconcile', () => {
  it('matches on the cleared basis: no row, account marked', () => {
    const r = run('account.reconcile', { account: 'chk', balance: 900 });
    expect(r.ok).toBe(true);
    expect(r.value.value).toEqual({ diff: 0, adjusted: false });
    expect(r.value.changes).not.toHaveProperty('transactions');
    // lastReconciledLedger: the app's reconciled marker reads it, so every reconcile leaves the sheet's record.
    expect(r.value.changes.accounts.find(a => a.id === 'chk')).toEqual({
      id: 'chk', name: 'Checking', initialBalance: 1000, lastReconciledAt: '2026-10-02', lastReconciledBalance: 900, lastReconciledLedger: 900,
      lastReconciledStamp: NOW.toISOString(),
    });
    expect(r.value.changes.accounts[1]).toEqual({ id: 'inv', name: 'Brokerage', type: 'investment', initialBalance: 500 });
  });

  it('appends an adjustment for the difference', () => {
    const r = run('account.reconcile', { account: 'chk', balance: 880, date: '2026-09-30' });
    expect(r.value.value).toEqual({ diff: -20, adjusted: true });
    expect(r.value.changes.transactions.at(-1)).toEqual({
      id: 'b1', type: 'adjustment', date: '2026-09-30', payee: 'Reconciliation adjustment',
      note: 'Reconcile Checking to statement balance 880', amount: -20, target: 'account', target_id: 'chk',
      cleared: true, status: 'posted', created_at: AT, modified_at: AT,
    });
    expect(r.value.changes.accounts.find(a => a.id === 'chk')).toMatchObject({ lastReconciledAt: '2026-09-30', lastReconciledBalance: 880 });
  });

  it('uses the given note', () => {
    const r = run('account.reconcile', { account: 'chk', balance: 910, note: 'Sept statement' });
    expect(r.value.changes.transactions.at(-1)).toMatchObject({ amount: 10, note: 'Sept statement' });
  });

  it('ignores cleared rows dated after today', () => {
    const d = data();
    const future = { id: 'fut', type: 'expense', date: '2026-11-01', payee: 'F', amount: 40, account: 'chk', cleared: true, status: 'posted' };
    const r = run('account.reconcile', { account: 'chk', balance: 900 }, deepFreeze({ ...d, transactions: [...d.transactions, future] }));
    expect(r.value.value).toEqual({ diff: 0, adjusted: false });
  });

  it('refuses an investment account unless forced', () => {
    const r = run('account.reconcile', { account: 'inv', balance: 600 });
    expect(r.error).toEqual({ code: 'reconcile_investment', params: { id: 'inv' } });
    const f = run('account.reconcile', { account: 'inv', balance: 600, force: true });
    expect(f.ok).toBe(true);
    expect(f.value.value).toEqual({ diff: 100, adjusted: true });
  });
});

describe('error codes', () => {
  it('describes the three new codes in every locale', () => {
    expect(ERROR_CODES).toEqual(expect.arrayContaining(['note_required', 'target_required', 'reconcile_investment']));
    expect(describeError({ code: 'note_required', params: {} }, tr)).toBe('A note explaining why is required');
    expect(describeError({ code: 'target_required', params: {} }, tr)).toBe('Give exactly one of envelope or account');
    expect(describeError({ code: 'reconcile_investment', params: { id: 'inv' } }, tr)).toMatch(/balance\.set/);
  });
});
