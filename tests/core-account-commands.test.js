// tests/core-account-commands.test.js — account.create, .update, .archive,
// .delete and .reorder, and the form's value normalisation and cross-field
// rules, which moved into core so CLI and AI writes store what the form does.
import { describe, it, expect } from 'vitest';
import { registry } from '../js/core/index.js';
import { runCommand } from '../js/core/pipeline.js';
import { makeCtx } from '../js/core/context.js';
import { applyDiff } from '../js/core/diff.js';
import { identityMove, moveAdjustment } from '../js/core/account-type-move.js';
import { crisisCashToStore } from '../js/pages/account-edit-rules.js';
import { spendingByDefault } from '../js/engine.js';

function deepFreeze(o) { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); Object.values(o).forEach(deepFreeze); } return o; }
const NOW = new Date(2026, 9, 2, 10, 0, 0);
const AT = NOW.toISOString();
const ctx = () => makeCtx({ now: NOW, newId: (() => { let n = 0; return () => `n${++n}`; })() });

const chk = { id: 'chk', name: 'Checking', type: 'bank', initialBalance: 100 };
const sav = { id: 'sav', name: 'Savings', type: 'savings', initialBalance: 500, interestTiers: [{ rate: 2 }], interestPayout: 'monthly' };
const inv = { id: 'inv', name: 'Broker', type: 'investment', initialBalance: 0, trackInvestments: false };
const old = { id: 'old', name: 'Old', type: 'bank', initialBalance: 0, archived: true };
const house = { id: 'house', name: 'House', type: 'asset', initialBalance: 200000, group: 'Property' };
const lent = { id: 'lent', name: 'Loan to Pat', type: 'loan_given', initialBalance: 1000, interestTiers: [{ rate: 4 }], loanStart: '2025-03-01', interestPayout: 'monthly' };
const mort = { id: 'mort', name: 'Mortgage', type: 'loan', initialBalance: -100000, interestTiers: [{ rate: 3 }], interestFirstMonth: '2024-01' };
const dup1 = { id: 'dup1', name: 'Spare', type: 'bank', initialBalance: 0 };
const dup2 = { id: 'dup2', name: 'Spare', type: 'bank', initialBalance: 0 };

const data = (extra = {}) => deepFreeze({
  meta: {}, budgetItems: [], envelopeTemplates: [],
  accounts: [chk, sav, inv, old, house, lent, mort, dup1, dup2],
  envelopes: [{ id: 'groc', name: 'Groceries' }, { id: 'loans', name: 'Loans to others' }],
  transactions: [
    { id: 't1', type: 'expense', date: '2026-09-01', payee: 'Shop', amount: 30, account: 'chk', envelope_id: 'groc', status: 'posted' },
    { id: 't2', type: 'account_transfer', date: '2026-09-02', payee: 'Move', amount: 50, from_account: 'chk', to_account: 'sav', status: 'posted' },
  ],
  ...extra,
});

// Every successful run is checked twice over: the same input on the same
// frozen data gives the same diff (the dry run is the commit), and that diff
// applied to the data reproduces the committed collections.
function run(name, input, d = data()) {
  const r = runCommand(registry, d, name, input, ctx());
  if (r.ok) {
    const again = runCommand(registry, d, name, input, ctx());
    expect(again.value.diff).toEqual(r.value.diff);
    const applied = applyDiff(d, r.value.diff);
    expect(applied.ok).toBe(true);
    for (const [kind, rows] of Object.entries(applied.value)) expect(rows).toEqual(r.value.changes[kind]);
  }
  return r;
}
const accountOf = (r, id) => r.value.changes.accounts.find(a => a.id === id);

describe('savings interest mode', () => {
  it('validates, preserves on unrelated edits, resets, and removes on a type change', () => {
    const full = { ...sav, interestTierMode: 'full-balance' };
    const d = data({ accounts: [full] });
    expect(accountOf(run('account.update', { id: 'sav', fields: { name: 'Danske' } }, d), 'sav').interestTierMode).toBe('full-balance');
    expect(accountOf(run('account.update', { id: 'sav', fields: { interestTierMode: null } }, d), 'sav')).not.toHaveProperty('interestTierMode');
    expect(accountOf(run('account.update', { id: 'sav', fields: { type: 'bank' } }, d), 'sav')).not.toHaveProperty('interestTierMode');
    expect(run('account.update', { id: 'sav', fields: { interestTierMode: 'invalid' } }).ok).toBe(false);
  });
});

