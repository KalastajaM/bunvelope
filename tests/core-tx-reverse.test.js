import { describe, it, expect } from 'vitest';
import { registry } from '../js/core/index.js';
import { runCommand } from '../js/core/pipeline.js';
import { makeCtx } from '../js/core/context.js';
import strictLedger from '../js/core/policies/strict-ledger.js';
import { ERROR_CODES, describeError } from '../js/core/errors.js';
import { t as tr } from '../js/ui/i18n.js';

function deepFreeze(o) { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); Object.values(o).forEach(deepFreeze); } return o; }
const NOW = new Date(2026, 9, 2, 10, 0, 0);
const AT = NOW.toISOString();
const ctx = () => makeCtx({ now: NOW, newId: (() => { let n = 0; return () => `r${++n}`; })() });
const data = (txs) => deepFreeze({
  meta: {}, budgetItems: [], envelopeTemplates: [],
  accounts: [{ id: 'chk', name: 'Checking' }, { id: 'sav', name: 'Savings' }, { id: 'loan', name: 'Loan' }],
  envelopes: [{ id: 'groc', name: 'Groceries' }, { id: 'rent', name: 'Rent' }],
  transactions: txs,
});
const base = { date: '2026-09-10', payee: 'Shop', status: 'posted', note: 'orig note' };
const reverse = (tx, input = {}, opts) => runCommand(registry, data([tx]), 'transaction.reverse', { id: tx.id, ...input }, ctx(), opts);
const note = (tx) => `Reversal of ${tx.id} (${tx.date} "${tx.payee}" ${Math.abs(tx.amount).toFixed(2)})`;
const common = (tx) => ({
  id: 'r1', date: tx.date, payee: `Reversal: ${tx.payee}`, note: note(tx),
  status: 'posted', reverses: tx.id, created_at: AT, modified_at: AT,
});

