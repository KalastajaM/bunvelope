// js/ui/emergency-calc-dialog.js
//
// Read-only breakdown of how the emergency-fund required balance is computed.
// Driven entirely by the result of `computeEmergencyFundRequirement` in
// engine.js — this file only renders, never recalculates.

import { openSheet } from './sheet.js';
import { fmt } from '../utils.js';
import { t, trEnv } from './i18n.js';

function row(label, value, { strong = false, indent = false, signed = false, muted = false, suffix = null } = {}) {
  const r = document.createElement('div');
  r.style.cssText = 'display:flex;justify-content:space-between;align-items:baseline;gap:12px;'
    + (indent ? 'padding-left:16px;' : '')
    + (strong ? 'font-weight:600;' : '')
    + (muted ? 'opacity:0.55;' : '');
  const l = document.createElement('span');
  l.style.cssText = (indent ? 'color:var(--muted);' : '') + 'font-size:14px;';
  l.textContent = label;
  if (suffix) {
    const sfx = document.createElement('span');
    sfx.style.cssText = 'color:var(--muted);font-size:12px;font-style:italic;margin-left:6px;';
    sfx.textContent = suffix;
    l.append(sfx);
  }
  const v = document.createElement('span');
  v.style.cssText = 'font-variant-numeric:tabular-nums;font-size:14px;';
  v.textContent = signed && value > 0 ? '− ' + fmt(value) : fmt(value);
  r.append(l, v);
  return r;
}

function rule() {
  const hr = document.createElement('div');
  hr.style.cssText = 'border-top:1px solid var(--border);margin:8px 0;';
  return hr;
}

function sectionTitle(text) {
  const h = document.createElement('div');
  h.style.cssText = 'font-size:12px;text-transform:uppercase;letter-spacing:0.06em;color:var(--muted);margin:14px 0 6px;';
  h.textContent = text;
  return h;
}

export function openEmergencyCalcDialog(calc, envelope) {
  const content = document.createElement('div');
  content.style.cssText = 'display:flex;flex-direction:column;gap:2px;font-size:14px;line-height:1.5;';

  const intro = document.createElement('p');
  intro.style.cssText = 'margin:0 0 10px;color:var(--muted);font-size:13px;';
  intro.textContent = t('envelopes.emergencyCalcIntro')(calc.duration);
  content.append(intro);

  // ── Monthly essentials breakdown ────────────────────────────────────────
  content.append(sectionTitle(t('envelopes.emergencyCalcMonthlyEssentials')));
  if (calc.items.length === 0) {
    const empty = document.createElement('div');
    empty.style.cssText = 'color:var(--muted);font-size:13px;font-style:italic;';
    empty.textContent = t('envelopes.emergencyCalcNoItems');
    content.append(empty);
  } else {
    for (const it of calc.items) {
      const label = it.description ? `${it.envName} · ${it.description}` : it.envName;
      content.append(row(label, it.monthlyAmount, { indent: true }));
    }
  }
  content.append(row(t('envelopes.emergencyCalcMonthlyTotal'), calc.monthlyEssentials, { strong: true }));

  // ── × duration → subtotal ───────────────────────────────────────────────
  const mult = document.createElement('div');
  mult.style.cssText = 'display:flex;justify-content:space-between;align-items:baseline;gap:12px;color:var(--muted);font-size:13px;margin-top:4px;';
  const ml = document.createElement('span');
  ml.textContent = t('envelopes.emergencyCalcMultiply')(calc.duration);
  const mv = document.createElement('span');
  mv.style.fontVariantNumeric = 'tabular-nums';
  mv.textContent = '×';
  mult.append(ml, mv);
  content.append(mult);
  content.append(row(t('envelopes.emergencyCalcSubtotal'), calc.subtotal, { strong: true }));

  // ── Already covered elsewhere ───────────────────────────────────────────
  content.append(sectionTitle(t('envelopes.emergencyCalcCovered')));
  const modeNote = document.createElement('div');
  modeNote.style.cssText = 'font-size:12px;color:var(--muted);font-style:italic;margin:-2px 0 6px;';
  modeNote.textContent = calc.creditMode === 'all'
    ? t('envelopes.emergencyCalcModeNoteAll')
    : t('envelopes.emergencyCalcModeNoteFlagged');
  content.append(modeNote);
  if (calc.contributors.length === 0) {
    const empty = document.createElement('div');
    empty.style.cssText = 'color:var(--muted);font-size:13px;font-style:italic;';
    empty.textContent = t('envelopes.emergencyCalcNoContributors');
    content.append(empty);
  } else {
    for (const c of calc.contributors) {
      content.append(row(c.envName, c.balance, {
        indent: true,
        signed: !c.clamped,
        muted: c.clamped,
        suffix: c.clamped ? t('envelopes.emergencyCalcContributorClamped') : null,
      }));
    }
  }
  content.append(row(t('envelopes.emergencyCalcCoveredTotal'), calc.sumOtherBalance, { strong: true, signed: true }));

  content.append(rule());

  // ── Net + buffer = required ─────────────────────────────────────────────
  const netNeeded = Math.max(0, calc.subtotal - calc.sumOtherBalance);
  content.append(row(t('envelopes.emergencyCalcNet'), netNeeded));
  if (calc.buffer > 0) {
    content.append(row('+ ' + t('envelopes.emergencyCalcBuffer'), calc.buffer));
  }
  content.append(rule());
  content.append(row(t('envelopes.emergencyCalcRequired'), calc.required, { strong: true }));

  // ── Close button ────────────────────────────────────────────────────────
  const actions = document.createElement('div');
  actions.dataset.sheetActions = '';
  actions.style.cssText = 'display:flex;justify-content:flex-end;margin-top:20px;';
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'btn btn-accent';
  closeBtn.textContent = t('envelopes.emergencyCalcClose');
  actions.append(closeBtn);
  content.append(actions);

  const title = envelope ? `${trEnv(envelope)} — ${t('envelopes.emergencyCalcTitle')}` : t('envelopes.emergencyCalcTitle');
  const { close } = openSheet({ title, content });
  closeBtn.addEventListener('click', () => close());
}
