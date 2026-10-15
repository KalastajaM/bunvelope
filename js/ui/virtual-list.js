// js/ui/virtual-list.js — Virtual scroller. Supports both fixed and per-item
// row heights.
//
// Usage:
//   const vl = createVirtualList({
//     container,        // a scrollable element; we set overflow + position on it
//     items,            // Array<unknown>
//     rowHeight,        // px (number) OR (item, idx) => number
//     renderRow,        // (item, index) => HTMLElement
//     overscan,         // default 5
//     onWindowChange,   // optional (startIdx, endIdx) => void — used by the
//                       //   transactions page to drive the pinned date header
//   });
//   vl.setItems(nextItems);
//   vl.scrollToIndex(i);
//   vl.destroy();

/** Pure windowing math for fixed-height lists — exported for unit tests. */
export function computeWindow({ scrollTop, viewportHeight, rowHeight, itemCount, overscan = 5 }) {
  if (itemCount <= 0) return { startIdx: 0, endIdx: 0 };
  const rawStart = Math.floor(scrollTop / rowHeight) - overscan;
  const rawEnd   = Math.ceil((scrollTop + viewportHeight) / rowHeight) + overscan;
  return {
    startIdx: Math.max(0, rawStart),
    endIdx:   Math.min(itemCount, Math.max(0, rawEnd)),
  };
}

/** Variable-height windowing: `offsets[i]` is the y-position of item i;
 *  `offsets[itemCount]` is the total list height. Exported for tests. */
export function computeWindowVariable({ scrollTop, viewportHeight, offsets, overscan = 5 }) {
  const itemCount = Math.max(0, offsets.length - 1);
  if (itemCount <= 0) return { startIdx: 0, endIdx: 0 };
  // upper_bound(scrollTop): smallest i such that offsets[i] > scrollTop.
  // The first visible item is one before that.
  let lo = 0, hi = offsets.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (offsets[mid] <= scrollTop) lo = mid + 1;
    else hi = mid;
  }
  const startVisible = Math.max(0, lo - 1);
  // lower_bound(scrollTop + vh): smallest i such that offsets[i] >= viewport bottom.
  const target = scrollTop + viewportHeight;
  let elo = startVisible, ehi = offsets.length;
  while (elo < ehi) {
    const mid = (elo + ehi) >>> 1;
    if (offsets[mid] < target) elo = mid + 1;
    else ehi = mid;
  }
  const endVisible = elo;
  return {
    startIdx: Math.max(0, startVisible - overscan),
    endIdx:   Math.min(itemCount, endVisible + overscan),
  };
}

export function createVirtualList({ container, items, rowHeight, renderRow, overscan = 5, onWindowChange }) {
  if (!container) throw new Error('virtual-list: container is required');
  const isFn = typeof rowHeight === 'function';
  if (!isFn && (typeof rowHeight !== 'number' || rowHeight <= 0)) {
    throw new Error('virtual-list: rowHeight must be a positive number or a function');
  }
  if (typeof renderRow !== 'function') throw new Error('virtual-list: renderRow must be a function');

  container.style.position = 'relative';
  container.style.overflowY = 'auto';

  const spacer = document.createElement('div');
  spacer.className = 'vl-spacer';
  spacer.style.position = 'relative';
  spacer.style.width = '100%';
  container.innerHTML = '';
  container.append(spacer);

  let currentItems = items || [];
  let renderedRange = { startIdx: 0, endIdx: 0 };
  let offsets = [0]; // populated only when isFn — offsets[i] = top of item i
  const pool = new Map(); // index → { el, item }

  function recomputeOffsets() {
    if (!isFn) return;
    offsets = new Array(currentItems.length + 1);
    offsets[0] = 0;
    for (let i = 0; i < currentItems.length; i++) {
      const h = Math.max(1, rowHeight(currentItems[i], i));
      offsets[i + 1] = offsets[i] + h;
    }
  }

  function topOf(i)    { return isFn ? offsets[i] : i * rowHeight; }
  function heightOf(i) { return isFn ? offsets[i + 1] - offsets[i] : rowHeight; }
  function totalHeight() {
    return isFn ? (offsets[currentItems.length] || 0) : currentItems.length * rowHeight;
  }
  function sizeSpacer() { spacer.style.height = `${totalHeight()}px`; }

  function renderVisible() {
    const { scrollTop, clientHeight } = container;
    const next = isFn
      ? computeWindowVariable({ scrollTop, viewportHeight: clientHeight, offsets, overscan })
      : computeWindow({ scrollTop, viewportHeight: clientHeight, rowHeight, itemCount: currentItems.length, overscan });

    for (const [idx, entry] of pool) {
      if (idx < next.startIdx || idx >= next.endIdx) {
        entry.el.remove();
        pool.delete(idx);
      }
    }
    for (let i = next.startIdx; i < next.endIdx; i++) {
      if (pool.has(i)) continue;
      const item = currentItems[i];
      const el = renderRow(item, i);
      el.style.position = 'absolute';
      el.style.top = `${topOf(i)}px`;
      el.style.left = '0';
      el.style.right = '0';
      el.style.height = `${heightOf(i)}px`;
      spacer.append(el);
      pool.set(i, { el, item });
    }
    renderedRange = next;
    if (onWindowChange) onWindowChange(next.startIdx, next.endIdx);
  }

  function onScroll() { renderVisible(); }
  function onResize() { renderVisible(); }

  container.addEventListener('scroll', onScroll, { passive: true });
  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(onResize) : null;
  if (ro) ro.observe(container);

  recomputeOffsets();
  sizeSpacer();
  renderVisible();

  return {
    setItems(nextItems) {
      currentItems = nextItems || [];
      for (const [, entry] of pool) entry.el.remove();
      pool.clear();
      recomputeOffsets();
      sizeSpacer();
      renderVisible();
    },
    scrollToIndex(i) {
      const clamped = Math.max(0, Math.min(currentItems.length - 1, i));
      container.scrollTop = topOf(clamped);
    },
    destroy() {
      container.removeEventListener('scroll', onScroll);
      if (ro) ro.disconnect();
      for (const [, entry] of pool) entry.el.remove();
      pool.clear();
      spacer.remove();
    },
    getRenderedRange() { return { ...renderedRange }; },
  };
}
