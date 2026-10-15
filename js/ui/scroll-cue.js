// js/ui/scroll-cue.js — a visible cue on sideways-scrolling strips.
//
// On a phone, wide tables (Stress, Net worth, Review, Investments) and the
// Settings tab strip scroll sideways inside their own box. A box that merely
// clips gives no hint there is more to the right, so the key columns (Net,
// Runway, Surplus) went unseen. An element that opts in with
// `data-scroll-cue` gets `data-scroll-start` / `data-scroll-end` set while
// there is more content in that direction; css/mobile.css fades that edge.
//
// One MutationObserver picks up opted-in elements whenever a page renders,
// so a page only adds the attribute; a ResizeObserver per element keeps the
// state right when the window or the content changes size.

/**
 * Which edges of a horizontal scroller hide content.
 * @param {{ scrollLeft: number, scrollWidth: number, clientWidth: number }} m
 * @returns {{ start: boolean, end: boolean }}
 */
export function scrollCueState({ scrollLeft, scrollWidth, clientWidth }) {
  const max = scrollWidth - clientWidth;
  // Sub-pixel layouts leave a 1px "overflow" that is not content.
  if (!(max > 1)) return { start: false, end: false };
  // RTL scrollers report a negative scrollLeft; the magnitude is what counts.
  const pos = Math.abs(scrollLeft);
  return { start: pos > 1, end: pos < max - 1 };
}

const attached = new WeakSet();

/** @param {HTMLElement} el */
function update(el) {
  const { start, end } = scrollCueState(el);
  el.toggleAttribute('data-scroll-start', start);
  el.toggleAttribute('data-scroll-end', end);
}

/** @param {HTMLElement} el */
export function attachScrollCue(el) {
  if (attached.has(el)) return;
  attached.add(el);
  el.addEventListener('scroll', () => update(el), { passive: true });
  if (typeof ResizeObserver === 'function') {
    const ro = new ResizeObserver(() => update(el));
    ro.observe(el);
    // Content growing (a table filled in later) changes scrollWidth without
    // resizing the box itself.
    for (const child of el.children) ro.observe(child);
  }
  update(el);
}

/** @param {ParentNode} root */
export function attachScrollCues(root) {
  if (root instanceof HTMLElement && root.hasAttribute('data-scroll-cue')) attachScrollCue(root);
  for (const el of root.querySelectorAll('[data-scroll-cue]')) attachScrollCue(/** @type {HTMLElement} */ (el));
}

let observing = false;
/** Watch the document for opted-in elements. Idempotent. */
export function observeScrollCues(root = typeof document === 'undefined' ? null : document.body) {
  if (observing || !root || typeof MutationObserver !== 'function') return;
  observing = true;
  let queued = false;
  const run = () => { queued = false; attachScrollCues(root); };
  new MutationObserver(() => {
    if (queued) return;
    // A test environment torn down mid-callback has no frame scheduler and
    // nothing left to decorate.
    if (typeof requestAnimationFrame !== 'function') return;
    queued = true;
    requestAnimationFrame(run);
  }).observe(root, { childList: true, subtree: true });
  attachScrollCues(root);
}
