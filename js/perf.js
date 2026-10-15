// js/perf.js — opt-in boot/load timing instrumentation.
//
// Disabled by default and a no-op unless switched on, so it costs nothing in
// normal use. Enable with `?perf=1` in the URL, or persistently with
//   localStorage.setItem('bv-perf', '1')
//
// Usage:
//   import { mark, report } from './perf.js';
//   mark('bundle-fetched');
//   ...
//   report('budget load');   // console.table of deltas, then resets
//
// Marks are recorded relative to the first mark of the current run, so the
// table reads as a waterfall. `report()` clears the buffer, which means a
// second budget load in the same session measures itself, not the boot.

const ENABLED = (() => {
  try {
    if (typeof window === 'undefined') return false;
    const params = new URLSearchParams(window.location.search);
    if (params.get('perf') === '1') return true;
    return localStorage.getItem('bv-perf') === '1';
  } catch {
    // Safari private mode can throw on localStorage access.
    return false;
  }
})();

export function isPerfEnabled() { return ENABLED; }

const now = () => (
  typeof performance !== 'undefined' && performance.now
    ? performance.now()
    : Date.now()
);

/** @type {{name: string, at: number}[]} */
let marks = [];

export function mark(name) {
  if (!ENABLED) return;
  marks.push({ name, at: now() });
  // Also emit a real User Timing mark so the DevTools performance panel
  // lines up with the console table.
  try { performance.mark?.(`bv:${name}`); } catch { /* non-fatal */ }
}

/**
 * Print the collected marks as a waterfall and reset the buffer.
 *
 * `extra` is an optional object of counters (transaction counts, cache
 * stats) printed alongside the timings — the numbers are meaningless
 * without knowing the data size they were measured against.
 */
export function report(label = 'timing', extra = null) {
  if (!ENABLED) return;
  if (!marks.length) return;
  const t0 = marks[0].at;
  const rows = marks.map((m, i) => ({
    step: m.name,
    'since start (ms)': Math.round(m.at - t0),
    'delta (ms)': i === 0 ? 0 : Math.round(m.at - marks[i - 1].at),
  }));
  console.groupCollapsed(`[bunvelope perf] ${label} — ${Math.round(marks[marks.length - 1].at - t0)}ms total`);
  console.table(rows);
  if (extra) console.table(extra);
  console.groupEnd();
  marks = [];
}

/**
 * Snapshot of the counters worth reporting next to a load timing: data
 * volume plus the engine's memo hit/miss ratios. Reads the globals that
 * js/engine/balance-cache.js already exposes.
 */
export function perfCounters(state) {
  if (!ENABLED) return null;
  const bal = globalThis.__BUNVELOPE_BAL_STATS__ || null;
  const out = {
    transactions: state?.transactions?.length ?? 0,
    envelopes: state?.envelopes?.length ?? 0,
    accounts: state?.accounts?.length ?? 0,
    budgetItems: state?.budgetItems?.length ?? 0,
  };
  if (bal) {
    out.balanceCacheHits = bal.hits;
    out.balanceCacheMisses = bal.misses;
    out.balanceWalkMs = Math.round(bal.walkMs);
  }
  return [out];
}
