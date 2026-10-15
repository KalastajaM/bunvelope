// tests/ai-proposal.test.js — the guards between a model's output and the
// ledger. These are the tests that matter most in the AI feature: everything
// else is UI around them.

import { describe, it, expect } from 'vitest';
import {
  makeProposal, validateProposal, proposalToRecordSteps,
  committableRows, needsReview, sortForReview,
} from '../js/ai/proposal.js';
import { registry } from '../js/core/index.js';
import { runBatch } from '../js/core/pipeline.js';
import { makeCtx } from '../js/core/context.js';
import { recordProposal } from './_fakes/recordProposal.js';

function fixtureState() {
  return {
    envelopes: [
      { id: 'env-groceries', name: 'Groceries' },
      { id: 'env-dining', name: 'Dining' },
    ],
    accounts: [
      { id: 'acc-checking', name: 'Checking' },
      { id: 'acc-savings', name: 'Savings' },
    ],
    transactions: [],
  };
}

function row(over = {}) {
  return {
    date: '2026-08-01',
    payee: 'K-Market',
    amount: 42.5,
    type: 'expense',
    account_id: 'acc-checking',
    envelope_id: 'env-groceries',
    confidence: 0.9,
    ...over,
  };
}

describe('validateProposal — ids are validated, not trusted', () => {
  it('drops an envelope id that is not in this budget', () => {
    const p = validateProposal(
      makeProposal({ kind: 'transactions', rows: [row({ envelope_id: 'env-hallucinated' })] }),
      fixtureState(),
    );
    expect(p.rows[0].envelope_id).toBe(null);
    expect(p.rows[0].warnings.map((w) => w.code)).toContain('unknown_envelope');
    expect(p.warnings.map((w) => w.code)).toContain('unknown_ids');
  });

  it('drops an account id that is not in this budget', () => {
    const p = validateProposal(
      makeProposal({ kind: 'transactions', rows: [row({ account_id: 'acc-nope' })] }),
      fixtureState(),
    );
    expect(p.rows[0].account_id).toBe(null);
    expect(p.rows[0].warnings.map((w) => w.code)).toContain('unknown_account');
  });

  it('keeps ids that do exist', () => {
    const p = validateProposal(
      makeProposal({ kind: 'transactions', rows: [row()] }),
      fixtureState(),
    );
    expect(p.rows[0].envelope_id).toBe('env-groceries');
    expect(p.rows[0].account_id).toBe('acc-checking');
    expect(p.rows[0].warnings).toHaveLength(0);
  });
});

describe('validateProposal — transfer sides are validated too', () => {
  it('nulls a from_envelope_id that does not exist', () => {
    const p = validateProposal(makeProposal({
      kind: 'transactions',
      rows: [row({
        type: 'envelope_transfer',
        from_envelope_id: 'env-invented',
        to_envelope_id: 'env-dining',
        envelope_id: 'env-dining',
      })],
    }), fixtureState());
    expect(p.rows[0].from_envelope_id).toBe(null);
    expect(p.rows[0].to_envelope_id).toBe('env-dining');
    expect(p.rows[0].warnings.map((w) => w.code)).toContain('unknown_envelope');
  });

  it('nulls a to_account that does not exist', () => {
    const p = validateProposal(makeProposal({
      kind: 'transactions',
      rows: [row({ type: 'account_transfer', from_account: 'acc-checking', to_account: 'acc-ghost' })],
    }), fixtureState());
    expect(p.rows[0].from_account).toBe('acc-checking');
    expect(p.rows[0].to_account).toBe(null);
    expect(p.rows[0].warnings.map((w) => w.code)).toContain('unknown_account');
  });
});

