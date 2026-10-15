import { describe, it, expect } from 'vitest';
import strictLedger, { EDITABLE_HISTORY_FIELDS } from '../js/core/policies/strict-ledger.js';
import { resolvePolicies, policyNames } from '../js/core/policies/index.js';
import { makeCtx } from '../js/core/context.js';

const ctx = makeCtx({ now: new Date(2026, 9, 15), newId: () => 'n' });
const tx = (id, date, extra = {}) => ({ id, type: 'expense', amount: 10, date, account: 'bank', ...extra });
const data = (transactions) => ({ meta: {}, accounts: [], envelopes: [], budgetItems: [], envelopeTemplates: [], transactions });
const check = (beforeTxs, afterTxs, input = {}) =>
  strictLedger.check(data(beforeTxs), data(afterTxs), { name: 'x', input }, ctx);

describe('strict-ledger', () => {
  it('allows today, scheduled future rows and untouched history', () => {
    const old = tx('o', '2026-09-01');
    expect(check([old], [old, tx('n', '2026-10-15')])).toBeNull();
    expect(check([old], [old, tx('s', '2026-11-01', { status: 'scheduled' })])).toBeNull();
  });

  it('refuses a posted row dated in the future, unless forced', () => {
    expect(check([], [tx('f', '2026-10-16')])).toEqual({ error: { code: 'ledger_future_posted', params: { id: 'f', date: '2026-10-16' } } });
    expect(check([], [tx('f', '2026-10-16')], { force: true })).toEqual({ forced: ['future-posted'] });
  });

  it('refuses posting a scheduled row with a future date', () => {
    const s = tx('s', '2026-11-01', { status: 'scheduled' });
    expect(check([s], [{ ...s, status: 'posted' }]).error.code).toBe('ledger_future_posted');
  });

  it('refuses editing or deleting posted history, but lets cleared and flagged change', () => {
    const old = tx('o', '2026-09-01');
    expect(check([old], [{ ...old, amount: 12 }]).error).toEqual({ code: 'ledger_history_locked', params: { id: 'o', date: '2026-09-01' } });
    expect(check([old], []).error.code).toBe('ledger_history_locked');
    expect(check([old], [{ ...old, cleared: true, flagged: true }])).toBeNull();
    expect(check([old], [], { force: true })).toEqual({ forced: ['history-locked'] });
    expect(EDITABLE_HISTORY_FIELDS).toEqual(['cleared', 'flagged', 'reversed_by', 'modified_at']);
  });

  it('lets a backdated row created today be edited, like Budget', () => {
    const r = tx('o', '2026-09-01', { created_at: new Date(2026, 9, 15, 8).toISOString() });
    expect(check([r], [{ ...r, amount: 12 }])).toBeNull();
  });

  it('lets reverse mark posted history', () => {
    const old = tx('o', '2026-09-01');
    expect(check([old], [{ ...old, reversed_by: 'x', modified_at: '2026-10-15T09:00:00.000Z' }])).toBeNull();
  });

  it('does not blame a legacy row that normalisation rewrote', () => {
    const legacy = tx('o', '2026-09-01', { amount: -10 });
    expect(check([legacy], [{ ...legacy, amount: 10 }])).toBeNull();
  });

  it('refuses a new set line, even when forced, but tolerates an existing one', () => {
    const fill = (id, lines) => ({ id, type: 'fill', date: '2026-10-15', lines });
    const setLines = [{ envelope_id: 'e', amount: 5, mode: 'set' }];
    expect(check([], [fill('f', setLines)], { force: true }).error).toEqual({ code: 'ledger_set_line', params: { id: 'f' } });
    const legacy = fill('g', setLines);
    expect(check([legacy], [{ ...legacy, note: 'x' }])).toBeNull();
  });

  it('ignores commands that do not touch transactions', () => {
    const txs = [tx('o', '2026-09-01')];
    expect(strictLedger.check(data(txs), { ...data(txs), transactions: txs }, { name: 'x', input: {} }, ctx)).toBeNull();
  });
});

describe('resolvePolicies', () => {
  it('resolves known names and refuses unknown ones', () => {
    expect(policyNames()).toEqual(['strict-ledger']);
    expect(resolvePolicies(['strict-ledger', 'strict-ledger'])).toEqual({ ok: true, value: [strictLedger] });
    expect(resolvePolicies(undefined)).toEqual({ ok: true, value: [] });
    expect(resolvePolicies(['lax'])).toEqual({ ok: false, error: { code: 'unknown_policy', params: { name: 'lax' } } });
  });

  it('refuses inherited property names like "constructor"', () => {
    expect(resolvePolicies(['constructor'])).toEqual({ ok: false, error: { code: 'unknown_policy', params: { name: 'constructor' } } });
  });
});
