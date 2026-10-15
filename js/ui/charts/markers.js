// js/ui/charts/markers.js — markers on a chart's x points (e.g. the
// simulation's dates to act on). Pure: groups `spec.markers` by the index of
// the x point whose key they name; a marker naming no x point is dropped.

/**
 * @param {any} spec  `{ x: {key}[], markers?: {key, label, onSelect?}[] }`
 * @returns {Map<number, { key: string, label: string, onSelect?: () => void }[]>}
 */
export function markersByIndex(spec) {
  const indexOf = new Map((spec.x || []).map((x, i) => [String(x.key), i]));
  /** @type {Map<number, any[]>} */
  const out = new Map();
  for (const m of spec.markers || []) {
    const i = indexOf.get(String(m.key));
    if (i == null) continue;
    if (!out.has(i)) out.set(i, []);
    /** @type {any[]} */ (out.get(i)).push(m);
  }
  return out;
}

/**
 * Appends a marker mention to a base sentence, only when the chart actually
 * has any (a marker naming no x point never reaches `markersByIndex`'s map,
 * so `markers.size` reflects what is really drawn). Used for the figure's
 * aria-label keyboard hint ("Enter activates one") and its sr-only summary,
 * so screen-reader users learn markers exist without index.js repeating the
 * branch in two places.
 * @param {string} base
 * @param {Map<number, any[]>} markers
 * @param {string} note
 */
export function withMarkerNote(base, markers, note) {
  return markers.size ? `${base} ${note}` : base;
}