describe('account.create', () => {
  it('defaults to a bank account with a zero opening balance and no notes', () => {
    const r = run('account.create', { name: 'Wallet' });
    expect(r.ok).toBe(true);
    expect(r.value.value).toEqual({ id: 'wallet' });
    expect(r.value.changes.accounts.at(-1)).toEqual({ id: 'wallet', code: 'WA01', name: 'Wallet', type: 'bank', initialBalance: 0 });
    expect(r.value.changes.accounts.slice(0, -1)).toEqual(data().accounts);
  });

  it('trims the name, notes and group, and makes the id from the name with a collision suffix', () => {
    const r = run('account.create', { name: '  Chk!  ', notes: '  spare cash ' });
    expect(r.value.value).toEqual({ id: 'chk-2' });
    expect(r.value.changes.accounts.at(-1)).toEqual({ id: 'chk-2', code: 'CH01', name: 'Chk!', type: 'bank', initialBalance: 0, notes: 'spare cash' });
    const asset = run('account.create', { name: 'Car', type: 'asset', initialBalance: 9000, group: ' Vehicles ' });
    expect(asset.value.changes.accounts.at(-1)).toEqual({ id: 'car', code: 'CA01', name: 'Car', type: 'asset', initialBalance: 9000, group: 'Vehicles' });
    expect(run('account.create', { name: '!!!' }).value.value).toEqual({ id: 'account' });
  });

  it('refuses a name already taken, case-insensitively and among archived accounts', () => {
    expect(run('account.create', { name: ' checking ' }).error).toEqual({ code: 'name_taken', params: { kind: 'account', name: 'checking' } });
    expect(run('account.create', { name: 'OLD' }).error.code).toBe('name_taken');
    const empty = run('account.create', { name: '   ' });
    expect(empty.error.code).toBe('bad_input');
    expect(empty.error.params.errors[0].path).toBe('name');
  });

  it('stores only the fields that belong to the type, normalised as the form stores them', () => {
    const r = run('account.create', {
      name: 'Rainy day', type: 'savings', initialBalance: '250.50',
      interestTiers: [{ upTo: 1000, rate: 2 }, { rate: 1 }], interestPayout: 'quarterly',
      group: 'ignored', interestRates: [{ from: '2026-01-01', rate: 3 }], trackInvestments: false,
      spending: false, crisisCash: true,
    });
    expect(r.value.changes.accounts.at(-1)).toEqual({
      id: 'rainy-day', code: 'RA01', name: 'Rainy day', type: 'savings', initialBalance: 250.5,
      interestTiers: [{ upTo: 1000, rate: 2 }, { rate: 1 }], interestPayout: 'quarterly',
    });
  });

  it('refuses a loan end before its start', () => {
    const r = run('account.create', { name: 'IOU', type: 'loan_given', loanStart: '2026-05-01', loanEnd: '2026-04-30' });
    expect(r.error).toEqual({ code: 'bad_input', params: { errors: [{ path: 'loanEnd', message: 'must not be before loanStart' }] } });
  });
});

