// tests/ai-import-pipeline.test.js — the pure parts of the AI import path:
// image sizing, model-response handling, the payee history digest, and the
// assembly that ties a categorization back to the row it belongs to.

import { describe, it, expect } from 'vitest';
import { fitDimensions, isImageFile, isPdfFile, MAX_IMAGE_EDGE } from '../js/import/downscale.js';
import { normaliseParseResult } from '../js/import/ai-parse.js';
import { buildPayeeDigest, readAssignments } from '../js/ai/categorize.js';
import { rowsNeedingCategorization, buildImportProposal } from '../js/import/build-proposal.js';
import { needsReview, committableRows } from '../js/ai/proposal.js';

describe('fitDimensions', () => {
  it('leaves an already-small image alone', () => {
    expect(fitDimensions(800, 600)).toEqual({ width: 800, height: 600, scaled: false });
  });

  it('scales the long edge down and keeps the aspect ratio', () => {
    const out = fitDimensions(4000, 3000);
    expect(out.width).toBe(MAX_IMAGE_EDGE);
    expect(out.height).toBe(Math.round(3000 * (MAX_IMAGE_EDGE / 4000)));
    expect(out.scaled).toBe(true);
  });

  it('handles portrait phone photos — height is the long edge', () => {
    const out = fitDimensions(3000, 4000);
    expect(out.height).toBe(MAX_IMAGE_EDGE);
    expect(out.width).toBeLessThan(MAX_IMAGE_EDGE);
  });

  it('never produces a zero dimension', () => {
    const out = fitDimensions(10000, 1);
    expect(out.height).toBeGreaterThanOrEqual(1);
  });

  it('recognises the file types it accepts', () => {
    expect(isImageFile({ type: 'image/jpeg' })).toBe(true);
    expect(isImageFile({ type: 'image/heic' })).toBe(false);
    expect(isPdfFile({ type: 'application/pdf' })).toBe(true);
    expect(isPdfFile(null)).toBe(false);
  });
});

function toolMessage(name, input) {
  return { content: [{ type: 'tool_use', id: 'tu_1', name, input }] };
}

describe('normaliseParseResult', () => {
  it('preserves statement account identifiers per row without confusing counterparties', () => {
    const out = normaliseParseResult(toolMessage('record_rows', {
      source_account: 'Checking',
      rows: [
        { date: '2026-09-01', payee: 'A', amount: -10 },
        { date: '2026-09-02', payee: 'B', amount: 20, source_account: 'Savings' },
      ],
    }));
    expect(out.rows.map(row => row.sourceAccount)).toEqual(['Checking', 'Savings']);
  });
  it('reports a refusal instead of reading a partial tool call', () => {
    const msg = { ...toolMessage('record_rows', { rows: [{ date: '2026-08-01', payee: 'X', amount: -1 }] }), stop_reason: 'refusal' };
    expect(() => normaliseParseResult(msg)).toThrow(expect.objectContaining({ code: 'ai_refused' }));
  });

  it('maps the tool call onto importer rows', () => {
    const out = normaliseParseResult(toolMessage('record_rows', {
      rows: [
        { date: '2026-08-01', payee: 'K-Market', amount: -42.5 },
        { date: '2026-08-02', payee: 'Salary', amount: 3200 },
      ],
      declared_total: -42.5,
      currency: 'EUR',
    }));
    expect(out.rows).toHaveLength(2);
    expect(out.rows[0].amount).toBe(-42.5);
    expect(out.rows[0].date).toBeInstanceOf(Date);
    expect(out.declaredTotal).toBe(-42.5);
    expect(out.currency).toBe('EUR');
  });

  it('drops unreadable rows rather than guessing, and counts them', () => {
    const out = normaliseParseResult(toolMessage('record_rows', {
      rows: [
        { date: '2026-08-01', payee: 'Good', amount: -10 },
        { date: 'illegible', payee: 'Bad date', amount: -10 },
        { date: '2026-08-02', payee: 'Bad amount', amount: null },
        { date: '2026-08-03', payee: 'Zero', amount: 0 },
      ],
    }));
    expect(out.rows).toHaveLength(1);
    expect(out.skipped).toBe(3);
  });

  it('drops a sub-cent row like a zero one, so it cannot make the import refuse every row', () => {
    const out = normaliseParseResult(toolMessage('record_rows', {
      rows: [
        { date: '2026-08-01', payee: 'Good', amount: -10 },
        { date: '2026-08-02', payee: 'Rounding', amount: 0.004 },
        { date: '2026-08-03', payee: 'Rounding out', amount: -0.004 },
        { date: '2026-08-04', payee: 'A cent', amount: 0.005 },
      ],
    }));
    expect(out.rows.map((r) => [r.payee, r.amount])).toEqual([['Good', -10], ['A cent', 0.01]]);
    expect(out.skipped).toBe(2);
  });

  it('throws when the model returned no tool call at all', () => {
    expect(() => normaliseParseResult({ content: [{ type: 'text', text: 'I cannot read this' }] }))
      .toThrow(/could not be read/);
  });

  it('reports no declared total when the document printed none', () => {
    const out = normaliseParseResult(toolMessage('record_rows', {
      rows: [{ date: '2026-08-01', payee: 'X', amount: -5 }],
    }));
    expect(out.declaredTotal).toBe(null);
  });
});