describe('validateProposal — unreadable rows are dropped, never guessed', () => {
  it('drops a row with no parseable date', () => {
    const p = validateProposal(
      makeProposal({ kind: 'transactions', rows: [row({ date: 'sometime last week' })] }),
      fixtureState(),
    );
    expect(p.rows).toHaveLength(0);
    expect(p.warnings.map((w) => w.code)).toContain('rows_dropped');
  });

  it('drops a row with no usable amount', () => {
    const p = validateProposal(
      makeProposal({ kind: 'transactions', rows: [row({ amount: 'illegible' }), row({ amount: 0 })] }),
      fixtureState(),
    );
    expect(p.rows).toHaveLength(0);
  });

  it('accepts the Date object parseRow actually returns', () => {
    // The importer's own parser produces Dates, not strings. Stringifying one
    // before parsing dropped every row of a real CSV import.
    const p = validateProposal(
      makeProposal({ kind: 'transactions', rows: [row({ date: new Date(2026, 7, 3) })] }),
      fixtureState(),
    );
    expect(p.rows).toHaveLength(1);
    expect(p.rows[0].date).toBe('2026-08-03');
  });

  it('normalises dd/mm/yyyy dates to ISO', () => {
    const p = validateProposal(
      makeProposal({ kind: 'transactions', rows: [row({ date: '03/08/2026' })] }),
      fixtureState(),
    );
    expect(p.rows[0].date).toBe('2026-08-03');
  });
});

describe('validateProposal — sign is never the model output', () => {
  it('strips a negative amount down to a magnitude', () => {
    const p = validateProposal(
      makeProposal({ kind: 'transactions', rows: [row({ amount: -42.5 })] }),
      fixtureState(),
    );
    expect(p.rows[0].amount).toBe(42.5);
  });

  it('infers a type from the parser sign when the model gives none', () => {
    const state = fixtureState();
    const out = validateProposal(makeProposal({
      kind: 'transactions',
      rows: [row({ type: null, amount: -12 }), row({ type: null, amount: 300 })],
    }), state);
    expect(out.rows[0].type).toBe('expense');
    expect(out.rows[1].type).toBe('income');
  });

  it('refuses a transaction type outside the allowed set', () => {
    const p = validateProposal(
      makeProposal({ kind: 'transactions', rows: [row({ type: 'fill', amount: -5 })] }),
      fixtureState(),
    );
    // Not silently written through as a fill — falls back to the sign rule.
    expect(p.rows[0].type).toBe('expense');
  });
});

describe('validateProposal — total cross-check', () => {
  it('flags a row sum that disagrees with the printed total', () => {
    const p = validateProposal(makeProposal({
      kind: 'transactions',
      rows: [row({ amount: 10 }), row({ amount: 20 })],
      meta: { declaredTotal: 33 },   // a misread digit
    }), fixtureState());
    expect(p.warnings.map((w) => w.code)).toContain('total_mismatch');
    expect(p.meta.computedTotal).toBe(30);
  });

  it('stays quiet when the totals agree', () => {
    const p = validateProposal(makeProposal({
      kind: 'transactions',
      rows: [row({ amount: 10 }), row({ amount: 20.5 })],
      meta: { declaredTotal: 30.5 },
    }), fixtureState());
    expect(p.warnings.map((w) => w.code)).not.toContain('total_mismatch');
  });

  it('tolerates the printed total being negative', () => {
    const p = validateProposal(makeProposal({
      kind: 'transactions',
      rows: [row({ amount: 10 })],
      meta: { declaredTotal: -10 },
    }), fixtureState());
    expect(p.warnings.map((w) => w.code)).not.toContain('total_mismatch');
  });

  it('says nothing when the document printed no total', () => {
    const p = validateProposal(makeProposal({
      kind: 'transactions', rows: [row({ amount: 10 })],
    }), fixtureState());
    expect(p.warnings).toHaveLength(0);
  });
});

