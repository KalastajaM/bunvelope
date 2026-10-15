// paintYield exists because the dashboard and reports pages await a yield
// between painting their skeletons and blocking on aggregates. Awaiting
// requestAnimationFrame alone is a trap: a hidden or backgrounded tab never
// fires it, so the render suspends forever — no rejection, no console error,
// just skeletons that never resolve into a page. These tests pin the escape
// hatch, since the failure they guard against is silent by nature.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { paintYield } from '../js/ui/skeleton.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('paintYield', () => {
  it('resolves when requestAnimationFrame never fires', async () => {
    // Exactly the hidden-tab case: rAF exists, accepts the callback, and then
    // never calls it.
    vi.stubGlobal('requestAnimationFrame', () => 1);

    await expect(paintYield(10)).resolves.toBeUndefined();
  });

  it('resolves when requestAnimationFrame is not defined at all', async () => {
    vi.stubGlobal('requestAnimationFrame', undefined);

    await expect(paintYield(10)).resolves.toBeUndefined();
  });

  it('resolves on the rAF path without waiting out the timeout', async () => {
    vi.stubGlobal('requestAnimationFrame', (cb) => { cb(); return 1; });

    const started = Date.now();
    await paintYield(5000);

    // If this hung on the timer rather than the frame, it would take 5s.
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('resolves once even when both sources fire', async () => {
    let resolutions = 0;
    vi.stubGlobal('requestAnimationFrame', (cb) => { cb(); return 1; });

    await paintYield(1).then(() => { resolutions += 1; });
    // Give the trailing timer a chance to fire after the promise settled.
    await new Promise((r) => setTimeout(r, 20));

    expect(resolutions).toBe(1);
  });
});
