// js/ui/empty-state.js — Shared "no data here yet" panel. Matches the
// existing `.empty-state` CSS in css/app.css. Use everywhere a page or
// section renders without any rows so the copy + CTA stay consistent.
//
//   emptyState({
//     icon: 'envelope',     // optional, name from js/ui/icon.js
//     title: '...',         // required
//     body:  '...',         // optional, supports \n\n paragraphs
//     action: {             // optional CTA button
//       label: '+ New',
//       onClick: () => …,
//       variant: 'accent',  // 'accent' | 'ghost' (default 'accent')
//     },
//   })

import { icon } from './icon.js';

export function emptyState({ icon: iconName, title, body, action } = {}) {
  const root = document.createElement('div');
  root.className = 'empty-state';

  if (iconName) {
    const wrap = document.createElement('div');
    wrap.className = 'empty-icon';
    wrap.append(icon(iconName, 22));
    root.append(wrap);
  }

  if (title) {
    const h = document.createElement('div');
    h.className = 'empty-title';
    h.textContent = title;
    root.append(h);
  }

  if (body) {
    for (const para of paragraphs(body)) {
      const p = document.createElement('p');
      p.className = 'empty-body';
      p.style.margin = '0';
      p.textContent = para;
      root.append(p);
    }
  }

  if (action && typeof action.onClick === 'function') {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `btn empty-action ${action.variant === 'ghost' ? 'btn-ghost' : 'btn-accent'}`;
    btn.textContent = action.label || '';
    btn.addEventListener('click', action.onClick);
    root.append(btn);
  }

  return root;
}

function paragraphs(body) {
  return String(body || '')
    .split(/\n{2,}/)
    .map(s => s.trim())
    .filter(Boolean);
}