// What an approved proposal becomes once recorded: its record steps' inputs,
// imported in one transaction.import (as the import sheet and the dialog do).
describe('an approved proposal, recorded', () => {
  it('emits positive magnitudes for type-signed rows', () => {
    const state = fixtureState();
    const p = validateProposal(makeProposal({
      kind: 'transactions',
      rows: [row({ amount: -42.5 }), row({ amount: -1200, type: 'income' })],
    }), state);
    const txs = recordProposal(p, state);
    expect(txs).toHaveLength(2);
    expect(txs.every((tx) => tx.amount > 0)).toBe(true);
  });

  it('uses `account`, matching the shape add-tx writes', () => {
    const state = fixtureState();
    const p = validateProposal(makeProposal({ kind: 'transactions', rows: [row()] }), state);
    const [tx] = recordProposal(p, state);
    expect(tx.account).toBe('acc-checking');
    expect(tx.envelope_id).toBe('env-groceries');
    expect(tx.account_id).toBeUndefined();
  });

  it('excludes rows matched to an existing transaction', () => {
    const state = fixtureState();
    const p = validateProposal(makeProposal({
      kind: 'transactions',
      rows: [row(), row({ payee: 'Already there', duplicateOf: 'tx-7' })],
    }), state);
    expect(committableRows(p)).toHaveLength(1);
    expect(recordProposal(p, state)).toHaveLength(1);
  });

  it('excludes rows the user unchecked in review', () => {
    const state = fixtureState();
    const p = validateProposal(makeProposal({ kind: 'transactions', rows: [row(), row()] }), state);
    p.rows[0].excluded = true;
    expect(recordProposal(p, state)).toHaveLength(1);
  });

  it('leaves ids to the session (one newId per row) and marks every row\'s provenance', () => {
    const state = fixtureState();
    const p = validateProposal(makeProposal({
      kind: 'transactions', rows: [row(), row()], meta: { source: 'receipt' },
    }), state);
    // The proposal sends no id of its own, so two identical rows cannot collide:
    // each recorded row takes the next ctx.newId() (recordProposal's `rec-n`).
    expect(proposalToRecordSteps(p, state).some((s) => 'id' in s.input)).toBe(false);
    const txs = recordProposal(p, state);
    expect(txs.map((t) => t.id)).toEqual(['rec-1', 'rec-2']);
    expect(txs.map((t) => t.source)).toEqual(['receipt', 'receipt']);
  });

  it('falls back to the first unarchived account when none was resolved', () => {
    const state = fixtureState();
    state.accounts.unshift({ id: 'acc-old', name: 'Closed', archived: true });
    const p = validateProposal(
      makeProposal({ kind: 'transactions', rows: [row({ account_id: null })] }),
      state,
    );
    const [tx] = recordProposal(p, state);
    expect(tx.account).toBe('acc-checking');
  });

  it('carries a multi-envelope split through and clears the single id', () => {
    const state = fixtureState();
    const p = validateProposal(makeProposal({
      kind: 'transactions',
      rows: [row({
        amount: 50,
        envelope_splits: [
          { envelope_id: 'env-groceries', amount: 30 },
          { envelope_id: 'env-dining', amount: -20 },
        ],
      })],
    }), state);
    const [tx] = recordProposal(p, state);
    expect(tx.envelope_id).toBe(null);
    expect(tx.envelope_splits).toEqual([
      { envelope_id: 'env-groceries', amount: 30 },
      { envelope_id: 'env-dining', amount: 20 },
    ]);
  });
});

