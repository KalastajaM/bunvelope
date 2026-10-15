// Automatic history of calculation inputs. A current head plus reversible
// per-commit diffs preserves additions, edits, deletions and settings together.
import { comparisonData, comparisonInputs, same, validComparison } from './comparison.js';
import { rowDiff, invert, applyDiff } from './diff.js';
import { isoDate } from './context.js';

export function initialHistory(data, now) {
  return { version: 1, start: { at: now.toISOString(), date: isoDate(now) }, head: comparisonData(data), entries: [] };
}
export function validHistory(h) {
  return h?.version === 1 && typeof h.start?.at === 'string'
    && validComparison({ version: 1, date: h.start?.date, data: h.head, view: { lens: 'booked' } })
    && Array.isArray(h.entries) && h.entries.every(e => typeof e.at === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(e.date) && e.diff && typeof e.diff === 'object')
    && (h.previous === undefined || (Array.isArray(h.previous) && h.previous.every(validHistory)));
}

// Replay is also the proof used by storage and lossless cleanup. Never infer
// continuity from dates or similar-looking snapshots alone.
export function historyStart(segment) {
  let data = segment.head;
  try {
    for (const entry of [...segment.entries].reverse()) {
      const applied = applyDiff(data, invert(entry.diff));
      if (!applied.ok) return null;
      data = { ...data, ...applied.value };
    }
  } catch { return null; }
  return data;
}

const compacted = new WeakMap();
export function compactFinancialHistory(history) {
  if (history && compacted.has(history)) return compacted.get(history);
  if (!validHistory(history)) return history;
  const segments = [];
  function visit(h) {
    for (const p of h.previous || []) visit(p);
    const { previous: _previous, ...segment } = h;
    segments.push(segment);
  }
  visit(history);
  const kept = [];
  let merged = false;
  for (const segment of segments) {
    const prior = kept.at(-1);
    const last = prior?.entries.at(-1)?.at || prior?.start.at;
    // Clock reversals and uncertain/corrupt revisions remain explicit gaps.
    const ordered = segment.entries.every((e, i) => e.at >= (i ? segment.entries[i - 1].at : segment.start.at));
    const endDate = prior?.until || prior?.entries.at(-1)?.date || prior?.start.date;
    const contiguousDays = Date.parse(segment.start.date) - Date.parse(endDate) <= 86400000;
    if (prior && ordered && contiguousDays && last <= segment.start.at
        && same(prior.head, historyStart(segment))) {
      const { until: _until, gap: _gap, ...rest } = segment;
      kept[kept.length - 1] = { ...rest, start: prior.start,
        entries: [...prior.entries, ...segment.entries],
        ...(prior.gap ? { gap: true } : {}),
        ...(segment.until ? { until: segment.until } : {}) };
      merged = true;
    } else kept.push(segment);
  }
  if (!merged) { compacted.set(history, history); return history; }
  const result = { ...kept.at(-1), ...(kept.length > 1 ? { previous: kept.slice(0, -1) } : {}) };
  compacted.set(history, result); compacted.set(result, result);
  return result;
}

export function appendFinancialHistory(before, after, now) {
  const previous = comparisonInputs(before), next = comparisonInputs(after);
  let history = compactFinancialHistory(before.meta?.financialHistory);
  // Import/external edits or an older client can bypass the session. Never
  // claim continuity across such a gap. Preserve an explicit coverage reason.
  if (!validHistory(history) || !same(history.head, previous)
      || now.toISOString() < (history.entries.at(-1)?.at || history.start.at)) {
    const hadHistory = !!history;
    const old = validHistory(history) ? history : null;
    history = initialHistory(before, now);
    if (hadHistory) history.gap = true;
    if (old) {
      const { previous: older = [], ...segment } = old;
      history.previous = [...older, { ...segment, until: segment.entries.at(-1)?.date || segment.start.date }];
      history.gap = true;
    }
  }
  const diff = rowDiff(previous, next);
  if (!Object.keys(diff).length) return history;
  // Only retained data needs ownership. Diffing the borrowed inputs above also
  // preserves identity for unchanged rows, avoiding redundant deep comparisons.
  return { ...history, head: structuredClone(next), entries: [...history.entries,
    { at: now.toISOString(), date: isoDate(now), diff: structuredClone(diff) }] };
}

export function historyPoint(data, date) {
  const current = compactFinancialHistory(data.meta?.financialHistory);
  if (!validHistory(current) || !same(current.head, comparisonInputs(data))) return null;
  const h = [current, ...(current.previous || []).slice().reverse()].find(segment => date >= segment.start.date && (!segment.until || date <= segment.until));
  if (!h) return null;
  let result = h.head;
  let revisions = 0;
  for (const entry of [...h.entries].reverse()) {
    if (entry.date < date) continue;
    let applied;
    try { applied = applyDiff(result, invert(entry.diff)); } catch { return null; }
    if (!applied.ok) return null;
    result = { ...result, ...applied.value }; revisions++;
  }
  return { version: 1, date, at: date === h.start.date ? h.start.at : null,
    data: result, revisions, partialDay: date === h.start.date, start: h.start, gap: !!h.gap };
}
