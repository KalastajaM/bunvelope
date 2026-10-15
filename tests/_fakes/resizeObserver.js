// jsdom has no ResizeObserver, and the chart component (js/ui/charts/)
// draws a line, bar or pie only once it has been told its width. This stub
// records every observer so a test can deliver that width to the charts on
// the page, the way a browser would after they are attached.
import { vi } from 'vitest';

let observers = [];

/** Install the stub; call from beforeEach. */
export function stubResizeObserver() {
  observers = [];
  vi.stubGlobal('ResizeObserver', class {
    constructor(cb) { this.cb = cb; observers.push(this); }
    observe() {}
    unobserve() {}
    disconnect() {}
  });
}

/** Tell every chart built so far that it is `width` px wide. */
export function resizeCharts(width = 600) {
  for (const o of observers) o.cb([{ contentRect: { width } }]);
}
