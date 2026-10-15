// `runMonthlyReview`'s debit walk carried its own per-type loop — a near-copy
// of the balance walkers that was not actually the same rules: no fills, no
// envelope transfers, no adjustments, no investment sells or dividends. That
// difference is deliberate (it measures SPENDING, not balance movement), which
// is exactly what made it easy to mistake for a fourth copy and "tidy" into
// changing its numbers.
//
// It now goes through `txEnvelopeSpend`. This pins that the numbers did not
// move: the pre-refactor loop is reproduced as an oracle and compared over
// seeded random ledgers, and the exclusions are asserted one by one so a later
// change that folds fills or transfers into "spending" fails loudly.

import { describe, it, expect } from 'vitest';
import { runMonthlyReview, txEnvelopeSpend } from '../../js/engine.js';
import { validateAmount, parseDate } from '../../js/utils.js';

const ENVELOPES = [
  { id: 'e1', name: 'Food', category: 'Living' },
  { id: 'e2', name: 'Home', category: 'Living' },
  { id: 'e3', name: 'Fun', category: 'Living' },
];
const MONTH = '2026-08';
const REF = new Date(2026, 7, 24);

// ── Oracle: the debit walk as it stood before the refactor ──────────────────

function oldDebits(transactions, envelopeBalances, refDate) {
  const today = new Date(refDate.getFullYear(), refDate.getMonth(), refDate.getDate());
  const actualDebits = new Map();
  const scheduledDebits = new Map();

  for (const tx of transactions) {
    const type = tx.type || '';
    const status = tx.status || '';
    const tDate = parseDate(tx.date);
    if (!tDate) continue;
    if (tDate.getMonth() + 1 !== 8 || tDate.getFullYear() !== 2026) continue;

    const isPlanned = status === 'scheduled' || !!tx.is_forecast || tDate > today;
    const addToBucket = (envId, signedAmt) => {
      if (!envId || envId === '__none__') return;
      const amt = validateAmount(signedAmt);
      if (amt === null) return;
      const bucket = isPlanned ? scheduledDebits : actualDebits;
      if (isPlanned && !envelopeBalances.has(envId)) return;
      bucket.set(envId, (bucket.get(envId) || 0) + amt);
    };
    const addDebit = (envId, rawAmt) => addToBucket(envId, Math.abs(validateAmount(rawAmt) ?? 0));

    if (type === 'expense') {
      if (Array.isArray(tx.envelope_splits) && tx.envelope_splits.length) {
        for (const s of tx.envelope_splits) addToBucket(s.envelope_id, s.amount);
      } else {
        addDebit(tx.envelope_id, tx.amount);
      }
    } else if (type === 'debt_payment') {
      addDebit(tx.envelope_id, tx.amount);
    } else if (type === 'investment_transfer') {
      const direction = tx.direction === 'sell' ? 'sell'
                      : tx.direction === 'dividend' ? 'dividend'
                      : 'buy';
      if (direction === 'buy') addDebit(tx.envelope_id, tx.amount);
    }
  }
  return { actualDebits, scheduledDebits };
}

// ── Seeded generator ────────────────────────────────────────────────────────

