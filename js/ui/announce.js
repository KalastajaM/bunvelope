// js/ui/announce.js — visually-hidden polite live region for screen-reader
// announcements that have no visual counterpart (e.g. keyboard reorder).
// Toasts already announce; use this when a toast would be visual noise.
let region = null;

export function announce(msg) {
  if (!region) {
    region = document.createElement('div');
    region.setAttribute('aria-live', 'polite');
    region.style.cssText = 'position:absolute;width:1px;height:1px;overflow:hidden;'
      + 'clip:rect(0 0 0 0);clip-path:inset(50%);white-space:nowrap;';
    document.body.append(region);
  }
  // Clear first so repeating the same message re-announces.
  region.textContent = '';
  requestAnimationFrame(() => { region.textContent = msg; });
}
