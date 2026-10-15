// Compare the old per-repair batch with per-row setFields using the same
// 20k-row ledger, clock and commit checks. No disk writes or timing assertions.
// Run: node scripts/benchmark-repair-links.mjs
import { performance } from 'node:perf_hooks';
import { deepStrictEqual } from 'node:assert';
import { registry } from '../js/core/index.js';
import { runBatch, runCommand } from '../js/core/pipeline.js';
import { makeCtx } from '../js/core/context.js';
import { applyCommitChecks } from '../js/session/commit-checks.js';

const ctx = makeCtx({ now: new Date('2026-10-04T12:00:00Z'), newId: () => 'unused' });
const data = {
  meta: {}, accounts: [{ id: 'checking', name: 'Checking', type: 'bank' }],
  envelopes: [{ id: 'groceries', name: 'Groceries' }], budgetItems: [], envelopeTemplates: [],
  transactions: Array.from({ length: 20000 }, (_, i) => ({
    id: `tx-${i}`, type: 'expense', date: '2026-10-01', amount: 10,
    account: 'checking', envelope_id: 'groceries', payee: 'Shop', status: 'posted',
  })),
};
const options = { checks: applyCommitChecks };
const median = samples => [...samples].sort((a, b) => a - b)[Math.floor(samples.length / 2)];
for (const count of [1, 10, 100, 500]) {
  const rows = Array.from({ length: count }, (_, i) => ({ id: `tx-${i}`, fromBudget: `item-${i}:2026-10` }));
  const steps = rows.map(({ id, ...fields }) => ({ name: 'transaction.setFields', input: { ids: [id], ...fields } }));
  const legacy = [], bulk = [];
  // Warm both paths; the three recorded samples all start from the same data.
  for (let sample = -1; sample < 3; sample++) {
    let start = performance.now();
    const before = runBatch(registry, data, steps, ctx, options);
    const oldMs = performance.now() - start;
    start = performance.now();
    const after = runCommand(registry, data, 'transaction.setFields', { rows }, ctx, options);
    const newMs = performance.now() - start;
    if (!before.ok || !after.ok) throw new Error(JSON.stringify({ before, after }));
    deepStrictEqual(after.value.after, before.value.after);
    deepStrictEqual(after.value.diff, before.value.diff);
    if (sample >= 0) { legacy.push(oldMs); bulk.push(newMs); }
  }
  console.log(JSON.stringify({ ledgerRows: 20000, repairs: count,
    batchMedianMs: Math.round(median(legacy)), perRowMedianMs: Math.round(median(bulk)),
    speedup: +(median(legacy) / median(bulk)).toFixed(1),
  }));
}
