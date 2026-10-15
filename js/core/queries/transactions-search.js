import { ok, fail } from '../result.js';
import { refDate } from '../lens-input.js';
import { transactionsPageTxList } from '../effective-txs.js';
import { filterAndSort } from '../transactions-filter.js';
import { txAbsAmount } from '../../engine/tx-amounts.js';
import { round2 } from '../../utils.js';

export default {
  name: 'transactions.search',
  summary: 'Search stored transactions, optionally including the scheduled preview. Newest day first; ties use reverse input order. Count and magnitude total cover all matches before pagination, not spending or net movement.',
  input: { type: 'object', properties: {
    account: { type: 'ref', kind: 'account' },
    envelope: { type: 'ref', kind: 'envelope' },
    noEnvelope: { type: 'boolean', default: false, description: 'Uncategorized expense/debt-payment rows; cannot combine with envelope' },
    type: { type: 'string' },
    dateFrom: { type: 'date' }, dateTo: { type: 'date' },
    minAmount: { type: 'money', minimum: 0 }, maxAmount: { type: 'money', minimum: 0 },
    cleared: { type: 'boolean' }, flagged: { type: 'boolean' },
    status: { enum: ['all', 'posted', 'scheduled', 'cleared', 'uncleared'], default: 'all' },
    search: { type: 'string' },
    searchMode: { enum: ['literal', 'tokens'], default: 'literal', description: 'Literal substring, or browser tokens (phrases, tags and numeric comparisons)' },
    showScheduled: { type: 'boolean', default: false },
    date: { type: 'date', description: 'Reference day for the scheduled preview (default query clock)' },
    offset: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER, default: 0 },
    limit: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER, default: 60, description: 'Maximum rows returned; browser explicitly requests all for its virtual list' },
  } },
  run(data, input, ctx) {
    const bad = (path, message) => fail('bad_input', { errors: [{ path, message }] });
    if (input.noEnvelope && input.envelope) return bad('envelope', 'cannot combine with noEnvelope');
    if (input.dateFrom && input.dateTo && input.dateFrom > input.dateTo) return bad('dateTo', 'must be on or after dateFrom');
    if (input.minAmount !== undefined && input.maxAmount !== undefined && input.minAmount > input.maxAmount) return bad('maxAmount', 'must be at least minAmount');
    const effective = transactionsPageTxList({
      ...data, today: refDate(input, ctx), showScheduled: input.showScheduled,
      dateFrom: input.dateFrom, dateTo: input.dateTo,
      country: data.meta?.country ?? 'FI', tombstones: data.meta?.scheduledTombstones || [],
    });
    const matches = filterAndSort(effective.filter(Boolean), {
      ...input, envelope: input.noEnvelope ? '__noenvelope__' : input.envelope,
    });
    const { offset, limit } = input;
    return ok({
      rows: JSON.parse(JSON.stringify(matches.slice(offset, offset + limit))),
      matched: matches.length,
      totalMagnitude: round2(matches.reduce((sum, tx) => sum + txAbsAmount(tx), 0)),
      offset, limit, hasMore: offset + limit < matches.length,
    });
  },
};
