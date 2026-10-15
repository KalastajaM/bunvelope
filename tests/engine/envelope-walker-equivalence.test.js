// Differential test for the envelope-walker consolidation.
//
// `_computeEnvelopeBalancesRaw` and `computeEnvelopeRunningBalances` each
// carried their own hand-written copy of the per-type envelope math; both now
// go through `txEnvelopeEffect`. The existing suite is a fixed corpus, and a
// fixed corpus is precisely what let the last drift through — a copy shipped
// missing the `__none__` sentinel guard and every example test still passed.
//
// So this compares the live implementations against the PRE-REFACTOR code,
// reproduced verbatim below as an oracle, over thousands of randomly shaped
// transactions: splits, set-mode fills, dividends, `__none__`, malformed
// amounts, same-day ties, unknown types.
//
// The generator is seeded, so a failure names a reproducible case rather than
// a mood.

import { describe, it, expect } from 'vitest';
import {
  computeEnvelopeBalances, computeEnvelopeRunningBalances,
} from '../../js/engine.js';
import { validateAmount } from '../../js/utils.js';

// ── Oracle: the implementations as they stood before consolidation ───────────

function oldBulk(transactions) {
  const ordered = (transactions || []).map((tx, i) => ({ tx, i }));
  ordered.sort((a, b) => {
    const da = (a.tx.date || '').slice(0, 10);
    const db = (b.tx.date || '').slice(0, 10);
    if (da !== db) return da < db ? -1 : 1;
    return a.i - b.i;
  });
  const balances = new Map();
  const get = id => balances.get(id) ?? 0;
  const set = (id, val) => balances.set(id, val);
  const add = (id, delta) => set(id, get(id) + delta);

  for (const { tx } of ordered) {
    const type = tx.type;
    if (type === 'expense') {
      if (Array.isArray(tx.envelope_splits) && tx.envelope_splits.length) {
        for (const s of tx.envelope_splits) {
          const sa = validateAmount(s.amount);
          if (sa !== null && s.envelope_id && s.envelope_id !== '__none__') {
            add(s.envelope_id, -sa);
          }
        }
      } else {
        const amt = validateAmount(tx.amount);
        if (amt !== null && tx.envelope_id && tx.envelope_id !== '__none__') {
          add(tx.envelope_id, -Math.abs(amt));
        }
      }
    } else if (type === 'income') {
      const amt = validateAmount(tx.amount);
      if (amt !== null && tx.envelope_id && tx.envelope_id !== '__none__') {
        add(tx.envelope_id, Math.abs(amt));
      }
    } else if (type === 'fill') {
      for (const line of (tx.lines || [])) {
        const id = line.envelope_id;
        if (!id) continue;
        const amt = validateAmount(line.amount);
        if (amt === null) continue;
        if (line.mode === 'set') set(id, amt);
        else                     add(id, amt);
      }
    } else if (type === 'envelope_transfer') {
      const amt = validateAmount(tx.amount);
      if (amt !== null) {
        if (tx.from_envelope_id) add(tx.from_envelope_id, -Math.abs(amt));
        if (tx.to_envelope_id)   add(tx.to_envelope_id,    Math.abs(amt));
      }
    } else if (type === 'debt_payment') {
      const amt = validateAmount(tx.amount);
      if (amt !== null && tx.envelope_id) add(tx.envelope_id, -Math.abs(amt));
    } else if (type === 'investment_transfer') {
      const amt = validateAmount(tx.amount);
      if (amt !== null && tx.envelope_id && tx.envelope_id !== '__none__') {
        const direction = tx.direction === 'sell' ? 'sell'
                        : tx.direction === 'dividend' ? 'dividend'
                        : 'buy';
        add(tx.envelope_id, (direction === 'buy' ? -1 : 1) * Math.abs(amt));
      }
    } else if (type === 'adjustment' && tx.target === 'envelope') {
      const amt = validateAmount(tx.amount);
      if (amt !== null && tx.target_id) add(tx.target_id, amt);
    }
  }
  return balances;
}

