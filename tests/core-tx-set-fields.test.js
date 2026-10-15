import { describe, it, expect } from 'vitest';
import { registry } from '../js/core/index.js';
import { runCommand, runBatch } from '../js/core/pipeline.js';
import { makeCtx } from '../js/core/context.js';
import { applyCommitChecks } from '../js/session/commit-checks.js';
import strictLedger from '../js/core/policies/strict-ledger.js';

function deepFreeze(o) { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); Object.values(o).forEach(deepFreeze); } return o; }
const NOW = new Date(2026, 9, 2, 10, 0, 0);
const STAMP = NOW.toISOString();
const ctx = () => makeCtx({ now: NOW, newId: () => 'n1' });
const a = { id: 'a', type: 'expense', date: '2026-10-01', payee: 'A', amount: 10, account: 'chk', envelope_id: 'groc', cleared: true };
const b = {
  id: 'b', type: 'expense', date: '2026-10-01', payee: 'B', amount: 20, account: 'chk', envelope_id: null,
  budget_item_id: 'bi1', envelope_splits: [{ envelope_id: 'groc', amount: 12 }, { envelope_id: 'fun', amount: 8 }],
  from_budget: 'rent:2026-10', status: 'scheduled',
};
const inc = { id: 'inc', type: 'income', date: '2026-10-01', payee: 'Pay', amount: 100, account: 'chk', envelope_id: 'groc' };
const tr = { id: 'tr', type: 'account_transfer', date: '2026-10-01', payee: 'T', amount: 5, from_account: 'chk', to_account: 'sav' };
// Legacy rows the amend path would refuse: an expense without envelope_id and
// a stray foreign field.
const legacy = { id: 'leg', type: 'expense', date: '2026-09-01', payee: 'Old', amount: 7, account: 'chk', status: 'posted', from_account: 'chk' };
const brokenSplit = { id: 'bs', type: 'expense', date: '2026-09-01', payee: 'S', amount: 30, account: 'chk', envelope_splits: [{ envelope_id: 'groc', amount: 5 }], status: 'posted' };
const old = { id: 'old', type: 'expense', date: '2026-09-01', payee: 'Old', amount: 7, account: 'chk', envelope_id: 'groc', status: 'posted' };
const data = (transactions = [a, b, inc, tr, legacy]) => deepFreeze({
  meta: {}, budgetItems: [{ id: 'bi1', name: 'Rent', envelope_id: 'groc', amount: 20 }], envelopeTemplates: [],
  accounts: [{ id: 'chk', name: 'Checking' }, { id: 'sav', name: 'Savings' }],
  envelopes: [{ id: 'groc', name: 'Groceries' }, { id: 'fun', name: 'Fun' }],
  transactions,
});
const run = (input, d = data(), opts) => runCommand(registry, d, 'transaction.setFields', input, ctx(), opts);
const row = (r, id) => r.value.changes.transactions.find(t => t.id === id);

