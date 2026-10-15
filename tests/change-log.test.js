import { describe, it, expect } from 'vitest';
import { diffTransactionWrite, appendChangeLog, getChangeLog, CHANGE_LOG_CAP } from '../js/state/change-log.js';

const AT = '2026-10-01T12:00:00.000Z';
const rent = { id: 'r', type: 'expense', date: '2026-09-03', amount: 1200, account: 'chk', envelope_id: 'rent', payee: 'Landlord', status: 'posted' };
const food = { id: 'f', type: 'expense', date: '2026-09-04', amount: 50, account: 'chk', envelope_id: 'food', payee: 'Shop', status: 'posted' };

describe('diffTransactionWrite', () => {
  it('records an edit to a money field with the before and after rows', () => {
    const after = { ...rent, amount: 1250 };
    const out = diffTransactionWrite([rent, food], [after, food], AT);
    expect(out).toEqual([{ at: AT, op: 'edit', id: 'r', fields: ['amount'], before: rent, after }]);
  });

  it('records a delete', () => {
    expect(diffTransactionWrite([rent, food], [food], AT)).toEqual([
      { at: AT, op: 'delete', id: 'r', fields: [], before: rent },
    ]);
  });

  it('ignores additions, and edits that move no money (payee, note, flag)', () => {
    const extra = { ...food, id: 'n' };
    expect(diffTransactionWrite([rent], [rent, extra], AT)).toEqual([]);
    expect(diffTransactionWrite([rent], [{ ...rent, payee: 'L', note: 'x', flagged: true, modified_at: AT }], AT)).toEqual([]);
  });

  it('names every money field that changed, splits and cleared included', () => {
    const after = { ...rent, date: '2026-09-04', envelope_id: null, envelope_splits: [{ envelope_id: 'rent', amount: 1200 }], cleared: true };
    expect(diffTransactionWrite([rent], [after], AT)[0].fields).toEqual(['date', 'envelope_id', 'envelope_splits', 'cleared']);
  });

  it('ignores forecast rows', () => {
    const fc = { ...rent, id: 'fc', is_forecast: true };
    expect(diffTransactionWrite([fc], [], AT)).toEqual([]);
  });
});

describe('appendChangeLog / getChangeLog', () => {
  it('appends newest last and returns a new meta', () => {
    const meta = { currency: 'EUR' };
    const e1 = diffTransactionWrite([rent], [], AT);
    const next = appendChangeLog(meta, e1);
    expect(next).not.toBe(meta);
    expect(next.currency).toBe('EUR');
    expect(getChangeLog(next)).toEqual(e1);
    expect(getChangeLog(meta)).toEqual([]);
  });

  it('keeps only the newest CHANGE_LOG_CAP entries', () => {
    const many = Array.from({ length: CHANGE_LOG_CAP + 5 }, (_, i) => ({ at: AT, op: 'delete', id: `t${i}`, fields: [], before: {} }));
    const log = getChangeLog(appendChangeLog({}, many));
    expect(log).toHaveLength(CHANGE_LOG_CAP);
    expect(log[0].id).toBe('t5');
  });

  it('tolerates a malformed stored log', () => {
    expect(getChangeLog({ change_log: 'nope' })).toEqual([]);
  });
});

describe('diffTransactionWrite and the write normalisation', () => {
  it('a legacy signed amount saved as a magnitude is not an edit', () => {
    expect(diffTransactionWrite([{ ...rent, amount: -1200 }], [rent], AT)).toEqual([]);
  });
  it('an adjustment keeps its sign, so flipping it is', () => {
    const adj = { id: 'a', type: 'adjustment', target: 'account', target_id: 'chk', amount: -5, date: '2026-09-01' };
    expect(diffTransactionWrite([adj], [{ ...adj, amount: 5 }], AT)[0].fields).toEqual(['amount']);
  });
});
