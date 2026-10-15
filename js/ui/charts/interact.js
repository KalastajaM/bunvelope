// js/ui/charts/interact.js — pointer, touch and keyboard handling. Turns
// positions into x indices through the model and reports intent back to
// index.js (move the cursor, zoom, select); it draws nothing itself except
// the drag-selection rectangle. i18n-free.
//
//   mouse   move = crosshair · drag = zoom to range · click = onSelect, or
//           the first marker's action on charts without onSelect ·
//           double-click = reset zoom (only without onSelect: there the
//           first click has already navigated)
//   touch   tap/drag = crosshair that stays · pinch = zoom ·
//           tap on the point already showing = onSelect
//   keys    ←/→ Home/End move · Esc clears · +/− zoom · Enter = onSelect

import { nearestIndex, zoomBy, clampZoom, canZoom } from './model.js';

/** A pointer that travels further than this before release is a drag. */
const DRAG_PX = 6;
/** A pinch smaller than this change in finger distance is ignored. */
const PINCH_MIN = 0.15;

/**
 * @param {{
 *   root: HTMLElement, svg: SVGSVGElement, geom: any, spec: any, n: number,
 *   getCursor: () => number | null, setCursor: (i: number | null, speak?: boolean) => void,
 *   setZoom: (win: { from: number, to: number } | null) => void,
 *   select: (i: number) => void, signal: AbortSignal,
 * }} o
 */
export function attachSeriesInteraction(o) {
  const { svg, geom, spec, signal } = o;
  const zoomable = canZoom(spec);
  const pxAt = clientX => clientX - svg.getBoundingClientRect().left;
  const idxAt = clientX => nearestIndex(geom.kind, pxAt(clientX), geom.win, geom.plotL, geom.plotW);
  const mid = () => Math.round((geom.win.from + geom.win.to) / 2);

  const showSel = (xa, xb) => {
    const left = Math.max(geom.plotL, Math.min(xa, xb));
    const right = Math.min(geom.plotL + geom.plotW, Math.max(xa, xb));
    geom.sel.setAttribute('x', String(left));
    geom.sel.setAttribute('width', String(Math.max(0, right - left)));
    geom.sel.setAttribute('visibility', 'visible');
  };
  const hideSel = () => geom.sel.setAttribute('visibility', 'hidden');

  /** @type {{ x0: number, i0: number, moved: boolean } | null} */
  let drag = null;
  /** @type {Map<number, number>} pointerId → clientX */
  const touches = new Map();
  /** @type {{ d0: number, center: number } | null} */
  let pinch = null;
  /** @type {{ i: number, x0: number, wasShowing: boolean, moved: boolean } | null} */
  let tap = null;

  svg.addEventListener('pointerdown', e => {
    if (e.pointerType === 'mouse') {
      if (e.button !== 0) return;
      drag = { x0: pxAt(e.clientX), i0: idxAt(e.clientX), moved: false };
      svg.setPointerCapture(e.pointerId);
      return;
    }
    touches.set(e.pointerId, e.clientX);
    svg.setPointerCapture(e.pointerId);
    if (touches.size === 2) {
      const [a, b] = [...touches.values()];
      pinch = { d0: Math.abs(a - b) || 1, center: idxAt((a + b) / 2) };
      tap = null;
    } else if (touches.size === 1) {
      const i = idxAt(e.clientX);
      tap = { i, x0: e.clientX, wasShowing: o.getCursor() === i, moved: false };
      o.setCursor(i);
    } else if (touches.size > 2) {
      // a third finger cancels the pinch
      pinch = null;
      tap = null;
    }
  }, { signal });

  svg.addEventListener('pointermove', e => {
    if (e.pointerType === 'mouse') {
      if (drag) {
        const x = pxAt(e.clientX);
        if (!drag.moved && zoomable && Math.abs(x - drag.x0) > DRAG_PX) drag.moved = true;
        if (drag.moved) { showSel(drag.x0, x); return; }
      }
      o.setCursor(idxAt(e.clientX));
      return;
    }
    if (!touches.has(e.pointerId)) return;
    touches.set(e.pointerId, e.clientX);
    if (pinch) return;
    if (tap && Math.abs(e.clientX - tap.x0) > DRAG_PX) tap.moved = true;
    o.setCursor(idxAt(e.clientX));
  }, { signal });

  const end = e => {
    if (e.pointerType === 'mouse') {
      if (!drag) return;
      const d = drag;
      drag = null;
      hideSel();
      if (d.moved) o.setZoom(clampZoom(d.i0, idxAt(e.clientX), o.n));
      else if (e.type === 'pointerup') {
        const x = pxAt(e.clientX);
        if (x >= geom.plotL && x <= geom.plotL + geom.plotW) o.select(idxAt(e.clientX));
      }
      return;
    }
    if (!touches.has(e.pointerId)) return;
    if (pinch && touches.size === 2) {
      const [a, b] = [...touches.values()];
      const factor = pinch.d0 / (Math.abs(a - b) || 1); // fingers apart → < 1 → zoom in
      if (zoomable && Math.abs(1 - factor) > PINCH_MIN) o.setZoom(zoomBy(geom.win, o.n, factor, pinch.center));
      pinch = null;
    } else if (tap && !tap.moved && tap.wasShowing && e.type === 'pointerup') {
      o.select(tap.i);
    }
    touches.delete(e.pointerId);
    if (!touches.size) { tap = null; pinch = null; }
  };
  svg.addEventListener('pointerup', end, { signal });
  svg.addEventListener('pointercancel', end, { signal });
  svg.addEventListener('pointerleave', e => {
    if (e.pointerType === 'mouse' && !drag) o.setCursor(null);
  }, { signal });
  svg.addEventListener('dblclick', () => {
    if (zoomable && !spec.onSelect) o.setZoom(null);
  }, { signal });

  o.root.addEventListener('keydown', e => {
    if (e.target !== o.root) return; // legend and toolbar buttons handle their own keys
    const cur = o.getCursor();
    const { from, to } = geom.win;
    let next;
    switch (e.key) {
      case 'ArrowLeft': next = cur == null ? to : Math.max(from, cur - 1); break;
      case 'ArrowRight': next = cur == null ? from : Math.min(to, cur + 1); break;
      case 'Home': next = from; break;
      case 'End': next = to; break;
      case 'Escape':
        if (cur == null) return;
        e.preventDefault();
        o.setCursor(null);
        return;
      case '+': case '=':
        if (!zoomable) return;
        e.preventDefault();
        o.setZoom(zoomBy(geom.win, o.n, 0.5, cur ?? mid()));
        return;
      case '-': case '_':
        if (!zoomable) return;
        e.preventDefault();
        o.setZoom(zoomBy(geom.win, o.n, 2, cur ?? mid()));
        return;
      case 'Enter':
        if (cur == null) return;
        e.preventDefault();
        o.select(cur);
        return;
      default:
        return;
    }
    e.preventDefault();
    o.setCursor(next, true);
  }, { signal });
}