describe('account.update', () => {
  it('sets the given fields and keeps the rest', () => {
    const r = run('account.update', { id: 'chk', fields: { name: ' Main ', notes: ' daily ', favorite: true, initialBalance: '150' } });
    expect(r.ok).toBe(true);
    expect(r.value.value).toEqual({ id: 'chk' });
    expect(accountOf(r, 'chk')).toEqual({ ...chk, name: 'Main', notes: 'daily', favorite: true, initialBalance: 150 });
    expect(r.value.changes).not.toHaveProperty('transactions');
    expect(run('account.update', { id: 'chk', fields: { notes: null } }).value.changes.accounts[0]).toEqual(chk);
  });

  it('drops the fields a type change leaves behind', () => {
    const r = run('account.update', { id: 'sav', fields: { type: 'bank' } });
    expect(accountOf(r, 'sav')).toEqual({ id: 'sav', name: 'Savings', type: 'bank', initialBalance: 500 });
  });

  it('allows an existing duplicate name to stay, but refuses a changed name that clashes', () => {
    expect(run('account.update', { id: 'dup1', fields: { notes: 'still a duplicate' } }).ok).toBe(true);
    expect(run('account.update', { id: 'dup1', fields: { name: 'Spare', notes: 'same name sent' } }).ok).toBe(true);
    expect(run('account.update', { id: 'chk', fields: { name: 'CHECKING' } }).ok).toBe(true);
    expect(run('account.update', { id: 'chk', fields: { name: 'savings' } }).error)
      .toEqual({ code: 'name_taken', params: { kind: 'account', name: 'savings' } });
    expect(run('account.update', { id: 'dup1', fields: { name: 'old' } }).error.code).toBe('name_taken');
    const empty = run('account.update', { id: 'chk', fields: { name: ' ' } });
    expect(empty.error.code).toBe('bad_input');
    expect(empty.error.params.errors[0].path).toBe('fields.name');
  });

  describe('a single-field update touches only its own fields', () => {
    // Records as older versions of the form left them: investment tiers and a
    // payout (still projected by the engine and shown on the card), the legacy
    // interestFirstMonth, a stray group on a bank account, and spending flags
    // on an off-budget account. The full clean-up runs only with `type`.
    const fund = { id: 'fund', name: 'Fund', type: 'investment', initialBalance: 0, interestTiers: [{ rate: 2 }], interestPayout: 'monthly', interestFirstMonth: '2024-01' };
    const stray = { id: 'stray', name: 'Stray', type: 'bank', initialBalance: 0, group: 'Property', spending: true };
    const cabin = { id: 'cabin', name: 'Cabin', type: 'asset', initialBalance: 1, spending: false, crisisCash: true };
    const d = () => data({ accounts: [...data().accounts, fund, stray, cabin] });

    for (const acc of [fund, stray, cabin, mort, lent]) {
      for (const fields of [
        { favorite: true }, { favorite: false },
        { expectedGrowth: 3 }, { expectedGrowth: null },
        { plannedMonthly: 50 }, { plannedMonthly: null },
      ]) {
        it(`${acc.id}, ${JSON.stringify(fields)}: every other key is identical`, () => {
          const r = run('account.update', { id: acc.id, fields }, d());
          expect(r.ok).toBe(true);
          const [[key, v]] = Object.entries(fields);
          const { [key]: _drop, ...rest } = acc;
          expect(accountOf(r, acc.id)).toEqual(v === null ? rest : { ...rest, [key]: v });
        });
      }
    }

    it('a growth edit leaves a set favourite and a growth clear leaves the contribution', () => {
      const both = { ...fund, favorite: true, expectedGrowth: 5, plannedMonthly: 100 };
      const r = run('account.update', { id: 'fund', fields: { expectedGrowth: null } }, data({ accounts: [both] }));
      const { expectedGrowth: _g, ...rest } = both;
      expect(accountOf(r, 'fund')).toEqual(rest);
    });

    it('with type, the full clean-up still runs', () => {
      const r = run('account.update', { id: 'fund', fields: { type: 'investment', favorite: true } }, d());
      expect(accountOf(r, 'fund')).toEqual({ id: 'fund', name: 'Fund', type: 'investment', initialBalance: 0, favorite: true });
    });
  });

  describe('a type change across the budget\'s cash', () => {
    // sav: 500 opening + 50 transferred in. Savings counts toward the
    // identity, investment does not.
    const move = identityMove(sav, 'investment', data().accounts, data().transactions);

    it('is a move of the whole balance', () => {
      expect(move).toEqual({ balance: 550, leaving: true });
    });

    it('needs moveEnvelope', () => {
      const r = run('account.update', { id: 'sav', fields: { type: 'investment' } });
      expect(r.error.code).toBe('bad_input');
      expect(r.error.params.errors[0].path).toBe('moveEnvelope');
    });

    it('with an envelope: the account and the adjustment row in one result, the row as the form builds it', () => {
      const r = run('account.update', { id: 'sav', fields: { type: 'investment' }, moveEnvelope: 'loans', moveNote: 'Savings changed type' });
      expect(r.ok).toBe(true);
      expect(accountOf(r, 'sav')).toEqual({ id: 'sav', name: 'Savings', type: 'investment', initialBalance: 500 });
      const row = r.value.changes.transactions.at(-1);
      expect(r.value.changes.transactions.slice(0, -1)).toEqual(data().transactions);
      // What account-edit.js builds today, with the id and clock from ctx.
      expect(row).toEqual(moveAdjustment(move, 'loans', { id: 'n1', date: '2026-10-02', note: 'Savings changed type', nowIso: AT }));
      expect(row).toEqual({
        id: 'n1', date: '2026-10-02', type: 'adjustment', target: 'envelope', target_id: 'loans',
        amount: -550, note: 'Savings changed type', status: 'posted', created_at: AT, modified_at: AT,
      });
      expect(r.value.diff.accounts.changed).toHaveLength(1);
      expect(r.value.diff.transactions.added).toHaveLength(1);
    });

    it('defaults the note', () => {
      const r = run('account.update', { id: 'sav', fields: { type: 'investment' }, moveEnvelope: 'loans' });
      expect(r.value.changes.transactions.at(-1).note).toBe('Type change');
    });

    it('with null: the balance is left to Unallocated and no row is added', () => {
      const r = run('account.update', { id: 'sav', fields: { type: 'investment' }, moveEnvelope: null });
      expect(r.ok).toBe(true);
      expect(accountOf(r, 'sav').type).toBe('investment');
      expect(r.value.changes).not.toHaveProperty('transactions');
    });
  });

  it('refuses moveEnvelope without a crossing move', () => {
    for (const input of [
      { id: 'chk', fields: { type: 'cash' }, moveEnvelope: 'loans' },
      { id: 'chk', fields: { notes: 'x' }, moveEnvelope: null },
      // Crosses, but the balance is zero: nothing moves.
      { id: 'inv', fields: { type: 'bank' }, moveEnvelope: 'loans' },
    ]) {
      const r = run('account.update', input);
      expect(r.error.code).toBe('bad_input');
      expect(r.error.params.errors[0].path).toBe('moveEnvelope');
    }
    expect(run('account.update', { id: 'inv', fields: { type: 'bank' } }).ok).toBe(true);
  });

  describe('normalisation, as the form stores values', () => {
    it('deletes empty tier and rate lists and a blank group', () => {
      expect(accountOf(run('account.update', { id: 'sav', fields: { interestTiers: [] } }), 'sav')).not.toHaveProperty('interestTiers');
      const loan = accountOf(run('account.update', { id: 'mort', fields: { interestRates: [] } }), 'mort');
      expect(loan).not.toHaveProperty('interestRates');
      expect(accountOf(run('account.update', { id: 'house', fields: { group: '   ' } }), 'house')).not.toHaveProperty('group');
      expect(accountOf(run('account.update', { id: 'house', fields: { group: '' } }), 'house')).not.toHaveProperty('group');
    });

    it('drops the payout without tiers (savings) or rates (loan given), and refuses yearly', () => {
      const s = accountOf(run('account.update', { id: 'sav', fields: { interestTiers: null } }), 'sav');
      expect(s).not.toHaveProperty('interestPayout');
      const l = accountOf(run('account.update', { id: 'lent', fields: { interestRates: [], interestPayout: 'quarterly' } }), 'lent');
      expect(l).not.toHaveProperty('interestPayout');
      const withRates = accountOf(run('account.update', { id: 'lent', fields: { interestRates: [{ from: '2025-03-01', rate: 4 }], interestPayout: 'quarterly' } }), 'lent');
      expect(withRates.interestPayout).toBe('quarterly');
      expect(run('account.update', { id: 'sav', fields: { interestPayout: 'yearly' } }).error.code).toBe('bad_input');
      expect(accountOf(run('account.update', { id: 'sav', fields: { interestPayout: null } }), 'sav')).not.toHaveProperty('interestPayout');
    });

    it('stores trackInvestments only as false, pensionInsurance and taxWrapped only as true', () => {
      const on = accountOf(run('account.update', { id: 'inv', fields: { trackInvestments: true, pensionInsurance: true, taxWrapped: true } }), 'inv');
      expect(on).toEqual({ id: 'inv', name: 'Broker', type: 'investment', initialBalance: 0, pensionInsurance: true, taxWrapped: true });
      const off = accountOf(run('account.update', { id: 'inv', fields: { trackInvestments: false, pensionInsurance: false, taxWrapped: false } }), 'inv');
      expect(off).toEqual({ id: 'inv', name: 'Broker', type: 'investment', initialBalance: 0, trackInvestments: false });
    });

    it('stores spending only when it differs from the type default', () => {
      expect(accountOf(run('account.update', { id: 'chk', fields: { spending: true } }), 'chk')).not.toHaveProperty('spending');
      expect(accountOf(run('account.update', { id: 'chk', fields: { spending: false } }), 'chk').spending).toBe(false);
      expect(accountOf(run('account.update', { id: 'sav', fields: { spending: false } }), 'sav')).not.toHaveProperty('spending');
      expect(accountOf(run('account.update', { id: 'sav', fields: { spending: true } }), 'sav').spending).toBe(true);
    });

    it('stores crisisCash as crisisCashToStore says', () => {
      // A spending account always counts: never stored.
      expect(accountOf(run('account.update', { id: 'chk', fields: { crisisCash: true } }), 'chk')).not.toHaveProperty('crisisCash');
      expect(accountOf(run('account.update', { id: 'chk', fields: { spending: false, crisisCash: true } }), 'chk').crisisCash).toBe(true);
      expect(accountOf(run('account.update', { id: 'chk', fields: { spending: false, crisisCash: false } }), 'chk')).not.toHaveProperty('crisisCash');
      // Savings defaults to true.
      expect(accountOf(run('account.update', { id: 'sav', fields: { crisisCash: true } }), 'sav')).not.toHaveProperty('crisisCash');
      expect(accountOf(run('account.update', { id: 'sav', fields: { crisisCash: false } }), 'sav').crisisCash).toBe(false);
      // A spending savings account: never stored.
      expect(accountOf(run('account.update', { id: 'sav', fields: { spending: true, crisisCash: false } }), 'sav')).not.toHaveProperty('crisisCash');
    });
  });

  describe('cross-field rules', () => {
    it('refuses a loan end before its start', () => {
      const r = run('account.update', { id: 'lent', fields: { loanEnd: '2025-02-28' } });
      expect(r.error).toEqual({ code: 'bad_input', params: { errors: [{ path: 'fields.loanEnd', message: 'must not be before loanStart' }] } });
      expect(run('account.update', { id: 'lent', fields: { loanEnd: '2025-03-01' } }).ok).toBe(true);
    });

    it('refuses a loan given with interest rates and no start', () => {
      const r = run('account.update', { id: 'lent', fields: { loanStart: null, interestRates: [{ from: '2025-03-01', rate: 4 }] } });
      expect(r.error).toEqual({ code: 'bad_input', params: { errors: [{ path: 'fields.loanStart', message: 'is required when a loan given has interest rates' }] } });
      // A loan (taken) has no start date and needs none.
      expect(run('account.update', { id: 'mort', fields: { interestRates: [{ from: '2024-01-01', rate: 3 }] } }).ok).toBe(true);
    });

    it('refuses a positive opening balance on a loan (owed is negative), on create and update', () => {
      const err = { path: 'initialBalance', message: 'must be zero or negative for a loan (the amount owed is negative)' };
      expect(run('account.create', { name: 'Car loan', type: 'loan', initialBalance: 5000 }).error)
        .toEqual({ code: 'bad_input', params: { errors: [err] } });
      expect(run('account.create', { name: 'Car loan', type: 'loan', initialBalance: -5000 }).ok).toBe(true);
      expect(run('account.update', { id: 'mort', fields: { initialBalance: 100000 } }).error)
        .toEqual({ code: 'bad_input', params: { errors: [{ ...err, path: 'fields.initialBalance' }] } });
      // A positive balance is fine on a loan given (it is owed to you).
      expect(run('account.create', { name: 'Loan to Sam', type: 'loan_given', initialBalance: 5000 }).ok).toBe(true);
    });

    it('lets unrelated edits through on a legacy loan stored positive, but not a type or balance edit', () => {
      const d = data({ accounts: [{ ...mort, initialBalance: 100000 }] });
      expect(run('account.update', { id: 'mort', fields: { favorite: true } }, d).ok).toBe(true);
      expect(run('account.update', { id: 'mort', fields: { initialBalance: 90000 } }, d).ok).toBe(false);
      expect(run('account.update', { id: 'mort', fields: { initialBalance: -90000 } }, d).ok).toBe(true);
    });
  });

  describe('a legacy loan (savings-style tiers, no dated rates)', () => {
    it('keeps its tiers when interestRates is not given', () => {
      const l = accountOf(run('account.update', { id: 'lent', fields: { notes: 'Pat' } }), 'lent');
      expect(l).toEqual({ ...lent, notes: 'Pat' });
      const m = accountOf(run('account.update', { id: 'mort', fields: { type: 'loan_given', loanStart: '2024-01-01' } }), 'mort');
      expect(m.interestTiers).toEqual([{ rate: 3 }]);
      expect(m).not.toHaveProperty('interestFirstMonth');
    });

    it('replaces them with the given rates', () => {
      const l = accountOf(run('account.update', { id: 'lent', fields: { interestRates: [{ from: '2025-03-01', rate: 4 }] } }), 'lent');
      expect(l).toEqual({ id: 'lent', name: 'Loan to Pat', type: 'loan_given', initialBalance: 1000, loanStart: '2025-03-01', interestPayout: 'monthly', interestRates: [{ from: '2025-03-01', rate: 4 }] });
    });

    it('drops them on a type change out of the loan types', () => {
      const r = run('account.update', { id: 'mort', fields: { type: 'bank' }, moveEnvelope: null });
      expect(accountOf(r, 'mort')).toEqual({ id: 'mort', name: 'Mortgage', type: 'bank', initialBalance: -100000 });
    });
  });
});

