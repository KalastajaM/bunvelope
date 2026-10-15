// transaction.repairTransferEndpoints: the load-time repair of envelope
// transfers stored under the pre-v3 endpoint names, as an internal command.
// The pure rewrite is repairEnvelopeTransferIds (tests/repair-envelope-transfer-ids.test.js);
// here: the command applies it to the ledger, reports what it did, and is
// invisible to help while staying dispatchable by name.
import { describe, it, expect } from 'vitest';
import { registry } from '../js/core/index.js';
import { runCommand } from '../js/core/pipeline.js';
import { makeCtx } from '../js/core/context.js';
import { repairEnvelopeTransferIds } from '../js/core/repair-envelope-transfer-ids.js';
import strictLedger from '../js/core/policies/strict-ledger.js';

function deepFreeze(o) { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); Object.values(o).forEach(deepFreeze); } return o; }
const NOW = new Date(2026, 9, 2, 10, 0, 0);
const ctx = () => makeCtx({ now: NOW, newId: () => 'n1' });
const envelopes = [{ id: 'env-a', name: 'A' }, { id: 'env-b', name: 'B' }];
const broken = (over = {}) => ({
  id: 'tx-1', type: 'envelope_transfer', date: '2026-07-01', amount: 50,
  from_envelope: 'env-a', to_envelope: 'env-b', ...over,
});
const fine = { id: 'ok', type: 'expense', date: '2026-07-02', payee: 'P', amount: 5, account: 'chk', envelope_id: 'env-a' };
const data = (transactions) => deepFreeze({
  meta: {}, budgetItems: [], envelopeTemplates: [],
  accounts: [{ id: 'chk', name: 'Checking' }], envelopes, transactions,
});
const run = (d) => runCommand(registry, d, 'transaction.repairTransferEndpoints', {}, ctx());

describe('transaction.repairTransferEndpoints', () => {
  it('writes what repairEnvelopeTransferIds returns, for the ledger and its envelopes', () => {
    const txs = [fine, broken(), broken({ id: 'tx-2', to_envelope: 'gone' })];
    const expected = repairEnvelopeTransferIds(txs, { envelopes });
    const r = run(data(txs));
    expect(r.ok).toBe(true);
    expect(r.value.changes.transactions).toEqual(expected.transactions);
    expect(r.value.changes.transactions[0]).toBe(fine);
    expect(r.value.changes.transactions[1]).toEqual({
      id: 'tx-1', type: 'envelope_transfer', date: '2026-07-01', amount: 50, from_envelope_id: 'env-a', to_envelope_id: 'env-b',
    });
    expect(Object.keys(r.value.changes)).toEqual(['transactions']);
  });

  it('reports { repaired, rows, unresolved }', () => {
    const r = run(data([broken(), broken({ id: 'tx-2', to_envelope: 'gone' })]));
    expect(r.value.value).toEqual({ repaired: 4, rows: 2, unresolved: ['gone'] });
  });

  it('with nothing to repair, changes nothing', () => {
    const r = run(data([fine, { ...broken(), from_envelope: undefined, to_envelope: undefined, from_envelope_id: 'env-a', to_envelope_id: 'env-b' }].map(t => JSON.parse(JSON.stringify(t)))));
    expect(r.ok).toBe(true);
    expect(r.value.changes).toEqual({});
    expect(r.value.value).toEqual({ repaired: 0, rows: 0, unresolved: [] });
  });

  it('a stray bare key beside an existing canonical field is cleaned but counts no endpoint', () => {
    // The loader dispatches only when repaired > 0; the command still reports it truthfully.
    const stray = broken({ from_envelope_id: 'env-a', to_envelope_id: 'env-b' });
    const r = run(data([stray]));
    expect(r.value.value).toMatchObject({ repaired: 0, rows: 1 });
  });

  it('is idempotent: a second pass over its own output changes nothing', () => {
    const first = run(data([broken()]));
    const second = run(data(first.value.changes.transactions));
    expect(second.value.changes).toEqual({});
  });

  it('under strict-ledger: refused without force (a posted past row changes), passes with force', () => {
    // A key rename is not a history edit, so the loader dispatches it with force: true.
    const d = data([broken()]);
    const refused = runCommand(registry, d, 'transaction.repairTransferEndpoints', {}, ctx(), { policies: [strictLedger] });
    expect(refused.ok).toBe(false);
    expect(refused.error).toEqual({ code: 'ledger_history_locked', params: { id: 'tx-1', date: '2026-07-01' } });
    const forced = runCommand(registry, d, 'transaction.repairTransferEndpoints', { force: true }, ctx(), { policies: [strictLedger] });
    expect(forced.ok).toBe(true);
    expect(forced.value.forced).toEqual(['history-locked']);
    expect(forced.value.changes.transactions[0]).toMatchObject({ from_envelope_id: 'env-a', to_envelope_id: 'env-b' });
  });

  it('is internal: hidden from list(), resolved by get(), and leaves payees alone', () => {
    expect(registry.list().map(e => e.name)).not.toContain('transaction.repairTransferEndpoints');
    expect(registry.list({ includeInternal: true }).map(e => e.name)).toContain('transaction.repairTransferEndpoints');
    const entry = registry.get('transaction.repairTransferEndpoints');
    expect(entry.kind).toBe('command');
    expect(entry.internal).toBe(true);
    expect(entry.payeeAliases).toBe(false);
  });
});
