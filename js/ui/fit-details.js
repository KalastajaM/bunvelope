import { getPrefs, savePrefs } from '../app.js';

// Automatic expansion is a layout choice, never a saved user preference.
// Measure intrinsic heights so an open disclosure cannot prop the row open.
export function fitDetails(top, card, neighbour, details, key) {
  let frame;
  const saved = getPrefs().dailyDetails?.[key];
  let manual = typeof saved === 'boolean';
  if (manual) details.open = saved;
  const summary = details.querySelector('summary');
  summary.addEventListener('click', () => {
    manual = true;
    savePrefs({ dailyDetails: { ...getPrefs().dailyDetails, [key]: !details.open } });
  });
  const update = () => {
    if (!top.isConnected) { observer?.disconnect(); return; }
    if (manual) return;
    const sideBySide = card.offsetLeft !== neighbour.offsetLeft;
    const cardAlign = card.style.alignSelf, neighbourAlign = neighbour.style.alignSelf;
    card.style.alignSelf = neighbour.style.alignSelf = 'start';
    details.open = true;
    const fits = sideBySide && card.getBoundingClientRect().height <= neighbour.getBoundingClientRect().height;
    details.open = fits;
    card.style.alignSelf = cardAlign; neighbour.style.alignSelf = neighbourAlign;
  };
  const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(update); };
  const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(schedule) : null;
  observer?.observe(top); observer?.observe(neighbour);
  schedule();
}