describe('account.archive', () => {
  it('archives and unarchives, changing only archived', () => {
    const a = run('account.archive', { id: 'chk', archived: true });
    expect(a.value.changes.accounts).toEqual(data().accounts.map(x => (x.id === 'chk' ? { ...chk, archived: true } : x)));
    expect(a.value.value).toEqual({ id: 'chk', archived: true });
    const u = run('account.archive', { id: 'old', archived: false });
    expect(accountOf(u, 'old')).toEqual({ ...old, archived: false });
  });

  it('refuses a no-op, so Undo always has a diff', () => {
    for (const input of [{ id: 'chk', archived: false }, { id: 'old', archived: true }]) {
      const r = run('account.archive', input);
      expect(r.error.code).toBe('bad_input');
      expect(r.error.params.errors[0].path).toBe('archived');
    }
  });
});

describe('account.delete', () => {
  it('refuses an account still referenced, with the counts', () => {
    expect(run('account.delete', { id: 'chk' }).error).toEqual({ code: 'in_use', params: { kind: 'account', id: 'chk', refs: { transactions: 2 } } });
    expect(run('account.delete', { id: 'sav' }).error.params.refs).toEqual({ transactions: 1 });
  });

  it('counts interest income linked to a loan given (interest_of) as a reference', () => {
    const d = data({ transactions: [{ id: 'int', type: 'income', date: '2026-08-01', amount: 5, account: 'chk', envelope_id: null, interest_of: 'house' }] });
    expect(run('account.delete', { id: 'house' }, d).error).toMatchObject({ code: 'in_use', params: { refs: { transactions: 1 } } });
  });

  it('removes an unreferenced account', () => {
    const r = run('account.delete', { id: 'house' });
    expect(r.ok).toBe(true);
    expect(r.value.value).toEqual({ id: 'house' });
    expect(r.value.changes.accounts).toEqual(data().accounts.filter(a => a.id !== 'house'));
    expect(r.value.diff.accounts.removed).toEqual([{ row: house, index: 4 }]);
  });

  it('refuses an unknown id', () => {
    expect(run('account.delete', { id: 'nope' }).error.code).toBe('bad_input');
  });
});

