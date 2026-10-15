// js/ui/tour.js — guided tour (spotlight + popover)
//
// Exports:
//   startTour()           — begin the tour unconditionally
//   maybeAutoStartTour()  — start only if prefs.tourSeen is falsy

import { t } from './i18n.js';
import { navigate, getPrefs, savePrefs } from '../app.js';
import { openBudgetGuide } from './budget-guides.js';

// Step schema: { key, page?, selector?, simpleOnly? }
// If selector is omitted (or element not found), popover is centered.
// Selectors are comma-separated fallbacks — first hit wins. Prefer real,
// action-bearing UI (primary buttons, key data cards) over page headers.
// Teach the first budgeting cycle. All destination pages are available in
// simple mode; advanced topics live in the optional budgeting guides.
const STEPS = [
  { key: 'welcome',  page: 'dashboard' },
  { key: 'rail',     page: 'dashboard', selector: '#rail' },
  { key: 'accounts', page: 'accounts',  selector: '.page-head .actions .btn-accent, .page-head' },
  { key: 'envelopes',page: 'envelopes', selector: '#env-new, .page-head' },
  { key: 'budget',   page: 'budget-plan', selector: '#bp-add, .page-head' },
  { key: 'unallocated', page: 'dashboard', selector: '#status-unallocated' },
  { key: 'transactions', page: 'transactions', selector: '.page-head .actions .btn-accent, .page-head' },
  { key: 'dashboard',page: 'dashboard', selector: '.hero-card, .kpi, .page-head' },
  { key: 'simpleMode', selector: '#rail-tweaks, #topnav-tweaks', simpleOnly: true },
  { key: 'finish',   page: 'dashboard' },
];

/** The short tour is the same with or without AI. */
export function tourSteps({ simple }) {
  return STEPS.filter(s => !s.simpleOnly || simple);
}

let steps = STEPS;

let active = false;
let stepIdx = 0;
let backdropEl = null;
let popoverEl = null;
let spotEl = null;
let spotPrevBg = '';
let spotBgPatched = false;
let prevFocus = null;
let repositionRaf = 0;
let keyHandler = null;
let resizeHandler = null;

function findTarget(selector) {
  if (!selector) return null;
  const parts = selector.split(',').map(s => s.trim()).filter(Boolean);
  for (const sel of parts) {
    const el = document.querySelector(sel);
    if (el && el.getBoundingClientRect().width > 0) return el;
  }
  return null;
}

async function waitForTarget(selector, timeoutMs = 800) {
  if (!selector) return null;
  const start = performance.now();
  return new Promise((resolve) => {
    const tick = () => {
      const el = findTarget(selector);
      if (el) return resolve(el);
      if (performance.now() - start > timeoutMs) return resolve(null);
      requestAnimationFrame(tick);
    };
    tick();
  });
}

function buildBackdrop() {
  const el = document.createElement('div');
  el.className = 'tour-backdrop is-centered';
  el.setAttribute('aria-hidden', 'true');
  document.body.append(el);
  return el;
}

function buildPopover(totalSteps) {
  const el = document.createElement('div');
  el.className = 'tour-popover is-centered';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-modal', 'true');
  el.setAttribute('aria-live', 'polite');

  const progress = document.createElement('div');
  progress.className = 'tour-progress';
  progress.setAttribute('role', 'progressbar');
  progress.setAttribute('aria-valuemin', '0');
  progress.setAttribute('aria-valuemax', String(totalSteps));
  const progressFill = document.createElement('div');
  progressFill.className = 'tour-progress-fill';
  progress.append(progressFill);
  el.append(progress);

  const meta = document.createElement('div');
  meta.className = 'tour-meta';
  const stepLbl = document.createElement('span');
  stepLbl.className = 'tour-step-lbl';
  meta.append(stepLbl);
  const skipBtn = document.createElement('button');
  skipBtn.type = 'button';
  skipBtn.className = 'tour-skip';
  skipBtn.textContent = t('tour.skip');
  skipBtn.addEventListener('click', endTour);
  meta.append(skipBtn);
  el.append(meta);

  const h3 = document.createElement('h3');
  h3.className = 'tour-title';
  el.append(h3);

  const p = document.createElement('p');
  p.className = 'tour-body';
  el.append(p);

  const guidesBtn = document.createElement('button');
  guidesBtn.type = 'button';
  guidesBtn.className = 'btn btn-ghost btn-sm tour-guides';
  guidesBtn.textContent = t('guides.open');
  guidesBtn.hidden = true;
  guidesBtn.addEventListener('click', () => {
    endTour(true);
    openBudgetGuide();
  });
  el.append(guidesBtn);

  const actions = document.createElement('div');
  actions.className = 'tour-actions';

  const backBtn = document.createElement('button');
  backBtn.type = 'button';
  backBtn.className = 'btn btn-ghost btn-sm tour-back';
  backBtn.textContent = t('tour.back');
  backBtn.addEventListener('click', () => goTo(stepIdx - 1));
  actions.append(backBtn);

  const nextBtn = document.createElement('button');
  nextBtn.type = 'button';
  nextBtn.className = 'btn btn-accent btn-sm tour-next';
  nextBtn.addEventListener('click', () => {
    if (stepIdx >= totalSteps - 1) endTour(true);
    else goTo(stepIdx + 1);
  });
  actions.append(nextBtn);

  el.insertBefore(actions, h3);
  document.body.append(el);
  return el;
}

