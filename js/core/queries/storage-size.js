import { ok } from '../result.js';
import { compactFinancialHistory, validHistory } from '../financial-history.js';
const bytes = value => new TextEncoder().encode(JSON.stringify(value)).length;
export default {
  name: 'storage.size',
  summary: 'Logical JSON byte counts before compression, with history revisions and verified compaction savings. Not database or filesystem allocation.',
  input: { type: 'object', properties: {} },
  run(data) {
    const { financialHistory, ...meta } = data.meta || {};
    const bundle = Object.fromEntries(['envelopes','budgetItems','transactions','accounts','envelopeTemplates'].map(k => [k, data[k] || []]));
    const without = bytes({ ...bundle, meta });
    const total = bytes({ ...bundle, meta: data.meta || {} });
    const compacted = compactFinancialHistory(financialHistory);
    const after = bytes({ ...bundle, meta: { ...meta, ...(financialHistory !== undefined ? { financialHistory: compacted } : {}) } });
    const segments = validHistory(financialHistory) ? [...(financialHistory.previous || []), financialHistory] : [];
    return ok({ totalBytes: total, dataBytes: without, historyBytes: total - without,
      compactedBytes: after, reclaimableBytes: total - after,
      segments: segments.length, revisions: segments.reduce((n, s) => n + s.entries.length, 0) });
  },
};