describe('account.reorder', () => {
  const ids = data().accounts.map(a => a.id);

  it('rebuilds the array in the given order, keeping every object', () => {
    const d = data();
    const next = [...ids].reverse();
    const r = run('account.reorder', { ids: next }, d);
    expect(r.ok).toBe(true);
    expect(r.value.changes.accounts.map(a => a.id)).toEqual(next);
    r.value.changes.accounts.forEach(a => expect(a).toBe(d.accounts.find(x => x.id === a.id)));
    expect(r.value.diff).toEqual({ accounts: { added: [], removed: [], changed: [], order: { before: ids, after: next } } });
  });

  it('refuses anything but a permutation of the current ids', () => {
    const notPerm = { code: 'not_permutation', params: { kind: 'account' } };
    expect(run('account.reorder', { ids: ids.slice(1) }).error).toEqual(notPerm);
    expect(run('account.reorder', { ids: [...ids, 'extra'] }).error).toEqual(notPerm);
    expect(run('account.reorder', { ids: [...ids.slice(1), 'extra'] }).error).toEqual(notPerm);
    expect(run('account.reorder', { ids: [...ids.slice(1), ids[1]] }).error).toEqual(notPerm);
  });
});

// The account form's Save handler (js/pages/account-edit.js, the update
// branch), copied with the DOM reads replaced by `f`: the form's state after
// the user's edits. It returns the stored account and the values the form
// computes from its inputs.
const INTEREST_TYPES = new Set(['savings']);
const LOAN_TYPES = new Set(['loan', 'loan_given']);
function oldFormOut(x, f) {
  const name = f.name.trim();
  const type = f.type;
  const initialBalance = f.initialBalance;
  const notes = f.notes.trim();
  const isLoanGiven = type === 'loan_given';
  const interestRates = [];
  if (LOAN_TYPES.has(type)) {
    for (const row of f.rateRows) {
      const { from, rate } = row;
      if (from && Number.isFinite(rate) && rate >= 0) interestRates.push({ from, rate: Math.round(rate * 1000) / 1000 });
    }
    interestRates.sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
  }
  // Stored only when it is not the default (actual/365).
  const interestDayCount = type === 'loan' && f.dayCount !== 'act/365' ? f.dayCount : null;
  const loanStart = isLoanGiven ? (f.loanStart || null) : null;
  const loanEnd = isLoanGiven ? (f.loanEnd || null) : null;
  const tiers = [];
  if (INTEREST_TYPES.has(type)) {
    f.tierRows.forEach((row, i) => {
      const rate = row.rate;
      if (!Number.isFinite(rate) || rate < 0) return;
      const tier = { rate: Math.round(rate * 1000) / 1000 };
      const upTo = row.upTo;
      if (Number.isFinite(upTo) && upTo > 0 && i < f.tierRows.length - 1) {
        tier.upTo = Math.round(upTo * 100) / 100;
      } else if (Number.isFinite(upTo) && upTo > 0) {
        tier.upTo = Math.round(upTo * 100) / 100;
      }
      tiers.push(tier);
    });
  }
  const interestPayout = isLoanGiven
    ? (interestRates.length && f.loanPayout !== 'yearly' ? f.loanPayout : null)
    : (tiers.length && f.payout !== 'yearly' ? f.payout : null);
  const trackInvestments = type === 'investment' ? f.track : null;
  const pensionInsurance = type === 'investment' ? f.pension : null;
  const taxWrapped = type === 'investment' ? f.tax : null;
  const isAsset = type === 'asset';
  const group = isAsset ? f.group.trim() : '';
  const offBudget = isAsset || type === 'loan' || type === 'loan_given';
  const spending = offBudget || f.spend === spendingByDefault(type) ? null : f.spend;
  const crisisCash = crisisCashToStore({
    isAsset: offBudget, spending: f.spend, crisisChecked: f.crisis, type,
  });

  const out = { ...x, name, type, initialBalance };
  if (notes) out.notes = notes; else delete out.notes;
  if (tiers.length) out.interestTiers = tiers; else delete out.interestTiers;
  if (interestPayout) out.interestPayout = interestPayout; else delete out.interestPayout;
  if (trackInvestments === false) out.trackInvestments = false;
  else delete out.trackInvestments;
  if (pensionInsurance === true) out.pensionInsurance = true;
  else delete out.pensionInsurance;
  if (taxWrapped === true) out.taxWrapped = true;
  else delete out.taxWrapped;
  if (spending !== null) out.spending = spending;
  else delete out.spending;
  if (crisisCash !== null) out.crisisCash = crisisCash;
  else delete out.crisisCash;
  if (group) out.group = group; else delete out.group;
  if (interestRates.length) out.interestRates = interestRates; else delete out.interestRates;
  if (interestDayCount) out.interestDayCount = interestDayCount; else delete out.interestDayCount;
  if (loanStart) out.loanStart = loanStart; else delete out.loanStart;
  if (loanEnd) out.loanEnd = loanEnd; else delete out.loanEnd;
  delete out.interestFirstMonth;
  return {
    out,
    computed: {
      name, type, initialBalance, notes, interestTiers: tiers, interestPayout, trackInvestments, pensionInsurance,
      taxWrapped, spending, crisisCash, group, interestRates, interestDayCount, loanStart, loanEnd,
    },
  };
}

