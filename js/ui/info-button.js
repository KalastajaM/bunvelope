// js/ui/info-button.js — Contextual help primitive. `infoButton(key)`
// returns a small `?` button; clicking it opens a side sheet whose
// title/body come from the `help.<key>.title` / `help.<key>.body` i18n
// entries. Body strings can contain `\n\n` to form paragraphs.
//
// Reuse this anywhere a UI label maps to a Bunvelope concept the user
// might not recognise on first encounter. The same `key` is also used
// from the Settings concept card so the explanation lives in exactly
// one place.

import { icon } from './icon.js';
import { openSheet } from './sheet.js';
import { t } from './i18n.js';
import { guideButton } from './budget-guides.js';

const CONCEPT_GUIDES = {
  accountBalances: 'allocation', envelopes: 'accounts', txTypes: 'review',
  fills: 'allocation', unallocated: 'allocation', scheduledTx: 'planning',
  reconciling: 'review', envelopeFigures: 'planning', emergencyRunway: 'stress',
};

export function infoButton(key, opts = {}) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'info-btn';
  if (key) btn.dataset.helpKey = key;
  if (opts.size) btn.style.setProperty('--info-btn-size', `${opts.size}px`);
  btn.append(icon('help', opts.size || 14));
  const title = opts.title || helpTitle(key);
  const aria = t('help.aria');
  btn.setAttribute('aria-label', typeof aria === 'function' ? aria(title) : `Help: ${title}`);
  btn.title = opts.tooltip || shortExplanation(opts.intro || opts.body || helpBody(key)) || title;
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    openHelpSheet(key, opts);
  });
  return btn;
}

export function openHelpSheet(key, opts = {}) {
  const title = opts.title || helpTitle(key);
  const body = [opts.intro, opts.body ?? helpBody(key)].filter(Boolean).join('\n\n');
  const wrap = document.createElement('div');
  wrap.style.cssText = 'display:flex;flex-direction:column;gap:12px;font-size:14px;line-height:1.5;';
  for (const para of paragraphs(body)) {
    const p = document.createElement('p');
    p.style.margin = '0';
    p.textContent = para;
    wrap.append(p);
  }
  const guide = opts.guide || CONCEPT_GUIDES[key];
  if (guide) wrap.append(guideButton(guide));
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'btn btn-ghost btn-sm';
  closeBtn.textContent = t('common.close');
  const sheet = openSheet({ title, content: wrap, headerActions: [closeBtn] });
  closeBtn.addEventListener('click', sheet.close);
  return sheet;
}

function helpTitle(key) {
  const v = safeT(`help.${key}.title`);
  return v || key;
}

function helpBody(key) {
  const v = safeT(`help.${key}.body`);
  return v || '';
}

function safeT(path) {
  try {
    const v = t(path);
    return typeof v === 'string' ? v : '';
  } catch {
    return '';
  }
}

function paragraphs(body) {
  return String(body || '')
    .split(/\n{2,}/)
    .map(s => s.trim())
    .filter(Boolean);
}

/** Give a page title the same contextual help control as Accounts and Envelopes. */
export function addPageHelp(heading, bodyKey, { tooltipKey, detailKeys = [], guide } = {}) {
  if (!heading || heading.querySelector('.info-btn')) return;
  const body = [bodyKey, ...detailKeys].map(key => t(key)).join('\n\n');
  heading.append(infoButton(null, { title: heading.textContent, body, guide, tooltip: tooltipKey ? t(tooltipKey) : shortExplanation(body) }));
}

// Use the first sentence for a brief hover explanation; the sheet keeps every paragraph.
function shortExplanation(body) {
  return String(body || '').split(/(?<=[.!?])\s|\n/)[0].trim();
}