/**
 * Item lists (horizontal bars, pie legend): hovering or focusing a row, or a
 * pie slice, marks every element with the same data-id `.is-hot` (row
 * highlight, share shown, other slices dimmed); ↑/↓ move focus between rows.
 * @param {{ body: HTMLElement, signal: AbortSignal }} o
 */
export function attachItemInteraction({ body, signal }) {
  const idOf = target => {
    const hit = target instanceof Element ? target.closest('[data-id]') : null;
    return hit ? hit.getAttribute('data-id') : null;
  };
  const hot = id => {
    for (const e of body.querySelectorAll('[data-id]')) e.classList.toggle('is-hot', id != null && e.getAttribute('data-id') === id);
  };
  // Keyboard focus moving off a row (e.g. Tab to the hide button, which sits
  // outside this row's hover target) used to clear the highlight outright;
  // now it falls back to whatever the pointer is still hovering.
  /** @type {string | null} */
  let hoveredId = null;
  body.addEventListener('pointerover', e => { hoveredId = idOf(e.target); hot(hoveredId); }, { signal });
  body.addEventListener('pointerleave', () => {
    hoveredId = null;
    hot(body.contains(document.activeElement) ? idOf(document.activeElement) : null);
  }, { signal });
  body.addEventListener('focusin', e => hot(idOf(e.target)), { signal });
  body.addEventListener('focusout', () => hot(hoveredId), { signal });
  body.addEventListener('keydown', e => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const mains = [...body.querySelectorAll('.bv-chart-item-main')];
    const row = document.activeElement instanceof Element ? document.activeElement.closest('.bv-chart-item') : null;
    const at = row ? mains.indexOf(/** @type {Element} */ (row.querySelector('.bv-chart-item-main'))) : -1;
    if (at < 0) return;
    const next = mains[Math.max(0, Math.min(mains.length - 1, at + (e.key === 'ArrowDown' ? 1 : -1)))];
    e.preventDefault();
    /** @type {HTMLElement} */ (next).focus();
  }, { signal });
}