// The form's raw input values, before the Save handler's normalisation.
const rawFields = (f) => ({
  name: f.name, type: f.type, initialBalance: f.initialBalance, notes: f.notes,
  interestTiers: f.tierRows, interestPayout: (f.type === 'loan_given' ? f.loanPayout : f.payout) === 'yearly' ? null : (f.type === 'loan_given' ? f.loanPayout : f.payout),
  interestRates: f.rateRows, interestDayCount: f.dayCount, loanStart: f.loanStart || null, loanEnd: f.loanEnd || null,
  trackInvestments: f.track, pensionInsurance: f.pension, taxWrapped: f.tax,
  spending: f.spend, crisisCash: f.crisis, group: f.group,
});

const blank = {
  notes: '', tierRows: [], payout: 'yearly', loanPayout: 'yearly', rateRows: [], dayCount: 'act/365', loanStart: '', loanEnd: '',
  track: true, pension: false, tax: false, group: '', spend: false, crisis: false,
};
const kept = { favorite: true, expectedGrowth: 0.04, plannedMonthly: 100, archived: false, lastReconciledAt: '2026-09-30' };
const CASES = [
  ['bank', { id: 'a', name: 'Checking', type: 'bank', initialBalance: 100, spending: true, crisisCash: false, notes: 'n', ...kept },
    { ...blank, name: ' Checking ', type: 'bank', initialBalance: 120, notes: '  ', tierRows: [{ rate: 1 }], payout: 'monthly', group: 'x', spend: true, crisis: true }],
  ['cash', { id: 'a', name: 'Wallet', type: 'cash', initialBalance: 20 },
    { ...blank, name: 'Wallet', type: 'cash', initialBalance: 20, notes: ' coins ', spend: false, crisis: true }],
  ['credit_card', { id: 'a', name: 'Amex', type: 'credit_card', initialBalance: -40, crisisCash: true },
    { ...blank, name: 'Amex', type: 'credit_card', initialBalance: -40, spend: true, crisis: false, track: false }],
  ['savings', { id: 'a', name: 'Rainy', type: 'savings', initialBalance: 900, interestTiers: [{ rate: 1 }], interestFirstMonth: '2025-01', ...kept },
    { ...blank, name: 'Rainy', type: 'savings', initialBalance: 900, tierRows: [{ upTo: 1000, rate: 2 }, { rate: 1 }], payout: 'quarterly', spend: false, crisis: false, rateRows: [{ from: '2026-01-01', rate: 2 }] }],
  ['savings without tiers', { id: 'a', name: 'Rainy', type: 'savings', initialBalance: 900, interestTiers: [{ rate: 1 }], interestPayout: 'monthly' },
    { ...blank, name: 'Rainy', type: 'savings', initialBalance: 900, payout: 'monthly', spend: true, crisis: true }],
  ['investment', { id: 'a', name: 'Broker', type: 'investment', initialBalance: 0, trackInvestments: true, pensionInsurance: false },
    { ...blank, name: 'Broker', type: 'investment', initialBalance: 0, track: false, pension: true, tax: false, spend: false, crisis: false }],
  ['investment, defaults', { id: 'a', name: 'Pension', type: 'investment', initialBalance: 0, trackInvestments: false, taxWrapped: false, ...kept },
    { ...blank, name: 'Pension', type: 'investment', initialBalance: 0, track: true, pension: false, tax: true, spend: false, crisis: true }],
  ['asset', { id: 'a', name: 'House', type: 'asset', initialBalance: 200000, spending: false, group: 'Old group' },
    { ...blank, name: 'House', type: 'asset', initialBalance: 210000, group: ' Property ', spend: true, crisis: true, track: false }],
  ['asset, blank group', { id: 'a', name: 'Car', type: 'asset', initialBalance: 5000, group: 'Vehicles' },
    { ...blank, name: 'Car', type: 'asset', initialBalance: 5000, group: '   ' }],
  ['loan', { id: 'a', name: 'Mortgage', type: 'loan', initialBalance: -100000, interestFirstMonth: '2024-01', crisisCash: true, ...kept },
    { ...blank, name: 'Mortgage', type: 'loan', initialBalance: -100000, rateRows: [{ from: '2024-01-01', rate: 3.5 }, { from: '2026-01-01', rate: 2.9 }], loanPayout: 'monthly', payout: 'monthly', spend: true }],
  ['loan, actual/360', { id: 'a', name: 'Mortgage', type: 'loan', initialBalance: -100000, interestRates: [{ from: '2024-01-01', rate: 3 }] },
    { ...blank, name: 'Mortgage', type: 'loan', initialBalance: -100000, rateRows: [{ from: '2024-01-01', rate: 3 }], dayCount: 'act/360' }],
  ['loan, 30/360 back to actual/365', { id: 'a', name: 'Mortgage', type: 'loan', initialBalance: -100000, interestRates: [{ from: '2024-01-01', rate: 3 }], interestDayCount: '30/360' },
    { ...blank, name: 'Mortgage', type: 'loan', initialBalance: -100000, rateRows: [{ from: '2024-01-01', rate: 3 }], dayCount: 'act/365' }],
  ['loan to bank drops the day count', { id: 'a', name: 'Mortgage', type: 'loan', initialBalance: 0, interestDayCount: '30/360' },
    { ...blank, name: 'Mortgage', type: 'bank', initialBalance: 0, dayCount: '30/360', spend: true }],
  ['loan_given', { id: 'a', name: 'Pat', type: 'loan_given', initialBalance: 1000 },
    { ...blank, name: 'Pat', type: 'loan_given', initialBalance: 1000, rateRows: [{ from: '2025-03-01', rate: 4 }], loanStart: '2025-03-01', loanEnd: '2027-03-01', loanPayout: 'quarterly', tierRows: [{ rate: 9 }], payout: 'monthly', dayCount: 'act/360' }],
  ['loan_given without rates', { id: 'a', name: 'Pat', type: 'loan_given', initialBalance: 1000, interestRates: [{ from: '2025-03-01', rate: 4 }], interestPayout: 'monthly', loanStart: '2025-03-01' },
    { ...blank, name: 'Pat', type: 'loan_given', initialBalance: 1000, loanStart: '2025-03-01', loanPayout: 'monthly' }],
  // The form offers a legacy loan's tier as the first dated rate, from the
  // start date (account-edit.js, initialRates), so a save sends it as a rate.
  ['legacy loan_given', { id: 'a', name: 'Pat', type: 'loan_given', initialBalance: 1000, interestTiers: [{ rate: 4 }], loanStart: '2025-03-01', interestPayout: 'monthly' },
    { ...blank, name: 'Pat', type: 'loan_given', initialBalance: 1000, rateRows: [{ from: '2025-03-01', rate: 4 }], loanStart: '2025-03-01', loanPayout: 'monthly' }],
  ['savings to bank', { id: 'a', name: 'Rainy', type: 'savings', initialBalance: 0, interestTiers: [{ rate: 1 }], crisisCash: false },
    { ...blank, name: 'Rainy', type: 'bank', initialBalance: 0, tierRows: [{ rate: 1 }], payout: 'monthly', spend: true, crisis: false }],
  ['bank to investment', { id: 'a', name: 'Broker cash', type: 'bank', initialBalance: 0, spending: false },
    { ...blank, name: 'Broker cash', type: 'investment', initialBalance: 0, track: false, spend: false, crisis: false }],
];