function positionPopover(target) {
  if (!popoverEl) return;
  if (!target) {
    popoverEl.classList.add('is-centered');
    popoverEl.style.top = '';
    popoverEl.style.left = '';
    popoverEl.style.transform = '';
    return;
  }
  popoverEl.classList.remove('is-centered');
  const r = target.getBoundingClientRect();
  const pw = popoverEl.offsetWidth || 320;
  const ph = popoverEl.offsetHeight || 180;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const margin = 12;

  // Prefer below, then above, then right, then left
  let top = r.bottom + margin;
  let left = Math.min(Math.max(margin, r.left + r.width / 2 - pw / 2), vw - pw - margin);
  if (top + ph > vh - margin) {
    top = r.top - ph - margin;
  }
  if (top < margin) {
    // target fills viewport vertically — stick near top
    top = margin;
    left = Math.min(vw - pw - margin, Math.max(margin, r.right + margin));
    if (left + pw > vw - margin) left = margin;
  }
  popoverEl.style.transform = 'none';
  popoverEl.style.top = `${Math.round(top)}px`;
  popoverEl.style.left = `${Math.round(left)}px`;
}

function applyMask(target) {
  if (!backdropEl) return;
  if (!target) {
    backdropEl.classList.add('is-centered');
    backdropEl.style.setProperty('--tour-mask', 'none');
    return;
  }
  backdropEl.classList.remove('is-centered');
  const r = target.getBoundingClientRect();
  const pad = 6;
  const x = Math.max(0, r.left - pad);
  const y = Math.max(0, r.top - pad);
  const w = Math.min(window.innerWidth, r.width + pad * 2);
  const h = Math.min(window.innerHeight, r.height + pad * 2);
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='${vw}' height='${vh}' viewBox='0 0 ${vw} ${vh}'>`
    + `<rect width='100%' height='100%' fill='white'/>`
    + `<rect x='${x}' y='${y}' width='${w}' height='${h}' rx='10' ry='10' fill='black'/>`
    + `</svg>`;
  const url = `url("data:image/svg+xml;utf8,${encodeURIComponent(svg)}")`;
  backdropEl.style.setProperty('--tour-mask', url);
}

function clearSpot() {
  if (spotEl) {
    spotEl.classList.remove('tour-spot');
    if (spotBgPatched) spotEl.style.backgroundColor = spotPrevBg;
    spotEl = null;
  }
  spotBgPatched = false;
}

function markSpot(target) {
  clearSpot();
  if (target) {
    target.classList.add('tour-spot');
    spotEl = target;
    // A see-through target (the Settings tab buttons) paints no text inside
    // the spotlight, so give it the page background while it is lit.
    const bg = getComputedStyle(target).backgroundColor;
    if (bg === 'transparent' || bg === 'rgba(0, 0, 0, 0)') {
      spotPrevBg = target.style.backgroundColor;
      target.style.backgroundColor = 'var(--bg)';
      spotBgPatched = true;
    }
  }
}

async function goTo(i) {
  if (!active) return;
  if (i < 0) i = 0;
  if (i >= steps.length) { endTour(true); return; }

  const step = steps[i];
  stepIdx = i;
  if (step.page) {
    try { await navigate(step.page); } catch (err) { console.warn('tour navigate failed:', err); }
  }

  const target = await waitForTarget(step.selector);
  // A skip or a newer step may have landed while navigation was settling.
  if (!active || stepIdx !== i) return;
  if (target) {
    try { target.scrollIntoView({ block: 'center', behavior: 'auto' }); } catch { /* ignore */ }
  }

  // Refresh step content
  const titleEl = popoverEl.querySelector('.tour-title');
  const bodyEl = popoverEl.querySelector('.tour-body');
  const stepLbl = popoverEl.querySelector('.tour-step-lbl');
  const backBtn = popoverEl.querySelector('.tour-back');
  const nextBtn = popoverEl.querySelector('.tour-next');

  titleEl.textContent = t(`tour.steps.${step.key}.title`);
  bodyEl.textContent = t(`tour.steps.${step.key}.body`);
  stepLbl.textContent = t('tour.stepOf')(i + 1, steps.length);
  backBtn.disabled = i === 0;
  backBtn.style.visibility = i === 0 ? 'hidden' : 'visible';
  nextBtn.textContent = i >= steps.length - 1 ? t('tour.done') : t('tour.next');
  popoverEl.querySelector('.tour-guides').hidden = step.key !== 'finish';

  const progress = popoverEl.querySelector('.tour-progress');
  const progressFill = popoverEl.querySelector('.tour-progress-fill');
  if (progress && progressFill) {
    const pct = ((i + 1) / steps.length) * 100;
    progressFill.style.width = `${pct}%`;
    progress.setAttribute('aria-valuenow', String(i + 1));
  }

  markSpot(target);
  // Position after layout has settled
  requestAnimationFrame(() => {
    if (!active || stepIdx !== i) return;
    applyMask(target);
    positionPopover(target);
    // Focus the Next button so keyboard users can proceed
    nextBtn.focus();
  });
}

function reposition() {
  if (!active) return;
  cancelAnimationFrame(repositionRaf);
  repositionRaf = requestAnimationFrame(() => {
    const step = steps[stepIdx];
    const target = step.selector ? findTarget(step.selector) : null;
    if (target !== spotEl) markSpot(target);
    applyMask(target);
    positionPopover(target);
  });
}

export function endTour(completed) {
  if (!active) return;
  active = false;
  clearSpot();
  if (backdropEl) { backdropEl.remove(); backdropEl = null; }
  if (popoverEl) { popoverEl.remove(); popoverEl = null; }
  if (keyHandler) { document.removeEventListener('keydown', keyHandler, true); keyHandler = null; }
  if (resizeHandler) {
    window.removeEventListener('resize', resizeHandler);
    window.removeEventListener('scroll', resizeHandler, true);
    resizeHandler = null;
  }
  try { savePrefs({ tourSeen: true }); } catch (err) { console.warn('savePrefs(tourSeen) failed:', err); }
  if (prevFocus && typeof prevFocus.focus === 'function') {
    try { prevFocus.focus(); } catch { /* ignore */ }
  }
  prevFocus = null;
  // `completed` reserved for telemetry; currently unused.
  void completed;
}

export function startTour() {
  if (active) return;
  active = true;
  stepIdx = 0;
  steps = tourSteps({ simple: getPrefs().uiMode === 'simple' });
  prevFocus = document.activeElement;
  backdropEl = buildBackdrop();
  popoverEl = buildPopover(steps.length);

  keyHandler = (e) => {
    if (!active) return;
    if (e.key === 'Escape') { e.preventDefault(); endTour(); return; }
    if (e.key === 'ArrowRight' || e.key === 'Enter') {
      // Preserve native activation of Back, Skip and the guide link.
      if (e.key === 'Enter' && e.target.closest?.('button:not(.tour-next)')) return;
      e.preventDefault();
      if (stepIdx >= steps.length - 1) endTour(true);
      else goTo(stepIdx + 1);
      return;
    }
    if (e.key === 'ArrowLeft') { e.preventDefault(); goTo(stepIdx - 1); }
  };
  document.addEventListener('keydown', keyHandler, true);

  resizeHandler = reposition;
  window.addEventListener('resize', resizeHandler);
  window.addEventListener('scroll', resizeHandler, true);

  goTo(0);
}

export function maybeAutoStartTour() {
  try {
    const prefs = getPrefs();
    if (prefs.tourSeen) return;
  } catch { /* ignore */ }
  // Small delay so the first page finishes rendering.
  setTimeout(() => startTour(), 300);
}