describe('transaction.reverse mirror rows', () => {
  it('expense becomes an income on the same account and envelope', () => {
    const tx = { ...base, id: 'x', type: 'expense', amount: 12.5, account: 'chk', envelope_id: 'groc', cleared: false };
    const r = reverse(tx);
    expect(r.ok).toBe(true);
    const mirror = { ...common(tx), type: 'income', amount: 12.5, account: 'chk', envelope_id: 'groc', cleared: true };
    expect(r.value.value.reversal).toEqual([mirror]);
    const rows = r.value.changes.transactions;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ ...tx, reversed_by: 'r1', modified_at: AT });
    expect(rows[1]).toEqual(mirror);
  });

  it('omits envelope_id when the original has none', () => {
    const tx = { ...base, id: 'x', type: 'expense', amount: 3, account: 'chk', envelope_id: null };
    const m = reverse(tx).value.value.reversal[0];
    expect(m).not.toHaveProperty('envelope_id');
    expect(m.type).toBe('income');
  });

  it('income becomes an expense', () => {
    const tx = { ...base, id: 'x', type: 'income', amount: 100, account: 'chk', envelope_id: 'rent' };
    expect(reverse(tx).value.value.reversal).toEqual([
      { ...common(tx), type: 'expense', amount: 100, account: 'chk', envelope_id: 'rent', cleared: true },
    ]);
  });

  it('puts the original payee and an optional note into the text', () => {
    const tx = { ...base, id: 'x', type: 'expense', amount: 5, account: 'chk', payee: 'Café "Olé"' };
    const m = reverse(tx, { note: 'wrong shop' }).value.value.reversal[0];
    expect(m.payee).toBe('Reversal: Café "Olé"');
    expect(m.note).toBe('Reversal of x (2026-09-10 "Café "Olé"" 5.00) — wrong shop');
    expect(reverse(tx, { note: '' }).value.value.reversal[0].note).toBe('Reversal of x (2026-09-10 "Café "Olé"" 5.00)');
  });

  it('uses an empty payee when the original has none', () => {
    const tx = { ...base, id: 'x', type: 'expense', amount: 5, account: 'chk', payee: undefined };
    const m = reverse(tx).value.value.reversal[0];
    expect(m.payee).toBe('Reversal: ');
    expect(m.note).toBe('Reversal of x (2026-09-10 "" 5.00)');
  });

  it('account_transfer swaps the accounts', () => {
    const tx = { ...base, id: 'x', type: 'account_transfer', amount: 40, from_account: 'chk', to_account: 'sav', cleared: true };
    expect(reverse(tx).value.value.reversal).toEqual([
      { ...common(tx), type: 'account_transfer', amount: 40, from_account: 'sav', to_account: 'chk', cleared: true },
    ]);
  });

  it('debt_payment without an envelope is one swapped transfer', () => {
    const tx = { ...base, id: 'x', type: 'debt_payment', amount: 200, from_account: 'chk', to_account: 'loan' };
    expect(reverse(tx).value.value.reversal).toEqual([
      { ...common(tx), type: 'account_transfer', amount: 200, from_account: 'loan', to_account: 'chk', cleared: true },
    ]);
  });

  it('debt_payment with an envelope also credits the envelope back, and reversed_by names the first row', () => {
    const tx = { ...base, id: 'x', type: 'debt_payment', amount: 200, from_account: 'chk', to_account: 'loan', envelope_id: 'rent' };
    const r = reverse(tx);
    expect(r.value.value.reversal).toEqual([
      { ...common(tx), type: 'account_transfer', amount: 200, from_account: 'loan', to_account: 'chk', cleared: true },
      { ...common(tx), id: 'r2', type: 'adjustment', amount: 200, target: 'envelope', target_id: 'rent', cleared: true },
    ]);
    const rows = r.value.changes.transactions;
    expect(rows).toHaveLength(3);
    expect(rows[0].reversed_by).toBe('r1');
  });

  it('investment buy becomes a sell with swapped accounts, units and price, and no fee', () => {
    const tx = { ...base, id: 'x', type: 'investment_transfer', direction: 'buy', amount: 500, from_account: 'chk', to_account: 'sav', symbol: 'VWRL', envelope_id: 'rent', units: 4.5, pricePerUnit: 111.11, fee: 2 };
    expect(reverse(tx).value.value.reversal).toEqual([
      { ...common(tx), type: 'investment_transfer', amount: 500, direction: 'sell', from_account: 'sav', to_account: 'chk', symbol: 'VWRL', envelope_id: 'rent', units: 4.5, pricePerUnit: 111.11, cleared: true },
    ]);
  });

  it('investment sell becomes a buy; no units or price means none on the mirror', () => {
    const tx = { ...base, id: 'x', type: 'investment_transfer', direction: 'sell', amount: 500, from_account: 'sav', to_account: 'chk', symbol: 'VWRL' };
    const m = reverse(tx).value.value.reversal[0];
    expect(m.direction).toBe('buy');
    expect(m.from_account).toBe('chk');
    expect(m.to_account).toBe('sav');
    expect(m).not.toHaveProperty('units');
    expect(m).not.toHaveProperty('pricePerUnit');
    expect(m).not.toHaveProperty('envelope_id');
    expect(m).not.toHaveProperty('fee');
  });

  it('investment mirror uses the magnitude of units and price', () => {
    const tx = { ...base, id: 'x', type: 'investment_transfer', direction: 'sell', amount: 50, from_account: 'sav', to_account: 'chk', symbol: 'V', units: -2, pricePerUnit: -25 };
    const m = reverse(tx).value.value.reversal[0];
    expect(m.units).toBe(2);
    expect(m.pricePerUnit).toBe(25);
  });

  it('envelope_transfer swaps the envelopes and has no cleared key', () => {
    const tx = { ...base, id: 'x', type: 'envelope_transfer', amount: 25, from_envelope_id: 'groc', to_envelope_id: 'rent' };
    const m = reverse(tx).value.value.reversal[0];
    expect(m).toEqual({ ...common(tx), type: 'envelope_transfer', amount: 25, from_envelope_id: 'rent', to_envelope_id: 'groc' });
    expect(m).not.toHaveProperty('cleared');
  });

  it('adjustment negates its signed amount on the same target', () => {
    const plus = { ...base, id: 'x', type: 'adjustment', amount: 7.25, target: 'envelope', target_id: 'groc' };
    expect(reverse(plus).value.value.reversal).toEqual([
      { ...common(plus), type: 'adjustment', amount: -7.25, target: 'envelope', target_id: 'groc', cleared: true },
    ]);
    const minus = { ...base, id: 'y', type: 'adjustment', amount: -3, target: 'account', target_id: 'chk' };
    expect(reverse(minus).value.value.reversal[0].amount).toBe(3);
  });

  it('fill negates every line in add mode and keeps the source', () => {
    const tx = { ...base, id: 'x', type: 'fill', amount: 0, source: 'new_income', source_account: 'chk', lines: [{ envelope_id: 'groc', amount: 30, mode: 'add' }, { envelope_id: 'rent', amount: -10 }] };
    const m = reverse(tx).value.value.reversal[0];
    expect(m).toEqual({
      ...common(tx), type: 'fill', source: 'new_income', source_account: 'chk',
      lines: [{ envelope_id: 'groc', mode: 'add', amount: -30 }, { envelope_id: 'rent', mode: 'add', amount: 10 }],
    });
    expect(m).not.toHaveProperty('cleared');
  });

  it('fill defaults its source to allocation and drops source_account otherwise', () => {
    const tx = { ...base, id: 'x', type: 'fill', amount: 0, source_account: 'chk', lines: [{ envelope_id: 'groc', amount: 30, mode: 'add' }] };
    const m = reverse(tx).value.value.reversal[0];
    expect(m.source).toBe('allocation');
    expect(m).not.toHaveProperty('source_account');
  });
});