describe('equivalence with the account form', () => {
  const others = [{ id: 'z', name: 'Other', type: 'bank', initialBalance: 0 }];
  for (const [label, x, f] of CASES) {
    it(`${label}: the form's computed values and its raw inputs both store what the form stores`, () => {
      const d = data({ accounts: [x, ...others], transactions: [] });
      const { out, computed } = oldFormOut(x, f);
      for (const fields of [computed, rawFields(f)]) {
        const r = run('account.update', { id: 'a', fields }, d);
        expect(r.ok, JSON.stringify(r.error)).toBe(true);
        expect(accountOf(r, 'a')).toEqual(out);
      }
    });
  }
});

it('allows unrelated edits to a legacy account with invalid loan dates, but refuses edits to those dates', () => {
  const d = data({ accounts: [{ ...mort, type: 'loan_given', loanStart: '2026-10-01', loanEnd: '2025-01-01' }] });
  expect(run('account.update', { id: 'mort', fields: { favorite: true } }, d).ok).toBe(true);
  expect(run('account.update', { id: 'mort', fields: { loanEnd: '2024-01-01' } }, d).ok).toBe(false);
  expect(run('account.update', { id: 'mort', fields: { loanEnd: '2030-01-01' } }, d).ok).toBe(true);
});

// Owner decision 2026-10-05: a card's balance is paid off in the forecast
// from the account it names (engine card-settlement.js).
describe('settledFrom', () => {
  const card = { id: 'card', name: 'Mastercard', type: 'credit_card', initialBalance: -50 };
  const cc2 = { id: 'cc2', name: 'Other card', type: 'credit_card', initialBalance: 0 };
  const d = () => data({ accounts: [chk, sav, old, card, cc2], transactions: [] });

  it('stores the paying account on a card, and null clears it', () => {
    const r = run('account.update', { id: 'card', fields: { settledFrom: 'chk' } }, d());
    expect(r.ok, JSON.stringify(r.error)).toBe(true);
    expect(accountOf(r, 'card')).toEqual({ ...card, settledFrom: 'chk' });
    const set = data({ accounts: [chk, { ...card, settledFrom: 'chk' }], transactions: [] });
    expect(accountOf(run('account.update', { id: 'card', fields: { settledFrom: null } }, set), 'card')).toEqual(card);
  });

  it('is stored on create too', () => {
    const c = run('account.create', { name: 'New card', type: 'credit_card', settledFrom: 'chk' }, d());
    expect(c.value.changes.accounts.at(-1)).toEqual({ id: 'new-card', code: 'NE01', name: 'New card', type: 'credit_card', initialBalance: 0, settledFrom: 'chk' });
  });

  it('belongs to cards (credit cards, bank and cash accounts): another type drops it', () => {
    expect(accountOf(run('account.update', { id: 'chk', fields: { settledFrom: 'sav' } }, d()), 'chk').settledFrom).toBe('sav');
    expect(accountOf(run('account.update', { id: 'sav', fields: { settledFrom: 'chk' } }, d()), 'sav')).not.toHaveProperty('settledFrom');
    const set = data({ accounts: [chk, { ...card, settledFrom: 'chk' }], transactions: [] });
    const r = run('account.update', { id: 'card', fields: { type: 'savings' } }, set);
    expect(accountOf(r, 'card')).not.toHaveProperty('settledFrom');
  });

  it('refuses itself, an archived account, a credit card, an investment and an unknown account', () => {
    const errorOf = (settledFrom) => run('account.update', { id: 'card', fields: { settledFrom } }, d()).error;
    expect(errorOf('card').params.errors).toEqual([{ path: 'fields.settledFrom', message: 'must be another account' }]);
    expect(errorOf('old').params.errors).toEqual([{ path: 'fields.settledFrom', message: 'must not be an archived account' }]);
    expect(errorOf('cc2').params.errors).toEqual([{ path: 'fields.settledFrom', message: 'must be a bank, cash or savings account' }]);
    const withInv = data({ accounts: [chk, inv, card], transactions: [] });
    expect(run('account.update', { id: 'card', fields: { settledFrom: 'inv' } }, withInv).error.params.errors)
      .toEqual([{ path: 'fields.settledFrom', message: 'must be a bank, cash or savings account' }]);
    expect(errorOf('nope').code).toBe('bad_input');
    expect(run('account.create', { name: 'X', type: 'credit_card', settledFrom: 'cc2' }, d()).error.params.errors)
      .toEqual([{ path: 'settledFrom', message: 'must be a bank, cash or savings account' }]);
  });

  it('does not block another edit of a card whose paying account was archived since', () => {
    const later = data({ accounts: [{ ...chk, archived: true }, { ...card, settledFrom: 'chk' }], transactions: [] });
    expect(run('account.update', { id: 'card', fields: { favorite: true } }, later).ok).toBe(true);
  });

  it('account.delete of the paying account clears the setting in the same commit', () => {
    const z = { id: 'z', name: 'Spare', type: 'bank', initialBalance: 0 };
    const set = data({ accounts: [chk, z, { ...card, settledFrom: 'z' }, { ...cc2, settledFrom: 'chk' }], transactions: [] });
    const r = run('account.delete', { id: 'z' }, set);
    expect(r.ok, JSON.stringify(r.error)).toBe(true);
    expect(r.value.changes.accounts).toEqual([chk, card, { ...cc2, settledFrom: 'chk' }]);
  });
});
