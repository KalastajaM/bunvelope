import { t } from './i18n.js';

// Shared responsive tracks keep every group and its sticky heading aligned.
// Old manual width/order preferences intentionally no longer affect these lists.
const layouts = {
  accounts: [['name', 160, 2], ['balance', 140, 1], ['details', 140, 1.6], ['actions', 100, 0.7]],
  envelopes: [['name', 160, 2], ['balance', 160, 1], ['progress', 142, 1], ['actions', 100, 0.5]],
  plan: [['item', 180, 1.6], ['schedule', 130, 1], ['settings', 200, 1.6], ['annual', 150, 1]],
};

export function listColumnRow(row, kind) {
  layouts[kind].forEach(([key], i) => { row.children[i].dataset.listColumn = key; });
}

export function listColumns(host, kind, enabled = true, headingHost = host) {
  host.classList.toggle('column-layout', enabled);
  if (headingHost !== host) {
    headingHost.replaceChildren();
    headingHost.classList.toggle('column-layout', enabled);
    headingHost.hidden = !enabled;
    host.onscroll = enabled ? () => { headingHost.scrollLeft = host.scrollLeft; } : null;
    headingHost.onscroll = enabled ? () => { host.scrollLeft = headingHost.scrollLeft; } : null;
  }
  if (!enabled) return;
  const columns = layouts[kind];
  const tracks = columns.map(([, min, weight]) => `minmax(${min}px, ${weight}fr)`).join(' ');
  // Include gaps between columns and row padding/border.
  const minimum = columns.reduce((sum, [, min]) => sum + min, (columns.length - 1) * 12 + 42);
  for (const target of new Set([host, headingHost])) {
    target.style.setProperty('--list-columns', tracks);
    target.style.setProperty('--list-min-width', `${minimum}px`);
  }
  const header = document.createElement('div');
  header.className = 'list-column-header';
  for (const [key] of columns) {
    const cell = document.createElement('span');
    cell.className = 'list-column-label';
    cell.dataset.listColumn = key;
    cell.textContent = t(`columns.${key}`);
    header.append(cell);
  }
  headingHost.append(header);
  if (headingHost !== host) headingHost.scrollLeft = host.scrollLeft;
}
