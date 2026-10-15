// Deterministic, disposable history workload. No database, files, or user data.
// Run: node tools/history-benchmark.mjs [row-count ...]
// Timings are diagnostic, never machine-dependent CI assertions.
import { performance } from 'node:perf_hooks';
import { appendFinancialHistory, initialHistory } from '../js/core/financial-history.js';

const sizes = process.argv.slice(2).map(Number);
if (!sizes.length) sizes.push(1000, 5000, 20000);
if (sizes.some(n => !Number.isSafeInteger(n) || n < 1 || n > 100000)) {
  throw new Error('row counts must be integers between 1 and 100000');
}
const bytes = value => Buffer.byteLength(JSON.stringify(value));
const median = times => [...times].sort((a, b) => a - b)[Math.floor(times.length / 2)];
const now = new Date('2026-10-08T12:00:00Z');
const prices = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`SYM${i}`, { price: 10 + i, asOf: '2026-10-08' }]));
function budget(rows) {
  return {
    accounts: [{ id: 'bank', name: 'Bank', type: 'bank', initialBalance: rows * 20 }],
    envelopes: [{ id: 'food', name: 'Food', category: 'living' }],
    transactions: Array.from({ length: rows }, (_, i) => ({ id: `tx${i}`, type: 'expense',
      date: '2026-10-01', amount: 10, account: 'bank', envelope_id: 'food', status: 'posted', payee: `Payee ${i % 100}` })),
    budgetItems: [], envelopeTemplates: [], meta: { schemaVersion: 7, currency: 'EUR', country: 'FI', investments: { prices } },
  };
}
for (const rows of sizes) {
  for (const workload of ['transaction-edit', 'price-refresh']) {
    let data = budget(rows);
    data.meta.financialHistory = initialHistory(data, now);
    const initialHistoryBytes = bytes(data.meta.financialHistory);
    const times = []; const serialization = [];
    for (let revision = 1; revision <= 100; revision++) {
      const after = workload === 'transaction-edit'
        ? { ...data, transactions: data.transactions.map((tx, i) => i === 0 ? { ...tx, payee: `Edited ${revision}` } : tx) }
        : { ...data, meta: { ...data.meta, investments: { prices: Object.fromEntries(
          Object.entries(prices).map(([symbol, quote]) => [symbol, { ...quote, price: quote.price + revision }]),
        ) } } };
      const started = performance.now();
      const history = appendFinancialHistory(data, after, now);
      times.push(performance.now() - started);
      data = { ...after, meta: { ...after.meta, financialHistory: history } };
      const serializationStarted = performance.now();
      const payload = { version: revision, items: [
        ...(workload === 'transaction-edit' ? [{ kind: 'transactions', data: data.transactions }] : []),
        { kind: 'meta', data: data.meta },
      ] };
      const payloadBytes = bytes(payload);
      serialization.push(performance.now() - serializationStarted);
      if ([1, 10, 100].includes(revision)) {
        console.log(JSON.stringify({ rows, workload, revision,
          historyBytes: bytes(history), historyGrowthBytes: bytes(history) - initialHistoryBytes,
          payloadBytes, encryptedPayloadBytesEstimate: Math.ceil(payloadBytes / 3) * 4,
          appendMedianMs: +median(times).toFixed(2), serializeMedianMs: +median(serialization).toFixed(2) }));
      }
    }
  }
}