describe('transaction.setFields', () => {
  it('sets the date alone and stamps modified_at', () => {
    const r = run({ ids: ['a'], date: '2026-10-02' });
    expect(r.value.value).toEqual({ changed: 1 });
    expect(row(r, 'a')).toEqual({ ...a, date: '2026-10-02', modified_at: STAMP });
  });

  it('sets the payee alone, trimmed', () => {
    const r = run({ ids: ['a', 'inc'], payee: '  Corner shop ' });
    expect(r.value.value).toEqual({ changed: 2 });
    expect(row(r, 'a')).toEqual({ ...a, payee: 'Corner shop', modified_at: STAMP });
    expect(row(r, 'inc').payee).toBe('Corner shop');
    expect(row(r, 'tr')).toBe(tr);
  });

  it('refuses a blank payee', () => {
    for (const payee of ['', '   ']) {
      const r = run({ ids: ['a'], payee });
      expect(r.error.code).toBe('bad_input');
      expect(r.error.params.errors.map(e => e.path)).toEqual(['payee']);
    }
  });

  it('sets the envelope alone, dropping budget_item_id and envelope_splits', () => {
    const r = run({ ids: ['b'], envelope: 'fun' });
    const out = row(r, 'b');
    expect(out).toEqual({ id: 'b', type: 'expense', date: '2026-10-01', payee: 'B', amount: 20, account: 'chk', envelope_id: 'fun', from_budget: 'rent:2026-10', status: 'scheduled', modified_at: STAMP });
    expect(out).not.toHaveProperty('budget_item_id');
    expect(out).not.toHaveProperty('envelope_splits');
  });

  it('applies to income rows too', () => {
    const r = run({ ids: ['inc'], envelope: 'fun' });
    expect(row(r, 'inc')).toEqual({ ...inc, envelope_id: 'fun', modified_at: STAMP });
  });

  it('stores null and __none__ as the envelope', () => {
    expect(row(run({ ids: ['a'], envelope: null }), 'a')).toEqual({ ...a, envelope_id: null, modified_at: STAMP });
    expect(row(run({ ids: ['a'], envelope: '__none__' }), 'a')).toEqual({ ...a, envelope_id: '__none__', modified_at: STAMP });
  });

  it('refuses an unknown envelope', () => {
    expect(run({ ids: ['a'], envelope: 'nope' }).error.code).toBe('bad_input');
  });

  it('refuses an envelope on a row type that cannot carry one', () => {
    const r = run({ ids: ['a', 'tr'], envelope: 'fun' });
    expect(r.error).toEqual({ code: 'field_not_allowed', params: { field: 'envelope_id', type: 'account_transfer' } });
    for (const type of ['investment_transfer', 'debt_payment']) {
      const other = { id: 'x', type, date: '2026-10-01', amount: 5, from_account: 'chk', to_account: 'sav' };
      expect(run({ ids: ['x'], envelope: 'fun' }, data([other])).error).toEqual({ code: 'field_not_allowed', params: { field: 'envelope_id', type } });
    }
  });

  it('sets fromBudget, and null removes the key without touching status', () => {
    const set = run({ ids: ['a'], fromBudget: 'gym:2026-10' });
    expect(row(set, 'a')).toEqual({ ...a, from_budget: 'gym:2026-10', modified_at: STAMP });
    const cleared = run({ ids: ['b'], fromBudget: null });
    const out = row(cleared, 'b');
    expect(out).not.toHaveProperty('from_budget');
    expect(out.status).toBe('scheduled');
    expect(out).toEqual({ ...b, from_budget: undefined, modified_at: STAMP });
    for (const blank of ['', '   ']) {
      const bl = run({ ids: ['a'], fromBudget: blank });
      expect(bl.error.code).toBe('bad_input');
      expect(bl.error.params.errors.map(e => e.path)).toEqual(['fromBudget']);
    }
    // A non-blank key is stored as given, not trimmed.
    expect(row(run({ ids: ['a'], fromBudget: ' k:2026-10 ' }), 'a').from_budget).toBe(' k:2026-10 ');
  });

  it('combines fields in one stamp', () => {
    const r = run({ ids: ['a'], date: '2026-10-02', payee: ' Z ', envelope: 'fun', fromBudget: 'k:2026-10' });
    expect(row(r, 'a')).toEqual({ ...a, date: '2026-10-02', payee: 'Z', envelope_id: 'fun', from_budget: 'k:2026-10', modified_at: STAMP });
  });

  it('needs at least one field and one id', () => {
    const none = run({ ids: ['a'] });
    expect(none.error.code).toBe('bad_input');
    expect(none.error.params.errors[0].path).toBe('(input)');
    const noIds = run({ ids: [], date: '2026-10-02' });
    expect(noIds.error.params.errors).toEqual([{ path: 'ids', message: 'needs at least one id' }]);
  });

  it('rejects a malformed date', () => {
    expect(run({ ids: ['a'], date: '2026-02-30' }).error.code).toBe('bad_input');
  });

  it('reports the first unknown id and writes nothing', () => {
    expect(run({ ids: ['a', 'zz', 'yy'], date: '2026-10-02' }).error).toEqual({ code: 'tx_not_found', params: { id: 'zz' } });
  });

  it('leaves unchanged rows as the same object, without modified_at', () => {
    const r = run({ ids: ['a', 'inc'], date: '2026-10-01', payee: 'A' });
    // a already has date and payee; inc has the date but another payee.
    expect(r.value.value).toEqual({ changed: 1 });
    expect(row(r, 'a')).toBe(a);
    expect(row(r, 'a')).not.toHaveProperty('modified_at');
    expect(row(r, 'inc')).toEqual({ ...inc, payee: 'A', modified_at: STAMP });
  });

  it('reports no change when everything already matches', () => {
    const r = run({ ids: ['a'], date: '2026-10-01', payee: 'A', envelope: 'groc' });
    expect(r.value.value).toEqual({ changed: 0 });
    expect(r.value.changes).toEqual({});
  });

  it('counts a row with a budget-item link as changed even when the envelope matches', () => {
    const linked = { ...a, id: 'l', envelope_id: 'groc', budget_item_id: 'bi1' };
    const r = run({ ids: ['l'], envelope: 'groc' }, data([linked]));
    expect(row(r, 'l')).toEqual({ ...a, id: 'l', modified_at: STAMP });
  });

  it('edits a legacy row that fails checkTxRow, keeping its other fields exactly', () => {
    // amend refuses a split that does not add up; setFields does not look.
    expect(runCommand(registry, data([brokenSplit]), 'transaction.amend', { id: 'bs', payee: 'X' }, ctx()).ok).toBe(false);
    const r = run({ ids: ['leg', 'bs'], payee: 'New' }, data([legacy, brokenSplit]));
    expect(r.ok).toBe(true);
    expect(row(r, 'leg')).toEqual({ ...legacy, payee: 'New', modified_at: STAMP });
    expect(row(r, 'leg')).toHaveProperty('from_account', 'chk');
    expect(row(r, 'leg')).not.toHaveProperty('envelope_id');
    expect(row(r, 'bs')).toEqual({ ...brokenSplit, payee: 'New', modified_at: STAMP });
  });

  it('strict-ledger refuses a payee change on a posted past row; force passes it', () => {
    const d = data([old]);
    const refused = run({ ids: ['old'], payee: 'New' }, d, { policies: [strictLedger] });
    expect(refused.error.code).toBe('ledger_history_locked');
    const forced = run({ ids: ['old'], payee: 'New', force: true }, d, { policies: [strictLedger] });
    expect(forced.ok).toBe(true);
    expect(forced.value.forced).toEqual(['history-locked']);
    expect(row(forced, 'old').payee).toBe('New');
  });
});

