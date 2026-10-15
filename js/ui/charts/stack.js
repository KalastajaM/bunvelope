// js/ui/charts/stack.js — the stacked view's layers: per x point, series
// stack from zero in the given order, non-negative values upward and negative
// values downward (a debt pulls the stack below zero rather than cancelling a
// part above it). Pure; model.js uses the extents for the axis, render.js
// draws the layers.

const val = v => (Number.isFinite(v) ? v : 0);

/**
 * @param {{ id: string, values: number[] }[]} series  visible stack series, in stack order
 * @param {number} from  first x index (inclusive)
 * @param {number} to    last x index (inclusive)
 * @returns {{ layers: { id: string, lo: number[], hi: number[] }[], min: number, max: number }}
 *   `lo`/`hi` are indexed by `i - from`; `min`/`max` always include zero.
 */
export function stackLayers(series, from, to) {
  const layers = series.map(s => ({ id: s.id, lo: /** @type {number[]} */ ([]), hi: /** @type {number[]} */ ([]) }));
  let min = 0;
  let max = 0;
  for (let i = from; i <= to; i++) {
    let up = 0;
    let down = 0;
    series.forEach((s, j) => {
      const v = val(s.values[i]);
      if (v >= 0) {
        layers[j].lo.push(up);
        up += v;
        layers[j].hi.push(up);
      } else {
        layers[j].hi.push(down);
        down += v;
        layers[j].lo.push(down);
      }
    });
    if (up > max) max = up;
    if (down < min) min = down;
  }
  return { layers, min, max };
}
