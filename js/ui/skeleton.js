// js/ui/skeleton.js — placeholder shimmer card painted before a heavy page
// computes its real content. Pair with `paintYield()` so the skeleton actually
// paints before the main thread blocks:
//
//   container.replaceChildren(head, skeletonCard(), skeletonCard({ blockHeight: 160 }));
//   await paintYield();
//   ...compute aggregates, then swap in the real cards...
//
// Styling comes from .skeleton / .skeleton-line / .skeleton-block in
// css/app.css (shimmer disabled under prefers-reduced-motion).

/**
 * Yield once so a painted skeleton reaches the screen before the caller blocks.
 *
 * Races `requestAnimationFrame` against a timer on purpose. A hidden or
 * backgrounded tab never fires rAF, so awaiting it alone leaves the page
 * stuck on skeletons indefinitely — and because the render is merely
 * suspended rather than rejected, nothing appears in the console. The page
 * just never finishes. Whichever source fires first wins; the loser is a
 * no-op.
 */
export function paintYield(timeoutMs = 50) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(finish);
    setTimeout(finish, timeoutMs);
  });
}

export function skeletonCard({ lineWidth = '30%', blockHeight = 80 } = {}) {
  const card = document.createElement('section');
  card.className = 'card';
  card.style.marginBottom = '16px';
  const line = document.createElement('div');
  line.className = 'skeleton skeleton-line';
  line.style.width = lineWidth;
  const block = document.createElement('div');
  block.className = 'skeleton skeleton-block';
  block.style.marginTop = '14px';
  block.style.height = `${blockHeight}px`;
  card.append(line, block);
  return card;
}
