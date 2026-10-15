// Physical storage only: the logical budget/export still contains v1 history.
// Immutable baseline + forward revision chunks avoid rewriting a growing head.
import { compactFinancialHistory, validHistory, historyStart } from '../core/financial-history.js';
import { deepEqual, applyDiff } from '../core/diff.js';

export const isStoredHistory = h => h?.storage === 'history-chunks-v1';
export function chunkIds(h) {
  if (!isStoredHistory(h)) return [];
  if (!Array.isArray(h.segments) || !h.segments.length || h.segments.some(s => !s
      || typeof s.base !== 'string' || !Array.isArray(s.chunks)
      || [...s.chunks, s.base].some(id => typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)))) {
    throw new Error('Invalid financial history manifest');
  }
  return h.segments.flatMap(s => [s.base, ...s.chunks]);
}

export async function chunkId(data) {
  const bytes = new TextEncoder().encode(JSON.stringify(data, (_key, value) => value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])) : value));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function replay(head, entries) {
  for (const entry of entries) {
    const result = applyDiff(head, entry.diff);
    if (!result.ok) throw new Error('Financial history revision conflicts with its baseline');
    head = { ...head, ...result.value };
  }
  return head;
}

/** Prepare immutable chunks; advance the returned cache ONLY after publication. */
export async function packHistoryMeta(meta, cache = null, seal = async v => v) {
  const history = compactFinancialHistory(meta?.financialHistory);
  if (!validHistory(history)) return { meta, chunks: [], cache: null };
  const chunks = [];
  const add = async data => {
    const stored = await seal(data), id = await chunkId(stored);
    chunks.push({ id, data: stored });
    return id;
  };
  const segments = [];
  const cached = [];
  const flattened = [];
  const visit = h => {
    for (const p of h.previous || []) visit(p);
    const { previous: _previous, ...segment } = h;
    flattened.push(segment);
  };
  visit(history);
  for (const segment of flattened) {
    // A matching prefix alone is insufficient: prove the head also follows it.
    const previous = cache?.segments?.find(s => deepEqual(s.history.start, segment.start)
      && s.history.entries.length <= segment.entries.length
      && s.history.entries.every((e, i) => deepEqual(e, segment.entries[i])));
    let reusable = false;
    if (previous) {
      try { reusable = deepEqual(replay(previous.history.head, segment.entries.slice(previous.history.entries.length)), segment.head); }
      catch { /* Rewrite from a verified baseline below. */ }
    }
    const descriptor = { start: segment.start,
      ...(segment.gap ? { gap: true } : {}), ...(segment.until ? { until: segment.until } : {}),
      base: reusable ? previous.descriptor.base : null,
      chunks: reusable ? [...previous.descriptor.chunks] : [] };
    let from = reusable ? previous.history.entries.length : 0;
    if (!reusable) {
      const baseline = historyStart(segment);
      // Preserve malformed legacy history verbatim rather than losing it.
      if (!baseline) return { meta, chunks: [], cache: null };
      descriptor.base = await add({ baseline });
    }
    while (from < segment.entries.length) {
      descriptor.chunks.push(await add({ entries: segment.entries.slice(from, from + 64) }));
      from += 64;
    }
    segments.push(descriptor);
    cached.push({ history: segment, descriptor });
  }
  return { meta: { ...meta, schemaVersion: Math.max(meta.schemaVersion || 1, 8),
    financialHistory: { storage: 'history-chunks-v1', segments } }, chunks,
    cache: { segments: cached } };
}

/** Missing/corrupt chunks fail closed; no partial budget or invented history. */
export async function unpackHistoryMeta(meta, get, open = async v => v) {
  const stored = meta?.financialHistory;
  if (!isStoredHistory(stored)) return { meta, cache: null };
  if (!Array.isArray(stored.segments) || !stored.segments.length) throw new Error('Invalid financial history manifest');
  const read = async id => {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('Invalid financial history chunk id');
    const raw = await get(id);
    if (!raw || await chunkId(raw) !== id) throw new Error('Missing or damaged financial history chunk');
    return open(raw);
  };
  const segments = [], cached = [];
  for (const descriptor of stored.segments) {
    if (!Array.isArray(descriptor.chunks)) throw new Error('Invalid financial history chunk list');
    const { baseline } = await read(descriptor.base);
    const entries = [];
    for (const id of descriptor.chunks) {
      const chunk = await read(id);
      if (!Array.isArray(chunk.entries)) throw new Error('Invalid financial history revisions');
      entries.push(...chunk.entries);
    }
    const history = { version: 1, start: descriptor.start, head: replay(baseline, entries), entries,
      ...(descriptor.gap ? { gap: true } : {}), ...(descriptor.until ? { until: descriptor.until } : {}) };
    if (!validHistory(history)) throw new Error('Invalid financial history');
    segments.push(history); cached.push({ history, descriptor });
  }
  const history = { ...segments.at(-1), ...(segments.length > 1 ? { previous: segments.slice(0, -1) } : {}) };
  return { meta: { ...meta, financialHistory: history }, cache: { segments: cached } };
}
