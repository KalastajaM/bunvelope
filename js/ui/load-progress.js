// js/ui/load-progress.js — stepped progress card shown while a budget loads.
//
// The load path has several multi-hundred-millisecond awaits (network fetch,
// decrypt, transaction normalisation, scheduled-transaction materialisation)
// and used to leave #app empty for all of them. This paints a card naming the
// budget and ticks through the steps as they complete.
//
// Usage:
//   const prog = openLoadProgress(container, { name: 'Household' });
//   await prog.step('reading');
//   ...
//   prog.close();          // the next render claims #app anyway
//
// `step()` is async on purpose: it yields a frame so the update actually
// paints before the caller resumes and blocks the main thread again. Same
// trick as js/pages/dashboard.js:30 and js/pages/reports.js.

import { t } from './i18n.js';
import { paintYield } from './skeleton.js';

// Order matters — it's the display order and drives the done/active states.
const STEPS = ['reading', 'preparing', 'scheduled', 'rendering'];

/**
 * @param {HTMLElement} container  usually #app
 * @param {{name?: string}} opts
 * @returns {{step: (key: string) => Promise<void>, close: () => void}}
 */
export function openLoadProgress(container, { name } = {}) {
  if (!container) {
    return { step: async () => {}, close: () => {} };
  }

  container.innerHTML = '';

  const page = document.createElement('div');
  page.className = 'page load-progress';

  const card = document.createElement('div');
  card.className = 'card';

  const title = document.createElement('div');
  title.className = 'load-progress-title';
  title.textContent = t('loadProgress.title');
  card.append(title);

  const sub = document.createElement('div');
  sub.className = 'load-progress-sub';
  sub.textContent = name || '';
  card.append(sub);

  const list = document.createElement('div');
  list.className = 'load-progress-steps';
  list.setAttribute('role', 'status');
  list.setAttribute('aria-live', 'polite');

  /** @type {Map<string, HTMLElement>} */
  const rows = new Map();
  for (const key of STEPS) {
    const row = document.createElement('div');
    row.className = 'load-progress-step';
    row.dataset.state = 'pending';

    const dot = document.createElement('span');
    dot.className = 'load-progress-dot';

    const label = document.createElement('span');
    label.textContent = t(`loadProgress.${key}`);

    row.append(dot, label);
    list.append(row);
    rows.set(key, row);
  }

  card.append(list);
  page.append(card);
  container.append(page);

  let closed = false;

  async function step(key) {
    if (closed) return;
    const idx = STEPS.indexOf(key);
    if (idx === -1) return;
    // Everything before `key` is finished; `key` itself is in flight.
    STEPS.forEach((k, i) => {
      const row = rows.get(k);
      if (!row) return;
      row.dataset.state = i < idx ? 'done' : i === idx ? 'active' : 'pending';
    });
    await paintYield();
  }

  function close() {
    closed = true;
    // Deliberately does not clear the container: the caller's next render
    // (navigate() / renderWelcome()) does that, and blanking here would
    // flash an empty page in between.
  }

  return { step, close };
}
