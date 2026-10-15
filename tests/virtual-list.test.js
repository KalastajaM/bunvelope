import { describe, it, expect } from 'vitest';
import { computeWindow, computeWindowVariable } from '../js/ui/virtual-list.js';

describe('computeWindow', () => {
  it('at scrollTop=0 returns rows from start with overscan clamped', () => {
    const w = computeWindow({ scrollTop: 0, viewportHeight: 560, rowHeight: 56, itemCount: 1000, overscan: 5 });
    expect(w.startIdx).toBe(0);
    expect(w.endIdx).toBe(15);
  });

  it('mid-scroll returns correct window', () => {
    const w = computeWindow({ scrollTop: 5600, viewportHeight: 560, rowHeight: 56, itemCount: 1000, overscan: 5 });
    expect(w.startIdx).toBe(95);
    expect(w.endIdx).toBe(115);
  });

  it('clamps endIdx to itemCount', () => {
    const w = computeWindow({ scrollTop: 56_000, viewportHeight: 560, rowHeight: 56, itemCount: 1000, overscan: 5 });
    expect(w.endIdx).toBe(1000);
  });

  it('empty list', () => {
    const w = computeWindow({ scrollTop: 0, viewportHeight: 560, rowHeight: 56, itemCount: 0, overscan: 5 });
    expect(w.startIdx).toBe(0);
    expect(w.endIdx).toBe(0);
  });

  it('overscan zero still returns the strictly-visible window', () => {
    const w = computeWindow({ scrollTop: 112, viewportHeight: 280, rowHeight: 56, itemCount: 100, overscan: 0 });
    expect(w.startIdx).toBe(2);
    expect(w.endIdx).toBe(7);
  });

  it('produces non-negative startIdx with huge overscan', () => {
    const w = computeWindow({ scrollTop: 0, viewportHeight: 280, rowHeight: 56, itemCount: 100, overscan: 1000 });
    expect(w.startIdx).toBe(0);
  });
});

describe('computeWindowVariable', () => {
  // Mixed-height list: 4 items of height [28, 56, 28, 56]
  // offsets:           [0, 28, 84, 112, 168]
  const offsets = [0, 28, 84, 112, 168];

  it('at scrollTop=0 returns rows from start with overscan clamped', () => {
    const w = computeWindowVariable({ scrollTop: 0, viewportHeight: 100, offsets, overscan: 0 });
    expect(w.startIdx).toBe(0);
    // viewport [0, 100): items 0 (0-28), 1 (28-84), 2 (84-112) overlap. Item 3 at 112 is outside.
    expect(w.endIdx).toBe(3);
  });

  it('mid-scroll past a header still includes the partially-visible row', () => {
    // scrollTop=40, viewport=[40, 140). Item 1 spans [28,84) — top edge above viewport, bottom inside.
    const w = computeWindowVariable({ scrollTop: 40, viewportHeight: 100, offsets, overscan: 0 });
    expect(w.startIdx).toBe(1); // item 1 is the first visible
    expect(w.endIdx).toBe(4);   // items 1,2,3 visible
  });

  it('clamps endIdx to itemCount', () => {
    const w = computeWindowVariable({ scrollTop: 200, viewportHeight: 100, offsets, overscan: 5 });
    expect(w.endIdx).toBe(4);
  });

  it('empty list', () => {
    const w = computeWindowVariable({ scrollTop: 0, viewportHeight: 100, offsets: [0], overscan: 5 });
    expect(w.startIdx).toBe(0);
    expect(w.endIdx).toBe(0);
  });

  it('overscan extends both ends without going negative or past end', () => {
    const w = computeWindowVariable({ scrollTop: 84, viewportHeight: 28, offsets, overscan: 5 });
    expect(w.startIdx).toBe(0);
    expect(w.endIdx).toBe(4);
  });
});
