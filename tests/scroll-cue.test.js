// @vitest-environment jsdom
// The sideways-scroll cue on wide tables and tab strips (BACKLOG 2026-10-05,
// phone width): an edge that hides content is flagged so CSS can fade it.
import { describe, it, expect } from 'vitest';
import { scrollCueState, attachScrollCue, attachScrollCues } from '../js/ui/scroll-cue.js';

describe('scrollCueState', () => {
  it('flags nothing when the content fits', () => {
    expect(scrollCueState({ scrollLeft: 0, scrollWidth: 300, clientWidth: 300 })).toEqual({ start: false, end: false });
    // A sub-pixel overflow is not content.
    expect(scrollCueState({ scrollLeft: 0, scrollWidth: 301, clientWidth: 300 })).toEqual({ start: false, end: false });
  });
  it('flags the end at the start, both in the middle, the start at the end', () => {
    expect(scrollCueState({ scrollLeft: 0, scrollWidth: 600, clientWidth: 300 })).toEqual({ start: false, end: true });
    expect(scrollCueState({ scrollLeft: 150, scrollWidth: 600, clientWidth: 300 })).toEqual({ start: true, end: true });
    expect(scrollCueState({ scrollLeft: 300, scrollWidth: 600, clientWidth: 300 })).toEqual({ start: true, end: false });
  });
  it('reads a right-to-left scroller by magnitude', () => {
    expect(scrollCueState({ scrollLeft: -300, scrollWidth: 600, clientWidth: 300 })).toEqual({ start: true, end: false });
  });
});

function scroller(scrollWidth, clientWidth) {
  const el = document.createElement('div');
  el.setAttribute('data-scroll-cue', '');
  Object.defineProperty(el, 'scrollWidth', { value: scrollWidth, configurable: true });
  Object.defineProperty(el, 'clientWidth', { value: clientWidth, configurable: true });
  el.append(document.createElement('table'));
  return el;
}

describe('attachScrollCue', () => {
  it('sets data-scroll-end on an overflowing box and follows its scroll', () => {
    const el = scroller(600, 300);
    attachScrollCue(el);
    expect(el.hasAttribute('data-scroll-end')).toBe(true);
    expect(el.hasAttribute('data-scroll-start')).toBe(false);
    el.scrollLeft = 300;
    el.dispatchEvent(new Event('scroll'));
    expect(el.hasAttribute('data-scroll-start')).toBe(true);
    expect(el.hasAttribute('data-scroll-end')).toBe(false);
  });
  it('sets nothing on a box that fits', () => {
    const el = scroller(300, 300);
    attachScrollCue(el);
    expect(el.hasAttribute('data-scroll-end')).toBe(false);
  });
  it('attachScrollCues finds opted-in elements under a root', () => {
    const root = document.createElement('div');
    const a = scroller(500, 200);
    const plain = document.createElement('div');
    root.append(a, plain);
    attachScrollCues(root);
    expect(a.hasAttribute('data-scroll-end')).toBe(true);
    expect(plain.hasAttribute('data-scroll-end')).toBe(false);
  });
});
