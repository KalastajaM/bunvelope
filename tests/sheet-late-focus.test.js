// @vitest-environment jsdom
// A sheet moves focus to its first field in its first animation frame. When
// that frame is late (a busy or throttled page) and the user has already
// clicked into another field of the sheet, the late frame must not pull the
// focus back: what they type next would land in the wrong field (an account
// named "Checking250" with an opening balance of 0, seen in the guest e2e).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { openSheet } from '../js/ui/sheet.js';

let frames;

beforeEach(() => {
  document.body.innerHTML = '<button id="opener">open</button><div id="sheet-host"></div>';
  frames = [];
  vi.stubGlobal('requestAnimationFrame', (cb) => { frames.push(cb); return frames.length; });
  // jsdom lays nothing out; give every element a box so it counts as visible.
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue([{}]);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const runFrames = () => { for (const cb of frames.splice(0)) cb(0); };

function form() {
  const content = document.createElement('div');
  const name = document.createElement('input'); name.name = 'name';
  const balance = document.createElement('input'); balance.name = 'initialBalance';
  content.append(name, balance);
  return { content, name, balance };
}

describe('openSheet initial focus', () => {
  it('focuses the first field in its first frame', () => {
    document.getElementById('opener').focus();
    const { content, name } = form();
    openSheet({ title: 'New account', content });
    runFrames();
    expect(document.activeElement).toBe(name);
  });

  it('leaves the focus where the user put it when the first frame is late', () => {
    document.getElementById('opener').focus();
    const { content, balance } = form();
    openSheet({ title: 'New account', content });
    balance.focus();          // the user clicked into the second field first
    runFrames();              // the late first frame
    expect(document.activeElement).toBe(balance);
  });
});
