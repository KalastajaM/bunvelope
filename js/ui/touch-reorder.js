// js/ui/touch-reorder.js — touch (and pointer) drag-to-reorder helper.
//
// The HTML5 drag-and-drop API is mouse-only on most mobile browsers, so card
// reordering on touch devices needs a parallel implementation. This module
// exposes `enableTouchReorder({ handle, getItemId, getCandidates, onReorder })`
// which the existing envelope/account pages can attach without restructuring
// their drag code paths.
//
// Activation: a long-press (~350ms) on the handle. Once activated, the user
// can drag a finger over sibling cards (or category headers) to reorder; the
// drop target is the topmost element under the pointer that has the same
// data-id attribute as one of the candidates. Releasing fires `onReorder`.

const LONG_PRESS_MS = 350;
const MOVE_THRESHOLD = 8;

export function enableTouchReorder({
  handle,            // element that starts the drag (the card itself, usually)
  getItemId,         // () => string|null  — id of the item being dragged
  getDropTarget,     // (clientX, clientY) => { id, kind } | null
  onReorder,         // ({ from, to, kind }) => void
  onActivate,        // optional: () => void  — feedback when long-press triggers
  onCancel,          // optional: () => void
}) {
  let active = false;
  let pressTimer = null;
  let startX = 0, startY = 0;
  let lastTarget = null;

  const clearHover = () => {
    if (lastTarget && lastTarget.el) {
      lastTarget.el.classList.remove('drag-over', 'drag-over-group');
    }
    lastTarget = null;
  };

  const cancelPress = () => {
    if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
    if (active) {
      active = false;
      handle.classList.remove('is-touch-dragging');
      clearHover();
      onCancel?.();
    }
  };

  const onPointerDown = (e) => {
    // Only react to touch / pen — leave mouse drag to the existing HTML5 API.
    if (e.pointerType !== 'touch' && e.pointerType !== 'pen') return;
    startX = e.clientX; startY = e.clientY;
    pressTimer = setTimeout(() => {
      pressTimer = null;
      if (!getItemId()) return;
      active = true;
      handle.classList.add('is-touch-dragging');
      try { handle.setPointerCapture?.(e.pointerId); } catch { /* noop */ }
      onActivate?.();
    }, LONG_PRESS_MS);
  };

  const onPointerMove = (e) => {
    if (pressTimer && (Math.abs(e.clientX - startX) > MOVE_THRESHOLD || Math.abs(e.clientY - startY) > MOVE_THRESHOLD)) {
      // User scrolled before long-press fired — abort.
      clearTimeout(pressTimer); pressTimer = null;
      return;
    }
    if (!active) return;
    e.preventDefault(); // prevent scrolling while dragging
    const target = getDropTarget(e.clientX, e.clientY);
    if (!target || target.id === getItemId()) {
      clearHover();
      return;
    }
    if (lastTarget && lastTarget.id === target.id) return;
    clearHover();
    lastTarget = target;
    if (target.el) {
      target.el.classList.add(target.kind === 'group' ? 'drag-over-group' : 'drag-over');
    }
  };

  const onPointerUp = () => {
    if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
    if (!active) return;
    const from = getItemId();
    const target = lastTarget;
    handle.classList.remove('is-touch-dragging');
    clearHover();
    active = false;
    if (target && target.id && from && target.id !== from) {
      onReorder({ from, to: target.id, kind: target.kind });
    }
  };

  handle.addEventListener('pointerdown', onPointerDown);
  handle.addEventListener('pointermove', onPointerMove, { passive: false });
  handle.addEventListener('pointerup', onPointerUp);
  handle.addEventListener('pointercancel', cancelPress);

  return () => {
    cancelPress();
    handle.removeEventListener('pointerdown', onPointerDown);
    handle.removeEventListener('pointermove', onPointerMove);
    handle.removeEventListener('pointerup', onPointerUp);
    handle.removeEventListener('pointercancel', cancelPress);
  };
}