function oldRunning(transactions, envelopeId) {
  if (!envelopeId) return new Map();
  const indexed = (transactions || []).map((tx, i) => ({ tx, i }));
  indexed.sort((a, b) => {
    const da = (a.tx.date || '').slice(0, 10);
    const db = (b.tx.date || '').slice(0, 10);
    if (da !== db) return da < db ? -1 : 1;
    return a.i - b.i;
  });
  const out = new Map();
  let bal = 0;
  for (const { tx } of indexed) {
    const type = tx.type;
    let next = bal;
    let touched = false;
    if (type === 'expense') {
      if (Array.isArray(tx.envelope_splits) && tx.envelope_splits.length) {
        for (const s of tx.envelope_splits) {
          if (s.envelope_id !== envelopeId || s.envelope_id === '__none__') continue;
          const sa = validateAmount(s.amount);
          if (sa === null) continue;
          next -= sa;
          touched = true;
        }
      } else if (tx.envelope_id === envelopeId && tx.envelope_id !== '__none__') {
        const amt = validateAmount(tx.amount);
        if (amt !== null) { next -= Math.abs(amt); touched = true; }
      }
    } else if (type === 'income') {
      if (tx.envelope_id === envelopeId && tx.envelope_id !== '__none__') {
        const amt = validateAmount(tx.amount);
        if (amt !== null) { next += Math.abs(amt); touched = true; }
      }
    } else if (type === 'fill') {
      for (const line of (tx.lines || [])) {
        if (line.envelope_id !== envelopeId) continue;
        const amt = validateAmount(line.amount);
        if (amt === null) continue;
        if (line.mode === 'set') next = amt;
        else                     next += amt;
        touched = true;
      }
    } else if (type === 'envelope_transfer') {
      const amt = validateAmount(tx.amount);
      if (amt !== null) {
        if (tx.from_envelope_id === envelopeId) { next -= Math.abs(amt); touched = true; }
        if (tx.to_envelope_id   === envelopeId) { next += Math.abs(amt); touched = true; }
      }
    } else if (type === 'debt_payment' && tx.envelope_id === envelopeId) {
      const amt = validateAmount(tx.amount);
      if (amt !== null) { next -= Math.abs(amt); touched = true; }
    } else if (type === 'investment_transfer' && tx.envelope_id === envelopeId
               && tx.envelope_id !== '__none__') {
      const amt = validateAmount(tx.amount);
      if (amt !== null) {
        const direction = tx.direction === 'sell' ? 'sell'
                        : tx.direction === 'dividend' ? 'dividend'
                        : 'buy';
        next += (direction === 'buy' ? -1 : 1) * Math.abs(amt);
        touched = true;
      }
    } else if (type === 'adjustment' && tx.target === 'envelope' && tx.target_id === envelopeId) {
      const amt = validateAmount(tx.amount);
      if (amt !== null) { next += amt; touched = true; }
    }
    if (touched) { bal = next; out.set(tx.id, bal); }
  }
  return out;
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

const ENV_POOL = ['e1', 'e2', 'e3', '__none__', undefined, null, ''];
const TYPES = [
  'expense', 'expense', 'income', 'fill', 'fill', 'envelope_transfer',
  'debt_payment', 'investment_transfer', 'adjustment', 'account_transfer', 'nonsense',
];
// Dates deliberately repeat so the stable-index tiebreaker is exercised.
const DATES = ['2026-01-05', '2026-01-05', '2026-02-11', '2026-03-01', '', undefined];

function makeTransactions(rnd, n) {
  const pick = arr => arr[Math.floor(rnd() * arr.length)];
  const amount = () => {
    const r = rnd();
    if (r < 0.05) return null;
    if (r < 0.1) return 'not-a-number';
    if (r < 0.15) return NaN;
    if (r < 0.25) return -Math.round(rnd() * 20000) / 100;
    return Math.round(rnd() * 50000) / 100;
  };
  const txs = [];
  for (let i = 0; i < n; i++) {
    const type = pick(TYPES);
    const tx = { id: `t${i}`, type, date: pick(DATES), amount: amount() };
    if (type === 'expense' && rnd() < 0.4) {
      const lines = 1 + Math.floor(rnd() * 3);
      tx.envelope_splits = Array.from({ length: lines }, () => ({
        envelope_id: pick(ENV_POOL), amount: amount(),
      }));
    } else if (type === 'fill') {
      const lines = 1 + Math.floor(rnd() * 4);
      tx.lines = Array.from({ length: lines }, () => ({
        envelope_id: pick(ENV_POOL),
        amount: amount(),
        mode: rnd() < 0.3 ? 'set' : 'add',
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

// Both walkers now fold a transaction's lines into ONE effect before applying
// it, where the old code applied each line separately. `(b + 0.1) + 0.2` and
// `b + (0.1 + 0.2)` differ in the last bit, so compare numerically rather than
// by identity — the gap is far below a cent and display rounds anyway.
const EPS = 1e-9;

function expectMapsClose(actual, expected, label) {
  const keys = new Set([...actual.keys(), ...expected.keys()]);
  for (const k of keys) {
    const a = actual.get(k) ?? 0;
    const e = expected.get(k) ?? 0;
    expect(Math.abs(a - e), `${label}: key ${String(k)} → ${a} vs ${e}`).toBeLessThan(EPS);
  }
}

describe('envelope walkers match the pre-consolidation implementations', () => {
  it('bulk balances agree across 200 random ledgers', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const txs = makeTransactions(mulberry32(seed), 40);
      expectMapsClose(computeEnvelopeBalances(txs), oldBulk(txs), `bulk seed ${seed}`);
    }
  });

  it('running balances agree for every envelope across 200 random ledgers', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const txs = makeTransactions(mulberry32(seed + 5000), 40);
      for (const envId of ['e1', 'e2', 'e3', '__none__']) {
        expectMapsClose(
          computeEnvelopeRunningBalances(txs, envId),
          oldRunning(txs, envId),
          `running ${envId} seed ${seed}`,
        );
      }
    }
  });

  it('running balances end where the bulk walk says they should', () => {
    // The two are independent code paths over the same rules; their final
    // numbers must agree or one of the app's surfaces is lying.
    for (let seed = 1; seed <= 100; seed++) {
      const txs = makeTransactions(mulberry32(seed + 9000), 30);
      const bulk = computeEnvelopeBalances(txs);
      for (const envId of ['e1', 'e2', 'e3']) {
        const running = computeEnvelopeRunningBalances(txs, envId);
        const last = [...running.values()].pop() ?? 0;
        expect(
          Math.abs(last - (bulk.get(envId) ?? 0)),
          `seed ${seed} envelope ${envId}: running ended ${last}, bulk says ${bulk.get(envId)}`,
        ).toBeLessThan(EPS);
      }
    }
  });

  it('keeps the same set of touched transactions in the running map', () => {
    for (let seed = 1; seed <= 100; seed++) {
      const txs = makeTransactions(mulberry32(seed + 12000), 30);
      for (const envId of ['e1', '__none__']) {
        const got = [...computeEnvelopeRunningBalances(txs, envId).keys()].sort();
        const want = [...oldRunning(txs, envId).keys()].sort();
        expect(got, `touched ids differ, seed ${seed}, envelope ${envId}`).toEqual(want);
      }
    }
  });
});
