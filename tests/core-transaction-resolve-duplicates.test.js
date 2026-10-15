// transaction.resolveDuplicates: the duplicates sheet's cleanup as a command.
// It does exactly what the sheet's old pure helper (resolveDuplicateGroups,
// deleted once the sheet dispatched this) did: same survivors in the same
// order, the keeper takes the group's key with modified_at, and it never
// touches meta: the key lives on in the keeper, so no tombstone is wanted.
import { describe, it, expect } from 'vitest';
import { registry } from '../js/core/index.js';
import { runCommand } from '../js/core/pipeline.js';
import { makeCtx } from '../js/core/context.js';
import strictLedger from '../js/core/policies/strict-ledger.js';
import { findDuplicateGroups } from '../js/state/duplicate-finder.js';

function deepFreeze(o) { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); Object.values(o).forEach(deepFreeze); } return o; }
const NOW = new Date(2026, 9, 2, 10, 0, 0);
const STAMP = NOW.toISOString();
const ctx = () => makeCtx({ now: NOW, newId: () => 'n1' });
const tx = (id, over = {}) => ({
  id, type: 'expense', date: '2026-09-10', status: 'posted', amount: 42.5,
  account: 'chk', envelope_id: 'food', payee: 'K-Market', ...over,
});
const data = (transactions, meta = {}) => deepFreeze({
  meta, budgetItems: [], envelopeTemplates: [],
  accounts: [{ id: 'chk', name: 'Checking' }],
  envelopes: [{ id: 'food', name: 'Food' }],
  transactions,
});
const run = (groups, d) => runCommand(registry, d, 'transaction.resolveDuplicates', { groups }, ctx());
const toInput = (g) => ({ keep: g.keepId, drop: g.rows.filter(r => r.id !== g.keepId).map(r => r.id) });
const paths = (r) => r.error.params.errors.map(e => e.path);

describe('transaction.resolveDuplicates: the groups the finder proposes', () => {
  it('drops the copies and moves the key to the kept hand entry, leaving other rows alone', () => {
    const other = tx('other', { payee: 'Prisma', amount: 7 });
    const rows = [
      tx('hand', { date: '2026-09-03' }),
      tx('auto', { date: '2026-09-06', from_budget: 'bi-gym:2026-09' }),
      other,
    ];
    const [group] = findDuplicateGroups({ transactions: rows });
    expect(toInput(group)).toEqual({ keep: 'hand', drop: ['auto'] });
    const r = run([toInput(group)], data(rows));
    expect(r.ok).toBe(true);
    expect(r.value.changes.transactions).toEqual([{ ...rows[0], from_budget: 'bi-gym:2026-09', modified_at: STAMP }, other]);
    expect(r.value.value).toEqual({ removed: 1 });
    expect(r.value.changes.transactions[1]).toBe(other);
    expect(rows[0].from_budget).toBeUndefined();
  });

  it('keeping the tagged row leaves it as it is', () => {
    const rows = [tx('hand'), tx('auto', { from_budget: 'bi-x:2026-09' })];
    const r = run([{ keep: 'auto', drop: ['hand'] }], data(rows));
    expect(r.ok).toBe(true);
    expect(r.value.changes.transactions).toEqual([rows[1]]);
    expect(r.value.changes.transactions[0]).toBe(rows[1]);
  });

  it('several groups at once, as the sheet applies them', () => {
    const rows = [
      tx('a1', { payee: 'Gym', from_budget: 'bi-x:2026-09' }),
      tx('lone', { payee: 'Solo', amount: 5 }),
      tx('a2', { payee: 'Gym', date: '2026-09-28', from_budget: 'bi-x:2026-09' }),
      tx('h', { payee: 'Rent', amount: 900, date: '2026-09-01' }),
      tx('p', { payee: 'Rent', amount: 900, date: '2026-09-03', from_budget: 'bi-rent:2026-09' }),
    ];
    const groups = findDuplicateGroups({ transactions: rows });
    expect(groups.map(toInput)).toEqual([{ keep: 'a1', drop: ['a2'] }, { keep: 'h', drop: ['p'] }]);
    const r = run(groups.map(toInput), data(rows));
    expect(r.ok).toBe(true);
    expect(r.value.changes.transactions).toEqual([rows[0], rows[1], { ...rows[3], from_budget: 'bi-rent:2026-09', modified_at: STAMP }]);
    expect(r.value.value).toEqual({ removed: 2 });
  });

  it('keeps the survivors in their original order', () => {
    const rows = [tx('z', { amount: 1, payee: 'Z' }), tx('b', { from_budget: 'k:1' }), tx('m', { amount: 2, payee: 'M' }), tx('a')];
    const r = run([{ keep: 'a', drop: ['b'] }], data(rows));
    expect(r.value.changes.transactions.map(t => t.id)).toEqual(['z', 'm', 'a']);
  });
});

describe('transaction.resolveDuplicates: what it writes', () => {
  it('never changes meta, and writes no tombstone for a removed row that had a key', () => {
    const rows = [tx('hand'), tx('auto', { from_budget: 'bi-x:2026-09' })];
    const r = run([{ keep: 'hand', drop: ['auto'] }], data(rows, { scheduledTombstones: ['old'] }));
    expect(r.ok).toBe(true);
    expect(Object.keys(r.value.changes)).toEqual(['transactions']);
    expect(r.value.changes.transactions).toEqual([{ ...rows[0], from_budget: 'bi-x:2026-09', modified_at: STAMP }]);
  });

  it('a keeper that already has the key is not touched, a keyless group stamps nothing', () => {
    const rows = [tx('a', { from_budget: 'k:1' }), tx('b', { from_budget: 'k:1', date: '2026-09-20' }), tx('c', { payee: 'P', amount: 3 }), tx('d', { payee: 'P', amount: 3 })];
    const r = run([{ keep: 'a', drop: ['b'] }, { keep: 'c', drop: ['d'] }], data(rows));
    expect(r.ok).toBe(true);
    expect(r.value.changes.transactions[0]).toBe(rows[0]);
    expect(r.value.changes.transactions[1]).toBe(rows[2]);
    expect(r.value.value).toEqual({ removed: 2 });
  });

  it('removes several copies of one row', () => {
    const rows = [tx('a'), tx('b'), tx('c')];
    const r = run([{ keep: 'b', drop: ['a', 'c'] }], data(rows));
    expect(r.value.changes.transactions).toEqual([rows[1]]);
    expect(r.value.value).toEqual({ removed: 2 });
  });
});