describe('transaction.setFields per-row patches', () => {
  it('matches separate commands for mixed fields while running commit checks only once', () => {
    const d = data();
    const rows = [
      { id: 'a', payee: ' Corner shop ', fromBudget: 'groceries:2026-10' },
      { id: 'b', envelope: 'fun', fromBudget: null },
      { id: 'inc', date: '2026-10-02' },
      { id: 'tr', fromBudget: 'saving:2026-10' },
      { id: 'leg', payee: 'Legacy renamed' },
    ];
    let checks = 0;
    const actual = run({ rows }, d, { checks: (...args) => { checks++; return applyCommitChecks(...args); } });
    const expected = runBatch(registry, d, rows.map(({ id, ...fields }) => ({
      name: 'transaction.setFields', input: { ids: [id], ...fields },
    })), ctx(), { checks: applyCommitChecks });
    expect(actual.ok).toBe(true);
    expect(expected.ok).toBe(true);
    expect(actual.value.value).toEqual({ changed: 5 });
    expect(actual.value.after).toEqual(expected.value.after);
    expect(actual.value.diff).toEqual(expected.value.diff);
    expect(checks).toBe(1);
  });

  it('preserves matching rows and returns an empty change on a repeated repair', () => {
    const rows = [{ id: 'a', payee: 'A' }, { id: 'tr', fromBudget: 'saving:2026-10' }];
    const first = run({ rows });
    expect(first.value.value).toEqual({ changed: 1 });
    expect(row(first, 'a')).toBe(a);
    expect(row(first, 'b')).toBe(b);
    const second = run({ rows }, first.value.after);
    expect(second.value.value).toEqual({ changed: 0 });
    expect(second.value.changes).toEqual({});
  });

  it.each([
    [{ rows: [] }, 'rows'],
    [{ rows: [{ id: 'a' }] }, 'rows[0]'],
    [{ rows: [{ id: 'a', payee: ' ' }] }, 'rows[0].payee'],
    [{ rows: [{ id: 'a', fromBudget: ' ' }] }, 'rows[0].fromBudget'],
    [{ rows: [{ id: 'a', date: '2026-02-30' }] }, 'rows[0].date'],
    [{ rows: [{ id: 'a', envelope: 'missing' }] }, 'rows[0].envelope'],
    [{ rows: [{ fromBudget: 'x' }] }, 'rows[0].id'],
    [{ rows: [{ id: 'a', payee: 'X', amount: 200 }] }, 'rows[0].amount'],
    [{ rows: [{ id: 'a', payee: 'X' }, { id: 'a', payee: 'Y' }] }, 'rows[1].id'],
    [{ ids: ['b'], rows: [{ id: 'a', payee: 'X' }] }, '(input)'],
    [{ payee: 'X', rows: [{ id: 'a', payee: 'Y' }] }, '(input)'],
  ])('refuses invalid or ambiguous patches: %j', (input, path) => {
    const r = run(input);
    expect(r.error.code).toBe('bad_input');
    expect(r.error.params.errors[0].path).toBe(path);
    expect(r).not.toHaveProperty('value');
  });

  it('refuses all patches before commit checks when a later row is missing or cannot accept the field', () => {
    for (const [patch, code] of [
      [{ id: 'missing', fromBudget: 'x' }, 'tx_not_found'],
      [{ id: 'tr', envelope: 'fun' }, 'field_not_allowed'],
    ]) {
      let checks = 0;
      const d = data();
      const r = run({ rows: [{ id: 'a', fromBudget: 'rent:2026-10' }, patch] }, d, {
        checks: (...args) => { checks++; return applyCommitChecks(...args); },
      });
      expect(r.error.code).toBe(code);
      expect(checks).toBe(0);
      expect(d.transactions[0]).toBe(a);
      expect(a).not.toHaveProperty('from_budget');
    }
  });

  it('applies strict-ledger to every patch and only accepts force at command level', () => {
    const rows = [{ id: 'a', fromBudget: 'rent:2026-10' }, { id: 'old', payee: 'New' }];
    const opts = { policies: [strictLedger], checks: applyCommitChecks };
    const d = data([{ ...a, date: '2026-10-02' }, old]);
    expect(run({ rows }, d, opts).error).toEqual({ code: 'ledger_history_locked', params: { id: 'old', date: '2026-09-01' } });
    const forced = run({ rows, force: true }, d, opts);
    expect(forced.value.forced).toEqual(['history-locked']);
    expect(forced.value.value).toEqual({ changed: 2 });
    expect(run({ rows: [{ ...rows[1], force: true }] }, d, opts).error.code).toBe('bad_input');
  });
});