describe('proposalToRecordSteps', () => {
  // The import sheet and the dialog send these inputs as one transaction.import.
  const NOW = new Date(2026, 9, 2, 10, 0, 0);
  const AT = NOW.toISOString();

  function coreData(state) {
    return { meta: {}, budgetItems: [], envelopeTemplates: [], ...state };
  }

  function recordThroughCore(steps, state) {
    let n = 0;
    const ctx = makeCtx({ now: NOW, newId: () => `core-${++n}` });
    const r = runBatch(registry, coreData(state), steps, ctx);
    expect(r.error).toBeUndefined();
    expect(r.ok).toBe(true);
    return r.value.value;
  }

  function stripVolatile(tx) {
    const { id: _i, created_at: _c, modified_at: _m, ...rest } = tx;
    return rest;
  }

  function mixedProposal(state) {
    return validateProposal(makeProposal({
      kind: 'transactions',
      meta: { source: 'receipt' },
      rows: [
        row(),
        row({ amount: -1200, type: 'income', payee: 'Salary', note: 'August', envelope_id: null }),
        row({ type: 'expense', account_id: null, payee: 'Kiosk' }),
        row({
          amount: 50, payee: 'Mixed basket',
          envelope_splits: [
            { envelope_id: 'env-groceries', amount: 30 },
            { envelope_id: 'env-dining', amount: -20 },
          ],
        }),
        row({ type: 'account_transfer', payee: 'Move', account_id: 'acc-checking', counter_account: 'acc-savings', transfer_direction: 'out', envelope_id: null }),
        row({ type: 'account_transfer', payee: 'Back', account_id: 'acc-checking', counter_account: 'acc-savings', transfer_direction: 'in', envelope_id: null }),
        row({ type: 'envelope_transfer', payee: 'Shift', envelope_id: null, from_envelope_id: 'env-groceries', to_envelope_id: 'env-dining', account_id: null }),
        row({ payee: 'Dup', duplicateOf: 'tx-7' }),
        row({ payee: 'Unchecked', excluded: true }),
      ],
    }), state);
  }

  it('produces inputs that transaction.record accepts', () => {
    const state = fixtureState();
    const steps = proposalToRecordSteps(mixedProposal(state), state);
    expect(steps).toHaveLength(7);
    expect(steps.every((s) => s.name === 'transaction.record')).toBe(true);
    const rows = recordThroughCore(steps, state);
    expect(rows).toHaveLength(7);
    expect(rows.every((r) => r.created_at === AT)).toBe(true);
  });

  // The rows the retired proposalToTransactions wrote for this proposal (it
  // built them by hand), apart from id and timestamps: recording the steps,
  // one by one or as one import, must keep writing exactly these.
  const LEGACY_ROWS = [
    { type: 'expense', date: '2026-08-01', payee: 'K-Market', amount: 42.5, note: null, source: 'receipt', account: 'acc-checking', envelope_id: 'env-groceries' },
    { type: 'income', date: '2026-08-01', payee: 'Salary', amount: 1200, note: 'August', source: 'receipt', account: 'acc-checking', envelope_id: null },
    { type: 'expense', date: '2026-08-01', payee: 'Kiosk', amount: 42.5, note: null, source: 'receipt', account: 'acc-checking', envelope_id: 'env-groceries' },
    {
      type: 'expense', date: '2026-08-01', payee: 'Mixed basket', amount: 50, note: null, source: 'receipt', account: 'acc-checking', envelope_id: null,
      envelope_splits: [{ envelope_id: 'env-groceries', amount: 30 }, { envelope_id: 'env-dining', amount: 20 }],
    },
    { type: 'account_transfer', date: '2026-08-01', payee: 'Move', amount: 42.5, note: null, source: 'receipt', from_account: 'acc-checking', to_account: 'acc-savings' },
    { type: 'account_transfer', date: '2026-08-01', payee: 'Back', amount: 42.5, note: null, source: 'receipt', from_account: 'acc-checking', to_account: 'acc-savings' },
    { type: 'envelope_transfer', date: '2026-08-01', payee: 'Shift', amount: 42.5, note: null, source: 'receipt', from_envelope_id: 'env-groceries', to_envelope_id: 'env-dining' },
  ];

  it('records the rows the hand-built import used to write, apart from id and timestamps', () => {
    const state = fixtureState();
    const p = mixedProposal(state);
    expect(recordThroughCore(proposalToRecordSteps(p, state), state).map(stripVolatile)).toEqual(LEGACY_ROWS);
    expect(recordProposal(p, state).map(stripVolatile)).toEqual(LEGACY_ROWS);
  });

  it('skips duplicates and excluded rows, and stamps the default provenance', () => {
    const state = fixtureState();
    const p = validateProposal(makeProposal({
      kind: 'transactions',
      rows: [row(), row({ duplicateOf: 'tx-7' }), row({ excluded: true })],
    }), state);
    const steps = proposalToRecordSteps(p, state);
    expect(steps).toHaveLength(1);
    expect(steps[0].input.source).toBe('ai-import');
  });

  it('falls back to the first unarchived account', () => {
    const state = fixtureState();
    state.accounts.unshift({ id: 'acc-old', name: 'Closed', archived: true });
    const p = validateProposal(makeProposal({ kind: 'transactions', rows: [row({ account_id: null })] }), state);
    expect(proposalToRecordSteps(p, state)[0].input.account).toBe('acc-checking');
  });

  it('throws transfer_needs_account for a transfer without two distinct accounts', () => {
    const state = fixtureState();
    // The review UI edits account_id / counter_account after validateProposal.
    const bad = (over) => {
      const p = validateProposal(makeProposal({
        kind: 'transactions',
        rows: [row({ type: 'account_transfer', envelope_id: null, counter_account: 'acc-savings', transfer_direction: 'out' })],
      }), state);
      Object.assign(p.rows[0], over);
      return p;
    };
    for (const p of [
      bad({ account_id: 'acc-checking', counter_account: null }),
      bad({ account_id: 'acc-checking', counter_account: 'acc-checking', transfer_direction: 'out' }),
    ]) {
      expect(() => proposalToRecordSteps(p, state)).toThrow(expect.objectContaining({ code: 'transfer_needs_account' }));
    }
  });

  it('resolves ⟦amt:…⟧ tokens in the payee and note it sends', () => {
    const state = fixtureState();
    const p = validateProposal(makeProposal({ kind: 'transactions', rows: [row()] }), state);
    p.rows[0].payee += ' ⟦amt:1⟧';
    p.rows[0].note = 'x ⟦amt:2';
    const [{ input }] = proposalToRecordSteps(p, state);
    expect(JSON.stringify(input)).not.toMatch(/[⟦⟧]/);
  });
});

