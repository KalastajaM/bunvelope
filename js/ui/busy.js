// js/ui/busy.js — minimal helper to put a button into a busy state.
//
// Usage:
//   await withBusy(saveBtn, async () => { await persist(...); });
//
// While the async work runs, the button is disabled and shows a small spinner
// before the original label. The original label is restored on success or
// failure. If `label` is provided it replaces the text while busy (e.g.
// "Saving…"), otherwise the original text is preserved.

export async function withBusy(btn, fn, { label } = {}) {
  if (!btn) return fn();
  const wasDisabled = btn.disabled;
  const orig = btn.textContent;
  btn.disabled = true;
  btn.classList.add('is-busy');
  if (label) btn.textContent = label;
  try {
    return await fn();
  } finally {
    btn.classList.remove('is-busy');
    btn.disabled = wasDisabled;
    btn.textContent = orig;
  }
}