describe('transaction.reverse dating', () => {
  it('dates the mirror with the original by default', () => {
    const tx = { ...base, id: 'x', type: 'expense', amount: 5, account: 'chk', date: '2026-03-04' };
    expect(reverse(tx).value.value.reversal[0].date).toBe('2026-03-04');
  });

  it('takes an explicit date', () => {
    const tx = { ...base, id: 'x', type: 'expense', amount: 5, account: 'chk' };
    const r = reverse(tx, { date: '2026-10-02' });
    expect(r.value.value.reversal[0].date).toBe('2026-10-02');
    expect(r.value.value.reversal[0].note).toContain('2026-09-10');
  });
});

describe('transaction.reverse refusals', () => {
  const exp = { ...base, id: 'x', type: 'expense', amount: 5, account: 'chk' };

  it('tx_not_found', () => {
    const r = runCommand(registry, data([exp]), 'transaction.reverse', { id: 'nope' }, ctx());
    expect(r.error).toEqual({ code: 'tx_not_found', params: { id: 'nope' } });
  });

  it('already_reversed names the mirror', () => {
    const r = reverse({ ...exp, reversed_by: 'm9' });
    expect(r.error).toEqual({ code: 'already_reversed', params: { id: 'x', by: 'm9' } });
  });

  it.each([
    ['split', { ...exp, envelope_splits: [{ envelope_id: 'groc', amount: 2 }, { envelope_id: 'rent', amount: 3 }] }],
    ['set_fill', { ...base, id: 'x', type: 'fill', amount: 0, lines: [{ envelope_id: 'groc', amount: 5, mode: 'set' }] }],
    ['no_mirror', { ...base, id: 'x', type: 'investment_transfer', direction: 'dividend', amount: 5, from_account: 'chk', to_account: 'sav' }],
    ['no_mirror', { ...base, id: 'x', type: 'investment_transfer', direction: 'adjust', amount: 5, from_account: 'chk', to_account: 'sav' }],
    ['scheduled', { ...exp, status: 'scheduled' }],
    ['type', { ...exp, type: 'mystery' }],
  ])('reverse_unsupported (%s)', (reason, tx) => {
    const r = reverse(tx);
    expect(r.error).toEqual({ code: 'reverse_unsupported', params: { id: 'x', reason } });
  });

  it('an empty envelope_splits array is not a split', () => {
    expect(reverse({ ...exp, envelope_splits: [] }).ok).toBe(true);
  });

  it('describes both new codes in every locale', () => {
    expect(ERROR_CODES).toEqual(expect.arrayContaining(['already_reversed', 'reverse_unsupported']));
    expect(describeError({ code: 'already_reversed', params: { by: 'm9' } }, tr)).toBe('Already reversed by m9');
    expect(describeError({ code: 'reverse_unsupported', params: { reason: 'split' } }, tr)).toBe('This transaction cannot be reversed automatically: split expenses are not supported');
  });
});

describe('transaction.reverse under strict-ledger', () => {
  it('reverses a posted past row', () => {
    const tx = { ...base, id: 'x', type: 'expense', amount: 5, account: 'chk', date: '2026-08-01', created_at: '2026-08-01T08:00:00.000Z' };
    const r = reverse(tx, {}, { policies: [strictLedger] });
    expect(r.ok).toBe(true);
    expect(r.value.changes.transactions[0].reversed_by).toBe('r1');
  });
});