describe('review ordering', () => {
  it('treats a missing confidence as needing review', () => {
    expect(needsReview({ confidence: null, warnings: [] })).toBe(true);
    expect(needsReview({ confidence: 0.95, warnings: [] })).toBe(false);
    expect(needsReview({ confidence: 0.95, warnings: [{ code: 'x' }] })).toBe(true);
  });

  it('sorts the rows needing attention to the top, least confident first', () => {
    const rows = [
      { date: '2026-08-01', confidence: 0.99, warnings: [] },
      { date: '2026-08-02', confidence: 0.2, warnings: [] },
      { date: '2026-08-03', confidence: null, warnings: [] },
      { date: '2026-08-04', confidence: 0.5, warnings: [] },
    ];
    const sorted = sortForReview(rows);
    expect(sorted.map((r) => r.confidence)).toEqual([null, 0.2, 0.5, 0.99]);
    // Non-destructive.
    expect(rows[0].confidence).toBe(0.99);
  });
});

// The prompts ask the model to write ⟦amt:…⟧ in ALL prose. A payee, note or
// rationale it proposes is stored budget data once approved, so a token must
// be resolved (formatted, as the user saw it) before it is ever saved.
describe('model text with ⟦amt:…⟧ tokens never reaches stored data', () => {
  const TOKEN = /[⟦⟧]|amt:/;

  it('validateProposal resolves tokens in payee, note, rationale and summary', () => {
    const p = validateProposal(
      makeProposal({
        kind: 'transactions',
        rows: [row({
          payee: 'Refund ⟦amt:12.5⟧ Shop',
          note: 'was ⟦amt:-3⟧',
          rationale: 'matches ⟦amt:42.5⟧ last month',
        })],
        meta: { source: 'dialog', summary: 'Add ⟦amt:42.5⟧ groceries' },
      }),
      fixtureState(),
    );
    const r = p.rows[0];
    for (const v of [r.payee, r.note, r.rationale, p.meta.summary]) expect(v).not.toMatch(TOKEN);
    expect(r.payee).toContain('12');
    expect(r.rationale).toContain('42');
  });

  it('a proposed transaction built from model text is saved without the token', () => {
    const state = fixtureState();
    const validated = validateProposal(
      makeProposal({ kind: 'transactions', rows: [row({ payee: 'K-Market ⟦amt:9⟧', note: 'x ⟦amt:oops⟧ y' })] }),
      state,
    );
    // The review UI can edit a row after validation; the write boundary
    // resolves tokens again, so nothing the row carries gets through.
    validated.rows[0].payee += ' ⟦amt:1⟧';
    validated.rows[0].note += ' ⟦amt:2';
    const [tx] = recordProposal(validated, state);
    expect(tx.payee).not.toMatch(TOKEN);
    expect(tx.note).not.toMatch(TOKEN);
    expect(JSON.stringify(tx)).not.toMatch(/[⟦⟧]/);
  });

  it('leaves ordinary payees and a null note untouched', () => {
    const state = fixtureState();
    const p = validateProposal(makeProposal({ kind: 'transactions', rows: [row()] }), state);
    const [tx] = recordProposal(p, state);
    expect(tx.payee).toBe('K-Market');
    expect(tx.note).toBe(null);
  });
});
