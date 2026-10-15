// A reload right after an edit could lose it: writes are fire-and-forget and
// nothing held the page open for them (BACKLOG 2026-09-29). The guard asks the
// browser to warn only while a write is pending.
import { describe, it, expect } from 'vitest';
import { onBeforeUnload } from '../js/state/unload-guard.js';
import { createMetaQueue, metaWritesPending } from '../js/state/meta-queue.js';

function fakeEvent() {
  return { prevented: false, returnValue: undefined, preventDefault() { this.prevented = true; } };
}

describe('onBeforeUnload', () => {
  it('asks the browser to warn while a write is pending', () => {
    const e = fakeEvent();
    expect(onBeforeUnload(e, () => true)).toBe('');
    expect(e.prevented).toBe(true);
    expect(e.returnValue).toBe('');
  });

  it('does nothing when every write has landed, so a normal close is never interrupted', () => {
    const e = fakeEvent();
    expect(onBeforeUnload(e, () => false)).toBeUndefined();
    expect(e.prevented).toBe(false);
    expect(e.returnValue).toBeUndefined();
  });
});

describe('metaWritesPending', () => {
  it('counts a patch still waiting behind another until it lands, and after a failure too', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    let calls = 0;
    const { update } = createMetaQueue(async () => {
      calls += 1;
      if (calls === 1) await gate;
      if (calls === 2) throw new Error('disk full');
    });
    const state = { budgetFolder: 'f', meta: {} };
    const first = update(state, (m) => ({ ...m, a: 1 }));
    const second = update(state, (m) => ({ ...m, b: 2 })).catch(() => {});
    expect(metaWritesPending()).toBe(true);
    release();
    await first;
    await second;
    expect(metaWritesPending()).toBe(false);
  });
});