function mulberry32(seed) {
  return function next() {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ENV_POOL = ['e1', 'e2', 'e3', '__none__', undefined, ''];
const TYPES = [
  'expense', 'expense', 'expense', 'debt_payment', 'investment_transfer',
  'fill', 'envelope_transfer', 'adjustment', 'income', 'account_transfer',
];
const DATES = ['2026-08-02', '2026-08-24', '2026-08-30', '2026-07-31', '2026-09-01', ''];

function makeTransactions(rnd, n) {
  const pick = arr => arr[Math.floor(rnd() * arr.length)];
  const amount = () => {
    const r = rnd();
    if (r < 0.06) return null;
    if (r < 0.12) return 'nope';
    if (r < 0.22) return -Math.round(rnd() * 8000) / 100;
    return Math.round(rnd() * 30000) / 100;
  };
  const txs = [];
  for (let i = 0; i < n; i++) {
    const type = pick(TYPES);
    const tx = {
      id: `t${i}`, type, date: pick(DATES), amount: amount(),
      status: rnd() < 0.25 ? 'scheduled' : 'posted',
    };
    if (rnd() < 0.1) tx.is_forecast = true;
    if (type === 'expense' && rnd() < 0.45) {
      tx.envelope_splits = Array.from({ length: 1 + Math.floor(rnd() * 3) }, () => ({
        envelope_id: pick(ENV_POOL), amount: amount(),
      }));
    } else if (type === 'fill') {
      tx.lines = Array.from({ length: 1 + Math.floor(rnd() * 3) }, () => ({
        envelope_id: pick(ENV_POOL), amount: amount(), mode: rnd() < 0.3 ? 'set' : 'add',
      }));
    } else if (type === 'envelope_transfer') {
      tx.from_envelope_id = pick(ENV_POOL);
      tx.to_envelope_id = pick(ENV_POOL);
    } else if (type === 'investment_transfer') {
      tx.envelope_id = pick(ENV_POOL);
      tx.direction = pick(['buy', 'sell', 'dividend', undefined]);
    } else if (type === 'adjustment') {
      tx.target = pick(['envelope', 'account']);
      tx.target_id = pick(ENV_POOL);
    } else {
      tx.envelope_id = pick(ENV_POOL);
    }
    txs.push(tx);
  }
  return txs;
}

const EPS = 1e-9;

// `runMonthlyReview` surfaces the two buckets as `actual` and `scheduled` per
// row — the observable form the oracle has to be checked against.
function reviewSpend(transactions, balances) {
  const rows = runMonthlyReview(ENVELOPES, [], balances, transactions, MONTH, REF);
  const actual = new Map();
  const scheduled = new Map();
  for (const r of rows) {
    actual.set(r.envelope_id, r.actual);
    scheduled.set(r.envelope_id, r.scheduled);
  }
  return { actual, scheduled };
}

describe('monthly-review debits match the pre-refactor walk', () => {
  it('agrees across 150 random ledgers', () => {
    for (let seed = 1; seed <= 150; seed++) {
      const txs = makeTransactions(mulberry32(seed), 30);
      const balances = new Map([['e1', 500], ['e2', 500], ['e3', 500]]);
      const want = oldDebits(txs, balances, REF);
      const got = reviewSpend(txs, balances);

      for (const id of ['e1', 'e2', 'e3']) {
        expect(
          Math.abs((got.actual.get(id) ?? 0) - (want.actualDebits.get(id) ?? 0)),
          `seed ${seed}: actual debits for ${id}`,
        ).toBeLessThan(EPS);
        expect(
          Math.abs((got.scheduled.get(id) ?? 0) - (want.scheduledDebits.get(id) ?? 0)),
          `seed ${seed}: scheduled debits for ${id}`,
        ).toBeLessThan(EPS);
      }
    }
  });

  it('still drops a planned debit for an envelope with no balance row', () => {
    const txs = [{
      id: 'x', type: 'expense', date: '2026-08-30', status: 'scheduled',
      amount: 40, envelope_id: 'e2',
    }];
    const balances = new Map([['e1', 500]]); // e2 absent on purpose
    const { scheduled } = reviewSpend(txs, balances);
    expect(scheduled.get('e2') ?? 0).toBe(0);
    // ...and still counts it when the envelope does have a balance row.
    const withRow = reviewSpend(txs, new Map([['e1', 500], ['e2', 500]]));
    expect(withRow.scheduled.get('e2')).toBe(40);
  });
});

describe('txEnvelopeSpend counts spending and nothing else', () => {
  const spend = (tx, id = 'e1') => txEnvelopeSpend(tx, id);

  it('counts a plain expense as its magnitude', () => {
    expect(spend({ type: 'expense', envelope_id: 'e1', amount: 25 })).toBe(25);
    expect(spend({ type: 'expense', envelope_id: 'e1', amount: -25 })).toBe(25);
  });

  it('counts split lines with their own sign, so a credit line reduces it', () => {
    const tx = {
      type: 'expense',
      envelope_splits: [
        { envelope_id: 'e1', amount: 30 },
        { envelope_id: 'e1', amount: -10 },
        { envelope_id: 'e2', amount: 99 },
      ],
    };
    expect(spend(tx)).toBe(20);
    expect(spend(tx, 'e2')).toBe(99);
  });

  it('counts a debt payment', () => {
    expect(spend({ type: 'debt_payment', envelope_id: 'e1', amount: 60 })).toBe(60);
  });

  it('counts an investment BUY but not a sell or dividend', () => {
    const base = { type: 'investment_transfer', envelope_id: 'e1', amount: 100 };
    expect(spend({ ...base, direction: 'buy' })).toBe(100);
    expect(spend({ ...base, direction: 'sell' })).toBe(0);
    expect(spend({ ...base, direction: 'dividend' })).toBe(0);
    expect(spend({ ...base })).toBe(100); // absent direction defaults to buy
  });

  // The exclusions are the point of having a separate primitive. If any of
  // these starts counting, "spent this month" silently includes money arriving.
  it('counts no fill, transfer, adjustment or income', () => {
    expect(spend({ type: 'fill', lines: [{ envelope_id: 'e1', mode: 'add', amount: 100 }] })).toBe(0);
    expect(spend({ type: 'envelope_transfer', from_envelope_id: 'e1', to_envelope_id: 'e2', amount: 50 })).toBe(0);
    expect(spend({ type: 'adjustment', target: 'envelope', target_id: 'e1', amount: -20 })).toBe(0);
    expect(spend({ type: 'income', envelope_id: 'e1', amount: 200 })).toBe(0);
    expect(spend({ type: 'account_transfer', from_account: 'a', to_account: 'b', amount: 400 })).toBe(0);
  });

  it('spends nothing for __none__ or a missing envelope', () => {
    expect(txEnvelopeSpend({ type: 'expense', envelope_id: '__none__', amount: 10 }, '__none__')).toBe(0);
    expect(txEnvelopeSpend({ type: 'expense', envelope_id: 'e1', amount: 10 }, null)).toBe(0);
    expect(txEnvelopeSpend(null, 'e1')).toBe(0);
  });

  it('treats a malformed amount as zero rather than NaN', () => {
    expect(spend({ type: 'expense', envelope_id: 'e1', amount: 'abc' })).toBe(0);
    expect(spend({ type: 'expense', envelope_id: 'e1', amount: null })).toBe(0);
  });
});