describe('buildPayeeDigest', () => {
  const state = {
    transactions: [
      { payee: 'K-Market', envelope_id: 'env-groceries', account: 'acc-1' },
      { payee: 'k-market ', envelope_id: 'env-groceries', account: 'acc-1' },
      { payee: 'K-Market', envelope_id: 'env-dining', account: 'acc-1' },
      { payee: 'Netflix', envelope_id: 'env-subs', account: 'acc-2' },
      { payee: 'Rare Shop', envelope_id: 'env-misc', account: 'acc-1' },
      { payee: 'No envelope', envelope_id: null, account: 'acc-1' },
      { payee: 'Forecast', envelope_id: 'env-x', is_forecast: true },
    ],
  };

  it('picks each payee’s most-used envelope, case- and space-insensitively', () => {
    const digest = buildPayeeDigest(state, []);
    const km = digest.find((d) => d.payee.toLowerCase() === 'k-market');
    expect(km.envelope_id).toBe('env-groceries');
    expect(km.count).toBe(3);
  });

  it('ignores rows with no envelope and forecast rows', () => {
    const digest = buildPayeeDigest(state, []);
    expect(digest.some((d) => d.payee === 'No envelope')).toBe(false);
    expect(digest.some((d) => d.payee === 'Forecast')).toBe(false);
  });

  it('always includes a payee from the current batch, however rare', () => {
    const big = { transactions: [...state.transactions] };
    for (let i = 0; i < 200; i++) {
      big.transactions.push({ payee: `Common ${i}`, envelope_id: 'env-a', account: 'acc-1' });
      big.transactions.push({ payee: `Common ${i}`, envelope_id: 'env-a', account: 'acc-1' });
    }
    const digest = buildPayeeDigest(big, ['Rare Shop']);
    expect(digest.some((d) => d.payee === 'Rare Shop')).toBe(true);
  });

  it('is stable between runs so the prompt prefix stays cacheable', () => {
    expect(JSON.stringify(buildPayeeDigest(state, ['K-Market'])))
      .toBe(JSON.stringify(buildPayeeDigest(state, ['K-Market'])));
  });
});

describe('readAssignments', () => {
  const context = {
    envelopes: [{ id: 'env-a' }, { id: 'env-b' }],
    accounts: [{ id: 'acc-1' }],
  };

  it('resolves a money token in the rationale', () => {
    const out = readAssignments(toolMessage('assign_rows', {
      assignments: [{ index: 0, type: 'expense', envelope_id: 'env-a', confidence: 0.9, rationale: 'usually ⟦amt:12⟧' }],
    }), 1, context);
    expect(out[0].rationale).not.toMatch(/[⟦⟧]/);
    expect(out[0].rationale).toContain('12');
  });

  it('nulls an envelope id that was not offered', () => {
    const out = readAssignments(toolMessage('assign_rows', {
      assignments: [{ index: 0, type: 'expense', envelope_id: 'env-invented', account_id: 'acc-1', confidence: 0.9 }],
    }), 1, context);
    expect(out[0].envelope_id).toBe(null);
    expect(out[0].account_id).toBe('acc-1');
  });

  it('discards an index outside the batch', () => {
    const out = readAssignments(toolMessage('assign_rows', {
      assignments: [
        { index: 0, type: 'expense', envelope_id: 'env-a', confidence: 0.9 },
        { index: 99, type: 'expense', envelope_id: 'env-a', confidence: 0.9 },
        { index: -1, type: 'expense', envelope_id: 'env-a', confidence: 0.9 },
      ],
    }), 2, context);
    expect(out).toHaveLength(1);
    expect(out[0].index).toBe(0);
  });

  it('keeps the first answer when an index is repeated', () => {
    const out = readAssignments(toolMessage('assign_rows', {
      assignments: [
        { index: 0, type: 'expense', envelope_id: 'env-a', confidence: 0.9 },
        { index: 0, type: 'expense', envelope_id: 'env-b', confidence: 0.1 },
      ],
    }), 1, context);
    expect(out).toHaveLength(1);
    expect(out[0].envelope_id).toBe('env-a');
  });

  it('returns nothing when the model wrote prose instead of calling the tool', () => {
    expect(readAssignments({ content: [{ type: 'text', text: 'sure!' }] }, 3, context)).toEqual([]);
  });
});