describe('transaction.resolveDuplicates: refusals', () => {
  const rows = [tx('a'), tx('b'), tx('c', { payee: 'P', amount: 3 }), tx('d', { payee: 'P', amount: 3 })];

  it('refuses an unknown id, keep or drop, with tx_not_found', () => {
    const k = run([{ keep: 'nope', drop: ['a'] }], data(rows));
    expect(k.ok).toBe(false);
    expect(k.error).toEqual({ code: 'tx_not_found', params: { id: 'nope' } });
    const d = run([{ keep: 'a', drop: ['b', 'ghost'] }], data(rows));
    expect(d.error).toEqual({ code: 'tx_not_found', params: { id: 'ghost' } });
  });

  it('refuses a keeper in its own drop list', () => {
    const r = run([{ keep: 'a', drop: ['a', 'b'] }], data(rows));
    expect(r.error.code).toBe('bad_input');
    expect(paths(r)).toEqual(['groups[0].drop']);
  });

  it('refuses an id in more than one group, or twice in one', () => {
    const r = run([{ keep: 'a', drop: ['b'] }, { keep: 'c', drop: ['b'] }], data(rows));
    expect(r.error.code).toBe('bad_input');
    expect(paths(r)).toEqual(['groups[1].drop']);
    const r2 = run([{ keep: 'a', drop: ['b', 'b'] }], data(rows));
    expect(r2.error.code).toBe('bad_input');
    const r3 = run([{ keep: 'a', drop: ['b'] }, { keep: 'b', drop: ['c'] }], data(rows));
    expect(r3.error.code).toBe('bad_input');
    expect(paths(r3)).toEqual(['groups[1].keep']);
  });

  it('refuses a group whose rows carry two different keys', () => {
    const two = [tx('a', { from_budget: 'k:1' }), tx('b', { from_budget: 'k:2' })];
    const r = run([{ keep: 'a', drop: ['b'] }], data(two));
    expect(r.error.code).toBe('bad_input');
    expect(paths(r)).toEqual(['groups[0]']);
  });

  it('refuses no groups, and a group with nothing to drop', () => {
    expect(run([], data(rows)).error.code).toBe('bad_input');
    const r = run([{ keep: 'a', drop: [] }], data(rows));
    expect(r.error.code).toBe('bad_input');
    expect(paths(r)).toEqual(['groups[0].drop']);
  });

  it('refuses a malformed group through the schema', () => {
    expect(run([{ keep: 'a' }], data(rows)).error.code).toBe('bad_input');
    expect(run([{ drop: ['a'] }], data(rows)).error.code).toBe('bad_input');
  });

  it('a refusal changes nothing (the input rows are frozen and untouched)', () => {
    const d = data(rows);
    run([{ keep: 'a', drop: ['b', 'ghost'] }], d);
    expect(d.transactions).toEqual(rows);
  });
});

describe('transaction.resolveDuplicates: a corrupt ledger', () => {
  it('execute passes a null row through untouched, as the old helper did, instead of throwing', () => {
    // The pipeline's rowDiff refuses a row without an id whatever the command,
    // so this is the command's own guard, exercised directly.
    const rows = [tx('hand'), null, tx('copy', { from_budget: 'bi-gym:2026-09' })];
    const r = registry.get('transaction.resolveDuplicates').execute(data(rows), { groups: [{ keep: 'hand', drop: ['copy'] }] }, ctx());
    expect(r.ok).toBe(true);
    expect(r.value.changes.transactions).toEqual([
      { ...rows[0], from_budget: 'bi-gym:2026-09', modified_at: STAMP }, null,
    ]);
    expect(r.value.value).toEqual({ removed: 1 });
  });
});

describe('transaction.resolveDuplicates: strict ledger', () => {
  it('refuses dropping a posted past row; force passes it', () => {
    const rows = [tx('hand', { date: '2026-01-03' }), tx('auto', { date: '2026-01-06', from_budget: 'bi-x:2026-01' })];
    const input = { groups: [{ keep: 'hand', drop: ['auto'] }] };
    const refused = runCommand(registry, data(rows), 'transaction.resolveDuplicates', input, ctx(), { policies: [strictLedger] });
    expect(refused.ok).toBe(false);
    expect(refused.error.code).toBe('ledger_history_locked');
    const forced = runCommand(registry, data(rows), 'transaction.resolveDuplicates', { ...input, force: true }, ctx(), { policies: [strictLedger] });
    expect(forced.ok).toBe(true);
    expect(forced.value.forced).toEqual(['history-locked']);
    expect(forced.value.changes.transactions.map(t => t.id)).toEqual(['hand']);
  });
});

describe('transaction.resolveDuplicates: registry', () => {
  it('is a public command, with its summary for help', () => {
    expect(registry.list().map(e => e.name)).toContain('transaction.resolveDuplicates');
    expect(registry.get('transaction.resolveDuplicates').internal).toBeUndefined();
  });
});
