// js/ui/lens-control.js — the balance-lens switcher.
//
// Lives next to Unallocated in the status bar, and is always
// visible on purpose: a global display mode the user cannot see is how they
// misread their own balance. Every instance stays in sync through
// `syncLensControls`, because the shell is built once at boot while the lens
// can change at any time.

import { LENSES, HORIZONS, LENS_FORECAST } from '../engine.js';
import { t } from './i18n.js';
import { infoButton } from './info-button.js';

const instances = new Set();

const HORIZON_KEYS = {
  eom: 'lens.horizonEom',
  '3m': 'lens.horizon3m',
  '6m': 'lens.horizon6m',
  '12m': 'lens.horizon12m',
};

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Build a lens switcher.
 *
 * @param {object} opts
 * @param {() => {lens: string, horizon: string}} opts.read   current values
 * @param {(patch: object) => void} opts.onChange             commit a change
 * @param {string} [opts.variant]  'rail' (stacked), 'top' or 'status' (inline)
 */
export function lensControl({ read, onChange, variant = 'rail' }) {
  const wrap = document.createElement('div');
  wrap.className = 'lens-ctl lens-ctl-' + variant;

  const label = document.createElement('span');
  label.className = 'lens-ctl-label';
  label.textContent = t('lens.label');
  wrap.append(label);

  const seg = document.createElement('div');
  seg.className = 'seg lens-seg';
  seg.setAttribute('role', 'radiogroup');
  seg.setAttribute('aria-label', t('lens.label'));

  const buttons = new Map();
  for (const lens of LENSES) {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.lens = lens;
    b.textContent = t('lens.' + lens);
    b.title = t('lens.' + lens + 'Hint');
    b.setAttribute('role', 'radio');
    b.addEventListener('click', () => onChange({ lens }));
    buttons.set(lens, b);
    seg.append(b);
  }
  const help = infoButton('accountBalances');
  wrap.append(seg, help);

  // Horizon — only meaningful for the forecast lens, so it is absent rather
  // than disabled in the other two.
  const horizonRow = document.createElement('div');
  horizonRow.className = 'lens-horizon';

  const horizonLbl = document.createElement('span');
  horizonLbl.className = 'lens-ctl-label';
  horizonLbl.textContent = t('lens.horizon');
  horizonRow.append(horizonLbl);

  const select = document.createElement('select');
  select.setAttribute('aria-label', t('lens.horizon'));
  for (const h of HORIZONS) {
    const o = document.createElement('option');
    o.value = h;
    o.textContent = t(HORIZON_KEYS[h]);
    select.append(o);
  }
  const customOpt = document.createElement('option');
  customOpt.value = 'custom';
  customOpt.textContent = t('lens.horizonCustom');
  select.append(customOpt);
  horizonRow.append(select);

  const dateInput = document.createElement('input');
  dateInput.type = 'date';
  dateInput.className = 'lens-horizon-date';
  dateInput.setAttribute('aria-label', t('lens.horizonCustom'));
  horizonRow.append(dateInput);

  select.addEventListener('change', () => {
    if (select.value === 'custom') {
      // Seed the picker from the current horizon so it opens somewhere sane
      // rather than empty, but do not commit until a date is actually chosen.
      dateInput.hidden = false;
      if (!dateInput.value) dateInput.value = defaultCustomDate();
      onChange({ lensHorizon: dateInput.value });
      return;
    }
    onChange({ lensHorizon: select.value });
  });
  dateInput.addEventListener('change', () => {
    if (ISO_DATE_RE.test(dateInput.value)) onChange({ lensHorizon: dateInput.value });
  });

  wrap.append(horizonRow);

  const instance = { wrap, buttons, seg, select, dateInput, horizonRow, read, help };
  instances.add(instance);
  paint(instance);
  return wrap;
}

function defaultCustomDate() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  const target = new Date(d.getFullYear(), d.getMonth() + 4, 0);
  return `${target.getFullYear()}-${pad(target.getMonth() + 1)}-${pad(target.getDate())}`;
}

function paint(instance) {
  const { lens, horizon } = instance.read();
  for (const [name, b] of instance.buttons) {
    const on = name === lens;
    b.classList.toggle('on', on);
    b.setAttribute('aria-checked', on ? 'true' : 'false');
  }
  const isForecast = lens === LENS_FORECAST;
  instance.horizonRow.hidden = !isForecast;
  const isCustom = ISO_DATE_RE.test(horizon);
  instance.select.value = isCustom ? 'custom' : horizon;
  instance.dateInput.hidden = !isCustom;
  if (isCustom) instance.dateInput.value = horizon;
}

/** Repaint every mounted switcher — call after the lens or horizon changes. */
export function syncLensControls() {
  for (const instance of instances) paint(instance);
}

/** Re-apply labels after a language switch. */
export function relabelLensControls() {
  for (const instance of instances) {
    const labels = instance.wrap.querySelectorAll('.lens-ctl-label');
    if (labels[0]) labels[0].textContent = t('lens.label');
    if (labels[1]) labels[1].textContent = t('lens.horizon');
    const help = infoButton('accountBalances');
    instance.help.replaceWith(help);
    instance.help = help;
    instance.seg.setAttribute('aria-label', t('lens.label'));
    for (const [name, b] of instance.buttons) {
      b.textContent = t('lens.' + name);
      b.title = t('lens.' + name + 'Hint');
    }
    for (const opt of instance.select.options) {
      opt.textContent = opt.value === 'custom'
        ? t('lens.horizonCustom')
        : t(HORIZON_KEYS[opt.value]);
    }
  }
}

/** Test-only: drop every registered instance. */
export function _resetLensControls() {
  instances.clear();
}
