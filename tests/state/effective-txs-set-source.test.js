// A scheduled template whose set-mode line is funded from a source envelope
// is forecast with a `source_set_pending` placeholder; the lists the Review
// and Transactions pages use must resolve it to the real top-up draw.
import { describe, it, expect } from 'vitest';
import { buildEffectiveTxList, transactionsPageTxList } from '../../js/core/effective-txs.js';
import { computeEnvelopeBalances } from '../../js/engine.js';

const ALL = {
  Jan: true, Feb: true, Mar: true, Apr: true, May: true, Jun: true,
  Jul: true, Aug: true, Sep: true, Oct: true, Nov: true, Dec: true,
};
const TODAY = new Date(2026, 0, 1);
const ENVELOPES = [{ id: 'groc', name: 'Groceries' }, { id: 'buf', name: 'Buffer' }];
const TEMPLATE = {
  id: 'tpl', name: 'Top up from buffer',
  lines: [{ envelope_id: 'groc', mode: 'set', amount: 500 }],
  schedule: { enabled: true, payment_day: 25, months: { ...ALL }, since: '2026-01-01', source_envelope_id: 'buf' },
};
const SEED = [
  { id: 'seed-buf', type: 'adjustment', target: 'envelope', target_id: 'buf', amount: 5000, date: '2025-12-01', status: 'posted' },
  { id: 'seed-groc', type: 'adjustment', target: 'envelope', target_id: 'groc', amount: 120, date: '2025-12-01', status: 'posted' },
];

describe('effective lists resolve set-mode source draws', () => {
  it('buildEffectiveTxList: no pending rows, and the source pays exactly the top-up', () => {
    const list = buildEffectiveTxList({
      transactions: SEED, envelopeTemplates: [TEMPLATE], envelopes: ENVELOPES,
      today: TODAY, endStr: '2026-01-31',
    });
    expect(list.some(t => t.source_set_pending)).toBe(false);
    const bal = computeEnvelopeBalances(list);
    expect(bal.get('groc')).toBeCloseTo(500, 2);
    expect(bal.get('buf')).toBeCloseTo(5000 - 380, 2);
  });

  it('transactionsPageTxList: no pending rows', () => {
    const list = transactionsPageTxList({
      transactions: SEED, envelopeTemplates: [TEMPLATE], envelopes: ENVELOPES,
      budgetItems: [], accounts: [], today: TODAY, showScheduled: true,
    });
    expect(list.some(t => t.source_set_pending)).toBe(false);
  });
});
