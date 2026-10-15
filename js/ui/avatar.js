// js/ui/avatar.js
export function avatar(name) {
  const letter = (name || '?').trim()[0]?.toUpperCase() || '?';
  let h = 0;
  for (const c of name || '') h = (h * 31 + c.charCodeAt(0)) & 0xffff;
  const hue = (h * 17) % 360;
  const el = document.createElement('div');
  // Per-name pastel: the hue comes from here, the lightness from CSS
  // (.avatar--hue in css/app.css, re-toned in css/theme-dark.css).
  el.className = 'avatar avatar--hue';
  el.style.setProperty('--avatar-hue', String(hue));
  el.textContent = letter;
  return el;
}
