// server/ai/cache.js — LRU response cache + per-user/per-feature sliding-window
// rate caps. Both keep at most a few hundred entries in memory; nothing
// persists across restarts.

import { createHash } from 'node:crypto';

const RESPONSE_TTL_MS = 60 * 60 * 1000; // 1h
const RESPONSE_MAX = 200;

const responseCache = new Map(); // key -> { value, expiresAt }

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(value[k])).join(',') + '}';
}

export function cacheKey({ feature, context, locale, input, userId }) {
  const h = createHash('sha256');
  h.update(feature || '');
  h.update('|');
  h.update(locale || '');
  h.update('|');
  h.update(input || '');
  h.update('|');
  h.update(userId || '');
  h.update('|');
  h.update(canonicalJson(context ?? null));
  return h.digest('hex');
}

export function getCached(key) {
  const entry = responseCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) {
    responseCache.delete(key);
    return null;
  }
  // Refresh recency.
  responseCache.delete(key);
  responseCache.set(key, entry);
  return entry.value;
}

export function setCached(key, value) {
  responseCache.set(key, { value, expiresAt: Date.now() + RESPONSE_TTL_MS });
  while (responseCache.size > RESPONSE_MAX) {
    const oldest = responseCache.keys().next().value;
    responseCache.delete(oldest);
  }
}

export function clearCachedForUser(userId) {
  if (!userId) return 0;
  const keys = userKeyIndex.get(userId);
  if (!keys) return 0;
  let n = 0;
  for (const k of keys) {
    if (responseCache.delete(k)) n++;
  }
  userKeyIndex.delete(userId);
  return n;
}

const userKeyIndex = new Map(); // userId -> Set<key>

export function indexUserKey(userId, key) {
  if (!userId) return;
  let s = userKeyIndex.get(userId);
  if (!s) { s = new Set(); userKeyIndex.set(userId, s); }
  s.add(key);
}

// ── Sliding-window per-user/per-feature soft caps ────────────────────────

const FEATURE_CAPS = {
  monthly_briefing:        { max: 6,  windowMs: 60_000 },
  anomaly:                 { max: 4,  windowMs: 60_000 },
  envelope_health:         { max: 4,  windowMs: 60_000 },
  subscription_detection:  { max: 4,  windowMs: 60_000 },
  whatif:                  { max: 12, windowMs: 60_000 },
  reconcile:               { max: 12, windowMs: 60_000 },
  onboarding:              { max: 12, windowMs: 60_000 },
  search:                  { max: 30, windowMs: 60_000 },
  portfolio_insight:       { max: 4,  windowMs: 60_000 },
};

const windows = new Map(); // `${userId}:${feature}` -> number[] (timestamps)

export function checkRate(userId, feature) {
  const cap = FEATURE_CAPS[feature];
  if (!cap || !userId) return { ok: true };
  const key = `${userId}:${feature}`;
  const now = Date.now();
  const cutoff = now - cap.windowMs;
  const arr = windows.get(key) || [];
  while (arr.length && arr[0] < cutoff) arr.shift();
  if (arr.length >= cap.max) {
    return { ok: false, retry_after_ms: arr[0] + cap.windowMs - now };
  }
  arr.push(now);
  windows.set(key, arr);
  return { ok: true };
}
