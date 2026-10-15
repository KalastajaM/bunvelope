import { describe, it, expect } from 'vitest';
import { pickInitialFocus } from '../js/ui/sheet.js';

// Minimal stand-in for an element: querySelectorAll answers from a map keyed by
// the first selector fragment the implementation asks for.
function fakeScope(matches) {
  const list = (v) => (Array.isArray(v) ? v : v ? [v] : []);
  return {
    querySelectorAll(sel) {
      if (sel === '[autofocus]') return list(matches.autofocus);
      if (sel.startsWith('input:not([disabled])')) return list(matches.field);
      return list(matches.any);
    },
  };
}
const el = (name, visible = true) => ({ name, focus() {}, getClientRects: () => (visible ? [{}] : []) });

describe('pickInitialFocus', () => {
  it('uses an explicit initialFocus element first', () => {
    const payee = el('payee');
    const sheet = fakeScope({ any: el('cancel') });
    const content = fakeScope({ field: el('type') });
    expect(pickInitialFocus(sheet, content, payee)).toBe(payee);
    expect(pickInitialFocus(sheet, content, () => payee)).toBe(payee);
  });

  it('prefers [autofocus], then the first body field, over header buttons', () => {
    const sheet = fakeScope({ any: el('cancel') });
    const auto = el('auto');
    expect(pickInitialFocus(sheet, fakeScope({ autofocus: auto, field: el('f') }), null)).toBe(auto);
    const field = el('field');
    expect(pickInitialFocus(sheet, fakeScope({ field }), null)).toBe(field);
  });

  it('skips hidden fields', () => {
    const hiddenSelect = el('type', false);
    const payee = el('payee');
    const sheet = fakeScope({ any: el('cancel') });
    expect(pickInitialFocus(sheet, fakeScope({ field: [hiddenSelect, payee] }), null)).toBe(payee);
  });

  it('falls back to the first focusable anywhere when the body has no field', () => {
    const cancel = el('cancel');
    expect(pickInitialFocus(fakeScope({ any: cancel }), fakeScope({}), null)).toBe(cancel);
  });
});