describe('buildImportProposal', () => {
  const state = {
    envelopes: [{ id: 'env-groceries', name: 'Groceries' }, { id: 'env-dining', name: 'Dining' }],
    accounts: [{ id: 'acc-1', name: 'Checking' }],
    transactions: [],
  };

  function matchedFixture() {
    return [
      { csvRow: { date: '2026-08-01', payee: 'K-Market', amount: -20 }, match: null, matchType: 'none' },
      { csvRow: { date: '2026-08-02', payee: 'Old one', amount: -30 }, match: { id: 'tx-9', date: '2026-08-02', payee: 'Old one' }, matchType: 'exact' },
      { csvRow: { date: '2026-08-03', payee: 'Cafe', amount: -8 }, match: null, matchType: 'none' },
    ];
  }

  it('only sends unmatched rows for categorization', () => {
    const needing = rowsNeedingCategorization(matchedFixture());
    expect(needing.map((r) => r.payee)).toEqual(['K-Market', 'Cafe']);
    expect(needing.map((r) => r.__sourceIndex)).toEqual([0, 2]);
  });

  it('attaches each categorization to the row it was computed for', () => {
    const matched = matchedFixture();
    const needing = rowsNeedingCategorization(matched);
    const categorized = [
      { index: 0, type: 'expense', envelope_id: 'env-groceries', account_id: 'acc-1', confidence: 0.95, rationale: 'usually groceries' },
      { index: 1, type: 'expense', envelope_id: 'env-dining', account_id: 'acc-1', confidence: 0.4, rationale: 'guess' },
    ];
    const p = buildImportProposal({ matched, needing, categorized, state, defaultAccountId: 'acc-1' });

    const byPayee = Object.fromEntries(p.rows.map((r) => [r.payee, r]));
    expect(byPayee['K-Market'].envelope_id).toBe('env-groceries');
    expect(byPayee['Cafe'].envelope_id).toBe('env-dining');
    expect(byPayee['Cafe'].confidence).toBe(0.4);
  });

  it('does not shift bookings when the model answers for fewer rows than asked', () => {
    const matched = matchedFixture();
    const needing = rowsNeedingCategorization(matched);
    // Only the second unmatched row came back.
    const categorized = [null, { index: 1, type: 'expense', envelope_id: 'env-dining', account_id: 'acc-1', confidence: 0.8 }];
    const p = buildImportProposal({ matched, needing, categorized, state, defaultAccountId: 'acc-1' });

    const byPayee = Object.fromEntries(p.rows.map((r) => [r.payee, r]));
    expect(byPayee['K-Market'].envelope_id).toBe(null);   // not given Cafe's envelope
    expect(byPayee['Cafe'].envelope_id).toBe('env-dining');
  });

  it('marks matched rows as duplicates and carries what they matched', () => {
    const matched = matchedFixture();
    const p = buildImportProposal({
      matched, needing: rowsNeedingCategorization(matched), categorized: [], state,
    });
    const dup = p.rows.find((r) => r.payee === 'Old one');
    expect(dup.duplicateOf).toBe('tx-9');
    expect(dup.duplicateMatch.matchType).toBe('exact');
  });

  it('imports a possible match by default, categorized and flagged for a look (decision 6)', () => {
    const matched = [
      ...matchedFixture(),
      { csvRow: { date: '2026-08-05', payee: 'LIDL 123', amount: -12 }, match: { id: 'tx-4', date: '2026-08-03', payee: 'Lidl' }, matchType: 'possible', days: 2, payeeMatch: true },
    ];
    const needing = rowsNeedingCategorization(matched);
    expect(needing.map((r) => r.payee)).toEqual(['K-Market', 'Cafe', 'LIDL 123']);
    const p = buildImportProposal({ matched, needing, categorized: [], state, defaultAccountId: 'acc-1' });
    const row = p.rows.find((r) => r.payee === 'LIDL 123');
    expect(row.duplicateOf).toBe(null);
    expect(row.possibleDuplicateOf).toBe('tx-4');
    expect(row.warnings).toEqual([expect.objectContaining({ code: 'possible_duplicate', message: '2026-08-03', payee: 'Lidl' })]);
    expect(needsReview(row)).toBe(true);
    // Committed unless the user unticks it.
    expect(committableRows(p).map((r) => r.payee)).toContain('LIDL 123');
    row.excluded = true;
    expect(committableRows(p).map((r) => r.payee)).not.toContain('LIDL 123');
  });

  it('falls back to the sheet’s account when the model named none', () => {
    const matched = matchedFixture();
    const p = buildImportProposal({
      matched, needing: rowsNeedingCategorization(matched), categorized: [], state,
      defaultAccountId: 'acc-1',
    });
    expect(p.rows.every((r) => r.account_id === 'acc-1')).toBe(true);
  });

  it('surfaces the declared-total mismatch through to the proposal', () => {
    const matched = matchedFixture();
    const p = buildImportProposal({
      matched, needing: rowsNeedingCategorization(matched), categorized: [], state,
      declaredTotal: 999, source: 'receipt',
    });
    expect(p.warnings.map((w) => w.code)).toContain('total_mismatch');
    expect(p.meta.source).toBe('receipt');
  });
});
