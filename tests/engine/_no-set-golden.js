// Shared by `no-set-forecast-golden.test.js` and the script that wrote its
// golden file. The golden was captured from the engine BEFORE set-mode lines
// became resolvable in the forecast (2026-09-24), so the test proves that
// work changed nothing for a budget carrying no set-mode template line.
//
// Regenerate only on a deliberate behaviour or fixture change:
//   node tests/engine/_no-set-golden.js --write

import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  projectEnvelopeBalance, recommendEnvelopeActions, computeEnvelopeBalances,
  computeAccountBalances,
} from '../../js/engine.js';
import { lensTransactions, _resetLensCache } from '../../js/engine/lens.js';

const HERE = fileURLToPath(new URL('.', import.meta.url));
export const GOLDEN_PATH = `${HERE}../fixtures/no-set-forecast-golden.json`;

const load = name => JSON.parse(readFileSync(`${HERE}../../budgets/example-project/${name}.json`, 'utf8'));

const ALL = {
  Jan: true, Feb: true, Mar: true, Apr: true, May: true, Jun: true,
  Jul: true, Aug: true, Sep: true, Oct: true, Nov: true, Dec: true,
};

/** The fictional example budget, with add-mode fills and templates. */
function exampleBudget() {
  return {
    transactions: load('transactions'),
    budgetItems: load('budget-items'),
    envelopeTemplates: load('envelope-templates'),
    accounts: load('accounts'),
    envelopes: load('envelopes'),
  };
}

/**
 * A small synthetic budget exercising a source-funded (add-mode) template,
 * a quarterly template and working-day shifts, none of which lands in a
 * shift window on the dates sampled below.
 */
function syntheticBudget() {
  const envelopes = [
    { id: 'rent', name: 'Rent' },
    { id: 'food', name: 'Food', rollover: 'zero-monthly' },
    { id: 'buf', name: 'Buffer' },
    { id: 'car', name: 'Car', goal_amount: 3000, goal_date: '2027-03-01' },
  ];
  const accounts = [{ id: 'a1', name: 'Checking', type: 'bank' }];
  const budgetItems = [
    { id: 'bi-rent', envelope_id: 'rent', default_amount: 800, include: true, payment_day: 3,
      monthly_schedule: { ...ALL }, as_schedule: true, account_id: 'a1', extra_buffer: 100 },
    { id: 'bi-food', envelope_id: 'food', default_amount: 400, include: true,
      monthly_schedule: { ...ALL } },
    { id: 'bi-car', envelope_id: 'car', default_amount: 600, include: true, payment_day: 15,
      monthly_schedule: { Mar: true, Sep: true }, as_schedule: true, account_id: 'a1',
      schedule_day_type: 'next_work_day' },
  ];
  const envelopeTemplates = [
    { id: 'monthly', name: 'Monthly', lines: [
      { envelope_id: 'rent', mode: 'add', amount: 850 },
      { envelope_id: 'food', mode: 'add', amount: 380 },
    ], schedule: { enabled: true, payment_day: 25, months: { ...ALL }, day_type: 'prev_work_day',
      source_envelope_id: 'buf', source_since: '2026-12-01' } },
    { id: 'quarterly', name: 'Quarterly', lines: [
      { envelope_id: 'car', mode: 'add', amount: 900 },
    ], schedule: { enabled: true, payment_day: 10, months: { Jan: true, Apr: true, Jul: true, Oct: true } } },
  ];
  const transactions = [
    { id: 's1', type: 'adjustment', target: 'envelope', target_id: 'buf', amount: 6000,
      date: '2026-06-01', status: 'posted' },
    { id: 's2', type: 'fill', date: '2026-06-02', status: 'posted', source: 'allocation',
      lines: [{ envelope_id: 'rent', mode: 'add', amount: 900 }, { envelope_id: 'car', mode: 'add', amount: 1200 }] },
    { id: 'x1', type: 'expense', date: '2026-06-05', status: 'posted', amount: 42, envelope_id: 'food', account: 'a1' },
    { id: 'x2', type: 'expense', date: '2026-12-20', status: 'scheduled', amount: 300, envelope_id: 'car', account: 'a1' },
  ];
  return { transactions, budgetItems, envelopeTemplates, accounts, envelopes };
}

const CASES = [
  { name: 'example', budget: exampleBudget, dates: [[2026, 9, 8], [2026, 9, 20], [2027, 0, 12]] },
  { name: 'synthetic', budget: syntheticBudget, dates: [[2026, 5, 10], [2026, 10, 16], [2027, 0, 12]] },
];

const sha = v => createHash('sha1').update(JSON.stringify(v)).digest('hex');
const r2 = n => Math.round(n * 100) / 100;

/** A compact, deterministic digest of every figure the forecast surfaces show. */
export function snapshot() {
  const out = {};
  for (const c of CASES) {
    for (const [y, m, d] of c.dates) {
      const today = new Date(y, m, d);
      const b = c.budget();
      const key = `${c.name}@${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      const envs = {};
      for (const env of b.envelopes) {
        const input = { ...b, envelopeId: env.id, today, months: 12, country: 'FI', tombstones: [] };
        const p = projectEnvelopeBalance(input);
        const recs = recommendEnvelopeActions(input, p);
        envs[env.id] = {
          opening: p.opening, low: p.low, high: p.high, closing: p.closing,
          firstNegative: p.firstNegative, fillSource: p.fillSource, monthlyFill: p.monthlyFill,
          months: p.months.map(mo => [mo.key, mo.opening, mo.in, mo.out, mo.low, mo.closing]),
          daily: sha(p.daily),
          recs: recs.map(rec => [rec.kind, rec.severity, rec.amount, rec.date]),
        };
      }
      _resetLensCache();
      const lens = {};
      for (const horizon of ['eom', '3m', '12m']) {
        const txs = lensTransactions({ ...b, meta: { country: 'FI' } }, { lens: 'forecast', horizon, today });
        const eb = computeEnvelopeBalances(txs);
        const ab = computeAccountBalances(b.accounts, txs);
        lens[horizon] = {
          rows: txs.length,
          envelopes: Object.fromEntries([...eb].sort().map(([k, v]) => [k, r2(v)])),
          accounts: Object.fromEntries([...ab].sort().map(([k, v]) => [k, r2(v)])),
        };
      }
      out[key] = { envs, lens };
    }
  }
  return out;
}

if (process.argv.includes('--write')) {
  writeFileSync(GOLDEN_PATH, `${JSON.stringify(snapshot(), null, 1)}\n`);
  console.log(`wrote ${GOLDEN_PATH}`);
}
