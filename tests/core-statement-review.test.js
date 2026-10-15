import { describe, it, expect } from 'vitest';
import { registry } from '../js/core/index.js';
import { runQuery, runCommand } from '../js/core/pipeline.js';
import { makeCtx } from '../js/core/context.js';
import { parseRow, detectColumns } from '../js/import/csv-parse-generic.js';

const ctx = makeCtx({ now: new Date(2026, 9, 12), newId: () => 'unused' });
const tx = (id, date, amount, payee = 'Shop', extra = {}) => ({ id, account: 'bank', type: 'expense', amount, date, payee, ...extra });
const row = (key, date, amount, payee = 'Shop', extra = {}) => ({ key, date, amount, payee, ...extra });
function review(rows, transactions = [], input = {}, meta = {}) {
  const result = runQuery(registry, { accounts: [{ id: 'bank', type: 'bank', initialBalance: 100 }], transactions, meta },
    'import.review', { account: 'bank', rows, ...input }, ctx);
  expect(result.ok).toBe(true);
  return result.value;
}

describe('statement review', () => {
  it('uses cleared and checked rows for reconciliation without losing unchecked duplicate matches', () => {
    const rows = [row('spotify', '2026-10-12', -21.98, 'Spotify'),
      ...[7.40, 83.82, 61.94, 69.75].map((v, i) => row(`p${i}`, '2026-10-12', -v, 'Reservation', { bankStatus: 'pending' }))];
    const transactions = [tx('prior', '2026-10-11', 293.62, 'Prior', { cleared: true }), tx('spotify', '2026-10-12', 21.98, 'Spotify')];
    const input = { target: -416.53, date: '2026-10-12', selected: ['p0', 'p1', 'p2', 'p3'] };
    expect(review(rows, transactions, input).balance.ledgerRemaining).toBe(21.98);
    const result = review(rows, transactions, { ...input, checked: [] });
    expect(result.balance).toMatchObject({ target: -416.53, ledger: -193.62, selectedDelta: -222.91, projected: -416.53, ledgerRemaining: 0 });
    expect(result.rows[0]).toMatchObject({ group: 'recorded', match: { id: 'spotify' } });
    expect(result.suggestion.status).toBe('balanced');
    expect(review(rows, transactions, { ...input, checked: ['spotify'] }).balance.ledgerRemaining).toBe(21.98);
  });
  it('previews checked scheduled rows as posted for matching and balance', () => {
    const result = review([row('scheduled', '2026-10-12', -20), row('new', '2026-10-12', -5, 'New')],
      [tx('scheduled', '2026-10-12', 20, 'Shop', { status: 'scheduled' })],
      { target: 75, date: '2026-10-12', checked: ['scheduled'] });
    expect(result.rows.map(r => r.group)).toEqual(['recorded', 'missing']);
    expect(result.balance).toMatchObject({ ledger: 80, selectedDelta: -5, projected: 75, ledgerRemaining: 0 });
  });
  it.each(['booked', 'available'])('updates the literal bank difference for every selected reservation (%s)', basis => {
    const rows = [row('a', '2026-10-01', -12, 'Reservation', { bankStatus: 'pending' })];
    const before = review(rows, [], { target: 89, basis, selected: [] });
    const after = review(rows, [], { target: 89, basis, selected: ['a'] });
    expect(before.balance.ledgerRemaining).toBe(-11);
    expect(after.balance).toMatchObject({ projected: 88, ledgerRemaining: 1 });
    const imported = review(rows, [tx('new', '2026-10-01', 12, 'Reservation')], { target: 89, basis, selected: [] });
    expect(imported.balance.ledgerRemaining).toBe(after.balance.ledgerRemaining);
  });
  it('parses statement status and running balances without treating a blank balance as zero', () => {
    const headers = ['Date', 'Text', 'Amount', 'Balance', 'Status'];
    const mapping = { ...detectColumns(headers), headers, decimal: ',' };
    expect(parseRow(['10.10.2026', 'Shop', '-5,00', '95,00', 'Executed'], mapping)).toMatchObject({ bankStatus: 'booked', bankBalance: 95 });
    expect(parseRow(['10.10.2026', 'Reservation', '-5,00', '', 'Pending'], mapping)).toMatchObject({ bankStatus: 'pending' });
    expect(parseRow(['10.10.2026', 'Reservation', '-5,00', '', 'Pending'], mapping)).not.toHaveProperty('bankBalance');
  });
  it('uses confirmed aliases, keeps original bank wording and claims each booking only once', () => {
    const result = review([row('a', '2026-10-01', -5, 'Bank merchant'), row('b', '2026-10-01', -5, 'Bank merchant')],
      [tx('old', '2026-10-01', 5, 'Shop')], {}, { payeeAliases: { 'bank merchant': 'Shop' } });
    expect(result.rows.map(r => r.group)).toEqual(['recorded', 'missing']);
    expect(result.rows[0]).toMatchObject({ payee: 'Bank merchant', match: { id: 'old' } });
  });
  it('does not hide shifted dates, ambiguous payees or scheduled rows as recorded', () => {
    const result = review([row('a', '2026-10-02', -5), row('b', '2026-10-03', -6, 'Different'), row('c', '2026-10-04', -7)],
      [tx('a', '2026-10-01', 5), tx('b', '2026-10-03', 6), tx('c', '2026-10-04', 7, 'Shop', { status: 'scheduled' })]);
    expect(result.rows.map(r => r.group)).toEqual(['review', 'review', 'missing']);
  });
  it('keeps pending reservations separate and explains their already recorded impact', () => {
    const result = review([row('a', '2026-10-10', -6, 'Shop', { bankStatus: 'booked', bankBalance: 94 }),
      row('b', '2026-10-09', -10, 'Reservation', { bankStatus: 'pending' })],
    [tx('a', '2026-10-10', 6), tx('b', '2026-10-09', 10, 'Clinic')], { target: 94, date: '2026-10-10', basis: 'booked' });
    expect(result.rows.map(r => r.group)).toEqual(['recorded', 'pending']);
    expect(result.balance).toMatchObject({ ledger: 84, rawGap: 10, gap: 0, comparisonLedger: 94, pendingRecorded: -10, bookedEstimate: 94, pendingExplainsGap: true });
    expect(result.suggestion.status).toBe('pending');
  });
  it('flags unmatched history at or before an account reconciliation adjustment', () => {
    const result = review([row('a', '2026-09-20', -5), row('b', '2026-10-02', -8)],
      [{ id: 'adj', date: '2026-09-30', type: 'adjustment', target: 'account', target_id: 'bank', amount: -5 }]);
    expect(result.rows.map(r => [r.group, r.adjustmentDate])).toEqual([['review', '2026-09-30'], ['missing', null]]);
    expect(result.rows[0].included).toBe(false);
  });
  it('finds a unique gap explanation without selecting it automatically', () => {
    const result = review([row('a', '2026-10-01', -8), row('b', '2026-10-01', -3), row('c', '2026-10-01', -20)], [], { target: 89, date: '2026-10-02' });
    expect(result.suggestion).toMatchObject({ status: 'unique', keys: ['a', 'b'] });
    expect(result.balance).toMatchObject({ ledger: 100, selectedDelta: -31, remaining: 20 });
  });
  it('reports ambiguity for repeated amounts and never suggests rows after the target date', () => {
    const result = review([row('a', '2026-10-01', -5), row('b', '2026-10-01', -5), row('c', '2026-10-03', -10)], [], { target: 95, date: '2026-10-02' });
    expect(result.suggestion.status).toBe('ambiguous');
    expect(result.rows[2]).toMatchObject({ afterDate: true, included: false });
    expect(result.balance.remaining).toBe(5);
  });
  it('does not silently pick one of different combinations that reach the same balance', () => {
    expect(review([row('a', '2026-10-01', -5), row('b', '2026-10-01', -2), row('c', '2026-10-01', -3)], [], { target: 95 }).suggestion.status).toBe('ambiguous');
  });
  it('uses the latest booked statement day but refuses an ambiguous same-day closing balance', () => {
    const result = review([row('a', '2026-10-01', -5, 'A', { bankBalance: 95 }), row('b', '2026-10-01', -2, 'B', { bankBalance: 93 })]);
    expect(result.statement).toMatchObject({ date: '2026-10-01', closingBalance: null });
  });
  it('explains available balance with reservations not yet recorded without suggesting importing them', () => {
    const r = review([row('p', '2026-10-01', -10, 'Reservation', { bankStatus: 'pending' })], [], { target: 90, date: '2026-10-01', basis: 'available' });
    expect(r.balance).toMatchObject({ ledger: 100, comparisonLedger: 90, gap: 0, remaining: 0 });
    expect(r.rows[0].included).toBe(false);
    expect(r.suggestion.keys).toEqual([]);
  });
  it('uses booked balance for a missing-booking suggestion when a confidently matched reservation is already recorded', () => {
    const r = review([row('p', '2026-10-01', -10, 'Clinic', { bankStatus: 'pending' }), row('m', '2026-10-01', -5)],
      [tx('p', '2026-10-01', 10, 'Clinic')], { target: 95, date: '2026-10-01', basis: 'booked' });
    expect(r.balance).toMatchObject({ ledger: 90, comparisonLedger: 100, gap: -5, remaining: 0 });
    expect(r.suggestion).toEqual({ status: 'unique', keys: ['m'] });
  });
  it('does not offer a unique suggestion based on a reservation matched by amount alone', () => {
    const r = review([row('p', '2026-10-01', -10, 'Reservation', { bankStatus: 'pending' }), row('m', '2026-10-01', -5)],
      [tx('p', '2026-10-01', 10, 'Clinic')], { target: 95, date: '2026-10-01', basis: 'booked' });
    expect(r.suggestion).toEqual({ status: 'pending', keys: [] });
  });
  it('counts a newly selected reservation once in available comparison and never in booked comparison', () => {
    for (const basis of ['booked', 'available']) {
      const r = review([row('p', '2026-10-01', -10, 'Reservation', { bankStatus: 'pending' })], [], { target: basis === 'booked' ? 100 : 90, date: '2026-10-01', basis, selected: ['p'] });
      expect(r.balance).toMatchObject({ projected: 90, remaining: 0 });
    }
  });
  it('does not report a match after explicitly adding an already recorded reservation again', () => {
    const rows = [row('p', '2026-10-01', -10, 'Clinic', { bankStatus: 'pending' })];
    const before = review(rows, [tx('old', '2026-10-01', 10, 'Clinic')], { target: 100, date: '2026-10-01', selected: ['p'] });
    expect(before.balance).toMatchObject({ projected: 80, comparisonProjected: 90, remaining: 10 });
    const after = review(rows, [tx('old', '2026-10-01', 10, 'Clinic'), tx('new', '2026-10-01', 10, 'Clinic')], { target: 100, date: '2026-10-01', selected: [] });
    expect(after.balance.remaining).toBe(before.balance.remaining);
  });
  it('provides a recorded-balance target for reconciliation without absorbing unrecorded reservations into an adjustment', () => {
    const r = review([row('p', '2026-10-01', -10, 'Reservation', { bankStatus: 'pending' })], [], { target: 90, date: '2026-10-01', basis: 'available' });
    expect(r.balance.reconcileTarget).toBe(100);
  });
  it('does not count a reservation match beyond the balance date in the projected dated balance', () => {
    const r = review([row('p', '2026-10-01', -10, 'Clinic', { bankStatus: 'pending' })],
      [tx('later', '2026-10-02', 10, 'Clinic')], { target: 100, date: '2026-10-01', selected: ['p'] });
    expect(r.balance).toMatchObject({ comparisonProjected: 100, remaining: 0 });
  });
  it.each([false, true])('accounts for cleared reservations in the reconciliation target: %s', cleared => {
    const r = review([row('p', '2026-10-01', -10, 'Clinic', { bankStatus: 'pending' })],
      [{ ...tx('p', '2026-10-01', 10, 'Clinic'), cleared }], { target: 90, date: '2026-10-01', basis: 'available' });
    expect(r.balance.reconcileTarget).toBe(cleared ? 90 : 100);
  });
  it('refuses a statement import if the ledger changed after review, including at command execution', () => {
    const rows = [row('a', '2026-10-01', -5)];
    const r = review(rows);
    const input = { rows: [{ type: 'expense', account: 'bank', date: '2026-10-01', payee: 'Shop', amount: 5 }], expectedStatement: { account: 'bank', context: r.context } };
    const data = { accounts: [{ id: 'bank', type: 'bank', initialBalance: 100 }], transactions: [], meta: {} };
    expect(runCommand(registry, data, 'transaction.import', input, ctx).ok).toBe(true);
    const changed = { ...data, transactions: [tx('new', '2026-10-01', 5)] };
    expect(runCommand(registry, changed, 'transaction.import', input, ctx)).toMatchObject({ ok: false, error: { code: 'import_review_changed' } });
  });
});
